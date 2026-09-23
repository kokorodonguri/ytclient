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
  updateFeedStatus,
} from "./dom.js";
import {
  fetchFeed,
  getErrorMessage,
  getYouTubeWatchUrl,
  initApiCredentials,
  openExternalUrl,
  testApiConnection,
} from "./api.js";
import { initializeUI, renderCurrentGrid } from "./ui.js";
import { readCachedFeed, writeCachedFeed } from "./feedCache.js";
import { playVideo } from "./player.js";
import { log, logError } from "./utils.js";
import { MESSAGES, TIMING } from "./constants.js";

const MODULE = "RENDERER";

// ========================================
// グローバル状態
// ========================================

let isInitialized = false;
let isFeedLoading = false;
let consecutiveFeedFailures = 0;
// 直前に描画したフィードの ETag。ポーリングは 5 秒ごとに走るが、
// 中身が変わるのは収集ワーカーの 1 周期ごと。同じ ETag なら
// 状態の入れ替えもグリッドの作り直しも丸ごと省く
let lastRenderedEtag = "";
// キャッシュから描画した直後かどうか。サーバーからの初回応答までは
// 「保存済みの一覧を見ている」ことを利用者に伝える必要がある。
let showingCachedFeed = false;
const MAX_FEED_BACKOFF_MS = 60000;

/**
 * 連続失敗回数に応じた再試行間隔を返す（最大60秒）
 * @returns {number} 遅延ミリ秒
 */
function nextBackoffDelay() {
  const factor = 2 ** Math.min(consecutiveFeedFailures, 5);
  return Math.min(TIMING.POLLING_INTERVAL * factor, MAX_FEED_BACKOFF_MS);
}

/**
 * 保存済みフィードがあれば、サーバーに問い合わせる前に描画する
 *
 * サーバー集約でバックエンドは単一障害点になった。ここで先に描くことで、
 * サーバーが落ちていても・機内モードでも、直前に見えていた一覧が出る。
 * @returns {boolean} キャッシュから描画したか
 */
function hydrateFromCache() {
  const cached = readCachedFeed();
  if (!cached) return false;

  state.setAppData({
    official: cached.official,
    clips: cached.clips,
    // サーバーからの応答を待っている状態なので、更新中として見せる
    is_building: true,
    last_updated: cached.last_updated,
    last_error: null,
  });
  showingCachedFeed = true;
  renderCurrentGrid();
  updateFeedStatus({
    status: "loading",
    label: "更新中",
    summary: "保存済みの一覧を表示しています",
  });
  log(MODULE, "Rendered the cached feed while waiting for the server");
  return true;
}

/**
 * オンライン・オフラインの遷移を購読する
 *
 * これまでは fetch の失敗からオフラインを推測するだけだったので、復帰しても
 * バックオフの待ち時間が明けるまで（最大 60 秒）画面が変わらなかった。
 * Electron・ブラウザ・Capacitor いずれも Chromium なので navigator.onLine が
 * そのまま使える。
 */
function setupConnectivityHandlers() {
  window.addEventListener("offline", () => {
    log(MODULE, "Went offline - pausing polling");
    state.clearPollingTimer();
    updateFeedStatus({
      status: "offline",
      label: "オフライン",
      summary: showingCachedFeed
        ? "ネットワークに接続していません（保存済みの一覧を表示しています）"
        : "ネットワークに接続していません",
    });
  });

  window.addEventListener("online", () => {
    log(MODULE, "Back online - refreshing immediately");
    // バックオフの待ち時間を待たずに取り直す
    consecutiveFeedFailures = 0;
    loadAndRenderFeed();
  });
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

    // 2.7 保存済みフィードがあれば先に描く。サーバーが落ちていても
    //     起動直後に一覧が出る（サーバー側の永続キャッシュと同じ役割）。
    hydrateFromCache();

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

    // 6. オンライン復帰を監視する
    setupConnectivityHandlers();

    // 7. フィードを読み込んでレンダリング
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

    // 内容が前回と同一なら、状態の差し替えも再描画も行わない。
    // 4000 件規模では 1 回の作り直しに 400ms 近くかかるため、
    // 変化していないフレームを描き直さないことが最も効く。
    const unchanged =
      Boolean(feedData.etag) && feedData.etag === lastRenderedEtag;

    if (unchanged) {
      log(MODULE, "Feed unchanged - skipping re-render");
      if (state.appData.is_building) {
        scheduleNextFeedRefresh(TIMING.POLLING_INTERVAL);
      }
      return;
    }

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

    lastRenderedEtag = feedData.etag || "";
    showingCachedFeed = false;

    // グリッドをレンダリング
    renderCurrentGrid();

    // 収集が完了した状態だけ保存する。is_building 中は不完全な一覧なので、
    // それを次回の起動時に見せると「メンバーが減った」ように見える。
    if (!feedData.is_building && (feedData.official.length || feedData.clips.length)) {
      writeCachedFeed(feedData);
    }

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
      summary: showingCachedFeed
        ? `${errorMsg}（保存済みの一覧を表示しています）`
        : errorMsg,
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
 * 次のフィード更新をスケジュール
 * @param {number} delayMs - 遅延時間（ミリ秒）
 */
function scheduleNextFeedRefresh(delayMs = TIMING.POLLING_INTERVAL) {
  // 既存のタイマーをクリア
  if (state.pollingTimer) {
    clearTimeout(state.pollingTimer);
  }

  // オフライン中は再試行を積まない。復帰は online イベントが拾う。
  if (navigator.onLine === false) {
    log(MODULE, "Offline - not scheduling a refresh");
    state.pollingTimer = null;
    return;
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

async function openMembersOnlyVideo(videoId) {
  const watchUrl = getYouTubeWatchUrl(videoId);
  try {
    await openExternalUrl(watchUrl);
  } catch (error) {
    logError(MODULE, "Error opening members-only video", error);
    window.open(watchUrl, "_blank", "noopener,noreferrer");
  }
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

    // メンバー限定は埋め込みも HLS 解決も通らないので、アプリ内で開かず
    // ログイン済みの YouTube に渡す
    if (card.dataset.membersOnly === "true") {
      openMembersOnlyVideo(videoId);
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
