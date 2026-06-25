/**
 * dom.js
 * DOM要素の操作と状態管理を一元化するモジュール
 * パフォーマンス最適化のためにDOM要素をキャッシュして再利用
 */

import { addClass, removeClass, toggleClass } from "./utils.js";
import { UI_CONSTANTS } from "./constants.js";

/**
 * DOM要素キャッシュ（シングルトン）
 */
let domCache = null;

/**
 * DOM要素キャッシュを初期化
 * @returns {Object} キャッシュ済みのDOM要素
 */
export function initDomCache() {
  if (domCache) {
    return domCache;
  }

  domCache = {
    // ===== Sidebar要素 =====
    sidebar: document.getElementById("sidebar"),
    sidebarOverlay: document.getElementById("sidebar-overlay"),
    sidebarChannelList: document.getElementById("sidebar-channel-list"),
    sidebarSelectedChannelText: document.getElementById(
      "sidebar-selected-channel",
    ),
    sidebarHomeBtn: document.getElementById("sidebar-home-btn"),

    // ===== ヘッダー要素 =====
    mainHeader: document.getElementById("main-header"),
    hamburgerBtn: document.getElementById("hamburger-btn"),
    appTitle: document.getElementById("app-title"),

    // ===== タブ要素 =====
    tabOfficial: document.getElementById("tab-official"),
    tabClips: document.getElementById("tab-clips"),

    // ===== コントロール要素 =====
    gameDropdown: document.getElementById("game-dropdown"),
    gameSelectedText: document.getElementById("game-selected-text"),
    gameOptions: document.getElementById("game-options"),
    freeWordInput: document.getElementById("free-word"),
    refreshBtn: document.getElementById("refresh-btn"),
    clearFiltersBtn: document.getElementById("clear-filters-btn"),
    settingsBtn: document.getElementById("settings-btn"),
    settingsModal: document.getElementById("settings-modal"),
    settingsForm: document.getElementById("settings-form"),
    settingsCloseBtn: document.getElementById("settings-close-btn"),
    settingsCancelBtn: document.getElementById("settings-cancel-btn"),
    backendUrlInput: document.getElementById("backend-url-input"),
    startLocalBackendCheck: document.getElementById(
      "start-local-backend-check",
    ),
    settingsCurrentBackend: document.getElementById(
      "settings-current-backend",
    ),
    settingsSaveBtn: document.getElementById("settings-save-btn"),

    // ===== メインコンテナ要素 =====
    mainContent: document.getElementById("main-content"),
    feedStatusPanel: document.getElementById("feed-status-panel"),
    connectionStatus: document.getElementById("connection-status"),
    feedSummary: document.getElementById("feed-summary"),
    activeFilters: document.getElementById("active-filters"),
    officialContainer: document.getElementById("official-container"),
    clipsContainer: document.getElementById("clips-container"),
    playerView: document.getElementById("player-view"),

    // ===== プレイヤー要素 =====
    playerContainer: document.getElementById("player-container"),
    playerVideoTitle: document.getElementById("player-video-title"),
    descriptionContainer: document.getElementById("description-container"),
    backBtn: document.getElementById("back-btn"),

    // ===== 通知要素 =====
    toastContainer: createToastContainer(),
  };

  return domCache;
}

/**
 * トースト通知コンテナを作成または取得
 * @returns {Element}
 */
function createToastContainer() {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }
  return container;
}

/**
 * キャッシュからDOM要素を取得
 * @param {string} key - 要素のキー
 * @returns {Element|null}
 */
export function getDOM(key) {
  if (!domCache) {
    console.error("[DOM] Cache not initialized. Call initDomCache() first.");
    return null;
  }
  return domCache[key] || null;
}

/**
 * ========================================
 * サイドバー操作
 * ======================================== */

/**
 * サイドバーの表示/非表示を切り替え
 * @param {boolean} [show] - 表示状態（省略時は自動判定）
 */
export function toggleSidebar(show) {
  const sidebar = getDOM("sidebar");
  const overlay = getDOM("sidebarOverlay");

  if (!sidebar || !overlay) return;

  if (show === undefined) {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("show");
  } else {
    toggleClass(sidebar, "open", show);
    toggleClass(overlay, "show", show);
  }
}

/**
 * サイドバーを閉じる
 */
export function closeSidebar() {
  toggleSidebar(false);
}

/**
 * サイドバーを開く
 */
export function openSidebar() {
  toggleSidebar(true);
}

/**
 * サイドバーの選択チャンネルテキストを更新
 * @param {string} text - チャンネル名またはラベル
 */
export function updateSidebarSelectedChannel(text) {
  const channelText = getDOM("sidebarSelectedChannelText");
  if (channelText) {
    channelText.textContent = text || "";
  }
}

/**
 * ========================================
 * タブ操作
 * ======================================== */

/**
 * タブの選択状態を更新
 * @param {string} mode - 'official' または 'clips'
 */
export function setTabActive(mode) {
  const officialTab = getDOM("tabOfficial");
  const clipsTab = getDOM("tabClips");

  if (!officialTab || !clipsTab) return;

  toggleClass(officialTab, "active", mode === "official");
  toggleClass(clipsTab, "active", mode === "clips");

  // aria-selected属性も更新
  officialTab.setAttribute(
    "aria-selected",
    mode === "official" ? "true" : "false",
  );
  clipsTab.setAttribute("aria-selected", mode === "clips" ? "true" : "false");
}

/**
 * ========================================
 * ドロップダウン操作
 * ======================================== */

/**
 * ゲームドロップダウンオプションの表示/非表示を切り替え
 * @param {boolean} [show] - 表示状態
 */
export function toggleGameOptions(show) {
  const gameOptions = getDOM("gameOptions");
  if (!gameOptions) return;

  if (show === undefined) {
    gameOptions.classList.toggle("show");
  } else {
    toggleClass(gameOptions, "show", show);
  }

  // aria-expanded属性を更新
  const gameSelectedText = getDOM("gameSelectedText");
  if (gameSelectedText) {
    gameSelectedText.setAttribute(
      "aria-expanded",
      gameOptions.classList.contains("show") ? "true" : "false",
    );
  }
}

/**
 * すべてのドロップダウンを閉じる
 */
export function closeAllDropdowns() {
  document.querySelectorAll(".dropdown-options").forEach((el) => {
    removeClass(el, "show");
  });

  // aria-expanded属性を更新
  document.querySelectorAll('[aria-haspopup="listbox"]').forEach((el) => {
    el.setAttribute("aria-expanded", "false");
  });
}

/**
 * ゲーム選択テキストを更新
 * @param {string} text - 選択されたゲーム名
 */
export function updateGameSelectedText(text) {
  const gameSelectedText = getDOM("gameSelectedText");
  if (gameSelectedText) {
    gameSelectedText.textContent = text || "";
  }
}

/**
 * フィード状態表示を更新
 * @param {Object} options
 * @param {'loading'|'online'|'offline'} options.status - 接続状態
 * @param {string} options.label - 状態ラベル
 * @param {string} options.summary - 件数や更新状態の要約
 */
export function updateFeedStatus({ status = "loading", label, summary }) {
  const connectionStatus = getDOM("connectionStatus");
  const feedSummary = getDOM("feedSummary");

  if (connectionStatus) {
    connectionStatus.className = `status-pill ${status}`;
    connectionStatus.textContent = label || "";
  }

  if (feedSummary) {
    feedSummary.textContent = summary || "";
  }
}

/**
 * ========================================
 * グリッドコンテナ操作
 * ======================================== */

/**
 * グリッドコンテナを取得
 * @param {string} mode - 'official' または 'clips'
 * @returns {Element|null}
 */
export function getGridContainer(mode) {
  return mode === "official"
    ? getDOM("officialContainer")
    : getDOM("clipsContainer");
}

/**
 * ========================================
 * プレイヤー操作
 * ======================================== */

/**
 * プレイヤーを表示
 */
export function showPlayer() {
  const playerView = getDOM("playerView");
  const officialContainer = getDOM("officialContainer");
  const clipsContainer = getDOM("clipsContainer");

  if (playerView) removeClass(playerView, "hidden");
  if (officialContainer) addClass(officialContainer, "hidden");
  if (clipsContainer) addClass(clipsContainer, "hidden");
}

/**
 * プレイヤーを非表示
 * @param {string} mode - 'official' または 'clips'
 */
export function hidePlayer(mode) {
  const playerView = getDOM("playerView");
  const officialContainer = getDOM("officialContainer");
  const clipsContainer = getDOM("clipsContainer");
  const descriptionContainer = getDOM("descriptionContainer");

  if (playerView) addClass(playerView, "hidden");
  if (descriptionContainer) addClass(descriptionContainer, "hidden");

  if (mode === "official" && officialContainer) {
    removeClass(officialContainer, "hidden");
  } else if (mode === "clips" && clipsContainer) {
    removeClass(clipsContainer, "hidden");
  }

  clearPlayerContainer();
}

/**
 * プレイヤービデオタイトルを更新
 * @param {string} title - ビデオタイトル
 */
export function updatePlayerVideoTitle(title) {
  const playerTitle = getDOM("playerVideoTitle");
  if (playerTitle) {
    playerTitle.textContent = title || "";
  }
}

/**
 * プレイヤーコンテナにHTMLを設定
 * @param {string} html - 設定するHTML
 */
export function setPlayerHTML(html) {
  const playerContainer = getDOM("playerContainer");
  if (playerContainer) {
    playerContainer.innerHTML = html;
  }
}

/**
 * プレイヤーコンテナをクリア
 */
function clearPlayerContainer() {
  const playerContainer = getDOM("playerContainer");
  if (playerContainer) {
    playerContainer.innerHTML = "";
  }
}

/**
 * ========================================
 * 説明欄操作
 * ======================================== */

/**
 * 説明欄コンテナを表示
 */
export function showDescriptionContainer() {
  const descContainer = getDOM("descriptionContainer");
  if (descContainer) removeClass(descContainer, "hidden");
}

/**
 * 説明欄コンテナを非表示
 */
export function hideDescriptionContainer() {
  const descContainer = getDOM("descriptionContainer");
  if (descContainer) addClass(descContainer, "hidden");
}

/**
 * ========================================
 * トースト通知
 * ======================================== */

/**
 * トースト通知を表示
 * @param {string} message - 通知メッセージ
 * @param {string} type - 'success', 'error', 'warning', 'info'
 * @param {number} duration - 表示時間（ミリ秒）
 */
export function showToast(
  message,
  type = "info",
  duration = UI_CONSTANTS.TOAST_DURATION,
) {
  const container = getDOM("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", "alert");
  toast.textContent = message || "";

  container.appendChild(toast);

  // 指定時間後に削除
  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => {
      try {
        toast.remove();
      } catch (e) {
        console.error("Error removing toast:", e);
      }
    }, 300);
  }, duration);
}

/**
 * エラートースト
 * @param {string} message - メッセージ
 */
export function showErrorToast(message) {
  showToast(message, "error");
}

export default {
  initDomCache,
  getDOM,
  toggleSidebar,
  closeSidebar,
  openSidebar,
  updateSidebarSelectedChannel,
  setTabActive,
  toggleGameOptions,
  closeAllDropdowns,
  updateGameSelectedText,
  updateFeedStatus,
  getGridContainer,
  showPlayer,
  hidePlayer,
  updatePlayerVideoTitle,
  setPlayerHTML,
  showDescriptionContainer,
  hideDescriptionContainer,
  showToast,
  showErrorToast,
};
