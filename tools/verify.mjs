/* ============================================================================
   tools/verify.mjs — デッキ自己検証ハーネス
   使い方: node tools/verify.mjs <deckDir> [--strict] [--font-floor=<px>]
                                 [--font-exclude="<sel,…>"] [--baseline <deckDir>]
   出力:   <deckDir>/out/verify/slide-NN.png(fragment 全表示状態)
           <deckDir>/out/verify/report.json / report.md
           <deckDir>/out/verify/baseline/{current,before}/slide-NN.png(--baseline 指定時。
             現行と変更前を同一実行・同一条件で撮り直したもの)

   検査内容:
   a. オーバーフロー検出 — 各スライドの可視要素が .slides キャンバス(Reveal config。
      既定 1280×720)から 4px を超えてはみ出していないか(.slides の rect 基準 →
      scale 非依存)。矩形は overflow:hidden|clip の祖先でクランプしてから測る
      (CSS クロップ画像の raw box による誤検知を根絶)
   b. ページエラー — console error / pageerror / requestfailed / HTTP >=400
   c. フォント — document.fonts.status と読み込み失敗フォント
   d. コントラスト簡易チェック(warning)。SVG <text> は CSS color ではなく fill を
      前景色として解決し、半透明背景は合成して実効背景色を出す。判定不能は件数で報告
   e. 重なりスイープ(warning)— 血縁でない要素の可視矩形が交差していないか。文字は
      行ごとの字面(グリフ)で測る。フッター帯・.src 行への侵入と gap も報告
   f. 静的アサート(warning)— <aside> 開閉数 / 見出しの句読点 / 見出しの実描画行数 /
      テーマ CSS とアセット系統の整合
   g. 実効フォント px の床(--font-floor 指定時)— SVG は viewBox 比を掛けた実寸で測る
   h. baseline md5 照合(--baseline 指定時)— 両デッキを同一実行・同一条件で撮って
      静止面の画素不変を証明する。同一デッキの再撮影でも md5 が変わる面は
      「比較不能(unstable)」として偽差分と区別する(いずれも判定には混ぜない)

   常時スクショの残骸を purge し、実行後に report の枚数と実在 PNG を照合する。

   exit code: a / b / スクショ枚数不一致 があれば 1。--font-floor の床割れも 1。
              --strict では e(交差)と f も 1 に昇格する(gap 近接注意は昇格しない)
   ============================================================================ */

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { REPO_ROOT, serveRepo, resolveDeckDir, ensureOutDir, openDeck, serveForDeck, serveRootFor } from './lib.mjs';

const OVERFLOW_TOLERANCE_PX = 4;   // キャンバス座標系(1280×720)での許容はみ出し量
const OVERLAP_MIN_AREA_PX2 = 4;    // 重なりスイープの下限交差面積(これ以下は隣接の誤差として無視)
const BAND_PROXIMITY_PX = 20;      // 固定物(フッター帯・.src 行)への近接注意しきい値

// フォント床検査の共通除外(プラットフォーム規約の役物)。テーマ固有の役物は
// テーマ manifest(template.json)の verify.fontFloorExclude から連結する
const FONT_EXCLUDE_COMMON = '.src, figcaption, .cap';

/* ---------------------------------------------------------------------------
   引数解析
--------------------------------------------------------------------------- */
function usage() {
  console.error([
    'usage: node tools/verify.mjs <deckDir> [オプション]',
    '',
    '  <deckDir>                   index.html を含むデッキディレクトリ',
    '',
    'オプション:',
    '  --strict                    重なり・固定物交差・静的アサートの WARN を FAIL(exit 1)に昇格',
    '                              (固定物への gap 近接注意は昇格しない)',
    '  --font-floor=<px>           実効フォント px の床を検査。床割れは FAIL(exit 1)',
    '  --font-exclude="<sel,…>"    フォント床の除外セレクタを追加',
    `                              (既定の除外: ${FONT_EXCLUDE_COMMON} + テーマ manifest の verify.fontFloorExclude)`,
    '  --baseline <deckDir>        変更前デッキとスライド PNG の md5 を照合(結果表示のみ・exit code に影響しない)',
    '',
    '例:',
    '  node tools/verify.mjs decks/my-deck',
    '  node tools/verify.mjs decks/my-deck --strict --font-floor=18',
    '  node tools/verify.mjs decks/my-deck --baseline ../head/decks/my-deck',
  ].join('\n'));
  process.exit(2);
}

const argv = process.argv.slice(2);
if (!argv.length) usage();

const flags = { strict: false, fontFloor: null, fontExclude: '', baseline: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const valueOf = (name) => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
  if (a === '--strict') flags.strict = true;
  else if (a === '--font-floor' || a.startsWith('--font-floor=')) {
    const v = parseFloat(valueOf());
    if (!(v > 0)) { console.error('error: --font-floor には正の px を指定してください(例 --font-floor=18)'); process.exit(2); }
    flags.fontFloor = v;
  } else if (a === '--font-exclude' || a.startsWith('--font-exclude=')) {
    flags.fontExclude = (valueOf() || '').trim();
  } else if (a === '--baseline' || a.startsWith('--baseline=')) {
    flags.baseline = valueOf();
    if (!flags.baseline) { console.error('error: --baseline にはデッキディレクトリを指定してください'); process.exit(2); }
  } else if (a.startsWith('-')) {
    console.error(`error: 未知のオプション: ${a}`);
    usage();
  } else positional.push(a);
}
if (positional.length !== 1) usage();

const deckDir = resolveDeckDir(positional[0]);
const deckRel = path.relative(REPO_ROOT, deckDir);

/* ---------------------------------------------------------------------------
   テーマ契約(themes/README.md)の解決 — マニフェスト駆動
   デッキ HTML の <link href> から themes/<name>/<file>.css への参照を見つけて
   テーマ dir を特定し、その template.json を読む。検証パラメータ(フッター帯の
   高さ・フォント床のテーマ除外・テーマ属性・モード系統)はテーマ名を
   ハードコードせず全てマニフェストから取る。
--------------------------------------------------------------------------- */
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isExternalRef = (v) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(v);
let themeManifest = null;
let themeDirAbs = null;
{
  const deckSrc = await fs.readFile(path.join(deckDir, 'index.html'), 'utf8');
  const themesRoot = path.join(REPO_ROOT, 'themes');
  for (const m of deckSrc.matchAll(/<link[^>]+href="([^"]+\.css)"/gi)) {
    const href = m[1];
    if (isExternalRef(href)) continue;
    const abs = path.resolve(deckDir, href);
    const rel = path.relative(themesRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // themes/ 配下でない
    themeDirAbs = path.join(themesRoot, rel.split(path.sep)[0]);
    break;
  }
  if (themeDirAbs) {
    const manifestPath = path.join(themeDirAbs, 'template.json');
    if (!existsSync(manifestPath)) {
      console.error(`error: テーマ契約違反: ${manifestPath} がありません(themes/README.md 参照)`);
      process.exit(2);
    }
    try {
      themeManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (err) {
      console.error(`error: テーマ契約違反: ${manifestPath} を読めません(${err.message})`);
      process.exit(2);
    }
  } else {
    console.error('warn: デッキにテーマ(themes/<name>/*.css)への参照がありません — ' +
      '既定値で検証します(フッター帯 0px・フォント床除外は共通分のみ)');
  }
}
// 下端のフッターゾーン(ロゴ・©・ページ番号の帯)。テキスト侵犯は警告。
// 高さはテーマ manifest の verify.footerZonePx(家具なしテーマ・テーマ未参照は 0)
const FOOTER_ZONE_PX = themeManifest?.verify?.footerZonePx ?? 0;

// フォント床の除外セレクタ(共通分 + テーマ manifest 分 + 追加指定。この順で連結)
const fontExcludeSel = [
  FONT_EXCLUDE_COMMON,
  ...(themeManifest?.verify?.fontFloorExclude ?? []),
  flags.fontExclude,
].filter(Boolean).join(', ');

/* --baseline: 変更前デッキ。両デッキとプラットフォームの共通祖先を配信ルートにする
   (デッキ HTML がエンジンを相対パスで参照するため、1 つのサーバで両方配信する) */
let baselineDir = null;
if (flags.baseline) {
  baselineDir = path.resolve(process.cwd(), flags.baseline);
  if (!existsSync(path.join(baselineDir, 'index.html'))) {
    console.error(`error: --baseline ${baselineDir}/index.html が見つかりません`);
    process.exit(2);
  }
  if (serveRootFor(deckDir, baselineDir) === path.parse(deckDir).root) {
    console.error('error: 2 つのデッキとプラットフォームの共通祖先がファイルシステムルートになります。' +
      'baseline デッキも同じホーム配下等に置いてください(相対参照とローカル配信の前提)');
    process.exit(2);
  }
}

/* ---------------------------------------------------------------------------
   スクリーンショットの残骸 purge と枚数照合
   撮影前に slide-*.png を全削除する。前回より枚数が減ったデッキで古い PNG が
   残ると、目視 QA と自動評価が「もう存在しない面」を見て誤った合格判定を出す
   (実測で事故った)。実行後に report の枚数と実在 PNG を突き合わせて担保する。
--------------------------------------------------------------------------- */
const SLIDE_PNG_RE = /^slide-\d+\.png$/i;

async function purgeSlidePngs(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  let purged = 0;
  for (const name of names) {
    if (!/^slide-.*\.png$/i.test(name)) continue;
    await fs.unlink(path.join(dir, name)).catch(() => {});
    purged++;
  }
  return purged;
}

async function countSlidePngs(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  return names.filter((n) => SLIDE_PNG_RE.test(n)).length;
}

/* ---------------------------------------------------------------------------
   鮮度: デッキソース(out/ 除外)の最新 mtime
   run 開始より新しいソースがあれば「レポートは既に古い」— 検証中にデッキを編集した
   場合の見落としを防ぐ(古いレポートを根拠に合格と報告する事故の防止)。
--------------------------------------------------------------------------- */
const MTIME_SKIP_DIRS = new Set(['out', 'node_modules', '.git']);

async function deckSourceMaxMtime(dir) {
  let max = 0;
  const walk = async (d) => {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (MTIME_SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs > max) max = st.mtimeMs;
    }
  };
  await walk(dir);
  return max;
}

const runStartedAtMs = Date.now();

/* ---------------------------------------------------------------------------
   f. 静的アサート(ソース HTML を読んで機械的に検出できる事故。既定 WARN)
   - <aside> の開閉数不一致: 閉じタグ欠落は DOM 側では自動修復されるため
     ブラウザ検証を素通りする。ノートが隣の面に漏れる事故の実測原因
   - テーマ CSS リンク(manifest の entry)と themeAttr・data-background-image の
     アセット系統(manifest の modeAssets)の不整合: 別モードの背景画像を混ぜると
     文字が沈む
--------------------------------------------------------------------------- */
async function staticSourceAsserts(dir) {
  const issues = [];
  const src = await fs.readFile(path.join(dir, 'index.html'), 'utf8');

  const openTags = (src.match(/<aside\b/gi) || []).length;
  const closeTags = (src.match(/<\/aside\s*>/gi) || []).length;
  if (openTags !== closeTags) {
    issues.push({
      kind: 'aside-balance',
      detail: `<aside 開 ${openTags} 個 / </aside> 閉 ${closeTags} 個 — 開閉が不一致(閉じ忘れはブラウザが自動修復するため描画では気づけない)`,
    });
  }

  // テーマ系統: <link ... themes/<name>/entry[mode]> と themeAttr、モード別アセットパス。
  // モード語彙・属性名・対応ファイルは全てテーマ manifest(template.json)から取る
  if (themeManifest) {
    const modes = themeManifest.modes || [];
    // リンクされているエントリ CSS からデッキのモード系統を判定
    // (href はデッキ位置基準で解決してから manifest の entry と突き合わせる)
    let linkMode = null;
    let linkEntry = null;
    for (const lm of src.matchAll(/<link[^>]+href="([^"]+\.css)"/gi)) {
      if (isExternalRef(lm[1])) continue;
      const abs = path.resolve(dir, lm[1]);
      for (const mode of modes) {
        const entry = themeManifest.entry?.[mode];
        if (entry && abs === path.join(themeDirAbs, entry)) { linkMode = mode; linkEntry = entry; break; }
      }
      if (linkMode) break;
    }
    // themeAttr(と legacyThemeAttrs)のいずれの属性名でもモード値を読む
    let attrMode = null;
    let attrName = null;
    for (const name of [themeManifest.themeAttr, ...(themeManifest.legacyThemeAttrs || [])].filter(Boolean)) {
      const m = new RegExp(`${escRe(name)}="(${modes.map(escRe).join('|')})"`, 'i').exec(src);
      if (m) { attrMode = m[1]; attrName = name; break; }
    }
    if (linkMode && attrMode && linkMode !== attrMode) {
      issues.push({
        kind: 'theme-consistency',
        detail: `テーマ CSS は ${linkEntry} だが ${attrName}="${attrMode}" — 系統が不一致`,
      });
    }
    if (linkMode && themeManifest.modeAssets) {
      const wrong = new Set();
      for (const m of src.matchAll(/data-background-image="([^"]+)"/gi)) {
        for (const [mode, assetDir] of Object.entries(themeManifest.modeAssets)) {
          if (mode === linkMode || !assetDir) continue;
          if (m[1].includes(assetDir)) wrong.add(m[1]);
        }
      }
      if (wrong.size) {
        issues.push({
          kind: 'theme-consistency',
          detail: `テーマ CSS は ${linkEntry} だが背景画像が別系統: ${[...wrong].slice(0, 6).join(', ')}${wrong.size > 6 ? ` 他 ${wrong.size - 6} 件` : ''}`,
        });
      }
    }
  }
  return issues;
}

/* ---------------------------------------------------------------------------
   スクショ条件(本体と baseline で必ず同一にする — 差分の原因を条件差にしないため)
   コントロールドックとレターボックス演出は検証対象外の UI なので写さない
   (margin>0 のデッキで余白にレターボックス色・エッジラインが写り込むのを防ぐ)
--------------------------------------------------------------------------- */
const SHOT_STYLE = [
  '.pp-dock { display: none !important; }',
  '.reveal-viewport { background: var(--pp-bg, #fff) !important; }',
  '.reveal > .backgrounds { box-shadow: none !important; }',
].join('\n');

const SETTLE_MS = 500; // transition 'fade'/'fast'(400ms)+ 背景画像の settle 待ち

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/* md5 照合用の撮影。現行デッキと baseline デッキを「同一実行・同一条件」で撮るため、
   両者ともこの関数だけを通す(過去の run で作った PNG とは比較しない)。
   only を渡すと撮るのはその面だけだが、送りは全面を順に辿る — 到達経路で
   autoAnimate や count-up の状態が変わるため、経路まで揃えないと条件が同一にならない。
   戻り値: { slideCount, shots: Map<面番号, md5> } */
async function shootDeck(browser, server, dir, { outDir = null, only = null } = {}) {
  const { context, page } = await openDeck(browser, server.origin, dir, { root: server.root });
  await page.addStyleTag({ content: SHOT_STYLE });
  const indices = await page.evaluate(() =>
    window.Reveal.getSlides().map((s) => {
      const { h, v } = window.Reveal.getIndices(s);
      return { h, v };
    })
  );
  const shots = new Map();
  for (let i = 0; i < indices.length; i++) {
    const n = i + 1;
    const { h, v } = indices[i];
    await page.evaluate(([hh, vv]) => window.Reveal.slide(hh, vv, 99), [h, v]);
    await page.waitForTimeout(SETTLE_MS);
    if (only && !only.includes(n)) continue;
    const name = `slide-${String(n).padStart(2, '0')}.png`;
    const buf = await page.screenshot({
      animations: 'disabled',
      ...(outDir ? { path: path.join(outDir, name) } : {}),
    });
    shots.set(n, md5(buf));
  }
  await context.close();
  return { slideCount: indices.length, shots };
}

/* ---------------------------------------------------------------------------
   ブラウザ内で実行するスライド検査
   (オーバーフロー / コントラスト / 重なり / 固定物 clearance / 見出し / フォント床)
   ※ page.evaluate に渡すため自己完結な関数にしておく(外の値は引数で渡す)
--------------------------------------------------------------------------- */
function inPageCheckSlide({ tolerance, footerZonePx, overlapMinAreaPx2, bandProximityPx, fontFloor, fontExcludeSel }) {
  const slidesEl = document.querySelector('.reveal .slides');
  const canvas = slidesEl.getBoundingClientRect(); // キャンバス実 rect(scale 適用後)
  const cfgWidth = (window.Reveal.getConfig().width) || 1280;
  const cfgHeight = (window.Reveal.getConfig().height) || 720;
  // フッター帯の高さはテーマ manifest の verify.footerZonePx(720 基準。テーマは
  // 家具をキャンバス高さの % で置く)。1440×810 など別サイズのキャンバスでは比例させる
  const footerBandPx = footerZonePx * (cfgHeight / 720);
  const scale = canvas.width / cfgWidth || 1;      // 実 px → キャンバス px 換算係数
  const section = window.Reveal.getCurrentSlide();

  /* ---- 色ユーティリティ(WCAG コントラスト) ---- */
  const parseColor = (str) => {
    const m = /^rgba?\(([^)]+)\)$/.exec(str || '');
    if (!m) return null; // lab()/color() 等は扱わない
    const p = m[1].split(',').map((s) => parseFloat(s));
    if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 };
  };
  const relLum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  // 半透明の層を下の色に合成する(alpha compositing)。パネルが rgba で敷かれている
  // だけで「判定不能」にすると、デッキの大半が測れなくなり軸が機能しない
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const contrastRatio = (c1, c2) => {
    const l1 = relLum(c1); const l2 = relLum(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  /* ---- 要素の説明文字列 ---- */
  const describe = (el) => {
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim();
    if (cls) d += '.' + cls.split(/\s+/).join('.');
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (text) d += ' 「' + text.slice(0, 40) + (text.length > 40 ? '…' : '') + '」';
    return d;
  };

  /* ---- 可視判定: display / visibility / opacity(祖先含む)/ 矩形の有無 ---- */
  const isVisible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility !== 'visible') return false;
    for (let cur = el; cur && cur !== slidesEl; cur = cur.parentElement) {
      if (parseFloat(getComputedStyle(cur).opacity) < 0.05) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };

  /* ---- 可視矩形: overflow: hidden|clip の祖先で交差クランプする ----
     CSS クロップ(overflow:hidden + 負 margin / object-fit)された画像は
     getBoundingClientRect が「クロップ前の raw box」を返すため、クランプしないと
     見えていない領域をはみ出し・重なりとして誤検知する(実測で誤検知の主因)。
     svg も UA 既定で overflow:hidden なので viewBox 外の描画は自動的に落ちる。
     戻り値は client 座標。クランプ結果が空(幅か高さ≤0)なら null = 実質不可視。 */
  const clipRect = (el) => {
    const r = el.getBoundingClientRect();
    let top = r.top, right = r.right, bottom = r.bottom, left = r.left;
    for (let cur = el.parentElement; cur; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      const clipX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const clipY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      if (clipX || clipY) {
        const pr = cur.getBoundingClientRect();
        if (clipX) { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
        if (clipY) { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
      }
      if (cur === slidesEl) break;
    }
    if (right - left <= 0 || bottom - top <= 0) return null;
    return { top, right, bottom, left, width: right - left, height: bottom - top };
  };

  /* ---- a. オーバーフロー検出 ---- */
  // transform された要素は getBoundingClientRect が軸平行境界箱(AABB)になり、
  // 回転装飾などで「見た目は内側なのにはみ出し」と誤検出し得るため警告に降格する
  const hasTransform = (el) => {
    for (let cur = el; cur && cur !== section; cur = cur.parentElement) {
      if (getComputedStyle(cur).transform !== 'none') return true;
    }
    return false;
  };

  const overflows = [];
  const overflowWarnings = []; // transform 由来(境界箱判定)の疑いあり
  const footerZoneWarnings = [];
  for (const el of section.querySelectorAll('*')) {
    if (el.closest('aside.notes')) continue; // ノートは表示対象外
    if (!isVisible(el)) continue;
    const r = clipRect(el);
    if (!r) continue; // クロップで消えている = 見えていないので判定対象外
    const over = {
      top: (canvas.top - r.top) / scale,
      right: (r.right - canvas.right) / scale,
      bottom: (r.bottom - canvas.bottom) / scale,
      left: (canvas.left - r.left) / scale,
    };
    const bad = {};
    for (const dir of ['top', 'right', 'bottom', 'left']) {
      if (over[dir] > tolerance) bad[dir] = Math.round(over[dir] * 10) / 10;
    }
    if (Object.keys(bad).length) {
      const entry = {
        element: describe(el),
        tag: el.tagName.toLowerCase(),
        class: el.getAttribute('class') || '',
        overflow: bad, // 方向ごとのはみ出し量(キャンバス px)
      };
      if (hasTransform(el)) {
        entry.note = 'transform あり(境界箱判定のため誤検出の可能性)';
        overflowWarnings.push(entry);
      } else {
        overflows.push(entry);
      }
    }

    // フッターゾーン侵犯(警告): 下端の帯にテキストを置くとロゴ・©・ページ番号と重なる。
    // 対象は直接テキストを持つ要素のみ(.src 出典行はゾーン内配置が仕様なので除外)
    if (footerBandPx > 0 && !el.closest('.src')) {
      let hasText = false;
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) { hasText = true; break; }
      }
      if (hasText) {
        const bottomIn = (r.bottom - canvas.top) / scale;
        if (bottomIn > cfgHeight - footerBandPx && bottomIn <= cfgHeight + tolerance) {
          footerZoneWarnings.push({
            element: describe(el),
            bottomPx: Math.round(bottomIn * 10) / 10,
            zoneStartPx: Math.round(cfgHeight - footerBandPx),
          });
        }
      }
    }
    if (overflows.length >= 30) break; // レポート爆発防止
  }

  /* ---- d. コントラスト簡易チェック(warning) ---- */
  const contrastWarnings = [];
  let contrastIndeterminate = 0; // 判定不能(背景画像上・半透明・図形塗り不明)= 目視必須

  /* SVG のテキストの背後は CSS の background ではなく図形の fill。テキスト矩形を包む
     不透明な図形を文書順で探し、テキストより前に描かれた最後のものを背景とする
     (後ろに描かれる図形はテキストの上に乗るので背景ではない)。 */
  const svgShapeBgUnder = (el) => {
    const root = el.ownerSVGElement;
    if (!root) return null;
    const tr = el.getBoundingClientRect();
    let found = null;
    for (const sh of root.querySelectorAll('rect, circle, ellipse, path, polygon, polyline')) {
      // el が sh より前 = sh は el の上に描かれる → 背景ではない
      if (sh.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) continue;
      const cs = getComputedStyle(sh);
      if (cs.display === 'none' || cs.visibility !== 'visible') continue;
      const fc = parseColor(cs.fill);
      const fo = parseFloat(cs.fillOpacity);
      const op = parseFloat(cs.opacity);
      if (!fc || fc.a < 0.99) continue;
      if (Number.isFinite(fo) && fo < 0.99) continue;
      if (Number.isFinite(op) && op < 0.99) continue;
      const r = sh.getBoundingClientRect();
      if (r.left <= tr.left + 0.5 && r.right >= tr.right - 0.5 &&
          r.top <= tr.top + 0.5 && r.bottom >= tr.bottom - 0.5) found = fc;
    }
    return found;
  };
  const sectionHasBgImage =
    section.hasAttribute('data-background-image') ||
    section.hasAttribute('data-background-video') ||
    section.hasAttribute('data-background-gradient') ||
    section.hasAttribute('data-background-iframe');
  // キャンバス地は .backgrounds(shell がレターボックス対応で --pp-bg を塗る)を
  // 第一候補にする。viewport 背景はレターボックス色になったため代表色にならない。
  const bgLayer = document.querySelector('.reveal > .backgrounds');
  const viewportBg =
    (bgLayer && (() => { const c = parseColor(getComputedStyle(bgLayer).backgroundColor); return c && c.a >= 0.99 ? c : null; })()) ||
    parseColor(getComputedStyle(document.querySelector('.reveal-viewport') || document.body).backgroundColor);

  for (const el of section.querySelectorAll('*')) {
    if (el.closest('aside.notes')) continue;
    // 直接テキストノードを持つ要素だけを対象にする
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) { hasText = true; break; }
    }
    if (!hasText || !isVisible(el)) continue;

    const st = getComputedStyle(el);
    const svgOwner = el.ownerSVGElement;
    // SVG の <text> は CSS の color ではなく fill が前景色(属性・style・継承の
    // いずれで指定されても computed style に解決される)。color を読むと
    // 「暗い背景に暗い文字」という誤検知になる — 実測で報告された誤検知の原因
    const fg = parseColor(svgOwner ? st.fill : st.color);
    if (!fg) { contrastIndeterminate++; continue; } // none / url() / lab() 等

    // 背景の探索: SVG 内は背後の図形の fill、HTML は祖先の不透明 background-color。
    // 途中で背景画像・半透明背景に当たったら判定不能として skip。
    let bg = svgOwner ? svgShapeBgUnder(el) : null;
    let indeterminate = false;
    const layers = []; // 内側→外側の順に積んだ半透明背景。不透明な地が決まってから合成する
    if (!bg) {
      for (let cur = el; cur; cur = cur.parentElement) {
        const cs = getComputedStyle(cur);
        // エディターで挿入した図形(.pp-shape)は、輪郭の SVG の塗りが文字の地
        if (cur.classList && cur.classList.contains('pp-shape')) {
          const sp = cur.querySelector(':scope > svg.pp-sh-g .pp-sh-p');
          if (sp) {
            const ps = getComputedStyle(sp);
            if (/url\(/.test(ps.fill)) { indeterminate = true; break; }   // グラデーション
            const c = parseColor(ps.fill), fo = parseFloat(ps.fillOpacity);
            const a = c ? c.a * (isNaN(fo) ? 1 : fo) : 0;
            if (c && a >= 0.99) { bg = c; break; }
            if (c && a > 0.01) layers.push({ ...c, a });
          }
        }
        if (cs.backgroundImage && cs.backgroundImage !== 'none') { indeterminate = true; break; }
        const c = parseColor(cs.backgroundColor);
        if (c && c.a >= 0.99) { bg = c; break; }
        if (c && c.a > 0.01) layers.push(c);
        if (cur === section) break; // セクションまで見つからなければスライド背景へフォールバック
      }
    }
    if (indeterminate) { contrastIndeterminate++; continue; }
    if (!bg) {
      if (sectionHasBgImage) { contrastIndeterminate++; continue; } // 背景画像上は判定不能
      bg = viewportBg;
      if (!bg) { contrastIndeterminate++; continue; }
    }
    // 不透明な地の上に、外側の層から順に半透明背景を重ねて実効背景色を得る
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);

    // 文字色が半透明なら背景と合成して実効色にする
    const eff = fg.a >= 0.99 ? fg : {
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
    };
    const ratio = contrastRatio(eff, bg);
    const fontSize = parseFloat(st.fontSize);
    const required = fontSize >= 24 ? 3 : 4.5; // 24px 以上は大テキスト扱い
    if (ratio < required) {
      contrastWarnings.push({
        element: describe(el),
        inSvg: !!svgOwner,
        fontSizePx: Math.round(fontSize * 10) / 10,
        ratio: Math.round(ratio * 100) / 100,
        required,
        color: svgOwner ? st.fill : st.color, // SVG は fill が前景色(判定に使った値を出す)
        background: 'rgb(' + [bg.r, bg.g, bg.b].map((v) => Math.round(v)).join(', ') + ')',
      });
    }
    if (contrastWarnings.length >= 30) break;
  }

  /* ---- e. 重なりスイープ(warning) ----
     「はみ出していないが重なっている」を拾う軸。テキスト・画像・枠線・背景を持つ要素の
     可視矩形を集め、血縁でないペアの交差面積を測る。下敷き(全画面ラッパ)は全要素と
     交差するので除外する。fragment 全表示状態での判定なので、途中状態の重なりは対象外。 */
  const hasVisibleBorder = (cs) => {
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const w = parseFloat(cs['border' + side + 'Width']);
      const style = cs['border' + side + 'Style'];
      if (!(w > 0.4) || style === 'none' || style === 'hidden') continue;
      const c = parseColor(cs['border' + side + 'Color']);
      if (!c || c.a > 0.05) return true;
    }
    return false;
  };
  const directText = (el) => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  };
  // svg は透明キャンバスが広く場所を取るため、実際に描かれている子要素の和集合
  // (インク箱)に置き換える。viewport 矩形のままだと重なり誤検知を量産する
  const inkRect = (el) => {
    const base = clipRect(el);
    if (!base || el.tagName.toLowerCase() !== 'svg') return base;
    let t = Infinity, l = Infinity, b = -Infinity, r = -Infinity;
    for (const child of el.querySelectorAll('*')) {
      const cs = getComputedStyle(child);
      if (cs.display === 'none' || cs.visibility !== 'visible') continue;
      const cr = child.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) continue;
      t = Math.min(t, cr.top); l = Math.min(l, cr.left);
      b = Math.max(b, cr.bottom); r = Math.max(r, cr.right);
    }
    if (!(b > t && r > l)) return base;
    const top = Math.max(base.top, t), left = Math.max(base.left, l);
    const bottom = Math.min(base.bottom, b), right = Math.min(base.right, r);
    if (right - left <= 0 || bottom - top <= 0) return base;
    return { top, right, bottom, left, width: right - left, height: bottom - top };
  };
  const toCanvas = (r) => ({
    top: (r.top - canvas.top) / scale,
    left: (r.left - canvas.left) / scale,
    bottom: (r.bottom - canvas.top) / scale,
    right: (r.right - canvas.left) / scale,
  });

  /* 文字だけの要素は「行ボックス」ではなく「字面(グリフのインク)」で測る。
     行ボックスは半レディングとディセンダ余白を含むため、大きな数字の下や
     見出しの上で隣の行と数 px 重なる — 目には触れていないのに重なりと報告される
     誤検知の主因。Range で行の実寸を取り、canvas の TextMetrics で上下の余白を詰める。
     枠線・背景・画像を持つ要素は箱そのものが見えているので詰めない。 */
  const measureCtx = document.createElement('canvas').getContext('2d');
  // 戻り値は「行ごとの字面矩形の配列」。複数行にまたがる要素を 1 つの外接矩形に
  // まとめると、行末・行頭の空白領域まで占有として扱われ、隣の行の文字と重なったと
  // 誤検知する。行単位で持てば実際に文字がある領域だけを比較できる。
  const textInkRects = (el, cs, base) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rs = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rs.length) return [base];
    let insetTop = 0, insetBottom = 0;
    try {
      measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'M';
      const m = measureCtx.measureText(text);
      const fa = m.fontBoundingBoxAscent, fd = m.fontBoundingBoxDescent;
      const aa = m.actualBoundingBoxAscent, ad = m.actualBoundingBoxDescent;
      if ([fa, fd, aa, ad].every((v) => typeof v === 'number' && v >= 0)) {
        const half = Math.max(0, (rs[0].height - (fa + fd)) / 2); // 行ボックスの半レディング
        insetTop = half + Math.max(0, fa - aa);
        insetBottom = half + Math.max(0, fd - ad);
      }
    } catch { /* 測定不能なフォント指定はそのまま(詰めない)*/ }
    const out = [];
    for (const r of rs) {
      const t = Math.max(r.top + insetTop, base.top);
      const b = Math.min(r.bottom - insetBottom, base.bottom);
      const l = Math.max(r.left, base.left);
      const r2 = Math.min(r.right, base.right);
      if (r2 - l <= 0 || b - t <= 0) continue;
      out.push({ top: t, right: r2, bottom: b, left: l });
    }
    return out.length ? out : [base];
  };
  const unionRect = (parts) => {
    let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
    for (const r of parts) {
      top = Math.min(top, r.top); left = Math.min(left, r.left);
      bottom = Math.max(bottom, r.bottom); right = Math.max(right, r.right);
    }
    return { top, left, bottom, right };
  };
  const interArea = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? { area: w * h, width: w, height: h } : null;
  };

  const candidates = [];
  for (const el of section.querySelectorAll('*')) {
    if (el.closest('aside.notes')) continue;
    if (!isVisible(el)) continue;
    // エディターで挿入した部品:線は外接矩形が広く何とでも交差するので外す。図形の輪郭(SVG)は
    // 図形の文字の下敷き(塗りだけの空要素と同じ扱い)。図形の文字そのものは実体として残す
    if (el.closest('.pp-line') || el.closest('svg.pp-sh-g')) continue;
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const bgc = parseColor(cs.backgroundColor);
    const hasText = directText(el);
    const isMedia = tag === 'img' || tag === 'svg' || tag === 'video' || tag === 'canvas';
    const hasBorder = hasVisibleBorder(cs);
    const hasBgImage = !!cs.backgroundImage && cs.backgroundImage !== 'none';
    const hasBox = hasBorder || hasBgImage || (bgc && bgc.a > 0.05);
    const target = hasText || isMedia || hasBox;
    if (!target) continue;
    // 塗りだけの空要素(バーの伸び・ハイライト・メーター)は文字の下敷きとして
    // 意図的に重ねる部品。全画面ラッパと同じ理由でペア判定から外す
    // (その上の文字が読めるかはコントラスト軸が見る)。枠線・背景画像・文字が
    // あるものは実体として残すので、パネル同士の衝突は取り落とさない
    const isFillBackdrop = !hasBorder && !hasBgImage && !isMedia && !(el.textContent || '').trim();
    if (isFillBackdrop) continue;
    const raw = inkRect(el);
    if (!raw) continue;
    // 字面だけが見えている要素(枠線・背景・画像を持たない)は行ごとのグリフ範囲に詰める
    const parts = (hasText && !isMedia && !hasBox ? textInkRects(el, cs, raw) : [raw]).map(toCanvas);
    const rect = unionRect(parts);
    const w = rect.right - rect.left, h = rect.bottom - rect.top;
    if (w * h < 16) continue;                                  // 塵(罫線の端など)は無視
    if (h > 0.9 * cfgHeight || w > 0.99 * cfgWidth) continue;   // 全画面ラッパは下敷きなので除外
    candidates.push({ el, rect, parts, desc: describe(el) });
    if (candidates.length >= 300) break;                        // 走査爆発の上限
  }

  const overlapWarnings = [];
  for (let i = 0; i < candidates.length && overlapWarnings.length < 30; i++) {
    for (let j = i + 1; j < candidates.length && overlapWarnings.length < 30; j++) {
      const A = candidates[i], B = candidates[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue; // 祖先子孫は重なって当然
      if (!interArea(A.rect, B.rect)) continue;                 // 外接矩形が離れていれば行を見る必要もない
      let worst = null;
      for (const pa of A.parts) {
        for (const pb of B.parts) {
          const hit = interArea(pa, pb);
          if (hit && hit.area > (worst ? worst.area : overlapMinAreaPx2)) worst = hit;
        }
      }
      if (!worst) continue;
      overlapWarnings.push({
        a: A.desc, b: B.desc,
        areaPx2: Math.round(worst.area),
        overlap: { width: Math.round(worst.width * 10) / 10, height: Math.round(worst.height * 10) / 10 },
      });
    }
  }

  /* ---- e-2. 固定物との clearance: フッター帯(下端 footerBandPx)と .src 出典行 ----
     交差は WARN、gap ≤ bandProximityPx は近接注意(WARN のまま昇格しない)。
     .src 自身は仕様上この帯の上に居るので判定対象から外す。 */
  const bandOverlaps = [];
  const bandProximity = [];
  let srcTop = null;
  for (const e of section.querySelectorAll('.src')) {
    if (!isVisible(e)) continue;
    const r = clipRect(e);
    if (!r) continue;
    const t = toCanvas(r).top;
    srcTop = srcTop === null ? t : Math.min(srcTop, t);
  }
  const footerTop = cfgHeight - footerBandPx;
  const candByEl = new Map(candidates.map((c) => [c.el, c]));
  for (const cand of candidates) {
    if (cand.el.closest('.src') || cand.el.querySelector('.src')) continue;
    // 親も同じ下端で候補なら親だけ報告する(入れ子チェーンの重複報告を抑える)
    const parent = candByEl.get(cand.el.parentElement);
    if (parent && Math.abs(parent.rect.bottom - cand.rect.bottom) < 1) continue;
    const zones = [{ zone: 'footer', label: `フッター帯(y≧${Math.round(footerTop)})`, top: footerTop }];
    if (srcTop !== null) zones.push({ zone: 'src', label: `.src 出典行(y≧${Math.round(srcTop)})`, top: srcTop });
    for (const z of zones) {
      const into = cand.rect.bottom - z.top;
      if (into > 0) {
        if (into * (cand.rect.right - cand.rect.left) <= overlapMinAreaPx2) continue;
        if (bandOverlaps.length < 30) {
          bandOverlaps.push({ zone: z.zone, label: z.label, element: cand.desc, intoPx: Math.round(into * 10) / 10 });
        }
      } else if (-into <= bandProximityPx) {
        if (bandProximity.length < 30) {
          bandProximity.push({ zone: z.zone, label: z.label, element: cand.desc, gapPx: Math.round(-into * 10) / 10 });
        }
      }
    }
  }

  /* ---- g. 実効フォント px の床(--font-floor 指定時のみ) ----
     属性値ではなく「実際に描かれる px」で測る。SVG の text は font-size 属性が
     viewBox 単位なので、実描画幅 / viewBox 幅の比を掛けないと本当の大きさが出ない
     (font-size="13" が実効 11px で刷られていた事故が実測にある)。 */
  const fontFloorViolations = [];
  let minEffectiveFontPx = null;
  if (fontFloor > 0) {
    for (const el of section.querySelectorAll('*')) {
      if (el.closest('aside.notes')) continue;
      if (!directText(el) || !isVisible(el)) continue;
      if (fontExcludeSel && el.closest(fontExcludeSel)) continue;
      const cs = getComputedStyle(el);
      const declared = parseFloat(cs.fontSize);
      if (!(declared > 0)) continue;
      let effective = declared; // HTML 要素は computed px がそのままキャンバス px
      const svg = el.ownerSVGElement;
      if (svg) {
        const vb = svg.viewBox && svg.viewBox.baseVal;
        const sr = svg.getBoundingClientRect();
        if (vb && vb.width > 0 && sr.width > 0) effective = declared * ((sr.width / scale) / vb.width);
      }
      effective = Math.round(effective * 10) / 10;
      if (minEffectiveFontPx === null || effective < minEffectiveFontPx) minEffectiveFontPx = effective;
      if (effective < fontFloor && fontFloorViolations.length < 30) {
        fontFloorViolations.push({
          element: describe(el),
          effectivePx: effective,
          declaredPx: Math.round(declared * 10) / 10,
          inSvg: !!svg,
        });
      }
    }
  }

  /* ---- f. 見出しの静的アサート(句読点・折返し。既定 WARN) ----
     句読点: 見出しは体言止め(ワーディング規範)。
     折返し: h2 が 2 行になるのは字数過多か幅不足のサイン。文字数ではなく
     Range の client rects を行(top)でクラスタリングして「実描画行数」を測る。 */
  const titleWarnings = [];
  for (const h of section.querySelectorAll('h2')) {
    if (!isVisible(h)) continue;
    const text = (h.textContent || '').trim().replace(/\s+/g, ' ');
    if (/[。、]/.test(text)) {
      titleWarnings.push({ kind: 'punctuation', element: describe(h), text: text.slice(0, 60) });
    }
    const range = document.createRange();
    range.selectNodeContents(h);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    const hst = getComputedStyle(h);
    const lh = parseFloat(hst.lineHeight) || parseFloat(hst.fontSize) * 1.4;
    const threshold = Math.max(4, lh * 0.5); // 同一行内のベースラインずれを吸収
    const lineTops = [];
    for (const r of rects.sort((a, b) => a.top - b.top)) {
      if (!lineTops.length || Math.abs(r.top - lineTops[lineTops.length - 1]) > threshold) lineTops.push(r.top);
    }
    // 明示的な <br> の数だけは意図した行分けとして許す。それを超えて行が増えていれば
    // 「語の途中で勝手に折れた」自動折返し = 規範が狙う事故。<br> ぶんだけの複数行は
    // 意図的な 2 行タイトルなので注記に留める(--strict でも昇格させない)
    const brCount = h.querySelectorAll('br').length;
    const intendedLines = brCount + 1;
    if (lineTops.length > 1) {
      const autoWrapped = lineTops.length > intendedLines;
      titleWarnings.push({
        kind: 'wrap',
        element: describe(h),
        lines: lineTops.length,
        brCount,
        autoWrapped, // true のみ --strict でゲートになる
      });
    }
  }

  /* ---- スライドのラベル(レポート用) ---- */
  const heading = section.querySelector('h1, h2, h3');
  const label = (heading ? heading.textContent.trim().replace(/\s+/g, ' ')
    : (section.getAttribute('class') || section.id || '(無題)')).slice(0, 60);

  return {
    overflows, overflowWarnings, footerZoneWarnings, contrastWarnings, titleWarnings,
    overlapWarnings, bandOverlaps, bandProximity, candidateCount: candidates.length,
    fontFloorViolations, minEffectiveFontPx, contrastIndeterminate, label,
    canvas: { width: cfgWidth, height: cfgHeight },
  };
}

/* ---------------------------------------------------------------------------
   メイン
--------------------------------------------------------------------------- */
const deckErrors = { consoleErrors: [], pageErrors: [], requestFailures: [], badResponses: [] };

const server = await serveForDeck(deckDir, baselineDir ? [baselineDir] : []);
const browser = await chromium.launch();
let exitCode = 0;

try {
  const verifyDir = await ensureOutDir(deckDir, 'verify');
  const purgedCount = await purgeSlidePngs(verifyDir); // 撮影前に残骸を消す(古い面を評価しない)

  const { page } = await openDeck(browser, server.origin, deckDir, {
    root: server.root,
    onConsole: (msg) => { if (msg.type() === 'error') deckErrors.consoleErrors.push(msg.text()); },
    onPageError: (err) => deckErrors.pageErrors.push(err.message),
    onRequestFailed: (req) => deckErrors.requestFailures.push(`${req.url()} (${req.failure()?.errorText || 'unknown'})`),
    onBadResponse: (res) => deckErrors.badResponses.push(`HTTP ${res.status()}: ${res.url()}`),
  });

  await page.addStyleTag({ content: SHOT_STYLE }); // baseline 撮影と同一条件

  // スライド列挙(縦スタックも含めフラットに)
  const slideIndices = await page.evaluate(() =>
    window.Reveal.getSlides().map((s) => {
      const { h, v } = window.Reveal.getIndices(s);
      return { h, v };
    })
  );
  if (!slideIndices.length) throw new Error('スライドが 1 枚も見つかりません');

  const slides = [];
  for (let i = 0; i < slideIndices.length; i++) {
    const { h, v } = slideIndices[i];
    // fragment 全表示でスライドへ移動(f=99 は最終 fragment に丸められる)
    await page.evaluate(([hh, vv]) => window.Reveal.slide(hh, vv, 99), [h, v]);
    await page.waitForTimeout(SETTLE_MS);

    const check = await page.evaluate(inPageCheckSlide, {
      tolerance: OVERFLOW_TOLERANCE_PX,
      footerZonePx: FOOTER_ZONE_PX,
      overlapMinAreaPx2: OVERLAP_MIN_AREA_PX2,
      bandProximityPx: BAND_PROXIMITY_PX,
      fontFloor: flags.fontFloor || 0,
      fontExcludeSel,
    });

    const shotName = `slide-${String(i + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: path.join(verifyDir, shotName), animations: 'disabled' });

    slides.push({
      index: i + 1,
      h, v,
      label: check.label,
      canvas: check.canvas,
      screenshot: path.join('out', 'verify', shotName),
      pass: check.overflows.length === 0,
      overflows: check.overflows,
      overflowWarnings: check.overflowWarnings,
      footerZoneWarnings: check.footerZoneWarnings,
      contrastWarnings: check.contrastWarnings,
      titleWarnings: check.titleWarnings,
      overlapWarnings: check.overlapWarnings,
      bandOverlaps: check.bandOverlaps,
      bandProximity: check.bandProximity,
      fontFloorViolations: check.fontFloorViolations,
      minEffectiveFontPx: check.minEffectiveFontPx,
      contrastIndeterminate: check.contrastIndeterminate,
      overlapCandidateCount: check.candidateCount, // 重なりスイープの走査対象数(閾値調整の手がかり)
    });
  }

  /* ---- h. baseline md5 照合(--baseline 指定時のみ) ----
     「静止面を変えないはずの変更」を画素で証明する軸。差分の有無は判定に混ぜず
     結果表示だけにする(意図した変更で FAIL にしても意味がないため)。 */
  let baseline = null;
  if (!baselineDir) {
    // 前回の --baseline 実行で残った比較用スクショを消す。残骸を「今回の証拠」と
    // 読み違える事故を防ぐ(残骸 purge と同じ理由)
    await fs.rm(path.join(verifyDir, 'baseline'), { recursive: true, force: true }).catch(() => {});
  }
  if (baselineDir) {
    const curOut = await ensureOutDir(deckDir, 'verify', 'baseline', 'current');
    const befOut = await ensureOutDir(deckDir, 'verify', 'baseline', 'before');
    await purgeSlidePngs(curOut);
    await purgeSlidePngs(befOut);
    // 両デッキを同一実行・同一条件で撮る(本編の検査を挟まないので経路も揃う)
    const cur = await shootDeck(browser, server, deckDir, { outDir: curOut });
    const bef = await shootDeck(browser, server, baselineDir, { outDir: befOut });

    const compared = Math.min(cur.slideCount, bef.slideCount);
    const rawDiffs = [];
    for (let n = 1; n <= compared; n++) {
      if (cur.shots.get(n) !== bef.shots.get(n)) rawDiffs.push(n);
    }

    /* 差分が出た面だけ、同じデッキをもう一度撮って自己再現性を確かめる。
       同一デッキで 2 回の md5 が違う面は SMIL や動画など止まらない動きを含んでいて
       画素照合が成立しない → 「比較不能(unstable)」として偽差分と区別する。 */
    let diffSlides = rawDiffs;
    let unstableSlides = [];
    if (rawDiffs.length) {
      const curRe = await shootDeck(browser, server, deckDir, { only: rawDiffs });
      const befRe = await shootDeck(browser, server, baselineDir, { only: rawDiffs });
      diffSlides = [];
      for (const n of rawDiffs) {
        const curStable = curRe.shots.get(n) === cur.shots.get(n);
        const befStable = befRe.shots.get(n) === bef.shots.get(n);
        if (curStable && befStable) diffSlides.push(n);
        else unstableSlides.push(n);
      }
    }

    baseline = {
      dir: path.relative(REPO_ROOT, baselineDir),
      slideCount: { current: cur.slideCount, baseline: bef.slideCount },
      countMismatch: cur.slideCount !== bef.slideCount,
      comparedCount: compared,
      diffSlides,
      unstableSlides, // 画素照合が成立しない面(FAIL 扱いにしない)
      identical: diffSlides.length === 0 && unstableSlides.length === 0 && cur.slideCount === bef.slideCount,
      shots: { current: path.join('out', 'verify', 'baseline', 'current'), before: path.join('out', 'verify', 'baseline', 'before') },
    };
  }

  // c. フォント読込状態
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const failed = [];
    document.fonts.forEach((f) => {
      if (f.status === 'error') failed.push({ family: f.family, style: f.style, weight: f.weight });
    });
    return { status: document.fonts.status, failed };
  });

  /* ---- 集計 ---- */
  const overflowCount = slides.reduce((n, s) => n + s.overflows.length, 0);
  const overflowWarningCount = slides.reduce((n, s) => n + s.overflowWarnings.length, 0);
  const footerZoneWarningCount = slides.reduce((n, s) => n + s.footerZoneWarnings.length, 0);
  const contrastWarningCount = slides.reduce((n, s) => n + s.contrastWarnings.length, 0);
  const overlapWarningCount = slides.reduce((n, s) => n + s.overlapWarnings.length, 0);
  const bandOverlapCount = slides.reduce((n, s) => n + s.bandOverlaps.length, 0);
  const bandProximityCount = slides.reduce((n, s) => n + s.bandProximity.length, 0);
  const errorCount =
    deckErrors.consoleErrors.length + deckErrors.pageErrors.length +
    deckErrors.requestFailures.length + deckErrors.badResponses.length;

  // 撮影枚数の照合: レポートの枚数と実在 PNG が一致しなければレポート自体が信用できない
  const pngCount = await countSlidePngs(verifyDir);
  const pngCountMismatch = pngCount !== slides.length;

  // f. 静的アサート: ソース HTML 由来(デッキ単位)+ 見出し由来(スライド単位)
  const sourceAsserts = await staticSourceAsserts(deckDir);
  const titleWarningCount = slides.reduce((n, s) => n + s.titleWarnings.length, 0);
  const staticWarningCount = sourceAsserts.length + titleWarningCount;
  // --strict のゲート対象は「句読点」と「自動折返し」だけ。明示的 <br> による
  // 意図的な複数行は注記(advisory)として数えるが昇格させない
  const isTitleAdvisory = (w) => w.kind === 'wrap' && !w.autoWrapped;
  const titleAdvisoryCount = slides.reduce((n, s) => n + s.titleWarnings.filter(isTitleAdvisory).length, 0);
  const staticGateCount = sourceAsserts.length + (titleWarningCount - titleAdvisoryCount);

  // 鮮度: 実行中にソースが更新されていればレポートは既に古い(FAIL にはしない)
  const sourceMaxMtimeMs = await deckSourceMaxMtime(deckDir);
  const staleSource = sourceMaxMtimeMs > runStartedAtMs;

  const fontFloorViolationCount = slides.reduce((n, s) => n + s.fontFloorViolations.length, 0);
  const contrastIndeterminateCount = slides.reduce((n, s) => n + s.contrastIndeterminate, 0);

  /* ---- 判定 ----
     常時 FAIL: overflow / ページエラー / スクショ枚数不一致
     --font-floor 指定時: 床割れも FAIL(指定した時点で床は要件)
     --strict 指定時: 重なり・固定物交差・静的アサートの WARN も FAIL に昇格
     (固定物への gap 近接注意は設計判断の余地があるため昇格しない) */
  const hardFail = overflowCount > 0 || errorCount > 0 || pngCountMismatch;
  const fontFail = flags.fontFloor ? fontFloorViolationCount > 0 : false;
  const strictFail = flags.strict
    ? overlapWarningCount > 0 || bandOverlapCount > 0 || staticGateCount > 0
    : false;
  const ok = !hardFail && !fontFail && !strictFail;
  exitCode = ok ? 0 : 1;

  /* ---- report.json ---- */
  const report = {
    deck: deckRel,
    generatedAt: new Date().toISOString(),
    startedAt: new Date(runStartedAtMs).toISOString(),
    // デッキソース(out/ 除外)の最新 mtime。startedAt より新しければレポートは古い
    deckSourceMaxMtime: sourceMaxMtimeMs ? new Date(sourceMaxMtimeMs).toISOString() : null,
    staleSource,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    canvas: slides[0].canvas, // デッキの実キャンバス(Reveal config。既定 1280×720)
    tolerancePx: OVERFLOW_TOLERANCE_PX,
    footerZonePx: FOOTER_ZONE_PX,
    // 実際に使ったフッター帯(テーマは % 配置なのでキャンバス高さで比例させている)
    footerZonePxEffective: Math.round(FOOTER_ZONE_PX * (slides[0].canvas.height / 720)),
    overlapMinAreaPx2: OVERLAP_MIN_AREA_PX2,
    bandProximityPx: BAND_PROXIMITY_PX,
    // 実行モード(どの軸がゲートだったか。レポートを後から読むとき必須の情報)
    mode: {
      strict: flags.strict,
      fontFloorPx: flags.fontFloor || null,
      fontExclude: flags.fontFloor ? fontExcludeSel : null,
      baseline: flags.baseline || null,
    },
    failedBy: { hardFail, fontFail, strictFail },
    note: 'fragment は全表示(最終)状態のみ検査。current-visible / fade-out の途中状態と、JS が slidechanged 以外で動的に変えるものは対象外。'
      + ' 重なりスイープは血縁でないペアの矩形交差を見る発見的な軸で、意図した重ね(バッジ・図の上のラベル)も挙がる — 目視で採否を決める。'
      + ' コントラストの「判定不能」は背景画像上・図形塗り不明のテキストで、目視確認が必須。',
    ok,
    // 撮影の完全性: 撮影前に消した残骸数と、実行後に実在する slide-NN.png の枚数
    screenshots: {
      purgedBefore: purgedCount,
      pngCount,
      expected: slides.length,
      mismatch: pngCountMismatch,
    },
    summary: {
      slideCount: slides.length,
      overflowCount,
      overflowWarningCount,
      footerZoneWarningCount,
      errorCount,
      contrastWarningCount,
      fontFailedCount: fonts.failed.length,
      staticWarningCount,
      staticGateCount,      // --strict で FAIL になる静的アサート数(注記を除く)
      titleAdvisoryCount,   // 明示的 <br> による複数行見出し(昇格しない注記)
      overlapWarningCount,
      bandOverlapCount,
      bandProximityCount,
      fontFloorViolationCount,
      contrastIndeterminateCount,
    },
    staticAsserts: { source: sourceAsserts, titleWarningCount },
    baseline,
    slides,
    deckErrors,
    fonts,
  };
  await fs.writeFile(path.join(verifyDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  /* ---- report.md ---- */
  const md = [];
  md.push(`# 検証レポート: ${deckRel}`);
  md.push('');
  md.push(`- 実行日時: ${report.generatedAt}`);
  md.push(`- 結果: **${ok ? 'PASS' : 'FAIL'}**`);
  md.push(`- スライド ${slides.length} 枚 / overflow ${overflowCount} 件 / エラー ${errorCount} 件 / 警告(transform ${overflowWarningCount}・フッターゾーン ${footerZoneWarningCount}・コントラスト ${contrastWarningCount}・静的アサート ${staticWarningCount}(うち --strict ゲート ${staticGateCount}・注記 ${titleAdvisoryCount}))`);
  md.push(`- 重なりスイープ: 交差 ${overlapWarningCount} 件 / 固定物(フッター帯・.src)交差 ${bandOverlapCount} 件 / 近接注意 ${bandProximityCount} 件`);
  md.push(`- モード: ${flags.strict ? '--strict(重なり・固定物交差・静的アサートをゲートに昇格)' : '既定(新軸は WARN)'}` +
    `${flags.fontFloor ? ` / --font-floor=${flags.fontFloor}px(床割れ ${fontFloorViolationCount} 件・除外 "${fontExcludeSel}")` : ' / フォント床は未検査'}`);
  md.push(`- フォント: status=${fonts.status}, 失敗 ${fonts.failed.length} 件`);
  md.push(`- スクショ: 実在 ${pngCount} 枚 / 期待 ${slides.length} 枚${pngCountMismatch ? ' — **不一致(FAIL)**' : ''}(撮影前に残骸 ${purgedCount} 枚を削除)`);
  md.push(`- ソース最新 mtime: ${report.deckSourceMaxMtime || '(不明)'}${staleSource ? ' — **実行中にデッキが更新された。このレポートは古い**' : ''}`);
  md.push(`- コントラスト: 警告 ${contrastWarningCount} 件 / **判定不能 ${contrastIndeterminateCount} 件(目視必須)** — 背景画像上・半透明背景・図形塗り不明のテキスト`);
  md.push('- 注: fragment は全表示(最終)状態のみ検査。背景画像上のテキストはコントラスト判定不能として skip される(スクショの目視確認が必須)。');
  md.push('');
  md.push('## スライド別');
  md.push('');
  // 「判定」列は overflow 由来のみ(従来の pass 定義)。デッキ全体の合否は冒頭の結果行を見る
  md.push('| # | スライド | overflow判定 | overflow | 重なり | 固定物 | コントラスト警告 | 最小実効px |');
  md.push('|--:|---|---|--:|--:|--:|--:|--:|');
  for (const s of slides) {
    md.push(`| ${s.index} | ${s.label.replace(/\|/g, '\\|')} | ${s.pass ? 'PASS' : 'FAIL'} | ${s.overflows.length} | ` +
      `${s.overlapWarnings.length} | ${s.bandOverlaps.length} | ${s.contrastWarnings.length} | ${s.minEffectiveFontPx ?? '—'} |`);
  }
  const detailLines = [];
  for (const s of slides) {
    for (const o of s.overflows) {
      const dirs = Object.entries(o.overflow).map(([d, px]) => `${d} ${px}px`).join(', ');
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} overflow(${dirs}): ${o.element}`);
    }
    for (const o of s.overflowWarnings) {
      const dirs = Object.entries(o.overflow).map(([d, px]) => `${d} ${px}px`).join(', ');
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} overflow疑い/${o.note}(${dirs}): ${o.element}`);
    }
    for (const w of s.footerZoneWarnings) {
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} フッターゾーン侵犯警告(テキスト下端 y=${w.bottomPx} > ${w.zoneStartPx}): ${w.element}`);
    }
    for (const w of s.contrastWarnings) {
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} コントラスト警告(${w.ratio} < ${w.required}, ${w.fontSizePx}px, ${w.color} on ${w.background}): ${w.element}`);
    }
    for (const w of s.overlapWarnings) {
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} 重なり警告(交差 ${w.areaPx2}px² = ${w.overlap.width}×${w.overlap.height}px): ${w.a} ⇔ ${w.b}`);
    }
    for (const w of s.bandOverlaps) {
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} 固定物と交差(${w.label} に ${w.intoPx}px 侵入): ${w.element}`);
    }
    for (const w of s.bandProximity) {
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} 近接注意(${w.label} まで gap ${w.gapPx}px): ${w.element}`);
    }
    for (const w of s.fontFloorViolations) {
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} フォント床割れ(実効 ${w.effectivePx}px < ${flags.fontFloor}px${w.inSvg ? `, SVG 内・指定 ${w.declaredPx}px` : ''}): ${w.element}`);
    }
    for (const w of s.titleWarnings) {
      const msg = w.kind === 'punctuation'
        ? `見出しに句読点(体言止めにする)「${w.text}」`
        : (w.autoWrapped
          ? `見出しが自動折返しで ${w.lines} 行(明示的 <br> ${w.brCount} 個 — 字数か幅を見直す)`
          : `見出しが ${w.lines} 行 — 明示的 <br> あり(意図確認。--strict でも FAIL にしない)`);
      const tag = isTitleAdvisory(w) ? '静的アサート注記' : '静的アサート警告';
      detailLines.push(`- slide ${String(s.index).padStart(2, '0')} ${tag}/${msg}: ${w.element}`);
    }
  }
  for (const a of sourceAsserts) {
    detailLines.push(`- デッキ全体 静的アサート警告/${a.kind}: ${a.detail}`);
  }
  if (detailLines.length) {
    md.push('');
    md.push('## 指摘詳細');
    md.push('');
    md.push(...detailLines);
  }
  if (errorCount) {
    md.push('');
    md.push('## デッキ全体のエラー');
    md.push('');
    for (const e of deckErrors.consoleErrors) md.push(`- console error: ${e}`);
    for (const e of deckErrors.pageErrors) md.push(`- pageerror: ${e}`);
    for (const e of deckErrors.requestFailures) md.push(`- request failed: ${e}`);
    for (const e of deckErrors.badResponses) md.push(`- ${e}`);
  }
  if (baseline) {
    md.push('');
    md.push('## baseline md5 照合');
    md.push('');
    md.push(`- 変更前デッキ: ${baseline.dir}`);
    md.push(`- 枚数: 現行 ${baseline.slideCount.current} 枚 / baseline ${baseline.slideCount.baseline} 枚${baseline.countMismatch ? ' — **枚数不一致**' : ''}`);
    md.push(baseline.identical
      ? `- 結果: **全 ${baseline.comparedCount} 枚が md5 一致(画素不変を証明)**`
      : `- 結果: 差分あり — 面 ${baseline.diffSlides.join(', ') || '(なし)'}${baseline.countMismatch ? ' + 枚数不一致' : ''}`);
    if (baseline.unstableSlides.length) {
      md.push(`- 比較不能(unstable): 面 ${baseline.unstableSlides.join(', ')} — 同一デッキの再撮影でも md5 が変わる面(SMIL・動画など止まらない動きを含む)。画素照合が成立しないので差分として扱わない。anim-qa / ffmpeg フレーム抽出で確認する`);
    }
    md.push(`- スクショ: 現行 \`${baseline.shots.current}/\` / 変更前 \`${baseline.shots.before}/\`(同一実行・同一条件で撮影。差分面は並べて目視する)`);
    md.push('- 注: この軸は結果表示のみで exit code に影響しない(意図した変更で FAIL にしないため)。');
  }
  if (fonts.failed.length) {
    md.push('');
    md.push('## フォント読込失敗');
    md.push('');
    for (const f of fonts.failed) md.push(`- ${f.family} (${f.style} ${f.weight})`);
  }
  md.push('');
  await fs.writeFile(path.join(verifyDir, 'report.md'), md.join('\n'));

  /* ---- コンソールサマリ ---- */
  console.log(`検証: ${deckRel}(${slides.length} スライド)`);
  for (const s of slides) {
    const flags = [];
    if (s.overflows.length) flags.push(`overflow ${s.overflows.length}件`);
    if (s.overflowWarnings.length) flags.push(`overflow疑い ${s.overflowWarnings.length}件`);
    if (s.footerZoneWarnings.length) flags.push(`フッターゾーン警告 ${s.footerZoneWarnings.length}件`);
    if (s.contrastWarnings.length) flags.push(`コントラスト警告 ${s.contrastWarnings.length}件`);
    if (s.overlapWarnings.length) flags.push(`重なり警告 ${s.overlapWarnings.length}件`);
    if (s.bandOverlaps.length) flags.push(`固定物交差 ${s.bandOverlaps.length}件`);
    if (s.bandProximity.length) flags.push(`近接注意 ${s.bandProximity.length}件`);
    if (s.titleWarnings.length) flags.push(`静的アサート警告 ${s.titleWarnings.length}件`);
    console.log(`  slide ${String(s.index).padStart(2, '0')} [${s.pass ? 'PASS' : 'FAIL'}] ${s.label}${flags.length ? ' — ' + flags.join(' / ') : ''}`);
  }
  for (const line of detailLines) console.log('  ' + line.replace(/^- /, ''));
  if (contrastIndeterminateCount) {
    console.log(`  コントラスト判定不能 ${contrastIndeterminateCount} 件(目視必須)— 背景画像上・半透明背景・図形塗り不明のテキスト`);
  }
  if (errorCount) {
    console.log(`  デッキ全体のエラー ${errorCount} 件:`);
    for (const e of deckErrors.consoleErrors) console.log(`    - console error: ${e}`);
    for (const e of deckErrors.pageErrors) console.log(`    - pageerror: ${e}`);
    for (const e of deckErrors.requestFailures) console.log(`    - request failed: ${e}`);
    for (const e of deckErrors.badResponses) console.log(`    - ${e}`);
  }
  if (fonts.failed.length) {
    console.log(`  フォント読込失敗 ${fonts.failed.length} 件: ${fonts.failed.map((f) => f.family).join(', ')}`);
  }
  if (pngCountMismatch) {
    console.log(`  FAIL: スクショ枚数が不一致(実在 ${pngCount} 枚 / 期待 ${slides.length} 枚)— out/verify を確認`);
  }
  if (staleSource) {
    console.log(`  warn: 実行中にデッキソースが更新されました(${report.deckSourceMaxMtime} > 開始 ${report.startedAt})`);
    console.log('        このレポートとスクショは最新のデッキを反映していません。再実行してください');
  }
  if (baseline) {
    console.log(`  baseline 照合(${baseline.dir}): 現行 ${baseline.slideCount.current} 枚 / baseline ${baseline.slideCount.baseline} 枚`);
    if (baseline.identical) {
      console.log(`    全 ${baseline.comparedCount} 枚 md5 一致 — 画素不変`);
    } else {
      if (baseline.countMismatch) console.log('    枚数が不一致(面の増減がある)');
      if (baseline.diffSlides.length) console.log(`    md5 差分のある面: ${baseline.diffSlides.join(', ')}`);
      if (baseline.unstableSlides.length) {
        console.log(`    比較不能(unstable)な面: ${baseline.unstableSlides.join(', ')} — 同一デッキの再撮影でも md5 が変わる(止まらない動きを含む)。差分ではないので anim-qa / ffmpeg で確認`);
      }
      console.log(`    スクショ: ${path.join(deckRel, baseline.shots.current)}/ と ${path.join(deckRel, baseline.shots.before)}/`);
    }
  }
  if (!ok) {
    const why = [];
    if (overflowCount) why.push(`overflow ${overflowCount}件`);
    if (errorCount) why.push(`ページエラー ${errorCount}件`);
    if (pngCountMismatch) why.push('スクショ枚数不一致');
    if (fontFail) why.push(`フォント床割れ ${fontFloorViolationCount}件(--font-floor=${flags.fontFloor})`);
    if (strictFail) why.push(`--strict 昇格(重なり ${overlapWarningCount}・固定物交差 ${bandOverlapCount}・静的アサート ${staticGateCount})`);
    console.log(`  FAIL 理由: ${why.join(' / ')}`);
  }
  console.log(`結果: ${ok ? 'PASS' : 'FAIL'} — レポート: ${path.join(deckRel, 'out', 'verify')}/report.{json,md}`);
} catch (err) {
  console.error(`error: 検証に失敗しました: ${err.message}`);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

process.exit(exitCode);
