/**
 * ui.js
 * UI初期化とイベントハンドリングを管理するモジュール
 * サイドバー、ドロップダウン、タブなどのインタラクションを集約
 */

import state from "./state.js";
import {
  initDomCache,
  getDOM,
  closeSidebar,
  toggleSidebar,
  setTabActive,
  toggleGameOptions,
  closeAllDropdowns,
  updateGameSelectedText,
  updateSidebarSelectedChannel,
  hidePlayer,
  showToast,
} from "./dom.js";
import { renderGrid } from "./grid.js";
import { log, logError, escapeHTML, debounce } from "./utils.js";
import {
  CHANNELS,
  API_CONFIG,
  GAME_FILTERS,
  VIDEO_MODES,
  TIMING,
  MESSAGES,
  BUTTON_LABELS,
} from "./constants.js";

const MODULE = "UI";

/**
 * ========================================
 * サイドバー初期化
 * ======================================== */

export function initializeSidebar() {
  log(MODULE, "Initializing sidebar...");

  const hamburgerBtn = getDOM("hamburgerBtn");
  const sidebar = getDOM("sidebar");
  const sidebarOverlay = getDOM("sidebarOverlay");
  const sidebarHomeBtn = getDOM("sidebarHomeBtn");
  const sidebarChannelList = getDOM("sidebarChannelList");

  // ハンバーガーメニュー
  if (hamburgerBtn && sidebar && sidebarOverlay) {
    hamburgerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSidebar();
    });

    sidebarOverlay.addEventListener("click", () => {
      closeSidebar();
    });
  }

  // ホームボタン
  if (sidebarHomeBtn) {
    sidebarHomeBtn.addEventListener("click", () => {
      setSelectedChannel(CHANNELS.ALL.value);
      closeSidebar();
      renderCurrentGrid();
    });
  }

  // チャンネルリスト
  if (sidebarChannelList) {
    sidebarChannelList.innerHTML = "";
    CHANNELS.MEMBERS.forEach((channel) => {
      const item = document.createElement("button");
      item.className = "menu-item";
      item.setAttribute("type", "button");
      item.dataset.channelName = channel.name;
      item.innerHTML = `<span class="icon">📌</span><span>${escapeHTML(channel.name)}</span>`;
      item.addEventListener("click", () => {
        setSelectedChannel(channel.name);
        closeSidebar();
        renderCurrentGrid();
      });
      sidebarChannelList.appendChild(item);
    });
  }

  log(MODULE, "Sidebar initialized");
}

/**
 * ========================================
 * ゲームドロップダウン初期化
 * ======================================== */

export function initializeGameDropdown() {
  log(MODULE, "Initializing game dropdown...");

  const gameSelectedText = getDOM("gameSelectedText");
  const gameOptions = getDOM("gameOptions");

  if (!gameSelectedText || !gameOptions) return;

  // ドロップダウン開閉
  gameSelectedText.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGameOptions();
  });

  // ゲーム選択
  gameOptions.querySelectorAll(".dropdown-item").forEach((item) => {
    item.addEventListener("click", () => {
      const gameValue = item.getAttribute("data-value") || "";
      state.setSelectedGame(gameValue);
      updateGameSelectedText(item.textContent);
      toggleGameOptions(false);
      renderCurrentGrid();
    });
  });

  log(MODULE, "Game dropdown initialized");
}

/**
 * ========================================
 * タブボタン初期化
 * ======================================== */

export function initializeTabButtons() {
  log(MODULE, "Initializing tab buttons...");

  const tabOfficial = getDOM("tabOfficial");
  const tabClips = getDOM("tabClips");

  if (tabOfficial) {
    tabOfficial.addEventListener("click", () => {
      setMode(VIDEO_MODES.OFFICIAL);
    });
  }

  if (tabClips) {
    tabClips.addEventListener("click", () => {
      setMode(VIDEO_MODES.CLIPS);
    });
  }

  log(MODULE, "Tab buttons initialized");
}

/**
 * ========================================
 * グローバルハンドラー初期化
 * ======================================== */

export function initializeGlobalHandlers() {
  log(MODULE, "Initializing global handlers...");

  const refreshBtn = getDOM("refreshBtn");
  const freeWordInput = getDOM("freeWordInput");
  const clearFiltersBtn = getDOM("clearFiltersBtn");
  const settingsBtn = getDOM("settingsBtn");

  // 外部クリックでドロップダウンを閉じる
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#game-dropdown")) {
      closeAllDropdowns();
    }
  });

  // 更新ボタン
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const originalText = refreshBtn.textContent;
      refreshBtn.textContent = BUTTON_LABELS.LOADING;
      refreshBtn.disabled = true;

      try {
        await window.triggerFeedRefresh?.();
      } catch (error) {
        logError(MODULE, "Refresh error", error);
        showToast(MESSAGES.ERROR.NETWORK, "error");
      } finally {
        refreshBtn.textContent = originalText;
        refreshBtn.disabled = false;
      }
    });
  }

  // 自由ワード検索（デバウンス処理）
  if (freeWordInput) {
    const debouncedSearch = debounce(() => {
      renderCurrentGrid();
    }, TIMING.DEBOUNCE_SEARCH);

    freeWordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        debouncedSearch();
      }
    });

    freeWordInput.addEventListener("input", debouncedSearch);
  }

  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener("click", () => {
      setSelectedChannel(CHANNELS.ALL.value);
      state.setSelectedGame("");
      updateGameSelectedText(GAME_FILTERS[0]?.label || "すべてのゲーム");
      if (freeWordInput) {
        freeWordInput.value = "";
      }
      closeAllDropdowns();
      renderCurrentGrid();
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      openSettingsModal();
    });
  }

  log(MODULE, "Global handlers initialized");
}

export function initializeSettingsDialog() {
  const modal = getDOM("settingsModal");
  const form = getDOM("settingsForm");
  const closeBtn = getDOM("settingsCloseBtn");
  const cancelBtn = getDOM("settingsCancelBtn");

  if (!modal || !form) return;

  closeBtn?.addEventListener("click", closeSettingsModal);
  cancelBtn?.addEventListener("click", closeSettingsModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeSettingsModal();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveSettings();
  });
}

async function openSettingsModal() {
  const modal = getDOM("settingsModal");
  const input = getDOM("backendUrlInput");
  const check = getDOM("startLocalBackendCheck");
  const current = getDOM("settingsCurrentBackend");

  if (!modal || !input || !check) return;

  let backendUrl = API_CONFIG.BASE_URL;
  let startLocalBackend = false;

  try {
    const result = await window.api?.getBackendConfig?.();
    if (result?.ok && result.config) {
      backendUrl = result.config.backendUrl || backendUrl;
      startLocalBackend = Boolean(result.config.startLocalBackend);
    }
  } catch (error) {
    logError(MODULE, "Failed to load backend config", error);
  }

  input.value = backendUrl;
  check.checked = startLocalBackend;
  if (current) {
    current.textContent = `現在の接続先: ${backendUrl}`;
  }

  modal.classList.remove("hidden");
  input.focus();
  input.select();
}

function closeSettingsModal() {
  getDOM("settingsModal")?.classList.add("hidden");
}

function normalizeBackendInput(rawValue) {
  const value = (rawValue || "").trim();
  if (!value) return "";
  return value.includes("://") ? value : `http://${value}`;
}

async function saveSettings() {
  const input = getDOM("backendUrlInput");
  const check = getDOM("startLocalBackendCheck");
  const saveBtn = getDOM("settingsSaveBtn");

  if (!input || !check) return;

  const backendUrl = normalizeBackendInput(input.value);
  if (!backendUrl) {
    showToast("バックエンドサーバーを入力してください", "error");
    return;
  }

  if (!window.api?.setBackendConfig) {
    showToast("この環境では設定を保存できません", "error");
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  try {
    const result = await window.api.setBackendConfig({
      backendUrl,
      startLocalBackend: check.checked,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "保存に失敗しました");
    }
    showToast("設定を保存しました", "success");
    closeSettingsModal();
  } catch (error) {
    logError(MODULE, "Failed to save backend config", error);
    showToast("設定の保存に失敗しました", "error");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * ========================================
 * バックボタン初期化
 * ======================================== */

export function initializeBackButton() {
  log(MODULE, "Initializing back button...");

  const backBtn = getDOM("backBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      closePlayer();
    });
  }

  log(MODULE, "Back button initialized");
}

/**
 * ========================================
 * 状態管理関数
 * ======================================== */

/**
 * 選択されたチャンネルを設定
 * @param {string} value - チャンネル値
 */
export function setSelectedChannel(value) {
  state.setSelectedChannel(value);
  const label = value === CHANNELS.ALL.value ? CHANNELS.ALL.label : value;
  updateSidebarSelectedChannel(label);
  syncSidebarActiveChannel(value);
  log(MODULE, `Channel selected: ${label}`);
}

/**
 * モード（オフィシャル/クリップス）を切り替え
 * @param {string} mode - 'official' または 'clips'
 */
export function setMode(mode) {
  if (state.currentMode === mode) return;

  log(MODULE, `Mode changed: ${mode}`);
  state.setMode(mode);
  setTabActive(mode);

  // プレイヤーが表示されている場合は閉じる
  const playerView = getDOM("playerView");
  if (playerView && !playerView.classList.contains("hidden")) {
    closePlayer();
  }

  // コンテナの表示切り替え
  const officialContainer = getDOM("officialContainer");
  const clipsContainer = getDOM("clipsContainer");

  if (mode === VIDEO_MODES.OFFICIAL) {
    officialContainer?.classList.remove("hidden");
    clipsContainer?.classList.add("hidden");
  } else {
    officialContainer?.classList.add("hidden");
    clipsContainer?.classList.remove("hidden");
  }

  renderCurrentGrid();
}

/**
 * グリッドコンテナを取得するラッパー関数
 * @param {string} mode - 'official' または 'clips'
 * @returns {Element|null}
 */
function getGridContainerWrapper(mode) {
  return mode === VIDEO_MODES.OFFICIAL
    ? getDOM("officialContainer")
    : getDOM("clipsContainer");
}

function renderCurrentGrid() {
  renderGrid(state, { getGridContainer: getGridContainerWrapper, getDOM });
}

function syncSidebarActiveChannel(value) {
  const sidebarHomeBtn = getDOM("sidebarHomeBtn");
  const sidebarChannelList = getDOM("sidebarChannelList");

  sidebarHomeBtn?.classList.toggle("active", value === CHANNELS.ALL.value);

  sidebarChannelList?.querySelectorAll("[data-channel-name]").forEach((item) => {
    item.classList.toggle("active", item.dataset.channelName === value);
  });
}

/**
 * ========================================
 * プレイヤー操作
 * ======================================== */

/**
 * プレイヤーを閉じる
 */
export function closePlayer() {
  log(MODULE, "Closing player...");

  // WebSocketをクローズ
  if (state.activeChatSocket) {
    try {
      state.activeChatSocket.close();
    } catch (e) {
      logError(MODULE, "Error closing WebSocket", e);
    }
    state.activeChatSocket = null;
  }

  // UIを更新
  hidePlayer(state.currentMode);
  state.setCurrentPlayerVideos([]);
}

/**
 * ========================================
 * UI全体初期化
 * ======================================== */

/**
 * UI全体を初期化
 * @returns {boolean} 初期化成功フラグ
 */
export function initializeUI() {
  try {
    log(MODULE, "Initializing UI...");

    initDomCache();

    initializeSidebar();
    initializeGameDropdown();
    initializeTabButtons();
    initializeGlobalHandlers();
    initializeSettingsDialog();
    initializeBackButton();

    // 初期状態を設定
    setSelectedChannel(CHANNELS.ALL.value);
    setMode(VIDEO_MODES.OFFICIAL);

    log(MODULE, "UI initialized successfully");
    return true;
  } catch (error) {
    logError(MODULE, "UI initialization error", error);
    showToast(MESSAGES.ERROR.INITIALIZATION_FAILED, "error");
    return false;
  }
}

/**
 * ========================================
 * ユーティリティ関数
 * ======================================== */

/**
 * チャンネル情報を取得
 * @returns {Array} チャンネル配列
 */
export function getTargetChannels() {
  return CHANNELS.MEMBERS;
}

/**
 * ゲームフィルターオプションを取得
 * @returns {Array} ゲームオプション配列
 */
export function getGameFilterOptions() {
  return GAME_FILTERS;
}

export default {
  initializeUI,
  initializeSidebar,
  initializeGameDropdown,
  initializeTabButtons,
  initializeGlobalHandlers,
  initializeSettingsDialog,
  initializeBackButton,
  setSelectedChannel,
  setMode,
  closePlayer,
  getTargetChannels,
  getGameFilterOptions,
};
