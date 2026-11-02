# sumi テーマ — 正典(レイアウトクラス・部品・トークン)

本ファイルはテーマ正典の型(themes/README.md 契約「テンプレートが提供を義務づけられるもの」の実例)。
生成りの紙 × 墨 × 群青。webpaper デザインシステムの 16:9 翻案(設計の根拠は [DESIGN.md](DESIGN.md))。
**AWS 等の特定ブランド要素を含まない汎用テンプレート。**

## 使い方

デッキからはエントリ CSS を 1 枚 `<link>` する(読み込み順は starter/index.html が正):

```html
<link rel="stylesheet" href="../../themes/sumi/light.css">   <!-- または dark.css -->
```

- **モード切替は 2 点セット**: `light.css ↔ dark.css` と `<html data-deck-theme="light|dark">`。
  sumi はアセット PNG を持たないので差し替えはこの 2 点だけ(new-deck の `--mode` が自動で行う)
- 色・フォント・サイズは**必ずトークン(CSS 変数)経由**。デッキ側に hex を書かない

## ファイル構成

| ファイル | 役割 |
|---|---|
| template.json | マニフェスト(モード・エントリ・verify 宣言: footerZonePx 44 / fontFloorExclude .kicker) |
| starter/index.html | 雛形(new-deck のコピー元。見本 6 面) |
| light.css / dark.css | エントリ(@import で下記を束ねる) |
| vars-light.css / vars-dark.css | 全カラートークン(値の変更はここだけ) |
| fonts.css | BIZ UDPGothic システムスタック(--f-body / --f-mono / --f-serif) |
| base.css | reveal 基礎・h2 縦バー・キッカー・リード・.src・フッター家具・ページ番号・進捗バー |
| components.css | 部品カタログ(パネル・カード・チップ・統計・表・コード・チャート・図解) |
| layouts.css | レイアウトクラス(カバー・章扉・アジェンダ・引用・クロージング) |

## デッキ側の規約

0. **モード属性**: `<html>` に `data-deck-theme="light|dark"`(エントリ CSS と必ず一致)
1. **フッター**: `body` 直下に置く(デッキ題のみ。ロゴ・クレジット類は置かない):

   ```html
   <div class="sumi-footer"><div class="sf-title">デッキ題</div></div>
   ```

   ページ番号はテーマが Reveal の .slide-number を右下に自動配置する(自作しない)。
   下端 44px はフッター帯(template.json の footerZonePx)— 本文を侵入させない
2. **出典行**: `.src`(絶対配置・帯の直上 bottom: 56px)。面の出典はここに書く
3. **カバー(.sumi-cover)ではフッター・ページ番号が自動非表示**になる(墨帯のため)

## レイアウトクラス

| クラス | 用途 | 備考 |
|---|---|---|
| `.sumi-cover` | 表紙 | 墨ベタ全面+群青上ボーダー+深紅タブ。子要素: `.cover-block > .kicker + h1 + .cover-meta > span*n`、`.speaker` / `.speaker-role`。**ダークでは白抜き反転** |
| `.sumi-agenda` | 目次 | `h2` + `ul.agenda > li > .agenda-title + .agenda-desc`。3〜5 項目・1 行ラベル。再訪時 `li.is-current`(群青)/ `li.is-done`(沈める) |
| `.sumi-section` | 章扉 | `.chapter-no`(等幅の章番号・群青)+ `.section-inner > .chapter-rule + .kicker + h2` |
| `.sumi-quote` | 引用 | `.quote-frame > .quote-mark + blockquote(セリフ原文)+ .quote-translation + .quote-source` |
| `.sumi-closing` | 結び | `.closing-statement` + `.closing-sub`。カバー意匠の縮小再演(生成り地) |
| (無指定) | コンテンツ | 左右 64px パディング。`h2`(黒縦バー)+ 任意の `.lead` から書き始める |

## 部品カタログ(components.css)

| 用途 | クラス/型 | 使いどころ |
|---|---|---|
| 格のある枠 | `.titled-panel > .panel-title + .panel-body` | 定義・結論など「格」のあるもの(墨 2px 枠+中央太字タイトル) |
| カード | `.card`(+`.grid .grid--2/--3`)、見出し `.card-title(--dot)` | 要点の列挙 |
| パステルカード | `.pastel-card--lavender/--blue/--mint` | 分類。図中の色チップと同色対応で凡例代わり |
| チップ | `.chip(--gray/--lavender/--blue/--mint)` | 「推奨」「新規」等の短いタグ |
| 統計タイル | `.stat-row > .stat > .stat-value + .stat-label` | KPI。深紅は `.stat-value--key` 1 つだけ |
| テーブル | `table`(`td.num` 右揃え・`td.mark(--best)` 判定・`tr.row-highlight` 推奨行) | 水平罫のみ・th 下罫は墨 |
| コード | `pre`(ライト地)/ `.terminal`(墨地。`.t-label/.t-token/.t-dim`) | スライドでは 10 行程度が上限 |
| チャート箱 | `.chart-panel > .chart-title (+ .chart-subtitle / .chart-caption)` | チャートは必ずこの白箱の中に |
| CSS 横棒 | `.hbar-row > .hbar-label + .hbar-track > .hbar-bar(--compare/--accent) + .hbar-value` | 主役=墨、比較=グレー、強調 1 本だけ群青 |
| SVG チャート | `svg-axis/grid/tick-text/label(--bold/--muted)/series-main/series-compare/dot-*/bar-*/highlight(-line/-ring)/anno` | viewBox 必須の流体 SVG。テキストは 18px 以上 |
| 図解 | `.diagram` + `dg-node(--lavender/--blue/--mint/--ink)/dg-wire(--dashed/--muted)/dg-arrow/dg-junction/dg-group/dg-text(--bold/--desc/--white)` | 白ノード+墨 2px 枠(rx=8 をマークアップで)+直交配線 |
| 文中の型 | `.kicker` / `.lead` / `.small` / `.caption` / `.key-number` / `.key-claim` / `.src` | キッカーは欧文大文字ラベル |

## チャート・図解の規約(webpaper と同一)

- 配色は 2 色だけ: **主役=墨(--chart-main)/ 比較=グレー(--chart-compare)**。
  強調は**深紅 1 点だけ**(「ここを見ろ」専用)。凡例を作らず直接ラベル
- 棒はスクエア端。3D・影・グラデ禁止(グラデは進捗バーのみの例外)
- 注釈を積極的に: リーダーライン・ハイライトリング・しきい値破線
- 図解は白ノード+墨枠+直交配線。ASCII アート禁止。SVG は viewBox のみ(width/height 属性禁止)
- フラグメントの段階強調は**群青**(深紅をアニメの現在位置表示に使わない)

## 主要トークン(全量は vars-*.css)

| トークン | light | dark | 意味 |
|---|---|---|---|
| --bg-page / --bg-panel | #faf8f4 / #ffffff | #1b1a18 / #242320 | 紙 / 一段浮く面 |
| --ink / --ink-mid / --gray-caption | #111 / #555 / #666 | #ece8e1 / #c2bcb1 / #a49e94 | 情報の格 |
| --accent | #2c4fae | #86b4e8 | 群青=強調・現在地 |
| --crimson | #d1495b | #e0687b | 深紅=「ここを見ろ」 |
| --pastel-lavender/-blue/-mint | 淡色 | 暗色対応 | 分類の意味コーディング |
| --line-strong / --line / --line-soft | #111 / #c9c9c9 / #e5e2dc | #d5d0c7 / #4a4741 / #2e2c29 | 罫線の格 |

## 禁止(webpaper の LLM smell リストを継承)

紫系グラデ背景 / 色付き左ボーダーのコールアウト / 過剰な角丸・影・グラスモーフィズム /
絵文字見出し / 根拠なく彩度の高い多色使い / ロゴ・ツールクレジットのフッター記載

