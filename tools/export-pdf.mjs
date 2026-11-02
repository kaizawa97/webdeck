/* ============================================================================
   tools/export-pdf.mjs — デッキを PDF に出力する
   使い方: node tools/export-pdf.mjs <deckDir>
   出力:   <deckDir>/out/<デッキ名>.pdf と <deckDir>/out/pdf-report.json

   方針:
   - print view(?view=print&pdfSeparateFragments=false)で開き、page.pdf() を
     1回だけ呼ぶ(スライド毎の分割印刷はしない — リンク・フォント埋め込み品質のため)
   - fragment は1ページに畳まれる(pdfSeparateFragments=false)
   - DOM の .pdf-page 数と PDF の実ページ数の一致を pdf-lib で検証する
   ============================================================================ */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { REPO_ROOT, serveRepo, resolveDeckDir, deckUrlPath, ensureOutDir, openDeck, serveForDeck } from './lib.mjs';

const deckDir = resolveDeckDir(process.argv[2]);
const deckName = path.basename(deckDir);

const warnings = []; // 助言レベル(exit code に影響しない)
const problems = []; // 実害レベル(資産404・スクリプトエラー等 → exit 1)

const server = await serveForDeck(deckDir);
const browser = await chromium.launch();
let exitCode = 0;

try {
  // print view で開く(URL に既に ? がある場合は & で連結する)
  const sep = deckUrlPath(deckDir).includes('?') ? '&' : '?';
  const { page } = await openDeck(browser, server.origin, deckDir, {
    root: server.root,
    query: sep + 'view=print&pdfSeparateFragments=false',
    onConsole: (msg) => {
      if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`);
    },
    onPageError: (err) => problems.push(`page error: ${err.message}`),
    onRequestFailed: (req) => problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`),
    onBadResponse: (res) => problems.push(`HTTP ${res.status()}: ${res.url()}`),
  });

  // print view では Reveal.isReady 前提が崩れるため、.pdf-page の出現を直接待つ。
  // .pdf-page だけでは不十分: PrintView はスライドを .pdf-page に包んだ「後」に
  // html へ reveal-print クラスを付けるため、その隙間に後段の背景色読み取りが
  // 走ると非 print 用のレターボックス色(--pp-letterbox)を拾い、全ページが
  // ダーク背景の PDF になる(非決定・実際に踏んだ)。クラス付与まで待つ。
  await page.waitForFunction(() =>
    document.querySelectorAll('.pdf-page').length > 0 &&
    document.documentElement.classList.contains('reveal-print'),
  null, { timeout: 30000 });

  // フォント読込 + 全 img の decode 完了 + 500ms settle
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})))
  );
  await page.waitForTimeout(500);

  // margin≠0 のデッキでは Reveal の @page サイズと Chromium の実ページに
  // サブピクセルのずれが出て、右端・下端に未描画の白ヘアラインが入ることがある。
  // html の背景をビューポート背景色で塗ってスリバーを目立たなくする。
  const deckInfo = await page.evaluate(() => {
    const vp = document.querySelector('.reveal-viewport') || document.body;
    const cs = getComputedStyle(vp);
    // 背景色はテーマトークン --pp-bg(:root 定義)を第一候補にする —
    // 計算済み背景色と違い、reveal-print クラスの付与タイミングに依存しない。
    // トークンを持たないデッキでは従来どおり計算済み背景色にフォールバック。
    const bg = (cs.getPropertyValue('--pp-bg') || '').trim() || cs.backgroundColor;
    const letterbox = (cs.getPropertyValue('--pp-letterbox') || '').trim() || '#12161b';
    return {
      bg,
      letterbox,
      margin: (window.Reveal && window.Reveal.getConfig) ? window.Reveal.getConfig().margin : null,
    };
  });
  // PrintView はスライドを .pdf-page に包む「時点」のビューポート背景色を
  // .pdf-page にインラインで焼き付ける。その時点では reveal-print が未付与のため
  // レターボックス色(--pp-letterbox)が全ページに焼き付き、light デッキでも
  // PDF 全面がダーク背景になる。上の waitForFunction はクラス付与を待つだけで
  // 焼き付き済みの色は戻せないので、page.pdf() の直前にツール側で塗り直すのが恒久対策。
  await page.addStyleTag({ content:
    `html { background: ${deckInfo.bg} !important; }\n` +
    `html.reveal-print .pdf-page { background: ${deckInfo.bg} !important; }` });
  if (deckInfo.margin && deckInfo.margin > 0) {
    warnings.push(`config.margin=${deckInfo.margin}(0 以外)のため PDF ページが厳密な 16:9 になりません(標準 config の margin:0 を推奨)`);
  }

  const domPages = await page.evaluate(() => document.querySelectorAll('.pdf-page').length);

  const outDir = await ensureOutDir(deckDir);
  const pdfPath = path.join(outDir, `${deckName}.pdf`);
  await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });

  // 検証: PDF の実ページ数が DOM の .pdf-page 数と一致すること
  const pdfBytes = await fs.readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const pdfPages = pdfDoc.getPageCount();
  const fileSize = pdfBytes.length;

  if (pdfPages !== domPages) {
    problems.push(`ページ数不一致: DOM .pdf-page=${domPages} / PDF=${pdfPages}`);
  }

  // 検証: PDF を実際にラスタライズして地の色を見る(スクショは screen メディアなので
  // print 専用スタイルの不良 — 全ページがレターボックス色に焼かれる等 — を写せない)。
  // 判定は「サンプルした全ページの角がレターボックス色」のときだけ FAIL(意図的な
  // ダーク面が混ざるデッキを誤検知しないため)。pdftoppm が無い環境はスキップ+警告。
  const bgCheck = await checkPdfBackground(pdfPath, pdfPages, deckInfo);
  if (bgCheck.problem) problems.push(bgCheck.problem);
  if (bgCheck.warning) warnings.push(bgCheck.warning);

  if (problems.length) exitCode = 1;

  const report = {
    deck: path.relative(REPO_ROOT, deckDir),
    pdf: pdfPath,
    domPages,
    pdfPages,
    fileSizeBytes: fileSize,
    backgroundCheck: bgCheck.summary,
    ok: exitCode === 0,
    problems,
    warnings,
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(outDir, 'pdf-report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(`PDF 出力: ${pdfPath}`);
  console.log(`ページ数: ${pdfPages}(DOM .pdf-page: ${domPages})`);
  console.log(`サイズ: ${(fileSize / 1024).toFixed(1)} KB`);
  if (warnings.length) {
    console.log(`警告 ${warnings.length} 件:`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (problems.length) {
    console.error(`error: 問題 ${problems.length} 件(PDF は生成されましたが配布前に解消してください):`);
    for (const p of problems) console.error(`  - ${p}`);
  }
} catch (err) {
  console.error(`error: PDF 出力に失敗しました: ${err.message}`);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

process.exit(exitCode);

/* ---- PDF 地色のラスタ検査 --------------------------------------------------
   pdftoppm(poppler)で分散した5ページを低解像度ラスタ化し、角の画素を
   レターボックス色と比較する。「サンプルの過半数がレターボックス色」で実害と
   判定する(全一致を条件にすると、全面アートの表紙が角を覆うデッキで
   本物の焼き付き不良を取りこぼす — 旧不良PDFで実証済み。逆に単発の一致は
   意図的なダーク面の可能性があるため FAIL にしない)。 */
async function checkPdfBackground(pdfPath, pageCount, deckInfo) {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const parse = (c) => {
    if (!c) return null;
    c = c.trim();
    let m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = c.match(/^#([0-9a-f]{3})$/i);
    if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
    m = c.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  };
  const bg = parse(deckInfo.bg);
  const lb = parse(deckInfo.letterbox);
  if (!bg || !lb) return { warning: `PDF地色検査をスキップ(色を解釈できない: bg=${deckInfo.bg} letterbox=${deckInfo.letterbox})。ラスタライズしての目視を推奨`, summary: { skipped: 'unparsable-color' } };
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  if (dist(bg, lb) < 30) return { summary: { skipped: 'bg≈letterbox(判別不能のため対象外)' } };
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); }
  catch { return { warning: 'pdftoppm が無いため PDF 地色のラスタ検査をスキップ(PDF をラスタライズしての目視を推奨)', summary: { skipped: 'no-pdftoppm' } }; }
  const pages = [...new Set([1, Math.ceil(pageCount * 0.25), Math.ceil(pageCount / 2), Math.ceil(pageCount * 0.75), pageCount])]
    .filter((p) => p >= 1 && p <= pageCount);
  const samples = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-pdfbg-'));
  try {
    for (const p of pages) {
      execFileSync('pdftoppm', ['-f', String(p), '-l', String(p), '-r', '12', pdfPath, path.join(tmp, 'pg')]);
      const file = (await fs.readdir(tmp)).find((f) => f.endsWith('.ppm'));
      if (!file) continue;
      const buf = await fs.readFile(path.join(tmp, file));
      await fs.unlink(path.join(tmp, file));
      // P6 ヘッダ: "P6" <w> <h> <max> の4トークン(空白/改行区切り)の直後がバイナリ
      const head = buf.subarray(0, 64).toString('latin1');
      const m = head.match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
      if (!m) continue;
      const w = +m[1]; const off = m[0].length;
      const px = (x, y) => [buf[off + 3 * (y * w + x)], buf[off + 3 * (y * w + x) + 1], buf[off + 3 * (y * w + x) + 2]];
      samples.push({ page: p, corner: px(1, 1) });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  if (!samples.length) return { warning: 'PDF地色検査: ラスタ化に失敗(目視を推奨)', summary: { skipped: 'raster-failed' } };
  /* 最近傍分類: 角の画素が「デッキ地色より letterbox に近い」ときだけヒット。
     絶対距離だけで判定すると、bg と letterbox が近いテーマ(例: 暖色ダーク紙
     #1b1a18 と #0f0e0d — 距離 35)で正しい地色を letterbox と誤検知する。 */
  const hits = samples.filter((s) => dist(s.corner, lb) <= 36 && dist(s.corner, lb) < dist(s.corner, bg));
  const majority = hits.length >= Math.ceil(samples.length / 2);
  const summary = { sampledPages: samples.map((s) => `p${s.page}=rgb(${s.corner.join(',')})`), letterbox: deckInfo.letterbox, deckBg: deckInfo.bg, letterboxHits: hits.length };
  if (majority) {
    return { problem: `PDF のサンプル ${samples.length} ページ中 ${hits.length} ページの地がレターボックス色 ${deckInfo.letterbox} に一致(p${hits.map((s) => s.page).join(',p')}) — print 背景の焼き付き不良(デッキ地色 ${deckInfo.bg} のはず)`, summary };
  }
  return { summary };
}
