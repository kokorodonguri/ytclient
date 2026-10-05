---
name: a11y-review
description: フロントエンド変更のアクセシビリティ+マルチデバイスレビュー。UI (src/frontend) に変更を加えたとき、またはリリース前チェックとして実行する。レスポンシブ崩れ・コントラスト・キーボード操作・ARIAセマンティクスを実機(ブラウザ)で検証する。
---

# アクセシビリティ + マルチデバイス レビュー

VSPO Client のフロントエンド (`src/frontend/`) を対象に、実際にアプリを起動して検証する。
静的読解だけでは完了にしない。未実行項目は「未確認」と明示する。

## 起動方法

バックエンド (ポート8010) がフロントエンドも配信する。localhost配信時のAPI先は
`constants.js` のLAN既定値になるため、**必ずクエリで上書きする**:

```
http://127.0.0.1:8010/app/?apiBaseUrl=http%3A%2F%2F127.0.0.1%3A8010
```

バックエンドが未起動なら `python src/backend/main.py 8010 127.0.0.1`。
依存不足 (`pytchat` 等) で起動できない場合は `pip install -r backend-requirements.txt` 後に再試行し、
それでも不可ならブート検証を「未確認」と記録する。

## チェックリスト

### 1. レスポンシブ (viewport: 1280 / 768 / 375)

各幅でリロード→同一操作で確認:

- `document.documentElement.scrollWidth - clientWidth` が 0 (横スクロール禁止。`body{overflow-x:hidden}` がバグを隠すので必ず scrollWidth で測る)
- `.controls` の bottom が `#main-header` の bottom 以内 (ヘッダーは `min-height` + `flex-wrap` 前提。固定 `height` に戻さない)
- `#settings-btn` が viewport 内に見えている (≤480px では `.controls .icon-control-btn{width:100%}`)
- 長い日本語タイトルの `-webkit-line-clamp` は全ブレークポイントで 2 行
- 再生時: `.player-status-bar` / `.player-fallback-actions` は `flex-wrap:wrap` のため 375px で折り返すこと (クリップ・到達不可は blocker)。split 表示 (`split-player-status-bar`) も同条件で確認
- 再生中は映像を最大化するため `body.is-player-open` で一覧向けの表示を畳む: `.feed-status-panel` は `display:none`、`.player-title` は `.sr-only` 相当 (見出しは AT に残す)、`main` の `max-width` 解除。閉じたら必ず元に戻ること (戻る / Esc / タブ切替の3経路すべて)
- 900px 以下では操作列のボタンがアイコンのみになる (`.btn-label` を視覚的に隠す)。**ラベル要素を削除してはいけない** — アクセシブル名が失われる。アイコン (`.btn-icon`) は `aria-hidden="true"` 必須
- 設定モーダルの API キー欄 (`type=password`) が `input[type=text]` と同じ見た目であること (セレクタは両対応が前提)

### 2. コントラスト (ライト/ダーク両方) + 視覚

- テキストに使う色は `--primary-text` / `--success-text` / `--warning-text` / `--error-text` / `--info-text` を使う。`--primary` (#007AFF) や `--success` 等の生のシステムカラーをテキストに使わない (AA未達)
- `.status-pill` は背景も枠も持たない。状態は文字色 + `::before` の形 (●塗り / ○リング / − 線) で二重に示す
- サムネイル上に載せてよいのは `.time-badge` だけ (`rgba(0,0,0,.55)` + `backdrop-filter`、非対応環境は `.75` の不透明にフォールバック)。種別は本文側の `.card-status` に 1 つだけ出す
- `.card-status` の 4 状態は「塗り (LIVE) > ティント (配信予定) > 灰枠 (アーカイブ) > 素 (動画)」で区別する。
  アクセントは System Blue 1 色だけなので、色相ではなく塗りの有無と濃度で 4 段を作る
  (モノクロ / 色覚特性でも判別できる必要がある)
- スキップリンクのリングは `--focus-ring-color` を使う (`--primary` は非テキスト比不足のため不可)
- 塗りを持たない操作要素 (入力欄) の輪郭は `--border-strong`。背景に対して 3:1 以上を維持する (WCAG 1.4.11)。
  装飾の仕切りは `--border-color` (black 6% / white 8%) を使い、操作要素の輪郭には使わない
- 半透明素材 (`--material-thick` + `backdrop-filter`) を使う箇所は、`@supports not (backdrop-filter)` で
  不透明の `--bg-solid` にフォールバックすること。ぼかしが効かない環境で文字が下の内容に埋もれる
- アクセントは System Blue 1 色。`--primary` は非テキスト専用 (3:1)、文字には `--primary-text`、
  白文字を載せる塗りには `--primary-fill` を使う (#007AFF に白文字は 4.02:1 で AA 未達)
- `--text-tertiary` は `--bg-base` 上で 4.5:1 を満たす値に保つ (`.card-status` の既定色に使っている)
- フォント 200% 拡大で破綻しないこと。`white-space:nowrap` + 固定 px 幅 (`free-word-input:160px` 等) の組み合わせは要注意
- `prefers-reduced-motion` 時: hover の transform 無効、弾幕は非表示 (player.js 側にも matchMedia ガードあり)
- font-size は rem を維持 (px を新規追加しない)
- タップターゲット 44px は `@media (pointer:coarse),(any-pointer:coarse)` ブロックで担保。新ボタン・アイコン系 (`.hamburger-btn` 含む) はそこに追加

### 3. キーボード

- ゲームドロップダウン: ArrowUp/Down で開閉・移動、Enter で確定、Escape で閉じる (ボタン外フォーカス時の Esc は document ハンドラが閉じる)、`aria-activedescendant` + `.focused` は close 時に必ず除去、ボタンに `aria-controls="game-options"` 必須
- タブ (メンバー配信/切り抜き): ArrowLeft/Right で移動+切替、非アクティブ側は `tabindex="-1"`
- プレイヤー: カード Enter → フォーカスは操作列先頭の `#back-btn` へ (操作列内に動的生成されるため、描画完了後に移る)、Esc (iframe 外フォーカス時) または戻るボタンで閉じて元のカードへ復帰。設定モーダル表示中の Esc はモーダル優先
- 操作列は DOM 上も視覚上も映像より前。Tab 順が `#back-btn` → 各操作 → iframe になっていること (iframe より後ろに操作が来たら WCAG 2.4.3 の退行)
- 設定モーダル: Tab がモーダル内で循環 (可視判定は `getClientRects().length>0`。`offsetParent` は fixed で誤判定するため不可)、Escape で閉じる、閉じたら `#settings-btn` にフォーカス復帰、背景は `inert`
- サイドバー: 閉時は `inert`、ハンバーガーに `aria-expanded` 同期、Escape で閉じてフォーカス復帰
- `type=url` への変更は禁止: バックエンド欄は IP 単体入力を許すため `type=text` + `inputmode=url` を維持する

### 4. セマンティクス

- 動的生成される `<button class="video-card">` 内に見出しタグ (h1-h6) を入れない (span を使う)
- サムネイル img は `alt=""` (ボタンの aria-label が名前を持つ)
- スケルトン (`.skeleton-grid`) は `aria-hidden="true"` (SR のゴミ読み防止)
- 装飾絵文字は `aria-hidden="true"`
- iframe には `title` 必須
- ライブリージョンは `#feed-summary` (polite/atomic)、`#connection-status` と `.player-panel-status` (`role=status` polite)、トーストコンテナのみ。増やさない・入れ子にしない
- チャンネル選択は `aria-current` を同期する (class だけの状態表現は不可)

### 5. その他

- 最後に `node --experimental-vm-modules scripts/check-syntax.mjs` を実行 (npm が使えない環境では node 直呼び)

## レポート

発見した問題は下記形式で記録する:

```text
[file:line] 重要度(blocker/major/minor) タイトル
再現: 幅/テーマ/操作手順
期待/実際: …
修正案: …
```

## 残存リスク (毎回記述)

- 未操作: … / 未実測: … (例: 実機 VoiceOver、200%+375px 併用、半透明合成色の実測)
- `npm run check` (または node 直呼び) の結果: …
