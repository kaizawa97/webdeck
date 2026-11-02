/* ============================================================================
   tools/export-pptx-editable.mjs — PPTX 出力(PowerPoint で直せる形)
   使い方: node tools/export-pptx-editable.mjs <deckDir> [--ea-font=游ゴシック体名] [--out=ファイル名]
   出力  : <deckDir>/out/<デッキ名>-editable.pptx と pptx-editable-report.json

   方式:
   - ブラウザ(1280×720)で各スライドを開き、fragment を全部出した状態で、要素の位置と見た目を測る
   - 文字 → テキストボックス(書式の区切りごとに太字・色・大きさ・上付きなど)
     背景色・枠線のある要素 → 四角形(角丸・円)、画像 → 画像、SVG(図・グラフ)→ 画像
     スライドの背景(色・画像)、フッターとページ番号もそのまま置く
   - aside.notes はスピーカーノートに入れる
   注意: 位置はブラウザで測った値なのでほぼ合うが、PowerPoint の文字の組み方はブラウザと違うため、
         折り返しの位置がずれることがある。グラデーション・影は単色・なしに近似する。
         見た目を完全に合わせたいときは export-pptx.mjs(画像を貼る方式)を使う
   ============================================================================ */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { resolveDeckDir, ensureOutDir, openDeck, REPO_ROOT, serveForDeck } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const deckDir = resolveDeckDir(args.find((a) => !a.startsWith('--')));
const deckName = path.basename(deckDir);
const EA_FONT = opt('ea-font', 'Yu Gothic');   // 日本語の文字に使う書体(Windows・Mac の PowerPoint にある)
const OUT_NAME = opt('out', deckName + '-editable');
// 書体の置き換え(「元=先」をカンマ区切り)。Amazon Ember Display は入っていない PC が多いので Amazon Ember に寄せる
const FONT_MAP = Object.fromEntries(opt('font-map', 'Amazon Ember Display=Amazon Ember').split(',').filter(Boolean).map((x) => x.split('=').map((y) => y.trim())));
const PX = 1 / 96;                              // 1280px = 13.333in

/* ---- ブラウザの中で、今のスライドを部品に分解する ---- */
async function extractSlide(FONT_MAP_) {
  const W = 1280;
  const SMALL = 30000;   // これより小さいグラデーションの飾りは画面から切り出す(大きいものは単色に近似)
  const slidesEl = Reveal.getSlidesElement();
  const sl = slidesEl.getBoundingClientRect();
  const k = sl.width / W;
  const box = (r) => ({ x: (r.left - sl.left) / k, y: (r.top - sl.top) / k, w: r.width / k, h: r.height / k });
  const sec = Reveal.getCurrentSlide();
  const items = [];
  const warn = [];

  const col = (c) => {
    if (!c) return null;
    const cm = c.match(/color\(srgb ([^)]+)\)/);   // color-mix() の計算結果は color(srgb r g b / a)(0〜1)
    if (cm) {
      const q = cm[1].split(/[\s\/]+/).filter(Boolean).map(Number), a = q.length > 3 ? q[3] : 1;
      if (!(a > 0.01)) return null;
      return { hex: q.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('').toUpperCase(), a };
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    const a = p.length > 3 ? p[3] : 1;
    if (!(a > 0.01)) return null;
    return { hex: p.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase(), a };
  };
  const opacityOf = (e) => { let o = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) o *= parseFloat(getComputedStyle(x).opacity) || 0; return o; };
  const firstFont = (f) => (f || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  const INLINE_DISPLAY = /^(inline|contents)$/;
  const SKIP = /^(SCRIPT|STYLE|TEMPLATE|ASIDE|NOSCRIPT|BR)$/;
  const urlOf = (bg) => { const m = /url\(["']?([^"')]+)["']?\)/.exec(bg || ''); return m ? new URL(m[1], document.baseURI).href : null; };
  const gradientColor = (bg) => { const m = /(?:linear|radial)-gradient\((.*)\)/.exec(bg || ''); if (!m) return null; const c = /rgba?\([^)]+\)/.exec(m[1]); return c ? col(c[0]) : null; };

  // 画像を PNG / JPEG の data URL に(SVG は大きさに合わせて描き直す)
  const toData = async (src, w, h) => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      if (/svg/.test(blob.type) || /\.svg(\?|$)/i.test(src)) {
        const url = URL.createObjectURL(blob);
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement('canvas'); const s = 2;
        c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        return c.toDataURL('image/png');
      }
      return await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
    } catch (e) { warn.push('画像を読めない: ' + src); return null; }
  };
  // インラインの SVG を PNG に(見た目の指定を要素に書き写してから描く)
  const SVG_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'stop-color', 'stop-opacity', 'display', 'visibility'];
  const svgData = async (svg, w, h) => {
    const clone = svg.cloneNode(true);
    const a = [svg, ...svg.querySelectorAll('*')], b = [clone, ...clone.querySelectorAll('*')];
    a.forEach((e, i) => { const cs = getComputedStyle(e); b[i].setAttribute('style', SVG_PROPS.map((p) => p + ':' + cs.getPropertyValue(p)).join(';')); });
    clone.setAttribute('width', w); clone.setAttribute('height', h);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    try {
      const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement('canvas'); const s = 2;
      c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } catch (e) { return null; }
  };

  // 文字の書式の区切り(run)。インラインの子だけを辿る。ブロックの子は別の部品として扱う
  const runsOf = (e) => {
    const runs = [];
    const pushText = (text, cs, extra) => {
      if (!text) return;
      const c = col(cs.color) || { hex: '000000', a: 1 };
      const deco = cs.textDecorationLine || '';
      const va = cs.verticalAlign;
      const hl = extra && extra.hl;
      runs.push({ text, o: {
        fontFace: FONT_MAP_[firstFont(cs.fontFamily)] || firstFont(cs.fontFamily), fontSize: +(parseFloat(cs.fontSize) / k * 0.75).toFixed(1),
        bold: parseInt(cs.fontWeight, 10) >= 600, italic: cs.fontStyle === 'italic',
        underline: /underline/.test(deco) ? { style: 'sng' } : undefined, strike: /line-through/.test(deco) ? 'sngStrike' : undefined,
        color: c.hex, transparency: c.a < 1 ? Math.round((1 - c.a) * 100) : undefined,
        superscript: va === 'super' || undefined, subscript: va === 'sub' || undefined,
        charSpacing: parseFloat(cs.letterSpacing) ? +(parseFloat(cs.letterSpacing) / k * 0.75).toFixed(2) : undefined,
        highlight: hl || undefined,
      } });
    };
    const pseudo = (el, which) => {
      const ps = getComputedStyle(el, which), ct = ps.content;
      if (!ct || ct === 'none' || ct === 'normal' || !/^["']/.test(ct)) return;
      pushText(ct.slice(1, -1).replace(/\\a/g, '\n'), ps);
    };
    const walk = (node, hl) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { pushText(c.nodeValue, getComputedStyle(node), { hl }); continue; }
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'BR') { runs.push({ br: true }); continue; }
        const cs = getComputedStyle(c);
        if (cs.display === 'none' || SKIP.test(c.tagName)) continue;
        if (!INLINE_DISPLAY.test(cs.display)) continue;   // ブロックの子は別に描く
        const bg = col(cs.backgroundColor);
        pseudo(c, '::before');
        walk(c, bg ? bg.hex : hl);
        pseudo(c, '::after');
      }
    };
    pseudo(e, '::before');
    walk(e, null);
    pseudo(e, '::after');
    // 空白をブラウザと同じように詰める(white-space: normal のとき)
    const pre = /pre/.test(getComputedStyle(e).whiteSpace);
    let out = [];
    runs.forEach((r) => {
      if (r.br) { out.push(r); return; }
      let t = pre ? r.text : r.text.replace(/\s+/g, ' ');
      out.push({ text: t, o: r.o });
    });
    if (!pre) {   // 行頭・行末の空白を落とす
      const trimEdge = (list, front) => {
        for (let i = front ? 0 : list.length - 1; front ? i < list.length : i >= 0; i += front ? 1 : -1) {
          if (list[i].br) break;
          list[i].text = front ? list[i].text.replace(/^\s+/, '') : list[i].text.replace(/\s+$/, '');
          if (list[i].text) break;
        }
      };
      const lines = [[]]; out.forEach((r) => { if (r.br) lines.push([]); else lines[lines.length - 1].push(r); });
      lines.forEach((l) => { trimEdge(l, true); trimEdge(l, false); });
      out = [];
      lines.forEach((l, i) => { l.filter((r) => r.text).forEach((r) => out.push(r)); if (i < lines.length - 1) out.push({ br: true }); });
    }
    return out;
  };
  const hasOwnInline = (e) => {
    for (const c of e.childNodes) {
      if (c.nodeType === 3 && /\S/.test(c.nodeValue)) return true;
      if (c.nodeType === 1 && INLINE_DISPLAY.test(getComputedStyle(c).display) && !SKIP.test(c.tagName) && /\S/.test(c.textContent)) return true;
    }
    const b = getComputedStyle(e, '::before').content;
    return !!b && /^["'].+["']$/.test(b);
  };

  // ::before / ::after の飾り(中身が空で、背景・枠線のあるもの)を本物の span にして測れるようにする
  if (!document.getElementById('pp-x-nopseudo')) {
    const st = document.createElement('style'); st.id = 'pp-x-nopseudo';
    st.textContent = '.pp-x-nob::before{display:none!important}.pp-x-noa::after{display:none!important}';
    document.head.appendChild(st);
  }
  const PSEUDO_COPY = ['display', 'width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'vertical-align', 'position', 'top', 'right', 'bottom', 'left',
    'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-radius', 'transform', 'opacity', 'flex', 'align-self', 'box-sizing'];
  const materialize = (root) => {
    for (const e of [root, ...root.querySelectorAll('*')]) {
      if (e.namespaceURI === 'http://www.w3.org/2000/svg' || e.hasAttribute('data-pp-pseudo')) continue;
      for (const which of ['::before', '::after']) {
        const ps = getComputedStyle(e, which);
        if (ps.display === 'none' || !/^["']{2}$/.test(ps.content)) continue;
        const deco = col(ps.backgroundColor) || ps.backgroundImage !== 'none' || ['Top', 'Right', 'Bottom', 'Left'].some((d) => parseFloat(ps['border' + d + 'Width']) > 0 && ps['border' + d + 'Style'] !== 'none');
        if (!deco) continue;
        const sp = document.createElement('span');
        sp.setAttribute('data-pp-pseudo', which);
        sp.style.cssText = PSEUDO_COPY.map((p) => p + ':' + ps.getPropertyValue(p)).join(';');
        if (which === '::before') e.insertBefore(sp, e.firstChild); else e.appendChild(sp);
        e.classList.add(which === '::before' ? 'pp-x-nob' : 'pp-x-noa');
      }
    }
  };
  // 文字の左端(先頭の文字の位置)。番号の丸などが前にあっても重ならないように
  const textLeft = (e) => {
    let left = Infinity;
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3 && /\S/.test(c.nodeValue)) {
          const rg = document.createRange(); rg.selectNodeContents(c);
          for (const r of rg.getClientRects()) if (r.width > 0) left = Math.min(left, r.left);
        } else if (c.nodeType === 1 && INLINE_DISPLAY.test(getComputedStyle(c).display)) walk(c);
      }
    };
    walk(e);
    return left;
  };

  // エディターで挿入した部品(.pp-obj)。回転していても、回す前の位置と大きさ(中心は同じ)
  const rot1 = (cs) => { const m = /(-?[\d.]+)deg/.exec(cs.rotate || ''); return m ? parseFloat(m[1]) : 0; };
  const rotOf = (cs, e) => {   // 自分と、外側のグループの回転を足す
    let d = rot1(cs);
    for (let x = e && e.parentElement; x && x.classList && x.classList.contains('pp-obj'); x = x.parentElement) d += rot1(getComputedStyle(x));
    return d;
  };
  const objBox = (e, r) => {
    const w = e.offsetWidth, h = e.offsetHeight, cx = (r.left + r.width / 2 - sl.left) / k, cy = (r.top + r.height / 2 - sl.top) / k;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  };
  const shapeItem = (e, cs, op, r) => {
    const g = e.querySelector(':scope > svg.pp-sh-g'), sp = g && g.querySelector('.pp-sh-p');
    if (!sp) return null;
    const ps = getComputedStyle(sp), flip = e.getAttribute('data-flip') || '';
    const base = { ...objBox(e, r), rot: rotOf(cs, e), flipH: /h/.test(flip), flipV: /v/.test(flip), op, shadow: e.classList.contains('pp-shadow'), dash: e.getAttribute('data-dash') || '' };
    const stroke = col(ps.stroke), sw = parseFloat(ps.strokeWidth) || 0;
    if (e.classList.contains('pp-line')) {
      return { t: 'line', ...base, kind: e.getAttribute('data-shape'), c: stroke || { hex: '000000', a: 1 }, lw: sw / k || 2, hs: e.getAttribute('data-hs') || '', he: e.getAttribute('data-he') || '' };
    }
    let fill = null;
    if (/url\(/.test(ps.fill)) {   // グラデーション:最後の色(塗りの色)で近似
      const stops = g.querySelectorAll('stop');
      fill = stops.length ? col(getComputedStyle(stops[stops.length - 1]).stopColor) : null;
    } else fill = col(ps.fill);
    const fo = parseFloat(ps.fillOpacity);
    if (fill && !isNaN(fo)) fill = { ...fill, a: fill.a * fo };
    const tEl = e.querySelector(':scope > .pp-sh-t');
    const runs = tEl ? runsOf(tEl) : [];
    const pad = ['Top', 'Right', 'Bottom', 'Left'].map((d) => (parseFloat(cs['padding' + d]) || 0) / k);
    const tcs = tEl ? getComputedStyle(tEl) : cs, ta = tcs.textAlign, lh = parseFloat(tcs.lineHeight);
    const jc = cs.justifyContent;
    return { t: 'shape', ...base, type: e.getAttribute('data-shape') || 'rect', fill: fill && fill.a > 0.01 ? fill : null, line: stroke && sw > 0 ? { c: stroke, w: sw / k } : null,
      text: runs.some((x) => x.text && /\S/.test(x.text)) ? { runs, pad, align: ta === 'center' ? 'center' : ta === 'right' || ta === 'end' ? 'right' : ta === 'justify' ? 'justify' : 'left',
        valign: /flex-end|end/.test(jc) ? 'bottom' : /center/.test(jc) ? 'middle' : 'top', lineSpacing: lh ? +(lh / k * 0.75).toFixed(1) : null } : null };
  };
  const tableItem = (e, op) => {   // 挿入した表 → PowerPoint の表
    const tb = e.querySelector('table');
    if (!tb) return null;
    const rows = Array.from(tb.rows).map((tr) => Array.from(tr.cells).map((c) => {
      const ccs = getComputedStyle(c), bg = col(ccs.backgroundColor), runs = runsOf(c), bc = col(ccs.borderTopColor), bw = parseFloat(ccs.borderTopWidth) || 0;
      const r0 = runs.find((x) => !x.br) || null;
      return { runs, colspan: c.colSpan > 1 ? c.colSpan : undefined, fill: bg, border: bc && bw ? { c: bc, w: bw / k } : null, base: r0 ? r0.o : null,
        align: ccs.textAlign === 'center' ? 'center' : ccs.textAlign === 'right' ? 'right' : 'left',
        pad: ['Top', 'Right', 'Bottom', 'Left'].map((d) => (parseFloat(ccs['padding' + d]) || 0) / k), h: c.getBoundingClientRect().height / k };
    }));
    const first = tb.rows[0];
    const colW = first ? Array.from(first.cells).map((c) => c.getBoundingClientRect().width / k) : [];
    return { t: 'table', ...box(tb.getBoundingClientRect()), rows, colW, rowH: Array.from(tb.rows).map((tr) => tr.getBoundingClientRect().height / k), op };
  };

  const visit = async (e) => {
    if (e.nodeType !== 1 || SKIP.test(e.tagName) || e.matches('aside.notes')) return;
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const op = opacityOf(e);
    if (op < 0.02) return;
    const r = e.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) { if (!e.children.length && !e.classList.contains('pp-line')) return; }
    const b = box(r);
    const tag = e.tagName.toLowerCase();
    if (e.classList.contains('pp-obj')) {
      if (e.classList.contains('pp-shape') || e.classList.contains('pp-line')) { const it = shapeItem(e, cs, op, r); if (it) { items.push(it); return; } }
      if (e.classList.contains('pp-tblw')) { const it = tableItem(e, op); if (it) { items.push(it); return; } }
      if (tag === 'img') {
        const data = await toData(e.currentSrc || e.src, e.offsetWidth, e.offsetHeight);
        const sc = (cs.scale || '1').split(/\s+/).map(parseFloat);
        if (data) items.push({ t: 'img', ...objBox(e, r), data, op, rot: rotOf(cs, e), flipH: sc[0] < 0, flipV: (sc.length > 1 ? sc[1] : sc[0]) < 0, shadow: e.classList.contains('pp-shadow') });
        return;
      }
      // グループ:中の部品をそれぞれ描く(グループの回転は PowerPoint では外れる)
    }

    if (tag === 'img') {
      const data = await toData(e.currentSrc || e.src, b.w, b.h);
      if (data) items.push({ t: 'img', ...b, data, fit: cs.objectFit, op });
      return;
    }
    if (tag === 'svg') {
      const data = await svgData(e, r.width / k, r.height / k);
      if (data) items.push({ t: 'img', ...b, data, op });
      else items.push({ t: 'shot', ...b });   // 描けない SVG は画面を切り出す
      return;
    }
    if (e.namespaceURI === 'http://www.w3.org/2000/svg') return;

    // 四角形(背景・枠線・角丸)
    const isGrad = /gradient\(/.test(cs.backgroundImage);
    if (isGrad && r.width * r.height / (k * k) < SMALL) {   // 小さいグラデーションの飾り(点・線など)は画面から切り出す
      items.push({ t: 'shot', ...b });
      if (!hasOwnInline(e) && !e.children.length) return;
    }
    const fill = col(cs.backgroundColor) || (isGrad && r.width * r.height / (k * k) >= SMALL ? gradientColor(cs.backgroundImage) : null);
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((d) => (cs['border' + d + 'Style'] !== 'none' ? parseFloat(cs['border' + d + 'Width']) || 0 : 0));
    const bc = ['Top', 'Right', 'Bottom', 'Left'].map((d) => col(cs['border' + d + 'Color']));
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    const allSame = bw.every((w) => w === bw[0]) && bc.every((c) => (c && c.hex) === (bc[0] && bc[0].hex));
    if (fill || (allSame && bw[0] > 0 && bc[0])) {
      items.push({ t: 'rect', ...b, fill, line: allSame && bw[0] > 0 && bc[0] ? { c: bc[0], w: bw[0] / k } : null,
        radius: rad / k, round: rad >= Math.min(r.width, r.height) / 2 - 0.5, op });
    }
    if (!allSame) {   // 片側だけの枠線(帯の左の線、表の罫線など)は細い四角形で
      const [t, rr, bt, l] = bw;
      if (t && bc[0]) items.push({ t: 'rect', x: b.x, y: b.y, w: b.w, h: t / k, fill: bc[0], op });
      if (bt && bc[2]) items.push({ t: 'rect', x: b.x, y: b.y + b.h - bt / k, w: b.w, h: bt / k, fill: bc[2], op });
      if (l && bc[3]) items.push({ t: 'rect', x: b.x, y: b.y, w: l / k, h: b.h, fill: bc[3], op });
      if (rr && bc[1]) items.push({ t: 'rect', x: b.x + b.w - rr / k, y: b.y, w: rr / k, h: b.h, fill: bc[1], op });
    }
    // 背景の画像(ロゴなど)
    const bgUrl = urlOf(cs.backgroundImage);
    if (bgUrl) {
      const data = await toData(bgUrl, b.w, b.h);
      if (data) items.push({ t: 'img', ...b, data, fit: /cover/.test(cs.backgroundSize) ? 'cover' : 'contain', bgPos: cs.backgroundPosition, op });
    }
    // 文字
    if (hasOwnInline(e)) {
      const pl = parseFloat(cs.paddingLeft) + (bw[3] || 0), pr = parseFloat(cs.paddingRight) + (bw[1] || 0);
      const pt = parseFloat(cs.paddingTop) + (bw[0] || 0), pb = parseFloat(cs.paddingBottom) + (bw[2] || 0);
      const runs = runsOf(e);
      if (runs.some((x) => x.text && /\S/.test(x.text))) {
        const lh = parseFloat(cs.lineHeight);
        const ta = cs.textAlign;
        const flexMid = /flex/.test(cs.display) && (cs.alignItems === 'center' || cs.justifyContent === 'center' && cs.flexDirection === 'column');
        const inner = { x: b.x + pl / k, y: b.y + pt / k, w: Math.max(4, b.w - (pl + pr) / k), h: Math.max(4, b.h - (pt + pb) / k) };
        const tl = textLeft(e);
        if (isFinite(tl) && ta !== 'center' && ta !== 'right' && ta !== 'end') {
          const nx = (tl - sl.left) / k;
          if (nx > inner.x + 1) { inner.w -= nx - inner.x; inner.x = nx; }
        }
        const lines = lh ? Math.round((inner.h) / (lh / k)) : 1;
        items.push({ t: 'text', ...inner, runs, op,
          align: ta === 'center' ? 'center' : ta === 'right' || ta === 'end' ? 'right' : ta === 'justify' ? 'justify' : 'left',
          valign: flexMid ? 'middle' : 'top', lineSpacing: lh ? +(lh / k * 0.75).toFixed(1) : null, oneLine: lines <= 1,
          bullet: cs.display === 'list-item' && cs.listStyleType !== 'none' ? (cs.listStyleType === 'decimal' ? 'num' : 'dot') : null });
      }
    }
    for (const c of e.children) {
      const ccs = getComputedStyle(c);
      if (hasOwnInline(e) && INLINE_DISPLAY.test(ccs.display)) continue;   // 文字の一部として描いた
      await visit(c);
    }
  };

  // スライドの背景
  let bg = null;
  const bgImg = sec.getAttribute('data-background-image');
  const bgCol = sec.getAttribute('data-background-color');
  if (bgImg) bg = { data: await toData(new URL(bgImg, document.baseURI).href, 1280, 720) };
  else {
    const c = col(bgCol ? bgCol : getComputedStyle(document.querySelector('.reveal .backgrounds')).backgroundColor);
    if (c) bg = { color: c.hex };
  }
  materialize(sec);
  document.querySelectorAll('body > .aws-footer, .reveal .slide-number').forEach(materialize);
  await visit(sec);
  // スライドの外に置かれた、全スライド共通の飾り(フッター・ページ番号)
  for (const e of document.querySelectorAll('body > .aws-footer, .reveal .slide-number, body > [data-pp-chrome]')) await visit(e);
  return { bg, items, warn };
}

/* ---- 挿入した図形・線・表を PowerPoint の部品として置く ---- */
const SHADOW = { type: 'outer', blur: 4, offset: 2, angle: 90, color: '000000', opacity: 0.3 };
const DASH = { dash: 'dash', dot: 'sysDot' };
const HEAD = { tri: 'triangle', arrow: 'arrow', oval: 'oval' };
const pt = (px) => +(px * 0.75).toFixed(2);
function runsToPptx(list, op) {
  const out = [];
  list.forEach((r) => {
    if (r.br) { if (out.length) out[out.length - 1].options.breakLine = true; else out.push({ text: '', options: { breakLine: true } }); return; }
    const o = { ...r.o };
    if (o.transparency == null && op < 0.99) o.transparency = Math.round((1 - op) * 100);
    Object.keys(o).forEach((x) => o[x] === undefined && delete o[x]);
    out.push({ text: r.text, options: o });
  });
  return out;
}
function addObj(slide, it, pos, tr) {
  if (it.t === 'line') {
    const ln = { color: it.c.hex, width: pt(it.lw), transparency: tr(it.c.a), dashType: DASH[it.dash], beginArrowType: HEAD[it.hs], endArrowType: HEAD[it.he] };
    Object.keys(ln).forEach((x) => ln[x] === undefined && delete ln[x]);
    const p = { x: it.x * PX, y: it.y * PX, w: Math.max(it.w, 0) * PX, h: Math.max(it.h, 0) * PX };
    if (it.kind === 'elbow') {   // カギ線:横 → 縦 → 横 の折れ線(自由図形)
      const fh = it.flipH, fv = it.flipV, a = [fh ? it.w : 0, fv ? it.h : 0], b = [fh ? 0 : it.w, fv ? 0 : it.h], mx = (a[0] + b[0]) / 2;
      const pts = [a, [mx, a[1]], [mx, b[1]], b].map((q, i) => ({ x: q[0] * PX, y: q[1] * PX, ...(i === 0 ? { moveTo: true } : {}) }));
      slide.addShape('custGeom', { ...p, points: pts, line: ln, fill: { type: 'none' } });
    } else slide.addShape('line', { ...p, flipH: it.flipH || undefined, flipV: it.flipV || undefined, line: ln });
    return;
  }
  const o = { ...pos, rotate: it.rot || undefined, flipH: it.flipH || undefined, flipV: it.flipV || undefined,
    fill: it.fill ? { color: it.fill.hex, transparency: tr(it.fill.a) } : { type: 'none' },
    line: it.line ? { color: it.line.c.hex, width: pt(it.line.w), transparency: tr(it.line.c.a), dashType: DASH[it.dash] } : { type: 'none' },
    shadow: it.shadow ? SHADOW : undefined };
  Object.keys(o).forEach((x) => o[x] === undefined && delete o[x]);
  if (o.line.dashType === undefined) delete o.line.dashType;
  if (it.text) {
    const t = it.text;
    slide.addText(runsToPptx(t.runs, it.op), { ...o, shape: it.type, margin: t.pad.map(pt), align: t.align, valign: t.valign, lineSpacing: t.lineSpacing || undefined, wrap: true, fit: 'none' });
  } else slide.addShape(it.type, o);
}
function addTable(slide, it, tr) {
  const rows = it.rows.map((row) => row.map((c) => {
    const o = { fill: c.fill ? { color: c.fill.hex, transparency: tr(c.fill.a) } : undefined, align: c.align, valign: 'middle', colspan: c.colspan,
      margin: c.pad.map((v) => v * PX), border: c.border ? [0, 1, 2, 3].map(() => ({ type: 'solid', pt: pt(c.border.w), color: c.border.c.hex })) : undefined };
    if (c.base) Object.assign(o, { fontFace: c.base.fontFace, fontSize: c.base.fontSize, color: c.base.color, bold: c.base.bold });
    Object.keys(o).forEach((x) => o[x] === undefined && delete o[x]);
    const runs = runsToPptx(c.runs, it.op);
    return { text: runs.length ? runs : '', options: o };
  }));
  slide.addTable(rows, { x: it.x * PX, y: it.y * PX, w: it.w * PX, colW: it.colW.map((v) => v * PX), rowH: it.rowH.map((v) => v * PX) });
}

/* ---- PPTX を組み立てる ---- */
const server = await serveForDeck(deckDir);
const browser = await chromium.launch();
let exitCode = 0;
try {
  const pageErrors = [], bad = [];
  const { context, page } = await openDeck(browser, server.origin, deckDir, {
    root: server.root,
    onPageError: (e) => pageErrors.push(String(e)),
    onBadResponse: (res) => bad.push(`${res.status()} ${res.url()}`),
  });
  await page.addStyleTag({ content: '.pp-dock{display:none!important}' });
  const meta = await page.evaluate(() => {
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
    return window.Reveal.getSlides().map((el) => ({ ...window.Reveal.getIndices(el), notes: Array.from(el.querySelectorAll('aside.notes')).map(notesText).filter(Boolean).join('\n\n') }));
  });
  const title = await page.title();
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
  pptx.layout = 'WIDE';
  pptx.title = title;

  const stats = { text: 0, rect: 0, img: 0, shot: 0, shape: 0, table: 0 }, warns = [];
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    await page.evaluate(({ h, v }) => { window.Reveal.slide(h, v); while (window.Reveal.nextFragment()) { /* 全部出す */ } }, m);
    await page.waitForTimeout(400);
    const { bg, items, warn } = await page.evaluate(extractSlide, FONT_MAP);
    warns.push(...warn.map((w) => `${i + 1} 枚目: ${w}`));
    const slide = pptx.addSlide();
    if (bg && bg.data) slide.background = { data: bg.data.replace(/^data:/, '') };
    else if (bg && bg.color) slide.background = { color: bg.color };
    for (const it of items) {
      const pos = { x: it.x * PX, y: it.y * PX, w: Math.max(it.w, 0.5) * PX, h: Math.max(it.h, 0.5) * PX };
      const tr = (a) => { const t = Math.round((1 - a * (it.op ?? 1)) * 100); return t > 0 ? t : undefined; };
      if (it.t === 'rect') {
        const shape = it.round ? pptx.ShapeType.ellipse : it.radius > 0.5 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
        slide.addShape(shape, { ...pos,
          fill: it.fill ? { color: it.fill.hex, transparency: tr(it.fill.a) } : { type: 'none' },
          line: it.line ? { color: it.line.c.hex, width: +(it.line.w * 0.75).toFixed(2), transparency: tr(it.line.c.a) } : { type: 'none' },
          rectRadius: shape === pptx.ShapeType.roundRect ? Math.min(it.radius, Math.min(it.w, it.h) / 2) * PX : undefined });
        stats.rect++;
      } else if (it.t === 'shape' || it.t === 'line') {
        addObj(slide, it, pos, tr);
        stats.shape++;
      } else if (it.t === 'table') {
        addTable(slide, it, tr);
        stats.table++;
      } else if (it.t === 'img') {
        const o = { ...pos, data: it.data.replace(/^data:/, '') };
        if (it.rot) o.rotate = it.rot;
        if (it.flipH) o.flipH = true;
        if (it.flipV) o.flipV = true;
        if (it.shadow) o.shadow = SHADOW;
        if (it.fit === 'contain' || it.fit === 'cover') {
          const dims = await page.evaluate(async (src) => { const im = new Image(); im.src = src; await im.decode(); return { w: im.naturalWidth, h: im.naturalHeight }; }, it.data);
          const s = it.fit === 'contain' ? Math.min(it.w / dims.w, it.h / dims.h) : Math.max(it.w / dims.w, it.h / dims.h);
          const w = dims.w * s, h = dims.h * s;
          // 背景の位置(左・中央・右)は大まかに合わせる
          const px = /^0%|left/.test(it.bgPos || '') ? 0 : /100%|right/.test(it.bgPos || '') ? 1 : 0.5;
          const py = /\s0%|top/.test(it.bgPos || '') ? 0 : /\s100%|bottom/.test(it.bgPos || '') ? 1 : 0.5;
          if (it.fit === 'contain') Object.assign(o, { x: (it.x + (it.w - w) * px) * PX, y: (it.y + (it.h - h) * py) * PX, w: w * PX, h: h * PX });
          else o.sizing = { type: 'cover', w: pos.w, h: pos.h };
        }
        if (it.op < 0.99) o.transparency = Math.round((1 - it.op) * 100);
        slide.addImage(o);
        stats.img++;
      } else if (it.t === 'shot') {
        const png = await page.screenshot({ clip: { x: it.x, y: it.y, width: it.w, height: it.h } });
        slide.addImage({ ...pos, data: 'image/png;base64,' + png.toString('base64') });
        stats.shot++;
      } else if (it.t === 'text') {
        const runs = [];
        it.runs.forEach((r, j) => {
          if (r.br) { if (runs.length) runs[runs.length - 1].options.breakLine = true; else runs.push({ text: '', options: { breakLine: true } }); return; }
          const o = { ...r.o };
          if (o.transparency == null && it.op < 0.99) o.transparency = Math.round((1 - it.op) * 100);
          Object.keys(o).forEach((x) => o[x] === undefined && delete o[x]);
          runs.push({ text: r.text, options: o });
        });
        if (!runs.length) continue;
        const allow = it.oneLine ? 0.06 : 0.025;   // PowerPoint は字幅がわずかに広いことがあるので、少しだけ広げる
        slide.addText(runs, { x: pos.x, y: pos.y, w: pos.w * (1 + allow), h: pos.h, margin: 0, align: it.align, valign: it.valign,
          lineSpacing: it.lineSpacing || undefined, wrap: !it.oneLine, fit: 'none', bullet: it.bullet === 'num' ? { type: 'number' } : it.bullet ? true : undefined });
        stats.text++;
      }
    }
    if (m.notes) slide.addNotes(m.notes);
    console.log(`  [${i + 1}/${meta.length}] 部品 ${items.length}`);
  }
  await context.close();

  const outDir = await ensureOutDir(deckDir);
  const outPath = path.join(outDir, OUT_NAME + '.pptx');
  await pptx.writeFile({ fileName: outPath });

  // 日本語の書体(ea)を指定する。pptxgenjs は latin と同じ書体を入れるため
  const zip = await JSZip.loadAsync(await fs.readFile(outPath));
  const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  for (const f of slideFiles) {
    let x = await zip.file(f).async('string');
    x = x.replace(/<a:ea typeface="[^"]*"( pitchFamily="\d+")?( charset="-?\d+")?\/>/g, `<a:ea typeface="${EA_FONT}"/>`);
    zip.file(f, x);
  }
  await fs.writeFile(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

  const problems = [];
  if (slideFiles.length !== meta.length) problems.push(`スライド XML 数が不一致: 期待 ${meta.length} / 実際 ${slideFiles.length}`);
  if (pageErrors.length) problems.push(`ページエラー: ${pageErrors.join(' / ')}`);
  if (bad.length) problems.push(`リソース読み込み失敗 ${bad.length} 件: ${bad.slice(0, 5).join(' / ')}`);
  const stat = await fs.stat(outPath);
  const report = { deck: path.relative(REPO_ROOT, deckDir), title, file: path.relative(REPO_ROOT, outPath), slides: meta.length, parts: stats, eaFont: EA_FONT,
    sizeBytes: stat.size, warnings: warns, problems, generatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(outDir, 'pptx-editable-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('');
  console.log(`PPTX(直せる形)出力: ${outPath}`);
  console.log(`  スライド ${meta.length} 枚 / 文字 ${stats.text}・四角形 ${stats.rect}・図形と線 ${stats.shape}・表 ${stats.table}・画像 ${stats.img}・切り出し ${stats.shot} / ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  if (warns.length) console.warn('  警告: ' + warns.slice(0, 5).join(' / ') + (warns.length > 5 ? ` ほか ${warns.length - 5} 件` : ''));
  if (problems.length) { console.error('検証 NG:'); problems.forEach((p) => console.error('  - ' + p)); exitCode = 1; }
  else console.log('検証 OK: スライド XML 数一致');
} catch (err) {
  console.error('error: PPTX(直せる形)の出力に失敗しました:', err.stack || err);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
process.exit(exitCode);
