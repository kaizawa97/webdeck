# sumi テーマ — 設計仕様(webpaper デザインシステムの 16:9 翻案)

出自: エージェント文書用デザインシステム **webpaper**(生成りの紙 × 墨 × 群青)を
1280×720 のスライドキャンバスへ翻案したもの。AWS 等の特定ブランド要素を一切含まない
汎用テンプレート。翻案の原則は「**紙面の規律は保存し、読む距離だけを引き直す**」。

## 1. アイデンティティ(webpaper から保存するもの)

1. **紙の実在感**: ページ地は真っ白でなく生成り `#faf8f4`。図版・部品だけが白 `#ffffff` の
   「パネル」として一段浮く。ダークは暖色ダーク紙 `#1b1a18` + 一段明るい面 `#242320`
   (単純反転ではなく独立設計。純白・純黒は使わない)
2. **画面の 95% はモノクロ**: 情報の格はグレー階調(#111 → #555 → #666 → #b0b0b0)と
   太字/通常の 2 ウェイトで作る。イタリック・下線・蛍光は使わない
3. **色は意味の分だけ**: 群青 `#2c4fae` = 強調・現在地。深紅 `#d1495b` = 「ここを見ろ」
   (1 面 1〜2 箇所まで。キーナンバー・キークレーム専用)。パステル 3 色
   (lavender `#e9e6ff` / blue `#e0f1ff` / mint `#e2f0e8`)= 分類の意味コーディング
4. **罫線の言語**: 黒 1.5px(格のある枠)/ グレー 1px(日常のカード)/
   細罫(表)。太さが意味を語る
5. **丸みの規律**: 2px(チャート箱・画像枠)/ 8px(パネル・カード)/ 3px(チップ)。
   バー・棒・配線エルボーは常にスクエア。影はゼロ
6. **署名的な型**: ①墨のマストヘッド(群青トップボーダー+深紅の垂れタブ)、
   ②見出しの黒太縦バー、③凡例なし直接ラベルのモノクロチャート
7. **禁止リスト**: 紫グラデ背景 / 色付き左ボーダーのコールアウト / 過剰な角丸・影・
   グラスモーフィズム / 絵文字見出し / 根拠のない多色

## 2. スライド用に引き直すもの(読む距離 → 投影距離)

webpaper の文書用スケール(本文 15.5px・行間 1.85)は投影では読めない。
1280×720 キャンバス基準の固定 px へ全面的に引き直す:

| 役割 | webpaper(文書) | sumi(スライド) |
|---|---|---|
| 本文 | 15.5px / 1.85 | **26px / 1.55** |
| リード(結論先出し) | 16.5px | 30px |
| スライドタイトル(h2 + 縦バー) | 23px / バー 9px | **40px 太字 / バー 12px** |
| カバータイトル | 42px | 64px |
| セクション扉タイトル | 33px | 54px |
| パネルタイトル | 16.5px | 26px |
| キャプション・出典 | 12.5px | 18px(verify のフォント床 = 18px を割らない) |
| キッカー(欧文ラベル) | 11px / .34em | 16px / .3em(フォント床除外) |
| 統計値(KPI) | 28px | 72px |
| 補助グレー | #808080 | **#666666**(プロジェクタで飛ぶため一段濃く)|
| 表罫 | 髪の毛罫 #d8d8d8 | 1px #c9c9c9(下罫 th は 2px 墨) |

密度規範も「1 セクション = 1 アイデア」→「**1 面 = 1 メッセージ**」に読み替える
(規範本体は docs/CONTENT.md が正典)。

## 3. レイアウトカタログ(全面 padding: 0 のレイアウトクラス)

| クラス | 用途 | 意匠 |
|---|---|---|
| `.sumi-cover` | 表紙 | 墨ベタ全面。上端に群青 10px ボーダー、その下左に深紅の垂れタブ(84×28)。キッカー+特大タイトル(生成り色抜き)+メタ行+発表者ブロック。**ダークでは白抜き反転**(明帯+墨文字)— webpaper のマストヘッド反転と同じ論理 |
| `.sumi-section` | 章扉 | 生成り地。グレー罫+ドット+欧文キッカー(chapter-break 意匠)+特大タイトル+等幅の章番号(tabular-nums、群青) |
| `.sumi-agenda` | 目次 | webpaper の .agenda 昇格版: 特大黒丸+太字タイトル+グレー説明の two-tier。3〜5 項目・1 行ラベル。再訪時の現在地は群青(`.is-current`) |
| `.sumi-quote` | 引用 | pull-quote 拡大版: セリフの特大 “ グリフ+原文+罫線+和訳+等幅グレー出典 |
| `.sumi-closing` | 結び / Q&A | 墨帯または生成り地に大字 1 文。カバーの縮小再演 |
| (無指定) | コンテンツ面 | 生成り地+左右 64px パディング。タイトルは h2(黒縦バー 12px + 40px 太字)を左上に、直下に `.lead` 任意 |

フッター家具 `.sumi-footer`: 下端 44px の帯に、右にページ番号(等幅 18px グレー)、
左にデッキ題(18px グレー、任意)。**意味のあるメタだけ** — ロゴ・クレジット類は置かない。
Reveal の下端プログレスバーは **表示する**(3px、群青グラデ `#23408e→#3b63c4→#86b4e8` —
webpaper で唯一グラデが許されたレールの意匠を進捗表現として移植。「例外は 1 つ」の思想ごと保存)。

## 4. 部品カタログ(components.css。すべてトークン参照)

webpaper から移植: `.titled-panel`(黒 1.5px 枠+中央太字タイトル)/ `.card`(+`.grid--2/--3`)/
`.pastel-card--lavender/--blue/--mint` / `.chip` / `.stat-row`+`.stat`(値 72px、`.stat-value--key` で深紅 1 つ)/
table(推奨行 `.row-highlight`、数値 `.num`、判定 `.mark`)/ コード 2 段(`pre` ライト地・`.terminal` 墨地)/
チャート語彙(`.chart-panel`・`.hbar`・`svg-axis/grid/tick-text/label/series-main/series-compare/dot/bar/highlight/highlight-ring/anno`)/
図解語彙(`.diagram`・`dg-node/wire/arrow/junction/group/text/icon` — 白ノード+黒 1.5px 枠+直交配線)/
`.src` 出典行(プラットフォーム共通規約: フッター帯直上 bottom: 56px 付近、18px グレー)。

チャート規約は webpaper と同一: 主役=墨・比較=グレー #8e8e8e・凡例なし直接ラベル・
強調は深紅 1 点だけ・棒はスクエア端・注釈積極(リーダーライン・リング・しきい値破線)。

フラグメント(段階表示)の強調色は**群青**。深紅は「ここを見ろ」1 点専用であり、
アニメーションの現在ステップ表示に使わない(1 意味 1 色の保存)。

## 5. モードとトークン実装

- モードは light / dark の 2 つ。`data-deck-theme` 属性+エントリ CSS の 2 点セットで切替
- **アセット PNG を持たない**(template.json に modeAssets なし)。背景・家具はすべて CSS
- トークン名は webpaper の語彙を踏襲(`--ink` `--ink-mid` `--accent` `--crimson`
  `--pastel-*` `--line*` `--bg-page` `--bg-panel` `--chart-*` 等)。
  ダークは vars-dark.css でトークン一括上書きのみ(部品側にダーク分岐を書かない)
- ファイル構成は aws テーマと同型: vars-{light,dark}.css / fonts.css / base.css /
  layouts.css / components.css / shell-hooks-{light,dark}.css / エントリ {light,dark}.css

### shell-hooks(--pp-* 契約)の値

| トークン | light | dark |
|---|---|---|
| --pp-bg | #faf8f4 | #1b1a18 |
| --pp-fg | #111111 | #ece8e1 |
| --pp-accent | #2c4fae | #86b4e8 |
| --pp-letterbox | #ece8e1 | #0f0e0d |
| --pp-font | BIZ UDPGothic スタック | 同左 |
| dock 系 | 白地 .94 / 墨字 / 罫 #c9c9c9 / active 群青 | #242320 地 / 生成り字 / 罫 #4a4741 / active 明群青 |
| --pp-progress-track | rgba(59,99,196,.12) | rgba(134,180,232,.14) |
| --r-overlay-element-* | 紙色系 RGB トリプレット | ダーク紙系 RGB トリプレット |

## 6. フォント

`"BIZ UDPGothic", "Noto Sans JP", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif`。
等幅は `"BIZ UDGothic", Consolas, Menlo, monospace`。引用の**原文のみ**セリフ
(`--f-serif: Georgia, "Times New Roman", …` — webpaper の pull-quote 意匠の保存。和訳はゴシック)。
ウェイトは 400 / 700 の 2 段のみ。
woff2 は同梱しない(システムフォントスタック)。**検証・出力ホストには BIZ UDPGothic と
BIZ UDGothic(等幅)の両方をインストールすること**(Google Fonts の OFL 版。無ければ
verify・PDF が Noto / DejaVu 系の代替面で実測され、サインオフの証跡にならない)。
数値は tabular-nums、和欧間に半角スペース、タイトル内区切りは全角コロン。

## 7. verify 宣言(template.json)

- `footerZonePx: 44`(.sumi-footer の帯)
- `fontFloorExclude: [".kicker"]`(16px の欧文ラベルは意匠上の役物)
