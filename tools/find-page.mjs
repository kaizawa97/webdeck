/* ============================================================================
   tools/find-page.mjs — 指摘(Orca の Design Feedback など)から、元のページのファイルを探す
   使い方:
     node tools/find-page.mjs <デッキの index.html か URL> [--text="文字"] [--selector="span.no"] [--page=キー]
   - URL に ?page=<キー> があれば(エディターが付ける)、そのページを最初に出す
   - ページ単位のデッキ(<section data-page>)は、冊の並びの順に src/pages/<キー>.html を調べ、
     文字(タグを外して比べる)と指定(タグ名・クラス)が合うページと行を出す
   - どのページにも無い文字は、エディターの画面など、スライドの外の可能性が高い
   ============================================================================ */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
let target = args.find((a) => !a.startsWith('--'));
if (!target) { console.error('使い方: node tools/find-page.mjs <index.html か URL> [--text=] [--selector=] [--page=]'); process.exit(2); }

let pageFromUrl = null;
if (/^file:/.test(target)) {
  const u = new URL(target);
  pageFromUrl = u.searchParams.get('page');
  target = fileURLToPath(u.origin === 'null' || u.protocol === 'file:' ? 'file://' + u.pathname : u.href);
} else {
  const m = /[?&]page=([^&#]+)/.exec(target);
  if (m) pageFromUrl = decodeURIComponent(m[1]);
  target = target.replace(/[?#].*$/, '');
}
if ((await fs.stat(target)).isDirectory()) target = path.join(target, 'index.html');
let page = opt('page') || pageFromUrl;
const text = opt('text');
const selector = opt('selector');

const norm = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
// 比べるときは空白と改行を全部外す(画面の文字は改行や空白の入り方がファイルと違うことがある)
const key = (s) => norm(s).replace(/\s+/g, '');
// 開始タグ(at)から、同じタグの入れ子を数えて閉じタグまでの中身を返す
function innerOf(body, at, tag, openLen) {
  const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '>', 'gi');
  re.lastIndex = at + openLen;
  let depth = 1, m;
  while ((m = re.exec(body))) {
    if (m[0][1] === '/') { if (--depth === 0) return body.slice(at + openLen, m.index); }
    else if (!/\/>$/.test(m[0])) depth++;
  }
  return body.slice(at + openLen);
}
const lastSel = selector ? selector.split(/\s*>\s*|\s+/).pop().replace(/:[\w-]+(\([^)]*\))?/g, '') : null;
const sel = lastSel ? /^([a-z0-9]+)?((?:\.[\w-]+)*)/i.exec(lastSel) : null;
const selTag = sel && sel[1] ? sel[1].toLowerCase() : null;
const selClasses = sel && sel[2] ? sel[2].split('.').filter(Boolean) : [];

const html = await fs.readFile(target, 'utf8');
const deckDir = path.dirname(target);
// 冊の並び(ページのキー)。index.html の section から読む
// 画面のスライド番号と合わせるため、目次などの自動のページも数に入れる
const allKeys = [...html.matchAll(/<section\b[^>]*\bdata-page="([^"]+)"/g)].map((m) => m[1]);
const keys = allKeys.filter((k) => k[0] !== '(');
// Orca の指定には section の位置(:nth-of-type(N))が入ることがある。URL にページ名がなければ、それを使う
const nth = selector && /section[^\s>]*:nth-of-type\((\d+)\)/.exec(selector);
if (!page && nth && allKeys[+nth[1] - 1] && allKeys[+nth[1] - 1][0] !== '(') page = allKeys[+nth[1] - 1];
const srcPages = path.join(path.dirname(deckDir), 'src', 'pages');
const hasSrc = keys.length && await fs.stat(srcPages).then(() => true, () => false);

// 調べる対象：ページ単位なら src/pages/<キー>.html、そうでなければ index.html の各 section
const units = [];
if (hasSrc) {
  for (const [i, k] of allKeys.entries()) {
    if (k[0] === '(') continue;
    const f = path.join(srcPages, k + '.html');
    const body = await fs.readFile(f, 'utf8').catch(() => null);
    if (body != null) units.push({ key: k, n: i + 1, file: f, body });
  }
} else {
  [...html.matchAll(/<section\b[\s\S]*?<\/section>/g)].forEach((m, i) => units.push({ key: null, n: i + 1, file: target, body: m[0], offset: m.index }));
}

// 1 つのファイルの中で、文字・指定が合う要素の行を探す
function hits(u) {
  const out = [];
  const lines = u.body.split('\n');
  const base = u.offset ? html.slice(0, u.offset).split('\n').length - 1 : 0;
  // 要素の開始タグを順に見て、その要素の文字(おおまかに次の閉じタグまで)と比べる
  const re = /<([a-z0-9]+)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(u.body))) {
    const tag = m[1].toLowerCase(), attrs = m[2];
    if (selTag && tag !== selTag) continue;
    const cls = (/\bclass="([^"]*)"/.exec(attrs) || [, ''])[1].split(/\s+/).filter(Boolean);
    if (selClasses.length && !selClasses.every((c) => cls.includes(c))) continue;
    const VOID = /^(br|img|input|hr|meta|link|source|col|wbr)$/;
    const inner = VOID.test(tag) ? '' : innerOf(u.body, m.index, tag, m[0].length);
    const t = norm(inner);
    if (text && !key(inner).includes(key(text))) continue;
    if (!text && !selector) continue;
    const line = base + u.body.slice(0, m.index).split('\n').length;
    out.push({ line, tag, cls: cls.join(' '), text: t.slice(0, 60), exact: !!text && key(inner) === key(text), size: inner.length });
  }
  // いちばん内側の要素から出す(外側の要素も文字を含むため)
  out.sort((a, b) => (b.exact - a.exact) || a.size - b.size);
  return out;
}

const results = [];
for (const u of units) {
  const h = hits(u);
  if (h.length) results.push({ ...u, hits: h, score: (u.key && u.key === page ? 100 : 0) + (h.some((x) => x.exact) ? 10 : 0) + (selector ? 1 : 0) });
}
results.sort((a, b) => b.score - a.score || a.n - b.n);

const rel = (f) => path.relative(process.cwd(), f) || f;
if (page && !results.some((r) => r.key === page)) {
  const u = units.find((x) => x.key === page);
  if (u) console.log(`URL のページ：${page}（${u.n} 枚目）→ ${rel(u.file)}（文字・指定はこのページに見つからない）`);
}
if (!results.length) {
  console.log('見つかりません。' + (text ? 'この文字はスライドの中に無いため、エディターの画面など、スライドの外の部分の可能性が高い' : '--text か --selector を付けてください'));
  process.exit(1);
}
for (const r of results.slice(0, 8)) {
  const tagline = r.key ? `${r.n} 枚目  ${r.key}${r.key === page ? '（URL のページ）' : ''}` : `${r.n} 枚目`;
  console.log(`${tagline}\n  ${rel(r.file)}`);
  r.hits.slice(0, 5).forEach((h) => console.log(`    ${h.line} 行目  <${h.tag}${h.cls ? ' class="' + h.cls + '"' : ''}>  ${h.text}${h.exact ? '' : '（部分一致）'}`));
}
if (results.length > 8) console.log(`ほか ${results.length - 8} ページ`);
// 共有しているページは、ほかの冊にも反映されることを知らせる
if (hasSrc && results[0].key) {
  const decks = path.join(path.dirname(srcPages), 'decks');
  const users = [];
  for (const f of await fs.readdir(decks).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(await fs.readFile(path.join(decks, f), 'utf8'));
    if ((d.pages || []).includes(results[0].key)) users.push(f.replace(/\.json$/, ''));
  }
  if (users.length > 1) console.log(`\n${results[0].key} を使っている冊：${users.join('、')}(直すと全部に反映)`);
}
