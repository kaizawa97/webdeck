/* ============================================================================
   webdeck — runtime shell (Reveal.js 6 thin wrapper)
   ----------------------------------------------------------------------------
   デッキ側の使い方(themes/<name>/starter/ 参照):

     <script src="../../runtime/vendor/reveal/reveal.js"></script>
     <script src="../../runtime/vendor/reveal/plugin/notes.js"></script>
     <script src="../../runtime/shell.js"></script>
     <script>
       PPShell.init({
         title: 'デッキタイトル',            // document.title に反映(省略可)
         config: {}                          // Reveal config の上書き(省略可)
       });
     </script>

   提供するもの:
   - 標準 Reveal config(1280×720 / linear / hash / help / notes プラグイン)
   - コントロールドック(下端ホバー表示。前後・ジャンプ・一覧・
     スクロール閲覧・スピーカービュー・投影ウィンドウ切り出し・全画面・
     PDF ダウンロード・ヘルプ)
   - 投影ウィンドウ切り出し中は本体をスピーカービュー化(オーバーレイ。
     戻るボタン/投影ウィンドウを閉じた時の自動復帰つき)
   - PDF ボタンは bundle が埋め込む window.PP_PDF(正式 export-pdf の成果物)が
     ある時だけ表示される。リポジトリ配信のデッキでは出ない
   - 印刷ビュー / スピーカービュー受信側ではドックを生成しない

   前提: classic script(ESM 不使用)。file:// でも動くこと。
   ============================================================================ */

(function (global) {
  'use strict';

  // エディター(runtime/editor.js)の置き場所。単一 HTML に束ねた配布物では
  // shell.js が埋め込まれて src が無くなるため、エディターは出ない(配布物は編集させない)
  var SHELL_SRC = (document.currentScript && document.currentScript.src) || '';
  var EDITOR_BASE = /^(file|https?):/.test(SHELL_SRC) ? SHELL_SRC.replace(/[^\/]*$/, '') : '';
  // 編集用の 1 ファイル(bundle.mjs --editable)はエディターを埋め込んでいる
  function editorAvailable() { return !!EDITOR_BASE || !!global.PP_EDITOR_INLINE; }

  var STANDARD_CONFIG = {
    // --- キャンバス規約: 1280×720 固定。margin 0 で PDF が正確に 16:9 になる ---
    width: 1280,
    height: 720,
    margin: 0,
    minScale: 0.2,
    maxScale: 2.0,
    center: false,           // スライドは固定キャンバス。自動縦センタリングしない

    // --- ナビゲーション ---
    navigationMode: 'linear', // 横一列・→だけで最後まで送れる(PowerPoint と同じ直感)
    hash: true,               // スライド単位の URL(共有リンク・リロード耐性)
    jumpToSlide: true,        // G キーでジャンプ入力
    keyboard: true,
    // 組み込み overview は linear 構成だと横一列にしかならず俯瞰に不向き。
    // 無効化し、シェルがタイル状の一覧グリッド(O / ドック)を提供する
    overview: false,
    // Reveal 6.0.1 は scrollActivationWidth(既定435)が設定されていると
    // toggleScrollView() が checkScrollActivation で即座に解除され no-op になる。
    // スクロール閲覧はドック/URL からの明示切替のみとし、自動発動は無効化する。
    scrollActivationWidth: null,

    // --- 見た目・挙動 ---
    transition: 'fade',
    transitionSpeed: 'fast',
    backgroundTransition: 'none',
    autoAnimateDuration: 0.6,
    controls: false,          // 矢印は独自ドックが提供する
    progress: true,           // 下端バー(クリックでジャンプ可能。テーマ側で非表示にする場合あり)
    slideNumber: 'c',         // 通し番号。テーマが .slide-number を再スタイルする
    help: true,               // ? キーのショートカット一覧
    pause: false,             // ブラックアウト(B)は提供しない(未使用機能のため撤去)
    hideInactiveCursor: true,
    hideCursorTime: 3000,

    // --- 出力 ---
    pdfSeparateFragments: false // fragment は1ページに畳んで出力(ビジネス配布向け)
  };

  /* ------------------------------------------------------------ utilities */

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  function isPrintView() {
    return /(\?|&)(print-pdf|view=print)/i.test(global.location.search);
  }

  function isSpeakerReceiver() {
    return /(\?|&)receiver/i.test(global.location.search);
  }

  // 投影ウィンドウ(ドックの切り出しボタンで開く子ウィンドウ)かどうか。
  // 値なしの素の ?popout を使う — Reveal は「k=v」形式のクエリを config に
  // 取り込むため、値付きにすると config を汚染する(?receiver と同じ流儀)。
  /* 手元のファイル(file://)を直接開いたときは、PowerPoint の標準表示と同じく編集画面で開く。
     次のときは従来どおり発表の表示：?present を付けたとき、init({ editByDefault: false })、
     自動操作(verify・PDF 書き出しなど navigator.webdriver)、iframe の中(スピーカービューなど)、印刷用の表示 */
  function editByDefault(shellOpts) {
    if ((shellOpts || {}).editByDefault === false) return false;
    if (global.location.protocol !== 'file:') return false;
    if (global.navigator.webdriver) return false;
    try { if (global.top !== global) return false; } catch (e) { return false; }
    return !/(\?|&)(present|print-pdf|receiver|popout)\b|(\?|&)view=/i.test(global.location.search);
  }

  function isPopoutView() {
    return /(\?|&)popout(&|=|$)/i.test(global.location.search);
  }

  /* ------------------------------------------------- canvas rect CSS vars
     スライド描画域(レターボックス後の実 rect)を CSS 変数で配布する。
     テーマはこれを使ってフッター等の「キャンバス基準の家具」を、ウィンドウの
     縦横比に依らずスライドに追従させられる(スピーカービューのプレビュー
     iframe 内でも同じ仕組みが働く)。print view では設定しない(フォール
     バック値=ビューポート全面が印刷ページと一致するため)。

       --pp-canvas-l / -t : キャンバス左上(px)
       --pp-canvas-w / -h : キャンバス実寸(px)
       --pp-canvas-r / -b : 右・下のレターボックス幅(px)                     */
  function setupCanvasVars(deck) {
    var root = document.documentElement;
    var raf = null;
    function sync() {
      raf = null;
      if (deck.isScrollView && deck.isScrollView()) return; // scroll view は対象外
      var el = deck.getSlidesElement && deck.getSlidesElement();
      if (!el) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      root.style.setProperty('--pp-canvas-l', r.left.toFixed(2) + 'px');
      root.style.setProperty('--pp-canvas-t', r.top.toFixed(2) + 'px');
      root.style.setProperty('--pp-canvas-w', r.width.toFixed(2) + 'px');
      root.style.setProperty('--pp-canvas-h', r.height.toFixed(2) + 'px');
      root.style.setProperty('--pp-canvas-r', (global.innerWidth - r.right).toFixed(2) + 'px');
      root.style.setProperty('--pp-canvas-b', (global.innerHeight - r.bottom).toFixed(2) + 'px');
      // レターボックスが実際に見えている時だけ立てるフラグ(スライド縁の
      // エッジライン表示に使う。16:9 ぴったりの全画面では線を出さない)
      var boxed = (r.left > 2) || (r.top > 2) ||
                  (global.innerWidth - r.right > 2) || (global.innerHeight - r.bottom > 2);
      root.classList.toggle('pp-letterboxed', boxed);
    }
    function schedule() { if (!raf) raf = global.requestAnimationFrame(sync); }
    ['ready', 'resize', 'overviewhidden', 'sync'].forEach(function (ev) { deck.on(ev, schedule); });
    global.addEventListener('resize', schedule, { passive: true });
    schedule();
  }

  /* ------------------------------------------------------------------ dock */

  var ICONS = {
    prev: '<svg viewBox="0 0 24 24"><path d="M14.5 6 8.5 12l6 6"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></svg>',
    overview: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/></svg>',
    scroll: '<svg viewBox="0 0 24 24"><path d="M6 4.5h12M6 9h12M6 13.5h12M6 18h8"/></svg>',
    speaker: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="11" height="14" rx="1.6"/><rect x="16.5" y="5" width="4.5" height="8" rx="1.2"/><path d="M5.5 9h6M5.5 12h6M5.5 15h4"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>',
    fullscreenExit: '<svg viewBox="0 0 24 24"><path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/></svg>',
    help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.9c-.8.4-1 .9-1 1.9"/><circle cx="12" cy="16.6" r="0.5" fill="currentColor" stroke="none"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v9.5M8.5 10 12 13.5 15.5 10"/><path d="M4.5 16.5v2A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-2"/></svg>',
    toc: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none"/></svg>',
    monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12.5" rx="1.8"/><path d="M9 20.5h6M12 17v3.5"/></svg>',
    popout: '<svg viewBox="0 0 24 24"><path d="M11.5 5H6.8a2.3 2.3 0 0 0-2.3 2.3v9.9a2.3 2.3 0 0 0 2.3 2.3h9.9a2.3 2.3 0 0 0 2.3-2.3v-4.7"/><path d="M14.5 4H20v5.5M20 4l-8.5 8.5"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
    exit: '<svg viewBox="0 0 24 24"><path d="M14.5 4.5H19a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4.5"/><path d="M4 12h11M4 12l4.5-4.5M4 12l4.5 4.5"/></svg>'
  };

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function buildDock(deck, shellOpts) {
    shellOpts = shellOpts || {};
    var dock = el('<div class="pp-dock pp-hidden" role="toolbar" aria-label="プレゼンテーション操作"></div>');

    function btn(act, icon, tip, label) {
      var b = el('<button type="button" data-act="' + act + '" data-tip="' + tip + '" aria-label="' + label + '">' + icon + '</button>');
      dock.appendChild(b);
      return b;
    }
    function sep() { dock.appendChild(el('<span class="pp-sep"></span>')); }

    var bPrev = btn('prev', ICONS.prev, '前へ ←', '前のスライド');
    var bCount = el(
      '<button type="button" class="pp-count" data-act="jump" data-tip="番号入力でジャンプ G" aria-label="スライド番号(クリックでジャンプ)">' +
      '<span class="pp-count-cur">1</span><span class="pp-count-sep">/</span><span class="pp-count-total pp-count-len">1</span></button>');
    dock.appendChild(bCount);
    var bNext = btn('next', ICONS.next, '次へ → / Space', '次のスライド');
    sep();
    var bOverview = btn('overview', ICONS.overview, '一覧 O', 'スライド一覧');
    var bScroll = btn('scroll', ICONS.scroll, 'スクロール閲覧', 'スクロール閲覧モード切替');
    sep();
    var bSpeaker = btn('speaker', ICONS.speaker, 'スピーカービュー S', 'スピーカービューを開く');
    var bPopout = btn('popout', ICONS.popout, '投影ウィンドウを切り出す', '投影ウィンドウを開く(画面共有用)');
    var bFull = btn('fullscreen', ICONS.fullscreen, '全画面 F', '全画面切替');
    var bPdf = btn('pdf', ICONS.download, 'PDF をダウンロード', 'PDF をダウンロード');
    var bHelp = btn('help', ICONS.help, 'ショートカット一覧 ?', 'キーボードショートカット一覧');
    var bEdit = btn('edit', ICONS.edit, '編集 E', 'スライドを編集');
    if (!editorAvailable() || isPopoutView()) bEdit.style.display = 'none';

    // notes プラグインが無いデッキではスピーカービューボタンを隠す
    if (!deck.getPlugin || !deck.getPlugin('notes')) bSpeaker.style.display = 'none';

    // 投影ウィンドウの中では切り出しボタンを出さない(入れ子を作らない)
    var IS_POPOUT = isPopoutView();
    if (IS_POPOUT) bPopout.style.display = 'none';

    // PDF ボタンは事前生成 PDF(bundle が window.PP_PDF として埋め込む)が
    // ある時だけ出す。ブラウザでその場生成はしない — 印刷ダイアログ経由の
    // PDF は品質・ページ数が保証できないため、配布物は常に export-pdf の
    // 検証済み成果物とする(bundle 時に生成・埋め込み)。
    // 注意: PP_PDF のタグは </body> 直前(デッキのスクリプト群より後)に
    // 注入されるため、ドック構築時(ready 直後のマイクロタスク)にはまだ
    // 実行されていないことがある。DOMContentLoaded 後に再同期して拾う。
    function syncPdfButton() {
      bPdf.style.display = (global.PP_PDF && global.PP_PDF.data) ? '' : 'none';
    }
    syncPdfButton();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', syncPdfButton, { once: true });
    }

    /* ---- actions ---- */
    dock.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!b || b.disabled) return;
      var act = b.getAttribute('data-act');
      switch (act) {
        case 'prev': deck.prev(); break;
        case 'next': deck.next(); break;
        case 'jump': if (deck.toggleJumpToSlide) deck.toggleJumpToSlide(); break;
        case 'overview': toggleGrid(); break;
        case 'scroll':
          if (deck.toggleScrollView) deck.toggleScrollView();
          // scroll view の出入りで DOM が組み替わり直後の状態取得が壊れるため遅延同期。
          // 抜けた時は投影ウィンドウへ現在位置を一度だけ送る(在中は送信ガードが抑止。
          // vendor に scroll view の出入りイベントは無いため、この唯一の切替経路で行う)
          setTimeout(function () { refresh(); sendPopoutState(); }, 450);
          break;
        case 'speaker':
          var notes = deck.getPlugin && deck.getPlugin('notes');
          if (notes && notes.open) notes.open();
          break;
        case 'popout': openPopout(); break;
        case 'fullscreen': toggleFullscreen(); break;
        case 'pdf': downloadPdf(); break;
        case 'help': deck.toggleHelp(); break;
        case 'edit': startEditor(deck); break;
      }
    });

    function downloadPdf() {
      var pdf = global.PP_PDF;
      if (!pdf || !pdf.data) return;
      // base64 → Blob → <a download>。data: URI 直リンクより大きな PDF に強く、
      // file:// で開いた単一 HTML でもダウンロードが走る。
      var bin = atob(pdf.data);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = pdf.name || 'slides.pdf';
      document.body.appendChild(a);
      a.click();
      a.parentNode.removeChild(a);
      // 保存先ダイアログを出すブラウザ(Safari 等)では click 後すぐに revoke すると
      // ダウンロードが失敗する。数MB を1分保持するコストは無視できるので長めに待つ。
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }

    function toggleFullscreen() {
      var doc = document;
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      } else {
        var root = doc.documentElement;
        (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      }
    }

    document.addEventListener('fullscreenchange', function () {
      bFull.innerHTML = document.fullscreenElement ? ICONS.fullscreenExit : ICONS.fullscreen;
      bFull.setAttribute('data-tip', document.fullscreenElement ? '全画面解除 Esc' : '全画面 F');
    });

    /* ---- state sync ---- */
    function refresh() {
      var total = deck.getTotalSlides();
      var inScroll = !!(deck.isScrollView && deck.isScrollView());
      var cur;

      if (inScroll) {
        // scroll view では getSlidePastCount/isLastSlide が DOM 組み替えで信頼できない。
        // インデックスから直接計算する。
        var idx = deck.getIndices() || {};
        cur = (idx.h || 0) + 1;
        bPrev.disabled = cur <= 1;
        bNext.disabled = cur >= total;
      } else {
        cur = deck.getSlidePastCount() + 1;
        var frag = deck.availableFragments ? deck.availableFragments() : { prev: false, next: false };
        bPrev.disabled = deck.isFirstSlide() && !frag.prev;
        bNext.disabled = deck.isLastSlide() && !frag.next;
      }
      // 遷移途中の取得失敗で「32 / 30」のような表示にならないよう常にクランプ
      cur = Math.max(1, Math.min(cur, total));
      bCount.querySelector('.pp-count-cur').textContent = cur;
      bCount.querySelector('.pp-count-total').textContent = total;

      bOverview.classList.toggle('pp-active', isGridOpen());
      bScroll.classList.toggle('pp-active', inScroll);
    }

    ['slidechanged', 'fragmentshown', 'fragmenthidden', 'ready', 'sync'].forEach(function (ev) {
      deck.on(ev, refresh);
    });

    /* ---- auto show/hide ---- */
    var hideTimer = null;
    var pinned = false;            // ドックにポインタが乗っている間は消さない
    var userHidden = false;        // D キーによる手動非表示(発表中に即座に消す用)
    var speakerSuppressed = false; // スピーカービューが開いている間の自動非表示

    function show() {
      if (userHidden || speakerSuppressed) return;
      dock.classList.remove('pp-hidden');
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { if (!pinned) hide(); }, 2600);
    }
    function hide() { dock.classList.add('pp-hidden'); }

    document.addEventListener('mousemove', show, { passive: true });
    document.addEventListener('touchstart', show, { passive: true });
    dock.addEventListener('pointerenter', function () { pinned = true; show(); });
    dock.addEventListener('pointerleave', function () { pinned = false; show(); });

    // E キー: 編集モード(エディターを置ける配信のときだけ)
    if (deck.addKeyBinding && editorAvailable() && !isPopoutView()) {
      deck.addKeyBinding({ keyCode: 69, key: 'E', description: '編集モード' }, function () { startEditor(deck); });
    }
    if (editorAvailable() && !isPopoutView() && (/[?&]edit\b/.test(global.location.search) || editByDefault(shellOpts))) startEditor(deck);

    // D キー: ドックの即時オン/オフ(? のヘルプ表にも載る)
    if (deck.addKeyBinding) {
      deck.addKeyBinding({ keyCode: 68, key: 'D', description: '操作ドックの表示切替' }, function () {
        userHidden = !userHidden;
        if (userHidden) hide(); else show();
      });
    }

    /* ================================================================
       スライド一覧グリッド
       ----------------------------------------------------------------
       Reveal 組み込みの overview は linear 構成では横一列にしかならず
       俯瞰に向かないため、config で無効化してタイル状のオーバーレイに
       置き換える(O キー / ドックの一覧ボタン)。
       - 縦横タイル。縦スクロールはマウスホイール、ネイティブの
         スクロールバー付き(.pp-grid-scroll の overflow)
       - クリックでそのスライドへジャンプして閉じる。Esc / O / 余白
         クリックで閉じる
       - 開いている間も矢印キー等は本体に効き、現在スライドの強調が追従
       - サムネイルは thumbSrcFor(PP_THUMBS → out/verify → カード)
       ================================================================ */
    var gridEl = null;
    var gridItems = [];

    function buildGridOverlay() {
      gridEl = el('<div class="pp-grid" role="dialog" aria-label="スライド一覧"><div class="pp-grid-scroll"></div></div>');
      var scroller = gridEl.firstChild;
      deck.getSlides().forEach(function (section, i) {
        var idx = deck.getIndices(section);
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pp-grid-item';
        var src = thumbSrcFor(i);
        if (src) {
          var img = document.createElement('img');
          img.loading = 'lazy';
          img.alt = '';
          img.src = src;
          img.addEventListener('error', function () {
            if (img.parentNode) img.parentNode.removeChild(img);
            b.classList.add('no-thumb');
          });
          b.appendChild(img);
        } else {
          b.classList.add('no-thumb');
        }
        var cap = document.createElement('span');
        cap.className = 'pp-grid-cap';
        var no = document.createElement('span');
        no.className = 'no';
        no.textContent = String(i + 1).padStart(2, '0');
        var ttl = document.createElement('span');
        ttl.className = 'ttl';
        ttl.textContent = slideLabel(section, i);
        cap.appendChild(no);
        cap.appendChild(ttl);
        b.appendChild(cap);
        b.addEventListener('click', function () {
          deck.slide(idx.h, idx.v);
          closeGrid();
        });
        scroller.appendChild(b);
        gridItems.push(b);
      });
      // タイル外(余白)クリックで閉じる
      gridEl.addEventListener('click', function (e) {
        if (e.target === gridEl || e.target === scroller) closeGrid();
      });
      document.body.appendChild(gridEl);
    }

    function isGridOpen() {
      return !!(gridEl && gridEl.classList.contains('pp-open'));
    }

    function refreshGridCurrent(scrollTo) {
      if (!gridEl) return;
      var curSection = deck.getCurrentSlide();
      var slides = deck.getSlides();
      for (var i = 0; i < gridItems.length; i++) {
        gridItems[i].classList.toggle('pp-cur', slides[i] === curSection);
      }
      if (scrollTo) {
        var cur = gridEl.querySelector('.pp-cur');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      }
    }

    function onGridKeydown(event) {
      if (event.keyCode === 27) { // Esc で閉じる(他のキーは本体へ素通し)
        event.preventDefault();
        event.stopPropagation();
        closeGrid();
      }
    }

    function openGrid() {
      if (speakerOverlay) return; // スピーカービュー化中は一覧レールがその役を担う
      if (!gridEl) buildGridOverlay();
      gridEl.classList.add('pp-open');
      refreshGridCurrent(true);
      refresh();
      document.addEventListener('keydown', onGridKeydown, true);
    }

    function closeGrid() {
      if (!isGridOpen()) return;
      gridEl.classList.remove('pp-open');
      refresh();
      document.removeEventListener('keydown', onGridKeydown, true);
    }

    function toggleGrid() { if (isGridOpen()) closeGrid(); else openGrid(); }

    deck.on('slidechanged', function () { if (isGridOpen()) refreshGridCurrent(true); });

    // O キーを一覧グリッドに割り当てる(組み込み overview は config で無効)
    if (deck.addKeyBinding) {
      deck.addKeyBinding({ keyCode: 79, key: 'O', description: 'スライド一覧' }, toggleGrid);
    }

    /* ================================================================
       スピーカーウィンドウへの操作 UI 注入
       ----------------------------------------------------------------
       notes プラグインのスピーカーウィンドウは about:blank に本体と同一
       オリジンで生成され、毎秒 heartbeat を postMessage してくる。
       その event.source からウィンドウ参照を得て、操作バー(前後・番号・
       全スライド一覧・メインドック表示切替)を注入する。
       vendor は無改変。本体リロード後の再接続でも heartbeat 経由で
       自動的に再注入される。
       ================================================================ */
    var SESSION = 'pp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    var speakerWin = null;
    var speakerHandlers = [];   // [eventName, fn] — 解除用
    var speakerCloseTimer = null;

    // 操作バーの位置プリセット(PPShell.init({ speakerBar: '...' }) で選択)
    var SBAR_POSITIONS = {
      'bottom-left':   'left:238px;bottom:14px;', // 左はサムネイルレールを避ける
      'bottom-center': 'left:50%;transform:translateX(-50%);bottom:14px;',
      'bottom-right':  'right:14px;bottom:14px;',
      'top-left':      'left:238px;top:14px;',
      'top-right':     'right:14px;top:14px;',
    };
    var sbarPos = SBAR_POSITIONS[shellOpts.speakerBar] || SBAR_POSITIONS['bottom-right'];
    var RAIL_W = 224; // サムネイルレールの幅(px)

    /* スピーカー UI のアクセント色はテーマの --pp-accent(テーマ契約の必須トークン)を
       デッキ側 window の computed style から解決して注入する。特定テーマの色は
       ハードコードしない。解決できない時は無彩寄りの中立色に落とす。 */
    var ACCENT_FALLBACK = '#5c7080';
    function resolveAccent() {
      try {
        var v = global.getComputedStyle(document.documentElement)
          .getPropertyValue('--pp-accent').trim();
        return v || ACCENT_FALLBACK;
      } catch (e) { return ACCENT_FALLBACK; }
    }
    // アクセント色の半透明版(選択ハイライト用)。hex / rgb() 以外の表現は
    // 分解できないので中立色の RGB に落とす
    function accentRgba(alpha) {
      var v = resolveAccent();
      var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
      var r, g, b;
      if (m) {
        var h = m[1].length === 3
          ? m[1].split('').map(function (c) { return c + c; }).join('')
          : m[1];
        var n = parseInt(h, 16);
        r = n >> 16; g = (n >> 8) & 255; b = n & 255;
      } else {
        m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(v);
        if (m) { r = m[1]; g = m[2]; b = m[3]; }
        else { r = 92; g = 112; b = 128; } // ACCENT_FALLBACK の RGB
      }
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    function speakerCss() {
      var accent = resolveAccent();
      return '#pp-sbar{position:fixed;' + sbarPos + 'z-index:1000;display:flex;gap:2px;align-items:center;' +
        'padding:7px;border-radius:15px;background:rgba(28,33,40,.94);border:1px solid rgba(255,255,255,.1);' +
        'font-family:system-ui,sans-serif;color:rgba(255,255,255,.92);box-shadow:0 6px 24px rgba(0,0,0,.45)}' +
      '#pp-sbar button{appearance:none;border:0;background:transparent;color:inherit;width:46px;height:46px;' +
        'border-radius:10px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}' +
      '#pp-sbar button:hover{background:rgba(255,255,255,.12)}' +
      '#pp-sbar button.pp-active{color:' + accent + ';background:rgba(255,255,255,.12)}' +
      '#pp-sbar button[disabled]{opacity:.32;cursor:default;background:transparent}' +
      '#pp-sbar svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;' +
        'stroke-linecap:round;stroke-linejoin:round;display:block}' +
      '#pp-sbar .pp-count{min-width:76px;width:auto;padding:0 10px;font-size:15px;' +
        'font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '#pp-sbar .pp-sep{width:1px;height:24px;margin:0 5px;background:rgba(255,255,255,.14)}' +
      /* --- サムネイルレール(PowerPoint の通常画面のような常設フィルムストリップ) --- */
      '#pp-main-wrap{position:absolute;top:0;bottom:0;right:0;left:' + RAIL_W + 'px;transition:left .22s ease}' +
      'body.pp-rail-hidden #pp-main-wrap{left:0}' +
      '#pp-srail{position:fixed;left:0;top:0;bottom:0;width:' + RAIL_W + 'px;box-sizing:border-box;' +
        'overflow-y:auto;overflow-x:hidden;background:#14171C;border-right:1px solid rgba(255,255,255,.09);' +
        'padding:10px 10px 80px;z-index:900;font-family:system-ui,sans-serif;' +
        'transition:transform .22s ease;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}' +
      'body.pp-rail-hidden #pp-srail{transform:translateX(-100%)}' +
      '#pp-srail button{display:block;width:100%;appearance:none;border:0;background:transparent;' +
        'color:rgba(255,255,255,.82);padding:6px;border-radius:9px;cursor:pointer;text-align:left;margin-bottom:6px}' +
      '#pp-srail button:hover{background:rgba(255,255,255,.08)}' +
      '#pp-srail button.pp-cur{background:' + accentRgba(0.16) + '}' +
      '#pp-srail button.pp-cur img{outline:2px solid ' + accent + ';outline-offset:0}' +
      '#pp-srail img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:5px;display:block;' +
        'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);margin-bottom:5px}' +
      '#pp-srail .cap{display:flex;gap:7px;font-size:11.5px;line-height:1.4;white-space:nowrap;overflow:hidden}' +
      '#pp-srail .cap .ttl{overflow:hidden;text-overflow:ellipsis}' +
      '#pp-srail .no{opacity:.55;font-variant-numeric:tabular-nums;flex:0 0 auto}' +
      '#pp-srail button.no-thumb{padding:10px 8px}' +
      '#pp-srail button.no-thumb .cap{white-space:normal}';
    }

    /* ---- スライドサムネイルの取得元(一覧グリッドとスピーカーレールで共用)
       1. window.PP_THUMBS(bundle が埋め込む data URI — 単一 HTML 配布用)
       2. out/verify/slide-NN.png(リポジトリで verify 済みのデッキ)
       3. null → 呼び出し側が番号+タイトルのカードにフォールバック       ---- */
    function thumbSrcFor(i) {
      if (global.PP_THUMBS && global.PP_THUMBS.length) return global.PP_THUMBS[i] || null;
      try {
        return new URL('out/verify/slide-' + String(i + 1).padStart(2, '0') + '.png',
          global.location.href).href;
      } catch (e) { return null; }
    }

    function slideLabel(section, i) {
      var h = section.querySelector('h1, h2, h3');
      var t = (h ? h.textContent : '').replace(/\s+/g, ' ').trim();
      if (!t) {
        var p = section.querySelector('p, blockquote, .lead');
        t = (p ? p.textContent : '').replace(/\s+/g, ' ').trim();
      }
      return (t || '(無題スライド)').slice(0, 42);
    }

    function offSpeakerHandlers() {
      speakerHandlers.forEach(function (h) { deck.off(h[0], h[1]); });
      speakerHandlers = [];
    }

    function onSpeakerClosed() {
      offSpeakerHandlers();
      speakerWin = null;
      if (speakerCloseTimer) { clearInterval(speakerCloseTimer); speakerCloseTimer = null; }
      if (speakerSuppressed) { speakerSuppressed = false; show(); }
    }

    function injectSpeakerUi(w) {
      var d;
      try { d = w.document; } catch (e) { return; }
      if (!d || !d.body || !d.getElementById('current-slide')) return; // まだ構築中 → 次の heartbeat で再試行

      var existing = d.getElementById('pp-sbar');
      if (existing && existing.getAttribute('data-pp-session') === SESSION) return; // 現世代の UI が生きている
      // 前世代の注入物(本体リロードでリスナが死んでいる)を除去して作り直す
      ['pp-sbar', 'pp-stoc', 'pp-srail', 'pp-sbar-style'].forEach(function (id) {
        var n = d.getElementById(id); if (n) n.parentNode.removeChild(n);
      });

      var style = d.createElement('style');
      style.id = 'pp-sbar-style';
      style.textContent = speakerCss();
      d.head.appendChild(style);

      // プラグイン純正のペイン群(現在/次スライド・ノート等)を positioned な
      // ラッパーに移し、レール分だけ右に寄せる。ペインは % 絶対配置なので
      // 包含ブロックがラッパーに変わるだけで全レイアウトが自然に縮む。
      // ラッパーはウィンドウが生きている限り再利用する(再注入でも作り直さない)。
      var wrap = d.getElementById('pp-main-wrap');
      if (!wrap) {
        wrap = d.createElement('div');
        wrap.id = 'pp-main-wrap';
        while (d.body.firstChild) wrap.appendChild(d.body.firstChild);
        d.body.appendChild(wrap);
      }

      var bar = d.createElement('div');
      bar.id = 'pp-sbar';
      bar.setAttribute('data-pp-session', SESSION);
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', '発表操作');

      function sBtn(icon, title) {
        var b = d.createElement('button');
        b.type = 'button';
        b.title = title;
        b.innerHTML = icon;
        bar.appendChild(b);
        return b;
      }
      function sSep() {
        var s = d.createElement('span'); s.className = 'pp-sep'; bar.appendChild(s);
      }

      var sPrev = sBtn(ICONS.prev, '前へ (←)');
      var sCount = d.createElement('button');
      sCount.type = 'button';
      sCount.className = 'pp-count';
      sCount.title = 'スライド番号';
      bar.appendChild(sCount);
      var sNext = sBtn(ICONS.next, '次へ (→ / Space)');
      sSep();
      var sToc = sBtn(ICONS.toc, 'サムネイル一覧の表示/非表示');
      sSep();
      var sDock = sBtn(ICONS.monitor, '聴衆画面の操作ドックを表示/非表示');

      // 本体に重ねたオーバーレイ型(投影ウィンドウ切り出し中)のときだけ、
      // スピーカービューを閉じて元のスライド表示へ戻るボタンを出す
      if (w.frameElement) {
        sSep();
        var sReturn = sBtn(ICONS.exit, 'スピーカービューを閉じてスライド表示に戻る');
        sReturn.addEventListener('click', function () { closeSpeakerOverlay(); });
      }

      // 常設サムネイルレール。画像は thumbSrcFor(PP_THUMBS → out/verify →
      // 番号+タイトルのカードにフォールバック)。現在スライドは常に中央へ追従。
      var rail = d.createElement('div');
      rail.id = 'pp-srail';
      rail.setAttribute('aria-label', 'スライド一覧');
      var railButtons = [];
      deck.getSlides().forEach(function (section, i) {
        var idx = deck.getIndices(section);
        var b = d.createElement('button');
        b.type = 'button';
        var thumbSrc = thumbSrcFor(i);
        if (thumbSrc) {
          var img = d.createElement('img');
          img.loading = 'lazy';
          img.alt = '';
          img.src = thumbSrc;
          img.addEventListener('error', function () {
            if (img.parentNode) img.parentNode.removeChild(img);
            b.classList.add('no-thumb');
          });
          b.appendChild(img);
        } else {
          b.classList.add('no-thumb');
        }
        var cap = d.createElement('span');
        cap.className = 'cap';
        var no = d.createElement('span'); no.className = 'no';
        no.textContent = String(i + 1).padStart(2, '0');
        var ttl = d.createElement('span'); ttl.className = 'ttl';
        ttl.textContent = slideLabel(section, i);
        cap.appendChild(no);
        cap.appendChild(ttl);
        b.appendChild(cap);
        b.addEventListener('click', function () { deck.slide(idx.h, idx.v); });
        rail.appendChild(b);
        railButtons.push(b);
      });

      function railVisible() { return !d.body.classList.contains('pp-rail-hidden'); }
      function centerCurrent(smooth) {
        if (!railVisible()) return;
        var cur = rail.querySelector('.pp-cur');
        if (cur) cur.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      }

      sPrev.addEventListener('click', function () { deck.prev(); });
      sNext.addEventListener('click', function () { deck.next(); });
      sToc.addEventListener('click', function () {
        d.body.classList.toggle('pp-rail-hidden');
        sToc.classList.toggle('pp-active', railVisible());
        if (railVisible()) setTimeout(function () { centerCurrent(false); }, 240);
      });
      sDock.addEventListener('click', function () {
        speakerSuppressed = !speakerSuppressed;
        if (speakerSuppressed) hide(); else { dock.classList.remove('pp-hidden'); show(); }
        refreshSpeaker();
      });

      d.body.appendChild(rail);
      d.body.appendChild(bar);
      sToc.classList.toggle('pp-active', railVisible()); // 表示状態は body クラスで永続(リロード跨ぎ)

      // キーボード操作をメインデッキへ届ける。
      // notes プラグイン組み込みの keydown 転送はプレビュー iframe にしか届かず
      // 本体が動かない(実測)ため、capture 段で先取りして本体の triggerKey を呼ぶ。
      // 矢印/Space/PageUp/Down/Home/End/N/P のみ。F(全画面)と G(ジャンプ入力)は
      // 本体側のユーザージェスチャ・表示を要するため対象外。
      var NAV_KEYS = { 32: 1, 33: 1, 34: 1, 35: 1, 36: 1, 37: 1, 38: 1, 39: 1, 40: 1, 78: 1, 80: 1 };
      d.addEventListener('keydown', function (event) {
        var t = event.target;
        if (t && /^(input|textarea|select)$/i.test(t.tagName || '')) return; // レイアウト選択等を邪魔しない
        if (!NAV_KEYS[event.keyCode] || event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation(); // 組み込みの iframe 転送(プレビューだけ動く)と二重処理しない
        try { deck.triggerKey(event.keyCode); } catch (e) {}
      }, true);

      function refreshSpeaker() {
        try {
          var total = deck.getTotalSlides();
          var cur = Math.max(1, Math.min(deck.getSlidePastCount() + 1, total));
          sCount.textContent = cur + ' / ' + total;
          var frag = deck.availableFragments ? deck.availableFragments() : { prev: false, next: false };
          sPrev.disabled = deck.isFirstSlide() && !frag.prev;
          sNext.disabled = deck.isLastSlide() && !frag.next;
          sDock.classList.toggle('pp-active', !speakerSuppressed && !userHidden);
          var curSection = deck.getCurrentSlide();
          var slides = deck.getSlides();
          var changed = false;
          for (var i = 0; i < railButtons.length; i++) {
            var isCur = slides[i] === curSection;
            if (isCur && !railButtons[i].classList.contains('pp-cur')) changed = true;
            railButtons[i].classList.toggle('pp-cur', isCur);
          }
          if (changed) centerCurrent(true); // 現在スライドをレール中央へ追従
        } catch (e) { /* ウィンドウが閉じた直後の競合は無視(close 監視が回収する) */ }
      }

      offSpeakerHandlers();
      ['slidechanged', 'fragmentshown', 'fragmenthidden', 'sync'].forEach(function (ev) {
        deck.on(ev, refreshSpeaker);
        speakerHandlers.push([ev, refreshSpeaker]);
      });
      refreshSpeaker();
    }

    function adoptSpeakerWindow(w) {
      if (!w) return;
      speakerWin = w;
      if (!speakerSuppressed && !userHidden) { speakerSuppressed = true; hide(); }
      injectSpeakerUi(w);
      if (!speakerCloseTimer) {
        speakerCloseTimer = setInterval(function () {
          var closed = true;
          try { closed = !speakerWin || speakerWin.closed; } catch (e) {}
          if (closed) onSpeakerClosed();
        }, 800);
      }
    }

    /* ================================================================
       投影ウィンドウ(ポップアウト)
       ----------------------------------------------------------------
       デッキ自身を ?popout 付き URL の最小クロームなポップアップで開き、
       本体と双方向で状態(スライド位置・fragment)をミラーする。
       会議アプリの画面共有で URL バーやブックマークバーを
       映したくない時に、このウィンドウだけを選んで配信する。
       切り出しと同時に本体はスピーカービュー(オーバーレイ)に切り替わる
       — 操作バーの戻るボタンでスライド表示へ戻せ、投影ウィンドウを
       閉じれば自動で戻る(下の openSpeakerOverlay 参照)。

       - 子(?popout)は opener へ毎秒 heartbeat を送り、親は event.source
         から参照を得る(親リロード後の再接続もこの1経路)。子のロード
         完了時は hello を送り、親が現在状態を必ず押し込む
       - ウィンドウ名はデッキパス基準で固定 — 親リロード直後(heartbeat
         再接続前)にボタンを押しても、名前一致で既存ウィンドウが再利用され
         2枚目は開かない
       - 状態は namespace 'pp-popout' の JSON メッセージで送り合う。
         適用中フラグでエコー送信を抑止(同一状態への setState はイベントを
         発火しないため、抑止が漏れても収束する)
       - スクロール閲覧は手元の俯瞰専用としてミラーしない: モード中の
         移動は送信せず、抜けた時に現在位置へ一度だけ同期する
         (一覧グリッドはローカルなオーバーレイなのでそもそも同期対象外。
          state.overview は組み込み overview 無効化に伴い常に false だが、
          念のためキーごと削除して送る)
       ================================================================ */
    var popoutWin = null;          // 親側: 切り出した投影ウィンドウ
    var popoutApplying = false;    // 受信状態の適用中(エコー送信の抑止)
    var popoutActiveTimer = null;  // heartbeat 由来のボタン点灯の消灯タイマー

    /* ---- 本体ウィンドウのスピーカービュー化(オーバーレイ) ----
       切り出し中の本体はスピーカービューとして使うのが基本運用なので、
       切り出しと同時に notes プラグイン純正のスピーカービューを全画面
       iframe として本体に重ねる(別窓は増やさない)。iframe に生成させる
       仕掛けは、notes.open() を呼ぶ間だけ window.open を差し替えて iframe
       の Window を返すこと — vendor 無改変のまま、接続・状態/ノート配信・
       キー転送・操作バー注入(上の injectSpeakerUi)まで既存経路がそのまま
       動く。iframe の opener を本体に向けるので、スピーカービューからの
       connected / heartbeat は本体に届く。
       S キーで既に別窓スピーカービューを開いている場合は乗っ取らない
       (notes.open() が既存窓に focus するだけ = window.open 不使用を検知)。 */
    var speakerOverlay = null;

    function openSpeakerOverlay() {
      if (speakerOverlay) return;
      var notes = deck.getPlugin && deck.getPlugin('notes');
      if (!notes || !notes.open) return;
      var iframe = document.createElement('iframe');
      iframe.id = 'pp-speaker-overlay';
      iframe.title = 'スピーカービュー';
      // 背景は白 — vendor のスピーカービューは body に背景色を指定しておらず、
      // 別窓ではトップレベル既定のキャンバス(白)が出る。iframe ではキャンバスが
      // 透明になるため、ここで白を敷かないと下の色が透けて文字が読めなくなる
      iframe.style.cssText =
        'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:500;background:#fff;';
      document.body.appendChild(iframe);
      var win = iframe.contentWindow;
      try { win.opener = global; } catch (e) {}
      var realOpen = global.open;
      var used = false;
      global.open = function () { used = true; return win; };
      try { notes.open(); } finally { global.open = realOpen; }
      if (!used) {
        // 別窓のスピーカービューが既にあり focus されただけ — オーバーレイ不要
        document.body.removeChild(iframe);
        return;
      }
      // document.write 後にも再設定(Window は同一だが実装差への保険。
      // スピーカービュー側の opener 参照は接続時以降なのでこれで間に合う)
      try { win.opener = global; } catch (e) {}
      // vendor のスピーカービューは背景色を明示しない(別窓ではトップレベル
      // 既定の白キャンバスが出る)。iframe ではキャンバスが透明になるため、
      // 文書側にも白を明示して別窓と同じ見た目を保証する
      try {
        var st = win.document.createElement('style');
        st.textContent = 'html { background: #fff; }';
        win.document.head.appendChild(st);
      } catch (e) {}
      speakerOverlay = iframe;
    }

    function closeSpeakerOverlay() {
      if (!speakerOverlay) return;
      if (speakerOverlay.parentNode) speakerOverlay.parentNode.removeChild(speakerOverlay);
      speakerOverlay = null;
      // iframe の Window は closed になるため、speakerCloseTimer が
      // onSpeakerClosed(ハンドラ解除・ドック復帰)を自動で回収する
    }

    function popoutPeer() {
      try {
        if (IS_POPOUT) return global.opener || null;
        return (popoutWin && !popoutWin.closed) ? popoutWin : null;
      } catch (e) { return null; }
    }

    // targetOrigin は '*' — file:// では各文書が opaque origin になり
    // 具体値を指定できない。載せるのはスライド位置等の公開情報のみ。
    function postToPeer(msg) {
      var peer = popoutPeer();
      if (!peer) return;
      try { peer.postMessage(JSON.stringify(msg), '*'); } catch (e) {}
    }

    function sendPopoutState(force) {
      // スクロール閲覧中の移動は手元専用 — 相手に流さない。
      // モードを抜ける時の一度きりの同期だけが force で通る
      if (!force) {
        try {
          if (deck.isScrollView && deck.isScrollView()) return;
        } catch (e) {}
      }
      var state;
      try { state = deck.getState(); } catch (e) { return; }
      delete state.overview;
      postToPeer({ namespace: 'pp-popout', type: 'state', state: state });
    }

    function applyPopoutState(state) {
      if (!state) return;
      popoutApplying = true;
      try {
        delete state.overview; // 受信側で開いている一覧を閉じさせない
        deck.setState(state);
      } catch (e) {}
      popoutApplying = false;
    }

    function markPopoutAlive() {
      bPopout.classList.add('pp-active');
      if (popoutActiveTimer) clearTimeout(popoutActiveTimer);
      popoutActiveTimer = setTimeout(function () {
        bPopout.classList.remove('pp-active');
        // heartbeat が途絶え、かつ確実に閉じている時だけスライド表示へ戻す。
        // 判定は .closed のみ — 最小化等によるタイマー抑制を閉扱いしない
        try { if (popoutWin && popoutWin.closed) closeSpeakerOverlay(); } catch (e) {}
      }, 2600);
    }

    function openPopout() {
      try {
        if (popoutWin && !popoutWin.closed) {
          popoutWin.focus();      // 2枚は開かない
          openSpeakerOverlay();   // 「戻る」後の再クリックでスピーカービューを再構成
          return;
        }
      } catch (e) {}
      // 閲覧モード系のクエリ(view= / print-pdf)は引き継がない —
      // ?view=scroll のページから切り出しても通常の投影として開くため
      var loc = global.location;
      var base = loc.href.split('#')[0].split('?')[0];
      var params = loc.search.replace(/^\?/, '').split('&').filter(function (p) {
        return p && !/^(view=|print-pdf|popout)/i.test(p);
      });
      params.push('popout');
      // ウィンドウ名はデッキパス基準で固定(SESSION を含めない)。親リロード
      // 直後で popoutWin 未再接続でも、名前一致で既存ウィンドウが再利用される
      popoutWin = global.open(base + '?' + params.join('&') + loc.hash,
        'pp-popout:' + loc.pathname, 'popup=yes,width=1280,height=720');
      if (!popoutWin) {
        alert('投影ウィンドウを開けませんでした。ブラウザのポップアップブロックを解除して、もう一度押してください。');
        return;
      }
      // 切り出し中の本体はスピーカービューとして使う(戻るボタン/投影
      // ウィンドウを閉じた時の自動復帰つき)
      openSpeakerOverlay();
    }

    ['slidechanged', 'fragmentshown', 'fragmenthidden'].forEach(function (ev) {
      deck.on(ev, function () { if (!popoutApplying) sendPopoutState(); });
    });

    if (IS_POPOUT && global.opener) {
      // 子: ロード完了を hello で通知(親が現在状態を返す)+ 毎秒 heartbeat
      postToPeer({ namespace: 'pp-popout', type: 'hello' });
      setInterval(function () {
        postToPeer({ namespace: 'pp-popout', type: 'heartbeat' });
      }, 1000);
    }

    // heartbeat(毎秒)を拾って子ウィンドウを認識する。
    // スピーカービュー(reveal-notes)・投影ウィンドウ(pp-popout)とも、
    // 初回オープン・リロード後の再接続をこの1経路で賄う。
    global.addEventListener('message', function (event) {
      var data;
      if (typeof event.data !== 'string') return;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      if (!data) return;
      if (data.namespace === 'reveal-notes' && data.type === 'heartbeat') {
        adoptSpeakerWindow(event.source);
      } else if (data.namespace === 'pp-popout') {
        if (IS_POPOUT) {
          // 子: opener からの状態のみ適用する
          if (data.type === 'state' && event.source === global.opener) applyPopoutState(data.state);
        } else if (data.type === 'hello') {
          popoutWin = event.source;   // 子のロード直後(子リロード時は同一 WindowProxy のまま来る)
          markPopoutAlive();
          sendPopoutState();
        } else if (data.type === 'heartbeat') {
          // 現在の参照が生きている間は乗り換えない(2つの子が居ても採用先が
          // フラップしない)。死んでいる時だけ採用する = 親リロード後の再接続
          if (!popoutPeer()) {
            popoutWin = event.source;
            sendPopoutState();
            openSpeakerOverlay(); // リロードした本体をスピーカービュー化に戻す
          }
          if (event.source === popoutWin) markPopoutAlive();
        } else if (data.type === 'state' && event.source === popoutWin) {
          applyPopoutState(data.state);
        }
      }
    });

    document.body.appendChild(dock);
    refresh();

    // 起動直後は存在を知らせるため一度見せる。ただし投影ウィンドウでは
    // 見せない — 開いた直後に画面共有されるウィンドウでツールバーを
    // フラッシュさせない(マウスを動かせば通常どおり現れる)
    if (!IS_POPOUT) show();

    return dock;
  }

  /* ---------------------------------------------------------------- editor */

  var editorLoading = null;
  function startEditor(deck) {
    if (global.PPEditor) { global.PPEditor.start(deck); return; }
    if (!EDITOR_BASE) return;
    if (!editorLoading) {
      editorLoading = new Promise(function (ok, ng) {
        var css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = EDITOR_BASE + 'editor.css';
        document.head.appendChild(css);
        var js = document.createElement('script');
        js.src = EDITOR_BASE + 'editor.js';
        js.onload = ok; js.onerror = function () { ng(new Error('editor.js を読み込めません')); };
        document.head.appendChild(js);
      });
    }
    editorLoading.then(function () { global.PPEditor.start(deck); }).catch(function (e) { console.error(e); });
  }

  /* ------------------------------------------------------------------ init */

  function init(opts) {
    opts = opts || {};
    if (!global.Reveal) {
      throw new Error('PPShell: Reveal.js が読み込まれていません(shell.js より前に vendor/reveal/reveal.js を読み込んでください)');
    }

    if (opts.title) document.title = opts.title;
    // 投影ウィンドウは画面共有のウィンドウ選択で見分けられるよう接尾辞を付ける
    if (isPopoutView()) document.title += ' — 投影';

    var plugins = [];
    if (global.RevealNotes) plugins.push(global.RevealNotes);
    if (global.RevealHighlight) plugins.push(global.RevealHighlight);

    var config = assign({}, STANDARD_CONFIG, opts.config || {});
    config.plugins = plugins.concat((opts.config && opts.config.plugins) || []);

    var deck = global.Reveal;
    var ready = deck.initialize(config);

    // キャンバス追従の CSS 変数(受信 iframe でも動かす。print では既定値に任せる)
    if (!isPrintView()) {
      ready.then(function () { setupCanvasVars(deck); });
    }

    // エディターの「PDF に書き出す」から開いた印刷ビュー：読み込みが済んだら印刷の画面を出す
    if (isPrintView() && /(\?|&)pp-print\b/.test(global.location.search)) {
      ready.then(function () { return document.fonts && document.fonts.ready; }).then(function () {
        setTimeout(function () { global.print(); }, 800);
      });
    }

    // 今のスライドのページ名(data-page)を URL の ?page= に入れる。Orca などの指摘は URL の # を落とすため、
    // ? 側に置いておくと、指摘からすぐ src/pages/<キー>.html を特定できる(tools/find-page.mjs)
    if (!isPrintView() && !isSpeakerReceiver()) {
      var syncPage = function () {
        try {
          var cur = deck.getCurrentSlide(), key = cur && cur.getAttribute('data-page');
          var q = new URLSearchParams(global.location.search);
          if (key && key.charAt(0) !== '(') q.set('page', key); else q.delete('page');
          var qs = q.toString().replace(/=(?=&|$)/g, '');
          var ix = deck.getIndices();   // # は Reveal と同じ書き方で、今のスライドに合わせる(再読み込みで同じスライドに戻る)
          var hash = ix.h || ix.v ? '#/' + ix.h + (ix.v ? '/' + ix.v : '') : '';
          var url = global.location.pathname + (qs ? '?' + qs : '') + hash;
          if (url !== global.location.pathname + global.location.search + global.location.hash) global.history.replaceState(global.history.state, '', url);
        } catch (e) { /* URL を書き換えられない環境では何もしない */ }
      };
      ready.then(function () { syncPage(); deck.on('slidechanged', function () { setTimeout(syncPage, 0); }); });
    }

    // 印刷ビュー / スピーカービューの受信 iframe ではドックを出さない
    if (!isPrintView() && !isSpeakerReceiver()) {
      ready.then(function () { buildDock(deck, opts); });
    }

    return ready.then(function () { return deck; });
  }

  global.PPShell = { init: init, STANDARD_CONFIG: STANDARD_CONFIG };
})(window);
