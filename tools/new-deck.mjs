/* ============================================================================
   tools/new-deck.mjs — 新規デッキの雛形生成(scaffold)
   使い方: node tools/new-deck.mjs <targetDir> [--template <name>]
                                   [--mode <mode>] [--title "タイトル"]

   - <targetDir> は任意の場所でよい(呼び出し元プロジェクト内を推奨。
     例: presentations/kickoff)。プラットフォーム(このリポジトリ)への
     参照は相対パスを自動算出して書き込む。
   - テンプレートは themes/<name>/template.json のディスカバリで列挙する
     (契約は themes/README.md)。1 つしか無ければ --template は省略できる。
   - --mode はテンプレートの modes から選ぶ。エントリ CSS・モード別アセット・
     テーマ属性をマニフェストどおりにセットで切り替える(片方だけ替えると
     不可視スライドになるため)。旧 --theme は非推奨エイリアス。
   ============================================================================ */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, serveRootFor } from './lib.mjs';

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: node tools/new-deck.mjs <targetDir> [--template <name>] [--mode <mode>] [--title "タイトル"]');
  process.exit(2);
}

/* ---- 引数解析 ---- */
const argv = process.argv.slice(2);
const opts = { template: null, mode: null, title: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const valueOf = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
  if (a === '--template' || a.startsWith('--template=')) opts.template = valueOf();
  else if (a === '--mode' || a.startsWith('--mode=')) opts.mode = valueOf();
  else if (a === '--theme' || a.startsWith('--theme=')) {
    // 旧 CLI 互換(--theme light|dark)。マニフェスト語彙に合わせて --mode に改名した
    console.error('note: --theme は非推奨です。--mode を推奨します');
    opts.mode = valueOf();
  } else if (a === '--title' || a.startsWith('--title=')) opts.title = valueOf();
  else if (a.startsWith('-')) usage(`未知のオプション: ${a}`);
  else positional.push(a);
}
if (positional.length !== 1) usage();

/* ---- テンプレートのディスカバリ(themes/<name>/template.json) ---- */
async function discoverTemplates() {
  const themesDir = path.join(REPO_ROOT, 'themes');
  const entries = await fs.readdir(themesDir, { withFileTypes: true }).catch(() => []);
  const templates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifestPath = path.join(themesDir, e.name, 'template.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (err) {
      console.error(`error: ${manifestPath} の読込に失敗しました: ${err.message}`);
      process.exit(2);
    }
    templates.push({ name: manifest.name || e.name, dir: path.join(themesDir, e.name), manifest });
  }
  return templates;
}

const templates = await discoverTemplates();
if (!templates.length) {
  console.error('error: テンプレートが 1 つも見つかりません(themes/<name>/template.json が必要。契約は themes/README.md)');
  process.exit(2);
}
const names = templates.map((t) => t.name).join(', ');
let tpl;
if (opts.template) {
  tpl = templates.find((t) => t.name === opts.template);
  if (!tpl) {
    console.error(`error: テンプレート "${opts.template}" が見つかりません(候補: ${names})`);
    process.exit(2);
  }
} else if (templates.length === 1) {
  tpl = templates[0];
} else {
  console.error(`error: テンプレートが複数あります。--template を指定してください(候補: ${names})`);
  process.exit(2);
}
const { manifest, dir: themeDir } = tpl;

/* ---- モード選択(マニフェストの modes / defaultMode) ---- */
const mode = opts.mode || manifest.defaultMode;
if (!Array.isArray(manifest.modes) || !manifest.modes.includes(mode)) {
  console.error(`error: テンプレート "${tpl.name}" にモード "${mode}" はありません(候補: ${(manifest.modes || []).join(', ')})`);
  process.exit(2);
}

/* ---- 出力先の検証 ---- */
const targetDir = path.resolve(process.cwd(), positional[0]);
if (existsSync(path.join(targetDir, 'index.html'))) {
  console.error(`error: ${targetDir}/index.html は既に存在します(上書きしません)`);
  process.exit(2);
}

// プラットフォームへの相対パス(デッキ位置基準)。
// 共通祖先がファイルシステムルートになる配置(/tmp 等)は、相対参照が
// 実用に耐えず検証サーバも立てられないため拒否する。
if (serveRootFor(targetDir) === path.parse(targetDir).root) {
  console.error('error: デッキとプラットフォームの共通祖先が / になります。' +
    'プラットフォームと同じホーム配下のプロジェクトに置いてください');
  process.exit(2);
}
const relToPlatform = path.relative(targetDir, REPO_ROOT).split(path.sep).join('/');

await fs.mkdir(targetDir, { recursive: true });

/* ---- 雛形読込とパス書き換え(解決ベース) ----
   starter 内の相対参照を starter の位置基準で絶対パスに解決し、リポジトリ内を
   指すものは「デッキ位置 → その実体」の相対パスに書き換える。マーカー文字列に
   依存しないので、テンプレートがどんな階層構成でも成立する。 */
const starterPath = path.join(themeDir, manifest.starter);
const starterDir = path.dirname(starterPath);
let html = await fs.readFile(starterPath, 'utf8');

const isExternal = (v) => !v || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v) || v.startsWith('/');
const rewriteRef = (v) => {
  if (isExternal(v)) return v;
  const abs = path.resolve(starterDir, v);
  const inRepo = !path.relative(REPO_ROOT, abs).startsWith('..');
  if (!inRepo) return v; // リポジトリ外への参照は触らない
  return path.relative(targetDir, abs).split(path.sep).join('/');
};
html = html.replace(/\b(href|src|data-background-image)="([^"]*)"/g,
  (_m, attr, val) => `${attr}="${rewriteRef(val)}"`);
const rewriteCssUrls = (css) => css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g,
  (_m, q, val) => `url(${q}${rewriteRef(val)}${q})`);
html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
  (_m, open, css, close) => open + rewriteCssUrls(css) + close);
html = html.replace(/\bstyle="([^"]*)"/g, (_m, css) => `style="${rewriteCssUrls(css)}"`);

/* ---- モード切替(マニフェストの entry / modeAssets / themeAttr の対置換) ----
   starter は defaultMode で書かれている。別モードを選んだ時だけ、
   エントリ CSS とモード別アセットを「セットで」対置換し、テーマ属性値も揃える。 */
if (mode !== manifest.defaultMode) {
  const from = manifest.defaultMode;
  const relOf = (p) => {
    const rel = path.relative(targetDir, path.join(themeDir, p)).split(path.sep).join('/');
    return p.endsWith('/') ? `${rel}/` : rel;
  };
  html = html.split(relOf(manifest.entry[from])).join(relOf(manifest.entry[mode]));
  if (manifest.modeAssets && manifest.modeAssets[from] && manifest.modeAssets[mode]) {
    html = html.split(relOf(manifest.modeAssets[from])).join(relOf(manifest.modeAssets[mode]));
  }
  for (const attr of [manifest.themeAttr, ...(manifest.legacyThemeAttrs || [])]) {
    if (!attr) continue;
    html = html.split(`${attr}="${from}"`).join(`${attr}="${mode}"`);
  }
}

/* ---- タイトル ---- */
if (opts.title) {
  const title = opts.title;
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  html = html.replace(/<h1>[^<]*<\/h1>/, `<h1>${title}</h1>`);
  html = html.replace(/title: '[^']*'/, `title: '${title.replace(/'/g, "\\'")}'`);
}

await fs.writeFile(path.join(targetDir, 'index.html'), html);

const relDeck = path.relative(process.cwd(), targetDir) || '.';
console.log(`デッキ雛形を生成しました: ${targetDir}`);
console.log(`  テンプレート: ${tpl.name}/${mode} / プラットフォーム参照: ${relToPlatform}/`);
console.log('');
console.log('次にやること:');
console.log(`  1. ${relDeck}/index.html の <section> を書く(規約: ${relToPlatform}/docs/AUTHORING.md、テーマ正典: ${relToPlatform}/themes/${tpl.name}/README.md)`);
console.log(`  2. 検証: node ${path.join(relToPlatform, 'tools/verify.mjs')} ${relDeck}`);
console.log(`  3. 出力: 同 tools/ の bundle.mjs / export-pdf.mjs / export-pptx.mjs`);
