/* ============================================================================
   tools/lib.mjs — 検証・出力ツール共通ヘルパ
   - serveRepo(): リポジトリルートを Cache-Control: no-store で配信(port 0)
   - openDeck(): 1280×720 でデッキを開き Reveal ready + フォント読込を待つ
   - resolveDeckDir(): CLI 引数の検証
   ============================================================================ */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

/** リポジトリルートを配信する http サーバを起動する。
 *  @returns {Promise<{port: number, origin: string, close: () => Promise<void>}>} */
export function serveRepo(root = REPO_ROOT) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let filePath = path.normalize(path.join(root, urlPath));
      if (!filePath.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store', // 検証中に古い CSS/JS を掴まないこと(実測で事故った)
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** デッキディレクトリ(index.html を含む)を検証して絶対パスで返す。
 *  デッキはプラットフォーム内(decks/ 等)でも外部プロジェクト内でもよい。
 *  外部の場合はプラットフォームとの共通祖先ディレクトリを配信ルートにする
 *  (デッキ HTML がエンジンを相対パスで参照するため)。 */
export function resolveDeckDir(arg) {
  if (!arg) {
    console.error('usage: node tools/<tool>.mjs <deckDir>   (例: decks/my-deck や ../myproj/presentations/x)');
    process.exit(2);
  }
  const deckDir = path.resolve(process.cwd(), arg);
  if (!existsSync(path.join(deckDir, 'index.html'))) {
    console.error(`error: ${deckDir}/index.html が見つかりません`);
    process.exit(2);
  }
  if (serveRootFor(deckDir) === path.parse(deckDir).root) {
    console.error('error: デッキとプラットフォームの共通祖先がファイルシステムルートになります。' +
      'デッキはプラットフォームと同じホーム配下等に置いてください(相対参照とローカル配信の前提)');
    process.exit(2);
  }
  return deckDir;
}

/** デッキ(複数可)とプラットフォームの共通祖先(配信ルート)。
 *  verify --baseline のように 2 つのデッキを 1 つのサーバで同時に配信する場合は
 *  両方を渡す(共通祖先が上がるだけで、各デッキの相対参照はそのまま解決できる)。 */
export function serveRootFor(...deckDirs) {
  const lists = [REPO_ROOT.split(path.sep)];
  for (const d of deckDirs) if (d) lists.push(path.resolve(d).split(path.sep));
  const len = Math.min(...lists.map((l) => l.length));
  const common = [];
  for (let i = 0; i < len; i++) {
    const seg = lists[0][i];
    if (lists.some((l) => l[i] !== seg)) break;
    common.push(seg);
  }
  return common.join(path.sep) || path.sep;
}

/** デッキの URL パス(サーバ origin からの相対。root は serveRootFor の結果) */
export function deckUrlPath(deckDir, root = REPO_ROOT) {
  return '/' + path.relative(root, deckDir).split(path.sep).join('/') + '/index.html';
}

/** デッキ用にサーバを立てて { origin, close, urlPath } を返す(共通祖先を配信)。
 *  alsoServe に別デッキを渡すと、そのデッキも同じサーバから配信できる root を選ぶ。 */
export async function serveForDeck(deckDir, alsoServe = []) {
  const root = serveRootFor(deckDir, ...alsoServe);
  const srv = await serveRepo(root);
  return { ...srv, root, urlPath: deckUrlPath(deckDir, root) };
}

/** out ディレクトリを用意して返す */
export async function ensureOutDir(deckDir, ...sub) {
  const dir = path.join(deckDir, 'out', ...sub);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 1280×720 ビューポートでデッキページを開き、Reveal ready とフォントを待つ。
 *  @param {import('playwright').Browser} browser
 *  @param {object} opts { query?: string, deviceScaleFactor?: number, onConsole?, onRequestFailed? } */
export async function openDeck(browser, origin, deckDir, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: opts.deviceScaleFactor || 1,
    // prefers-reduced-motion: reduce をエミュレートする。
    // count-up 等の JS 演出が即座に確定値へ settle するため、スクショ・PDF・PPTX に
    // 「アニメーション途中の誤った数値」が焼き込まれない(敵対レビューで実害を確認済み)。
    reducedMotion: opts.reducedMotion || 'reduce',
  });
  const page = await context.newPage();
  if (opts.onConsole) page.on('console', opts.onConsole);
  if (opts.onPageError) page.on('pageerror', opts.onPageError);
  if (opts.onRequestFailed) page.on('requestfailed', opts.onRequestFailed);
  page.on('response', (res) => {
    if (res.status() >= 400 && opts.onBadResponse) opts.onBadResponse(res);
  });
  const url = origin + deckUrlPath(deckDir, opts.root || REPO_ROOT) + (opts.query || '');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.Reveal && window.Reveal.isReady && window.Reveal.isReady(), null, { timeout: 15000 })
    .catch(() => { /* print view など isReady 前提が崩れるケースは呼び出し側で待つ */ });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, url };
}
