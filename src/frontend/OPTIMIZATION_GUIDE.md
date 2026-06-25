# フロントエンドコード最適化ガイド

## 📋 概要

このドキュメントでは、フロントエンドコードの最適化、リファクタリング、および推奨事項について説明します。

### ✨ 主な改善点

- **コード重複の削除**: 同じ機能を複数の場所で定義していたコードを統合
- **モジュール化の強化**: 機能ごとのモジュール分離を明確化
- **定数の一元管理**: ハードコードされた値を`constants.js`に集約
- **ユーティリティ関数の充実**: 共通処理を`utils.js`に統合
- **エラーハンドリングの改善**: 一貫性のあるエラー処理パターン
- **ロギングの標準化**: 全モジュールで統一されたログ出力
- **パフォーマンス最適化**: DOM操作のキャッシング、デバウンス処理
- **アクセシビリティの向上**: ARIA属性の追加、キーボード操作対応

---

## 📁 モジュール構造

### コアモジュール

#### `constants.js`
**役割**: アプリケーション全体の定数と設定値を一元管理

```javascript
// API設定
API_CONFIG.BASE_URL
API_CONFIG.TIMEOUT
API_CONFIG.ENDPOINTS

// チャンネル設定
CHANNELS.ALL
CHANNELS.MEMBERS[]

// ゲームフィルター
GAME_FILTERS[]

// モード定義
VIDEO_MODES.OFFICIAL
VIDEO_MODES.CLIPS

// UI定数
UI_CONSTANTS
TIMING
STORAGE_KEYS
MESSAGES
```

**使用例**:
```javascript
import { CHANNELS, MODES, MESSAGES } from './constants.js';

// チャンネル一覧にアクセス
CHANNELS.MEMBERS.forEach(channel => {
  console.log(channel.name);
});

// モード定数を使用
if (mode === MODES.OFFICIAL) { ... }

// エラーメッセージを表示
showToast(MESSAGES.ERROR.NETWORK);
```

#### `utils.js`
**役割**: 複数のモジュールで使用される汎用ユーティリティ関数

主要な関数群:
- **HTML安全性**: `escapeHTML()`, `escapeAttribute()`
- **時間フォーマット**: `formatRelativeTime()`
- **非同期処理**: `debounce()`, `throttle()`, `delay()`
- **イベント管理**: `safeAddEventListener()`, `addMultipleEventListeners()`
- **DOM観察**: `observeElementVisibility()`
- **ローカルストレージ**: `getFromLocalStorage()`, `saveToLocalStorage()`
- **ロギング**: `log()`, `logError()`, `logWarn()`

**使用例**:
```javascript
import { escapeHTML, debounce, log } from './utils.js';

// XSS対策
const safeName = escapeHTML(userInput);

// 検索のデバウンス
const handleSearch = debounce(() => {
  renderGrid(state, { getGridContainer, getDOM });
}, 300);

// ログ出力
log('MODULE', 'Processing started', { count: 10 });
```

#### `dom.js`
**役割**: DOM要素の操作と状態管理を一元化

主要機能:
- DOM要素キャッシング（シングルトン）
- サイドバー操作
- タブ管理
- ドロップダウン操作
- グリッドコンテナ管理
- プレイヤー制御
- トースト通知
- モーダル管理

**使用例**:
```javascript
import { 
  getDOM, 
  showToast, 
  toggleSidebar, 
  setTabActive 
} from './dom.js';

// DOM要素を取得
const refreshBtn = getDOM('refreshBtn');

// トースト通知を表示
showToast('保存しました', 'success');

// UI操作
toggleSidebar(true); // 開く
setTabActive('official'); // タブ切り替え
```

#### `state.js`
**役割**: アプリケーションのグローバル状態を管理

```javascript
state = {
  // UI状態
  currentMode: 'official',
  currentSelectedChannel: 'ALL',
  currentSelectedGame: '',

  // データ状態
  appData: {
    official: [],
    clips: [],
    is_building: false,
  },

  // 接続状態
  activeChatSocket: null,
  pollingTimer: null,
}
```

**ベストプラクティス**: 状態変更は常にstate経由で行う

#### `ui.js`
**役割**: UIイベントハンドラーと初期化を管理

主要な初期化関数:
- `initializeUI()` - UI全体の初期化
- `initializeSidebar()` - サイドバー初期化
- `initializeGameDropdown()` - ゲームドロップダウン初期化
- `initializeTabButtons()` - タブボタン初期化
- `initializeGlobalHandlers()` - グローバルイベント初期化

状態管理関数:
- `setSelectedChannel(value)` - チャンネル選択
- `setMode(mode)` - モード切り替え
- `closePlayer()` - プレイヤーを閉じる

**使用例**:
```javascript
import { setMode, setSelectedChannel } from './ui.js';
import { MODES, CHANNELS } from './constants.js';

// モード切り替え
setMode(MODES.CLIPS);

// チャンネル選択
setSelectedChannel(CHANNELS.ALL.value);
```

#### `grid.js`
**役割**: ビデオグリッドの表示ロジック

主要機能:
- `buildVideoCardHTML(item)` - カード生成
- `filterVideos(videos, filters)` - フィルタリング
- `sortVideos(videos)` - ソート
- `renderGrid(state, dom)` - グリッド描画

フィルター対応:
- チャンネル別フィルター
- ゲーム別フィルター
- 自由キーワード検索

ソート優先度:
1. ライブ配信（優先度: 2）
2. 予定配信（優先度: 1）
3. 通常動画（優先度: 0）
4. タイムスタンプ順（新しい順）

**使用例**:
```javascript
import { renderGrid, filterVideos } from './grid.js';

// グリッドをレンダリング
renderGrid(state, { getGridContainer, getDOM });

// ビデオをフィルタリング
const filtered = filterVideos(videos, {
  channel: 'ALL',
  game: 'Apex',
  searchWords: 'コラボ',
});
```

#### `api.js`
**役割**: バックエンド通信を一元管理

主要機能:
- `fetchFeed()` - フィード取得
- `fetchVideoComments(videoId, limit)` - コメント・説明文取得
- `createLiveChatWebSocket(videoId, handlers)` - WebSocket作成
- `openExternalUrl(url)` - 外部URL開放
- `getYouTubeWatchUrl(videoId)` - YouTube視聴URL生成
- `getYouTubeEmbedUrl(videoId)` - YouTube埋め込みURL生成

エラーハンドリング:
- タイムアウト処理
- JSON解析エラー
- ネットワークエラー

**使用例**:
```javascript
import { fetchFeed, openExternalUrl } from './api.js';

// フィード取得
try {
  const feed = await fetchFeed();
  state.appData = feed;
} catch (error) {
  console.error('Feed fetch failed:', error);
}

// URLを外部で開く
await openExternalUrl('https://youtube.com/watch?v=xyz');
```

#### `player.js`
**役割**: ビデオプレイヤーと弾幕機能を管理

主要機能:
- `playVideo(videoId, title, isLive)` - ビデオ再生
- `renderPlayer(videoId, title, isLive)` - プレイヤー描画
- `setupLiveChat(videoId)` - ライブチャット設定

#### `renderer.js`
**役割**: アプリケーションのメイン初期化とライフサイクル管理

主要処理:
- アプリケーション初期化
- フィード読み込み・レンダリング
- ポーリング管理
- グローバルコマンド定義
- エラーハンドリング

---

## 🎯 ベストプラクティス

### 1. 定数の使用

❌ **非推奨**:
```javascript
if (mode === 'official') { ... }
const BASE_URL = 'http://127.0.0.1:8000';
```

✅ **推奨**:
```javascript
import { MODES, API_CONFIG } from './constants.js';

if (mode === MODES.OFFICIAL) { ... }
const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.FEED}`;
```

### 2. エスケープ処理

❌ **非推奨**:
```javascript
element.innerHTML = userInput; // XSS脆弱性
```

✅ **推奨**:
```javascript
import { escapeHTML } from './utils.js';

element.innerHTML = escapeHTML(userInput);
```

### 3. ロギング

❌ **非推奨**:
```javascript
console.log('Processing...');
console.error('Error occurred');
```

✅ **推奨**:
```javascript
import { log, logError } from './utils.js';

log('MODULE_NAME', 'Processing started', { data });
logError('MODULE_NAME', 'Error occurred', error);
```

### 4. 非同期処理

❌ **非推奨**:
```javascript
input.addEventListener('input', () => {
  renderGrid(); // 毎回レンダリング
});
```

✅ **推奨**:
```javascript
import { debounce } from './utils.js';

const handleSearch = debounce(() => {
  renderGrid();
}, 300);

input.addEventListener('input', handleSearch);
```

### 5. エラーハンドリング

❌ **非推奨**:
```javascript
try {
  // 処理
} catch (error) {
  console.log('Error');
}
```

✅ **推奨**:
```javascript
try {
  // 処理
} catch (error) {
  logError('MODULE', 'Description of error', error);
  showErrorToast(MESSAGES.ERROR.SPECIFIC_ERROR);
}
```

### 6. DOM操作

❌ **非推奨**:
```javascript
document.getElementById('btn').addEventListener(...);
document.getElementById('btn').addEventListener(...); // 毎回取得
```

✅ **推奨**:
```javascript
import { getDOM } from './dom.js';

const btn = getDOM('btn');
btn.addEventListener('click', handler1);
btn.addEventListener('click', handler2);
```

### 7. 状態管理

❌ **非推奨**:
```javascript
let currentMode = 'official';
let selectedChannel = 'ALL';

// どこからでも変更可能
currentMode = 'clips';
```

✅ **推奨**:
```javascript
import state from './state.js';
import { setMode, setSelectedChannel } from './ui.js';

// 統一されたAPI経由で変更
setMode('clips');
setSelectedChannel('ALL');
```

---

## ⚡ パフォーマンス最適化

### 1. DOM キャッシング

DOM要素は`dom.js`で初期化時に一度だけ取得されキャッシュされます。
毎回`getElementById()`を呼ぶことなく、`getDOM(key)`で再利用可能です。

```javascript
// 初期化時に一度だけ
const domCache = {
  refreshBtn: document.getElementById('refresh-btn'),
  officialContainer: document.getElementById('official-container'),
  // ...
};

// 使用時はキャッシュから取得
const refreshBtn = getDOM('refreshBtn'); // 高速
```

### 2. デバウンス・スロットル

連続して呼ばれる処理（検索、リサイズなど）は最適化します。

```javascript
// 検索入力は300msのデバウンスをかける
const debouncedSearch = debounce(() => {
  renderGrid(state, { getGridContainer, getDOM });
}, 300);

freeWordInput.addEventListener('input', debouncedSearch);
```

### 3. メモリ管理

不要なリスナーやタイマーは確実にクリアします。

```javascript
// cleanup()関数でタイマーをクリア
if (state.pollingTimer) {
  clearTimeout(state.pollingTimer);
  state.pollingTimer = null;
}

// WebSocketをクローズ
if (state.activeChatSocket) {
  state.activeChatSocket.close();
  state.activeChatSocket = null;
}
```

---

## 🔍 デバッグ・開発

### ブラウザコンソールコマンド

```javascript
// アプリケーション状態を確認
window.getAppState()

// アプリケーション設定を確認
window.getAppConfig()

// 手動でフィードを更新
window.triggerFeedRefresh()

// グリッドを手動で再レンダリング
window.reRenderGrid()
```

### ログ出力の活用

すべてのモジュールは`[MODULE_NAME]`プレフィックス付きでログを出力します。

```
[UI] Initializing UI...
[UI] Sidebar initialized
[GRID] Filtered videos: 10 / 50
[API] Fetching feed data...
[RENDERER] Application initialized successfully ✅
```

---

## 🚀 新機能を追加する際のガイド

### 1. 新しいモジュールを作成

```javascript
// myfeature.js
import { log, logError } from './utils.js';
import { MODES } from './constants.js';
import { getDOM } from './dom.js';

const MODULE = 'MYFEATURE';

export function initializeFeature() {
  log(MODULE, 'Initializing feature...');
  // 実装
}
```

### 2. 定数を追加

`constants.js`にハードコードされた値を移動:

```javascript
// 定数の追加
export const MY_FEATURE_CONFIG = {
  TIMEOUT: 5000,
  MAX_ITEMS: 50,
  API_ENDPOINT: '/api/myfeature',
};
```

### 3. UIイベントを追加

`ui.js`のinitialize関数内で処理:

```javascript
export function initializeMyFeature() {
  const btn = getDOM('myBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      // イベント処理
      log(MODULE, 'Button clicked');
    });
  }
}
```

### 4. テンプレートに通知を追加

```javascript
// constants.jsのMESSAGES
MESSAGES: {
  INFO: {
    MY_FEATURE_LOADING: '機能を読み込み中...',
  },
  ERROR: {
    MY_FEATURE_FAILED: '機能の実行に失敗しました',
  },
}

// 使用
showToast(MESSAGES.INFO.MY_FEATURE_LOADING, 'info');
```

---

## 📊 ファイル構成

```
src/frontend/
├── constants.js          # 定数・設定値（232行）
├── utils.js             # 共通ユーティリティ（428行）
├── state.js             # グローバル状態管理
├── dom.js               # DOM操作・管理（450行）
├── ui.js                # UIイベント・初期化（350行）
├── grid.js              # グリッド表示ロジック（310行）
├── api.js               # バックエンド通信（375行）
├── player.js            # プレイヤー・弾幕機能
├── renderer.js          # メイン初期化・ライフサイクル
├── index.html           # HTMLテンプレート
├── style.css            # スタイルシート
└── README.md            # 使用方法ドキュメント
```

---

## 🔄 更新履歴

### 最新の改善（最適化フェーズ）

- ✅ `constants.js` 作成 - 全定数を一元管理
- ✅ `utils.js` 作成 - 共通ユーティリティを統合
- ✅ `dom.js` 最適化 - DOM操作を整理・拡張
- ✅ `ui.js` リファクター - 重複削除、constants活用
- ✅ `grid.js` 最適化 - ユーティリティ活用
- ✅ `api.js` 拡張 - openExternalUrl等追加
- ✅ `renderer.js` 改善 - ロギング・エラーハンドリング強化

---

## 📚 参考資料

- [JavaScript MDN](https://developer.mozilla.org/ja/docs/Web/JavaScript/)
- [Web Accessibility WCAG](https://www.w3.org/WAI/WCAG21/quickref/)
- [Clean Code Principles](https://wiki.c2.com/?CleanCode)

---

## ❓ FAQ

**Q: 新しいメッセージを追加したい**
A: `constants.js`の`MESSAGES`オブジェクトに追加してから使用してください

**Q: 新しいチャンネルを追加したい**
A: `constants.js`の`CHANNELS.MEMBERS`配列に追加してください

**Q: APIエンドポイントを変更したい**
A: `constants.js`の`API_CONFIG.ENDPOINTS`を編集してください

**Q: デバッグしたい**
A: ブラウザコンソールで`window.getAppState()`を実行してください

---

**最終更新**: 2024年
**ドキュメントバージョン**: 1.0
**互換性**: 全ブラウザ対応（ES6+）