# VSPO Client フロントエンド - リファクタリングドキュメント

## 📋 概要

元の巨大な `renderer.js` ファイル（600行以上）を、以下の構成に分割・再構成しました：

- **state.js**: グローバル状態管理
- **dom.js**: DOM要素の参照キャッシュ・管理
- **api.js**: バックエンド API 呼び出し
- **ui.js**: UI操作（サイドバー、ドロップダウン等）
- **player.js**: ビデオプレイヤーと弾幕機能
- **grid.js**: ビデオグリッド表示ロジック
- **preload.js**: Electronセキュリティ設定
- **renderer.js**: メイン初期化（最小限）

## 🏗️ モジュール構成

### state.js - 状態管理

**責務**: アプリケーションのグローバル状態を一元管理

```javascript
// 保持する状態
- currentMode: 'official' | 'clips'
- currentSelectedChannel: チャンネル名 | 'ALL'
- currentSelectedGame: ゲーム名 | ''
- appData: { official, clips, is_building }
- activeChatSocket: WebSocket | null
- pollingTimer: TimerId | null

// 提供するメソッド
- setMode(mode)
- setSelectedChannel(channel)
- setSelectedGame(game)
- setAppData(data)
- setActiveChatSocket(socket)
- setPollingTimer(timer)
- closeActiveChatSocket()
- clearPollingTimer()
- reset()
- getFilterStatus()
```

**使用例**:
```javascript
import state from './state.js';

state.setMode('official');
state.setSelectedGame('Apex');
console.log(state.currentMode); // 'official'
```

---

### dom.js - DOM要素管理

**責務**: DOM要素への参照をキャッシュし、パフォーマンス最適化・管理を行う

```javascript
// 主な機能
- initDomCache(): すべてのDOM要素をキャッシュして初期化
- getDOM(key): キャッシュからDOM要素を取得
- getAllDOM(): すべてのキャッシュを取得
- toggleSidebar(show): サイドバー表示/非表示
- setTabActive(mode): タブのアクティブ状態を設定
- toggleGameOptions(show): ゲームドロップダウンのON/OFF
- showToast(message): トースト通知を表示
- setGridHTML(mode, html): グリッドコンテナにHTMLを設定
```

**使用例**:
```javascript
import { initDomCache, getDOM, showToast } from './dom.js';

initDomCache(); // 初期化
const btn = getDOM('hamburgerBtn');
showToast('エラーが発生しました');
```

---

### api.js - API通信

**責務**: バックエンドサーバーとの通信を管理

```javascript
// 主な関数
- fetchFeed(): フィードデータを取得
- fetchVideoComments(videoId, limit): ビデオのコメント・説明文を取得
- fetchVideoDescription(videoId): 説明文のみを取得
- createLiveChatWebSocket(videoId, handlers): ライブチャットWSを作成
- closeWebSocket(socket): WebSocketを安全に閉じる
- testApiConnection(): API接続テスト
- getErrorMessage(error): エラーメッセージを取得
```

**使用例**:
```javascript
import { fetchFeed, createLiveChatWebSocket } from './api.js';

// フィード取得
const feedData = await fetchFeed();

// ライブチャット接続
const socket = createLiveChatWebSocket(videoId, {
  onMessage: (data) => console.log('New message:', data),
  onError: (error) => console.error('Error:', error),
  onClose: () => console.log('Connection closed'),
});
```

**エラーハンドリング**:
- タイムアウト処理（15秒）
- ネットワークエラー検出
- JSON解析エラー処理
- WebSocket自動再試行なし（手動で実装可能）

---

### ui.js - UI操作管理

**責務**: ユーザーインターフェース操作（サイドバー、ドロップダウン、タブ等）を管理

```javascript
// 主な関数
- initializeUI(): UI全体を初期化
- initializeSidebar(): サイドバーセットアップ
- initializeGameDropdown(): ゲーム選択ドロップダウン
- initializeTabButtons(): 配信/切り抜きタブ
- initializeGlobalHandlers(): グローバルイベントハンドラー
- initializeBackButton(): 戻るボタン
- setSelectedChannel(value): チャンネル選択を更新
- setMode(mode): 表示モード（official/clips）を切り替え
- closePlayer(): プレイヤーを閉じる
- getTargetChannels(): チャンネルリストを取得
```

**使用例**:
```javascript
import { initializeUI, setMode, closePlayer } from './ui.js';

initializeUI(); // 一括初期化
setMode('clips'); // クリップスモードに切り替え
closePlayer(); // プレイヤーを閉じる
```

---

### grid.js - ビデオグリッド表示

**責務**: ビデオリストのフィルタリング・ソート・表示を管理

```javascript
// 主な関数
- renderGrid(state, dom): グリッドをレンダリング
- buildVideoCardHTML(item): ビデオカードHTMLを生成
- formatRelativeTime(timestamp): 相対時間をフォーマット（例：「3時間前」）
- filterVideos(videos, filters): ビデオをフィルタリング
- sortVideos(videos): ビデオをソート
- renderEmptyGrid(dom, mode, message): 空のグリッドを表示
- renderLoadingGrid(dom, mode): ローディング状態を表示
```

**フィルタリング・ソート順序**:
1. ライブ配信 (LIVE)
2. 予定配信 (UPCOMING)
3. 過去の配信（タイムスタンプ新しい順）
4. 同じチャンネル内ではアップロード順

**使用例**:
```javascript
import { renderGrid, filterVideos, sortVideos } from './grid.js';

// グリッド全体をレンダリング
renderGrid(state, { getGridContainer, getDOM });

// フィルタリングのみ
const filtered = filterVideos(videos, {
  channel: 'ALL',
  game: 'Apex',
  searchWords: '配信'
});

// ソートのみ
const sorted = sortVideos(filtered);
```

---

### player.js - ビデオプレイヤー

**責務**: YouTube埋め込みプレイヤーと弾幕（ライブチャット）機能

```javascript
// 主な関数
- playVideo(videoId, title, isLive): ビデオ再生開始
- renderPlayer(videoId, title, isLive): プレイヤーをレンダリング
- closePlayer(): プレイヤーを閉じる
- setupLiveChat(videoId): ライブチャットを接続
```

**機能**:
- YouTube埋め込みプレイヤー
- 再読込ボタン
- ブラウザで開くボタン
- ライブ配信時のみ：
  - ライブチャット（弾幕）表示
  - 弾幕ON/OFFトグル
  - コメント流れるアニメーション
- ビデオ説明文の表示・折りたたみ
- 説明文内のURLをクリック可能に

**使用例**:
```javascript
import { playVideo } from './player.js';

playVideo('dQw4w9WgXcQ', 'Sample Video', false);
```

---

### preload.js - Electronセキュリティ設定

**責務**: レンダラープロセスとメインプロセス間の安全な通信

**セキュリティ対策**:
- URLホワイトリスト検証（http/https のみ）
- 疑わしいプロトコル（javascript:, data: など）の検出
- 入力値のサニタイズと長さチェック
- IPC通信のエラーハンドリング
- ログレベルの制限

**公開API**:
```javascript
window.api = {
  openExternalUrl(url): 外部URLをブラウザで開く
  getAppVersion(): アプリバージョン取得
  getPlatform(): OS情報取得
  onAppEvent(channel, listener): アプリイベント監視
  logger: { info, warn, error, debug }
  getProcessId(): プロセスID取得
  isDevelopment(): 開発環境判定
}
```

**使用例**:
```javascript
if (window.api) {
  window.api.openExternalUrl('https://example.com');
  window.api.logger.info('App started');
}
```

---

### renderer.js - メイン初期化

**責務**: 各モジュールを統合し、アプリケーション全体を初期化

**処理フロー**:
1. DOMContentLoaded時に `initializeApp()` を実行
2. DOM要素をキャッシュ
3. UI要素を初期化（サイドバー、ドロップダウン、タブ等）
4. イベントハンドラーを登録
5. サーバーからフィードを読み込み
6. グリッドを描画
7. ポーリング開始（サーバーが構築中の場合）

**エラーハンドリング**:
- 初期化失敗時のトースト通知
- API接続エラー時のポーリング継続
- グローバルエラーハンドラー（uncaughtException）
- 未処理のPromise拒否ハンドラー

---

## 🔄 モジュール間の依存関係

```
renderer.js (主要オーケストレーター)
    ├── state.js (状態管理)
    ├── dom.js (DOM操作)
    ├── api.js (API通信)
    ├── ui.js (UI操作)
    │   ├── state.js
    │   ├── dom.js
    │   └── grid.js
    ├── grid.js (グリッド表示)
    │   ├── state.js
    │   └── dom.js
    └── player.js (プレイヤー)
        ├── api.js
        ├── dom.js
        └── state.js
```

---

## ✅ 改善点

### 1. **モジュール分離**
- 責務を明確に分離
- 各モジュールが単一の責務を持つ
- 再利用性向上

### 2. **状態管理の一元化**
- グローバル変数の分散排除
- `state` オブジェクトで統一管理
- 状態追跡が容易

### 3. **DOM操作の効率化**
- DOM要素をキャッシュ（毎回のselect避ける）
- パフォーマンス向上
- メモリリーク防止

### 4. **エラーハンドリング**
- API通信のタイムアウト設定
- ネットワークエラー検出
- ユーザーフレンドリーなエラーメッセージ

### 5. **セキュリティ向上**
- preload.js でIPC通信を保護
- URL入力検証
- XSS対策

### 6. **ロギング**
- console.log で処理フロー追跡可能
- [モジュール名] プレフィックス付き
- デバッグが容易

---

## 🚀 使用方法

### 初期化

```javascript
// renderer.js が自動的に DOMContentLoaded で初期化
// 追加の設定不要
```

### UI制御

```javascript
import { setMode, setSelectedChannel } from './ui.js';

// モード切り替え
setMode('clips');

// チャンネル選択
setSelectedChannel('花芽すみれ');
```

### ビデオ再生

```javascript
import { playVideo } from './player.js';

playVideo('videoId123', 'Video Title', false);
```

### フィード更新

```javascript
// 自動更新（5秒ごと、サーバー構築中の場合）
// または手動リフレッシュボタンで更新
window.triggerFeedRefresh();
```

---

## 🔧 マイグレーションガイド

### 既存コードからの移行

**前:**
```javascript
currentMode = "official";
appData = { official: [], clips: [] };
playVideo(videoId, title, isLive);
```

**後:**
```javascript
import state from './state.js';
import { playVideo } from './player.js';

state.currentMode = 'official';
state.appData = { official: [], clips: [] };
playVideo(videoId, title, isLive);
```

---

## 📝 ベストプラクティス

### 1. 状態管理

- **✅ 推奨**: `state.setMode()` でメソッドを使用
- **❌ 非推奨**: 直接 `state.currentMode = 'clips'` に代入

### 2. DOM操作

- **✅ 推奨**: `getDOM('elementId')` でキャッシュから取得
- **❌ 非推奨**: 毎回 `document.getElementById()` を実行

### 3. API通信

- **✅ 推奨**: try-catch で async/await を使用
- **❌ 非推奨**: Promise チェーンで複数層のネスト

```javascript
try {
  const data = await fetchFeed();
  // 処理
} catch (error) {
  console.error('Error:', error);
}
```

### 4. エラーハンドリング

- **✅ 推奨**: `showToast()` でユーザーに通知
- **❌ 非推奨**: 無言でエラー処理

```javascript
try {
  // 何か処理
} catch (error) {
  showToast('エラーが発生しました。');
}
```

---

## 🧪 テスト方法

### 単体テスト

各モジュールは独立していため、単位テストが容易です：

```javascript
// state.js のテスト
import state from './state.js';
state.setMode('clips');
assert.equal(state.currentMode, 'clips');

// grid.js のテスト
import { formatRelativeTime } from './grid.js';
const time = formatRelativeTime(Date.now() / 1000 - 3600);
assert.equal(time, '1時間前');
```

### 統合テスト

```javascript
import { playVideo } from './player.js';
playVideo('testVideoId', 'Test', false);
// UI が変更されたか確認
```

---

## 🐛 デバッグ

### ログ出力

すべてのモジュールは console.log で処理を記録：

```
[App] Initializing application...
[App] DOM cache initialized
[App] UI initialized
[Feed] Loading feed from server...
[Feed] Feed loaded: { official: 42, clips: 15, is_building: false }
```

### ブラウザ DevTools

1. Console タブでログを確認
2. Application → Local Storage で状態確認
3. Network タブで API 呼び出しを監視

---

## 📚 参考資料

- [Electron Security Best Practices](https://www.electronjs.org/docs/tutorial/security)
- [JavaScript Modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
- [Web APIs](https://developer.mozilla.org/en-US/docs/Web/API)

---

## 📄 ライセンス

このプロジェクトはVSPO Clientの一部です。

---

**最終更新**: 2024年
**バージョン**: 2.0 (Modularized)