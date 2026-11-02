#!/usr/bin/env node
/* ============================================================================
   tools/fragment.mjs — 章単位 fragment ↔ index.html の機械同期

   使い方:
     node tools/fragment.mjs check     <deckDir> [name] [--dry-run]
     node tools/fragment.mjs integrate <deckDir> [name] [--dry-run]
     node tools/fragment.mjs resync    <deckDir> [name] [--dry-run]

   なぜ必要か:
     数十枚規模のデッキは index.html 1 ファイルの並行編集が破綻する。章ごとに
     <deckDir>/fragments/<name>.html を分担して書き、このツールで機械統合する。
     人手のコピペを排除することで「統合時に継ぎ目が壊れる」事故を無くす。

   fragment の規約:
     1. 冒頭(最初の SPEC コメントより前)に任意で <style> ブロック 1 個
        — 章固有 CSS。section 内の SVG インライン <style> と混同しないため
          「最初の SPEC コメントより前」を条件にしている。
     2. `<!-- ==== SPEC <ID>: <題名> ==== -->` コメント + 直後の <section>…</section>
        を 1 個以上。ID は英数字(S1 / S22B / APX-DIV いずれも一級)。
        コメントは `SPEC S13 (2-1): 題名` のように ID とコロンの間にラベルを置ける。
     3. 末尾(最後の section より後)に任意で standalone <script>
        — 章固有のビート制御等。section 内の <script> は section ごと運ばれる。

   同期される 3 つの面(いずれも冪等・双方向):
     sections : ID 照合で index の同 ID ブロック(SPEC コメント〜</section>)と丸ごと交換
     style    : index の deck-local <style> 末尾のマーカー区間
                (CSS コメント `==== fragment:<name> begin ====` 〜 `… end ====`)
     script   : index の </body> 直前のマーカー区間
                `<!-- ==== fragment:<name> script begin ==== --> … end -->`
     マーカー区間は「追記」ではなく「区間ごと置換」なので、fragment から消した
     CSS が index に生き残らない(旧実装で実害があった退行パターン)。

   終了コード:
     0 完全同期  /  1 内容不一致(resync か integrate で解消)
     2 使い方・入出力エラー  /  3 fragment にしか無い ID がある(統合先が無い)

   設計メモ:
     - lib.mjs の resolveDeckDir() は使わない。あちらはローカル配信の都合で
       「プラットフォームとの共通祖先が / なら拒否」する。本ツールは
       ファイル操作だけでブラウザを立てないため、その制約を持ち込まない。
     - HTML は正規表現 + 位置スライスで扱う。section の入れ子は深さ計数、
       コメントアウトされたタグは範囲表で除外する。
   ============================================================================ */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SUBCOMMANDS = ['check', 'integrate', 'resync'];
const USAGE =
  'usage: node tools/fragment.mjs <check|integrate|resync> <deckDir> [name] [--dry-run]\n' +
  '  例: node tools/fragment.mjs check decks/my-deck\n' +
  '      node tools/fragment.mjs integrate decks/my-deck ch2';

function die(msg, code = 2) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

/* ============================== HTML スライス ============================== */

/** HTML コメントの [start, end) 一覧(昇順・非重複) */
function commentRanges(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(html))) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** idx が commentRanges のいずれかに含まれるか(二分探索) */
function inRanges(ranges, idx) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (idx < s) hi = mid - 1;
    else if (idx >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

/** <section> の対応する </section> の直後 index を深さ計数で返す(-1 = 閉じ不足)。
 *  コメントアウトされた <section> / </section> は数えない。 */
function balancedSectionEnd(html, openIdx, ranges) {
  const re = /<section\b|<\/section\s*>/gi;
  re.lastIndex = openIdx;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (inRanges(ranges, m.index)) continue;
    if (m[0][1] === '/') {
      if (--depth === 0) return re.lastIndex;
    } else {
      depth++;
    }
  }
  return -1;
}

/* SPEC コメントの許容形:
 *   <!-- ==== SPEC S13: 題名 ==== -->
 *   <!-- ==== SPEC S22B (3-2) [新設]: 題名 ==== -->   ← ID とコロンの間にラベル可
 * ID は英数字 + '-' / '_'(S22B や APX-DIV のような非整数 ID を一級で扱う)。 */
const SPEC_RE = () =>
  /<!--\s*====\s*SPEC\s+([A-Za-z][A-Za-z0-9_-]*)[^\n:]*:([^\n]*?)=+\s*-->/g;

/** SPEC コメント + 直後の section を「ブロック」として全抽出。
 *  返す start は SPEC コメントの先頭(行頭ではない)。行頭にしないのは、
 *  置換時に index 側のインデントをそのまま残し、比較を対称にするため。 */
function specBlocks(html, label) {
  const ranges = commentRanges(html);
  const comments = [];
  const re = SPEC_RE();
  let m;
  while ((m = re.exec(html))) {
    comments.push({
      id: m[1].toUpperCase(),
      idRaw: m[1],
      title: m[2].replace(/=+\s*$/, '').trim(),
      cStart: m.index,
      cEnd: m.index + m[0].length,
    });
  }

  const blocks = [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    // section の開始タグは「次の SPEC コメントより前」に限る。無ければ
    // 直後に section を持たない宣言だけの SPEC コメント → 対象外として警告。
    const bound = i + 1 < comments.length ? comments[i + 1].cStart : html.length;
    let open = -1;
    for (let from = c.cEnd; ; ) {
      const k = html.indexOf('<section', from);
      if (k === -1 || k >= bound) break;
      if (!inRanges(ranges, k)) {
        open = k;
        break;
      }
      from = k + 8;
    }
    if (open === -1) {
      console.error(`warn: ${label}: SPEC ${c.idRaw} の直後に <section> が見つかりません(スキップ)`);
      continue;
    }
    const end = balancedSectionEnd(html, open, ranges);
    if (end === -1) die(`${label}: SPEC ${c.idRaw} の </section> が閉じていません`);
    blocks.push({ ...c, start: c.cStart, end, text: html.slice(c.cStart, end) });
  }

  // 同 ID が 2 個あると置換先が一意に決まらない → 明示エラー(黙って片方を選ばない)
  const seen = new Map();
  for (const b of blocks) {
    if (seen.has(b.id)) die(`${label}: SPEC ${b.idRaw} が重複しています(ID は一意にしてください)`);
    seen.set(b.id, b);
  }
  // 入れ子 section による範囲の重なりは置換で壊れる → 明示エラー
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start < blocks[i - 1].end) {
      die(`${label}: SPEC ${blocks[i - 1].idRaw} と ${blocks[i].idRaw} の範囲が重なっています(section の入れ子)`);
    }
  }
  return blocks;
}

/** 最初の実 <style>…</style>(コメント内は無視、limit より前に限る)の位置情報 */
function styleBlock(html, limit = html.length) {
  const ranges = commentRanges(html);
  const re = /<style\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m.index >= limit) return null;
    if (inRanges(ranges, m.index)) continue;
    const innerStart = m.index + m[0].length;
    const close = html.indexOf('</style>', innerStart);
    if (close === -1) return null;
    return { innerStart, innerEnd: close, inner: html.slice(innerStart, close).trim() };
  }
  return null;
}

/** 最後の section より後ろの standalone <script> 群(位置つき) */
function trailingScripts(html, blocks) {
  const after = blocks.length ? Math.max(...blocks.map((b) => b.end)) : 0;
  const ranges = commentRanges(html);
  const re = /<script\b[\s\S]*?<\/script\s*>/gi;
  re.lastIndex = after;
  const hits = [];
  let m;
  while ((m = re.exec(html))) {
    if (inRanges(ranges, m.index)) continue;
    hits.push([m.index, m.index + m[0].length]);
  }
  if (!hits.length) return { text: '', start: html.length, end: html.length, present: false };
  return {
    text: hits.map(([s, e]) => html.slice(s, e)).join('\n').trim(),
    start: hits[0][0],
    end: hits[hits.length - 1][1],
    present: true,
  };
}

/* ============================== マーカー区間 ============================== */

function markers(name, kind) {
  return kind === 'style'
    ? { begin: `/* ==== fragment:${name} begin ==== */`, end: `/* ==== fragment:${name} end ==== */` }
    : {
        begin: `<!-- ==== fragment:${name} script begin ==== -->`,
        end: `<!-- ==== fragment:${name} script end ==== -->`,
      };
}

/** index 内のマーカー区間(無ければ null)。begin だけあって end が無いのは破損。 */
function markerRegion(html, name, kind) {
  const { begin, end } = markers(name, kind);
  const s = html.indexOf(begin);
  if (s === -1) return null;
  const e = html.indexOf(end, s + begin.length);
  if (e === -1) die(`index.html の fragment:${name} ${kind} マーカーが begin だけで end がありません(手で修復してください)`);
  return { start: s, end: e + end.length, inner: html.slice(s + begin.length, e).trim() };
}

/* ============================== 差分レポート ============================== */

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const line = a.slice(0, i).split('\n').length;
  const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  return `  最初の相違 @${i} 文字目 (index 側 ${line} 行目)\n    index    : …${ctx(a)}\n    fragment : …${ctx(b)}`;
}

/** fragment 1 本と index の同期状態を判定する(read-only) */
function compareOne(name, indexHtml, fragHtml) {
  const iBlocks = specBlocks(indexHtml, 'index.html');
  const byId = new Map(iBlocks.map((b) => [b.id, b]));
  const fBlocks = specBlocks(fragHtml, `fragments/${name}.html`);
  const fStyle = styleBlock(fragHtml, fBlocks.length ? fBlocks[0].start : fragHtml.length);
  const fScript = trailingScripts(fragHtml, fBlocks);

  const lines = [];
  const mismatches = [];
  const orphans = [];

  // style
  const region = markerRegion(indexHtml, name, 'style');
  const want = fStyle ? fStyle.inner : '';
  const have = region ? region.inner : '';
  if (!fStyle && !region) {
    lines.push('  style   : SKIP  (fragment に <style> 無し)');
  } else if (want === have) {
    lines.push(`  style   : MATCH (${have.length} chars)`);
  } else {
    mismatches.push('style');
    lines.push(
      region
        ? `  style   : MISMATCH (index ${have.length} vs fragment ${want.length} chars)\n${firstDiff(have, want)}`
        : '  style   : MISMATCH (index にマーカー区間が無い — integrate 未実行)'
    );
  }

  // script
  const sRegion = markerRegion(indexHtml, name, 'script');
  if (!fScript.present && !sRegion) {
    // 何も無いのが正常 — 静かに通す
  } else if ((sRegion ? sRegion.inner : '') === fScript.text) {
    lines.push(`  script  : MATCH (${fScript.text.length} chars)`);
  } else {
    mismatches.push('script');
    lines.push(
      sRegion
        ? `  script  : MISMATCH (index ${sRegion.inner.length} vs fragment ${fScript.text.length} chars)`
        : '  script  : MISMATCH (index にマーカー区間が無い — integrate 未実行)'
    );
  }

  // sections
  for (const b of fBlocks) {
    const t = byId.get(b.id);
    if (!t) {
      orphans.push(b.idRaw);
      lines.push(`  ${b.idRaw.padEnd(7)} : ORPHAN   index に同 ID の SPEC が無い(骨格に追加が必要)`);
      continue;
    }
    if (t.text === b.text) {
      lines.push(`  ${b.idRaw.padEnd(7)} : MATCH`);
    } else {
      mismatches.push(b.idRaw);
      lines.push(
        `  ${b.idRaw.padEnd(7)} : MISMATCH (index ${t.text.length} vs fragment ${b.text.length} chars)\n${firstDiff(t.text, b.text)}`
      );
    }
  }

  return { lines, mismatches, orphans, sections: fBlocks.length };
}

/* ============================== 編集(適用) ============================== */

/** edits(ORIGINAL 文字列に対する位置)を降順に当てる */
function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** fragment → index(1 本ぶんの編集を計算して新しい index 文字列を返す) */
function integrateOne(name, indexHtml, fragHtml, report) {
  const fBlocks = specBlocks(fragHtml, `fragments/${name}.html`);
  if (!fBlocks.length) console.error(`warn: fragments/${name}.html に SPEC ブロックがありません`);
  const fStyle = styleBlock(fragHtml, fBlocks.length ? fBlocks[0].start : fragHtml.length);
  const fScript = trailingScripts(fragHtml, fBlocks);
  const iBlocks = specBlocks(indexHtml, 'index.html');
  const byId = new Map(iBlocks.map((b) => [b.id, b]));
  const edits = [];

  // sections — ID 照合。index に無い ID は触らずに警告(骨格の採番漏れ)。
  for (const b of fBlocks) {
    const t = byId.get(b.id);
    if (!t) {
      report.orphans.push(b.idRaw);
      continue;
    }
    edits.push({ start: t.start, end: t.end, text: b.text });
    report.replaced.push(b.idRaw);
  }

  // style — deck-local <style> 末尾のマーカー区間を upsert
  if (fStyle) {
    const { begin, end } = markers(name, 'style');
    const block = `${begin}\n${fStyle.inner}\n${end}`;
    const region = markerRegion(indexHtml, name, 'style');
    if (region) {
      edits.push({ start: region.start, end: region.end, text: block });
      report.style = 'replace(マーカー区間を更新)';
    } else {
      const deckStyle = styleBlock(indexHtml, iBlocks.length ? iBlocks[0].start : indexHtml.length);
      if (!deckStyle) die('index.html に deck-local <style> が見つかりません(<head> に <style></style> を用意してください)');
      edits.push({ start: deckStyle.innerEnd, end: deckStyle.innerEnd, text: `\n${block}\n` });
      report.style = 'insert(deck-local <style> 末尾へ新規)';
    }
  }

  // script — </body> 直前のマーカー区間を upsert
  if (fScript.present) {
    const { begin, end } = markers(name, 'script');
    const block = `${begin}\n${fScript.text}\n${end}`;
    const region = markerRegion(indexHtml, name, 'script');
    if (region) {
      edits.push({ start: region.start, end: region.end, text: block });
      report.script = 'replace(マーカー区間を更新)';
    } else {
      const bodyClose = indexHtml.lastIndexOf('</body>');
      if (bodyClose === -1) die('index.html に </body> が見つかりません');
      edits.push({ start: bodyClose, end: bodyClose, text: `${block}\n` });
      report.script = 'insert(</body> 直前へ新規)';
    }
  }

  return applyEdits(indexHtml, edits);
}

/** index → fragment(逆同期。fragment の構造・並び・非 SPEC 部分は保つ) */
function resyncOne(name, indexHtml, fragHtml, report) {
  const fBlocks = specBlocks(fragHtml, `fragments/${name}.html`);
  const fStyle = styleBlock(fragHtml, fBlocks.length ? fBlocks[0].start : fragHtml.length);
  const fScript = trailingScripts(fragHtml, fBlocks);
  const byId = new Map(specBlocks(indexHtml, 'index.html').map((b) => [b.id, b]));
  const edits = [];

  for (const b of fBlocks) {
    const t = byId.get(b.id);
    if (!t) {
      report.orphans.push(b.idRaw);
      continue;
    }
    edits.push({ start: b.start, end: b.end, text: t.text });
    report.replaced.push(b.idRaw);
  }

  const region = markerRegion(indexHtml, name, 'style');
  if (fStyle && region) {
    edits.push({ start: fStyle.innerStart, end: fStyle.innerEnd, text: `\n${region.inner}\n` });
    report.style = 'replace(index のマーカー区間から上書き)';
  } else if (fStyle && !region) {
    console.error(`warn: index.html に fragment:${name} の style マーカーが無いため style は逆同期していません(先に integrate)`);
    report.style = 'skip(index にマーカー無し)';
  }

  const sRegion = markerRegion(indexHtml, name, 'script');
  if (sRegion) {
    const text = fScript.present ? sRegion.inner : `\n\n${sRegion.inner}\n`;
    edits.push({ start: fScript.start, end: fScript.end, text });
    report.script = 'replace(index のマーカー区間から上書き)';
  } else if (fScript.present) {
    console.error(`warn: index.html に fragment:${name} の script マーカーが無いため script は逆同期していません(先に integrate)`);
    report.script = 'skip(index にマーカー無し)';
  }

  return applyEdits(fragHtml, edits);
}

/* ============================== 入出力・骨組み ============================== */

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const positional = argv.filter((a) => !a.startsWith('--'));
const [sub, deckArg, nameArg] = positional;

if (!sub || !SUBCOMMANDS.includes(sub)) {
  console.error(sub ? `error: 未知のサブコマンド: ${sub}` : 'error: サブコマンドが必要です');
  console.error(USAGE);
  process.exit(2);
}
if (!deckArg) {
  console.error('error: <deckDir> が必要です');
  console.error(USAGE);
  process.exit(2);
}

const deckDir = path.resolve(process.cwd(), deckArg);
const indexPath = path.join(deckDir, 'index.html');
const fragDir = path.join(deckDir, 'fragments');
if (!existsSync(indexPath)) die(`${indexPath} が見つかりません`);
if (!existsSync(fragDir)) die(`${fragDir} が見つかりません(fragment は <deckDir>/fragments/<name>.html)`);

/** 対象 fragment 名の解決。name 省略時は fragments/*.html 全部
 *  ('_' 始まりは head/tail の部品とみなして一括対象から除く。明示指定なら扱う)。 */
let names;
if (nameArg) {
  const base = path.basename(nameArg).replace(/\.html$/i, '');
  if (!existsSync(path.join(fragDir, `${base}.html`))) die(`${path.join(fragDir, `${base}.html`)} が見つかりません`);
  names = [base];
} else {
  names = (await fs.readdir(fragDir))
    .filter((f) => f.endsWith('.html') && !f.startsWith('_'))
    .map((f) => f.replace(/\.html$/i, ''))
    .sort();
  if (!names.length) die(`${fragDir} に fragment (*.html) がありません`);
}

const read = (p) => fs.readFile(p, 'utf8');
const fragPath = (n) => path.join(fragDir, `${n}.html`);
const deckRel = path.relative(process.cwd(), deckDir) || '.';

/** 破壊的操作の前に対象ファイルを out/fragment-backup/<timestamp>/ へ退避 */
async function backup() {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const dir = path.join(deckDir, 'out', 'fragment-backup', ts);
  await fs.mkdir(path.join(dir, 'fragments'), { recursive: true });
  await fs.copyFile(indexPath, path.join(dir, 'index.html'));
  for (const n of names) await fs.copyFile(fragPath(n), path.join(dir, 'fragments', `${n}.html`));
  return dir;
}

/** 全 fragment の同期状態を判定して表示。{ mismatches, orphans } を返す */
function runCheck(indexHtml, fragTexts, heading) {
  console.log(heading);
  let mism = 0;
  const orphans = [];
  for (const n of names) {
    const r = compareOne(n, indexHtml, fragTexts.get(n));
    console.log(`fragments/${n}.html — ${r.sections} sections`);
    for (const l of r.lines) console.log(l);
    mism += r.mismatches.length;
    orphans.push(...r.orphans.map((o) => `${n}:${o}`));
  }
  console.log('────────────────────────────────────────────────');
  if (mism === 0 && !orphans.length) console.log('結果: PASS — index ↔ fragments diff=0');
  else {
    if (mism) console.log(`結果: FAIL — 不一致 ${mism} 件`);
    if (orphans.length) console.log(`統合先の無い ID ${orphans.length} 件: ${orphans.join(', ')}`);
  }
  return { mismatches: mism, orphans };
}

const indexHtml0 = await read(indexPath);
const fragTexts0 = new Map();
for (const n of names) fragTexts0.set(n, await read(fragPath(n)));

if (sub === 'check') {
  const r = runCheck(indexHtml0, fragTexts0, `fragment check: ${deckRel}(${names.length} fragments)`);
  process.exit(r.mismatches ? 1 : r.orphans.length ? 3 : 0);
}

// ---- integrate / resync ------------------------------------------------------
const report = { replaced: [], orphans: [], style: 'skip(なし)', script: 'skip(なし)' };
let nextIndex = indexHtml0;
const nextFrags = new Map(fragTexts0);

if (sub === 'integrate') {
  for (const n of names) nextIndex = integrateOne(n, nextIndex, fragTexts0.get(n), report);
} else {
  for (const n of names) nextFrags.set(n, resyncOne(n, indexHtml0, fragTexts0.get(n), report));
}

const changed =
  sub === 'integrate'
    ? nextIndex !== indexHtml0
    : names.some((n) => nextFrags.get(n) !== fragTexts0.get(n));

let backupDir = null;
if (!dryRun && changed) {
  backupDir = await backup();
  if (sub === 'integrate') await fs.writeFile(indexPath, nextIndex);
  else for (const n of names) await fs.writeFile(fragPath(n), nextFrags.get(n));
}

console.log('────────────────────────────────────────────────');
console.log(`fragment ${sub}: ${deckRel}${dryRun ? '  [DRY-RUN 変更なし]' : changed ? '' : '  [変更なし]'}`);
console.log(`  fragments : ${names.join(', ')}`);
console.log(`  sections  : ${report.replaced.length ? report.replaced.join(', ') : '(なし)'}  (${report.replaced.length} 枚)`);
console.log(`  style     : ${report.style}`);
console.log(`  script    : ${report.script}`);
if (report.orphans.length) console.log(`  未反映 ID : ${report.orphans.join(', ')}  ← 対向に同 ID の SPEC が無い`);
if (backupDir) console.log(`  backup    : ${path.relative(process.cwd(), backupDir)}`);

// 実行後に check 相当を回して diff=0 を確認する(統合の自己検証)
const r = runCheck(nextIndex, nextFrags, `\n${sub} 後の自己検証:`);
process.exit(r.mismatches ? 1 : r.orphans.length ? 3 : 0);
