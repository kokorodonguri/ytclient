/**
 * renderer.js
 * メイン初期化スクリプト - アプリケーション全体の統合
 * 各モジュールを統合し、ライフサイクルを管理
 */

import state from "./state.js";
import {
  initDomCache,
  getDOM,
  showErrorToast,
  showToast,
  updateFeedStatus,
} from "./dom.js";
import {
  fetchFeed,
  getErrorMessage,
  initApiCredentials,
  testApiConnection,
} from "./api.js";
import {
  initializeUI,
  setSelectedChannel,
  setMode,
  closePlayer,
} from "./ui.js";
import { renderGrid } from "./grid.js";
import { playVideo } from "./player.js";
import { log, logError } from "./utils.js";
import { MODES, MESSAGES, TIMING } from "./constants.js";

const MODULE = "RENDERER";

// ========================================
// グローバル状態
// ========================================

let isInitialized = false;
let isFeedLoading = false;
let consecutiveFeedFailures = 0;
const MAX_FEED_BACKOFF_MS = 60000;

/**
 * 連続失敗回数に応じた再試行間隔を返す（最大60秒）
 * @returns {number} 遅延ミリ秒
 */
function nextBackoffDelay() {
  const factor = 2 ** Math.min(consecutiveFeedFailures, 5);
  return Math.min(TIMING.POLLING_INTERVAL * factor, MAX_FEED_BACKOFF_MS);
}

// ========================================
// アプリケーション初期化
// ========================================

/**
 * アプリケーションを初期化
 * @returns {Promise<boolean>} 初期化成功フラグ
 */
async function initializeApp() {
  if (isInitialized) {
    console.warn(`[${MODULE}] Already initialized`);
    return true;
  }

  try {
    log(MODULE, "Starting application initialization...");

    // 1. DOM要素をキャッシュ
    log(MODULE, "Initializing DOM cache...");
    const domCache = initDomCache();
    if (!domCache.officialContainer || !domCache.playerView) {
      throw new Error("Critical DOM elements not found");
    }

    // 2. UIイベントハンドラーを初期化
    log(MODULE, "Initializing UI handlers...");
    const uiInitSuccess = initializeUI();
    if (!uiInitSuccess) {
      throw new Error("UI initialization failed");
    }

    // 2.5 保存済みの接続先とAPIキーを読み込む（最初のリクエストより前に行う）
    log(MODULE, "Loading API credentials...");
    await initApiCredentials();

    // 3. API接続を確認
    log(MODULE, "Testing API connection...");
    const isConnected = await testApiConnection();
    if (!isConnected) {
      logError(MODULE, "API connection failed", null);
      updateFeedStatus({
        status: "offline",
        label: "オフライン",
        summary: "サーバーに接続できません。再接続を待機しています。",
      });
      showErrorToast(
        "サーバーに接続できません。サーバーが起動していることを確認してください。",
      );
      // エラーでも続行（オフライン使用を想定）
    }

    // 4. グリッドクリックハンドラーを設定
    log(MODULE, "Setting up grid click handlers...");
    setupGridClickHandlers();

    // 5. グローバルコマンドを設定
    window.triggerFeedRefresh = async () => {
      log(MODULE, "Manual feed refresh triggered");
      await loadAndRenderFeed();
    };

    // 6. フィードを読み込んでレンダリング
    log(MODULE, "Loading initial feed...");
    await loadAndRenderFeed();

    isInitialized = true;
    log(MODULE, "✅ Application initialized successfully");
    return true;
  } catch (error) {
    logError(MODULE, "Initialization failed", error);
    showErrorToast(MESSAGES.ERROR.INITIALIZATION_FAILED);
    return false;
  }
}

/**
 * ========================================
 * フィード管理
 * ======================================== */

/**
 * フィードを読み込んでレンダリング
 * @returns {Promise<void>}
 */
async function loadAndRenderFeed() {
  if (isFeedLoading) {
    log(MODULE, "Feed loading already in progress");
    return;
  }

  isFeedLoading = true;

  try {
    log(MODULE, "Fetching feed from server...");
    const feedData = await fetchFeed();
    consecutiveFeedFailures = 0;

    // 状態を更新
    state.setAppData({
      official: feedData.official || [],
      clips: feedData.clips || [],
      is_building: feedData.is_building || false,
      last_updated: feedData.last_updated || null,
      last_error: feedData.last_error || null,
    });

    log(MODULE, "Feed loaded", {
      official: state.appData.official.length,
      clips: state.appData.clips.length,
      is_building: state.appData.is_building,
    });

    // グリッドをレンダリング
    renderGridWithState();

    // 構築中の場合、ポーリングを開始
    if (state.appData.is_building) {
      log(MODULE, "Server is building - starting polling");
      scheduleNextFeedRefresh(TIMING.POLLING_INTERVAL);
    } else if (state.pollingTimer) {
      // 構築完了したらポーリング停止
      clearTimeout(state.pollingTimer);
      state.pollingTimer = null;
      log(MODULE, "Server build completed - stopped polling");
    }
  } catch (error) {
    logError(MODULE, "Feed load error", error);
    consecutiveFeedFailures += 1;
    const errorMsg = getErrorMessage(error);
    updateFeedStatus({
      status: "offline",
      label: "オフライン",
      summary: errorMsg,
    });
    // 失敗が続く間はトーストを出し続けない（初回のみ通知）
    if (consecutiveFeedFailures === 1) {
      showErrorToast(errorMsg);
    }

    // エラー時は指数バックオフで再試行を継続
    scheduleNextFeedRefresh(nextBackoffDelay());
  } finally {
    isFeedLoading = false;
  }
}

/**
 * グリッドを再レンダリング（状態を使用）
 */
function renderGridWithState() {
  try {
    const container =
      state.currentMode === MODES.OFFICIAL
        ? getDOM("officialContainer")
        : getDOM("clipsContainer");

    if (!container) {
      throw new Error("Grid container not found");
    }

    // グリッドレンダリング
    renderGrid(state, {
      getGridContainer: (mode) =>
        mode === MODES.OFFICIAL
          ? getDOM("officialContainer")
          : getDOM("clipsContainer"),
      getDOM,
    });

    log(MODULE, "Grid rendered successfully");
  } catch (error) {
    logError(MODULE, "Grid render error", error);
    showErrorToast(MESSAGES.ERROR.FAILED_RENDER);
  }
}

/**
 * 次のフィード更新をスケジュール
 * @param {number} delayMs - 遅延時間（ミリ秒）
 */
function scheduleNextFeedRefresh(delayMs = TIMING.POLLING_INTERVAL) {
  // 既存のタイマーをクリア
  if (state.pollingTimer) {
    clearTimeout(state.pollingTimer);
  }

  log(MODULE, `Scheduling next feed refresh in ${delayMs}ms`);

  state.pollingTimer = setTimeout(() => {
    loadAndRenderFeed();
  }, delayMs);
}

/**
 * ========================================
 * イベントハンドラー
 * ======================================== */

/**
 * グリッドクリックハンドラーを設定
 */
function setupGridClickHandlers() {
  const officialContainer = getDOM("officialContainer");
  const clipsContainer = getDOM("clipsContainer");

  if (officialContainer) {
    officialContainer.addEventListener("click", handleVideoCardClick);
  }

  if (clipsContainer) {
    clipsContainer.addEventListener("click", handleVideoCardClick);
  }

  log(MODULE, "Grid click handlers registered");
}

/**
 * ビデオカードクリック時の処理
 * @param {Event} event - クリックイベント
 */
function handleVideoCardClick(event) {
  const card = event.target.closest(".video-card");
  if (!card) return;

  try {
    const videoId = card.dataset.videoId;
    const title = card.dataset.title;
    const isLive = card.dataset.isLive === "true";

    if (!videoId || !title) {
      console.error("[CARD_CLICK] Missing video data");
      return;
    }

    log(MODULE, "Playing video", { videoId, title, isLive });
    playVideo(videoId, title, isLive);
  } catch (error) {
    logError(MODULE, "Error handling video card click", error);
    showErrorToast(MESSAGES.ERROR.FAILED_PLAYBACK);
  }
}

/**
 * ========================================
 * クリーンアップ・ライフサイクル
 * ======================================== */

/**
 * クリーンアップ処理を実行
 */
function cleanup() {
  log(MODULE, "Cleaning up...");

  // ポーリングタイマーをクリア
  if (state.pollingTimer) {
    clearTimeout(state.pollingTimer);
    state.pollingTimer = null;
  }

  // WebSocketをクローズ
  if (state.activeChatSocket) {
    try {
      state.activeChatSocket.close();
      state.activeChatSocket = null;
    } catch (e) {
      logError(MODULE, "Error closing WebSocket", e);
    }
  }

  // グローバルコマンドをクリア
  window.triggerFeedRefresh = null;

  log(MODULE, "Cleanup completed");
}

/**
 * ========================================
 * イベントリスナー
 * ======================================== */

// ウィンドウが閉じる時のクリーンアップ
window.addEventListener("beforeunload", cleanup);

// DOMContentLoaded時にアプリケーションを初期化
document.addEventListener("DOMContentLoaded", () => {
  log(MODULE, "DOM Content Loaded - starting initialization");
  initializeApp().catch((error) => {
    logError(MODULE, "Fatal initialization error", error);
  });
});

// 予期しないエラーハンドリング
window.addEventListener("error", (event) => {
  logError(MODULE, "Uncaught error", event.error);
});

// 未処理の Promise rejection
window.addEventListener("unhandledrejection", (event) => {
  logError(MODULE, "Unhandled rejection", event.reason);
});

// 可視性が変わったときの処理
document.addEventListener("visibilitychange", () => {
  if (!isInitialized) return;

  if (document.hidden) {
    // 非表示中はポーリングを止め、無駄なリクエストと再描画を避ける
    log(MODULE, "Document hidden - pausing polling");
    state.clearPollingTimer();
    return;
  }

  log(MODULE, "Document visible - refreshing feed");
  loadAndRenderFeed();
});

// エクスポート（テスト用）
export { initializeApp, loadAndRenderFeed, cleanup };
