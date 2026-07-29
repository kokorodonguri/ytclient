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
  isSidebarOpen,
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
import {
  log,
  logError,
  escapeHTML,
  debounce,
  saveToLocalStorage,
} from "./utils.js";
import {
  CHANNELS,
  API_CONFIG,
  API_BASE_URL_STORAGE_KEY,
  API_KEY_STORAGE_KEY,
  setRuntimeApiConfig,
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
      item.innerHTML = `<span class="icon" aria-hidden="true">📌</span><span>${escapeHTML(channel.name)}</span>`;
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

  const items = Array.from(gameOptions.querySelectorAll(".dropdown-item"));
  let activeIndex = 0;

  const setActive = (index) => {
    activeIndex = (index + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("focused", i === activeIndex));
    gameSelectedText.setAttribute(
      "aria-activedescendant",
      items[activeIndex]?.id || "",
    );
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  };

  const isOpen = () => gameOptions.classList.contains("show");

  const openList = () => {
    if (!isOpen()) toggleGameOptions(true);
    const selected = items.findIndex(
      (el) => el.getAttribute("aria-selected") === "true",
    );
    setActive(selected >= 0 ? selected : 0);
  };

  const closeList = () => {
    toggleGameOptions(false);
    gameSelectedText.removeAttribute("aria-activedescendant");
    items.forEach((el) => el.classList.remove("focused"));
  };

  const commit = (item) => {
    const gameValue = item.getAttribute("data-value") || "";
    items.forEach((el) => el.setAttribute("aria-selected", String(el === item)));
    state.setSelectedGame(gameValue);
    updateGameSelectedText(item.textContent);
    closeList();
    gameSelectedText.focus();
    renderCurrentGrid();
  };

  // ドロップダウン開閉
  gameSelectedText.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen()) {
      closeList();
    } else {
      openList();
    }
  });

  // キーボード操作 (WAI-ARIA listboxパターン)
  gameSelectedText.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (!isOpen()) {
          openList();
        } else {
          setActive(activeIndex + (e.key === "ArrowDown" ? 1 : -1));
        }
        break;
      case "Home":
        if (!isOpen()) return;
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        if (!isOpen()) return;
        e.preventDefault();
        setActive(items.length - 1);
        break;
      case "Enter":
      case " ":
        if (isOpen()) {
          e.preventDefault();
          if (items[activeIndex]) commit(items[activeIndex]);
        }
        break;
      case "Escape":
        if (isOpen()) {
          e.preventDefault();
          closeList();
        }
        break;
      case "Tab":
        if (isOpen()) closeList();
        break;
    }
  });

  // ゲーム選択（マウス）
  items.forEach((item, index) => {
    item.addEventListener("click", () => commit(item));
    item.addEventListener("mousemove", () => setActive(index));
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

  // 矢印キーでのタブ移動 (WAI-ARIA tabsパターン)
  const tablist = tabOfficial?.closest('[role="tablist"]');
  if (tablist && tabOfficial && tabClips) {
    tablist.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const tabs = [tabOfficial, tabClips];
      const current = tabs.indexOf(document.activeElement);
      if (current < 0) return;
      e.preventDefault();
      let next;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else next = (current + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
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

  // Escapeでサイドバーを閉じる（オーバーレイクリックのキーボード代替）
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isSidebarOpen()) {
      closeSidebar();
    }
  });

  // 更新ボタン
  if (refreshBtn) {
    const labelEl = refreshBtn.querySelector("span:not(.icon)");
    refreshBtn.addEventListener("click", async () => {
      if (labelEl) labelEl.textContent = BUTTON_LABELS.LOADING;
      refreshBtn.setAttribute("aria-busy", "true");
      refreshBtn.disabled = true;

      try {
        await window.triggerFeedRefresh?.();
      } catch (error) {
        logError(MODULE, "Refresh error", error);
        showToast(MESSAGES.ERROR.NETWORK, "error");
      } finally {
        if (labelEl) labelEl.textContent = BUTTON_LABELS.REFRESH;
        refreshBtn.removeAttribute("aria-busy");
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

let lastFocusedBeforeModal = null;

function trapModalKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSettingsModal();
    return;
  }
  if (e.key !== "Tab") return;

  const modal = getDOM("settingsModal");
  if (!modal) return;
  const focusables = Array.from(
    modal.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null);
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function setBackgroundInert(inert) {
  ["main-content", "main-header", "sidebar"].forEach((id) => {
    const el = document.getElementById(id);
    // サイドバーは閉じている間は常にinertを維持する
    if (!el || (id === "sidebar" && !inert && !isSidebarOpen())) return;
    el.inert = inert;
  });
}

async function openSettingsModal() {
  const modal = getDOM("settingsModal");
  const input = getDOM("backendUrlInput");
  const keyInput = getDOM("apiKeyInput");
  const check = getDOM("startLocalBackendCheck");
  const current = getDOM("settingsCurrentBackend");

  if (!modal || !input || !check) return;

  let backendUrl = API_CONFIG.BASE_URL;
  let apiKey = API_CONFIG.API_KEY;
  let startLocalBackend = false;

  try {
    const result = await window.api?.getBackendConfig?.();
    if (result?.ok && result.config) {
      backendUrl = result.config.backendUrl || backendUrl;
      apiKey = result.config.apiKey || apiKey;
      startLocalBackend = Boolean(result.config.startLocalBackend);
    }
  } catch (error) {
    logError(MODULE, "Failed to load backend config", error);
  }

  input.value = backendUrl;
  if (keyInput) keyInput.value = apiKey;
  check.checked = startLocalBackend;
  if (current) {
    current.textContent = `現在の接続先: ${backendUrl}`;
  }

  lastFocusedBeforeModal = document.activeElement;
  modal.classList.remove("hidden");
  setBackgroundInert(true);
  modal.addEventListener("keydown", trapModalKeydown);
  input.focus();
  input.select();
}

function closeSettingsModal() {
  const modal = getDOM("settingsModal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.removeEventListener("keydown", trapModalKeydown);
  modal.classList.add("hidden");
  setBackgroundInert(false);
  if (lastFocusedBeforeModal?.isConnected) {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

function normalizeBackendInput(rawValue) {
  const value = (rawValue || "").trim();
  if (!value) return "";
  return value.includes("://") ? value : `http://${value}`;
}

async function saveSettings() {
  const input = getDOM("backendUrlInput");
  const keyInput = getDOM("apiKeyInput");
  const check = getDOM("startLocalBackendCheck");
  const saveBtn = getDOM("settingsSaveBtn");

  if (!input || !check) return;

  const backendUrl = normalizeBackendInput(input.value);
  if (!backendUrl) {
    showToast("バックエンドサーバーを入力してください", "error");
    return;
  }

  const apiKey = (keyInput?.value || "").trim();

  if (saveBtn) saveBtn.disabled = true;
  try {
    if (window.api?.setBackendConfig) {
      const result = await window.api.setBackendConfig({
        backendUrl,
        apiKey,
        startLocalBackend: check.checked,
      });
      if (!result?.ok) {
        throw new Error(result?.error || "保存に失敗しました");
      }
    } else {
      // Electron 以外（APK / ブラウザ）は端末側に保持する
      saveToLocalStorage(API_KEY_STORAGE_KEY, apiKey);
      saveToLocalStorage(API_BASE_URL_STORAGE_KEY, backendUrl);
    }

    setRuntimeApiConfig({ baseUrl: backendUrl, apiKey });
    showToast("設定を保存しました", "success");
    closeSettingsModal();
    await window.triggerFeedRefresh?.();
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

  const isHome = value === CHANNELS.ALL.value;
  sidebarHomeBtn?.classList.toggle("active", isHome);
  if (sidebarHomeBtn) {
    if (isHome) sidebarHomeBtn.setAttribute("aria-current", "page");
    else sidebarHomeBtn.removeAttribute("aria-current");
  }

  sidebarChannelList?.querySelectorAll("[data-channel-name]").forEach((item) => {
    const active = item.dataset.channelName === value;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
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
  const lastVideoId = state.currentPlayerVideos?.[0]?.videoId || "";
  hidePlayer(state.currentMode);
  state.setCurrentPlayerVideos([]);

  // 再生前に選択していたカードへフォーカスを戻す
  restoreFocusToCard(lastVideoId);
}

/**
 * 一覧に戻ったとき、元のビデオカードへフォーカスを戻す
 * @param {string} videoId
 */
export function restoreFocusToCard(videoId) {
  // 有効なフォーカスが別の場所にあるとき（例: タブ切替時）は奪わない
  const active = document.activeElement;
  const playerView = getDOM("playerView");
  if (
    active &&
    active !== document.body &&
    !(playerView && playerView.contains(active))
  ) {
    return;
  }

  let target = null;
  if (videoId && typeof CSS !== "undefined" && CSS.escape) {
    target = document.querySelector(
      `.video-card[data-video-id="${CSS.escape(videoId)}"]`,
    );
  }
  (target || getDOM("mainContent"))?.focus();
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
