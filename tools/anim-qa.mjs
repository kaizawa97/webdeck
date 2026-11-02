/* ============================================================================
   tools/anim-qa.mjs — in-slide CSS アニメの中間フレーム QA(観測ツール)
   使い方: node tools/anim-qa.mjs <deckDir> --slide <n> [--times "0,0.4,0.9,1.5,3"]
           node tools/anim-qa.mjs <deckDir> --slide 3,7 --every 250 --duration 3
   出力:   <deckDir>/out/anim-qa/slide-<n>/t<ミリ秒>.png(各時点のフレーム)
           <deckDir>/out/anim-qa/slide-<n>/contact-sheet.png(一覧。目視用)
           <deckDir>/out/anim-qa/slide-<n>/contact-sheet.html(上記の組版元)

   なぜ要るか:
   verify.mjs / export-* は prefers-reduced-motion: reduce + screenshot の
   animations: 'disabled' で撮る。これは「アニメ途中の誤った数値を焼き込まない」
   ための正しい設計だが、副作用として "終端は正常・再生途中だけ壊れる" バグ
   (途中フレームでの重なり・逆方向の回転・読めない中間文字・唐突な飛び)を
   構造的に見逃す。本ツールはその盲点だけを埋める:reduced-motion を切り、
   アニメを生かしたまま実時間で複数フレームを撮る。

   判定は機械ではなく人間の目でやる。撮った PNG / コンタクトシートを Read で
   開いて見るところまでが 1 サイクル(machine gate は違和感を捕まえない)。

   前提: デッキの in-slide アニメは Reveal が付ける .present を起点に発火する
   (例: `.present .st-ch { animation: chin .7s forwards; }`)。よって対象面へ
   「別の面から入り直す」ことで再生をやり直させ、到達直後を t=0 とする。

   注: ファイル名のミリ秒は 5 桁ゼロ詰め(t00400.png)。ls / Read の並び順が
       そのまま時間順になり、目視レビューで前後を取り違えない。
   注: console error / pageerror は警告として表示するだけで exit code に
       しない(そのゲートは verify.mjs の仕事)。
   ============================================================================ */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { REPO_ROOT, resolveDeckDir, serveForDeck, deckUrlPath } from './lib.mjs';

const DEFAULT_TIMES = [0, 0.3, 0.7, 1.2, 2, 3.5, 5];
const PARK_SETTLE_MS = 450;  // transition 'fade'/'fast'(400ms)が終わるまで待って前面の .present を確実に落とす
const MAX_FRAMES = 60;       // --every の暴走防止(1 面あたり)
const SHEET_COLS = 4;
const SHEET_CELL_W = 440;

const USAGE = [
  'usage: node tools/anim-qa.mjs <deckDir> --slide <n> [--times "0,0.4,0.9,1.5,3"]',
  '       node tools/anim-qa.mjs <deckDir> --slide 3,7 --every 250 --duration 3',
  '  --slide    1 始まりの水平スライド番号(カンマ区切り / 複数回指定で複数面)',
  '  --times    到達を t=0 とした撮影時点(秒)。既定: ' + DEFAULT_TIMES.join(','),
  '  --every    等間隔サンプリングの間隔(ms)。--duration と併用・--times と排他',
  '  --duration 等間隔サンプリングの長さ(秒)',
].join('\n');

/* ---------------------------------------------------------------------------
   引数解析
--------------------------------------------------------------------------- */
const argv = process.argv.slice(2);

function die(msg) {
  console.error(`error: ${msg}`);
  console.error(USAGE);
  process.exit(2);
}

const positionals = [];
const slideArgs = [];
let timesArg = null;
let everyArg = null;
let durationArg = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--slide') { slideArgs.push(argv[++i]); continue; }
  if (a === '--times') { timesArg = argv[++i]; continue; }
  if (a === '--every') { everyArg = argv[++i]; continue; }
  if (a === '--duration') { durationArg = argv[++i]; continue; }
  if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  if (a.startsWith('--')) die(`未知のオプション: ${a}`);
  positionals.push(a);
}

const deckDir = resolveDeckDir(positionals[0]);
// 表示用のデッキ名。プラットフォーム内なら decks/x、外部プロジェクトのデッキなら
// cwd 相対(それも外なら絶対パス)— ログとコンタクトシートの見出しで面を取り違えないため
const deckRel = (() => {
  const fromRepo = path.relative(REPO_ROOT, deckDir);
  if (fromRepo && !fromRepo.startsWith('..')) return fromRepo;
  const fromCwd = path.relative(process.cwd(), deckDir);
  return fromCwd && !fromCwd.startsWith('..') ? fromCwd : deckDir;
})();

if (!slideArgs.length) die('--slide が必要です(1 始まりの水平スライド番号)');
if (timesArg !== null && (everyArg !== null || durationArg !== null)) {
  die('--times と --every/--duration は排他です(どちらか一方)');
}
if ((everyArg === null) !== (durationArg === null)) {
  die('--every と --duration は同時に指定してください');
}

/** "3,7" や複数回指定を 1 始まりの整数配列に畳む */
const slideNumbers = [...new Set(
  slideArgs.flatMap((s) => String(s ?? '').split(','))
    .map((s) => s.trim()).filter(Boolean)
    .map((s) => {
      if (!/^\d+$/.test(s)) die(`--slide は正の整数で指定してください(指定値: ${s})`);
      const n = Number(s);
      if (n < 1) die(`--slide は 1 以上です(指定値: ${s})`);
      return n;
    })
)].sort((a, b) => a - b);

/** 撮影時点(秒)の列を決める */
let times;
if (everyArg !== null) {
  const every = Number(everyArg);
  const duration = Number(durationArg);
  if (!Number.isFinite(every) || every <= 0) die(`--every は正の数(ms)です(指定値: ${everyArg})`);
  if (!Number.isFinite(duration) || duration <= 0) die(`--duration は正の数(秒)です(指定値: ${durationArg})`);
  times = [];
  for (let ms = 0; ms <= duration * 1000 + 1e-6; ms += every) times.push(ms / 1000);
  if (times.length > MAX_FRAMES) {
    die(`サンプル数が ${times.length} 枚になります(上限 ${MAX_FRAMES})。--every を大きくするか --duration を短くしてください`);
  }
} else if (timesArg !== null) {
  times = timesArg.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const t = Number(s);
    if (!Number.isFinite(t) || t < 0) die(`--times は 0 以上の秒数のカンマ区切りです(指定値: ${s})`);
    return t;
  });
  if (!times.length) die('--times が空です');
  if (times.length > MAX_FRAMES) die(`--times が ${times.length} 点あります(上限 ${MAX_FRAMES})`);
} else {
  times = DEFAULT_TIMES.slice();
}
times = [...new Set(times)].sort((a, b) => a - b);

/* ---------------------------------------------------------------------------
   ヘルパ
--------------------------------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const frameName = (seconds) => `t${String(Math.round(seconds * 1000)).padStart(5, '0')}.png`;

/** 1280×720・アニメ有効(reducedMotion: no-preference)でデッキを開く。
 *  lib.openDeck は reduce 固定(数値の誤焼き込み防止)なので、ここだけ同等ロジックを持つ。 */
async function openDeckAnimated(browser, origin, root, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    // ここが verify との唯一の本質的な差: アニメを生かして中間フレームを観測する
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  if (opts.onConsole) page.on('console', opts.onConsole);
  if (opts.onPageError) page.on('pageerror', opts.onPageError);
  const url = origin + deckUrlPath(deckDir, root);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.Reveal && window.Reveal.isReady && window.Reveal.isReady(),
    null, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  // 検証対象外の UI(ドック・レターボックス演出)はスクショに写さない — verify.mjs と同じ扱い
  await page.addStyleTag({ content: [
    '.pp-dock { display: none !important; }',
    '.reveal-viewport { background: var(--pp-bg, #fff) !important; }',
    '.reveal > .backgrounds { box-shadow: none !important; }',
  ].join('\n') });
  return { context, page };
}

/** 対象面へ「入り直して」再生をやり直させ、到達直後(= .present 付与直後)を返す。
 *  戻り値の t0 は node 側の時計。evaluate の往復ぶん数 ms 遅れるが実用上無視できる。 */
async function arriveAtSlide(page, page0IndexH, hCount) {
  if (hCount === 1) {
    // 1 面デッキは「別の面から入る」が作れないのでリロードで .present を付け直す
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.Reveal && window.Reveal.isReady && window.Reveal.isReady(),
      null, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
  } else {
    // 直前の面から入る(1 面目だけは 2 面目から戻る)。本番と同じ遷移で入るので
    // t=0 付近のフレームに transition のクロスフェードも正しく写る。
    const parkH = page0IndexH > 0 ? page0IndexH - 1 : 1;
    await page.evaluate((h) => window.Reveal.slide(h, 0, 0), parkH);
    await sleep(PARK_SETTLE_MS);
  }

  const info = await page.evaluate((h) => {
    // f=99 は最終 fragment に丸められる(verify.mjs と同じ「全表示」状態にする)
    window.Reveal.slide(h, 0, 99);
    // 入れ子など丸めきれないものが残っていたら送り切る(t=0 より前に済ませる)
    for (let i = 0; i < 200; i++) {
      const av = typeof window.Reveal.availableFragments === 'function' ? window.Reveal.availableFragments() : null;
      if (!av || !av.next) break;
      window.Reveal.nextFragment();
    }
    const s = window.Reveal.getCurrentSlide();
    const hd = s.querySelector('h1, h2, h3');
    // 見出しが無い面(カバー・クロージング等)はクラス名で代用する。ただし
    // Reveal が動的に付ける状態クラスは面の識別に無意味なので落とす
    const STATE = ['present', 'past', 'future', 'stack', 'visible', 'enabled', 'current-fragment'];
    const raw = hd ? hd.textContent
      : ((s.getAttribute('class') || '').split(/\s+/).filter((c) => c && !STATE.includes(c)).join(' ')
        || s.id || '(無題)');
    const frags = s.querySelectorAll('.fragment').length;
    return {
      label: raw.trim().replace(/\s+/g, ' ').slice(0, 60),
      fragments: frags,
      visibleFragments: s.querySelectorAll('.fragment.visible').length,
    };
  }, page0IndexH);

  return { t0: Date.now(), ...info };
}

/** 撮った PNG をグリッド HTML に並べ、同じブラウザでページごとスクショして
 *  コンタクトシートを作る(新規依存を入れないための手段)。 */
async function buildContactSheet(browser, dir, header, frames) {
  const cols = Math.min(SHEET_COLS, frames.length);
  const cellH = Math.round(SHEET_CELL_W * 720 / 1280);
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${header}</title>
<style>
  body { margin: 0; padding: 14px; background: #12161b;
         font-family: "Noto Sans CJK JP", "IPAexGothic", "Noto Sans JP", sans-serif; }
  h1 { margin: 0 0 12px; font-size: 15px; font-weight: 600; color: #e6e9ed; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, ${SHEET_CELL_W}px); gap: 14px; }
  figure { margin: 0; }
  figcaption { padding: 5px 2px 0; font-size: 12px; color: #cbd2da;
               font-variant-numeric: tabular-nums; }
  img { display: block; width: ${SHEET_CELL_W}px; height: ${cellH}px;
        border: 1px solid #2d353f; background: #fff; }
</style></head><body>
<h1>${header}</h1>
<div class="grid">
${frames.map((f) => `  <figure><img src="${f.file}" alt="${f.label}"><figcaption>${f.label}</figcaption></figure>`).join('\n')}
</div>
</body></html>
`;
  const htmlPath = path.join(dir, 'contact-sheet.html');
  await fs.writeFile(htmlPath, html);

  const sheetW = cols * SHEET_CELL_W + (cols - 1) * 14 + 28;
  const context = await browser.newContext({ viewport: { width: sheetW, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all(
      Array.from(document.images).map((img) => img.complete
        ? null
        : new Promise((r) => { img.onload = r; img.onerror = r; }))
    ));
    await page.evaluate(() => document.fonts.ready);
    // 中身の高さにビューポートを合わせる(fullPage も scrollHeight もビューポート高で
    // 下限が張るため、下に大きな余白が入って一覧性が落ちる。body の箱を実測する)
    const contentH = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await page.setViewportSize({ width: sheetW, height: Math.max(120, contentH) });
    const out = path.join(dir, 'contact-sheet.png');
    await page.screenshot({ path: out });
    return { png: out, html: htmlPath };
  } finally {
    await context.close();
  }
}

/* ---------------------------------------------------------------------------
   メイン
--------------------------------------------------------------------------- */
const pageIssues = { consoleErrors: [], pageErrors: [] };
const server = await serveForDeck(deckDir);
const browser = await chromium.launch();
let exitCode = 0;

try {
  const { context, page } = await openDeckAnimated(browser, server.origin, server.root, {
    onConsole: (msg) => { if (msg.type() === 'error') pageIssues.consoleErrors.push(msg.text()); },
    onPageError: (err) => pageIssues.pageErrors.push(err.message),
  });

  const hCount = await page.evaluate(() => window.Reveal.getHorizontalSlides().length);
  if (!hCount) throw new Error('スライドが 1 枚も見つかりません');
  for (const n of slideNumbers) {
    if (n > hCount) throw new Error(`--slide ${n} はスライド数(${hCount})を超えています`);
  }

  console.log(`アニメQA: ${deckRel}(水平 ${hCount} 面 / 対象 ${slideNumbers.join(', ')})`);
  console.log(`  撮影時点(到達を t=0 とした秒): ${times.join(', ')}`);

  const generated = [];
  for (const n of slideNumbers) {
    const dir = path.join(deckDir, 'out', 'anim-qa', `slide-${n}`);
    await fs.rm(dir, { recursive: true, force: true }); // 前回の残骸で誤読しないよう毎回作り直す
    await fs.mkdir(dir, { recursive: true });

    const arrival = await arriveAtSlide(page, n - 1, hCount);
    console.log('');
    console.log(`  slide ${n}「${arrival.label}」 — fragment ${arrival.visibleFragments}/${arrival.fragments} 表示`);

    const frames = [];
    for (const t of times) {
      await sleep(arrival.t0 + t * 1000 - Date.now());
      const actual = Date.now() - arrival.t0;
      const file = frameName(t);
      // animations: 'allow'(既定)= 撮影のためにアニメを止めない。ここが verify との差
      await page.screenshot({ path: path.join(dir, file), animations: 'allow' });
      const drift = actual - Math.round(t * 1000);
      const label = `t=${t.toFixed(3)}s` + (Math.abs(drift) > 60 ? `(実測 ${actual}ms)` : '');
      frames.push({ file, label, requestedMs: Math.round(t * 1000), actualMs: actual });
      console.log(`    ${label.padEnd(24)} → ${path.join('out', 'anim-qa', `slide-${n}`, file)}`
        + (Math.abs(drift) > 60 ? '' : ` (実測 ${actual}ms)`));
      generated.push(path.join(dir, file));
    }

    const sheet = await buildContactSheet(browser, dir,
      `${deckRel} — slide ${n}「${arrival.label}」 / t=0 は到達(.present 付与)時点`, frames);
    generated.push(sheet.png, sheet.html);
    console.log(`    コンタクトシート → ${path.join('out', 'anim-qa', `slide-${n}`, 'contact-sheet.png')}`);
  }

  await context.close();

  console.log('');
  console.log(`生成ファイル ${generated.length} 件:`);
  for (const f of generated) console.log(`  ${path.relative(process.cwd(), f)}`);
  if (pageIssues.consoleErrors.length || pageIssues.pageErrors.length) {
    console.log('');
    console.log(`警告: ページエラーを検出(判定は verify.mjs で):`);
    for (const e of pageIssues.consoleErrors) console.log(`  - console error: ${e}`);
    for (const e of pageIssues.pageErrors) console.log(`  - pageerror: ${e}`);
  }
  console.log('');
  console.log('次にやること: Read で開いて目視すること(重なり/タイミング/読めない文字/唐突な動き/方向)。');
} catch (err) {
  console.error(`error: アニメQA に失敗しました: ${err.message}`);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

process.exit(exitCode);
