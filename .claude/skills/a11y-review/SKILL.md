---
name: a11y-review
description: フロントエンド変更のアクセシビリティ+マルチデバイスレビュー。UI (src/frontend) に変更を加えたとき、またはリリース前チェックとして実行する。レスポンシブ崩れ・コントラスト・キーボード操作・ARIAセマンティクスを実機(ブラウザ)で検証する。
---

# アクセシビリティ + マルチデバイス レビュー

VSPO Client のフロントエンド (`src/frontend/`) を対象に、実際にアプリを起動して検証する。

## 起動方法

バックエンド (ポート8010) がフロントエンドも配信する。localhost配信時のAPI先は
`constants.js` のLAN既定値になるため、**必ずクエリで上書きする**:

```
http://127.0.0.1:8010/app/?apiBaseUrl=http%3A%2F%2F127.0.0.1%3A8010
```

バックエンドが未起動なら `python src/backend/main.py 8010 127.0.0.1`。

## チェックリスト

### 1. レスポンシブ (viewport: 1280 / 800 / 768 / 375)
各幅で JS 実行して確認:
- `document.documentElement.scrollWidth - clientWidth` が 0 (横スクロール禁止。`body{overflow-x:hidden}` がバグを隠すので必ず scrollWidth で測る)
- `.controls` の bottom が `#main-header` の bottom 以内 (ヘッダーは `min-height` + `flex-wrap` 前提。固定 `height` に戻さない)
- `#settings-btn` が viewport 内に見えている
- 長い日本語タイトルの `-webkit-line-clamp` は全ブレークポイントで 2 行

### 2. コントラスト (ライト/ダーク両方)
- テキストに使う色は `--primary-text` / `--success-text` / `--warning-text` / `--error-text` / `--info-text` を使う。`--primary`(#ec4899) や `--success` 等の生のブランド色をテキストに使わない (AA未達)
- ダークモードでの status-pill・保存ボタン (`.player-fallback-open-btn`) を実測 (過去に白背景に白文字の事故あり)
- サムネイル上のバッジ背景は不透明な濃色を維持

### 3. キーボード
- ゲームドロップダウン: ArrowUp/Down で開閉・移動、Enter で確定、Escape で閉じる、`aria-activedescendant` が追従
- タブ (メンバー配信/切り抜き): ArrowLeft/Right で移動+切替、非アクティブ側は `tabindex="-1"`
- 設定モーダル: Tab がモーダル内で循環、Escape で閉じる、閉じたら `#settings-btn` にフォーカス復帰、背景は `inert`
- サイドバー: 閉時は `inert`、ハンバーガーに `aria-expanded` 同期、Escape で閉じてフォーカス復帰
- カード Enter → プレイヤー表示でフォーカスは `#back-btn` へ、戻ると元のカードへ

### 4. セマンティクス
- 動的生成される `<button class="video-card">` 内に見出しタグ (h1-h6) を入れない (span を使う)
- サムネイル img は `alt=""` (ボタンの aria-label が名前を持つ)
- 装飾絵文字は `aria-hidden="true"`
- iframe には `title` 必須
- ライブリージョンは `#feed-summary` (polite/atomic) とトーストコンテナのみ。増やさない・入れ子にしない
- チャンネル選択は `aria-current` を同期する (class だけの状態表現は不可)

### 5. その他
- `prefers-reduced-motion` 時: hover の transform 無効、弾幕は非表示 (player.js 側にも matchMedia ガードあり)
- font-size は rem を維持 (px を新規追加しない)
- タッチ端末 (`pointer: coarse`) のタップターゲット 44px は media block で担保済み — 新ボタンはそこに追加
- 最後に `npm run check` を実行

## レポート

発見した問題は file:line・重大度・再現条件・修正案を添えて報告する。
