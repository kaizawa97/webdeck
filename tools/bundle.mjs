/* ============================================================================
   tools/bundle.mjs — デッキを自己完結の単一 HTML にバンドルする
   使い方: node tools/bundle.mjs <deckDir> [--strip-notes] [--dist-title "<名>"]
                                 [--no-pdf] [--no-thumbs]
   出力:   <deckDir>/out/<デッキ名>.html(デッキ名 = ディレクトリ名)
           --strip-notes 時は out/<デッキ名>-dist.html、
           --dist-title "<名>" 指定時は out/<名>.html(名はファイル名として無害化)

   やること:
   1. <link rel="stylesheet"> → <style> 展開(CSS 内の @import は再帰展開、
      url(...) 資産は base64 data URI 化。パス解決は各 CSS ファイル基準)
   2. <script src> → インライン("</script" は "<\/script" にエスケープ)
   3. HTML 属性の資産参照(img src / poster / data-background-image 等)を data URI 化
   4. http(s):// への外部参照はインライン化せず警告(オフライン配布で壊れるため)
   5. 正式 PDF(tools/export-pdf.mjs の検証済み成果物)を window.PP_PDF として
      埋め込み(ドックの PDF ダウンロードボタン用。--no-pdf で省略可)
   6. 生成後に file:// スモークテストを自動実行し、結果を out/bundle-report.json へ
   7. --strip-notes: スピーカーノート(aside.notes)を要素まるごと削除した
      「配布版」を作る。削除は HTML 組み立て段階で行い、その場で
      (a) aside.notes が 0 個 (b) <section> 数が元と同一 をアサートする
      (破れたら生成失敗)。スモークテストでも実ブラウザの DOM で再確認する
   9. --editable: 開くと編集画面になり、そのファイルに上書き保存できる「編集用の 1 ファイル」を作る
      (エディターを埋め込む。PDF・サムネイルは直すと古くなるので入れない)。画像などの元の場所を
      <script id="pp-assets"> に残し、tools/import-single.mjs で src/pages に戻せるようにする
   8. --dist-title "<名>": 出力ファイル名・<title>・埋め込み PDF のダウンロード名を
      <名> にする(既定のダウンロード名はディレクトリ名なので、聴衆に渡す配布物では
      日本語タイトル等へ差し替える)
   ============================================================================ */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { REPO_ROOT, serveRepo, resolveDeckDir, ensureOutDir, openDeck, serveForDeck } from './lib.mjs';

/* ------------------------------------------------------------ 定数・状態 */

const MIME = {
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

const CATEGORY = { フォント: ['.woff', '.woff2', '.ttf', '.otf', '.eot'],
                   画像: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'] };

const stats = { フォント: 0, 画像: 0, JS: 0, CSS: 0, その他: 0 };
const warnings = [];      // 見つからない資産など(続行する)
const externalRefs = [];  // http(s):// 参照(インライン化しない)

// 配布版(--strip-notes / --dist-title)の実測値。レポートにも出す
const dist = { stripNotes: false, notesRemoved: 0, sections: -1, title: null, pdfName: null };

function addStat(ext, bytes) {
  for (const [cat, exts] of Object.entries(CATEGORY)) {
    if (exts.includes(ext)) { stats[cat] += bytes; return; }
  }
  stats.その他 += bytes;
}

function fmt(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

const execFileP = promisify(execFile);

/** 「最後の」</body> の直前にタグを注入する。最初の出現はインライン化された
 *  notes.js 内のスピーカービュー HTML 文字列であり、そこに差し込むと
 *  スクリプトが分断される(実際に踏んだ)。
 *  注: toLowerCase() したコピーの lastIndexOf で原文を切らない — Unicode には
 *  小文字化で長さが変わる文字(İ 等)があり、位置がずれる。原文を直接走査する。 */
function injectBeforeLastBody(html, tag) {
  const re = /<\/body\s*>/gi;
  let li = -1;
  for (let m; (m = re.exec(html)) !== null;) li = m.index;
  return li >= 0 ? html.slice(0, li) + tag + '\n' + html.slice(li) : html + tag;
}

/* ------------------------------------------------------------ 汎用ヘルパ */

/** String.replace の async 版(fn にはマッチ配列を渡す)。
 *  再帰呼び出しで lastIndex を共有しないよう、正規表現は複製して使う */
async function replaceAsync(str, regex, fn) {
  const re = new RegExp(regex.source, regex.flags);
  const out = [];
  let last = 0, m;
  while ((m = re.exec(str)) !== null) {
    out.push(str.slice(last, m.index), await fn(m));
    last = m.index + m[0].length;
    if (!re.global) break;
  }
  out.push(str.slice(last));
  return out.join('');
}

function isExternal(ref) { return /^(https?:)?\/\//i.test(ref); }
function isSkippable(ref) {
  return !ref || /^(data:|#|mailto:|javascript:|about:|blob:)/i.test(ref);
}

/** 参照をファイルパスに解決(?query や #hash は除去。/ 始まりはリポジトリルート基準) */
function resolveRef(baseDir, ref) {
  const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
  return clean.startsWith('/') ? path.join(REPO_ROOT, clean) : path.resolve(baseDir, clean);
}

/** 資産ファイルを base64 data URI にする(見つからなければ警告して null) */
const assetMap = {};          // --editable: data URI の sha1 → 元の参照(デッキの index.html から見た書き方)
let recordAssets = false;
async function toDataUri(baseDir, ref, ctx) {
  const uri = await toDataUriRaw(baseDir, ref, ctx);
  if (uri && recordAssets && baseDir === recordAssets) {
    const { createHash } = await import('node:crypto');
    assetMap[createHash('sha1').update(uri).digest('hex')] = ref;
  }
  return uri;
}
async function toDataUriRaw(baseDir, ref, ctx) {
  const abs = resolveRef(baseDir, ref);
  let buf;
  try { buf = await fs.readFile(abs); }
  catch { warnings.push(`資産が見つかりません: ${ref}(参照元: ${ctx})`); return null; }
  const ext = path.extname(abs).toLowerCase();
  const uri = `data:${MIME[ext] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
  addStat(ext, uri.length);
  return uri;
}

/* ------------------------------------------------------------ CSS の処理 */

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;

/** CSS テキスト中の url(...) を data URI 化(baseDir = その CSS の場所)。
 *  urlQuote: 書き戻し時のクォート。style="..." 属性内では属性のクォートと衝突するため
 *  '' (クォートなし)を渡す(base64 data URI は空白・括弧を含まないので安全) */
async function inlineCssUrls(css, baseDir, ctx, urlQuote = '"') {
  return replaceAsync(css, CSS_URL_RE, async (m) => {
    const ref = m[2].trim();
    if (isSkippable(ref)) return m[0];
    if (isExternal(ref)) { externalRefs.push(`${ref}(CSS: ${ctx})`); return m[0]; }
    const uri = await toDataUri(baseDir, ref, ctx);
    return uri ? `url(${urlQuote}${uri}${urlQuote})` : m[0];
  });
}

/** CSS ファイルを読み、@import を再帰展開しつつ url(...) を data URI 化して返す */
async function inlineCss(cssPath, seen) {
  const rel = path.relative(REPO_ROOT, cssPath);
  if (seen.has(cssPath)) { warnings.push(`重複または循環 @import をスキップ(1回だけ取り込み): ${rel}`); return ''; }
  seen.add(cssPath);

  let css;
  try { css = await fs.readFile(cssPath, 'utf8'); }
  catch { warnings.push(`CSS が見つかりません: ${rel}`); return ''; }
  stats.CSS += Buffer.byteLength(css);

  const dir = path.dirname(cssPath);

  // 1. @import を先に再帰展開(展開結果は退避し、後段の url() 変換の対象外にする。
  //    展開結果内の url() は再帰側で「その CSS の場所」基準で解決済みのため)
  const inserted = [];
  css = await replaceAsync(css, CSS_IMPORT_RE, async (m) => {
    const ref = (m[2] || m[4]).trim();
    const media = (m[5] || '').trim();
    if (isExternal(ref)) { externalRefs.push(`${ref}(@import in ${rel})`); return m[0]; }
    const inner = await inlineCss(resolveRef(dir, ref), seen);
    const body = `/* ---- inlined: ${path.relative(REPO_ROOT, resolveRef(dir, ref))} ---- */\n${inner}`;
    inserted.push(media ? `@media ${media} {\n${body}\n}` : body);
    return `\u0000CSSIMP${inserted.length - 1}\u0000`;
  });

  // 2. この CSS 自身の url(...) を data URI 化
  css = await inlineCssUrls(css, dir, rel);

  // 3. 退避した @import 展開結果を戻す
  return css.replace(/\u0000CSSIMP(\d+)\u0000/g, (_, i) => inserted[+i]);
}

/** <style> ブロックに安全に入れる(万一 "</style" が含まれても閉じられないように) */
function escapeStyle(css) { return css.replace(/<\/style/gi, (m) => '<\\' + m.slice(1)); }

/* ------------------------------------------------------------ HTML 属性の処理 */

/** タグ文字列内の指定属性(引用符両対応・大文字小文字不問)を data URI に書き換える */
async function rewriteAttr(tag, attr, baseDir, ctx) {
  const re = new RegExp(`(\\b${attr}\\s*=\\s*)("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return tag;
  const ref = (m[3] ?? m[4] ?? m[5] ?? '').trim();
  if (isSkippable(ref)) return tag;
  if (isExternal(ref)) { externalRefs.push(`${ref}(属性 ${attr})`); return tag; }
  const uri = await toDataUri(baseDir, ref, ctx);
  return uri ? tag.replace(re, `$1"${uri}"`) : tag;
}

/* ------------------------------------------- 配布版(ノート削除・タイトル差替) */

/** タグの属性文字列から class を取り出し、notes クラスを持つか判定する */
function hasNotesClass(attrs) {
  const m = attrs.match(/\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  const cls = m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
  return /(^|\s)notes(\s|$)/.test(cls);
}

/** 開始タグの数(</aside> のような閉じタグは <aside\b にマッチしないので数えない) */
function countTags(html, name) {
  return (html.match(new RegExp(`<${name}\\b`, 'gi')) || []).length;
}

function countNotesAsides(html) {
  const re = /<aside\b([^>]*)>/gi;
  let n = 0;
  for (let m; (m = re.exec(html)) !== null;) if (hasNotesClass(m[1])) n++;
  return n;
}

/** aside.notes を「開始タグから対応する閉じタグまで」まるごと削除する。
 *  注記の中にさらに <aside> が入れ子になっていても閉じタグを取り違えないよう
 *  深さを数える。閉じタグが足りない場合は投げる — 黙って末尾まで削ると
 *  スライドを丸ごと落としかねない(ノート編集時の閉じタグ欠落は実際に起きる)。
 *  @returns {{html: string, removed: number}} */
function stripNotesAsides(html) {
  const TAG_RE = /<(\/?)aside\b([^>]*)>/gi;
  const out = [];
  let last = 0, removed = 0, m;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m[1] === '/') continue;             // 対応の取れない閉じタグは触らない
    if (!hasNotesClass(m[2])) continue;     // notes 以外の <aside> は残す
    const start = m.index;
    const inner = new RegExp(TAG_RE.source, TAG_RE.flags);
    inner.lastIndex = TAG_RE.lastIndex;
    let depth = 1, end = -1;
    for (let t; (t = inner.exec(html)) !== null;) {
      depth += t[1] === '/' ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    if (end < 0) {
      throw new Error(`ノート削除に失敗: <aside class="notes"> に対応する </aside> がありません` +
        `(${removed + 1} 個目。index.html の閉じタグを確認してください)`);
    }
    out.push(html.slice(last, start));
    last = end;
    removed++;
    TAG_RE.lastIndex = end;                 // 削除済み範囲は再走査しない
  }
  out.push(html.slice(last));
  return { html: out.join(''), removed };
}

function escapeHtmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** ファイル名として無害化する(区切り文字・制御文字を除去し、長さも詰める) */
function sanitizeFileName(name, ext) {
  let out = name.normalize('NFC')
    .replace(/[\\/:*?"<>|]/g, '_')                // OS が嫌う区切り・予約文字
    // 制御文字は落とす(ファイル名に入れない。この関数の外では \u0000 を退避トークンに使っている)
    .split('').filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f).join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')                          // 先頭ドット(隠しファイル化)を避ける
    .replace(/[.\s]+$/, '');                      // 末尾ドット・空白(Windows で不正)
  // ext4 のファイル名上限は 255 バイト。日本語は 1 文字 3 バイトなので文字数では測らない
  while (out && Buffer.byteLength(out + ext) > 200) out = out.slice(0, -1);
  if (!out) {
    console.error('error: --dist-title がファイル名として使える文字を含みません');
    process.exit(2);
  }
  return out;
}

/* ------------------------------------------------------------------ main */

/** @param {{stripNotes?: boolean, distTitle?: string|null}} opts */
async function buildBundle(deckDir, opts = {}) {
  const indexPath = path.join(deckDir, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');
  if (opts.editable) recordAssets = deckDir;

  // --- コメントを退避(コメント内の参照は処理しない) ---
  const comments = [];
  html = html.replace(/<!--[\s\S]*?-->/g, (m) => {
    comments.push(m);
    return `\u0000HTMLC${comments.length - 1}\u0000`;
  });

  // 処理済みブロック(<style>/<script>)の退避先。後段の属性パスから守る
  const blocks = [];
  const stash = (s) => { blocks.push(s); return `\u0000BLK${blocks.length - 1}\u0000`; };

  // --- 1. <script> を最初に退避・インライン化する ---
  // インラインスクリプトの文字列リテラル内に '<link rel="stylesheet">' 等が
  // 書かれていても、後段の CSS/属性パスが実タグと誤認しないようにする。
  html = await replaceAsync(html, /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi, async (m) => {
    const tag = m[0];
    const srcM = tag.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    const src = (srcM && (srcM[2] ?? srcM[3] ?? srcM[4]) || '').trim();
    if (!src) return stash(tag); // インラインスクリプト: そのまま退避
    if (isExternal(src)) { externalRefs.push(`${src}(script src)`); return stash(tag); }
    const abs = resolveRef(deckDir, src);
    let js;
    try { js = await fs.readFile(abs, 'utf8'); }
    catch { warnings.push(`スクリプトが見つかりません: ${src}`); return stash(tag); }
    stats.JS += Buffer.byteLength(js);
    // "</script" は "<\/script" にエスケープ(文字列リテラル内なので意味は変わらない)
    js = js.replace(/<\/script/gi, (s) => '<\\' + s.slice(1));
    return stash(`<script>\n/* ==== inlined script: ${src} ==== */\n${js}\n</script>`);
  });

  // --- 1a. <link rel="stylesheet"> → <style>、rel=icon の href は data URI 化 ---
  html = await replaceAsync(html, /<link\b[^>]*>/gi, async (m) => {
    const tag = m[0];
    const relM = tag.match(/\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    const rel = (relM && (relM[2] ?? relM[3] ?? relM[4])) || '';
    const hrefM = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    const href = (hrefM && (hrefM[2] ?? hrefM[3] ?? hrefM[4]) || '').trim();

    if (/stylesheet/i.test(rel)) {
      if (!href || isSkippable(href)) return tag;
      if (isExternal(href)) { externalRefs.push(`${href}(link stylesheet)`); return tag; }
      const css = await inlineCss(resolveRef(deckDir, href), new Set());
      return stash(`<style>\n/* ==== inlined stylesheet: ${href} ==== */\n${escapeStyle(css)}\n</style>`);
    }
    if (/icon/i.test(rel)) return stash(await rewriteAttr(tag, 'href', deckDir, 'link icon'));
    return tag;
  });

  // --- 1b. 既存のインライン <style> 内の url(...) も data URI 化して退避 ---
  html = await replaceAsync(html, /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, async (m) => {
    const css = await inlineCssUrls(m[1], deckDir, 'インライン <style>');
    return stash(m[0].slice(0, m[0].indexOf('>') + 1) + escapeStyle(css) + '</style>');
  });

  // (<script> は手順 1 で退避済み)

  // --- 1c. 配布版の加工(ノート削除・<title> 差替) ---
  // ここで行うのは、この時点では <script>/<style>/コメントが退避済みで「デッキ本体の
  // マークアップだけ」が残っているため。notes.js のスピーカービュー HTML 文字列にも
  // <aside class="notes"> と <title> が含まれており、生の全文置換では巻き込む。
  // また資産の data URI 化(手順 3)より前に削るので、ノート専用の画像はバンドルに入らない。
  if (opts.stripNotes) {
    const sectionsBefore = countTags(html, 'section');
    const { html: stripped, removed } = stripNotesAsides(html);
    html = stripped;

    // 生成時アサート: 破れたら配布物を作らせない(ノート混入は取り返しがつかない)
    const leftover = countNotesAsides(html);
    const sectionsAfter = countTags(html, 'section');
    if (leftover !== 0) {
      throw new Error(`配布版アサート失敗: aside.notes が ${leftover} 個残っています(削除ロジックの取りこぼし)`);
    }
    if (sectionsAfter !== sectionsBefore) {
      throw new Error(`配布版アサート失敗: <section> 数が変わりました(元 ${sectionsBefore} → ${sectionsAfter})`);
    }
    dist.stripNotes = true;
    dist.notesRemoved = removed;
    dist.sections = sectionsAfter;
    console.log(`  スピーカーノートを削除: aside.notes ${removed} 個(<section> ${sectionsAfter} 個は不変)`);
  }
  if (opts.distTitle) {
    let replaced = 0;
    html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/i, () => {
      replaced++;
      return `<title>${escapeHtmlText(opts.distTitle)}</title>`;
    });
    if (!replaced) warnings.push('<title> が見つからないため上書きしませんでした');
    dist.title = opts.distTitle;
  }

  // --- 3. 残りのタグの資産属性(img src / poster / data-background-* / style 属性) ---
  const SRC_TAGS = /^(img|source|video|audio|input|embed|track)$/i;
  html = await replaceAsync(html, /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, async (m) => {
    let tag = m[0];
    if (SRC_TAGS.test(m[1])) tag = await rewriteAttr(tag, 'src', deckDir, `<${m[1]}> src`);
    // インライン SVG の <image>/<use>(href / xlink:href)もインライン化する
    if (/^(image|use)$/i.test(m[1])) {
      tag = await rewriteAttr(tag, 'href', deckDir, `<${m[1]}> href`);
      tag = await rewriteAttr(tag, 'xlink:href', deckDir, `<${m[1]}> xlink:href`);
    }
    for (const attr of ['poster', 'data-background-image', 'data-background-video']) {
      tag = await rewriteAttr(tag, attr, deckDir, attr);
    }
    // style 属性内の url(...)。属性のクォートと衝突しないよう data URI はクォートなしで書き戻す
    const styleM = tag.match(/(\bstyle\s*=\s*)("([^"]*)"|'([^']*)')/i);
    if (styleM && /url\(/i.test(styleM[0])) {
      const q = styleM[2][0];
      const inlined = await inlineCssUrls(styleM[3] ?? styleM[4], deckDir, 'style 属性', '');
      tag = tag.replace(styleM[0], `${styleM[1]}${q}${inlined}${q}`);
    }
    return tag;
  });

  // --- 退避ブロックとコメントを復元 ---
  // 退避ブロック内にさらにトークンがネストし得る(例: インラインスクリプト内の
  // <style> 文字列)ため、トークンが消えるまで繰り返し復元する。
  let guard = 0;
  while (/\u0000(?:BLK|HTMLC)\d+\u0000/.test(html) && guard++ < 20) {
    html = html.replace(/\u0000BLK(\d+)\u0000/g, (_, i) => blocks[+i]);
    html = html.replace(/\u0000HTMLC(\d+)\u0000/g, (_, i) => comments[+i]);
  }
  if (html.includes('\u0000')) {
    throw new Error('内部エラー: 退避プレースホルダを復元しきれませんでした(bundle.mjs のバグ)');
  }
  return html;
}

/* ------------------------------------------------ サムネイル生成(埋め込み用) */

/** 全スライドの縮小サムネイル(JPEG data URI)を撮る。
 *  スピーカービューの左レールが単一 HTML 配布でも画像付きになるよう、
 *  window.PP_THUMBS としてバンドルに埋め込む(--no-thumbs で省略可) */
async function captureThumbs(browser, deckDir) {
  const srv = await serveForDeck(deckDir);
  try {
    const { context, page } = await openDeck(browser, srv.origin, deckDir, { root: srv.root });
    // ドックとレターボックス演出はサムネイルに写さない(verify と同じ扱い)
    await page.addStyleTag({ content: [
      '.pp-dock{display:none!important}',
      '.reveal-viewport{background:var(--pp-bg,#fff)!important}',
      '.reveal > .backgrounds{box-shadow:none!important}',
    ].join('\n') });
    const indices = await page.evaluate(() =>
      window.Reveal.getSlides().map((el) => window.Reveal.getIndices(el)));
    const thumbs = [];
    for (const { h, v } of indices) {
      await page.evaluate(([hh, vv]) => window.Reveal.slide(hh, vv, 99), [h, v]);
      await page.waitForTimeout(350); // reducedMotion 下なので settle は短くて足りる
      const png = await page.screenshot({ type: 'png' });
      // ページ内 canvas で幅 400px の JPEG に縮小(レール表示幅 ~200px の 2x)
      const uri = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 400;
        c.height = Math.round(400 * img.height / img.width);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.72);
      }, png.toString('base64'));
      thumbs.push(uri);
    }
    await context.close();
    return thumbs;
  } finally {
    await srv.close();
  }
}

/* ------------------------------------------------------ file:// スモークテスト */

/** @param {{shotName?: string, expectPdfName?: string|null, expectNoNotes?: boolean}} opts */
async function smokeTest(browser, deckDir, outFile, outDir, expectPdf, opts = {}) {
  // 元デッキのスライド数・DOM 上の section / aside.notes 数(HTTP 配信で取得)。
  // どちらのページも Reveal 初期化後に数えるので、素の HTML ではなく実 DOM で比較できる
  const srv = await serveForDeck(deckDir);
  let originalTotal = -1;
  let originalDom = { sections: -1, notes: -1 };
  try {
    const { context, page } = await openDeck(browser, srv.origin, deckDir, { root: srv.root });
    originalTotal = await page.evaluate(() => window.Reveal.getTotalSlides());
    originalDom = await page.evaluate(() => ({
      sections: document.querySelectorAll('.reveal .slides section').length,
      notes: document.querySelectorAll('aside.notes').length,
    }));
    await context.close();
  } finally {
    await srv.close();
  }

  // バンドルを file:// で開く
  const errors = { console: [], pageerror: [], requestfailed: [], badResponses: [] };
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.console.push(msg.text()); });
  page.on('pageerror', (err) => errors.pageerror.push(String(err)));
  page.on('requestfailed', (req) => errors.requestfailed.push(`${req.url().slice(0, 200)} (${req.failure()?.errorText})`));
  page.on('response', (res) => { if (res.status() >= 400) errors.badResponses.push(`${res.status()} ${res.url().slice(0, 200)}`); });

  await page.goto(pathToFileURL(outFile).href, { waitUntil: 'load' });
  let revealReady = true;
  await page.waitForFunction(() => window.Reveal && window.Reveal.isReady && window.Reveal.isReady(),
    null, { timeout: 15000 }).catch(() => { revealReady = false; });
  await page.evaluate(() => document.fonts.ready).catch(() => {});

  const bundleTotal = revealReady
    ? await page.evaluate(() => window.Reveal.getTotalSlides())
    : -1;

  // バンドル側の DOM 実測(配布版のノート 0 個・section 数不変を実ブラウザで確認する)
  const bundleDom = await page.evaluate(() => ({
    sections: document.querySelectorAll('.reveal .slides section').length,
    notes: document.querySelectorAll('aside.notes').length,
    title: document.title,
  })).catch(() => ({ sections: -1, notes: -1, title: '' }));

  // 埋め込み PDF の健全性(--no-pdf でなければ検査):
  // PP_PDF が存在し、デコード先頭が %PDF で、ドックの PDF ボタンが表示されていること。
  // ダウンロード名(--dist-title で差し替わる)も突き合わせる
  let pdfEmbed = null;
  if (expectPdf) {
    pdfEmbed = await page.evaluate((wantName) => {
      const p = window.PP_PDF;
      const present = !!(p && p.data);
      let headerOk = false;
      try { headerOk = present && atob(p.data.slice(0, 8)).startsWith('%PDF'); } catch (e) {}
      const btn = document.querySelector('.pp-dock button[data-act="pdf"]');
      return {
        present, headerOk, buttonVisible: !!btn && btn.style.display !== 'none',
        name: present ? p.name : null,
        nameOk: !wantName || (present && p.name === wantName),
      };
    }, opts.expectPdfName || null)
      .catch(() => ({ present: false, headerOk: false, buttonVisible: false, name: null, nameOk: false }));
  }

  // ドックが自動で隠れるのを待ってからスライド1のスクショ
  await page.waitForTimeout(3000);
  const shot = await page.screenshot();
  const shotPath = path.join(outDir, opts.shotName || 'bundle-smoke-slide1.png');
  await fs.writeFile(shotPath, shot);

  // 白紙判定: スクショを data URI で読み戻し、左上画素と異なる画素の割合を数える
  const pixels = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const r0 = d[0], g0 = d[1], b0 = d[2];
    let diff = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - r0) > 8 || Math.abs(d[i + 1] - g0) > 8 || Math.abs(d[i + 2] - b0) > 8) diff++;
    }
    return { total: d.length / 4, diff };
  }, shot.toString('base64')).catch(() => ({ total: 1, diff: 0 }));
  const diffRatio = pixels.diff / pixels.total;
  // 白紙判定の閾値: テキスト主体の白背景スライドは前景画素が数%に満たないことが
  // 普通にあるため、0.3% とする(完全な白紙・描画失敗は 0.0x% になる)
  const screenshotNotBlank = diffRatio > 0.003;

  await context.close();

  const totalsMatch = revealReady && bundleTotal === originalTotal;
  const noErrors = Object.values(errors).every((a) => a.length === 0);
  const pdfOk = !expectPdf || !!(pdfEmbed && pdfEmbed.present && pdfEmbed.headerOk
    && pdfEmbed.buttonVisible && pdfEmbed.nameOk);
  // 配布版のみの合否条件。通常版では判定に使わないので null(該当なし)にする
  // — レポートで「検証した結果 true」と見分けがつかなくなるため
  const notesStripped = opts.expectNoNotes
    ? (bundleDom.notes === 0 && bundleDom.sections === originalDom.sections)
    : null;
  const pass = revealReady && totalsMatch && noErrors && screenshotNotBlank && pdfOk
    && notesStripped !== false;

  return {
    pass, revealReady,
    totalSlides: { original: originalTotal, bundle: bundleTotal, match: totalsMatch },
    dom: { original: originalDom, bundle: bundleDom, notesStripped },
    errors, screenshot: { path: shotPath, diffRatio: +diffRatio.toFixed(4), notBlank: screenshotNotBlank },
    pdfEmbed,
  };
}

/* ------------------------------------------------------------------- 実行 */

const argv = process.argv.slice(2);

function usage(code) {
  console.error([
    'usage: node tools/bundle.mjs <deckDir> [options]',
    '',
    '  --strip-notes            スピーカーノート(aside.notes)を完全削除した配布版を作る',
    '                           (出力は out/<デッキ名>-dist.html。聴衆・顧客へ渡す版)',
    '  --dist-title "<名>"      出力ファイル名・<title>・埋め込み PDF のダウンロード名を <名> にする',
    '  --no-pdf                 配布用 PDF の生成・埋め込みを省く',
    '  --no-thumbs              スピーカービュー用サムネイルの埋め込みを省く',
    '  --editable               開くと編集画面になり、そのファイルに保存できる編集用の 1 ファイル(out/<デッキ名>-edit.html)',
    '                           直した内容は tools/import-single.mjs で src/pages に戻す',
    '',
    '  例: node tools/bundle.mjs decks/my-deck',
    '      node tools/bundle.mjs decks/my-deck --strip-notes --dist-title "AIエージェント入門"',
  ].join('\n'));
  process.exit(code);
}

/** --name <値> / --name=値 の値。未指定なら null */
function flagValue(name) {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return null;
  const v = argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`error: ${name} には値が必要です(例: ${name} "配布用のタイトル")`);
    process.exit(2);
  }
  return v;
}

if (argv.includes('--help') || argv.includes('-h')) usage(0);

const stripNotes = argv.includes('--strip-notes');
const editable = argv.includes('--editable');
if (editable && stripNotes) { console.error('error: --editable と --strip-notes は同時に使えません(編集用にはノートを残す)'); process.exit(2); }
const distTitle = flagValue('--dist-title');
// deckDir は値を取るフラグ(--dist-title)の値を除いた最初の非フラグ引数。
// フラグを先に書いても動くようにしている
const deckArg = argv.find((a, i) => !a.startsWith('--')
  && !(i > 0 && argv[i - 1] === '--dist-title'));
if (!deckArg) usage(2);

const deckDir = resolveDeckDir(deckArg);
const deckName = path.basename(deckDir);
const outDir = await ensureOutDir(deckDir);
// 出力名: --dist-title 優先 → --strip-notes の既定(-dist 付き)→ デッキ名
const outBase = distTitle ? sanitizeFileName(distTitle, '.html')
  : stripNotes ? `${deckName}-dist`
    : editable ? `${deckName}-edit`
      : deckName;
const outFile = path.join(outDir, `${outBase}.html`);
// 埋め込み PDF のダウンロード名(--dist-title のときだけ差し替える)
const pdfDownloadName = `${distTitle ? sanitizeFileName(distTitle, '.pdf') : deckName}.pdf`;
dist.pdfName = pdfDownloadName;
// 通常版の成果物名は一切変えない。配布版は別名にして、どちらのレポート・
// スクショがどの HTML のものか取り違えないようにする(古い成果物での誤判定は実害)
const artifactPrefix = outBase === deckName ? '' : `${outBase}-`;
const reportPath = path.join(outDir, `${artifactPrefix}bundle-report.json`);

console.log(`バンドル生成: ${path.relative(REPO_ROOT, deckDir)} → ${path.relative(REPO_ROOT, outFile)}`);
if (stripNotes) console.log('  配布版: スピーカーノートを削除します(--strip-notes)');
if (distTitle) console.log(`  配布名: ${distTitle}(PDF ダウンロード名 ${pdfDownloadName})`);

let bundled;
try {
  bundled = await buildBundle(deckDir, { stripNotes, distTitle, editable });
  if (editable) {
    // エディターを埋め込み、開くと編集画面になるようにする。画像の元の場所の表も入れる
    const edCss = await fs.readFile(path.join(REPO_ROOT, 'runtime', 'editor.css'), 'utf8');
    const edJs = (await fs.readFile(path.join(REPO_ROOT, 'runtime', 'editor.js'), 'utf8')).replace(/<\/script/gi, (x) => '<\\' + x.slice(1));
    const head = '<meta name="pp-single" content="1">\n<style>\n/* ==== inlined stylesheet: runtime/editor.css ==== */\n' + escapeStyle(edCss) + '\n</style>\n';
    bundled = bundled.replace(/<\/head>/i, () => head + '</head>');
    const body = '<script type="application/json" id="pp-assets">' + JSON.stringify(assetMap).replace(/<\//g, '<\\/') + '</script>\n'
      + '<script>window.PP_EDITOR_INLINE = true;</script>\n<script>\n/* ==== inlined script: runtime/editor.js ==== */\n' + edJs + '\n</script>\n';
    bundled = bundled.replace(/<body\b[^>]*>/i, (m) => m + '\n' + body);
    console.log(`  編集用: エディターを埋め込み、画像などの元の場所 ${Object.keys(assetMap).length} 件を記録`);
  }
} catch (e) {
  // 前回の成功バンドルが残っていると、fail 後に古い成果物(配布版なら「ノート入りの
  // 旧 HTML」)を掴んで配ってしまう。PDF 失敗時と同じく、消してから落ちる
  await fs.rm(outFile, { force: true });
  await fs.rm(reportPath, { force: true });
  console.error(`error: ${e.message}`);
  process.exit(1);
}

// --- 配布用 PDF の生成・埋め込み(ドックの PDF ダウンロードボタン用。--no-pdf で省略) ---
// ブラウザでその場生成はしない。検証込みの正式パイプライン(export-pdf)の
// 成果物をそのまま埋め込むことで、ボタンから落ちる PDF の品質・ページ数を
// 配布物でも保証する。
let pdfEmbedBytes = 0;
if (!argv.includes('--no-pdf') && !editable) {
  console.log('配布用 PDF を生成中(tools/export-pdf.mjs)...');
  try {
    const { stdout } = await execFileP(process.execPath,
      [path.join(REPO_ROOT, 'tools', 'export-pdf.mjs'), deckDir],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    for (const line of stdout.trim().split('\n')) console.log(`  ${line}`);
    const pdfBuf = await fs.readFile(path.join(outDir, `${deckName}.pdf`));
    const tag = `<script>window.PP_PDF=${JSON.stringify(
      { name: pdfDownloadName, data: pdfBuf.toString('base64') })};</script>`;
    pdfEmbedBytes = Buffer.byteLength(tag);
    bundled = injectBeforeLastBody(bundled, tag);
    console.log(`  PDF(${fmt(pdfBuf.length)})を埋め込みました(base64 換算 ${fmt(pdfEmbedBytes)})`);
  } catch (e) {
    for (const out of [e.stdout, e.stderr]) {
      if (out) for (const line of String(out).trim().split('\n')) console.error(`  ${line}`);
    }
    // 前回の成功バンドル・pass レポートが残っていると、fail 後に古い成果物を
    // 掴んで配ってしまいやすい。消してから落ちる。
    await fs.rm(outFile, { force: true });
    await fs.rm(reportPath, { force: true });
    console.error('error: 配布用 PDF の生成に失敗しました。デッキを修正するか、--no-pdf で PDF なしのバンドルを作ってください');
    process.exit(1);
  }
}

// --- 配布名でタブのタイトルを固定(--dist-title) ---
// <title> の差し替えだけでは足りない: runtime/shell.js の init() が opts.title
// (deck.js が渡すデッキ本来のタイトル)で document.title を上書きするため、
// デッキのスクリプト群より後で最後に上書きする。投影ウィンドウの接尾辞は残す。
if (distTitle) {
  const tag = `<script>(function(){var t=${JSON.stringify(distTitle)},s=' — 投影';`
    + `document.title=document.title.slice(-s.length)===s?t+s:t;})();</script>`;
  bundled = injectBeforeLastBody(bundled, tag);
}

// --- サムネイル埋め込み(スピーカービューの左レール用。--no-thumbs で省略) ---
const browser = await chromium.launch();
let thumbsBytes = 0;
if (!argv.includes('--no-thumbs') && !editable) {
  console.log('スピーカービュー用サムネイルを生成・埋め込み中...');
  try {
    const thumbs = await captureThumbs(browser, deckDir);
    const tag = `<script>window.PP_THUMBS=${JSON.stringify(thumbs)};</script>`;
    thumbsBytes = Buffer.byteLength(tag);
    bundled = injectBeforeLastBody(bundled, tag);
    console.log(`  ${thumbs.length} 枚(${fmt(thumbsBytes)})を埋め込みました`);
  } catch (e) {
    warnings.push(`サムネイル埋め込みに失敗(レールはタイトル表示になります): ${e.message}`);
  }
}

await fs.writeFile(outFile, bundled);
const totalBytes = Buffer.byteLength(bundled);

// --- サイズ内訳 ---
console.log(`\n出力サイズ: ${fmt(totalBytes)}(${outFile})`);
console.log('内訳(バンドル内の占有量。フォント/画像は base64 換算):');
for (const [cat, bytes] of Object.entries(stats)) {
  if (bytes > 0) console.log(`  ${cat.padEnd(4, '　')}: ${fmt(bytes)}`);
}
if (thumbsBytes > 0) console.log(`  サムネイル: ${fmt(thumbsBytes)}`);
if (pdfEmbedBytes > 0) console.log(`  埋め込みPDF: ${fmt(pdfEmbedBytes)}`);
if (totalBytes > 40 * 1024 * 1024) {
  console.warn('警告: 出力が 40MB を超えています。画像・動画の圧縮を検討してください');
}
if (externalRefs.length) {
  console.warn(`\n警告: http(s) 外部参照が ${externalRefs.length} 件あります(インライン化されないため、オフラインでは表示が壊れます):`);
  for (const r of externalRefs) console.warn(`  - ${r}`);
}
if (warnings.length) {
  console.warn('\n警告:');
  for (const w of warnings) console.warn(`  - ${w}`);
}

// --- file:// スモークテスト ---
console.log('\nfile:// スモークテストを実行中...');
let smoke;
try {
  smoke = await smokeTest(browser, deckDir, outFile, outDir, pdfEmbedBytes > 0, {
    shotName: `${artifactPrefix}bundle-smoke-slide1.png`,
    expectPdfName: pdfEmbedBytes > 0 ? pdfDownloadName : null,
    expectNoNotes: stripNotes,
  });
} finally {
  await browser.close();
}

const report = {
  deck: path.relative(REPO_ROOT, deckDir),
  bundle: path.relative(REPO_ROOT, outFile),
  generatedAt: new Date().toISOString(),
  sizeBytes: totalBytes,
  sizeBreakdown: { ...stats },
  dist: { ...dist },
  externalRefs,
  warnings,
  smoke,
};
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

console.log(`  Reveal ready        : ${smoke.revealReady ? 'OK' : 'NG'}`);
console.log(`  スライド数一致      : ${smoke.totalSlides.match ? 'OK' : 'NG'} (元 ${smoke.totalSlides.original} / バンドル ${smoke.totalSlides.bundle})`);
console.log(`  エラー 0 件         : ${Object.values(smoke.errors).every((a) => a.length === 0) ? 'OK' : 'NG'}`);
console.log(`  スクショ白紙でない  : ${smoke.screenshot.notBlank ? 'OK' : 'NG'} (差分画素率 ${(smoke.screenshot.diffRatio * 100).toFixed(1)}%)`);
if (smoke.pdfEmbed) {
  const p = smoke.pdfEmbed;
  const ok = p.present && p.headerOk && p.buttonVisible && p.nameOk;
  console.log(`  PDF 埋め込み        : ${ok ? 'OK' : 'NG'} (present=${p.present} header=${p.headerOk} button=${p.buttonVisible} name=${p.name})`);
}
if (stripNotes) {
  const d = smoke.dom;
  console.log(`  ノート削除(DOM)   : ${d.notesStripped ? 'OK' : 'NG'} (aside.notes ${d.bundle.notes} 個 / section ${d.bundle.sections} 個・元 ${d.original.sections} 個)`);
}
console.log(`レポート: ${reportPath}`);

if (!smoke.pass) {
  console.error('\nスモークテスト失敗。bundle-report.json を確認してください');
  for (const [kind, arr] of Object.entries(smoke.errors)) {
    for (const e of arr) console.error(`  [${kind}] ${e}`);
  }
  process.exit(1);
}
console.log('\nバンドル完了(スモークテスト PASS)');
