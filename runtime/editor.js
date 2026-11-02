/* ============================================================================
   webdeck — editor
   ----------------------------------------------------------------------------
   ドックの「編集」ボタン(E キー)か、URL に ?edit を付けると起動する。
   shell.js が必要になった時だけ読み込む(単一 HTML の配布物には入らない)。

   段階 1(文字の編集):
   - スライドの文字を直接編集(文字を持つ要素だけを編集可能にし、枠組みは壊さない)
   - 太字・斜体・下線・取り消し線・上付き・下付き、文字の拡大・縮小、文字色・蛍光ペン
     (色はテーマのパレット --pp-ed-c1〜c6 だけ)、書式のクリア
   - 箇条書き・段落番号、インデント、行間、左・中央・右・両端揃え
   - 切り取り・コピー・貼り付け(書式なし)・書式のコピー
   段階 2(スライドの操作):
   - 左のスライド一覧(縮小表示。クリックで移動、ドラッグで並べ替え、セクションの見出し)
   - 下のノート(aside.notes を直接編集)。一覧の幅とノートの高さは境目をドラッグで変える(ブラウザが覚える)
   - 新しいスライド(<template data-pp-layout="名前"> の型、または白紙)・複製・削除・リセット・上下へ移動
   - セクション(ページ単位のデッキの「@toc 部|名前」)の追加・名前の変更・削除
   段階 3(部品の配置):
   - スライド上の部品(カード・帯・画像・文字の枠など)をクリックで選び、ドラッグで移動、ハンドルでサイズ変更
     もう一度クリックすると内側の部品を選ぶ。矢印キーで 1px(Shift で 10px)、Delete で削除
     保存はその要素のインライン style(translate / width / height)。レイアウトの流れは変えない
   挿入(段階 4):
   - 図形(PowerPoint の prstGeom 名。輪郭は大きさに合わせた SVG)・線 / 矢印 / カギ線・テキストボックス・画像・表・リンク
   - 図形の書式(塗り・枠線・破線・矢印・影・透明度・グラデーション・文字の色・上下の配置・図形の変更)
   - 重なり順・グループ・回転(ハンドル)・反転・位置とサイズ・複製 / 部品のコピー・貼り付け。表の行・列の挿入と削除
   名前(ファイル › 名前):
   - 資料のタイトル・配るときのファイル名・冊の名前・ページのファイル名を直す。ページ単位のデッキでは保存時に
     pages/ のファイル名と、そのページを使う全部の冊の並び(decks/*.json)を書き換える
   共通:
   - 元に戻す・やり直し(Ctrl/⌘+Z、Ctrl/⌘+Shift+Z / Y)。文字の編集とスライドの操作を操作順に戻す
   - 保存(Ctrl/⌘+S)。File System Access API(Chrome / Edge)。初回だけ保存先を選ぶ
       ページ単位のデッキ(<section data-page="キー"> と <script id="pp-deck"> の冊の並び)
         → 選んだフォルダ(pages/ と decks/ を含むフォルダ)の pages/<キー>.html と decks/<冊>.json
       それ以外 → 選んだ index.html。文字だけの変更は該当 <section> だけ、スライドの操作があればスライド全体を書き換える

   前提: classic script(ESM 不使用)。サーバー不要(file:// で動く)。
   ============================================================================ */

(function (global) {
  'use strict';

  var INLINE = /^(B|STRONG|I|EM|U|S|STRIKE|SUB|SUP|SPAN|A|BR|MARK|SMALL|CODE|WBR|FONT)$/;
  var SKIP = /^(ASIDE|SVG|IMG|SCRIPT|STYLE|VIDEO|CANVAS|IFRAME|TABLE|THEAD|TBODY|TR|UL|OL|COLGROUP|COL)$/;
  var REVEAL_CLASSES = ['present', 'past', 'future', 'visible', 'current-fragment', 'stack'];
  var REVEAL_ATTRS = ['data-fragment-index', 'aria-hidden', 'hidden', 'data-index-h', 'data-index-v', 'data-previous-indexv', 'tabindex'];
  var MAX_UNDO = 200;
  var BLANK = '<section><h2>タイトル</h2><p>本文</p></section>';

  var deck = null;
  var bar = null, side = null, notes = null, notesBody = null, splitV = null, splitH = null;
  var notesOf = null;          // ノート欄に今出しているスライド
  var rows = new Map();        // section → 一覧の行 {row, html, cls}
  var thumbTimer = null;
  var LAYOUT_KEY = 'pp-editor-layout';
  var lay = { side: 236, notes: 150, showNotes: true, autosave: true };
  var active = false;
  var lastRange = null;
  var painter = null;          // 書式のコピーで覚えた書式
  var dirty = new Set();       // 中身を変えたスライド
  var structDirty = false;     // スライドの増減・並び・セクションを変えたか
  var stacks = new Map();      // section → [html, ...](文字の編集の履歴)
  var log = [], redoLog = [];  // 操作の順(文字：{t:'text', s}、スライド：{t:'struct', undo, redo})
  var saved = new Map();       // section → 最後に保存した(または開いた)時の HTML(リセット用)
  var model = null;            // ページ単位のデッキの並び：[{t:'page', key, s} | {t:'toc', s} | {t:'mark', part, label}]
  var deckInfo = null;         // 冊の情報(pp-deck の JSON)
  var deckName = null;
  var newKeys = new Set();     // このセッションで作ったページのキー
  var origKey = new Map();     // section → 保存済みのファイル名(キー)。名前を変えたら保存時に付け替える
  var names = null;            // { title, dist, origTitle, origDist, deckOrig }
  var single = !!document.querySelector('meta[name="pp-single"]');   // 編集用の 1 ファイル(bundle.mjs --editable)
  var snapTimer = null;
  var writer = null;           // テスト用に差し替えられる書き込み関数

  /* ------------------------------------------------------------ 小物 */

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function slides() { return deck.getSlides(); }
  function current() { return deck.getCurrentSlide(); }
  function slidesEl() { return deck.getSlidesElement(); }
  function hostOf(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    return node && node.closest ? node.closest('[data-pp-ed]') : null;
  }
  function sectionOf(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    var s = node && node.closest ? node.closest('.reveal .slides section') : null;
    return s && !s.closest('.pp-th') ? s : null;   // 一覧の縮小表示は対象外
  }
  function isAuto(s) { var k = s && s.getAttribute('data-page'); return !!k && k.charAt(0) === '('; }
  function toast(msg, kind) {
    var t = document.querySelector('.pp-ed-toast');
    if (!t) { t = el('<div class="pp-ed-toast"></div>'); document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'pp-ed-toast pp-show ' + (kind ? 'pp-' + kind : '');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.className = 'pp-ed-toast'; }, kind === 'err' ? 8000 : 4000);
  }
  function titleOf(s) {
    var h = s.querySelector('h1, h2, h3');
    var t = (h ? h.textContent : s.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 60) || '(無題)';
  }

  /* ------------------------------------------------ 編集できる要素の印 */

  function inlineOnly(e) {
    for (var c = e.firstElementChild; c; c = c.nextElementSibling) {
      if (!INLINE.test(c.tagName) || !inlineOnly(c)) return false;
    }
    return true;
  }
  function hasText(e) { return /\S/.test(e.textContent || ''); }
  function setEd(e) { e.setAttribute('contenteditable', 'true'); e.setAttribute('data-pp-ed', '1'); e.setAttribute('spellcheck', 'false'); }

  function markSection(section) {
    if (isAuto(section)) return;   // 自動で作るページ(目次)は直さない
    (function walk(e) {
      for (var c = e.firstElementChild; c; c = c.nextElementSibling) {
        if (c.matches('aside.notes')) continue;
        if (c.namespaceURI === 'http://www.w3.org/2000/svg') continue;
        // 挿入した図形の文字・表のセルは、空でも打てるようにする
        if (c.classList.contains('pp-sh-t') || /^(TD|TH)$/.test(c.tagName) && c.closest('table.pp-tbl')) { setEd(c); continue; }
        if (!SKIP.test(c.tagName) && !INLINE.test(c.tagName) && hasText(c) && inlineOnly(c)) setEd(c);
        else walk(c);
      }
    })(section);
  }
  function unmark(root) {
    (root || document).querySelectorAll('[data-pp-ed]').forEach(function (e) {
      e.removeAttribute('contenteditable'); e.removeAttribute('data-pp-ed'); e.removeAttribute('spellcheck');
    });
  }

  /* ------------------------------------------------------- 元に戻す */

  function dropEmptyStyle(root) {   // 表示の都合で付く空の style="" は変更として数えない・保存しない
    root.querySelectorAll('[style=""]').forEach(function (e) { e.removeAttribute('style'); });
  }
  function stackOf(s) {
    if (!stacks.has(s)) stacks.set(s, { past: [s.innerHTML], future: [] });
    return stacks.get(s);
  }
  function snapshot(s) {
    s = s || current();
    dropEmptyStyle(s);
    var st = stackOf(s), html = s.innerHTML;
    if (st.past[st.past.length - 1] === html) return;
    st.past.push(html);
    if (st.past.length > MAX_UNDO) st.past.shift();
    st.future = [];
    pushLog({ t: 'text', s: s });
  }
  function pushLog(op) {
    log.push(op);
    if (log.length > MAX_UNDO) log.shift();
    redoLog = [];
  }
  function scheduleSnapshot(s) {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(function () { snapshot(s); }, 400);
  }
  function setHtml(s, html) {
    s.innerHTML = html;
    markSection(s);
    dirty.add(s);
  }
  function goTo(s) { var i = slides().indexOf(s); if (i >= 0 && current() !== s) deck.slide(i); }
  function doUndo() {
    clearTimeout(snapTimer); if (active) snapshot(current());
    clearSel();
    var op = log.pop();
    if (!op) return;
    if (op.t === 'text') {
      var st = stackOf(op.s);
      if (st.past.length < 2) return;
      st.future.push(st.past.pop());
      if (!document.contains(op.s)) return;
      goTo(op.s); setHtml(op.s, st.past[st.past.length - 1]);
    } else op.undo();
    redoLog.push(op);
    notesOf = null;
    refresh();
  }
  function doRedo() {
    clearSel();
    var op = redoLog.pop();
    if (!op) return;
    if (op.t === 'text') {
      var st = stackOf(op.s);
      if (!st.future.length) return;
      var html = st.future.pop();
      st.past.push(html);
      goTo(op.s); setHtml(op.s, html);
    } else op.redo();
    log.push(op);
    notesOf = null;
    refresh();
  }

  /* ------------------------------------------------------- 選択範囲 */

  function rememberSelection() {
    var sel = global.getSelection();
    if (!sel.rangeCount) return;
    var r = sel.getRangeAt(0);
    if (hostOf(r.commonAncestorContainer)) { lastRange = r.cloneRange(); var c = cellAt(r.startContainer); if (c) lastCell = c; }
    if (bar) updateCtxTabs();
  }
  function range() {
    var sel = global.getSelection();
    if (sel.rangeCount && hostOf(sel.getRangeAt(0).commonAncestorContainer)) return sel.getRangeAt(0);
    if (lastRange && document.contains(lastRange.startContainer) && sectionOf(lastRange.startContainer) === current()) {
      sel.removeAllRanges(); sel.addRange(lastRange);
      return lastRange;
    }
    return null;
  }
  function before(fn) {
    return function () {
      var r = range();
      if (!r) { toast('先に、直したい文字を選んでください'); return; }
      var s = sectionOf(r.commonAncestorContainer);
      var host = hostOf(r.commonAncestorContainer);
      clearTimeout(snapTimer); snapshot(s);
      fn(r, host, s);
      tidy(host);
      snapshot(s);
      dirty.add(s);
      refresh();
    };
  }
  function tidy(host) {
    if (!host || !document.contains(host)) return;
    host.querySelectorAll('strike').forEach(function (e) { var x = document.createElement('s'); x.innerHTML = e.innerHTML; e.replaceWith(x); });
    host.querySelectorAll('span:not([class]):not([style])').forEach(function (e) { e.replaceWith.apply(e, Array.from(e.childNodes)); });
    host.querySelectorAll('font').forEach(function (e) { e.replaceWith.apply(e, Array.from(e.childNodes)); });
    host.normalize();
  }
  function wrap(r, make) {
    if (r.collapsed) return null;
    var frag = r.extractContents();
    var w = make();
    w.appendChild(frag);
    r.insertNode(w);
    var sel = global.getSelection(); sel.removeAllRanges();
    var nr = document.createRange(); nr.selectNodeContents(w); sel.addRange(nr); lastRange = nr.cloneRange();
    return w;
  }
  function exec(cmd, val) { return before(function () { document.execCommand('styleWithCSS', false, false); document.execCommand(cmd, false, val); }); }

  /* -------------------------------------------------------------- 書式 */

  function colorCmd(n) {
    return before(function (r) {
      var w = wrap(r, function () { var s = document.createElement('span'); if (n) s.className = 'pp-c' + n; return s; });
      if (w) w.querySelectorAll('[class^="pp-c"]').forEach(function (e) { e.replaceWith.apply(e, Array.from(e.childNodes)); });
    });
  }
  var highlight = before(function (r) { wrap(r, function () { var s = document.createElement('span'); s.className = 'pp-hl'; return s; }); });
  function sizeCmd(delta) {
    var onText = before(function (r) {
      var base = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      var px = parseFloat(getComputedStyle(base).fontSize) || 20;
      var next = Math.max(12, Math.min(96, Math.round(px + delta)));
      wrap(r, function () { var s = document.createElement('span'); s.style.fontSize = next + 'px'; return s; });
    });
    return function () {
      var sl = global.getSelection();
      var hasText = sl.rangeCount && !sl.isCollapsed && hostOf(sl.getRangeAt(0).commonAncestorContainer);
      if (hasText || !sels.length) return onText();
      sizeParts(delta)();   // 部品を選んでいるとき：その中の文字を全部、同じ割合で大きく / 小さく
    };
  }
  function sizeParts(delta) {
    return selOp(function (list) {
      list.forEach(function (part) {
        var base = parseFloat(getComputedStyle(part).fontSize) || 20;
        var f = Math.max(12, base + delta) / base;
        // 自分の大きさを持つ要素(親と大きさが違うもの)だけに書く。ほかは親から受け継ぐ
        var all = [part].concat(Array.from(part.querySelectorAll('*')).filter(function (e) { return e.namespaceURI !== SVG_NS && !e.closest('aside.notes'); }));
        var plan = all.map(function (e) {
          var px = parseFloat(getComputedStyle(e).fontSize);
          var own = e === part || Math.abs(px - parseFloat(getComputedStyle(e.parentElement).fontSize)) > 0.01;
          return own ? { e: e, px: px } : null;
        }).filter(Boolean);
        plan.forEach(function (x) { x.e.style.fontSize = Math.max(10, Math.round(x.px * f * 10) / 10) + 'px'; });
      });
    });
  }
  var clearFmt = before(function (r) {
    var t = document.createTextNode(r.toString());
    r.deleteContents(); r.insertNode(t);
  });
  function blockStyle(prop, val) { return before(function (r, host) { host.style[prop] = val; }); }
  function indent(step) {
    return before(function (r, host) {
      var next = Math.max(0, (parseFloat(host.style.marginLeft) || 0) + step);
      host.style.marginLeft = next ? next + 'px' : '';
    });
  }
  function listCmd(ordered) {
    return before(function (r, host, s) {
      if (host.tagName === 'LI') {           // 箇条書きを解除：行を <br> でつないだ 1 つの段落に
        var list = host.parentElement;
        var div = document.createElement('div');
        div.className = 'pp-para';
        div.innerHTML = Array.from(list.children).map(function (li) { return li.innerHTML; }).join('<br>');
        list.replaceWith(div);
      } else {                                // 行（<br> 区切り）ごとに項目にする
        var lines = host.innerHTML.split(/<br\s*\/?>/i).filter(function (x) { return /\S/.test(x.replace(/<[^>]+>/g, '')); });
        var lst = document.createElement(ordered ? 'ol' : 'ul');
        lst.className = ordered ? 'pp-olist' : 'blist';
        lst.innerHTML = lines.map(function (x) { return '<li>' + x.trim() + '</li>'; }).join('');
        host.innerHTML = '';
        host.appendChild(lst);
      }
      unmark(s); markSection(s);
    });
  }

  /* 書式のコピー：選んだ文字の書式（太字・斜体・下線・取り消し線・色・蛍光ペン・大きさ）を覚え、次に選んだ文字に付ける */
  function readFormat(node) {
    var f = { tags: [], cls: null, hl: false, size: null };
    for (var e = node.nodeType === 1 ? node : node.parentElement; e && !e.hasAttribute('data-pp-ed'); e = e.parentElement) {
      if (/^(B|STRONG|I|EM|U|S|SUB|SUP)$/.test(e.tagName)) f.tags.push(e.tagName === 'STRONG' ? 'B' : e.tagName === 'EM' ? 'I' : e.tagName);
      if (e.className && /^pp-c\d/.test(e.className) && !f.cls) f.cls = e.className;
      if (e.classList && e.classList.contains('pp-hl')) f.hl = true;
      if (e.style && e.style.fontSize && !f.size) f.size = e.style.fontSize;
    }
    return f;
  }
  function applyFormat(r, f) {
    var w = wrap(r, function () { return document.createElement('span'); });
    if (!w) return;
    if (f.cls) w.className = f.cls;
    if (f.size) w.style.fontSize = f.size;
    var inner = w;
    if (f.hl) { var h = document.createElement('span'); h.className = 'pp-hl'; while (inner.firstChild) h.appendChild(inner.firstChild); inner.appendChild(h); inner = h; }
    f.tags.forEach(function (t) { var x = document.createElement(t.toLowerCase()); while (inner.firstChild) x.appendChild(inner.firstChild); inner.appendChild(x); inner = x; });
  }
  function startPainter() {
    var r = range();
    if (!r) { toast('先に、書式をコピーしたい文字を選んでください'); return; }
    painter = readFormat(r.startContainer);
    bar.classList.add('pp-painting');
    toast('書式をコピーしました。付けたい文字を選んでください');
  }
  function onMouseUp() {
    if (!painter) return;
    setTimeout(function () {
      var sel = global.getSelection();
      if (!sel.rangeCount || sel.isCollapsed || !hostOf(sel.anchorNode)) return;
      var f = painter; painter = null; bar.classList.remove('pp-painting');
      before(function (r) { applyFormat(r, f); })();
    }, 0);
  }

  /* -------------------------------------------------- クリップボード */

  function clip(cmd) {
    return function () {
      var r = range();
      if (!r) return;
      if (cmd === 'cut') { var s = sectionOf(r.commonAncestorContainer); snapshot(s); document.execCommand('cut'); snapshot(s); dirty.add(s); refresh(); }
      else document.execCommand('copy');
    };
  }
  function pasteBtn() {
    if (!range()) { toast('先に、貼り付ける場所をクリックしてください'); return; }
    if (!navigator.clipboard || !navigator.clipboard.readText) { toast('このブラウザでは ⌘V / Ctrl+V で貼り付けてください'); return; }
    navigator.clipboard.readText().then(function (t) {
      var rr = range(); if (!rr) return;
      var s = sectionOf(rr.commonAncestorContainer); snapshot(s);
      rr.deleteContents(); rr.insertNode(document.createTextNode(t)); rr.collapse(false);
      snapshot(s); dirty.add(s); refresh();
    }).catch(function () { toast('クリップボードを読めませんでした。⌘V / Ctrl+V で貼り付けてください', 'err'); });
  }
  function onPaste(e) {
    if (!hostOf(e.target) && !(notesBody && notesBody.contains(e.target))) {
      if (active && !typingNow() && !(e.target.closest && e.target.closest(CHROME))) pasteOutside(e);
      return;
    }
    e.preventDefault();          // ほかの資料の書式を持ち込まない
    var t = (e.clipboardData || global.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  }

  /* ------------------------------------------- ページ単位のデッキの並び */

  function loadModel() {
    model = null; deckInfo = null;
    var j = document.getElementById('pp-deck');
    var m = document.querySelector('meta[name="pp-deck"]');
    if (!j || !m) return;
    try { deckInfo = JSON.parse(j.textContent); } catch (e) { return; }
    deckName = m.content;
    var secs = slides(), i = 0, out = [];
    deckInfo.pages.forEach(function (it) {
      if (it.indexOf('@toc ') === 0) {
        var x = it.slice(5).split('|');
        out.push({ t: 'mark', part: x[0], label: x.slice(1).join('|') });
      } else if (it === '@toc-page') out.push({ t: 'toc', s: secs[i++] });
      else out.push({ t: 'page', key: it, s: secs[i++] });
    });
    if (i !== secs.length || out.some(function (x) { return x.t === 'page' && x.s && x.s.getAttribute('data-page') !== x.key; })) {
      console.warn('PPEditor: 冊の並びとスライドが一致しないため、ページ単位の保存は使わない');
      deckInfo = null; return;
    }
    model = out;
  }
  function modelPages() {
    return model.map(function (x) { return x.t === 'mark' ? '@toc ' + x.part + '|' + x.label : x.t === 'toc' ? '@toc-page' : x.key; });
  }
  function entryOf(s) { for (var i = 0; i < model.length; i++) if (model[i].s === s) return i; return -1; }
  function markBefore(s) {   // s が属するセクション（直前の区切り）
    if (!model) return -1;
    for (var i = entryOf(s); i >= 0; i--) if (model[i].t === 'mark') return i;
    return -1;
  }
  function newKey(base) {
    var used = new Set(model ? model.filter(function (x) { return x.key; }).map(function (x) { return x.key; }) : []);
    newKeys.forEach(function (k) { used.add(k); });
    var d = new Date(), stamp = '' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    for (var n = 1; ; n++) { var k = base + '-' + stamp + '-' + n; if (!used.has(k)) return k; }
  }
  function prefixOf(s) {
    var k = s && s.getAttribute('data-page');
    var m = k && /^([a-z]+)\./.exec(k);
    if (m && m[1] !== 'x') return m[1];
    return deckName === 'customer' ? 'c' : 'sa';
  }

  /* ------------------------------------------------------ スライドの操作 */

  function afterStruct() {
    structVer++;
    deck.sync();
    structDirty = true;
    refresh();
  }
  /* 位置 idx（スライドの通し番号。0 始まり）に section を入れる。
     model では、mi があればその位置、なければ直前のスライドの後ろ（同じセクションに入る。区切りは動かさない） */
  function insertAt(s, idx, entry, mi) {
    var list = slides();
    if (idx >= list.length) slidesEl().appendChild(s); else slidesEl().insertBefore(s, list[idx]);
    if (model) {
      var at = mi != null ? mi : idx > 0 ? entryOf(list[idx - 1]) + 1 : (list.length ? entryOf(list[0]) : model.length);
      model.splice(at, 0, entry || { t: 'page', key: s.getAttribute('data-page'), s: s });
    }
  }
  function removeSlide(s) {
    var info = { idx: slides().indexOf(s), entry: null, mi: null };
    if (model) { var i = entryOf(s); info.entry = model[i]; info.mi = i; model.splice(i, 1); }
    s.remove();
    return info;
  }
  function addSlide(s, key) {
    var cur = current(), idx = slides().indexOf(cur) + 1;
    if (model) { s.setAttribute('data-page', key); newKeys.add(key); }
    insertAt(s, idx);
    markSection(s);
    stackOf(s);
    saved.set(s, null);
    dirty.add(s);
    var mi = model ? entryOf(s) : null, entry = model ? model[mi] : null;
    pushLog({
      t: 'struct',
      undo: function () { removeSlide(s); dirty.delete(s); afterStruct(); deck.slide(Math.max(0, idx - 1)); },
      redo: function () { insertAt(s, idx, entry, mi); dirty.add(s); afterStruct(); deck.slide(idx); },
    });
    afterStruct();
    deck.slide(idx);
  }
  function newFromLayout(html) {
    var s = el(html);
    if (!s || s.tagName !== 'SECTION') { toast('レイアウトの形が正しくありません', 'err'); return; }
    addSlide(s, model ? newKey(prefixOf(current()) + '.new') : null);
    toast('新しいスライドを追加しました');
  }
  function duplicate() {
    var cur = current();
    if (isAuto(cur)) { toast('自動で作るページ（目次）は複製できません'); return; }
    var c = el(unsubst(serialize(cur).html));
    var base = cur.getAttribute('data-page');
    addSlide(c, model ? newKey((base || 'x.page').replace(/-\d{8}-\d+$/, '') + '-copy') : null);
    toast('複製しました');
  }
  function deleteSlide() {
    var cur = current();
    if (slides().length <= 1) { toast('最後の 1 枚は削除できません'); return; }
    if (isAuto(cur) && !global.confirm('目次（自動）を削除しますか？')) return;
    var info = removeSlide(cur);
    var wasDirty = dirty.delete(cur);
    pushLog({
      t: 'struct',
      undo: function () { insertAt(cur, info.idx, info.entry, info.mi); if (wasDirty) dirty.add(cur); afterStruct(); deck.slide(info.idx); },
      redo: function () { removeSlide(cur); dirty.delete(cur); afterStruct(); deck.slide(Math.min(info.idx, slides().length - 1)); },
    });
    afterStruct();
    deck.slide(Math.min(info.idx, slides().length - 1));
    toast(model ? 'この冊から外しました（ページのファイルは残ります。ほかの冊で使っている場合があるため）' : '削除しました');
  }
  function moveTo(s, idx) {
    var from = slides().indexOf(s);
    if (idx === from || idx < 0 || idx >= slides().length) return;
    var info = removeSlide(s);
    insertAt(s, idx, info.entry);
    var mi = model ? entryOf(s) : null;   // 移した後の位置（やり直しで同じ位置に戻す）
    pushLog({
      t: 'struct',
      undo: function () { var i2 = removeSlide(s); insertAt(s, from, i2.entry, info.mi); afterStruct(); deck.slide(from); },
      redo: function () { var i2 = removeSlide(s); insertAt(s, idx, i2.entry, mi); afterStruct(); deck.slide(idx); },
    });
    afterStruct();
    deck.slide(idx);
  }
  function move(step) { var s = current(); moveTo(s, slides().indexOf(s) + step); }
  function resetSlide() {
    var s = current();
    var html = saved.get(s);
    if (!html) { toast('このスライドは今回追加したもので、戻す元がありません'); return; }
    if (!global.confirm('このスライドを、最後に保存した状態（または開いた時の状態）に戻しますか？')) return;
    clearTimeout(snapTimer); snapshot(s);
    var src = el(unsubst(html));
    Array.from(s.attributes).forEach(function (a) { if (!/^(class|style|hidden|aria-hidden|data-index-[hv]|data-page|data-previous-indexv)$/.test(a.name)) s.removeAttribute(a.name); });
    Array.from(src.attributes).forEach(function (a) { if (a.name !== 'class') s.setAttribute(a.name, a.value); });
    setHtml(s, src.innerHTML);
    snapshot(s);
    dirty.delete(s);
    notesOf = null;
    refresh();
    toast('元に戻しました');
  }

  /* セクション（ページ単位のデッキの目次の区切り） */
  function addSection() {
    if (!model) { toast('セクションはページ単位のデッキで使えます（目次の区切り）'); return; }
    var s = current(), i = entryOf(s);
    if (i > 0 && model[i - 1].t === 'mark') { toast('このスライドから、すでにセクション「' + model[i - 1].label + '」が始まっています'); return; }
    var prev = markBefore(s);
    var part = prev >= 0 ? model[prev].part : '本編';
    var label = global.prompt('セクションの名前（目次に出ます）', '新しいセクション');
    if (!label) return;
    var m = { t: 'mark', part: part, label: label };
    model.splice(i, 0, m);
    pushLog({
      t: 'struct',
      undo: function () { model.splice(model.indexOf(m), 1); structDirty = true; refresh(); },
      redo: function () { model.splice(entryOf(s), 0, m); structDirty = true; refresh(); },
    });
    structDirty = true; refresh();
    toast('このスライドからセクション「' + label + '」が始まります。目次は保存後の組み立てで更新');
  }
  function renameSection() {
    var i = markBefore(current());
    if (i < 0) { toast('このスライドはセクションに入っていません'); return; }
    var m = model[i], old = m.label;
    var label = global.prompt('セクションの名前', old);
    if (!label || label === old) return;
    m.label = label;
    pushLog({ t: 'struct', undo: function () { m.label = old; structDirty = true; refresh(); }, redo: function () { m.label = label; structDirty = true; refresh(); } });
    structDirty = true; refresh();
  }
  function removeSection() {
    var i = markBefore(current());
    if (i < 0) { toast('このスライドはセクションに入っていません'); return; }
    var m = model[i];
    if (!global.confirm('セクション「' + m.label + '」の区切りを外しますか？（スライドは消えません）')) return;
    var after = model[i + 1];
    model.splice(i, 1);
    pushLog({
      t: 'struct',
      undo: function () { var j = after ? model.indexOf(after) : model.length; model.splice(j, 0, m); structDirty = true; refresh(); },
      redo: function () { model.splice(model.indexOf(m), 1); structDirty = true; refresh(); },
    });
    structDirty = true; refresh();
  }

  /* ------------------------------------------------------------ 名前 */

  var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  function initNames() {
    if (names) return;
    var t = deckInfo ? deckInfo.title || '' : document.title;
    var d = deckInfo ? deckInfo.dist || '' : '';
    names = { title: t, dist: d, origTitle: t, origDist: d, deckOrig: deckName };
    slides().forEach(function (s) { var k = s.getAttribute('data-page'); if (k && !isAuto(s) && !newKeys.has(k)) origKey.set(s, k); });
  }
  function renames() {   // [{from, to, ss:[section]}]
    var out = {};
    origKey.forEach(function (from, s) {
      var to = s.getAttribute('data-page');
      if (!document.contains(s) || !to || to === from) return;
      (out[from] = out[from] || { from: from, to: to, ss: [] }).ss.push(s);
    });
    return Object.keys(out).map(function (k) { return out[k]; });
  }
  function namesDirty() {
    return !!names && (names.title !== names.origTitle || names.dist !== names.origDist || deckName !== names.deckOrig || renames().length > 0);
  }
  function setKey(key, to) {   // 同じページ(同じキー)を使うスライドと並びを全部付け替える
    if (!model) return;
    model.forEach(function (x) { if (x.t === 'page' && x.key === key) { x.key = to; if (x.s) x.s.setAttribute('data-page', to); } });
    if (newKeys.has(key)) { newKeys.delete(key); newKeys.add(to); }
  }
  function nameState() { return { title: names.title, dist: names.dist, deck: deckName }; }
  function applyNameState(st) {
    names.title = st.title; names.dist = st.dist; deckName = st.deck;
    document.title = st.title || document.title;
  }
  function nameDialog(focus) {
    initNames();
    closePop();
    var cur = current(), key = cur && cur.getAttribute('data-page');
    var paged = !!model && !single, pageOk = !!model && key && !isAuto(cur);
    var dlg = el('<div class="pp-ed-dlg" role="dialog" aria-label="名前の変更"><form>' +
      '<h3>名前の変更</h3>' +
      '<label>資料のタイトル<input name="title" autocomplete="off"></label>' +
      (paged ? '<label>配るときのファイル名<span class="pp-row"><input name="dist" autocomplete="off"><span class="pp-ext">.html / .pdf</span></span><small>単一 HTML・PDF を書き出すときの名前</small></label>' +
               '<label>冊の名前<span class="pp-row"><span class="pp-ext">decks/</span><input name="deck" autocomplete="off"><span class="pp-ext">.json</span></span><small>出力のフォルダ名にもなります(英数字・. _ -)。古い出力のフォルダは残るので、要らなければ消してください</small></label>' : '') +
      (pageOk ? '<label>このページのファイル名<span class="pp-row"><span class="pp-ext">pages/</span><input name="key" autocomplete="off"><span class="pp-ext">.html</span></span><small>このページを使っている全部の冊の並びも書き換えます(英数字・. _ -)</small></label>' : '') +
      (single ? '<p class="pp-note">編集用の 1 ファイルでは、タイトルとページの名前を直せます(冊の名前・配る名前は正本で)</p>' : !paged ? '<p class="pp-note">このデッキは index.html 1 枚の作りのため、直せるのはタイトルだけです(ファイル名・フォルダ名はファインダーで変えてください)</p>' : '') +
      '<p class="pp-err" hidden></p><div class="pp-btns"><button type="button" data-a="cancel">キャンセル</button><button type="submit" class="pp-ok">変更</button></div></form></div>');
    var f = dlg.querySelector('form');
    f.title.value = names.title;
    if (paged) { f.dist.value = names.dist; f.deck.value = deckName; }
    if (pageOk) f.key.value = key;
    var close = function () { dlg.remove(); document.removeEventListener('keydown', esc, true); };
    var esc = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', esc, true);
    dlg.addEventListener('mousedown', function (e) { if (e.target === dlg) close(); });
    dlg.querySelector('[data-a=cancel]').addEventListener('click', close);
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = dlg.querySelector('.pp-err');
      var fail = function (m) { err.textContent = m; err.hidden = false; };
      var next = { title: f.title.value.trim(), dist: paged ? f.dist.value.trim() : names.dist, deck: paged ? f.deck.value.trim() : deckName };
      var nk = pageOk ? f.key.value.trim() : key;
      if (!next.title) return fail('タイトルを入れてください');
      if (paged && /[\\/:*?"<>|]/.test(next.dist)) return fail('配るときのファイル名に \\ / : * ? " < > | は使えません');
      if (paged && !NAME_RE.test(next.deck)) return fail('冊の名前は英数字と . _ - で付けてください');
      if (pageOk && !NAME_RE.test(nk)) return fail('ページのファイル名は英数字と . _ - で付けてください');
      if (pageOk && nk !== key && model.some(function (x) { return x.t === 'page' && x.key === nk; })) return fail('この冊に、同じ名前のページがすでにあります');
      var before = nameState(), changedKey = pageOk && nk !== key;
      if (before.title === next.title && before.dist === next.dist && before.deck === next.deck && !changedKey) { close(); return; }
      var doIt = function () { applyNameState(next); if (changedKey) setKey(key, nk); refresh(); };
      pushLog({ t: 'struct',
        undo: function () { applyNameState(before); if (changedKey) setKey(nk, key); refresh(); },
        redo: doIt });
      doIt();
      close();
      toast('名前を変えました。保存するとファイルに書き込みます');
    });
    document.body.appendChild(dlg);
    var fi = (focus && f[focus]) || f.title;
    fi.focus(); fi.select();
  }

  function exists(dirH, name) { return dirH.getFileHandle(name).then(function () { return true; }, function () { return false; }); }
  function seq(fns) { return fns.reduce(function (pr, fn) { return pr.then(fn); }, Promise.resolve()); }
  /* ほかの冊の並びで、名前を変えたページを付け替える */
  async function updateOtherDecks(dd, p) {
    var map = {}; p.renames.forEach(function (r) { map[r.from] = r.to; });
    var skip = { }; skip[p.deck + '.json'] = 1; if (p.deckRename) skip[p.deckRename.from + '.json'] = 1;
    var touched = [];
    for await (var ent of dd.values()) {
      if (ent.kind !== 'file' || !/\.json$/.test(ent.name) || skip[ent.name]) continue;
      var text = await (await ent.getFile()).text(), d;
      try { d = JSON.parse(text); } catch (e) { continue; }
      if (!Array.isArray(d.pages) || !d.pages.some(function (k) { return map[k]; })) continue;
      d.pages = d.pages.map(function (k) { return map[k] || k; });
      await writeText(ent, JSON.stringify(d, null, 1));
      touched.push(ent.name);
    }
    return touched;
  }

  /* ------------------------------------------------------------ 保存 */

  function substitutions() {
    var m = document.querySelector('meta[name="pp-subst"]');
    if (!m) return [];
    return m.content.split('||').map(function (p) { return p.split('=>'); }).filter(function (p) { return p.length === 2; });
  }
  function unsubst(html) {   // 保存用の書き方（{{THEME}} など）を、表示用の実パスに戻す
    substitutions().forEach(function (p) { html = html.split(p[1]).join(p[0]); });
    return html;
  }
  function serialize(section, keepKey) {
    var c = section.cloneNode(true);
    unmark(c);
    dropEmptyStyle(c);
    [c].concat(Array.from(c.querySelectorAll('*'))).forEach(function (e) {
      if (e.classList) REVEAL_CLASSES.forEach(function (k) { e.classList.remove(k); });
      if (e.getAttribute('class') === '') e.removeAttribute('class');
      REVEAL_ATTRS.forEach(function (a) { e.removeAttribute(a); });
    });
    // Reveal がスライドに付ける表示用のスタイル
    c.style.removeProperty('display'); c.style.removeProperty('top'); c.style.removeProperty('left');
    if (!c.getAttribute('style')) c.removeAttribute('style');
    var key = c.getAttribute('data-page');
    if (!keepKey) c.removeAttribute('data-page');
    var html = c.outerHTML;
    substitutions().forEach(function (p) { html = html.split(p[0]).join(p[1]); });
    return { key: key, html: html };
  }

  var IDB = 'pp-editor';
  function idb(mode, fn) {
    return new Promise(function (ok, ng) {
      var rq = indexedDB.open(IDB, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('h'); };
      rq.onerror = function () { ng(rq.error); };
      rq.onsuccess = function () {
        var tx = rq.result.transaction('h', mode); var st = tx.objectStore('h');
        var r = fn(st);
        tx.oncomplete = function () { ok(r && r.result); };
        tx.onerror = function () { ng(tx.error); };
      };
    });
  }
  function handleKey(kind) { return kind + ':' + location.pathname; }
  var handleStore = null;   // テスト用に差し替えられる保存先の置き場
  function getHandle(kind) { if (handleStore) return Promise.resolve(handleStore.get(kind) || null); return idb('readonly', function (st) { return st.get(handleKey(kind)); }).catch(function () { return null; }); }
  function putHandle(kind, h) { if (handleStore) { handleStore.set(kind, h); return Promise.resolve(); } return idb('readwrite', function (st) { return st.put(h, handleKey(kind)); }).catch(function () {}); }
  function ensurePerm(h, interactive) {
    return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
      if (p === 'granted') return true;
      if (!interactive) return false;
      return h.requestPermission({ mode: 'readwrite' }).then(function (q) { return q === 'granted'; });
    });
  }
  /* ページ単位のデッキの保存先。webdeck フォルダ(src と各冊のフォルダが入っている所)を選ぶと、冊の index.html も書き換える。
     src を選んだときはページと冊の並びだけ。interactive でないとき(自動保存)は選ぶ画面も許可の確認も出さず null */
  function srcDir(interactive) {
    var resolve = function (h) {
      return h.getDirectoryHandle('src').then(function (src) {
        return src.getDirectoryHandle('pages').then(function () { return src.getDirectoryHandle('decks'); }).then(function () { return { src: src, root: h }; });
      }, function () {
        return h.getDirectoryHandle('pages').then(function () { return h.getDirectoryHandle('decks'); }).then(function () { return { src: h, root: null }; });
      });
    };
    return getHandle('srcroot').then(function (h) {
      if (h) return ensurePerm(h, interactive).then(function (ok) { return ok ? resolve(h) : interactive ? pick() : null; });
      return interactive ? pick() : null;
    });
    function pick() {
      toast('保存先として、src と各冊のフォルダが入っている webdeck フォルダを選んでください');
      return global.showDirectoryPicker({ id: 'pp-src', mode: 'readwrite' }).then(function (h) {
        return resolve(h).then(function (r) { putHandle('srcroot', h); return r; }, function () { throw new Error('選んだフォルダに src(pages と decks)がありません'); });
      });
    }
  }
  function indexFile(interactive) {
    return getHandle('file').then(function (h) {
      if (h) return ensurePerm(h, interactive).then(function (ok) { return ok ? h : interactive ? pick() : null; });
      return interactive ? pick() : null;
    });
    function pick() {
      toast(single ? '保存先として、今開いているこのファイル(' + decodeURIComponent(location.pathname.split('/').pop()) + ')を選んでください' : '保存先として、このデッキの index.html を選んでください');
      return global.showOpenFilePicker({ id: 'pp-index', types: [{ description: 'HTML', accept: { 'text/html': ['.html'] } }] })
        .then(function (hs) { putHandle('file', hs[0]); return hs[0]; });
    }
  }
  /* 冊の index.html を、今の画面の中身に書き換える(再読み込みしても直した内容が出るように。目次の番号は組み立て時に直る) */
  function deckFolderName() { var a = location.pathname.split('/'); return decodeURIComponent(a[a.length - 2] || ''); }
  function indexHtmlNow(text) {
    var top = Array.from(slidesEl().children).filter(function (e) { return e.tagName === 'SECTION'; });
    text = replaceAllSlides(text, top.map(function (s) {
      var k = s.getAttribute('data-page'), h = unsubst(serialize(s).html);
      return k ? h.replace(/^<section\b/, '<section data-page="' + k.replace(/"/g, '&quot;') + '"') : h;
    }));
    var d = {}; Object.keys(deckInfo).forEach(function (x) { d[x] = deckInfo[x]; });
    d.title = names.title; if (names.dist || 'dist' in deckInfo) d.dist = names.dist; d.pages = modelPages();
    text = text.replace(/(<script type="application\/json" id="pp-deck">)[\s\S]*?(<\/script>)/, function (m, a, b) { return a + JSON.stringify(d).replace(/<\//g, '<\\/') + b; });
    text = text.replace(/(<meta name="pp-deck" content=")[^"]*(")/, function (m, a, b) { return a + deckName + b; });
    return replaceTitle(text, names.title);
  }
  function writeText(handle, text) {
    return handle.createWritable().then(function (w) { return w.write(text).then(function () { return w.close(); }); });
  }

  /* <script>・<style>・<template>・コメントの中身を同じ長さの空白にした写し。
     編集用の 1 ファイルはエディターの JS(中に '<div class="slides">' などの文字列がある)を含むので、
     スライドの場所はこの写しで探し、書き換えは元の文字列に対して行う */
  function masked(text) {
    return text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)|(<style\b[^>]*>)([\s\S]*?)(<\/style>)|(<template\b[^>]*>)([\s\S]*?)(<\/template>)|<!--[\s\S]*?-->/gi,
      function (m) { return m.replace(/[^\n]/g, ' ').replace(/^ /, '<'); });
  }
  /* index.html の中の、.slides 直下の n 番目の <section> を置き換える（入れ子の section も数える） */
  function slidesRange(text) {
    text = masked(text);
    var m = /<div[^>]*class="[^"]*\bslides\b[^"]*"[^>]*>/.exec(text);
    if (!m) throw new Error('index.html に .slides が見つかりません');
    var startInner = m.index + m[0].length;
    var re = /<div\b|<\/div>/g; re.lastIndex = startInner;
    var depth = 1, x;
    while ((x = re.exec(text))) {
      depth += x[0] === '</div>' ? -1 : 1;
      if (depth === 0) return [startInner, x.index];
    }
    throw new Error('index.html の .slides の終わりが見つかりません');
  }
  function spliceSection(text, n, html) {
    var mt = masked(text);
    var start = mt.search(/<div[^>]*class="[^"]*\bslides\b[^"]*"[^>]*>/);
    if (start < 0) throw new Error('index.html に .slides が見つかりません');
    var re = /<section\b|<\/section>/g; re.lastIndex = start;
    var depth = 0, idx = -1, s0 = -1, m;
    while ((m = re.exec(mt))) {
      if (m[0] === '</section>') {
        depth--;
        if (depth === 0 && idx === n) return text.slice(0, s0) + html + text.slice(re.lastIndex);
      } else {
        if (depth === 0) { idx++; s0 = m.index; }
        depth++;
      }
    }
    throw new Error('index.html の ' + (n + 1) + ' 枚目が見つかりません');
  }
  function replaceTitle(text, title) {
    var esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var at = masked(text).search(/<title>/i);   // スクリプトの中の <title> は書き換えない
    if (at >= 0) { var end = text.indexOf('</title>', at); if (end > at) text = text.slice(0, at) + '<title>' + esc + text.slice(end); }
    // PPShell.init({ title: "…" }) の書き方なら、そこも合わせる
    return text.replace(/(PPShell\.init\(\s*\{\s*title:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/, function (m, a) { return a + JSON.stringify(title).replace(/<\//g, '<\\/'); });
  }
  function replaceAllSlides(text, htmls) {
    var r = slidesRange(text);
    return text.slice(0, r[0]) + '\n\n' + htmls.join('\n\n') + '\n\n  ' + text.slice(r[1]);
  }

  function payload() {
    var list = slides();
    var pages = Array.from(dirty).filter(function (s) { return document.contains(s) && !isAuto(s); })
      .map(function (s) { var o = serialize(s, !model); return { s: s, n: list.indexOf(s), key: o.key, html: o.html, isNew: newKeys.has(o.key) }; })
      .filter(function (x) { return x.html !== saved.get(x.s); });   // 直して元に戻したページは書かない
    initNames();
    var title = names.title !== names.origTitle ? names.title : null;
    if (model) {
      var deckJson = null, rn = renames().map(function (r) { return { from: r.from, to: r.to }; });
      var deckRename = deckName !== names.deckOrig ? { from: names.deckOrig, to: deckName } : null;
      if (JSON.stringify(modelPages()) !== JSON.stringify(deckInfo.pages) || title !== null || names.dist !== names.origDist || deckRename) {
        var d = {}; Object.keys(deckInfo).forEach(function (k) { d[k] = deckInfo[k]; });
        d.title = names.title; if (names.dist || 'dist' in deckInfo) d.dist = names.dist;
        d.pages = modelPages();
        deckJson = JSON.stringify(d, null, 1);
      }
      return { mode: 'paged', deck: deckName, pages: pages, deckJson: deckJson, renames: rn, deckRename: deckRename };
    }
    var top = Array.from(slidesEl().children).filter(function (e) { return e.tagName === 'SECTION'; });   // 縦の束は親ごと
    return { mode: 'plain', pages: pages, all: structDirty ? top.map(function (s) { return serialize(s, true).html; }) : null, title: title };
  }

  var saving = null, structVer = 0;
  function save(opts) {
    var auto = !!(opts && opts.auto);
    clearTimeout(snapTimer);
    if (saving) return saving.then(function () { return auto ? null : save(opts); });
    if (!dirty.size && !structDirty && !namesDirty()) { if (!auto) toast('変更はありません'); return Promise.resolve(); }
    dirty.forEach(function (s) { if (document.contains(s)) snapshot(s); });
    var p = payload(), ver = structVer;
    if (!p.pages.length && !p.deckJson && !p.all && !p.title && !(p.renames && p.renames.length)) { dirty.clear(); structDirty = false; refresh(); if (!auto) toast('変更はありません（元に戻した状態）'); return Promise.resolve(); }
    var finish = function () { saving = null; refresh(); };
    if (writer) { saving = writer(p).then(function () { done(p, ver, auto); }); return saving.then(finish); }
    if (!global.showDirectoryPicker) { if (!auto) toast('保存は Chrome か Edge で開いてください（File System Access API が必要）', 'err'); return Promise.resolve(); }
    var stopAuto = function () { autoState = 'paused'; refresh(); return 'skip'; };
    var job = single
      ? indexFile(!auto).then(function (fh) {
          if (!fh) return stopAuto();
          return fh.getFile().then(function (f) { return f.text(); }).then(function (text) {
            if (!/name="pp-single"/.test(text)) throw new Error('選んだファイルは、この編集用のファイルではありません');
            if (model) text = indexHtmlNow(text);
            else { var top = Array.from(slidesEl().children).filter(function (e) { return e.tagName === 'SECTION'; }); text = replaceTitle(replaceAllSlides(text, top.map(function (s) { return serialize(s, true).html; })), names.title); }
            return writeText(fh, text);
          });
        })
      : p.mode === 'paged'
      ? srcDir(!auto).then(function (sr) {
          if (!sr) return stopAuto();
          var dir = sr.src;
          return Promise.all([dir.getDirectoryHandle('pages'), dir.getDirectoryHandle('decks')]).then(function (h) {
            var pd = h[0], dd = h[1], others = [];
            var renamedTo = {}; p.renames.forEach(function (r) { renamedTo[r.to] = r; });
            return seq(p.renames.map(function (r) { return function () {   // 先に、付け替え先が空いているか確かめる
                return exists(pd, r.to + '.html').then(function (e) { if (e) throw new Error('pages に ' + r.to + '.html がすでにあります'); });
              }; }))
              .then(function () { if (p.deckRename) return exists(dd, p.deckRename.to + '.json').then(function (e) { if (e) throw new Error('decks に ' + p.deckRename.to + '.json がすでにあります'); }); })
              .then(function () { return seq(p.renames.map(function (r) { return function () {   // 名前を変えたページ：新しい名前で書く
                var pg = p.pages.filter(function (x) { return x.key === r.to; })[0];
                var text = pg ? Promise.resolve(pg.html + '\n') : pd.getFileHandle(r.from + '.html').then(function (fh) { return fh.getFile(); }).then(function (f) { return f.text(); });
                return text.then(function (t) { return pd.getFileHandle(r.to + '.html', { create: true }).then(function (fh) { return writeText(fh, t); }); });
              }; })); })
              .then(function () { return Promise.all(p.pages.filter(function (x) { return !renamedTo[x.key]; }).map(function (x) {
                return pd.getFileHandle(x.key + '.html', { create: x.isNew })
                  .catch(function () { throw new Error('pages に ' + x.key + '.html がありません（選んだフォルダが違う可能性）'); })
                  .then(function (fh) { return writeText(fh, x.html + '\n'); });
              })); })
              .then(function () { if (p.renames.length) return updateOtherDecks(dd, p).then(function (t) { others = t; }); })
              .then(function () { if (p.deckJson) return dd.getFileHandle(p.deck + '.json', { create: !!p.deckRename }).then(function (fh) { return writeText(fh, p.deckJson); }); })
              .then(function () { return seq(p.renames.map(function (r) { return function () { return pd.removeEntry(r.from + '.html').catch(function () {}); }; })); })
              .then(function () { if (p.deckRename) return dd.removeEntry(p.deckRename.from + '.json').catch(function () {}); })
              .then(function () {   // 冊の index.html も今の中身に
                p.others = others;
                if (!sr.root) return;
                return sr.root.getDirectoryHandle(deckFolderName()).then(function (fd) { return fd.getFileHandle('index.html'); })
                  .then(function (fh) { return fh.getFile().then(function (f) { return f.text(); }).then(function (t) { return writeText(fh, indexHtmlNow(t)); }); })
                  .then(function () { p.indexWritten = true; }, function () { p.indexWritten = false; });
              });
          });
        })
      : indexFile(!auto).then(function (fh) {
          if (!fh) return stopAuto();
          return fh.getFile().then(function (f) { return f.text(); }).then(function (text) {
            if (p.all) text = replaceAllSlides(text, p.all);
            else p.pages.slice().sort(function (a, b) { return b.n - a.n; }).forEach(function (x) { text = spliceSection(text, x.n, x.html); });
            if (p.title) text = replaceTitle(text, p.title);
            return writeText(fh, text);
          });
        });
    saving = job.then(function (r) { if (r !== 'skip') done(p, ver, auto); }).catch(function (e) {
      if (auto) { autoState = 'error'; refresh(); }
      if (e && e.name === 'AbortError') { toast('保存をやめました'); return; }
      toast('保存できませんでした：' + (e && e.message || e), 'err');
    });
    return saving.then(finish);
  }
  function done(p, ver, auto) {
    p.pages.forEach(function (x) { saved.set(x.s, x.html); });
    if (p.deckJson) { var dj = JSON.parse(p.deckJson); deckInfo.pages = dj.pages; deckInfo.title = dj.title; if ('dist' in dj) deckInfo.dist = dj.dist; }
    var parts = [];
    if (single) parts = [decodeURIComponent(location.pathname.split('/').pop())];
    else if (p.pages.length) parts.push(p.mode === 'paged' ? p.pages.map(function (x) { return x.key + '.html'; }).join('、') : p.pages.length + ' 枚');
    if (!single) (p.renames || []).forEach(function (r) { parts.push(r.from + ' → ' + r.to); });
    if (p.deckRename) parts.push('冊 ' + p.deckRename.from + ' → ' + p.deckRename.to);
    if (p.deckJson) parts.push('decks/' + p.deck + '.json');
    if (p.others && p.others.length) parts.push('ほかの冊の並び ' + p.others.join('、'));
    if (p.all) parts.push('スライドの並び');
    if (p.title && p.mode === 'plain') parts.push('タイトル');
    if (names) {
      names.origTitle = names.title; names.origDist = names.dist; names.deckOrig = deckName;
      slides().forEach(function (s) { var k = s.getAttribute('data-page'); if (k && !isAuto(s)) origKey.set(s, k); });
    }
    // 保存している間に直したものは未保存のまま残す
    Array.from(dirty).forEach(function (s) { if (!document.contains(s) || serialize(s, !model).html === saved.get(s)) dirty.delete(s); });
    if (ver === undefined || ver === structVer) structDirty = false;
    if (p.mode === 'paged') lastIndexWritten = !!p.indexWritten;
    newKeys.clear();
    autoState = auto ? 'saved' : 'on';
    lastSaved = new Date();
    refresh();
    if (auto) return;
    var tail = single ? '。このファイルに保存しました(正本に戻すときは tools/import-single.mjs)' : p.mode !== 'paged' ? '' : p.indexWritten ? '。ほかの冊への反映と目次の番号は assemble.py で' : '。冊の index.html への反映は assemble.py で(webdeck フォルダを保存先にすると自動で反映)';
    toast('保存しました（' + parts.join('、') + '）' + tail);
  }

  /* ------------------------------------------------------------ 書き出し */

  /* PDF：保存してから、このデッキを印刷の表示で別の窓に開き、印刷の画面を出す(「PDF として保存」を選ぶ) */
  function printOk() {   // 印刷でスライドの大きさの用紙になるのは Chrome / Edge(Electron の窓や Safari は A4 になる)
    var ua = navigator.userAgent;
    return /Chrome\//.test(ua) && !/Electron\//.test(ua) && !!global.showDirectoryPicker;
  }
  function exportPdf() {
    if (!printOk()) { cmdDialog('pdf'); return; }
    var pending = dirty.size || structDirty || namesDirty();
    var go = function () {
      if (pending && model && !lastIndexWritten) toast('冊の index.html にまだ反映されていない変更は PDF に入りません。webdeck フォルダを保存先にするか、assemble.py を流してください', 'err');
      var w = global.open(location.pathname + '?view=print&pdfSeparateFragments=false&pp-print=1', '_blank');
      if (!w) toast('別の窓を開けませんでした(ポップアップを許可してください)', 'err');
      else toast('印刷の画面が開きます。送り先で「PDF として保存」を選んでください');
    };
    if (pending) save().then(go); else go();
  }
  /* PowerPoint：書き出しは手元の node で行う(ブラウザの中では画像を読み込めないため)。実行するコマンドを出す */
  function exportPptx() { cmdDialog('pptx'); }
  function cmdDialog(kind) {
    closePop();
    var dir = decodeURIComponent(location.pathname).replace(/\/[^\/]*$/, '');
    var root = dir.replace(/\/[^\/]*$/, '');
    var tools = (document.querySelector('script[src$="shell.js"]') || {}).src || '';
    tools = decodeURIComponent(tools.replace(/^file:\/\//, '')).replace(/runtime\/shell\.js$/, 'tools/');
    var cmdEdit = model ? 'python3 -I "' + root + '/src/assemble.py" ' + deckName + ' --pptx' : 'node "' + tools + 'export-pptx-editable.mjs" "' + dir + '"';
    var cmdImg = 'node "' + tools + 'export-pptx.mjs" "' + dir + '"';
    var cmdPdf = model ? 'python3 -I "' + root + '/src/assemble.py" ' + deckName + ' --export' : 'node "' + tools + 'export-pdf.mjs" "' + dir + '"';
    var pdf = kind === 'pdf';
    if (single && !pdf) { toast('編集用の 1 ファイルからは PowerPoint を直接作れません。正本に戻してから(tools/import-single.mjs)、assemble.py --pptx で作ります'); return; }
    var dlg = el('<div class="pp-ed-dlg" role="dialog"><form>' +
      (pdf ? '<h3>PDF に書き出す</h3>' +
        '<p class="pp-note">このアプリ(Orca など)やブラウザの印刷では、用紙が A4 になり、スライドが回転して小さくなります。スライドの大きさの PDF は、Chrome か Edge でこのデッキを開いて「PDF に書き出す」を押すか、次のコマンドで作ります(Claude に「PDF に書き出して」と頼んでも作れます)。</p>' +
        '<label>16:9 の PDF(デッキの out フォルダに入る)<span class="pp-row"><input readonly name="a"><button type="button" data-c="a">コピー</button></span></label>'
      : '<h3>PowerPoint に書き出す</h3>' +
        '<p class="pp-note">PowerPoint のファイルは、手元のターミナルで作ります(ブラウザの中からは、テーマの画像やフォントを読み込めないため)。Claude に「PowerPoint に書き出して」と頼んでも作れます。</p>' +
        '<label>PowerPoint で直せる形(文字・図形・画像に分けて置く)<span class="pp-row"><input readonly name="a"><button type="button" data-c="a">コピー</button></span><small>位置はほぼ合います。折り返しの位置やグラデーション・影は少し変わります</small></label>' +
        '<label>見た目を完全に合わせた形(各スライドを画像で貼る。直せない)<span class="pp-row"><input readonly name="b"><button type="button" data-c="b">コピー</button></span></label>') +
      '<p class="pp-note">保存していない変更は入らないので、先に保存してください。</p>' +
      '<div class="pp-btns"><button type="button" class="pp-ok" data-a="close">閉じる</button></div></form></div>');
    var f = dlg.querySelector('form');
    f.a.value = pdf ? cmdPdf : cmdEdit; if (f.b) f.b.value = cmdImg;
    dlg.querySelectorAll('[data-c]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = f[b.getAttribute('data-c')].value;
        (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () { b.textContent = 'コピーしました'; }, function () { f[b.getAttribute('data-c')].select(); document.execCommand('copy'); b.textContent = 'コピーしました'; });
      });
    });
    var close = function () { dlg.remove(); };
    dlg.querySelector('[data-a=close]').addEventListener('click', close);
    dlg.addEventListener('mousedown', function (e) { if (e.target === dlg) close(); });
    document.body.appendChild(dlg);
    if (dirty.size || structDirty || namesDirty()) toast('保存していない変更があります。書き出す前に保存してください');
  }
  var lastIndexWritten = false;

  /* ------------------------------------------------------------ 自動保存 */

  var autoTimer = null, autoState = 'on', lastSaved = null, dragging = false, composing = false;
  function scheduleAuto() {
    if (!lay.autosave || !active || writer || autoState === 'paused') return;   // 待機中は「保存」を押すまで試さない
    if (!(dirty.size || structDirty || namesDirty())) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () {
      if (dragging || composing) { scheduleAuto(); return; }
      save({ auto: true });
    }, 2500);
  }
  function toggleAuto() {
    lay.autosave = !lay.autosave; saveLayout();
    if (lay.autosave) { autoState = 'on'; scheduleAuto(); toast('自動保存をオンにしました(保存先を一度選ぶと、直すたびに保存します)'); }
    else { clearTimeout(autoTimer); toast('自動保存をオフにしました'); }
    refresh();
  }

  /* ------------------------------------------- 部品の選択・移動・大きさ・揃え */

  var sels = [], sel = null;        // 選んでいる部品(sel は最後に選んだもの)
  var selBox = null, guideLayer = null;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var VISUAL_TAG = /^(IMG|SVG|TABLE|FIGURE|CANVAS|VIDEO|IFRAME|PICTURE)$/i;
  var SNAP = 6;                     // 吸着する距離(画面の px)
  function isVisual(e) {
    if (isObj(e)) return true;
    if (VISUAL_TAG.test(e.tagName)) return true;
    var cs = getComputedStyle(e);
    if (cs.display === 'inline' || cs.display === 'contents') return false;
    if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') return true;
    if (cs.backgroundImage !== 'none') return true;
    if (cs.boxShadow !== 'none') return true;
    return ['Top', 'Right', 'Bottom', 'Left'].some(function (d) { return parseFloat(cs['border' + d + 'Width']) > 0 && cs['border' + d + 'Style'] !== 'none'; });
  }
  var TABLE_PARTS = /^(TR|THEAD|TBODY|TFOOT|COLGROUP|COL)$/;   // 表の行などは単独では選ばない(表かセル)
  function selectable(e) {
    if (e.namespaceURI === SVG_NS && e.tagName.toLowerCase() !== 'svg') return false;
    if (TABLE_PARTS.test(e.tagName)) return false;
    if (e.closest('aside.notes') || INLINE.test(e.tagName) && !e.hasAttribute('data-pp-ed')) return false;
    // 挿入した部品の中(図形の輪郭・表など)は、部品ごと選ぶ。選べるのは部品そのものと文字・セルだけ
    if (!isObj(e) && !e.hasAttribute('data-pp-ed') && e.closest('.pp-obj')) return false;
    var cs = getComputedStyle(e);
    if (cs.display === 'inline' || cs.display === 'none' || cs.visibility === 'hidden') return false;
    return e.hasAttribute('data-pp-ed') || isVisual(e);
  }
  /* target からスライドまでの、選べる部品(内側から順)。SVG の中の図形は SVG ごと */
  function candidates(target, s) {
    var out = [];
    for (var e = target.nodeType === 1 ? target : target.parentElement; e && e !== s; e = e.parentElement) if (selectable(e)) out.push(e);
    return out;
  }
  function partsOf(s) { return Array.from(s.querySelectorAll('*')).filter(selectable); }
  function outermost(list) { return list.filter(function (h) { return !list.some(function (o) { return o !== h && o.contains(h); }); }); }
  function scaleK() { var r = slidesEl().getBoundingClientRect(); return r.width / slideSize().w || 1; }
  /* 位置：テーマの部品は translate(レイアウトの流れはそのまま)、挿入した部品(.pp-obj)は left / top */
  function getTr(e) {
    if (isObj(e)) return [parseFloat(e.style.left) || 0, parseFloat(e.style.top) || 0];
    var m = (e.style.translate || '').match(/-?[\d.]+/g) || [];
    return [parseFloat(m[0]) || 0, parseFloat(m[1]) || 0];
  }
  function cleanStyle(e) { if (!e.getAttribute('style')) e.removeAttribute('style'); }
  function setTr(e, x, y) {
    x = Math.round(x); y = Math.round(y);
    if (isObj(e)) { e.style.left = x + 'px'; e.style.top = y + 'px'; return; }
    e.style.translate = (x || y) ? x + 'px ' + y + 'px' : '';
    cleanStyle(e);
  }
  function setSize(e, w, h) {
    if (isObj(e)) {   // 挿入した部品は border-box。テキストボックスと表の高さは中身に合わせる
      if (w != null) e.style.width = Math.round(w) + 'px';
      if (h != null && !autoH(e)) e.style.height = Math.round(h) + 'px';
      return;
    }
    var cs = getComputedStyle(e);
    var bx = cs.boxSizing === 'border-box' ? 0 : parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    var by = cs.boxSizing === 'border-box' ? 0 : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    if (w != null) e.style.width = Math.round(w - bx) + 'px';
    if (h != null) e.style.height = Math.round(h - by) + 'px';
    var pd = e.parentElement && getComputedStyle(e.parentElement).display;
    if (/flex/.test(pd || '')) e.style.flex = 'none';   // flex の中では大きさの指定が効くように
  }
  function union(rs) {
    var l = Math.min.apply(null, rs.map(function (r) { return r.left; })), t = Math.min.apply(null, rs.map(function (r) { return r.top; }));
    var r = Math.max.apply(null, rs.map(function (x) { return x.right; })), b = Math.max.apply(null, rs.map(function (x) { return x.bottom; }));
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  }
  function buildSel() {
    selBox = el('<div class="pp-ed-sels"></div>');
    selBox.addEventListener('pointerdown', function (e) {
      var d = e.target.getAttribute('data-d');
      if (!d || !sels.length) return;
      e.preventDefault(); e.stopPropagation();
      if (d === 'rot') startRotate(e);
      else if (d === 'p1' || d === 'p2') startLineEnd(e, d);
      else startDrag(e, d);
    });
    guideLayer = el('<div class="pp-ed-guides"></div>');
    document.body.appendChild(guideLayer);
    document.body.appendChild(selBox);
  }
  var HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  function boxHtml(single, line) {
    if (line) return '<div class="pp-ed-sel pp-lsel"><div class="pp-hd pp-hd-p" data-d="p1"></div><div class="pp-hd pp-hd-p" data-d="p2"></div><span class="pp-lab"></span></div>';
    return '<div class="pp-ed-sel' + (single ? ' pp-has-rot' : ' pp-multi') + '">' + (single ? '<div class="pp-rot" data-d="rot" title="ドラッグで回転(Shift で 15° ごと)"></div>' : '') + '<div class="pp-edge pp-edge-top" data-d="move"></div><div class="pp-edge pp-edge-right" data-d="move"></div><div class="pp-edge pp-edge-bottom" data-d="move"></div><div class="pp-edge pp-edge-left" data-d="move"></div>' +
      (single ? HANDLES.map(function (d) { return '<div class="pp-hd pp-hd-' + d + '" data-d="' + d + '"></div>'; }).join('') : '') + '<span class="pp-lab"></span></div>';
  }
  function labelOf(e) {
    if (isObj(e)) return objLabel(e);
    var c = (e.getAttribute('class') || '').trim().split(/\s+/).filter(function (x) { return x && !/^pp-/.test(x); })[0];
    return e.tagName.toLowerCase() + (c ? '.' + c : '');
  }
  function placeSel() {
    if (!selBox) return;
    sels = sels.filter(function (e) { return active && document.contains(e) && sectionOf(e) === current(); });
    sel = sels[sels.length - 1] || null;
    var single = sels.length === 1, ln = single && isLine(sel), key = sels.length + (single ? (ln ? 'l' : 's') : 'm');
    if (selBox._key !== key) { selBox.innerHTML = sels.map(function () { return boxHtml(single, ln); }).join(''); selBox._key = key; }
    var k = scaleK();
    Array.prototype.forEach.call(selBox.children, function (b, i) {
      var e = sels[i], r = e.getBoundingClientRect(), rot = totalRot(e);
      var L = r.left, T = r.top, W = r.width, H = r.height;
      if (rot && e.offsetWidth) {   // 回転している部品は、回す前の枠を同じだけ回して描く
        W = e.offsetWidth * k; H = e.offsetHeight * k; L = r.left + r.width / 2 - W / 2; T = r.top + r.height / 2 - H / 2;
      }
      b.style.left = L + 'px'; b.style.top = T + 'px'; b.style.width = W + 'px'; b.style.height = H + 'px';
      b.style.transform = rot ? 'rotate(' + rot + 'deg)' : '';
      if (ln) {
        var ends = lineEndsClient(e), hs = b.querySelectorAll('.pp-hd-p');
        hs[0].style.left = (ends[0][0] - L) + 'px'; hs[0].style.top = (ends[0][1] - T) + 'px';
        hs[1].style.left = (ends[1][0] - L) + 'px'; hs[1].style.top = (ends[1][1] - T) + 'px';
      }
      b.classList.toggle('pp-main', e === sel);
      var lab = b.querySelector('.pp-lab');
      lab.style.display = e === sel ? '' : 'none';
      if (e === sel) lab.textContent = single ? labelOf(e) + '  ' + Math.round(e.offsetWidth) + '×' + Math.round(e.offsetHeight) + (getRot(e) ? '  ' + getRot(e) + '°' : '') : sels.length + ' 個を選択';
    });
    selBox.style.display = sels.length ? '' : 'none';
    updateCtxTabs();
  }
  function select(e, add) {
    if (!add) sels = e ? [e] : [];
    else if (e) {
      var i = sels.indexOf(e);
      if (i >= 0) sels.splice(i, 1);
      else sels = sels.filter(function (x) { return !(x.contains(e) || e.contains(x)); }).concat([e]);   // 入れ子は一緒に選ばない
    }
    placeSel();
  }
  function clearSel() { sels = []; placeSel(); }
  function selectAll() { var s = current(); if (!s || isAuto(s)) return; sels = outermost(partsOf(s)); placeSel(); }

  /* ---- 吸着とガイド線 ---- */
  function snapTargets(s, skip) {   // スライドの端・中央、ほかの部品の端・中央(画面の座標)
    var c = slidesEl().getBoundingClientRect();
    var xs = [], ys = [];
    var add = function (r, slide) {
      xs.push({ v: r.left, r: r, slide: slide }, { v: r.left + r.width / 2, r: r, slide: slide, mid: true }, { v: r.right, r: r, slide: slide });
      ys.push({ v: r.top, r: r, slide: slide }, { v: r.top + r.height / 2, r: r, slide: slide, mid: true }, { v: r.bottom, r: r, slide: slide });
    };
    add(c, true);
    partsOf(s).forEach(function (e) {
      if (skip.some(function (x) { return x === e || x.contains(e) || e.contains(x); })) return;
      var r = e.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) add(r, false);
    });
    return { xs: xs, ys: ys, canvas: c };
  }
  function snap1(lines, targets) {   // lines：動かしている側の位置。いちばん近い吸着先までの差
    var best = null;
    // スライドの端・中央は 1.5px ぶん優先する(ほかの部品の端とほぼ重なるときはスライドに合わせる)
    lines.forEach(function (v) { targets.forEach(function (t) { var d = t.v - v, sc = Math.abs(d) - (t.slide ? 1.5 : 0); if (Math.abs(d) <= SNAP && (!best || sc < best.sc)) best = { d: d, sc: sc }; }); });
    return best ? best.d : 0;
  }
  function drawGuides(box, T) {
    guideLayer.innerHTML = '';
    if (!box) return;
    var line = function (vert, v, a, b, mid) {
      var g = document.createElement('div');
      g.className = 'pp-ed-guide ' + (vert ? 'pp-gv' : 'pp-gh') + (mid ? ' pp-mid' : '');
      if (vert) { g.style.left = v + 'px'; g.style.top = a + 'px'; g.style.height = (b - a) + 'px'; }
      else { g.style.top = v + 'px'; g.style.left = a + 'px'; g.style.width = (b - a) + 'px'; }
      guideLayer.appendChild(g);
    };
    var mine = { x: [box.left, box.left + box.width / 2, box.right], y: [box.top, box.top + box.height / 2, box.bottom] };
    var seen = {};
    T.xs.forEach(function (t) {
      if (!mine.x.some(function (v) { return Math.abs(v - t.v) < 0.75; })) return;
      var r = t.slide ? T.canvas : t.r, k = 'x' + Math.round(t.v);
      var a = Math.min(box.top, r.top), b = Math.max(box.bottom, r.bottom);
      if (seen[k] && seen[k][0] <= a && seen[k][1] >= b) return;
      seen[k] = [a, b]; line(true, t.v, a, b, t.slide && t.mid);
    });
    T.ys.forEach(function (t) {
      if (!mine.y.some(function (v) { return Math.abs(v - t.v) < 0.75; })) return;
      var r = t.slide ? T.canvas : t.r, k = 'y' + Math.round(t.v);
      var a = Math.min(box.left, r.left), b = Math.max(box.right, r.right);
      if (seen[k] && seen[k][0] <= a && seen[k][1] >= b) return;
      seen[k] = [a, b]; line(false, t.v, a, b, t.slide && t.mid);
    });
  }

  /* ---- ドラッグ：移動(選んでいる全部)・大きさ(1 つのとき) ---- */
  function startDrag(e, mode, onClick) {
    var list = mode === 'move' ? sels.slice() : [sel], s = sectionOf(list[0]), k = scaleK();
    var st = list.map(function (t) { return { t: t, tr: getTr(t), w: t.offsetWidth, h: t.offsetHeight, r: t.getBoundingClientRect() }; });
    var B0 = union(st.map(function (x) { return x.r; })), x0 = e.clientX, y0 = e.clientY, moved = false, T = null;
    var kids = mode !== 'move' && isGroup(list[0]) ? groupKids(list[0]) : null;   // グループの大きさを変えるときは中身も同じ割合で
    function mv(m) {
      var dx = m.clientX - x0, dy = m.clientY - y0;
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < 3) return;
        moved = true; dragging = true; clearTimeout(snapTimer); snapshot(s);
        if (document.activeElement && hostOf(document.activeElement)) document.activeElement.blur();
        T = snapTargets(s, list);
      }
      var free = m.altKey;   // Alt(Option)を押している間は吸着しない
      if (mode === 'move') {
        if (m.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }   // Shift で縦か横だけ
        if (!free) {
          if (!m.shiftKey || dy === 0) dx += snap1([B0.left + dx, B0.left + B0.width / 2 + dx, B0.right + dx], T.xs);
          if (!m.shiftKey || dx === 0) dy += snap1([B0.top + dy, B0.top + B0.height / 2 + dy, B0.bottom + dy], T.ys);
        }
        st.forEach(function (x) { setTr(x.t, x.tr[0] + dx / k, x.tr[1] + dy / k); });
        drawGuides(free ? null : { left: B0.left + dx, top: B0.top + dy, right: B0.right + dx, bottom: B0.bottom + dy, width: B0.width, height: B0.height }, T);
      } else {
        var x = st[0], r = x.r, t0 = x.t, deg = totalRot(t0), ra = deg * Math.PI / 180, ca = Math.cos(ra), sa = Math.sin(ra);
        if (!free && !deg) {   // 動かしている辺だけ吸着(回転していないとき)
          if (mode.indexOf('e') >= 0) dx += snap1([r.right + dx], T.xs);
          if (mode.indexOf('w') >= 0) dx += snap1([r.left + dx], T.xs);
          if (mode.indexOf('s') >= 0) dy += snap1([r.bottom + dy], T.ys);
          if (mode.indexOf('n') >= 0) dy += snap1([r.top + dy], T.ys);
        }
        var ldx = (dx * ca + dy * sa) / k, ldy = (-dx * sa + dy * ca) / k;   // 部品の向きに直した動き
        var hasW = /[ew]/.test(mode), hasH = /[ns]/.test(mode) && !autoH(t0);
        var w = x.w, h = x.h;
        if (mode.indexOf('e') >= 0) w = x.w + ldx;
        if (mode.indexOf('w') >= 0) w = x.w - ldx;
        if (mode.indexOf('s') >= 0) h = x.h + ldy;
        if (mode.indexOf('n') >= 0) h = x.h - ldy;
        w = Math.max(16, w); h = Math.max(12, h);
        // 角を動かすとき：画像は縦横の比を保つ(Shift で自由に)。ほかは Shift で比を保つ
        if (mode.length === 2 && hasH && m.shiftKey !== keepsAspect(t0)) { var f = Math.max(w / x.w, h / x.h); w = x.w * f; h = x.h * f; }
        if (!hasH) h = x.h;
        // 反対側の辺(角)が動かないように位置を直す。回転していても同じ
        var sx = mode.indexOf('w') >= 0 ? x.w - w : 0, sy = mode.indexOf('n') >= 0 ? x.h - h : 0;
        var cx = sx + (w - x.w) / 2, cy = sy + (h - x.h) / 2;
        var gx = cx * ca - cy * sa, gy = cx * sa + cy * ca;
        setSize(t0, hasW ? w : null, hasH ? h : null);
        setTr(t0, x.tr[0] + gx + (x.w - w) / 2, x.tr[1] + gy + (x.h - h) / 2);
        if (kids) scaleKids(kids, w / x.w, hasH ? h / x.h : 1);
        if (isObj(t0)) renderShape(t0);
        drawGuides(free || deg ? null : t0.getBoundingClientRect(), T);
      }
      placeSel();
    }
    function up() {
      document.removeEventListener('pointermove', mv, true);
      document.removeEventListener('pointerup', up, true);
      drawGuides(null);
      dragging = false;
      if (moved) { snapshot(s); dirty.add(s); refresh(); }
      else if (onClick) onClick();
    }
    document.addEventListener('pointermove', mv, true);
    document.addEventListener('pointerup', up, true);
  }

  /* ---- 範囲選択(何もない所からドラッグ) ---- */
  function startMarquee(e, add) {
    var s = current();
    if (!s || isAuto(s)) { clearSel(); return; }
    e.preventDefault();
    if (document.activeElement && hostOf(document.activeElement)) document.activeElement.blur();
    var base = add ? sels.slice() : [];
    if (!add) clearSel();
    var x0 = e.clientX, y0 = e.clientY, parts = null, box = null;
    function mv(m) {
      if (!box) {
        if (Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) < 4) return;
        box = el('<div class="pp-ed-marquee"></div>'); guideLayer.appendChild(box);
        parts = partsOf(s).map(function (p) { return { e: p, r: p.getBoundingClientRect() }; });
      }
      var l = Math.min(x0, m.clientX), t = Math.min(y0, m.clientY), r = Math.max(x0, m.clientX), b = Math.max(y0, m.clientY);
      box.style.left = l + 'px'; box.style.top = t + 'px'; box.style.width = (r - l) + 'px'; box.style.height = (b - t) + 'px';
      var hit = outermost(parts.filter(function (p) { return p.r.width > 1 && p.r.left >= l && p.r.right <= r && p.r.top >= t && p.r.bottom <= b; }).map(function (p) { return p.e; }));
      sels = base.filter(function (x) { return !hit.some(function (h) { return h.contains(x) || x.contains(h); }); }).concat(hit);
      placeSel();
    }
    function up() {
      document.removeEventListener('pointermove', mv, true);
      document.removeEventListener('pointerup', up, true);
      if (box) box.remove();
    }
    document.addEventListener('pointermove', mv, true);
    document.addEventListener('pointerup', up, true);
  }

  var CHROME = '.pp-ed-bar, .pp-ed-status, .pp-ed-pop, .pp-ed-notes, .pp-ed-side, .pp-ed-split-v, .pp-ed-split-h, .pp-ed-sels, .pp-ed-toast, .pp-ed-dlg, .pp-dock';
  function onPointerDown(e) {
    if (!active || e.button !== 0 || e.target.closest(CHROME)) return;
    if (painter) return;
    if (drawKind) { startDraw(e); return; }   // 挿入 › 図形・テキストボックス：ドラッグで描く
    var add = e.shiftKey || e.metaKey || e.ctrlKey;
    var s = sectionOf(e.target);
    if (!s || s !== current() || isAuto(s)) { startMarquee(e, add); return; }   // スライドの外(灰色の所)からも範囲選択
    // 挿入した部品(図形・線・テキストボックス・画像・表・グループ)
    var chain = objChain(e.target, s);
    if (chain.length && !add && !(sels.length > 1 && sels.some(function (x) { return x.contains(e.target); }))) {
      var at = sel ? chain.indexOf(sel) : -1, th = hostOf(e.target);
      if (at === 0) {   // いちばん内側の部品がもう選ばれている：文字の上なら文字の編集、ほかはドラッグで移動
        if (th && sel.contains(th)) return;
        e.preventDefault(); blurText(); startDrag(e, 'move'); return;
      }
      var nx = at > 0 ? chain[at - 1] : chain[chain.length - 1];   // グループの中をもう一度押した：1 段内側
      select(nx);
      if (nx === chain[0] && th && directText(nx)) return;   // テキストボックス・表は 1 回目から文字を直せる
      e.preventDefault(); blurText(); startDrag(e, 'move');
      return;
    }
    var cands = candidates(e.target, s);
    if (!cands.length) { startMarquee(e, add); return; }                    // スライドの何もない所
    // 表の中を押したら、まず表ごと選ぶ(PowerPoint と同じ。もう一度押すとセル)。文字の上ならセルの文字も直せる
    var first = cands.filter(function (c) { return c.tagName === 'TABLE'; })[0] || cands.filter(isVisual)[0] || cands[0];
    if (add) {   // Shift / ⌘ / Ctrl + クリック：選択に足す・外す
      e.preventDefault();
      var hitSel = sels.filter(function (x) { return x.contains(e.target); })[0];
      select(hitSel || first, true);
      return;
    }
    var inSel = sels.filter(function (x) { return x.contains(e.target); })[0];
    if (sels.length > 1 && inSel) {   // 複数選んでいる中を押した：まとめて移動。動かさずに離したらその部品だけに
      e.preventDefault();
      if (document.activeElement && hostOf(document.activeElement)) document.activeElement.blur();
      startDrag(e, 'move', function () { select(inSel); });
      return;
    }
    var next;
    if (sel && sel !== cands[0] && sel.contains(e.target)) {   // 選んである部品の中をもう一度押した：1 段内側へ
      var inner = cands.filter(function (c) { return c !== sel && sel.contains(c); });
      next = inner[inner.length - 1];
    } else if (sel && sel.contains(e.target)) next = sel;
    else next = first;
    select(next);
    // 文字の上なら文字の編集(カーソルを置く)。文字以外の所を押したらそのままドラッグで移動。文字の枠は選択枠の縁をドラッグ
    if (!hostOf(e.target)) {
      e.preventDefault();
      if (document.activeElement && hostOf(document.activeElement)) document.activeElement.blur();
      startDrag(e, 'move');
    }
  }

  /* ---- 選んだ部品への操作 ---- */
  function selOp(fn) {
    return function () {
      if (!sels.length) { toast('先に、スライドの部品をクリックして選んでください'); return; }
      var s = sectionOf(sels[0]);
      clearTimeout(snapTimer); snapshot(s);
      fn(sels.slice(), s);
      snapshot(s); dirty.add(s); refresh(); placeSel();
    };
  }
  var resetPos = selOp(function (list) {
    list.forEach(function (e) {
      if (isObj(e)) {   // 挿入した部品は位置と大きさが本体なので、回転と文字の大きさだけ元に
        e.style.removeProperty('rotate'); e.style.removeProperty('font-size'); cleanStyle(e);
        e.querySelectorAll('[style*="font-size"]').forEach(function (x) { x.style.removeProperty('font-size'); cleanStyle(x); });
        return;
      }
      ['translate', 'width', 'height', 'flex', 'font-size', 'rotate', 'scale'].forEach(function (p) { e.style.removeProperty(p); }); cleanStyle(e);
      e.querySelectorAll('[style*="font-size"]').forEach(function (x) { x.style.removeProperty('font-size'); cleanStyle(x); });   // 中の文字の大きさも元に
    });
  });
  var deletePart = selOp(function (list) { list.forEach(function (e) { e.remove(); }); sels = []; });
  function nudge(dx, dy) { return selOp(function (list) { list.forEach(function (e) { var t = getTr(e); setTr(e, t[0] + dx, t[1] + dy); }); })(); }
  /* 揃える：2 つ以上なら選んだ範囲に、1 つならスライドに合わせる */
  function alignCmd(kind) {
    return selOp(function (list) {
      var k = scaleK(), rs = list.map(function (e) { return e.getBoundingClientRect(); });
      var ref = list.length > 1 ? union(rs) : slidesEl().getBoundingClientRect();
      list.forEach(function (e, i) {
        var r = rs[i], dx = 0, dy = 0;
        if (kind === 'l') dx = ref.left - r.left;
        if (kind === 'c') dx = (ref.left + ref.width / 2) - (r.left + r.width / 2);
        if (kind === 'r') dx = ref.right - r.right;
        if (kind === 't') dy = ref.top - r.top;
        if (kind === 'm') dy = (ref.top + ref.height / 2) - (r.top + r.height / 2);
        if (kind === 'b') dy = ref.bottom - r.bottom;
        var t = getTr(e); setTr(e, t[0] + dx / k, t[1] + dy / k);
      });
    });
  }
  /* 等間隔に並べる：3 つ以上。両端はそのまま、間のすき間をそろえる */
  function distribute(horiz) {
    return selOp(function (list) {
      if (list.length < 3) { toast('等間隔に並べるには 3 つ以上選んでください'); return; }
      var k = scaleK();
      var it = list.map(function (e) { return { e: e, r: e.getBoundingClientRect() }; })
        .sort(function (a, b) { return horiz ? a.r.left - b.r.left : a.r.top - b.r.top; });
      var first = it[0].r, last = it[it.length - 1].r;
      var span = horiz ? last.right - first.left : last.bottom - first.top;
      var sum = it.reduce(function (a, x) { return a + (horiz ? x.r.width : x.r.height); }, 0);
      var gap = (span - sum) / (it.length - 1), pos = horiz ? first.left : first.top;
      it.forEach(function (x) {
        var d = pos - (horiz ? x.r.left : x.r.top), t = getTr(x.e);
        setTr(x.e, t[0] + (horiz ? d / k : 0), t[1] + (horiz ? 0 : d / k));
        pos += (horiz ? x.r.width : x.r.height) + gap;
      });
    });
  }
  function selectOuter() {
    if (!sel) { toast('先に、スライドの部品をクリックして選んでください'); return; }
    var s = sectionOf(sel);
    var up = candidates(sel.parentElement, s).filter(function (c) { return c !== sel; });
    var p = up[0] || (sel.parentElement !== s ? sel.parentElement : null);
    if (p) select(p); else toast('これより外側の部品はありません');
  }

  /* ------------------------------------- 挿入した部品(図形・線・テキストボックス・画像・表・グループ)

     どれも <section> 直下(またはグループの中)に置く .pp-obj。位置は left / top、大きさは width / height(1280×720 の座標)。
     - 図形  <div class="pp-obj pp-shape" data-shape="chevron"><svg class="pp-sh-g">…</svg><div class="pp-sh-t">文字</div></div>
             data-shape は PowerPoint の図形の名前(prstGeom)。輪郭の SVG はここで大きさに合わせて作り、HTML にそのまま残す
             (配布物・PDF は JS なしで描ける。PPTX には PowerPoint の図形として書き出す)
     - 線    <div class="pp-obj pp-line" data-shape="line|elbow" data-hs / data-he="tri|arrow|oval" data-flip="h|v|hv">
             枠の左上 → 右下へ引く(data-flip で向きを変える。PowerPoint と同じ持ち方)。選ぶと両端に丸い印が出て、端をドラッグ
     - テキストボックス  .pp-shape.pp-tb(塗りなし・高さは中身に合わせる)
     - 画像  <img class="pp-obj pp-pic">(data: URL で埋め込む)
     - 表    <div class="pp-obj pp-tblw"><table class="pp-tbl">…</table></div>(高さは中身に合わせる)
     - グループ  <div class="pp-obj pp-group">(中の部品はグループの左上からの位置)
     色は CSS 変数(--sh-fill / --sh-line / --sh-lw / --sh-fo / --sh-tc)。テーマの色は var(--pp-ed-cN) のまま持つ(モードを替えても追従) */

  var SHAPE_CATS = [
    { head: '線', items: [['line', '直線'], ['arrow', '矢印'], ['darrow', '両矢印'], ['elbow', 'カギ線矢印']] },
    { head: '四角形', items: [['rect', '正方形 / 長方形'], ['roundRect', '角丸四角形'], ['flowChartTerminator', '角丸(端子)']] },
    { head: '基本図形', items: [['ellipse', '楕円'], ['triangle', '二等辺三角形'], ['rtTriangle', '直角三角形'], ['diamond', 'ひし形'], ['parallelogram', '平行四辺形'],
      ['trapezoid', '台形'], ['pentagon', '五角形'], ['hexagon', '六角形'], ['octagon', '八角形'], ['plus', '十字形'], ['can', '円柱'], ['star5', '星 5 pt']] },
    { head: 'ブロック矢印', items: [['rightArrow', '右矢印'], ['leftArrow', '左矢印'], ['upArrow', '上矢印'], ['downArrow', '下矢印'], ['leftRightArrow', '左右矢印'],
      ['upDownArrow', '上下矢印'], ['homePlate', 'ホームベース'], ['chevron', '山形']] },
    { head: 'フローチャート', items: [['flowChartProcess', '処理'], ['flowChartDecision', '判断'], ['flowChartDocument', '書類'], ['flowChartMagneticDisk', '磁気ディスク']] },
    { head: '吹き出し', items: [['wedgeRectCallout', '吹き出し: 四角形'], ['wedgeRoundRectCallout', '吹き出し: 角を丸めた四角形']] },
  ];
  var LINE_KINDS = { line: ['line', '', ''], arrow: ['line', '', 'tri'], darrow: ['line', 'tri', 'tri'], elbow: ['elbow', '', 'tri'] };
  function shapeName(t) {
    for (var i = 0; i < SHAPE_CATS.length; i++) for (var j = 0; j < SHAPE_CATS[i].items.length; j++) if (SHAPE_CATS[i].items[j][0] === t) return SHAPE_CATS[i].items[j][1];
    return t;
  }
  function isObj(e) { return !!(e && e.classList && e.classList.contains('pp-obj')); }
  function isLine(e) { return isObj(e) && e.classList.contains('pp-line'); }
  function isGroup(e) { return isObj(e) && e.classList.contains('pp-group'); }
  function isShape(e) { return isObj(e) && e.classList.contains('pp-shape'); }
  function autoH(e) { return isObj(e) && (e.classList.contains('pp-tb') || e.classList.contains('pp-tblw')); }
  function directText(e) { return autoH(e); }   // 1 回目のクリックから文字を直せる部品
  function keepsAspect(e) { return e.tagName === 'IMG' || e.tagName.toLowerCase() === 'svg' || e.tagName === 'VIDEO'; }
  function objLabel(e) {
    if (isLine(e)) return e.getAttribute('data-shape') === 'elbow' ? 'カギ線' : e.getAttribute('data-he') || e.getAttribute('data-hs') ? '矢印' : '直線';
    if (isGroup(e)) return 'グループ';
    if (e.classList.contains('pp-tb')) return 'テキストボックス';
    if (e.classList.contains('pp-pic')) return '画像';
    if (e.classList.contains('pp-tblw')) return '表';
    return shapeName(e.getAttribute('data-shape') || 'rect');
  }
  function objChain(t, s) {   // t から外側へ、挿入した部品(内側から順)
    var out = [];
    for (var x = t && t.nodeType === 1 ? t : t && t.parentElement; x && x !== s; x = x.parentElement) if (isObj(x)) out.push(x);
    return out;
  }
  function textOf(o) { for (var c = o && o.firstElementChild; c; c = c.nextElementSibling) if (c.classList.contains('pp-sh-t')) return c; return null; }
  function blurText() { if (document.activeElement && hostOf(document.activeElement)) document.activeElement.blur(); }
  function typingNow() {
    var a = document.activeElement;
    return !!a && (!!hostOf(a) || a === notesBody || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function getRot(e) { var m = /(-?[\d.]+)deg/.exec(e.style.rotate || ''); return m ? parseFloat(m[1]) : 0; }
  function setRot(e, d) {
    d = ((d % 360) + 540) % 360 - 180;
    d = Math.round(d * 10) / 10;
    if (Math.abs(d) < 0.05) e.style.removeProperty('rotate'); else e.style.rotate = d + 'deg';
    cleanStyle(e);
  }
  function totalRot(e) { var d = 0; for (var x = e; x && !(x.tagName === 'SECTION'); x = x.parentElement) if (x.style) d += getRot(x); return d; }

  /* ---- 図形の輪郭(PowerPoint の既定の形に合わせる。w×h の px で作る) ---- */
  function n2(v) { return Math.round(v * 100) / 100; }
  function poly(pts) { return 'M' + pts.map(function (p) { return n2(p[0]) + ' ' + n2(p[1]); }).join('L') + 'Z'; }
  function arc(r, x, y, big) { return 'A' + n2(r[0]) + ' ' + n2(r[1]) + ' 0 ' + (big ? 1 : 0) + ' 1 ' + n2(x) + ' ' + n2(y); }
  function rrPath(w, h, r, tail) {   // 角丸の四角形。tail は下の辺から出る吹き出しの [右の付け根 x, [先 x, 先 y], 左の付け根 x]
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    var R = [r, r];
    var d = 'M' + n2(r) + ' 0H' + n2(w - r) + arc(R, w, r) + 'V' + n2(h - r) + arc(R, w - r, h);
    if (tail) d += 'H' + n2(tail[0]) + 'L' + n2(tail[1][0]) + ' ' + n2(tail[1][1]) + 'L' + n2(tail[2]) + ' ' + n2(h);
    return d + 'H' + n2(r) + arc(R, 0, h - r) + 'V' + n2(r) + arc(R, r, 0) + 'Z';
  }
  function callout(w, h) { return [w * 0.4167, [w * 0.2917, h * 1.125], w * 0.1667]; }   // PowerPoint の既定(先は左下の外)
  function geom(t, w, h) {
    var m = Math.min(w, h), o, q;
    switch (t) {
      case 'roundRect': return { d: rrPath(w, h, m * 0.1667) };
      case 'flowChartTerminator': return { d: rrPath(w, h, m / 2) };
      case 'ellipse': return { d: 'M0 ' + n2(h / 2) + arc([w / 2, h / 2], w, h / 2, 1) + arc([w / 2, h / 2], 0, h / 2, 1) + 'Z' };
      case 'triangle': return { d: poly([[w / 2, 0], [w, h], [0, h]]) };
      case 'rtTriangle': return { d: poly([[0, 0], [w, h], [0, h]]) };
      case 'diamond': case 'flowChartDecision': return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) };
      case 'parallelogram': o = Math.min(m * 0.25, w / 2); return { d: poly([[o, 0], [w, 0], [w - o, h], [0, h]]) };
      case 'trapezoid': o = Math.min(m * 0.25, w / 2); return { d: poly([[o, 0], [w - o, 0], [w, h], [0, h]]) };
      case 'pentagon': return { d: poly([[w / 2, 0], [w, h * 0.382], [w * 0.809, h], [w * 0.191, h], [0, h * 0.382]]) };
      case 'hexagon': o = Math.min(m * 0.25, w / 2); return { d: poly([[o, 0], [w - o, 0], [w, h / 2], [w - o, h], [o, h], [0, h / 2]]) };
      case 'octagon': o = m * 0.2929; return { d: poly([[o, 0], [w - o, 0], [w, o], [w, h - o], [w - o, h], [o, h], [0, h - o], [0, o]]) };
      case 'plus': o = m * 0.25; return { d: poly([[o, 0], [w - o, 0], [w - o, o], [w, o], [w, h - o], [w - o, h - o], [w - o, h], [o, h], [o, h - o], [0, h - o], [0, o], [o, o]]) };
      case 'homePlate': o = Math.min(m * 0.5, w); return { d: poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h]]) };
      case 'chevron': o = Math.min(m * 0.5, w / 2); return { d: poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h], [o, h / 2]]) };
      case 'rightArrow': o = Math.min(m * 0.5, w); return { d: poly([[0, h * .25], [w - o, h * .25], [w - o, 0], [w, h / 2], [w - o, h], [w - o, h * .75], [0, h * .75]]) };
      case 'leftArrow': o = Math.min(m * 0.5, w); return { d: poly([[w, h * .25], [o, h * .25], [o, 0], [0, h / 2], [o, h], [o, h * .75], [w, h * .75]]) };
      case 'upArrow': o = Math.min(m * 0.5, h); return { d: poly([[w * .25, h], [w * .25, o], [0, o], [w / 2, 0], [w, o], [w * .75, o], [w * .75, h]]) };
      case 'downArrow': o = Math.min(m * 0.5, h); return { d: poly([[w * .25, 0], [w * .75, 0], [w * .75, h - o], [w, h - o], [w / 2, h], [0, h - o], [w * .25, h - o]]) };
      case 'leftRightArrow': o = Math.min(m * 0.5, w / 2); return { d: poly([[0, h / 2], [o, 0], [o, h * .25], [w - o, h * .25], [w - o, 0], [w, h / 2], [w - o, h], [w - o, h * .75], [o, h * .75], [o, h]]) };
      case 'upDownArrow': o = Math.min(m * 0.5, h / 2); return { d: poly([[w / 2, 0], [w, o], [w * .75, o], [w * .75, h - o], [w, h - o], [w / 2, h], [0, h - o], [w * .25, h - o], [w * .25, o], [0, o]]) };
      case 'wedgeRectCallout': return { d: rrPath(w, h, 0, callout(w, h)) };
      case 'wedgeRoundRectCallout': return { d: rrPath(w, h, Math.min(m * 0.1667, w * 0.1667), callout(w, h)) };
      case 'can': case 'flowChartMagneticDisk':
        q = Math.min(m * 0.125, h / 2);   // 上下の楕円の縦の半径
        return { d: 'M0 ' + n2(q) + arc([w / 2, q], w, q) + 'V' + n2(h - q) + arc([w / 2, q], 0, h - q) + 'Z',
                 x: 'M0 ' + n2(q) + arc([w / 2, q], w, q, 1) + arc([w / 2, q], 0, q, 1) + 'Z' };
      case 'star5': {
        var ry = h / 1.809, rx = w / 2 / 0.951, pts = [];
        for (var i = 0; i < 10; i++) { var a = (-90 + 36 * i) * Math.PI / 180, f = i % 2 ? 0.382 : 1; pts.push([w / 2 + rx * f * Math.cos(a), ry + ry * f * Math.sin(a)]); }
        return { d: poly(pts) };
      }
      case 'flowChartDocument': return { d: 'M0 0H' + n2(w) + 'V' + n2(h * 0.8) + 'C' + n2(w * 0.7) + ' ' + n2(h * 0.6) + ' ' + n2(w * 0.42) + ' ' + n2(h * 1.08) + ' 0 ' + n2(h * 0.88) + 'Z' };
      default: return { d: poly([[0, 0], [w, 0], [w, h], [0, h]]) };
    }
  }
  /* 線の通り道(枠の中の座標)。カギ線は横 → 縦 → 横 */
  function linePts(t, w, h, flip) {
    var fh = /h/.test(flip || ''), fv = /v/.test(flip || '');
    var a = [fh ? w : 0, fv ? h : 0], b = [fh ? 0 : w, fv ? 0 : h];
    return t === 'elbow' ? [a, [(a[0] + b[0]) / 2, a[1]], [(a[0] + b[0]) / 2, b[1]], b] : [a, b];
  }
  function headSvg(kind, tip, from, lw) {   // 線の端の矢印。cut は線をその分だけ短くする長さ
    var dx = tip[0] - from[0], dy = tip[1] - from[1], L = Math.hypot(dx, dy);
    if (!L) return { svg: '', cut: 0 };
    var ux = dx / L, uy = dy / L, len = lw * 3 + 5, wid = lw * 2.6 + 5;
    var bx = tip[0] - ux * len, by = tip[1] - uy * len, px = -uy * wid / 2, py = ux * wid / 2;
    var p1 = [bx + px, by + py], p2 = [bx - px, by - py];
    if (kind === 'tri') return { svg: '<path class="pp-sh-h" d="' + poly([tip, p1, p2]) + '"/>', cut: len * 0.85 };
    if (kind === 'arrow') return { svg: '<path class="pp-sh-h pp-open" d="M' + n2(p1[0]) + ' ' + n2(p1[1]) + 'L' + n2(tip[0]) + ' ' + n2(tip[1]) + 'L' + n2(p2[0]) + ' ' + n2(p2[1]) + '"/>', cut: lw / 2 };
    if (kind === 'oval') return { svg: '<circle class="pp-sh-h" cx="' + n2(tip[0]) + '" cy="' + n2(tip[1]) + '" r="' + n2(wid / 2.6) + '"/>', cut: 0 };
    return { svg: '', cut: 0 };
  }
  function lwOf(e, def) { var v = parseFloat(e.style.getPropertyValue('--sh-lw')); return isNaN(v) ? def : v; }
  function dashAttr(dash, lw) {
    lw = lw || 2;
    if (dash === 'dash') return ' stroke-dasharray="' + n2(lw * 4) + ' ' + n2(lw * 3) + '"';
    if (dash === 'dot') return ' stroke-dasharray="' + n2(lw) + ' ' + n2(lw) + '"';
    return '';
  }
  var gradSeq = 0;
  var FILL_DEF = 'var(--sh-fill, var(--pp-ed-c2, var(--pp-ed-c1, var(--pp-accent, #2563eb))))';
  /* 図形の SVG を、今の大きさ・設定で作り直す(グループは中身を全部) */
  function renderShape(e) {
    if (!isObj(e)) return;
    if (isGroup(e)) { Array.from(e.children).forEach(renderShape); return; }
    var t = e.getAttribute('data-shape');
    if (!t) return;
    var w = parseFloat(e.style.width), h = parseFloat(e.style.height);
    if (isNaN(w) || autoH(e) && e.offsetWidth) w = e.offsetWidth || w || 0;
    if (isNaN(h) || autoH(e)) h = e.offsetHeight || h || 0;
    var g = null;
    for (var c = e.firstElementChild; c; c = c.nextElementSibling) if (c.namespaceURI === SVG_NS && c.classList.contains('pp-sh-g')) { g = c; break; }
    if (!g) { g = document.createElementNS(SVG_NS, 'svg'); g.setAttribute('class', 'pp-sh-g'); g.setAttribute('aria-hidden', 'true'); e.insertBefore(g, e.firstChild); }
    var W = n2(Math.max(w, 1)), H = n2(Math.max(h, 1));
    g.setAttribute('width', W); g.setAttribute('height', H); g.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var dash = e.getAttribute('data-dash'), html;
    if (isLine(e)) {
      var lw = lwOf(e, 2), pts = linePts(t, w, h, e.getAttribute('data-flip')), drawn = pts.map(function (p) { return p.slice(); }), heads = '';
      [[0, e.getAttribute('data-hs')], [pts.length - 1, e.getAttribute('data-he')]].forEach(function (x) {
        var i = x[0], kind = x[1];
        if (!kind) return;
        var step = i ? -1 : 1, j = i + step;
        while (j >= 0 && j < pts.length && pts[j][0] === pts[i][0] && pts[j][1] === pts[i][1]) j += step;   // 同じ所にある点は飛ばす
        if (j < 0 || j >= pts.length) return;
        var r = headSvg(kind, pts[i], pts[j], lw);
        heads += r.svg;
        if (r.cut) {
          var dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1], L = Math.hypot(dx, dy), cut = Math.min(r.cut, L);
          drawn[i] = [pts[i][0] + dx / L * cut, pts[i][1] + dy / L * cut];
        }
      });
      var path = function (ps) { return 'M' + ps.map(function (p) { return n2(p[0]) + ' ' + n2(p[1]); }).join('L'); };
      html = '<path class="pp-sh-hit" d="' + path(pts) + '"/><path class="pp-sh-p" d="' + path(drawn) + '"' + dashAttr(dash, lw) + '/>' + heads;
    } else {
      var lw2 = lwOf(e, 0), gm = geom(t, w, h), fill = '', defs = '', gd = e.getAttribute('data-grad');
      if (gd) {   // グラデーション:塗りの色を白に寄せた色 → 塗りの色
        var id = 'ppg' + Date.now().toString(36) + (gradSeq++);
        defs = '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="' + (gd === 'v' ? 0 : 1) + '" y2="' + (gd === 'v' ? 1 : 0) + '">' +
          '<stop offset="0" style="stop-color:color-mix(in srgb, ' + FILL_DEF + ' 50%, #fff)"/><stop offset="1" style="stop-color:' + FILL_DEF + '"/></linearGradient></defs>';
        fill = ' style="fill:url(#' + id + ')"';
      }
      var fl = e.getAttribute('data-flip') || '', fh = /h/.test(fl), fv = /v/.test(fl);
      var tf = fl ? ' transform="translate(' + (fh ? W : 0) + ' ' + (fv ? H : 0) + ') scale(' + (fh ? -1 : 1) + ' ' + (fv ? -1 : 1) + ')"' : '';
      html = defs + '<g' + tf + '><path class="pp-sh-p" d="' + gm.d + '"' + fill + dashAttr(dash, lw2) + '/>' +
        (gm.x ? '<path class="pp-sh-x" d="' + gm.x + '"' + dashAttr(dash, lw2) + '/>' : '') + '</g>';
    }
    g.innerHTML = html;
  }

  /* ---- 作る ---- */
  function setBox(e, x, y, w, h) {
    e.style.left = Math.round(x) + 'px'; e.style.top = Math.round(y) + 'px';
    if (w != null) e.style.width = Math.round(w) + 'px';
    if (h != null) e.style.height = Math.round(h) + 'px';
  }
  function setLine(e, a, b) {   // 両端(親の座標)から枠と向きを決める
    setBox(e, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    var f = (b[0] < a[0] ? 'h' : '') + (b[1] < a[1] ? 'v' : '');
    if (f) e.setAttribute('data-flip', f); else e.removeAttribute('data-flip');
  }
  function lineEnds(e) {   // 両端(親の座標)
    var x = parseFloat(e.style.left) || 0, y = parseFloat(e.style.top) || 0, w = parseFloat(e.style.width) || 0, h = parseFloat(e.style.height) || 0;
    var f = e.getAttribute('data-flip') || '', fh = /h/.test(f), fv = /v/.test(f);
    return [[x + (fh ? w : 0), y + (fv ? h : 0)], [x + (fh ? 0 : w), y + (fv ? 0 : h)]];
  }
  function lineEndsClient(e) {
    var r = e.getBoundingClientRect(), f = e.getAttribute('data-flip') || '', fh = /h/.test(f), fv = /v/.test(f);
    return [[r.left + (fh ? r.width : 0), r.top + (fv ? r.height : 0)], [r.left + (fh ? 0 : r.width), r.top + (fv ? 0 : r.height)]];
  }
  function toLocal(parent, cx, cy) {   // 画面の座標 → parent の中の座標(スライドの px)
    var r = parent.getBoundingClientRect(), k = scaleK();
    return [(cx - r.left) / k - parent.clientLeft, (cy - r.top) / k - parent.clientTop];
  }
  function makeShape(t, x, y, w, h) {
    var lk = LINE_KINDS[t], e = document.createElement('div');
    if (lk) {
      e.className = 'pp-obj pp-line'; e.setAttribute('data-shape', lk[0]);
      if (lk[1]) e.setAttribute('data-hs', lk[1]);
      if (lk[2]) e.setAttribute('data-he', lk[2]);
    } else { e.className = 'pp-obj pp-shape'; e.setAttribute('data-shape', t); e.innerHTML = '<div class="pp-sh-t"></div>'; }
    setBox(e, x, y, w, h);
    return e;
  }
  function makeTextBox(x, y, w, text) {
    var e = document.createElement('div');
    e.className = 'pp-obj pp-shape pp-tb'; e.setAttribute('data-shape', 'rect');
    var t = document.createElement('div'); t.className = 'pp-sh-t';
    if (text) t.innerHTML = text.split(/\r?\n/).map(function (l) { return l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }).join('<br>');
    e.appendChild(t);
    setBox(e, x, y, w, null);
    return e;
  }
  function editSection() {
    var s = current();
    if (!s || isAuto(s)) { toast('このスライドには挿入できません(自動で作るページ)'); return null; }
    return s;
  }
  function placeIn(par, e) {   // ノート(aside.notes)より前に置く
    var n = null;
    for (var c = par.firstElementChild; c; c = c.nextElementSibling) if (c.matches('aside.notes')) { n = c; break; }
    par.insertBefore(e, n);
  }
  function insertObjs(s, list, after) {
    clearTimeout(snapTimer); snapshot(s);
    list.forEach(function (e) { if (after && after.has(e)) { var a = after.get(e); a.parentElement.insertBefore(e, a.nextSibling); } else placeIn(s, e); renderShape(e); });
    markSection(s);
    snapshot(s); dirty.add(s);
    sels = list.slice(); placeSel(); refresh();
  }
  function editText(o, all, cx, cy) {   // 図形の文字の編集に入る(all：中身を全部選ぶ。打つと置き換わる)
    var t = textOf(o);
    if (!t) return false;
    if (!t.hasAttribute('data-pp-ed')) setEd(t);
    t.focus();
    var gs = global.getSelection(), r = null;
    if (cx != null && document.caretRangeFromPoint) { r = document.caretRangeFromPoint(cx, cy); if (r && !t.contains(r.startContainer)) r = null; }
    if (!r) { r = document.createRange(); r.selectNodeContents(t); if (!all) r.collapse(false); }
    gs.removeAllRanges(); gs.addRange(r); lastRange = r.cloneRange();
    return true;
  }

  /* ---- 挿入 › 図形・テキストボックス：スライドの上をドラッグして描く ---- */
  var drawKind = null;
  function beginDraw(kind) {
    if (!editSection()) return;
    closePop(); clearSel(); blurText();
    drawKind = kind;
    document.documentElement.classList.add('pp-ed-drawing');
    toast(kind.t === 'text' ? 'テキストボックスを置く所をクリック(ドラッグで幅を決める)。Esc でやめる'
      : LINE_KINDS[kind.t] ? '始点から終点へドラッグして線を引きます(Shift で 45° ごと)。Esc でやめる'
      : 'スライドの上をドラッグして描きます(クリックで標準の大きさ。Shift で縦横の比をそろえる)。Esc でやめる');
  }
  function endDraw() { drawKind = null; document.documentElement.classList.remove('pp-ed-drawing'); }
  function startDraw(ev) {
    var s = editSection(), kind = drawKind;
    endDraw();
    if (!s) return;
    ev.preventDefault(); blurText();
    var p0 = toLocal(s, ev.clientX, ev.clientY), isLn = !!LINE_KINDS[kind.t], txt = kind.t === 'text';
    clearTimeout(snapTimer); snapshot(s);
    var e = txt ? makeTextBox(p0[0], p0[1], 40) : makeShape(kind.t, p0[0], p0[1], 1, 1);
    placeIn(s, e); renderShape(e);
    var moved = false;
    function mv(m) {
      var p = toLocal(s, m.clientX, m.clientY), dx = p[0] - p0[0], dy = p[1] - p0[1];
      if (!moved) { if (Math.abs(dx) + Math.abs(dy) < 3) return; moved = true; dragging = true; }
      if (isLn) {
        if (m.shiftKey) { var L = Math.hypot(dx, dy), q = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4; dx = L * Math.cos(q); dy = L * Math.sin(q); }
        setLine(e, p0, [p0[0] + dx, p0[1] + dy]);
      } else {
        if (m.shiftKey && !txt) { var z = Math.max(Math.abs(dx), Math.abs(dy)); dx = z * (dx < 0 ? -1 : 1); dy = z * (dy < 0 ? -1 : 1); }
        setBox(e, Math.min(p0[0], p0[0] + dx), txt ? p0[1] : Math.min(p0[1], p0[1] + dy), Math.max(Math.abs(dx), txt ? 40 : 1), txt ? null : Math.abs(dy));
      }
      renderShape(e);
      sels = [e]; placeSel();
    }
    function up() {
      document.removeEventListener('pointermove', mv, true);
      document.removeEventListener('pointerup', up, true);
      dragging = false;
      if (!moved) {   // クリックだけ：標準の大きさ
        if (isLn) setLine(e, p0, [p0[0] + 200, p0[1]]);
        else if (txt) setBox(e, p0[0], p0[1], 320, null);
        else setBox(e, p0[0], p0[1], 200, /^(rect|roundRect|ellipse|diamond|octagon|hexagon|pentagon|star5|plus|can|triangle|rtTriangle)$/.test(kind.t) ? 140 : 110);
      }
      renderShape(e);
      markSection(s); snapshot(s); dirty.add(s);
      sels = [e]; placeSel(); refresh();
      var tt = document.querySelector('.pp-ed-toast'); if (tt) tt.className = 'pp-ed-toast';   // 描き方の案内を閉じる
      if (txt) editText(e, false);
      else { tab = 'shape'; renderPanel(); }
    }
    document.addEventListener('pointermove', mv, true);
    document.addEventListener('pointerup', up, true);
  }

  /* ---- 画像(ファイル・貼り付け・ドラッグ)。大きい画像は長い辺 1920px に縮めて埋め込む ---- */
  function readImage(file) {
    return new Promise(function (ok, ng) {
      var fr = new FileReader();
      fr.onerror = function () { ng(fr.error); };
      fr.onload = function () {
        var src = fr.result, im = new Image();
        im.onload = function () {
          var w = im.naturalWidth || 400, h = im.naturalHeight || 300, max = 1920;
          if (/svg|gif/.test(file.type) || Math.max(w, h) <= max && file.size < 1.5e6) { ok({ src: src, w: w, h: h }); return; }
          var f = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
          c.width = Math.round(w * f); c.height = Math.round(h * f);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          var png = /png|webp/.test(file.type);
          ok({ src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88), w: c.width, h: c.height });
        };
        im.onerror = function () { ng(new Error('画像を読めませんでした')); };
        im.src = src;
      };
      fr.readAsDataURL(file);
    });
  }
  function insertImageFile(file, at) {
    var s = editSection();
    if (!s) return;
    if (!/^image\//.test(file.type)) { toast('画像のファイルを選んでください'); return; }
    readImage(file).then(function (im) {
      var sz = slideSize(), f = Math.min(1, sz.w * 0.6 / im.w, sz.h * 0.6 / im.h), w = im.w * f, h = im.h * f;
      var e = document.createElement('img');
      e.className = 'pp-obj pp-pic'; e.alt = (file.name || '').replace(/\.[^.]+$/, ''); e.src = im.src;
      setBox(e, at ? at[0] - w / 2 : (sz.w - w) / 2, at ? at[1] - h / 2 : (sz.h - h) / 2, w, h);
      insertObjs(s, [e]);
      tab = 'shape'; renderPanel();
    }).catch(function (err) { toast(String(err && err.message || err), 'err'); });
  }
  function pickImage() {
    if (!editSection()) return;
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.addEventListener('change', function () { if (inp.files && inp.files[0]) insertImageFile(inp.files[0]); });
    inp.click();
  }

  /* ---- 表 ---- */
  function insertTable(rows, cols) {
    var s = editSection();
    if (!s) return;
    var sz = slideSize(), w = Math.min(sz.w - 160, Math.max(360, cols * 170));
    var e = document.createElement('div');
    e.className = 'pp-obj pp-tblw';
    var html = '<table class="pp-tbl pp-band"><tbody>';
    for (var r = 0; r < rows; r++) { html += '<tr>'; for (var c = 0; c < cols; c++) html += r === 0 ? '<th></th>' : '<td></td>'; html += '</tr>'; }
    e.innerHTML = html + '</tbody></table>';
    setBox(e, (sz.w - w) / 2, 170, w, null);
    insertObjs(s, [e]);
    var first = e.querySelector('th, td');
    if (first) { first.focus(); lastCell = first; }
    tab = 'table'; renderPanel();
  }
  var lastCell = null;
  function cellAt(node) { var x = node && (node.nodeType === 1 ? node : node.parentElement); return x && x.closest ? x.closest('td, th') : null; }
  function cellCtx() {
    var gs = global.getSelection(), c = gs.rangeCount ? cellAt(gs.getRangeAt(0).startContainer) : null;
    if (c && sectionOf(c) === current()) return c;
    if (sel && /^(TD|TH)$/.test(sel.tagName)) return sel;
    if (lastCell && document.contains(lastCell) && sectionOf(lastCell) === current() && sel && (sel.contains(lastCell))) return lastCell;
    if (sel) { var t = sel.tagName === 'TABLE' ? sel : sel.querySelector && sel.querySelector('table'); if (t) return t.querySelector('td, th'); }
    return null;
  }
  function inTable() { return !!cellCtx(); }
  function tableOp(fn) {
    return function () {
      var c = cellCtx();
      if (!c) { toast('先に、表のセルをクリックしてください'); return; }
      var s = sectionOf(c), tr = c.parentElement, tb = c.closest('table');
      clearTimeout(snapTimer); snapshot(s);
      fn(c, tr, tb, s);
      unmark(s); markSection(s);
      snapshot(s); dirty.add(s); refresh();
    };
  }
  function cellIndex(c) { return Array.prototype.indexOf.call(c.parentElement.children, c); }
  function rowLike(tr, below) {
    var head = Array.from(tr.children).every(function (x) { return x.tagName === 'TH'; });
    var n = document.createElement('tr');
    Array.from(tr.children).forEach(function (x) {
      var y = document.createElement(head && below ? 'td' : x.tagName.toLowerCase());
      if (x.colSpan > 1) y.colSpan = x.colSpan;
      n.appendChild(y);
    });
    return n;
  }
  var rowAbove = tableOp(function (c, tr) { tr.parentElement.insertBefore(rowLike(tr, false), tr); });
  var rowBelow = tableOp(function (c, tr) { tr.parentElement.insertBefore(rowLike(tr, true), tr.nextSibling); });
  function colIns(right) {
    return tableOp(function (c, tr, tb) {
      var i = cellIndex(c);
      Array.from(tb.rows).forEach(function (row) {
        var ref = row.children[Math.min(i, row.children.length - 1)];
        if (!ref) return;
        var y = document.createElement(ref.tagName.toLowerCase());
        row.insertBefore(y, right ? ref.nextSibling : ref);
      });
    });
  }
  var colLeft = colIns(false), colRight = colIns(true);
  function dropTable(tb) { var w = tb.closest('.pp-tblw') || tb; w.remove(); sels = []; }
  var delRow = tableOp(function (c, tr, tb) { if (tb.rows.length <= 1) dropTable(tb); else tr.remove(); });
  var delCol = tableOp(function (c, tr, tb) {
    var i = cellIndex(c);
    if (tr.children.length <= 1) { dropTable(tb); return; }
    Array.from(tb.rows).forEach(function (row) { var x = row.children[i]; if (x) x.remove(); });
  });
  var delTable = tableOp(function (c, tr, tb) { dropTable(tb); });
  var toggleHead = tableOp(function (c, tr, tb) {   // 1 行目を見出し(th)と本文(td)で切り替える
    var row = tb.rows[0];
    if (!row) return;
    var head = Array.from(row.children).every(function (x) { return x.tagName === 'TH'; });
    Array.from(row.children).forEach(function (x) {
      var y = document.createElement(head ? 'td' : 'th');
      Array.from(x.attributes).forEach(function (a) { y.setAttribute(a.name, a.value); });
      while (x.firstChild) y.appendChild(x.firstChild);
      x.replaceWith(y);
    });
  });
  var toggleBand = tableOp(function (c, tr, tb) { tb.classList.toggle('pp-band'); if (!tb.classList.contains('pp-tbl')) toast('縞模様は挿入した表で使えます'); });

  /* ---- グループ ---- */
  function groupKids(g) {   // グループの中の部品の、今の位置と大きさ
    return Array.from(g.querySelectorAll('.pp-obj')).map(function (e) {
      return { e: e, l: parseFloat(e.style.left) || 0, t: parseFloat(e.style.top) || 0, w: parseFloat(e.style.width) || e.offsetWidth, h: parseFloat(e.style.height) || e.offsetHeight };
    });
  }
  function scaleKids(kids, fx, fy) {
    kids.forEach(function (x) {
      x.e.style.left = n2(x.l * fx) + 'px'; x.e.style.top = n2(x.t * fy) + 'px';
      x.e.style.width = n2(x.w * fx) + 'px';
      if (!autoH(x.e)) x.e.style.height = n2(x.h * fy) + 'px';
      if (!isGroup(x.e)) renderShape(x.e);
    });
  }
  function groupSel() {
    var list = sels.slice();
    if (list.length < 2 || !list.every(isObj)) { toast('グループにするには、挿入した図形・線・画像・テキストボックス・表を 2 つ以上選んでください'); return; }
    var par = list[0].parentElement;
    if (list.some(function (e) { return e.parentElement !== par; })) { toast('同じ所(同じグループの中)にある部品だけをまとめられます'); return; }
    var s = sectionOf(par), k = scaleK();
    clearTimeout(snapTimer); snapshot(s);
    var bb = union(list.map(function (e) { return e.getBoundingClientRect(); })), o = toLocal(par, bb.left, bb.top);
    var gx = Math.round(o[0]), gy = Math.round(o[1]);
    var g = document.createElement('div');
    g.className = 'pp-obj pp-group';
    setBox(g, gx, gy, bb.width / k, bb.height / k);
    var ordered = Array.from(par.children).filter(function (c) { return list.indexOf(c) >= 0; });
    par.insertBefore(g, ordered[ordered.length - 1].nextSibling);
    if (ordered.every(function (e) { return e.classList.contains('pp-back'); })) g.classList.add('pp-back');
    ordered.forEach(function (e) {
      e.classList.remove('pp-back');
      e.style.left = ((parseFloat(e.style.left) || 0) - gx) + 'px'; e.style.top = ((parseFloat(e.style.top) || 0) - gy) + 'px';
      g.appendChild(e);
    });
    snapshot(s); dirty.add(s); sels = [g]; placeSel(); refresh();
  }
  function ungroupSel() {
    var gs = sels.filter(isGroup);
    if (!gs.length) { toast('先に、グループを選んでください'); return; }
    var s = sectionOf(gs[0]), out = [];
    clearTimeout(snapTimer); snapshot(s);
    gs.forEach(function (g) {
      var gx = parseFloat(g.style.left) || 0, gy = parseFloat(g.style.top) || 0, rot = getRot(g), a = rot * Math.PI / 180;
      var gcx = g.offsetWidth / 2, gcy = g.offsetHeight / 2, par = g.parentElement, back = g.classList.contains('pp-back');
      Array.from(g.children).forEach(function (c) {
        if (!isObj(c)) return;
        var l = parseFloat(c.style.left) || 0, t = parseFloat(c.style.top) || 0;
        if (rot) {   // グループの回転を、中の部品の位置と向きに移す
          var w = c.offsetWidth, h = c.offsetHeight, x = l + w / 2 - gcx, y = t + h / 2 - gcy;
          l = x * Math.cos(a) - y * Math.sin(a) + gcx - w / 2; t = x * Math.sin(a) + y * Math.cos(a) + gcy - h / 2;
          setRot(c, getRot(c) + rot);
        }
        c.style.left = Math.round(l + gx) + 'px'; c.style.top = Math.round(t + gy) + 'px';
        if (back && par.tagName === 'SECTION') c.classList.add('pp-back');
        par.insertBefore(c, g); out.push(c);
      });
      g.remove();
    });
    snapshot(s); dirty.add(s); sels = out; placeSel(); refresh();
  }

  /* ---- 重なり順(挿入した部品どうし。最背面はテーマの部品より後ろ) ---- */
  function objSibs(e) { return Array.from(e.parentElement.children).filter(isObj); }
  function zMove(e, kind) {
    var par = e.parentElement, top = par.tagName === 'SECTION', sib = objSibs(e), i = sib.indexOf(e), back = e.classList.contains('pp-back');
    var notesA = null;
    for (var c = par.firstElementChild; c; c = c.nextElementSibling) if (c.matches('aside.notes')) notesA = c;
    if (kind === 'front') { e.classList.remove('pp-back'); par.insertBefore(e, notesA); }
    else if (kind === 'back') { if (top) e.classList.add('pp-back'); par.insertBefore(e, par.firstChild); }
    else if (kind === 'fwd') {
      var nx = sib[i + 1];
      if (top && back && (!nx || !nx.classList.contains('pp-back'))) {   // テーマの部品より前へ(前面の部品の中ではいちばん後ろ)
        e.classList.remove('pp-back');
        var ff = sib.filter(function (x) { return x !== e && !x.classList.contains('pp-back'); })[0];
        if (ff) par.insertBefore(e, ff);
      } else if (nx) par.insertBefore(e, nx.nextSibling);
    } else if (kind === 'bwd') {
      var pv = sib[i - 1];
      if (top && !back && (!pv || pv.classList.contains('pp-back'))) {   // テーマの部品より後ろへ
        e.classList.add('pp-back');
        var lb = sib.filter(function (x) { return x !== e && x.classList.contains('pp-back'); }).pop();
        par.insertBefore(e, lb ? lb.nextSibling : par.firstChild);
      } else if (pv) par.insertBefore(e, pv);
    }
  }
  function zCmd(kind) {
    return selOp(function (list) {
      var objs = list.filter(isObj);
      if (objs.length < list.length) toast('重なり順を変えられるのは、挿入した図形・線・画像・テキストボックス・表です(テーマの部品はレイアウトの順)');
      var ordered = objs.slice().sort(function (a, b) { return a.compareDocumentPosition(b) & 4 ? -1 : 1; });   // 文書の順
      if (kind === 'back' || kind === 'fwd') ordered.reverse();
      ordered.forEach(function (e) { zMove(e, kind); });
    });
  }

  /* ---- 回転・反転 ---- */
  function rotateCmd(deg) {
    return selOp(function (list) {
      list.forEach(function (e) {
        if (isLine(e)) {   // 線は両端を中心のまわりに回す
          var p = lineEnds(e), cx = (p[0][0] + p[1][0]) / 2, cy = (p[0][1] + p[1][1]) / 2, a = deg * Math.PI / 180;
          var rt = function (q) { var x = q[0] - cx, y = q[1] - cy; return [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]; };
          setLine(e, rt(p[0]), rt(p[1])); renderShape(e);
        } else setRot(e, getRot(e) + deg);
      });
    });
  }
  var rotReset = selOp(function (list) { list.forEach(function (e) { e.style.removeProperty('rotate'); cleanStyle(e); }); });
  function toggleFlip(e, ax) {
    var f = e.getAttribute('data-flip') || '';
    f = f.indexOf(ax) >= 0 ? f.replace(ax, '') : f + ax;
    f = (/h/.test(f) ? 'h' : '') + (/v/.test(f) ? 'v' : '');
    if (f) e.setAttribute('data-flip', f); else e.removeAttribute('data-flip');
  }
  function flipObj(e, ax) {
    if (getRot(e)) setRot(e, -getRot(e));
    if (isGroup(e)) {   // 中の部品の位置を鏡に映す
      var W = e.offsetWidth, H = e.offsetHeight;
      Array.from(e.children).filter(isObj).forEach(function (c) {
        if (ax === 'h') c.style.left = Math.round(W - (parseFloat(c.style.left) || 0) - c.offsetWidth) + 'px';
        else c.style.top = Math.round(H - (parseFloat(c.style.top) || 0) - c.offsetHeight) + 'px';
        flipObj(c, ax);
      });
    } else if (e.tagName === 'IMG') {
      var m = (e.style.scale || '1 1').split(/\s+/).map(parseFloat), sx = m[0] || 1, sy = m.length > 1 ? m[1] : sx;
      if (ax === 'h') sx = -sx; else sy = -sy;
      if (sx === 1 && sy === 1) e.style.removeProperty('scale'); else e.style.scale = sx + ' ' + sy;
    } else if (e.getAttribute('data-shape')) { toggleFlip(e, ax); renderShape(e); }
  }
  function flipCmd(ax) {
    return selOp(function (list) {
      var ok = list.filter(function (e) { return isObj(e) && !e.classList.contains('pp-tb') && !e.classList.contains('pp-tblw'); });
      if (ok.length < list.length) toast('反転できるのは、挿入した図形・線・画像・グループです');
      ok.forEach(function (e) { flipObj(e, ax); });
    });
  }

  /* ---- 図形の書式(塗りつぶし・枠線・効果・文字)。テーマの部品にも背景色・枠線・影として付く ---- */
  function leaves(list) {   // グループは中の部品に展開する
    var out = [];
    list.forEach(function (e) { if (isGroup(e)) out = out.concat(leaves(Array.from(e.children).filter(isObj))); else out.push(e); });
    return out;
  }
  function colorProbe(v, at) {
    var p = document.createElement('span'); p.style.color = v; (at || document.body).appendChild(p);
    var c = getComputedStyle(p).color; p.remove();
    var m = (c.match(/[\d.]+/g) || []).map(Number);
    return m.length >= 3 ? m : null;
  }
  function lum(rgb) {
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function autoTextColor(e, v) {   // 塗りの明るさに合わせて文字の色(白 / 濃い色)。文字の色を指定した図形はそのまま
    if (e.hasAttribute('data-tc') || e.classList.contains('pp-tb')) return;
    if (v === 'none') { e.style.setProperty('--sh-tc', 'var(--pp-fg, #1a1a1a)'); return; }
    var rgb = colorProbe(v, e);
    if (rgb && lum(rgb) > 0.45) e.style.setProperty('--sh-tc', '#1b1b1b'); else e.style.removeProperty('--sh-tc');
  }
  function fmtCmd(fn) { return selOp(function (list) { leaves(list).forEach(function (e) { fn(e); if (isObj(e)) renderShape(e); }); }); }
  function fillCmd(v) {
    return fmtCmd(function (e) {
      if (isLine(e)) return;
      if (isShape(e)) { e.style.setProperty('--sh-fill', v); if (v === 'none') e.removeAttribute('data-grad'); autoTextColor(e, v); }
      else if (e.classList.contains('pp-tblw')) { if (v === 'none') e.style.removeProperty('--sh-fill'); else e.style.setProperty('--sh-fill', v); }
      else e.style.backgroundColor = v === 'none' ? 'transparent' : v;
    });
  }
  function lineCmd(v) {
    return fmtCmd(function (e) {
      if (isLine(e)) { if (v !== 'none') e.style.setProperty('--sh-line', v); return; }
      if (isShape(e)) {
        if (v === 'none') { e.style.setProperty('--sh-line', 'none'); return; }
        e.style.setProperty('--sh-line', v);
        if (!lwOf(e, 0)) e.style.setProperty('--sh-lw', '2px');
        return;
      }
      if (e.classList.contains('pp-tblw')) return;
      if (v === 'none') { e.style.borderStyle = 'none'; return; }
      e.style.borderColor = v;
      if (getComputedStyle(e).borderTopStyle === 'none') e.style.borderStyle = 'solid';
      if (!parseFloat(getComputedStyle(e).borderTopWidth)) e.style.borderWidth = '2px';
    });
  }
  function lwCmd(px) {
    return fmtCmd(function (e) {
      if (isShape(e) || isLine(e)) {
        e.style.setProperty('--sh-lw', px + 'px');
        if (isShape(e) && (!e.style.getPropertyValue('--sh-line') || e.style.getPropertyValue('--sh-line') === 'none')) e.style.setProperty('--sh-line', 'var(--pp-fg, #1a1a1a)');
        return;
      }
      if (e.classList.contains('pp-tblw')) return;
      e.style.borderWidth = px + 'px';
      if (getComputedStyle(e).borderTopStyle === 'none') e.style.borderStyle = 'solid';
    });
  }
  function dashCmd(kind) {
    return fmtCmd(function (e) {
      if (isShape(e) || isLine(e)) { if (kind) e.setAttribute('data-dash', kind); else e.removeAttribute('data-dash'); return; }
      if (getComputedStyle(e).borderTopStyle !== 'none' || e.style.borderStyle) e.style.borderStyle = kind === 'dash' ? 'dashed' : kind === 'dot' ? 'dotted' : 'solid';
    });
  }
  function headCmd(hs, he) {
    return fmtCmd(function (e) {
      if (!isLine(e)) return;
      if (hs) e.setAttribute('data-hs', hs); else e.removeAttribute('data-hs');
      if (he) e.setAttribute('data-he', he); else e.removeAttribute('data-he');
    });
  }
  function shadowCmd(on) {
    return fmtCmd(function (e) {
      if (isObj(e)) e.classList.toggle('pp-shadow', on);
      else if (on) e.style.boxShadow = '0 3px 10px rgba(0, 0, 0, .28)'; else { e.style.removeProperty('box-shadow'); cleanStyle(e); }
    });
  }
  function alphaCmd(a) {   // 透明度(0〜1)。図形は塗りだけ、ほかは部品ごと
    return fmtCmd(function (e) {
      if (isShape(e)) { if (a) e.style.setProperty('--sh-fo', String(Math.round((1 - a) * 100) / 100)); else e.style.removeProperty('--sh-fo'); }
      else { if (a) e.style.opacity = String(Math.round((1 - a) * 100) / 100); else e.style.removeProperty('opacity'); cleanStyle(e); }
    });
  }
  function gradCmd(dir) {
    return fmtCmd(function (e) {
      if (!isShape(e)) return;
      if (dir) { e.setAttribute('data-grad', dir); if (e.style.getPropertyValue('--sh-fill') === 'none') e.style.removeProperty('--sh-fill'); }
      else e.removeAttribute('data-grad');
    });
  }
  function textColorCmd(v) {
    return fmtCmd(function (e) {
      if (isShape(e)) { if (v) { e.style.setProperty('--sh-tc', v); e.setAttribute('data-tc', '1'); } else { e.style.removeProperty('--sh-tc'); e.removeAttribute('data-tc'); autoTextColor(e, e.style.getPropertyValue('--sh-fill') || FILL_DEF); } }
      else if (!isLine(e)) { if (v) e.style.color = v; else { e.style.removeProperty('color'); cleanStyle(e); } }
    });
  }
  function valignCmd(v) {
    return fmtCmd(function (e) {
      if (!isShape(e)) return;
      if (!v) e.removeAttribute('data-valign'); else e.setAttribute('data-valign', v);
    });
  }
  function changeShapeCmd(t) {
    return fmtCmd(function (e) { if (isShape(e) && !e.classList.contains('pp-tb')) e.setAttribute('data-shape', t); });
  }

  /* ---- 部品の複製・コピー・貼り付け ---- */
  var objClip = null, CLIP_MARK = 'pp-editor-parts';
  function cloneHtml(e) { var c = e.cloneNode(true); unmark(c); return c.outerHTML; }
  function shift(e, d) { if (isObj(e)) { e.style.left = ((parseFloat(e.style.left) || 0) + d) + 'px'; e.style.top = ((parseFloat(e.style.top) || 0) + d) + 'px'; } }
  function duplicateParts() {
    if (!sels.length) { toast('先に、複製したい部品を選んでください'); return; }
    var s = sectionOf(sels[0]), after = new Map(), made = sels.map(function (e) { var c = el(cloneHtml(e)); shift(c, 20); after.set(c, e); return c; });
    insertObjs(s, made, after);
  }
  function copyParts(cut) {
    if (!sels.length) return false;
    objClip = { items: sels.map(function (e) { return { html: cloneHtml(e), obj: isObj(e), src: e }; }), from: current(), n: cut ? -1 : 0 };
    if (cut) deletePart();
    return true;
  }
  function pasteParts() {
    var s = editSection();
    if (!s || !objClip) return;
    objClip.n++;
    var d = objClip.from === s ? 20 * objClip.n : 0, after = new Map(), made = [];
    objClip.items.forEach(function (it) {
      var e = el(it.html);
      if (it.obj) { shift(e, d); made.push(e); }
      else if (it.src && document.contains(it.src) && sectionOf(it.src) === s) { after.set(e, it.src); made.push(e); }
    });
    if (!made.length) { toast('テーマの部品(カードなど)は、同じスライドの中でだけ貼り付けられます'); return; }
    insertObjs(s, made, after);
  }
  function onCopyCut(e) {
    if (!active || typingNow() || !sels.length) return;
    e.preventDefault();
    copyParts(e.type === 'cut');
    if (e.clipboardData) e.clipboardData.setData('text/plain', CLIP_MARK);
  }
  function pasteOutside(e) {   // 文字を打っていないときの貼り付け：画像 → 画像、部品 → 部品、文字 → テキストボックス
    var cd = e.clipboardData;
    if (!cd) return;
    var file = Array.from(cd.files || []).filter(function (f) { return /^image\//.test(f.type); })[0];
    var text = cd.getData('text/plain');
    if (file) { e.preventDefault(); insertImageFile(file); return; }
    if (objClip && (text === CLIP_MARK || !text)) { e.preventDefault(); pasteParts(); return; }
    if (text && /\S/.test(text)) {
      var s = editSection();
      if (!s) return;
      e.preventDefault();
      var sz = slideSize(), tb = makeTextBox(sz.w * 0.2, sz.h * 0.4, sz.w * 0.6, text.trim());
      insertObjs(s, [tb]);
    }
  }

  /* ---- 回転のハンドル・線の端 ---- */
  function startRotate(ev) {
    var t = sel;
    if (!t) return;
    var s = sectionOf(t), r = t.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var base = getRot(t), a0 = Math.atan2(ev.clientY - cy, ev.clientX - cx), moved = false;
    function mv(m) {
      if (!moved) { moved = true; dragging = true; clearTimeout(snapTimer); snapshot(s); blurText(); }
      var d = base + (Math.atan2(m.clientY - cy, m.clientX - cx) - a0) * 180 / Math.PI;
      if (m.shiftKey) d = Math.round(d / 15) * 15;
      else { var nr = Math.round(d / 90) * 90; if (Math.abs(d - nr) < 3) d = nr; }   // 0・90・180° の近くでは吸い付く
      setRot(t, d); placeSel();
    }
    function up() {
      document.removeEventListener('pointermove', mv, true);
      document.removeEventListener('pointerup', up, true);
      dragging = false;
      if (moved) { snapshot(s); dirty.add(s); refresh(); }
    }
    document.addEventListener('pointermove', mv, true);
    document.addEventListener('pointerup', up, true);
  }
  function startLineEnd(ev, which) {
    var t = sel;
    if (!isLine(t)) return;
    var s = sectionOf(t), par = t.parentElement, ends = lineEnds(t), fixed = ends[which === 'p1' ? 1 : 0], moved = false, T = null;
    function mv(m) {
      if (!moved) { moved = true; dragging = true; clearTimeout(snapTimer); snapshot(s); T = snapTargets(s, [t]); }
      var x = m.clientX, y = m.clientY;
      if (!m.altKey && !m.shiftKey) { x += snap1([x], T.xs); y += snap1([y], T.ys); }   // ほかの部品の端・中央に吸い付く(つなぎやすく)
      var p = toLocal(par, x, y);
      if (m.shiftKey) {   // Shift：45° ごと
        var dx = p[0] - fixed[0], dy = p[1] - fixed[1], L = Math.hypot(dx, dy), q = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
        p = [fixed[0] + L * Math.cos(q), fixed[1] + L * Math.sin(q)];
      }
      if (which === 'p1') setLine(t, p, fixed); else setLine(t, fixed, p);
      renderShape(t); placeSel();
    }
    function up() {
      document.removeEventListener('pointermove', mv, true);
      document.removeEventListener('pointerup', up, true);
      dragging = false;
      if (moved) { snapshot(s); dirty.add(s); refresh(); }
    }
    document.addEventListener('pointermove', mv, true);
    document.addEventListener('pointerup', up, true);
  }

  /* ---- 位置とサイズ(数値で) ---- */
  function posDialog() {
    if (sels.length !== 1) { toast('先に、部品を 1 つ選んでください'); return; }
    closePop();
    var e = sel, k = scaleK(), c = slidesEl().getBoundingClientRect(), r = e.getBoundingClientRect();
    var w0 = e.offsetWidth, h0 = e.offsetHeight, x0 = (r.left + r.width / 2 - c.left) / k - w0 / 2, y0 = (r.top + r.height / 2 - c.top) / k - h0 / 2, rot0 = getRot(e), ln = isLine(e);
    var num = function (n, v, lab, dis) { return '<label class="pp-num">' + lab + '<input name="' + n + '" type="number" step="1" value="' + Math.round(v) + '"' + (dis ? ' disabled' : '') + '></label>'; };
    var dlg = el('<div class="pp-ed-dlg" role="dialog" aria-label="位置とサイズ"><form><h3>位置とサイズ(スライドの px。1280 × 720)</h3><div class="pp-grid2">' +
      num('x', x0, '横の位置(左端から)') + num('y', y0, '縦の位置(上端から)') + num('w', w0, '幅') + num('h', h0, '高さ', autoH(e)) + (ln ? '' : num('r', rot0, '回転(°)')) +
      '</div><label class="pp-chk"><input type="checkbox" name="lock"' + (keepsAspect(e) ? ' checked' : '') + '>縦横比を固定する</label>' +
      '<div class="pp-btns"><button type="button" data-a="cancel">キャンセル</button><button type="submit" class="pp-ok">OK</button></div></form></div>');
    var f = dlg.querySelector('form'), close = function () { dlg.remove(); };
    f.w.addEventListener('input', function () { if (f.lock.checked && w0) f.h.value = Math.round(+f.w.value * h0 / w0); });
    f.h.addEventListener('input', function () { if (f.lock.checked && h0) f.w.value = Math.round(+f.h.value * w0 / h0); });
    dlg.querySelector('[data-a=cancel]').addEventListener('click', close);
    dlg.addEventListener('mousedown', function (ev) { if (ev.target === dlg) close(); });
    dlg.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var nw = Math.max(1, +f.w.value || w0), nh = Math.max(1, +f.h.value || h0), nx = +f.x.value, ny = +f.y.value;
      close();
      selOp(function () {
        var kids = isGroup(e) ? groupKids(e) : null;
        if (Math.round(nw) !== Math.round(w0) || Math.round(nh) !== Math.round(h0)) {
          setSize(e, nw, autoH(e) ? null : nh);
          if (kids) scaleKids(kids, nw / w0, nh / h0);
        }
        var t2 = getTr(e);
        setTr(e, t2[0] + (nx - x0), t2[1] + (ny - y0));
        if (!ln && f.r) setRot(e, +f.r.value || 0);
        if (isObj(e)) renderShape(e);
      })();
    });
    document.body.appendChild(dlg);
    f.x.focus(); f.x.select();
  }

  /* ---- リンク ---- */
  function linkCmd() {
    var r = range();
    if (!r || r.collapsed) { toast('先に、リンクにしたい文字を選んでください'); return; }
    var url = global.prompt('リンク先の URL(https://… / mailto:…)', 'https://');
    if (!url || url === 'https://') return;
    url = url.trim();
    if (!/^(https?:|mailto:|#)/i.test(url)) { toast('リンクは https:// ・ http:// ・ mailto: で始まる URL だけ付けられます', 'err'); return; }
    before(function (rr) { wrap(rr, function () { var a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; return a; }); })();
  }
  var unlinkCmd = before(function (r, host) {
    var n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    var link = n && n.closest('a');
    if (!link || !host.contains(link)) { toast('リンクの付いた文字の中をクリックしてください'); return; }
    link.replaceWith.apply(link, Array.from(link.childNodes));
  });

  /* ---- ドラッグで画像を入れる ---- */
  function onDragOver(e) {
    if (!active || !e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0 || e.target.closest && e.target.closest(CHROME)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  }
  function onDrop(e) {
    if (!active || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length || e.target.closest && e.target.closest(CHROME)) return;
    var f = Array.from(e.dataTransfer.files).filter(function (x) { return /^image\//.test(x.type); })[0];
    if (!f) return;
    e.preventDefault();
    var s = editSection();
    if (s) insertImageFile(f, toLocal(s, e.clientX, e.clientY));
  }
  function onDblClick(e) {
    if (!active) return;
    var s = sectionOf(e.target);
    if (!s || s !== current()) return;
    var o = objChain(e.target, s)[0];
    if (o && textOf(o) && !hostOf(e.target)) { select(o); editText(o, false, e.clientX, e.clientY); }
  }

  /* ---- 図形の一覧(挿入 › 図形)。アイコンは同じ輪郭の関数で描く ---- */
  function shapeIcon(t) {
    var lk = LINE_KINDS[t];
    if (lk) {
      var d = lk[0] === 'elbow' ? 'M3 18H12V6H21' : 'M3 20L21 4';
      var hd = '';
      if (lk[2]) hd += lk[0] === 'elbow' ? '<path d="M17 3 21 6 17 9" fill="currentColor"/>' : '<path d="M15 4.5 21 4 19.5 10" fill="currentColor"/>';
      if (lk[1]) hd += '<path d="M3 13.5 3 20 9.5 19.5" fill="currentColor"/>';
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/>' + hd + '</svg>';
    }
    var g = geom(t, 20, 14);
    return '<svg viewBox="-2 -5 24 24" aria-hidden="true"><path d="' + g.d + '"/>' + (g.x ? '<path d="' + g.x + '"/>' : '') + '</svg>';
  }
  function galleryPop(anchor, pick, only) {
    closePop();
    var p = el('<div class="pp-ed-pop pp-ed-gal" role="menu"></div>');
    SHAPE_CATS.forEach(function (c) {
      if (only && c.head === '線') return;
      p.appendChild(el('<div class="pp-ed-pop-h"></div>')).textContent = c.head;
      var row = el('<div class="pp-ed-gal-row"></div>');
      c.items.forEach(function (it) {
        var b = el('<button type="button" title="' + it[1] + '" aria-label="' + it[1] + '">' + shapeIcon(it[0]) + '</button>');
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () { closePop(); pick(it[0]); });
        row.appendChild(b);
      });
      p.appendChild(row);
    });
    openPop(p, anchor);
  }
  function tablePop(anchor) {
    closePop();
    var R = 8, C = 10;
    var p = el('<div class="pp-ed-pop pp-ed-tblpick" role="menu"><div class="pp-ed-pop-h">表の挿入</div><div class="pp-ed-tgrid"></div><div class="pp-cap">行と列の数を選ぶ</div></div>');
    var grid = p.querySelector('.pp-ed-tgrid'), cap = p.querySelector('.pp-cap');
    for (var r = 1; r <= R; r++) for (var c = 1; c <= C; c++) {
      var b = el('<button type="button" data-r="' + r + '" data-c="' + c + '"></button>');
      grid.appendChild(b);
    }
    grid.addEventListener('mouseover', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var rr = +b.dataset.r, cc = +b.dataset.c;
      grid.querySelectorAll('button').forEach(function (x) { x.classList.toggle('pp-on', +x.dataset.r <= rr && +x.dataset.c <= cc); });
      cap.textContent = rr + ' 行 × ' + cc + ' 列の表';
    });
    grid.addEventListener('mousedown', function (e) { e.preventDefault(); });
    grid.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; closePop(); insertTable(+b.dataset.r, +b.dataset.c); });
    openPop(p, anchor);
  }
  function openPop(p, anchor) {
    var r = anchor.getBoundingClientRect();
    p.style.left = Math.min(r.left, global.innerWidth - 20) + 'px'; p.style.top = (r.bottom + 4) + 'px';
    document.body.appendChild(p);
    var pr = p.getBoundingClientRect();
    if (pr.right > global.innerWidth - 6) p.style.left = Math.max(6, global.innerWidth - pr.width - 6) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', closePopOutside, true); }, 0);
  }
  function colorChoices() {
    var out = palette().map(function (c) { return { v: 'var(--pp-ed-c' + c.n + ')', label: c.label }; });
    return out.concat([{ v: 'var(--pp-fg, #1a1a1a)', label: '文字の色(テーマ)' }, { v: 'var(--pp-bg, #ffffff)', label: '地の色(テーマ)' }, { v: '#ffffff', label: '白' }, { v: '#000000', label: '黒' }]);
  }
  var colorIn = null;
  function moreColor(apply) {   // その他の色(ブラウザの色の選択)
    if (!colorIn) { colorIn = el('<input type="color" class="pp-ed-colorin" tabindex="-1" aria-hidden="true">'); document.body.appendChild(colorIn); }
    var c = colorIn.cloneNode(); colorIn.replaceWith(c); colorIn = c;
    colorIn.addEventListener('change', function () { apply(colorIn.value)(); });
    colorIn.click();
  }
  function colorItems(apply, noneLabel) {
    var items = colorChoices().map(function (c) { return { html: '<span class="pp-ed-sw" style="background:' + c.v + '"></span>' + c.label, run: apply(c.v) }; });
    if (noneLabel) items.push({ html: '<span class="pp-ed-sw pp-none"></span>' + noneLabel, run: apply('none') });
    items.push({ html: '<span class="pp-ed-sw pp-more"></span>その他の色…', run: function () { moreColor(apply); } });
    return items;
  }
  function needSel() { if (!sels.length) { toast('先に、スライドの部品をクリックして選んでください'); return false; } return true; }
  function shapeMenu(kind, x) {
    var ln = sels.length && sels.every(isLine);
    if (kind === 'shapes') return galleryPop(x, function (t) { beginDraw({ t: t }); });
    if (kind === 'change') { if (!needSel()) return; return galleryPop(x, function (t) { changeShapeCmd(t)(); }, true); }
    if (kind === 'table') return tablePop(x);
    if (kind === 'fill') return popover(x, [{ head: '図形の塗りつぶし' }].concat(colorItems(fillCmd, '塗りつぶしなし')));
    if (kind === 'line') {
      var items = [{ head: ln ? '線の色' : '図形の枠線' }].concat(colorItems(lineCmd, ln ? null : '枠線なし'));
      items.push({ sep: true }, { head: '太さ' });
      [[0.75, 1], [1.5, 2], [2.25, 3], [3, 4], [4.5, 6], [6, 8]].forEach(function (p) { items.push({ html: '<span class="pp-ed-lw" style="height:' + p[1] + 'px"></span>' + p[0] + ' pt', run: lwCmd(p[1]) }); });
      items.push({ sep: true }, { head: '実線 / 点線' }, { html: '<span class="pp-ed-dash"></span>実線', run: dashCmd('') }, { html: '<span class="pp-ed-dash pp-d"></span>破線', run: dashCmd('dash') }, { html: '<span class="pp-ed-dash pp-o"></span>点線', run: dashCmd('dot') });
      if (ln) {
        items.push({ sep: true }, { head: '矢印' });
        [['', '', '矢印なし'], ['', 'tri', '終点に矢印'], ['tri', '', '始点に矢印'], ['tri', 'tri', '両端に矢印'], ['', 'arrow', '終点に開いた矢印'], ['oval', 'oval', '両端に丸'], ['', 'oval', '終点に丸']]
          .forEach(function (h) { items.push({ html: h[2], run: headCmd(h[0], h[1]) }); });
      }
      return popover(x, items);
    }
    if (kind === 'fx') {
      return popover(x, [{ head: '影' }, { html: '影なし', run: shadowCmd(false) }, { html: '影を付ける', run: shadowCmd(true) },
        { sep: true }, { head: '透明度(図形は塗りだけ)' }].concat([0, 0.2, 0.4, 0.6, 0.8].map(function (a) { return { html: (a * 100) + ' %', run: alphaCmd(a) }; }))
        .concat([{ sep: true }, { head: 'グラデーション(図形)' }, { html: 'なし(単色)', run: gradCmd('') }, { html: '左から右へ', run: gradCmd('h') }, { html: '上から下へ', run: gradCmd('v') }]));
    }
    if (kind === 'tc') return popover(x, [{ head: '図形の文字の色' }, { html: '<span class="pp-ed-sw"></span>自動(塗りに合わせる)', run: textColorCmd('') }].concat(colorItems(textColorCmd)));
    if (kind === 'valign') return popover(x, [{ html: I.vaT + '上揃え', run: valignCmd('top') }, { html: I.vaM + '上下中央揃え', run: valignCmd('') }, { html: I.vaB + '下揃え', run: valignCmd('bottom') }]);
    if (kind === 'order') {
      return popover(x, [{ head: '重なり順' }, { html: I.front + '最前面へ移動', run: zCmd('front') }, { html: I.fwd + '前面へ移動', run: zCmd('fwd') }, { html: I.bwd + '背面へ移動', run: zCmd('bwd') }, { html: I.back + '最背面へ移動', run: zCmd('back') },
        { sep: true }, { head: 'グループ' }, { html: I.group + 'グループ化 ⌘G', run: groupSel }, { html: I.ungroup + 'グループ解除 ⌘⇧G', run: ungroupSel },
        { sep: true }, { head: '回転' }, { html: I.rotR + '右へ 90° 回転', run: rotateCmd(90) }, { html: I.rotL + '左へ 90° 回転', run: rotateCmd(-90) }, { html: I.flipV + '上下反転', run: flipCmd('v') }, { html: I.flipH + '左右反転', run: flipCmd('h') },
        { sep: true }, { html: I.sizepos + '位置とサイズ…', run: posDialog }, { html: I.dup + '複製 ⌘D', run: duplicateParts }]);
    }
    if (kind === 'rot') {
      return popover(x, [{ html: I.rotR + '右へ 90° 回転', run: rotateCmd(90) }, { html: I.rotL + '左へ 90° 回転', run: rotateCmd(-90) }, { html: I.flipV + '上下反転', run: flipCmd('v') }, { html: I.flipH + '左右反転', run: flipCmd('h') },
        { sep: true }, { html: '回転を元に戻す', run: rotReset }]);
    }
    if (kind === 'zf') return popover(x, [{ html: I.front + '最前面へ移動 ⌘⇧]', run: zCmd('front') }, { html: I.fwd + '前面へ移動 ⌘]', run: zCmd('fwd') }]);
    if (kind === 'zb') return popover(x, [{ html: I.back + '最背面へ移動 ⌘⇧[', run: zCmd('back') }, { html: I.bwd + '背面へ移動 ⌘[', run: zCmd('bwd') }]);
    if (kind === 'grp') return popover(x, [{ html: I.group + 'グループ化 ⌘G', run: groupSel }, { html: I.ungroup + 'グループ解除 ⌘⇧G', run: ungroupSel }]);
  }

  /* 図形の書式・テーブルのタブは、図形・表を選んでいるときだけ出す(PowerPoint のコンテキスト タブ) */
  function updateCtxTabs() {
    if (!bar) return;
    var st = { shape: sels.length > 0, table: inTable() }, gone = false;
    bar.querySelectorAll('.pp-ed-tab.pp-ctx').forEach(function (b) {
      var on = !!st[b.getAttribute('data-ctx')];
      if (b.hidden === on) b.hidden = !on;
      if (!on && b.getAttribute('data-tab') === tab) gone = true;
    });
    if (gone) { tab = 'home'; renderPanel(); }
  }

  /* ------------------------------------------------------------ リボン */

  function layouts() {
    return Array.from(document.querySelectorAll('template[data-pp-layout]')).map(function (t) {
      return { name: t.getAttribute('data-pp-layout'), html: t.innerHTML };
    });
  }
  function newSlideMenu(anchor) {
    var items = [{ head: 'レイアウト' }];
    layouts().forEach(function (l) { items.push({ html: l.name, run: function () { newFromLayout(l.html); } }); });
    if (!layouts().length) items.push({ html: '白紙（タイトルと本文）', run: function () { newFromLayout(BLANK); } });
    items.push({ sep: true }, { html: 'このスライドを複製', run: duplicate });
    popover(anchor, items);
  }
  function sectionMenu(anchor) {
    var i = model ? markBefore(current()) : -1;
    var items = [{ head: i >= 0 ? '今のセクション：' + model[i].label : 'セクション' }, { html: 'ここからセクションを始める', run: addSection }];
    if (i >= 0) items.push({ html: '名前を変える', run: renameSection }, { html: '区切りを外す', run: removeSection });
    popover(anchor, items);
  }

  /* リボンのアイコン(線画。24×24、currentColor) */
  function svg(d) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>'; }
  var I = {
    save: svg('<path d="M5 3.5h11l3.5 3.5v13.5H5z"/><path d="M8 3.5v5h7.5v-5"/><rect x="8" y="13" width="8" height="7.5"/>'),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    newslide: svg('<rect x="2.5" y="4" width="15" height="11" rx="1.5"/><path d="M19.5 14v7M16 17.5h7"/>'),
    dup: svg('<rect x="7" y="8" width="14" height="10" rx="1.5"/><path d="M3.5 15V5.5A1.5 1.5 0 0 1 5 4h12.5"/>'),
    del: svg('<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>'),
    reset: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>'),
    up: svg('<path d="M12 19.5v-15M6 10.5l6-6 6 6"/>'),
    down: svg('<path d="M12 4.5v15M6 13.5l6 6 6-6"/>'),
    sec: svg('<path d="M3 5.5h6.5l2 2.5H21v11.5H3z"/>'),
    cut: svg('<circle cx="6" cy="18" r="2.8"/><circle cx="18" cy="18" r="2.8"/><path d="M8 15.8 17.5 3.5M16 15.8 6.5 3.5"/>'),
    copy: svg('<rect x="8" y="8" width="12" height="13" rx="1.5"/><path d="M4 16V4.5A1.5 1.5 0 0 1 5.5 3H15"/>'),
    paste: svg('<rect x="5" y="4.5" width="14" height="16.5" rx="1.5"/><rect x="9" y="2.5" width="6" height="4" rx="1"/><path d="M8.5 11h7M8.5 15h5"/>'),
    painter: svg('<rect x="4" y="3" width="13" height="5.5" rx="1"/><path d="M17 5.5h3v5.5h-8v3"/><rect x="10.5" y="14" width="3" height="7" rx="1"/>'),
    hl: svg('<path d="m14.5 3.5 5 5-8.5 8.5H6v-5z"/><path d="m12 6 5 5"/><rect x="3" y="19.5" width="18" height="3" fill="#facc15" stroke="none"/>'),
    clear: svg('<path d="M4.5 19 10 5h1.5l3 7.5M6.5 14h6"/><path d="m15.5 15.5 5 5M20.5 15.5l-5 5"/>'),
    ul: svg('<circle cx="5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.3" fill="currentColor" stroke="none"/><path d="M9.5 6H20M9.5 12H20M9.5 18H20"/>'),
    ol: svg('<path d="M9.5 6H20M9.5 12H20M9.5 18H20"/><path d="M4 4.5h1.3V9M3.6 9h3.2"/><path d="M3.6 14.6c.4-.6 1-.9 1.6-.9.9 0 1.5.6 1.5 1.3 0 1.1-1.5 1.8-3 3.5h3.1"/>'),
    out: svg('<path d="M11 6.5h9M11 12h9M11 17.5h9"/><path d="M7.5 9 4.5 12l3 3"/>'),
    ind: svg('<path d="M11 6.5h9M11 12h9M11 17.5h9"/><path d="m4.5 9 3 3-3 3"/>'),
    lh: svg('<path d="M11 6h9M11 12h9M11 18h9"/><path d="M5.5 4v16M3.3 6.3 5.5 4l2.2 2.3M3.3 17.7 5.5 20l2.2-2.3"/>'),
    al: svg('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
    ac: svg('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
    ar: svg('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
    aj: svg('<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>'),
    outer: svg('<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.2"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
    resetpos: svg('<rect x="9.5" y="9.5" width="11" height="11" rx="1" stroke-dasharray="3 2"/><rect x="3.5" y="3.5" width="9" height="9" rx="1"/><path d="M16 4.5h2a2 2 0 0 1 2 2v2"/>'),
    delpart: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="m9 9 6 6M15 9l-6 6"/>'),
    name: svg('<path d="M3.5 7.5V4.5a1 1 0 0 1 1-1h3M3.5 16.5v3a1 1 0 0 0 1 1h3M16.5 3.5h3a1 1 0 0 1 1 1v3M20.5 16.5v3a1 1 0 0 1-1 1h-3"/><path d="M7.5 9h9M12 9v7.5"/>'),
    alL: svg('<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4" rx="1"/><rect x="7" y="14" width="8" height="4" rx="1"/>'),
    alC: svg('<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="7.5" y="14" width="9" height="4" rx="1"/>'),
    alR: svg('<path d="M20 3v18"/><rect x="5" y="6" width="12" height="4" rx="1"/><rect x="9" y="14" width="8" height="4" rx="1"/>'),
    alT: svg('<path d="M3 4h18"/><rect x="6" y="7" width="4" height="12" rx="1"/><rect x="14" y="7" width="4" height="8" rx="1"/>'),
    alM: svg('<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="7.5" width="4" height="9" rx="1"/>'),
    alB: svg('<path d="M3 20h18"/><rect x="6" y="5" width="4" height="12" rx="1"/><rect x="14" y="9" width="4" height="8" rx="1"/>'),
    dsH: svg('<path d="M3 3v18M21 3v18"/><rect x="9" y="7" width="6" height="10" rx="1"/>'),
    dsV: svg('<path d="M3 3h18M3 21h18"/><rect x="7" y="9" width="10" height="6" rx="1"/>'),
    arrange: svg('<rect x="3" y="3" width="9" height="9" rx="1"/><rect x="12" y="12" width="9" height="9" rx="1"/><path d="M15 3.5h4a1.5 1.5 0 0 1 1.5 1.5v4M9 20.5H5A1.5 1.5 0 0 1 3.5 19v-4"/>'),
    selall: svg('<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.2"/><path d="m8 12 3 3 5-6"/>'),
    pdf: svg('<path d="M6 2.5h8.5L19 7v14.5H6z"/><path d="M14.5 2.5V7H19"/><path d="M8.5 16.5v-4h1.6a1.2 1.2 0 0 1 0 2.4H8.5M13 12.5v4h1a2 2 0 0 0 0-4zM18 12.5h-2v4M16 14.5h1.6" stroke-width="1.3"/>'),
    pptx: svg('<rect x="2.5" y="4" width="13" height="16" rx="1.5"/><path d="M6 15.5v-7h2.6a2.2 2.2 0 0 1 0 4.4H6"/><path d="M15.5 8h5v8h-5"/>'),
    notes: svg('<rect x="4" y="3.5" width="16" height="17" rx="1.5"/><path d="M8 8.5h8M8 12h8M8 15.5h5"/>'),
    eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
    deck: svg('<rect x="3" y="4" width="18" height="13" rx="2" fill="#c43e1c" stroke="none"/><path d="M8 20.5h8M12 17v3.5" stroke="#c43e1c"/><path d="M7.5 13.5v-6h3.2a2 2 0 0 1 0 4H7.5" stroke="#fff" stroke-width="1.8"/>'),
    show: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>'),
    caret: '<svg class="pp-ed-caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>',
    shapes: svg('<rect x="3" y="11" width="9" height="9" rx="1"/><circle cx="16.5" cy="8" r="4.5"/><path d="M8 3.5 12.5 10h-9z"/>'),
    tbox: svg('<rect x="3" y="4" width="18" height="16" rx="1.5" stroke-dasharray="2.6 2"/><path d="M8 8.5h8M12 8.5v8"/>'),
    image: svg('<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="m3.5 17 5.5-5 4 3.5 3-2.5 4.5 4"/>'),
    table: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 14.5h18M9 4v16M15 4v16"/>'),
    link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3.3-3.3a4 4 0 0 0-5.7-5.7L12 6.3"/><path d="M14 10a4 4 0 0 0-5.7 0L5 13.3A4 4 0 0 0 10.7 19l1.3-1.3"/>'),
    unlink: svg('<path d="M13.3 5l.4-.4a4 4 0 0 1 5.7 5.7l-1.6 1.6M10.7 19l-.4.4a4 4 0 0 1-5.7-5.7l1.6-1.6"/><path d="M4 4l16 16"/>'),
    front: svg('<rect x="3" y="3" width="10" height="10" rx="1" stroke-dasharray="2.4 1.8"/><rect x="9" y="9" width="12" height="12" rx="1" fill="currentColor" fill-opacity=".35"/>'),
    fwd: svg('<rect x="3" y="3" width="11" height="11" rx="1" stroke-dasharray="2.4 1.8"/><rect x="10" y="10" width="11" height="11" rx="1" fill="currentColor" fill-opacity=".2"/><path d="M15.5 6.5h3v3"/>'),
    bwd: svg('<rect x="10" y="10" width="11" height="11" rx="1" stroke-dasharray="2.4 1.8"/><rect x="3" y="3" width="11" height="11" rx="1" fill="currentColor" fill-opacity=".2"/><path d="M8.5 17.5h-3v-3"/>'),
    back: svg('<rect x="9" y="9" width="12" height="12" rx="1" fill="currentColor" fill-opacity=".35"/><rect x="3" y="3" width="10" height="10" rx="1" fill="#fff"/>'),
    rotR: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v4.5H15"/>'),
    rotL: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5v4.5H9"/>'),
    flipH: svg('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6 3 18h6zM15 6l6 12h-6z"/>'),
    flipV: svg('<path d="M3 12h18" stroke-dasharray="2 2"/><path d="M6 9 18 3v6zM6 15l12 6v-6z"/>'),
    group: svg('<rect x="2.5" y="2.5" width="19" height="19" rx="1" stroke-dasharray="2.4 2"/><rect x="6" y="6" width="6" height="6" rx="1"/><circle cx="15" cy="15" r="3.2"/>'),
    ungroup: svg('<rect x="3" y="3" width="8" height="8" rx="1"/><circle cx="16.5" cy="16.5" r="4"/><path d="M13 4h7v7M4 13v7h7" stroke-dasharray="2 1.8"/>'),
    fill: svg('<path d="m10 3 8 8-6.5 6.5a2 2 0 0 1-2.8 0L3.5 12.3a2 2 0 0 1 0-2.8z"/><path d="M4 11h13"/><path d="M20 14.5s1.8 2.2 1.8 3.4a1.8 1.8 0 0 1-3.6 0c0-1.2 1.8-3.4 1.8-3.4z"/>'),
    pen: svg('<path d="m14.5 4.5 5 5L9 20H4v-5z"/><path d="m12 7 5 5"/>'),
    fx: svg('<rect x="3" y="3" width="13" height="13" rx="2"/><path d="M19 7.5V19a2 2 0 0 1-2 2H7.5" stroke-width="2.6" stroke-opacity=".45"/>'),
    sizepos: svg('<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M3 3v4M3 3h4M21 21v-4M21 21h-4M3 21h4M3 21v-4M21 3h-4M21 3v4"/>'),
    vaT: svg('<path d="M4 4h16"/><path d="M8 8h8M9.5 12h5"/>'),
    vaM: svg('<path d="M8 10h8M9.5 14h5"/><path d="M4 4h16M4 20h16" stroke-opacity=".4"/>'),
    vaB: svg('<path d="M4 20h16"/><path d="M8 12h8M9.5 16h5"/>'),
    change: svg('<rect x="3" y="3" width="8" height="8" rx="1"/><circle cx="17" cy="17" r="4"/><path d="M14 5h4.5v4.5M10 19H5.5v-4.5"/>'),
    rowA: svg('<rect x="3" y="11" width="18" height="10" rx="1"/><path d="M3 16h18M12 2.5v6M9 5.5h6"/>'),
    rowB: svg('<rect x="3" y="3" width="18" height="10" rx="1"/><path d="M3 8h18M12 15.5v6M9 18.5h6"/>'),
    colL: svg('<rect x="11" y="3" width="10" height="18" rx="1"/><path d="M16 3v18M2.5 12h6M5.5 9v6"/>'),
    colR: svg('<rect x="3" y="3" width="10" height="18" rx="1"/><path d="M8 3v18M15.5 12h6M18.5 9v6"/>'),
    delRow: svg('<rect x="3" y="7" width="18" height="10" rx="1"/><path d="m9 9.5 6 5M15 9.5l-6 5"/>'),
    delCol: svg('<rect x="7" y="3" width="10" height="18" rx="1"/><path d="m9.5 9 5 6M14.5 9l-5 6"/>'),
    thead: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9.5h18" stroke-width="3.2"/><path d="M3 15h18"/>'),
    band: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9.5h18M3 15h18"/><rect x="3" y="9.5" width="18" height="5.5" fill="currentColor" fill-opacity=".3" stroke="none"/>'),
  };
  /* リボン(PowerPoint for the web の 1 行のリボン)。タブ → グループ → ボタン [キー, 中身, 説明, 処理, 表示する文字]
     処理が 'menu:名前' ならメニューを開く。幅が足りないときは後ろのグループから「…」に入る */
  var TABS = [
    { id: 'file', label: 'ファイル', groups: [
      [['save', I.save, '保存 ⌘S', save, '保存'], ['name', I.name, '名前の変更(タイトル・配るファイル名・冊・ページ)', function () { nameDialog(); }, '名前の変更']],
      [['pdf', I.pdf, 'PDF に書き出す(印刷の画面で「PDF として保存」)', exportPdf, 'PDF に書き出す'], ['pptx', I.pptx, 'PowerPoint(.pptx)に書き出す', exportPptx, 'PowerPoint に書き出す']],
      [['show2', I.show, 'このスライドから発表する(全画面)', function () { slideShow(); }, 'スライドショー']]] },
    { id: 'home', label: 'ホーム', groups: [
      [['undo', I.undo, '元に戻す ⌘Z', doUndo], ['redo', I.redo, 'やり直し ⌘⇧Z', doRedo]],
      [['paste', I.paste, '貼り付け(書式なし)', pasteBtn], ['cut', I.cut, '切り取り', clip('cut')], ['copy', I.copy, 'コピー', clip('copy')], ['painter', I.painter, '書式のコピー', startPainter]],
      [['new', I.newslide + '<span class="pp-t">新しいスライド</span>' + I.caret, '新しいスライド(レイアウトを選ぶ)', 'menu:new'], ['dup', I.dup, 'スライドの複製', duplicate], ['del', I.del, 'スライドの削除', deleteSlide], ['reset', I.reset, 'リセット(保存した状態に戻す)', resetSlide]],
      [['b', '<b class="pp-g">B</b>', '太字 ⌘B', exec('bold')], ['i', '<i class="pp-g">I</i>', '斜体 ⌘I', exec('italic')], ['u', '<u class="pp-g">U</u>', '下線 ⌘U', exec('underline')],
       ['s', '<s class="pp-g">S</s>', '取り消し線', exec('strikeThrough')], ['sup', '<span class="pp-g">x<sup>2</sup></span>', '上付き', exec('superscript')], ['sub', '<span class="pp-g">x<sub>2</sub></span>', '下付き', exec('subscript')],
       ['grow', '<span class="pp-g">A<sup>+</sup></span>', '文字を大きく', sizeCmd(2)], ['shrink', '<span class="pp-g">A<sup>−</sup></span>', '文字を小さく', sizeCmd(-2)],
       ['hl', I.hl, '蛍光ペン', highlight], ['color', '<span class="pp-g pp-ed-ga">A<span class="pp-ed-bar-c"></span></span>' + I.caret, '文字の色', 'menu:color'], ['clear', I.clear, '書式のクリア', clearFmt]],
      [['ul', I.ul, '箇条書き', listCmd(false)], ['ol', I.ol, '段落番号', listCmd(true)], ['out', I.out, 'インデントを減らす', indent(-24)], ['in', I.ind, 'インデントを増やす', indent(24)],
       ['para', I.al + I.caret, '文字の配置(左・中央・右・両端)', 'menu:para'], ['lh', I.lh + I.caret, '行間', 'menu:lh']],
      [['h-shapes', I.shapes + '<span class="pp-t">図形</span>' + I.caret, '図形を挿入(四角形・矢印・線・吹き出しなど)', 'menu:shapes'], ['h-tbox', I.tbox, 'テキストボックスを挿入', function () { beginDraw({ t: 'text' }); }],
       ['h-fill', I.fill + I.caret, '図形の塗りつぶし', 'menu:fill'], ['h-line', I.pen + I.caret, '図形の枠線(色・太さ・破線・矢印)', 'menu:line'], ['h-order', I.front + I.caret, '重なり順・グループ・回転・位置とサイズ', 'menu:order']],
      [['arrange', I.arrange + '<span class="pp-t">揃える</span>' + I.caret, '揃える・等間隔に並べる(2 つ以上なら選んだ範囲、1 つならスライドに合わせる)', 'menu:align'],
       ['outer', I.outer, '外側の部品を選ぶ', selectOuter], ['selall', I.selall, 'このスライドの部品を全部選ぶ ⌘A', selectAll], ['resetpos', I.resetpos, '部品の位置と大きさを元に戻す', resetPos], ['delpart', I.delpart, '部品を削除 Delete', deletePart]]] },
    { id: 'insert', label: '挿入', groups: [
      [['i-new', I.newslide + '<span class="pp-t">新しいスライド</span>' + I.caret, '新しいスライド(レイアウトを選ぶ)', 'menu:new']],
      [['i-table', I.table + '<span class="pp-t">表</span>' + I.caret, '表を挿入(行と列の数を選ぶ)', 'menu:table'],
       ['i-image', I.image + '<span class="pp-t">画像</span>', '画像を挿入(ファイルから。コピーした画像の貼り付け・ファイルのドラッグでも入る)', pickImage]],
      [['i-shapes', I.shapes + '<span class="pp-t">図形</span>' + I.caret, '図形を挿入(四角形・矢印・線・吹き出しなど)', 'menu:shapes'],
       ['i-tbox', I.tbox + '<span class="pp-t">テキストボックス</span>', 'テキストボックスを挿入(クリックした所に置く。ドラッグで幅)', function () { beginDraw({ t: 'text' }); }]],
      [['i-link', I.link + '<span class="pp-t">リンク</span>', 'リンクを付ける(先に文字を選ぶ)', linkCmd], ['i-unlink', I.unlink, 'リンクを外す', unlinkCmd]]] },
    { id: 'arrange', label: '配置', groups: [
      [['a-l', I.alL, '左揃え', alignCmd('l'), '左'], ['a-c', I.alC, '左右中央揃え', alignCmd('c'), '中央'], ['a-r', I.alR, '右揃え', alignCmd('r'), '右']],
      [['a-t', I.alT, '上揃え', alignCmd('t'), '上'], ['a-m', I.alM, '上下中央揃え', alignCmd('m'), '中央'], ['a-b', I.alB, '下揃え', alignCmd('b'), '下']],
      [['d-h', I.dsH, '左右に等間隔(3 つ以上)', distribute(true), '左右に等間隔'], ['d-v', I.dsV, '上下に等間隔(3 つ以上)', distribute(false), '上下に等間隔']],
      [['z-front', I.front, '最前面へ移動 ⌘⇧]', zCmd('front'), '最前面へ'], ['z-fwd', I.fwd, '前面へ移動 ⌘]', zCmd('fwd'), '前面へ'], ['z-bwd', I.bwd, '背面へ移動 ⌘[', zCmd('bwd'), '背面へ'], ['z-back', I.back, '最背面へ移動(テーマの部品より後ろ) ⌘⇧[', zCmd('back'), '最背面へ']],
      [['grp', I.group, 'グループ化 ⌘G', groupSel, 'グループ化'], ['ungrp', I.ungroup, 'グループ解除 ⌘⇧G', ungroupSel, '解除'], ['rot', I.rotR + I.caret, '回転・反転', 'menu:rot', '回転'],
       ['size', I.sizepos, '位置とサイズを数値で指定', posDialog, '位置とサイズ'], ['dup-p', I.dup, '部品の複製 ⌘D', duplicateParts, '複製']],
      [['outer2', I.outer, '外側の部品を選ぶ', selectOuter, '外側を選ぶ'], ['selall2', I.selall, '全部選ぶ ⌘A', selectAll, '全部選ぶ'], ['resetpos2', I.resetpos, '位置と大きさを元に戻す', resetPos, '元の位置'], ['delpart2', I.delpart, '部品を削除', deletePart, '削除']],
      [['up', I.up, 'スライドを前へ移動', function () { move(-1); }, 'スライドを前へ'], ['down', I.down, 'スライドを後ろへ移動', function () { move(1); }, '後ろへ'], ['sec', I.sec + I.caret, 'セクション', 'menu:sec', 'セクション']]] },
    { id: 'view', label: '表示', groups: [
      [['notes2', I.notes, 'ノートの表示 / 非表示', function () { toggleNotes(); }, 'ノート'], ['resetlay', I.reset, '一覧の幅とノートの高さを元に戻す', function () { lay.side = 236; lay.notes = 150; lay.showNotes = true; applyLayout(); saveLayout(); relayout(); }, '大きさを元に戻す']],
      [['show3', I.show, 'このスライドから発表する(全画面)', function () { slideShow(); }, 'スライドショー'], ['exit2', I.eye, '編集画面を閉じて閲覧表示にする(E で戻る)', function () { stop(); }, '閲覧表示']]] },
    { id: 'shape', label: '図形の書式', ctx: 'shape', groups: [
      [['s-shapes', I.shapes + I.caret, '図形を挿入', 'menu:shapes'], ['s-change', I.change + '<span class="pp-t">図形の変更</span>' + I.caret, '選んだ図形の形を変える', 'menu:change']],
      [['s-fill', I.fill + '<span class="pp-t">塗りつぶし</span>' + I.caret, '図形の塗りつぶし(テーマの色・その他の色・なし)', 'menu:fill'],
       ['s-line', I.pen + '<span class="pp-t">枠線</span>' + I.caret, '図形の枠線・線(色・太さ・破線・矢印)', 'menu:line'],
       ['s-fx', I.fx + '<span class="pp-t">効果</span>' + I.caret, '図形の効果(影・透明度・グラデーション)', 'menu:fx']],
      [['s-tc', '<span class="pp-g pp-ed-ga">A<span class="pp-ed-bar-c"></span></span>' + I.caret, '図形の文字の色', 'menu:tc'], ['s-va', I.vaM + I.caret, '文字の上下の配置', 'menu:valign']],
      [['s-zf', I.front + '<span class="pp-t">前面へ</span>' + I.caret, '前面へ移動', 'menu:zf'], ['s-zb', I.back + '<span class="pp-t">背面へ</span>' + I.caret, '背面へ移動', 'menu:zb'],
       ['s-grp', I.group + I.caret, 'グループ化 / 解除', 'menu:grp'], ['s-rot', I.rotR + I.caret, '回転・反転', 'menu:rot'], ['s-al', I.arrange + I.caret, '揃える・等間隔', 'menu:align']],
      [['s-size', I.sizepos + '<span class="pp-t">位置とサイズ</span>', '位置とサイズを数値で指定', posDialog], ['s-dup', I.dup, '複製 ⌘D', duplicateParts], ['s-del', I.delpart, '削除 Delete', deletePart]]] },
    { id: 'table', label: 'テーブル', ctx: 'table', groups: [
      [['t-ra', I.rowA, '上に行を挿入', rowAbove, '上に行'], ['t-rb', I.rowB, '下に行を挿入', rowBelow, '下に行'], ['t-cl', I.colL, '左に列を挿入', colLeft, '左に列'], ['t-cr', I.colR, '右に列を挿入', colRight, '右に列']],
      [['t-dr', I.delRow, '行を削除', delRow, '行の削除'], ['t-dc', I.delCol, '列を削除', delCol, '列の削除'], ['t-dt', I.del, '表を削除', delTable, '表の削除']],
      [['t-head', I.thead, '見出しの行(1 行目)のオン / オフ', toggleHead, '見出しの行'], ['t-band', I.band, '縞模様の行のオン / オフ', toggleBand, '縞模様'], ['t-fill', I.fill + I.caret, '選んだ部品(セル・表の見出し)の塗りつぶし', 'menu:fill', '塗りつぶし']]] },
  ];
  var tab = 'home';

  function palette() {
    var cs = getComputedStyle(document.documentElement);
    var out = [];
    for (var i = 1; i <= 6; i++) {
      var v = cs.getPropertyValue('--pp-ed-c' + i).trim();
      if (!v) continue;
      var label = (cs.getPropertyValue('--pp-ed-c' + i + '-label') || '').trim().replace(/^["']|["']$/g, '') || ('色 ' + i);
      out.push({ n: i, label: label });
    }
    if (!out.length) out.push({ n: 1, label: '強調' });
    return out;
  }
  function popover(anchor, items) {
    closePop();
    var p = el('<div class="pp-ed-pop" role="menu"></div>');
    items.forEach(function (it) {
      if (it.sep) { p.appendChild(document.createElement('hr')); return; }
      if (it.head) { p.appendChild(el('<div class="pp-ed-pop-h"></div>')).textContent = it.head; return; }
      var b = el('<button type="button">' + it.html + '</button>');
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { closePop(); it.run(); });
      p.appendChild(b);
    });
    var r = anchor.getBoundingClientRect();
    p.style.left = r.left + 'px'; p.style.top = (r.bottom + 4) + 'px';
    document.body.appendChild(p);
    setTimeout(function () { document.addEventListener('mousedown', closePopOutside, true); }, 0);
  }
  function closePopOutside(e) { if (!e.target.closest('.pp-ed-pop')) closePop(); }
  function closePop() {
    document.querySelectorAll('.pp-ed-pop').forEach(function (p) { p.remove(); });
    document.removeEventListener('mousedown', closePopOutside, true);
  }
  function menu(kind, x) {
    if (/^(shapes|change|table|fill|line|fx|tc|valign|order|rot|zf|zb|grp)$/.test(kind)) return shapeMenu(kind, x);
    if (kind === 'new') return newSlideMenu(x);
    if (kind === 'sec') return sectionMenu(x);
    if (kind === 'align') {
      var one = sels.length === 1;
      return popover(x, [{ head: one ? 'スライドに合わせる(1 つを選択中)' : sels.length ? '選んだ ' + sels.length + ' 個の範囲に合わせる' : '先に部品を選んでください' },
        { html: I.alL + '左揃え', run: alignCmd('l') }, { html: I.alC + '左右中央揃え', run: alignCmd('c') }, { html: I.alR + '右揃え', run: alignCmd('r') },
        { sep: true }, { html: I.alT + '上揃え', run: alignCmd('t') }, { html: I.alM + '上下中央揃え', run: alignCmd('m') }, { html: I.alB + '下揃え', run: alignCmd('b') },
        { sep: true }, { html: I.dsH + '左右に等間隔', run: distribute(true) }, { html: I.dsV + '上下に等間隔', run: distribute(false) }]);
    }
    if (kind === 'color') {
      return popover(x, [{ html: '<span class="pp-ed-sw"></span>標準', run: colorCmd(0) }].concat(palette().map(function (c) {
        return { html: '<span class="pp-ed-sw pp-c' + c.n + '-sw"></span>' + c.label, run: colorCmd(c.n) };
      })));
    }
    if (kind === 'para') {
      return popover(x, [{ html: I.al + '左揃え', run: blockStyle('textAlign', '') }, { html: I.ac + '中央揃え', run: blockStyle('textAlign', 'center') },
        { html: I.ar + '右揃え', run: blockStyle('textAlign', 'right') }, { html: I.aj + '両端揃え', run: blockStyle('textAlign', 'justify') }]);
    }
    if (kind === 'lh') {
      return popover(x, ['', '1.2', '1.4', '1.6', '1.8', '2.0'].map(function (v) { return { html: v || '標準', run: blockStyle('lineHeight', v) }; }));
    }
  }

  function button(k, html, tip, fn, cls) {
    var x = el('<button type="button"' + (cls ? ' class="' + cls + '"' : '') + ' data-k="' + k + '" data-tip="' + tip + '" aria-label="' + tip.replace(/<[^>]+>/g, '') + '">' + html + '</button>');
    x.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 選択範囲を失わない
    x.addEventListener('click', function () { if (typeof fn === 'string') menu(fn.slice(5), x); else fn(); });
    return x;
  }
  var status = null;
  function K(k) { return (bar && bar.querySelector('[data-k="' + k + '"]')) || (status && status.querySelector('[data-k="' + k + '"]')); }
  /* マウスを乗せたときの説明。画面の外にはみ出さないよう位置を合わせる */
  var tipEl = null, tipFor = null;
  function showTip(e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (!t || !(bar.contains(t) || status.contains(t))) { hideTip(); return; }
    if (t === tipFor) return;
    tipFor = t;
    if (!tipEl) { tipEl = el('<div class="pp-ed-tip" role="tooltip"></div>'); document.body.appendChild(tipEl); }
    tipEl.textContent = t.getAttribute('data-tip');
    tipEl.style.display = 'block';
    var r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var x = Math.max(6, Math.min(global.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    var y = r.bottom + 6; if (y + h > global.innerHeight - 4) y = r.top - h - 6;
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  }
  function hideTip() { tipFor = null; if (tipEl) tipEl.style.display = 'none'; }
  function buildBar() {
    bar = el('<div class="pp-ed-bar" role="toolbar" aria-label="編集">' +
      '<div class="pp-ed-titlebar"><span class="pp-ed-app"></span></div>' +
      '<div class="pp-ed-tabs" role="tablist"></div>' +
      '<div class="pp-ed-ribbon"><div class="pp-ed-panel"></div></div></div>');
    var tb = bar.querySelector('.pp-ed-titlebar');
    tb.firstChild.innerHTML = I.deck;
    tb.appendChild(button('autosave', '<span class="pp-t">自動保存</span><span class="pp-sw"></span><span class="pp-st">オン</span>', '直すたびに自動で保存します', toggleAuto, 'pp-ed-auto'));
    tb.appendChild(button('title', '', 'クリックで名前を変える', function () { nameDialog(); }, 'pp-ed-title'));
    tb.appendChild(el('<span class="pp-ed-dirty" data-k="dirty"></span>'));
    tb.appendChild(button('save', I.save + '<span class="pp-t">保存</span>', '保存 ⌘S', save, 'pp-ed-savebtn'));
    var tabs = bar.querySelector('.pp-ed-tabs');
    TABS.forEach(function (t) {
      var b = el('<button type="button" role="tab" class="pp-ed-tab' + (t.ctx ? ' pp-ctx' : '') + '" data-tab="' + t.id + '"' + (t.ctx ? ' data-ctx="' + t.ctx + '" hidden' : '') + '></button>');
      b.textContent = t.label;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { tab = t.id; renderPanel(); });
      tabs.appendChild(b);
    });
    var right = el('<div class="pp-ed-tabs-r"></div>');
    right.appendChild(button('show', I.show + '<span class="pp-t">スライドショー</span>', 'このスライドから発表する(全画面)。全画面を抜けると編集に戻る', slideShow, 'pp-ed-show'));
    right.appendChild(button('exit', I.eye + '<span class="pp-t">閲覧表示</span>', '編集画面を閉じて閲覧表示にする(E で戻る)', function () { stop(); }, 'pp-ed-exit'));
    tabs.appendChild(right);
    document.body.appendChild(bar);
    status = el('<div class="pp-ed-status"><span class="pp-ed-pos" data-k="pos"></span><span class="pp-ed-key" data-k="key"></span><span class="pp-ed-sp"></span></div>');
    status.appendChild(button('notes', I.notes + '<span class="pp-t">ノート</span>', 'ノートの表示 / 非表示', toggleNotes, 'pp-ed-notes-btn'));
    document.body.appendChild(status);
    renderPanel();
    global.addEventListener('resize', fitPanel);
    [bar, status].forEach(function (x) { x.addEventListener('mouseover', showTip); x.addEventListener('mouseleave', hideTip); x.addEventListener('mousedown', hideTip); });
  }
  function renderPanel() {
    var panel = bar.querySelector('.pp-ed-panel'), t = TABS.filter(function (x) { return x.id === tab; })[0];
    bar.querySelectorAll('.pp-ed-tab').forEach(function (b) { b.classList.toggle('pp-on', b.getAttribute('data-tab') === tab); b.setAttribute('aria-selected', b.getAttribute('data-tab') === tab); });
    panel.innerHTML = '';
    t.groups.forEach(function (g, gi) {
      var grp = el('<div class="pp-ed-grp" data-g="' + gi + '"></div>');
      g.forEach(function (b) { grp.appendChild(button(b[0], b[1] + (b[4] ? '<span class="pp-t">' + b[4] + '</span>' : ''), b[2], b[3], b[4] ? 'pp-lab' : '')); });
      panel.appendChild(grp);
    });
    var more = button('more', I.more, 'ほかの操作', function () { moreMenu(more); }, 'pp-ed-more');
    panel.appendChild(more);
    fitPanel();
    applyLayout();
  }
  /* 幅に収まらないグループは隠して「…」から使う */
  function fitPanel() {
    if (!bar) return;
    var panel = bar.querySelector('.pp-ed-panel'), grps = Array.from(panel.querySelectorAll('.pp-ed-grp')), more = panel.querySelector('.pp-ed-more');
    grps.forEach(function (g) { g.hidden = false; });
    more.hidden = true;
    var avail = panel.parentElement.clientWidth - 16;
    if (panel.scrollWidth <= avail) return;
    more.hidden = false;
    for (var i = grps.length - 1; i > 0 && panel.scrollWidth > avail; i--) grps[i].hidden = true;
  }
  function moreMenu(anchor) {
    var t = TABS.filter(function (x) { return x.id === tab; })[0], items = [];
    bar.querySelectorAll('.pp-ed-panel .pp-ed-grp[hidden]').forEach(function (g) {
      if (items.length) items.push({ sep: true });
      t.groups[+g.getAttribute('data-g')].forEach(function (b) {
        items.push({ html: b[1].replace(I.caret, '') + '<span>' + b[2].replace(/ ⌘.*$/, '') + '</span>', run: typeof b[3] === 'string' ? function () { menu(b[3].slice(5), anchor); } : b[3] });
      });
    });
    popover(anchor, items);
  }

  /* ------------------------------------------------------ スライド一覧 */

  function slideSize() {
    var c = deck.getConfig ? deck.getConfig() : {};
    return { w: +c.width || 1280, h: +c.height || 720 };
  }
  function buildSide() {
    side = el('<nav class="pp-ed-side" aria-label="スライド一覧"></nav>');
    side.addEventListener('click', function (e) {
      var r = e.target.closest('.pp-sl'); if (r) deck.slide(+r.dataset.i);
    });
    side.addEventListener('dblclick', function (e) {
      var r = e.target.closest('.pp-sl'); if (!r || !e.target.closest('.pp-k')) return;
      deck.slide(+r.dataset.i); setTimeout(function () { nameDialog('key'); }, 30);
    });
    var dragFrom = -1;
    side.addEventListener('dragstart', function (e) {
      var r = e.target.closest('.pp-sl'); if (!r) return;
      dragFrom = +r.dataset.i; r.classList.add('pp-dragging');
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.dataset.i);
    });
    side.addEventListener('dragover', function (e) {
      var r = e.target.closest('.pp-sl'); if (!r || dragFrom < 0) return;
      e.preventDefault();
      side.querySelectorAll('.pp-drop-before, .pp-drop-after').forEach(function (x) { x.classList.remove('pp-drop-before', 'pp-drop-after'); });
      var b = r.getBoundingClientRect();
      r.classList.add(e.clientY < b.top + b.height / 2 ? 'pp-drop-before' : 'pp-drop-after');
    });
    side.addEventListener('dragend', function () {
      dragFrom = -1;
      side.querySelectorAll('.pp-dragging, .pp-drop-before, .pp-drop-after').forEach(function (x) { x.classList.remove('pp-dragging', 'pp-drop-before', 'pp-drop-after'); });
    });
    side.addEventListener('drop', function (e) {
      var r = e.target.closest('.pp-sl'); if (!r || dragFrom < 0) return;
      e.preventDefault();
      var to = +r.dataset.i + (r.classList.contains('pp-drop-after') ? 1 : 0);
      var s = slides()[dragFrom];
      if (to > dragFrom) to--;
      dragFrom = -1;
      moveTo(s, to);
    });
    document.body.appendChild(side);
  }
  function rowOf(s) {
    var r = rows.get(s);
    if (!r) {
      // 縮小表示は .reveal .slides の中に置き、テーマの「.reveal .slides section」の指定がそのまま効くようにする
      var row = el('<div class="pp-sl" draggable="true"><span class="pp-n"></span><div class="pp-thb"><div class="reveal pp-th"><div class="pp-th-bg"></div><div class="slides"></div></div></div><span class="pp-k"></span></div>');
      r = { row: row, html: null, cls: null };
      rows.set(s, r);
    }
    return r;
  }
  function paintThumb(s, r) {
    var html = s.innerHTML, cls = s.className;
    if (r.html === html && r.cls === cls) return;
    r.html = html; r.cls = cls;
    var c = s.cloneNode(true);
    unmark(c);
    c.querySelectorAll('aside.notes, script').forEach(function (e) { e.remove(); });
    c.querySelectorAll('[data-src]').forEach(function (e) { if (!e.getAttribute('src')) e.setAttribute('src', e.getAttribute('data-src')); });
    // 表示中の印(present など)を外す：テーマの :has(section.present…) を一覧で引き起こさない
    [c].concat(Array.from(c.querySelectorAll('*'))).forEach(function (e) {
      if (e.classList) REVEAL_CLASSES.forEach(function (k) { e.classList.remove(k); });
      REVEAL_ATTRS.forEach(function (a) { e.removeAttribute(a); });
    });
    c.removeAttribute('style'); c.removeAttribute('data-page'); c.removeAttribute('id');
    var th = r.row.querySelector('.pp-th');
    th.querySelector('.slides').replaceChildren(c);
    var bg = th.querySelector('.pp-th-bg');
    var img = s.getAttribute('data-background-image'), col = s.getAttribute('data-background-color') || s.getAttribute('data-background');
    bg.style.backgroundImage = img ? 'url("' + img.replace(/"/g, '%22') + '")' : '';
    bg.style.backgroundColor = col && !/[/.]/.test(col) ? col : '';
    bg.style.backgroundSize = s.getAttribute('data-background-size') || 'cover';
    bg.style.backgroundPosition = s.getAttribute('data-background-position') || 'center';
  }
  function paintThumbs() {
    clearTimeout(thumbTimer); thumbTimer = null;
    slides().forEach(function (s) { paintThumb(s, rowOf(s)); });
  }
  function refreshSide() {
    if (!side) return;
    var list = slides(), cur = current(), nodes = [];
    var put = function (s) {
      var r = rowOf(s), i = list.indexOf(s), k = s.getAttribute('data-page') || '';
      r.row.className = 'pp-sl' + (s === cur ? ' pp-cur' : '') + (dirty.has(s) ? ' pp-dirty' : '') + (isAuto(s) ? ' pp-auto' : '');
      r.row.dataset.i = i;
      r.row.querySelector('.pp-n').textContent = i + 1;
      r.row.querySelector('.pp-k').textContent = k;   // スライドの文字は textContent で入れる(HTML として解釈しない)
      r.row.title = titleOf(s);
      if (r.html === null) paintThumb(s, r);
      nodes.push(r.row);
    };
    if (model) model.forEach(function (x) {
      if (x.t !== 'mark') { put(x.s); return; }
      var h = el('<div class="pp-sec"><small></small><span></span></div>');
      h.firstChild.textContent = x.part; h.lastChild.textContent = x.label;
      nodes.push(h);
    });
    else list.forEach(put);
    side.replaceChildren.apply(side, nodes);
    if (!thumbTimer) thumbTimer = setTimeout(paintThumbs, 250);   // 直した中身は少し待ってから描き直す
    var c = side.querySelector('.pp-sl.pp-cur');
    if (c) { var b = c.getBoundingClientRect(), sb = side.getBoundingClientRect(); if (b.top < sb.top || b.bottom > sb.bottom) c.scrollIntoView({ block: 'nearest' }); }
  }

  /* ------------------------------------------------------------ ノート */

  function buildNotes() {
    notes = el('<div class="pp-ed-notes" aria-label="ノート"><div class="pp-ed-notes-body" contenteditable="true" spellcheck="false" data-ph="クリックしてノートを追加"></div></div>');
    notesBody = notes.firstChild;
    notesBody.addEventListener('input', onNotesInput);
    notesBody.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); document.execCommand('insertLineBreak'); }
    });
    document.body.appendChild(notes);
  }
  function notesEl(s) { return s.querySelector('aside.notes'); }
  function loadNotes() {
    if (!notesBody) return;
    var s = current();
    notesOf = s;
    var a = s && notesEl(s);
    notesBody.innerHTML = a ? a.innerHTML.trim() : '';
    var auto = !s || isAuto(s);
    notesBody.setAttribute('contenteditable', auto ? 'false' : 'true');
    notesBody.setAttribute('data-ph', auto ? '(自動で作るページのため、ノートは直せません)' : 'クリックしてノートを追加');
  }
  function onNotesInput() {
    var s = notesOf;
    if (!s || isAuto(s) || !document.contains(s)) return;
    var a = notesEl(s);
    var empty = !/\S/.test(notesBody.textContent) && !notesBody.querySelector('img');
    if (empty) { if (a) a.remove(); }
    else {
      if (!a) { a = document.createElement('aside'); a.className = 'notes'; s.appendChild(a); }
      a.innerHTML = notesBody.innerHTML;
    }
    dirty.add(s);
    scheduleSnapshot(s);
    refresh();
  }

  /* ------------------------------------------------- 一覧の幅・ノートの高さ */

  function loadLayout() {
    try { var j = JSON.parse(global.localStorage.getItem(LAYOUT_KEY) || 'null'); if (j) Object.keys(lay).forEach(function (k) { if (k in j) lay[k] = j[k]; }); } catch (e) { /* 使えない環境では既定値 */ }
  }
  function saveLayout() { try { global.localStorage.setItem(LAYOUT_KEY, JSON.stringify(lay)); } catch (e) { /* 覚えられないだけ */ } }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function applyLayout() {
    var root = document.documentElement, sz = slideSize();
    lay.side = clamp(Math.round(lay.side), 150, Math.max(150, Math.round(global.innerWidth * 0.5)));
    lay.notes = clamp(Math.round(lay.notes), 60, Math.max(60, Math.round((global.innerHeight - (bar ? bar.offsetHeight : 120)) * 0.7)));
    var k = (lay.side - 52) / sz.w;   // 52 = 番号の列と余白
    root.style.setProperty('--pp-ed-side-w', lay.side + 'px');
    root.style.setProperty('--pp-ed-notes-h', (lay.showNotes ? lay.notes : 0) + 'px');
    root.style.setProperty('--pp-ed-slide-w', sz.w + 'px');
    root.style.setProperty('--pp-ed-slide-h', sz.h + 'px');
    root.style.setProperty('--pp-ed-th-k', k.toFixed(4));
    root.style.setProperty('--pp-ed-th-h', (sz.h * k).toFixed(1) + 'px');
    root.classList.toggle('pp-ed-nonotes', !lay.showNotes);
    var nb = status && status.querySelector('[data-k=notes]'); if (nb) nb.classList.toggle('pp-on', lay.showNotes);
    if (bar) root.style.setProperty('--pp-ed-top', bar.offsetHeight + 'px');
  }
  /* shell の --pp-canvas-* はウィンドウ基準。編集中は .reveal をずらしているので、.reveal の中(ページ番号・背景レイヤーなど)
     には .reveal 基準に直した値を渡す(ウィンドウ直下のフッターはウィンドウ基準のまま) */
  var CANVAS_VARS = ['l', 't', 'r', 'b'];
  var canvasObs = null;
  function syncInnerCanvas() {
    var rv = deck && deck.getRevealElement && deck.getRevealElement();
    if (!rv) return;
    if (!active) { CANVAS_VARS.forEach(function (k) { rv.style.removeProperty('--pp-canvas-' + k); }); return; }
    var root = document.documentElement.style, b = rv.getBoundingClientRect();
    var v = function (k) { return parseFloat(root.getPropertyValue('--pp-canvas-' + k)); };
    var off = { l: b.left, t: b.top, r: global.innerWidth - b.right, b: global.innerHeight - b.bottom };
    CANVAS_VARS.forEach(function (k) {
      var x = v(k);
      if (isNaN(x)) rv.style.removeProperty('--pp-canvas-' + k); else rv.style.setProperty('--pp-canvas-' + k, (x - off[k]).toFixed(2) + 'px');
    });
  }
  function watchCanvas(on) {
    if (on && !canvasObs && global.MutationObserver) {
      canvasObs = new MutationObserver(syncInnerCanvas);
      canvasObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    } else if (!on && canvasObs) { canvasObs.disconnect(); canvasObs = null; }
    syncInnerCanvas();
  }
  var kickRaf = null;
  function kick() {   // Reveal と shell に、描画域の大きさが変わったことを知らせる
    if (kickRaf) return;
    kickRaf = global.requestAnimationFrame(function () { kickRaf = null; global.dispatchEvent(new Event('resize')); global.requestAnimationFrame(placeSel); });
  }
  function splitter(cls, tip, onMove) {
    var e = el('<div class="' + cls + '" title="' + tip + '"></div>');
    e.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      e.setPointerCapture(ev.pointerId);
      e.classList.add('pp-on');
      var mv = function (m) { onMove(m); applyLayout(); kick(); };
      var up = function () {
        e.removeEventListener('pointermove', mv); e.removeEventListener('pointerup', up); e.removeEventListener('pointercancel', up);
        e.classList.remove('pp-on'); saveLayout(); relayout();
      };
      e.addEventListener('pointermove', mv); e.addEventListener('pointerup', up); e.addEventListener('pointercancel', up);
    });
    document.body.appendChild(e);
    return e;
  }
  function buildSplitters() {
    splitV = splitter('pp-ed-split-v', 'ドラッグで一覧の幅を変える', function (m) { lay.side = m.clientX; });
    splitH = splitter('pp-ed-split-h', 'ドラッグでノートの高さを変える(ダブルクリックで表示 / 非表示)', function (m) { lay.notes = global.innerHeight - m.clientY - (status ? status.offsetHeight : 0); lay.showNotes = true; });
    splitH.addEventListener('dblclick', toggleNotes);
  }
  function toggleNotes() {
    lay.showNotes = !lay.showNotes;
    applyLayout(); saveLayout(); relayout();
  }

  function refresh() {
    if (!bar) return;
    var s = current();
    var i = slides().indexOf(s);
    K('pos').textContent = 'スライド ' + (i + 1) + ' / ' + slides().length;
    var key = s && s.getAttribute('data-page');
    K('key').textContent = key ? 'ページ：' + key : '';
    if (names) K('title').textContent = names.title + (model ? '(' + deckName + ')' : '');
    var nm = namesDirty(), n = dirty.size + (structDirty ? 1 : 0) + (nm ? 1 : 0);
    var d = K('dirty');
    var hm = lastSaved ? ('0' + lastSaved.getHours()).slice(-2) + ':' + ('0' + lastSaved.getMinutes()).slice(-2) : '';
    d.textContent = n ? (saving ? '保存しています…' : '未保存' + (dirty.size ? ' ' + dirty.size + ' 枚' : '') + (structDirty ? (dirty.size ? '＋' : ' ') + '並び' : '') + (nm ? (dirty.size || structDirty ? '＋' : ' ') + '名前' : ''))
      : lastSaved ? (autoState === 'saved' ? '自動保存しました ' : '保存しました ') + hm : '保存済み';
    d.classList.toggle('pp-on', n > 0);
    var ab = K('autosave');
    if (ab) {
      ab.classList.toggle('pp-on', !!lay.autosave);
      ab.querySelector('.pp-st').textContent = !lay.autosave ? 'オフ' : autoState === 'paused' && n ? '待機中' : 'オン';
      ab.setAttribute('data-tip', !lay.autosave ? '自動保存はオフ(クリックでオン)' : autoState === 'paused' && n ? '保存先の許可を待っています。「保存」を一度押すと、以後は直すたびに自動で保存します' : '直すたびに自動で保存します(クリックでオフ)');
    }
    if (n && lay.autosave && !saving) scheduleAuto();
    refreshSide();
    if (notesBody && (notesOf !== s || !notesBody.contains(document.activeElement))) loadNotes();
    placeSel();   // 打っている最中は読み直さない
  }

  /* ---------------------------------------------------------- 起動・終了 */

  function onInput(e) {
    var s = sectionOf(e.target);
    if (!s) return;
    var o = objChain(e.target, s)[0];
    if (o && autoH(o)) renderShape(o);   // テキストボックスの高さが変わったら輪郭(塗り・枠線)も合わせる
    dirty.add(s);
    scheduleSnapshot(s);
    refresh();
  }
  function onCompStart() { composing = true; }
  function onCompEnd() { composing = false; }
  function onSlideChanged() { refresh(); setTimeout(placeSel, 50); }
  function onResizeSel() { global.requestAnimationFrame(placeSel); }
  function onKey(e) {
    if (!active) return;
    var mod = e.metaKey || e.ctrlKey;
    var k = (e.key || '').toLowerCase();
    if (mod && k === 's') { e.preventDefault(); save(); return; }
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
    if (mod && ((k === 'z' && e.shiftKey) || k === 'y')) { e.preventDefault(); doRedo(); return; }
    if (mod && (k === 'b' || k === 'i' || k === 'u') && hostOf(e.target)) {
      e.preventDefault(); exec({ b: 'bold', i: 'italic', u: 'underline' }[k])(); return;
    }
    var typing = hostOf(document.activeElement) || document.activeElement === notesBody;
    if (drawKind && k === 'escape') { e.preventDefault(); endDraw(); toast('挿入をやめました'); return; }
    if (!typing && mod && k === 'd' && sels.length) { e.preventDefault(); e.stopPropagation(); duplicateParts(); return; }
    if (!typing && mod && k === 'g') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) ungroupSel(); else groupSel(); return; }
    if (!typing && mod && sels.length && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault(); e.stopPropagation();
      zCmd(e.code === 'BracketRight' ? (e.shiftKey ? 'front' : 'fwd') : (e.shiftKey ? 'back' : 'bwd'))();
      return;
    }
    // 図形を選んだまま打つと、その図形の文字になる(PowerPoint と同じ)。Enter / F2 は文字の終わりから
    if (!typing && !mod && !e.altKey && sels.length === 1 && textOf(sel) && ((e.key || '').length === 1 || k === 'process' || k === 'enter' || k === 'f2')) {
      e.stopPropagation();
      if (k === 'enter' || k === 'f2') { e.preventDefault(); editText(sel, false); } else editText(sel, true);
      return;
    }
    var ae = document.activeElement;
    if (typing && k === 'enter' && !e.shiftKey && !e.isComposing && hostOf(ae) && (/^(TD|TH)$/.test(ae.tagName) || ae.classList.contains('pp-sh-t'))) {
      e.preventDefault(); document.execCommand('insertLineBreak'); return;   // 図形・セルの中の改行は <br>
    }
    if (sel && !typing && !mod && /^arrow/.test(k)) {
      e.preventDefault(); e.stopPropagation();
      var st = e.shiftKey ? 10 : 1;
      nudge(k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0);
      return;
    }
    if (sel && !typing && (k === 'delete' || k === 'backspace')) { e.preventDefault(); deletePart(); return; }
    if (mod && k === 'a' && !typing) { e.preventDefault(); selectAll(); return; }
    if (k === 'escape' && sel && !typing) { clearSel(); return; }
    if (k === 'escape') {
      if (painter) { painter = null; bar.classList.remove('pp-painting'); return; }
      if (hostOf(document.activeElement) || document.activeElement === notesBody) { document.activeElement.blur(); return; }
      // 編集画面が既定なので、Esc で編集を終えない(終えるのはリボン右の「閲覧表示」)
    }
  }
  function onBeforeUnload(e) {
    if (dirty.size || structDirty || namesDirty()) { e.preventDefault(); e.returnValue = ''; }
  }
  function relayout() {
    setTimeout(function () { deck.layout(); global.dispatchEvent(new Event('resize')); global.requestAnimationFrame(placeSel); }, 30);
  }

  function start(d) {
    deck = d || global.Reveal;
    if (active) return;
    active = true;
    document.documentElement.classList.add('pp-editing');
    if (!model && !log.length) loadModel();
    initNames();
    if (!single && !model && slides().some(function (s) { return s.getAttribute('data-page'); }) && !oldWarned) {
      oldWarned = true;
      setTimeout(function () { toast('このデッキは組み立てが古いため、保存は index.html だけに入り、src/pages には入りません(次の組み立てで消えます)。assemble.py で組み立て直してから直してください', 'err'); }, 600);
    }
    slides().forEach(function (s) { markSection(s); dropEmptyStyle(s); stackOf(s); if (!saved.has(s)) saved.set(s, serialize(s, !model).html); });
    loadLayout();
    if (!bar) { buildBar(); buildSide(); buildNotes(); buildSplitters(); }
    else [bar, status, side, notes, splitV, splitH].forEach(function (e) { e.style.display = ''; });
    applyLayout();
    global.addEventListener('resize', applyLayout);
    notesOf = null;
    document.addEventListener('selectionchange', rememberSelection);
    document.addEventListener('input', onInput, true);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('compositionstart', onCompStart, true);
    document.addEventListener('compositionend', onCompEnd, true);
    document.addEventListener('copy', onCopyCut, true);
    document.addEventListener('cut', onCopyCut, true);
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dblclick', onDblClick, true);
    global.addEventListener('resize', onResizeSel);
    if (!selBox) buildSel();
    watchCanvas(true);
    global.addEventListener('beforeunload', onBeforeUnload);
    deck.on('slidechanged', onSlideChanged);
    refresh();
    relayout();
    if (!started) toast('文字はクリックで直接直せます。部品はドラッグで移動。保存は ⌘S / Ctrl+S、発表は右上のスライドショー');
    started = true;
  }
  /* スライドショー：編集の画面を隠して、今のスライドから全画面で発表する。変更はそのまま持ち、全画面を抜けると編集に戻る */
  var showing = false, started = false, oldWarned = false;
  function slideShow() {
    var at = deck.getIndices();
    stop({ keep: true });
    var de = document.documentElement;
    if (de.requestFullscreen) {
      showing = true;
      de.requestFullscreen().catch(function () { showing = false; toast('全画面にできませんでした。E キーで編集に戻ります'); });
    }
    setTimeout(function () { deck.slide(at.h, at.v); }, 60);
  }
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && showing) { showing = false; setTimeout(function () { start(deck); }, 60); }
  });
  function stop(opts) {
    if (!active) return;
    var keep = opts && opts.keep;
    if (!keep && (dirty.size || structDirty || namesDirty()) && !global.confirm('保存していない変更があります。保存せずに編集を終了しますか？')) return;
    active = false;
    unmark();
    closePop();
    document.documentElement.classList.remove('pp-editing');
    if (bar) [bar, status, side, notes, splitV, splitH].forEach(function (e) { e.style.display = 'none'; });
    global.removeEventListener('resize', applyLayout);
    document.removeEventListener('selectionchange', rememberSelection);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('paste', onPaste, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('compositionstart', onCompStart, true);
    document.removeEventListener('compositionend', onCompEnd, true);
    document.removeEventListener('copy', onCopyCut, true);
    document.removeEventListener('cut', onCopyCut, true);
    document.removeEventListener('dragover', onDragOver, true);
    document.removeEventListener('drop', onDrop, true);
    document.removeEventListener('dblclick', onDblClick, true);
    endDraw();
    clearTimeout(autoTimer);
    global.removeEventListener('resize', onResizeSel);
    clearSel();
    watchCanvas(false);
    global.removeEventListener('beforeunload', onBeforeUnload);
    deck.off('slidechanged', onSlideChanged);
    if (keep && (dirty.size || structDirty || namesDirty())) global.addEventListener('beforeunload', onBeforeUnload);   // 発表中も未保存を守る
    relayout();
  }

  global.PPEditor = {
    start: start, stop: stop, isActive: function () { return active; },
    // テスト用
    _serialize: serialize, _spliceSection: spliceSection, _replaceAllSlides: replaceAllSlides, _replaceTitle: replaceTitle, _nameDialog: function (f) { nameDialog(f); },
    _single: function () { return single; },
    _setWriter: function (fn) { writer = fn; }, _setHandleStore: function (m) { handleStore = m; }, _toggleAuto: function () { toggleAuto(); }, _save: save, _payload: payload,
    _dirty: function () { return dirty.size + (structDirty ? 1 : 0) + (namesDirty() ? 1 : 0); },
    _model: function () { return model ? modelPages() : null; },
    _sel: function () { return sel; }, _sels: function () { return sels.slice(); }, _select: function (e, add) { select(e, add); },
    _align: function (k) { alignCmd(k)(); }, _distribute: function (h) { distribute(h)(); }, _resetPos: function () { resetPos(); }, _outer: function () { selectOuter(); },
    _layout: function () { return JSON.parse(JSON.stringify(lay)); },
    _obj: { geom: geom, render: renderShape, beginDraw: beginDraw, insertTable: insertTable, insertImageFile: insertImageFile, group: groupSel, ungroup: ungroupSel,
            z: function (k) { zCmd(k)(); }, rotate: function (d) { rotateCmd(d)(); }, flip: function (a) { flipCmd(a)(); }, fill: function (v) { fillCmd(v)(); }, line: function (v) { lineCmd(v)(); },
            lw: function (v) { lwCmd(v)(); }, dash: function (v) { dashCmd(v)(); }, heads: function (a, b) { headCmd(a, b)(); }, shadow: function (v) { shadowCmd(v)(); }, alpha: function (v) { alphaCmd(v)(); },
            grad: function (v) { gradCmd(v)(); }, tc: function (v) { textColorCmd(v)(); }, valign: function (v) { valignCmd(v)(); }, change: function (t) { changeShapeCmd(t)(); },
            dup: duplicateParts, copy: copyParts, paste: pasteParts, table: { rowAbove: rowAbove, rowBelow: rowBelow, colLeft: colLeft, colRight: colRight, delRow: delRow, delCol: delCol, head: toggleHead, band: toggleBand },
            posDialog: posDialog, cats: SHAPE_CATS }, _paintThumbs: function () { paintThumbs(); },
    _ops: { duplicate: duplicate, deleteSlide: deleteSlide, move: move, moveTo: moveTo, newFromLayout: newFromLayout, resetSlide: resetSlide,
            addSection: addSection, renameSection: renameSection, removeSection: removeSection, undo: doUndo, redo: doRedo, layouts: layouts },
  };
})(window);
