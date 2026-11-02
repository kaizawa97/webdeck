/* ============================================================================
   tools/export-pptx.mjs — PPTX 出力(画像貼付方式)
   使い方: node tools/export-pptx.mjs <deckDir>
   出力  : <deckDir>/out/<デッキ名>.pptx と pptx-report.json

   方式:
   - 全スライドを fragment 全表示状態で高解像度スクショ(1280×720 @2x = 2560×1440)
   - pptxgenjs で 16:9 ワイドスライドの背景画像として貼付
   - 各 section の aside.notes を本物のスピーカーノートとして埋め込む
   注意: 画像貼付方式のため PowerPoint 上で内容の編集はできない(見た目完全一致が目的)
   ============================================================================ */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { serveRepo, resolveDeckDir, ensureOutDir, openDeck, REPO_ROOT, serveForDeck } from './lib.mjs';

const CAVEAT = '画像貼付方式のため PowerPoint 上での編集は不可(見た目の完全一致を優先)。編集可能な形が必要な場合は元の HTML デッキを修正して再出力すること。';

const deckDir = resolveDeckDir(process.argv[2]);
const deckName = path.basename(deckDir);

let exitCode = 0;
const server = await serveForDeck(deckDir);
const browser = await chromium.launch();

try {
  // --- デッキを高解像度(@2x)で開く(通常表示。print view ではない) ---
  const badResponses = [];
  const pageErrors = [];
  const { context, page } = await openDeck(browser, server.origin, deckDir, {
    root: server.root,
    deviceScaleFactor: 2,
    onPageError: (err) => pageErrors.push(String(err)),
    onBadResponse: (res) => badResponses.push(`${res.status()} ${res.url()}`),
    onRequestFailed: (req) => badResponses.push(`FAILED ${req.url()}`),
  });

  // ドックがスクショに写り込まないよう非表示にする
  // ドック非表示に加え、レターボックス演出(色・エッジライン)も無効化する。
  // margin>0 のデッキでスクショの余白にレターボックス色が焼き込まれるのを防ぐ。
  await page.addStyleTag({ content: [
    '.pp-dock{display:none!important}',
    '.reveal-viewport{background:var(--pp-bg,#fff)!important}',
    '.reveal > .backgrounds{box-shadow:none!important}',
  ].join('\n') });

  // --- スライド一覧(座標とノート)を収集 ---
  const slideMeta = await page.evaluate(() => {
    // display:none 下の innerText は <br> やブロック要素で改行を生まないため、
    // DOM を自前で辿って改行を復元する(スピーカービューと PPTX ノートの見た目を揃える)
    const notesText = (root) => {
      let out = '';
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c.nodeType === 3) { out += c.textContent; continue; }
          if (c.nodeType !== 1) continue;
          const tag = c.tagName.toLowerCase();
          if (tag === 'br') { out += '\n'; continue; }
          const isBlock = /^(p|div|li|ul|ol|h[1-6]|blockquote|pre|tr|table)$/.test(tag);
          if (isBlock && out && !out.endsWith('\n')) out += '\n';
          walk(c);
          if (isBlock && !out.endsWith('\n')) out += '\n';
        }
      };
      walk(root);
      return out.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    };
    return window.Reveal.getSlides().map((el) => {
      const idx = window.Reveal.getIndices(el);
      const notes = Array.from(el.querySelectorAll('aside.notes'))
        .map(notesText)
        .filter(Boolean)
        .join('\n\n');
      return { h: idx.h, v: idx.v, notes };
    });
  });
  if (slideMeta.length === 0) {
    console.error('error: スライドが1枚も見つかりません');
    process.exitCode = 1;
    throw new Error('no slides');
  }

  const deckTitle = await page.title();

  // --- pptx 準備(16:9 ワイド 13.333×7.5 インチ) ---
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
  pptx.layout = 'WIDE';
  pptx.title = deckTitle;

  // --- 全スライドを巡回してスクショ → 背景貼付 + ノート ---
  let notesCount = 0;
  for (let i = 0; i < slideMeta.length; i++) {
    const meta = slideMeta[i];
    await page.evaluate(({ h, v }) => {
      window.Reveal.slide(h, v);
      // fragment を全表示状態にする
      while (window.Reveal.nextFragment()) { /* 最後の fragment まで送る */ }
    }, meta);
    await page.waitForTimeout(600); // transition(fade/fast)と fragment 表示の settle 待ち

    const png = await page.screenshot({ type: 'png' });
    const slide = pptx.addSlide();
    slide.background = { data: 'image/png;base64,' + png.toString('base64') };
    if (meta.notes) {
      slide.addNotes(meta.notes);
      notesCount++;
    }
    console.log(`  [${i + 1}/${slideMeta.length}] スクリーンショット取得${meta.notes ? '(ノートあり)' : ''}`);
  }

  await context.close();

  // --- 書き出し ---
  const outDir = await ensureOutDir(deckDir);
  const outPath = path.join(outDir, `${deckName}.pptx`);
  await pptx.writeFile({ fileName: outPath });

  // --- 検証: 生成された .pptx を JSZip で開いて構造を確認 ---
  const problems = [];
  const zip = await JSZip.loadAsync(await fs.readFile(outPath));
  const zipFiles = Object.keys(zip.files);
  const slideXmls = zipFiles.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  const notesXmls = zipFiles.filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f));
  if (slideXmls.length !== slideMeta.length) {
    problems.push(`スライド XML 数が不一致: 期待 ${slideMeta.length} / 実際 ${slideXmls.length}`);
  }
  if (notesCount > 0 && notesXmls.length === 0) {
    problems.push(`ノートが ${notesCount} 件あるのに ppt/notesSlides/ が存在しません`);
  }
  if (pageErrors.length) problems.push(`ページエラー: ${pageErrors.join(' / ')}`);
  // 資産の読み込み失敗は「欠けたスクショ」を配布することになるため実害扱いにする
  if (badResponses.length) problems.push(`リソース読み込み失敗 ${badResponses.length} 件: ${badResponses.slice(0, 5).join(' / ')}`);

  // --- レポート ---
  const stat = await fs.stat(outPath);
  const report = {
    deck: path.relative(REPO_ROOT, deckDir),
    title: deckTitle,
    file: path.relative(REPO_ROOT, outPath),
    slides: slideMeta.length,
    notes: notesCount,
    sizeBytes: stat.size,
    resolution: '2560x1440 (1280×720 @2x)',
    caveat: CAVEAT,
    problems,
    warnings: badResponses,
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(outDir, 'pptx-report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log('');
  console.log(`PPTX 出力: ${outPath}`);
  console.log(`  スライド数: ${slideMeta.length} / ノート数: ${notesCount} / サイズ: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  注意: ${CAVEAT}`);
  if (badResponses.length) {
    console.warn(`  警告: 読み込みに失敗したリソースあり(${badResponses.length} 件): ${badResponses.join(' / ')}`);
  }
  if (problems.length) {
    console.error('検証 NG:');
    for (const p of problems) console.error(`  - ${p}`);
    exitCode = 1;
  } else {
    console.log('検証 OK: スライド XML 数一致・ノート格納を確認');
  }
} catch (err) {
  console.error('error: PPTX 出力に失敗しました:', err.message || err);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

process.exit(exitCode);
