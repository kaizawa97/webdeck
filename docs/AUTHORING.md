# AUTHORING.md — スライド設計規約

このプラットフォームでデッキを生成する LLM エージェント(および人間)が従う規範。
デッキは `tools/new-deck.mjs` で生成する(置き場所は呼び出し元プロジェクトの
`presentations/<name>/` を推奨。手順の正典は `SKILL.md`)。スライドは `<section>` に
**素の HTML/CSS/SVG** で書く。デッキにビルドステップは持たせない。

---

## 1. キャンバス規約

- **新規デッキは 1280×720・`center: false`**(`runtime/shell.js` の標準 config)。各 `<section>` は
  高さ 720px の固定キャンバスであり、自動縦センタリングは行われない。
  キャンバスサイズは変更禁止(テーマの実測座標・verify の検査・出力パイプラインが
  すべて 1280×720 前提で揃っているため)。
- レイアウト手段は自由: **絶対配置(`position: absolute`)・flex・grid のいずれでもよい**。
  座標・サイズはすべて **1280×720 基準の px** で書く(%, vw は使わない)。
- overflow は隠さない方針(`runtime/shell.css`)。はみ出しは「見えるバグ」として
  verify で検出される。**はみ出しの隠蔽に `overflow: hidden` を使わない**こと。
  画像のトリミングなど正当なクロップ用途には使ってよい(verify は `overflow: hidden`
  祖先で測定矩形をクランプする)。ただし恒久的なクロップは**事前クロップした派生
  アセット**にする方が誤検知源を残さない。
- flow で書く場合、テーマが `section` に与える左右パディングの実値は各テーマ正典
  (`themes/<name>/README.md`)が定義する。テーマのレイアウトクラス(表紙系など)は
  `padding: 0` の絶対配置キャンバスになるのが一般形。

## 2. 情報設計 — 内容規範は CONTENT.md

スライドの構成・情報密度・文字量・余白の取り方・図解の流儀は
**[docs/CONTENT.md](CONTENT.md)** が正典(執筆前に必ず読む)。本ドキュメントは
テーマ・出力と衝突する**技術制約**だけを扱う:

- **下端はフッター帯**: テーマのロゴ・©行・ページ番号など下端家具の帯高さは、
  テーマの `template.json`(`verify.footerZonePx`)が宣言し、**verify は同じ値で検査する**
  (実測値は各テーマ正典へ)。出典行 `.src` は帯の直上に置かれる(共通規約 —
  `themes/README.md`)。コンテンツ(枠線・背景を持つ箱を含む)は `.src` の罫線を
  跨がないこと — verify の重なりスイープが帯とのクリアランス(gap px)を報告する
- 読み上げ原稿・補足はスライドに書かず `<aside class="notes">` へ
  (スピーカービューと PPTX のノートに伝搬する)

## 3. テンプレートの使い方

`<head>` でエントリ CSS を1枚だけリンクする(順序: reset → reveal.css → shell.css →
**テーマ**。テーマは shell の既定を上書きするため必ず shell.css の後):

```html
<link rel="stylesheet" href="../../themes/<name>/<mode>.css">   <!-- 例: light.css / dark.css -->
```

注意: `../../` はリポジトリ内配置のプレースホルダ(実例は選択テーマの正典)。実際の
相対パスは `new-deck.mjs` がデッキの位置から自動算出して書き込むので、**雛形が書いた
パスを維持する**(モード切替時もファイル名部分だけ差し替える)。`data-background-image`
のパスも同様。デッキのモード属性は `data-deck-theme`(テーマの `template.json` が宣言する
`themeAttr`。旧属性名は `legacyThemeAttrs` として verify が両対応で読む)。

レイアウトクラス・部品・タイポグラフィ役・カラートークンの**正典は
`themes/<選択テンプレート>/README.md`**(テンプレートの一覧と契約は `themes/README.md`)。
ここでは再掲しない — 一覧とマークアップ実例はそちらを開く。本ドキュメントが持つのは規約2点のみ:

- **色・フォントのハードコード禁止**。必ずテーマのトークン(CSS 変数)を使う。
  ハードコードするとモード切替とテーマ更新が壊れる
- **モード(light|dark 等)の切替は2点セット**: エントリ CSS のリンク差し替え
  (`entry[from]` → `entry[to]`)+アセット参照の差し替え(`modeAssets[from]` →
  `modeAssets[to]`。`data-background-image` 等)。背景アートがモード別画像のテーマでは、
  CSS だけ替えると「白背景アートに白文字」の不可視スライドになる(背景画像上の
  テキストは verify のコントラスト検査も届かない)。`data-deck-theme` の値も
  同じモード名に揃える

## 4. 図解を SVG で書くときの規約

図解にどの手段を使うかは規定しない(トンマナの領域)。ただし技術制約として、
チャートライブラリ(Chart.js 等)を使う場合は**デッキ内にローカルコピー**する
(CDN 禁止 — §7)。

- SVG の書き方:
  - `viewBox` を論理座標にし(例 `viewBox="0 0 600 300"`)、`width`/`height` で
    スライド上のサイズを決める
  - `fill` / `stroke` には**テーマの CSS 変数**を使う(例: `stroke="var(--line-2)"`
    `fill="var(--text-1)"`。意味色・強調色のトークン名はテーマ正典を参照)
  - SVG 内テキストも `font-family: var(--f-small)` 等をあてる
- テーマには数値タイル・対比・手順/ログ表示などの既製部品が用意されていることが多い
  (カタログは `themes/<選択テンプレート>/README.md`)。SVG とどちらを使うかは自由。

## 5. fragment / スピーカーノート / 背景

- **段階表示**: `class="fragment"`(演出付きは `class="fragment fade-up"`)。
  PDF 出力では1ページに畳まれる(`pdfSeparateFragments: false` 設定済み)ため、
  **fragment を全部出した状態で1枚として成立するレイアウト**にすること。
  例外は動画ビートの積層(後続が前面を不透明に覆う設計 — [VIDEO.md](VIDEO.md))。
  なお opacity で隠れている fragment も**レイアウトは占める**(箱のサイズに参加する)。
- **スピーカーノート**: `<aside class="notes">…</aside>` を section 内に書く。
  スピーカービュー(S キー)と PPTX 出力のノートに伝搬する。
- **背景画像**: `<section data-background-image="../../themes/<name>/assets/<mode>/….png">`
  の形(実例は選択テーマの正典)。アセットを持たない CSS のみのテーマもある
  (`template.json` の `modeAssets` 省略)。アセット方式のテーマでは背景アートに
  必ずテーマの画像を使い、CSS グラデーションでの近似は禁止(根拠は各テーマの DESIGN.md)。
- **動的コンテンツの規律**: 数値・本文などの実データは**初期 HTML に確定値で書く**。
  JS のカウントアップ等は「確定値の上に載せる演出」に留め、
  `prefers-reduced-motion: reduce` では即確定させること。
  出力パイプライン(verify のスクショ・PDF・PPTX)は reduce 相当で描画されるため、
  初期 HTML が正しくないと**配布物に誤った数値が焼き込まれる**。
  また print view(PDF)では `slidechanged` は発火しない — イベント頼みの初期化は禁物。
- **CSS アニメーションも同じ規律**: 要素の**ベース状態(アニメなし時の見た目)=
  完成形**にし、動きは `@media (prefers-reduced-motion: no-preference)` の中で
  定義する。ベースを `opacity: 0` 等の「開始状態」にしてアニメで見せる書き方は、
  reduce 環境では開始状態のまま止まり、**PDF/スクショから要素が消える**。
  スライドに時間軸の動きを足す設計・実装の正典は [ANIMATION.md](ANIMATION.md)
  (レンダ動画は [VIDEO.md](VIDEO.md))。

## 6. 大型デッキの分割編集(fragment ファイル運用)

数十枚規模になると `index.html` 1ファイルの編集は衝突源になる(並行作業が不可能・
diff が巨大化)。その場合は章単位の fragment ファイルに分割して書き、機械的に統合する:

```bash
node $PP/tools/fragment.mjs check <deckDir>       # index と fragment の同期検査(統合前ゲート)
node $PP/tools/fragment.mjs integrate <deckDir>   # fragment → index へ統合(冪等)
node $PP/tools/fragment.mjs resync <deckDir>      # index を直接編集した後の逆同期
```

規約と規律(理由はどれも「静かな取りこぼし」の防止):

- スライドは `<!-- ==== SPEC <ID>: <題名> ==== -->` コメントで識別する(ID 例: `S12`)。
  統合はこの ID 照合で `<section>` を置換し、fragment 冒頭の `<style>` を
  マーカー付きで index に巻き上げる
- **1ファイル1オーナー**: 同じ fragment を複数の作業者(エージェント)が同時に
  編集しない。担当外の修正はメッセージで依頼する
- **index を直接編集したら必ず resync**。怠ると次の integrate で古い fragment の
  CSS が index を退行させる
- スライドの HTML を差し替えたら fragment の `<style>` も同時に更新する
  (新しい CSS クラスが未定義のまま overflow する)
- 統合の前後で `check` を回し、diff ゼロを確認してから次工程へ

## 7. 禁止事項

| 禁止 | 理由 |
|---|---|
| `<script type="module">` / ESM | 単一 HTML 化と file:// 起動が壊れる。classic script のみ |
| 外部 CDN 参照(JS/CSS/フォント/画像) | オフライン・file://・単一 HTML 配布が壊れる。必要ならリポジトリ内にコピー |
| Reveal 組み込みテーマの読み込み | テーマは `themes/` のみ。組み込みテーマは vendor に同梱もしていない |
| `runtime/vendor/` 配下の改変 | Reveal.js 6.0.1 ピン留め。挙動変更は `runtime/shell.js` 側で行う |
| 色・フォントのハードコード | §3 の通りトークンを使う |
| デッキ内のビルドステップ(npm 等) | 編集 → リロードで即反映が正義。npm は tools/ だけのもの |

## 8. 検証ループの義務

デッキを書いたら(直したら)必ず:

```bash
node $PP/tools/verify.mjs <deckDir>                          # 執筆中の反復
node $PP/tools/verify.mjs <deckDir> --strict --font-floor=18 # 出荷前(警告軸をゲート昇格)
```

1. 全スライドのスクリーンショットと検査結果が `<deckDir>/out/verify/` に出る。
2. レポートの指摘を直すだけでなく、**スクリーンショットを自分の目で見る**
   (Read ツールで画像を開く)。機械検査は定義済みの軸しか見ない —
   検証の全体設計・盲点の一覧・証明の様式は **[VERIFICATION.md](VERIFICATION.md)** が正典。
3. 指摘ゼロ・目視 OK になるまで修正 → 再実行を繰り返す。
   **このループを通過するまで「完成」と言ってはならない。**
