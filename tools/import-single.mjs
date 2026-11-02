/* ============================================================================
   tools/import-single.mjs — 編集用の 1 ファイル(bundle.mjs --editable)で直した内容を、正本(src)に戻す
   使い方: node tools/import-single.mjs <編集用の .html> <src フォルダ> [--write]
   - 既定は「何が変わるか」を出すだけ。--write で書き込む
   - 各スライド(<section data-page="キー">)を src/pages/<キー>.html と比べ、変わったページ・新しいページを書く
   - 埋め込んだ画像などは、ファイルに残した元の場所(<script id="pp-assets">)に戻す。
     元の場所が分からない画像(1 ファイルの中で足したもの)は src/assets/ に書き出してそこを指す
   - スライドの並び・セクション・タイトルが変わっていれば src/decks/<冊>.json も直す
   - 自動で作るページ(目次)は戻さない。戻したあとは assemble.py で各冊を組み立て直す
   ============================================================================ */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');
if (files.length < 2) { console.error('使い方: node tools/import-single.mjs <編集用の .html> <src フォルダ> [--write]'); process.exit(2); }
const [single, srcDir] = files;
const html = await fs.readFile(single, 'utf8');
if (!/<meta name="pp-single"/.test(html)) { console.error('error: 編集用の 1 ファイル(bundle.mjs --editable で作ったもの)ではありません'); process.exit(2); }

const assets = JSON.parse((/<script type="application\/json" id="pp-assets">([\s\S]*?)<\/script>/.exec(html) || [, '{}'])[1].replace(/<\\\//g, '</'));
const deckJson = (/<script type="application\/json" id="pp-deck">([\s\S]*?)<\/script>/.exec(html) || [])[1];
const deckName = (/<meta name="pp-deck" content="([^"]*)"/.exec(html) || [])[1];
const subst = ((/<meta name="pp-subst" content="([^"]*)"/.exec(html) || [])[1] || '').split('||').map((p) => p.split('=>')).filter((p) => p.length === 2);
if (!deckJson || !deckName) { console.error('error: ページ単位のデッキの編集用ファイルではありません(冊の並びがない)'); process.exit(2); }
const deck = JSON.parse(deckJson.replace(/<\\\//g, '</'));

// .slides 直下の section を取り出す(入れ子も数える)
// スクリプト・スタイル・テンプレートの中身は見ない(埋め込んだエディターの JS に '<div class="slides">' の文字列がある)
const masked = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<template\b[^>]*>[\s\S]*?<\/template>|<!--[\s\S]*?-->/gi, (m) => m.replace(/[^\n]/g, ' '));
const start = /<div[^>]*class="[^"]*\bslides\b[^"]*"[^>]*>/.exec(masked);
const sections = [];
{
  const re = /<section\b|<\/section>/g; re.lastIndex = start.index + start[0].length;
  let depth = 0, s0 = 0, m;
  while ((m = re.exec(masked))) {
    if (m[0] === '</section>') { if (--depth === 0) sections.push(html.slice(s0, re.lastIndex)); if (depth < 0) break; }
    else { if (depth === 0) s0 = m.index; depth++; }
  }
}

const newAssets = [];
const restore = async (h) => {
  // data URI → 元の場所。分からないものは src/assets に書き出す
  h = await replaceAsync(h, /data:([a-z0-9.+\/-]+);base64,[A-Za-z0-9+\/=]+/gi, async (uri, mime) => {
    const k = createHash('sha1').update(uri).digest('hex');
    if (assets[k]) return assets[k];
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[mime.toLowerCase()] || 'bin';
    const name = 'assets/added-' + k.slice(0, 12) + '.' + ext;
    newAssets.push({ name, data: Buffer.from(uri.split(',')[1], 'base64') });
    return name;
  });
  subst.forEach(([from, to]) => { h = h.split(from).join(to); });   // テーマの実際の場所 → {{THEME}}
  return h;
};
async function replaceAsync(str, re, fn) {
  const out = []; let last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(str))) { out.push(str.slice(last, m.index), await fn(...m)); last = re.lastIndex; }
  out.push(str.slice(last));
  return out.join('');
}
// 比べるときは、空白の入り方・空の class / style・class の前後の空白の違いは無視する(エディターが整えるため)
const norm = (s) => s.replace(/\bclass="([^"]*)"/g, (m, v) => { v = v.trim().replace(/\s+/g, ' '); return v ? 'class="' + v + '"' : ''; })
  .replace(/\bstyle=""/g, '').replace(/\s+(?=[\s>])/g, '').replace(/\s+/g, ' ').trim();

const changes = [];
for (const sec of sections) {
  const key = (/^<section\b[^>]*\bdata-page="([^"]+)"/.exec(sec) || [])[1];
  if (!key || key[0] === '(') continue;   // 目次などの自動のページ
  let page = await restore(sec.replace(/^(<section\b[^>]*?)\s*data-page="[^"]*"/, '$1'));
  const f = path.join(srcDir, 'pages', key + '.html');
  const old = await fs.readFile(f, 'utf8').catch(() => null);
  if (old != null && norm(old) === norm(page)) continue;
  changes.push({ key, file: f, page, isNew: old == null, oldLen: old ? old.length : 0 });
}
const deckFile = path.join(srcDir, 'decks', deckName + '.json');
const oldDeck = JSON.parse(await fs.readFile(deckFile, 'utf8').catch(() => 'null'));
const deckChanged = !oldDeck || JSON.stringify(oldDeck.pages) !== JSON.stringify(deck.pages) || oldDeck.title !== deck.title || (oldDeck.dist || '') !== (deck.dist || '');

console.log(`編集用ファイル: ${single}`);
console.log(`冊: ${deckName}(${sections.length} 枚)`);
if (!changes.length && !deckChanged && !newAssets.length) { console.log('正本と同じです(戻すものはありません)'); process.exit(0); }
for (const c of changes) console.log(`  ${c.isNew ? '新しいページ' : '変わったページ'}  pages/${c.key}.html`);
if (deckChanged) console.log(`  冊の並び・タイトル  decks/${deckName}.json`);
for (const a of newAssets) console.log(`  足した画像  ${a.name}`);
// 共有しているページは、ほかの冊にも反映される
const users = {};
for (const f of await fs.readdir(path.join(srcDir, 'decks'))) {
  if (!f.endsWith('.json') || f === deckName + '.json') continue;
  const d = JSON.parse(await fs.readFile(path.join(srcDir, 'decks', f), 'utf8'));
  for (const c of changes) if ((d.pages || []).includes(c.key)) (users[c.key] = users[c.key] || []).push(f.replace(/\.json$/, ''));
}
for (const [k, v] of Object.entries(users)) console.log(`  ※ ${k} はほかの冊(${v.join('、')})でも使っています。戻すとそちらにも反映されます`);

if (!WRITE) { console.log('\n(書き込んでいません。戻すときは --write を付けてください)'); process.exit(0); }
for (const c of changes) await fs.writeFile(c.file, c.page + '\n');
if (deckChanged) {
  const d = { ...(oldDeck || {}), title: deck.title, pages: deck.pages };
  if ('dist' in deck) d.dist = deck.dist;
  await fs.writeFile(deckFile, JSON.stringify(d, null, 1));
}
for (const a of newAssets) { await fs.mkdir(path.join(srcDir, 'assets'), { recursive: true }); await fs.writeFile(path.join(srcDir, a.name), a.data); }
console.log(`\n書き込みました。各冊への反映は assemble.py で(例：python3 -I ${path.join(srcDir, 'assemble.py')} --check)`);
