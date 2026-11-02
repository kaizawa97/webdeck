# themes/ — テンプレート(テーマ)契約の正典

このディレクトリの直下 1 ディレクトリ = 1 テンプレート(意匠パッケージ)。
**テンプレートは丸ごと削除・追加できる**ことがこのプラットフォームの設計目標であり、
そのために全テンプレートは本ファイルが定める**テーマ契約**に適合する。

- 汎用ドキュメント(`SKILL.md`・`docs/`)は**この契約にのみ言及する**。
  実測値・クラス語彙・誤検知の仕様・テーマ固有の教訓は、必ず `themes/<name>/` 配下に置く
  (この配置の不変条件が破られると、テンプレート削除で汎用側が壊れる)
- ツール(`tools/new-deck.mjs`・`tools/verify.mjs`)はテンプレート名をハードコードせず、
  **`template.json`(マニフェスト)を読んで動く**

## ディレクトリ構成(契約)

```
themes/<name>/
├── template.json      ← マニフェスト(必須。機械可読な契約)
├── starter/index.html ← 雛形(必須。new-deck のコピー元。defaultMode で書く)
├── README.md          ← テーマ正典(必須。レイアウトクラス・部品・トークンの一覧)
├── DESIGN.md          ← 設計仕様(任意。意匠の出自・実測根拠)
├── LESSONS.md         ← テーマ固有の教訓(任意。汎用の教訓は docs/LESSONS.md へ)
├── <mode>.css         ← モードごとのエントリ CSS(@import で束ねる 1 枚)
├── assets/<mode>/     ← モード別アセット(任意。無ければ CSS のみで完結)
└── fonts/             ← 同梱フォント(任意)
```

## template.json スキーマ(contract v1)

```jsonc
{
  "name": "aws",                    // ディレクトリ名と一致(必須)
  "displayName": "AWS ブランドテーマ",
  "contract": 1,                    // 契約バージョン(必須)
  "modes": ["light", "dark"],       // 提供モード(必須。1 つでも可)
  "defaultMode": "light",           // starter が書かれているモード(必須)
  "entry": {                        // モード → エントリ CSS(必須)
    "light": "light.css",
    "dark": "dark.css"
  },
  "modeAssets": {                   // モード別アセット dir(任意。モード切替で対置換)
    "light": "assets/light/",
    "dark": "assets/dark/"
  },
  "themeAttr": "data-deck-theme",   // デッキ <html>/<body> に付くモード属性名(必須)
  "legacyThemeAttrs": [],           // 旧属性名(任意。verify が両対応で読む)
  "starter": "starter/index.html",  // 雛形パス(必須)
  "verify": {                       // 検証パラメータ(必須)
    "footerZonePx": 56,             // 下端フッター家具の帯高さ。家具なしテーマは 0
    "fontFloorExclude": [".eyebrow"] // フォント床検査から除外するテーマ部品(小さくて当然の役物)
  }
}
```

## テンプレートが提供を義務づけられるもの

1. **`--pp-*` トークン一式**(エントリ CSS 経由で必ず定義する)。
   runtime(操作ドック・スピーカービュー・投影)と出力系(PDF の地色検査・PPTX 撮影)が参照する:

   ```
   --pp-bg  --pp-fg  --pp-accent  --pp-font  --pp-letterbox  --pp-canvas-edge
   --pp-dock-bg  --pp-dock-fg  --pp-dock-border  --pp-dock-hover
   --pp-dock-active  --pp-dock-shadow  --pp-progress-track
   --r-overlay-element-bg-color  --r-overlay-element-fg-color   (Reveal スクロールバー用 RGB トリプレット)
   ```

2. **starter**: 全モード切替が `entry` と `modeAssets` の**文字列対置換だけで成立する**こと
   (エントリ CSS 参照とアセット参照以外にモード依存の記述を書かない)。
   キャンバスは 1280×720。`themeAttr` 属性を defaultMode の値で持つこと
3. **README.md(テーマ正典)**: デッキ執筆者(LLM)が読む唯一のテーマ文書。
   最低限、①エントリ CSS の読み込み方とモード切替の 2 点セット、②レイアウトクラス表、
   ③部品カタログ、④デザイントークン一覧、⑤フッター家具等の必須マークアップ契約、を含む
4. **プラットフォーム共通規約との整合**: 色・フォントはトークン経由
   (デッキ側でのハードコード禁止を成立させる)。外部 CDN 参照禁止。
   出典行 `.src` を採用する場合は `bottom: 72px` 付近(フッター帯の直上)に置く

## モード切替の仕組み(new-deck / 手動共通)

light → dark 等の切替は **2 点セットの対置換**で行う:
`entry[from] → entry[to]` と `modeAssets[from] → modeAssets[to]`(定義があれば)。
片方だけ替えると背景と部品の系統が割れて不可視スライドが生まれる。
`themeAttr` の値も同じモード名に揃える。

## テンプレートの追加手順

1. このディレクトリに `<name>/` を切り、上記構成で実装する(既存テーマの README を型として使う)
2. `template.json` を書く(スキーマは上記)
3. `node tools/new-deck.mjs ~/tmp/smoke-<name> --template <name>` で雛形を生成し、
   `node tools/verify.mjs ~/tmp/smoke-<name>` が素で通ることを確認する(これが契約スモーク)。
   生成先はリポジトリと共通祖先を持つ場所にすること(`/tmp` 直下は祖先が `/` になり拒否される)
4. モードが複数あるなら各モードで 3 を繰り返す

## 削除・配布

テンプレートの削除は `themes/<name>/` を消すだけ。ツールはディスカバリベース
(残テンプレートが 1 つなら `--template` 省略時に自動選択)なので他に修正は不要。
既存デッキには削除したテーマへの参照が残り得るため、テンプレートを消す前に
参照元のデッキを別テンプレートへ移行しておくこと。
