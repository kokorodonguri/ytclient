/**
 * grid.js
 * ビデオグリッド表示ロジック
 * フィルタリング、ソート、HTML生成を担当
 */

import {
  escapeHTML,
  escapeAttribute,
  formatRelativeTime,
  log,
  logError,
} from "./utils.js";
import { MESSAGES } from "./constants.js";

const MODULE = "GRID";

/**
 * ========================================
 * HTML生成
 * ======================================== */

/**
 * 単一のビデオカードHTMLを生成
 * @param {Object} item - ビデオアイテム
 * @returns {string} HTML
 */
export function buildVideoCardHTML(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  try {
    // バッジHTMLを生成
    let badgesHTML = "";
    let typeBadgeHTML = "";

    if (item.is_live) {
      badgesHTML += '<span class="badge live-badge">🔴 LIVE</span>';
      typeBadgeHTML = '<span class="badge type-badge live-type-badge">LIVE中</span>';
    } else if (item.is_upcoming) {
      badgesHTML += '<span class="badge upcoming-badge">📅 予定</span>';
      typeBadgeHTML = '<span class="badge type-badge upcoming-type-badge">配信予定</span>';
    } else if (item.is_live_archive) {
      typeBadgeHTML = '<span class="badge type-badge archive-type-badge">配信アーカイブ</span>';
    }

    if (!item.is_live && !item.is_upcoming && item.timestamp) {
      const timeStr = formatRelativeTime(item.timestamp);
      if (timeStr) {
        badgesHTML += `<span class="badge time-badge">${timeStr}</span>`;
      }
    }

    if (!typeBadgeHTML) {
      typeBadgeHTML = '<span class="badge type-badge video-type-badge">動画</span>';
    }

    // データをエスケープ
    const videoId = escapeAttribute(item.video_id || "");
    const title = escapeAttribute(item.title || "");
    const titleText = escapeHTML(item.title || "");
    const uploaderText = escapeHTML(item.uploader || "");
    const uploaderAttribute = escapeAttribute(item.uploader || "");
    const thumbnail = escapeAttribute(item.thumbnail || "");
    const isLive = item.is_live ? "true" : "false";
    const ariaLabel = escapeAttribute(
      `ビデオ: ${item.title || ""} - ${item.uploader || ""}`,
    );

    return `
      <button
        class="video-card"
        type="button"
        data-video-id="${videoId}"
        data-title="${title}"
        data-is-live="${isLive}"
        aria-label="${ariaLabel}"
      >
        <div class="thumbnail-container">
          <img
            class="thumbnail"
            src="${thumbnail}"
            loading="lazy"
            alt="${uploaderAttribute}"
          />
          <div class="type-badge-container">${typeBadgeHTML}</div>
          <div class="badges-container">${badgesHTML}</div>
        </div>
        <div class="video-info">
          <h3 class="title">${titleText}</h3>
          <p class="channel-title">${uploaderText}</p>
        </div>
      </button>
    `;
  } catch (error) {
    logError(MODULE, "Error building video card HTML", error);
    return "";
  }
}

/**
 * ========================================
 * フィルタリング・ソート
 * ======================================== */

/**
 * ビデオリストをフィルタリング
 * @param {Array} videos - ビデオリスト
 * @param {Object} filters - { channel, game, searchWords }
 * @returns {Array} フィルタリング済みビデオ
 */
export function filterVideos(videos, filters = {}) {
  if (!Array.isArray(videos)) {
    return [];
  }

  let filtered = [...videos];

  // チャンネルフィルタ
  if (filters.channel && filters.channel !== "ALL") {
    filtered = filtered.filter((v) =>
      (v.uploader || "").includes(filters.channel),
    );
  }

  // ゲームと自由キーワードフィルタ
  const searchTerms = [];
  if (filters.game) {
    searchTerms.push(filters.game.toLowerCase());
  }
  if (filters.searchWords) {
    searchTerms.push(
      ...filters.searchWords
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 0),
    );
  }

  if (searchTerms.length > 0) {
    filtered = filtered.filter((v) => {
      const text = `${v.title || ""} ${v.uploader || ""}`.toLowerCase();
      return searchTerms.every((term) => text.includes(term));
    });
  }

  log(MODULE, `Filtered videos: ${filtered.length} / ${videos.length}`);
  return filtered;
}

/**
 * ビデオリストをソート
 * 優先度: ライブ配信 > 予定配信 > 通常（タイムスタンプ新しい順）
 * @param {Array} videos - ビデオリスト
 * @returns {Array} ソート済みビデオ
 */
export function sortVideos(videos) {
  if (!Array.isArray(videos)) {
    return [];
  }

  // Sort only by available timestamps; uploader identity must not affect order.
  return [...videos].sort((a, b) => {
    const aTimestamp = Number(a.timestamp) || 0;
    const bTimestamp = Number(b.timestamp) || 0;

    if (aTimestamp !== bTimestamp) {
      return bTimestamp - aTimestamp;
    }

    return 0;
  });
}

/**
 * ========================================
 * レンダリング
 * ======================================== */

/**
 * ビデオグリッドをレンダリング
 * @param {Object} state - アプリケーション状態
 * @param {Object} dom - DOM操作オブジェクト
 */
export function renderGrid(state, dom) {
  if (!state || !dom) {
    logError(MODULE, "renderGrid called with missing parameters", null);
    return;
  }

  const container = dom.getGridContainer(state.currentMode);
  if (!container) {
    logError(MODULE, "Grid container not found", null);
    return;
  }

  try {
    // ビデオソース選択
    const source =
      state.currentMode === "official"
        ? state.appData.official
        : state.appData.clips;

    if (!Array.isArray(source)) {
      container.innerHTML = `<p class="message-card">${MESSAGES.INFO.INVALID_DATA}</p>`;
      return;
    }

    // フィルタリング
    const filtered = filterVideos(source, {
      channel: state.currentSelectedChannel,
      game: state.currentSelectedGame,
      searchWords: dom.getDOM("freeWordInput")?.value || "",
    });

    // ソート
    const sorted = sortVideos(filtered);
    updateGridMeta(state, dom, sorted.length, source.length);

    // 構築中かつ結果がない場合
    if (state.appData.is_building && sorted.length === 0) {
      renderBuildingState(container);
      return;
    }

    // 結果がある場合
    if (sorted.length > 0) {
      renderVideos(container, sorted, state.appData.is_building);
    } else {
      renderEmptyState(container);
    }

    log(MODULE, `Rendered ${sorted.length} videos`);
    return sorted.length;
  } catch (error) {
    logError(MODULE, "Error rendering grid", error);
    container.innerHTML = `<p class="message-card">${MESSAGES.ERROR.FAILED_RENDER}</p>`;
    return 0;
  }
}

function updateGridMeta(state, dom, visibleCount, sourceCount) {
  const connectionStatus = dom.getDOM("connectionStatus");
  const feedSummary = dom.getDOM("feedSummary");
  const activeFilters = dom.getDOM("activeFilters");
  const clearFiltersBtn = dom.getDOM("clearFiltersBtn");

  const status = state.appData.last_error
    ? "offline"
    : state.appData.is_building
      ? "loading"
      : "online";
  const statusLabel = state.appData.last_error
    ? "取得エラー"
    : state.appData.is_building
      ? "取得中"
      : "オンライン";

  if (connectionStatus) {
    connectionStatus.className = `status-pill ${status}`;
    connectionStatus.textContent = statusLabel;
  }

  if (feedSummary) {
    const totalOfficial = state.appData.official.length;
    const totalClips = state.appData.clips.length;
    const updatedText = formatLastUpdated(state.appData.last_updated);
    const baseSummary = `表示 ${visibleCount}/${sourceCount}件 ・ 配信 ${totalOfficial}件 ・ 切り抜き ${totalClips}件`;
    feedSummary.textContent = state.appData.is_building
      ? `${baseSummary} ・ 最新データを取得中`
      : `${baseSummary}${updatedText ? ` ・ ${updatedText}` : ""}`;
  }

  const filters = getActiveFilterLabels(state, dom);
  if (activeFilters) {
    activeFilters.innerHTML = "";
    filters.forEach((filter) => {
      const chip = document.createElement("span");
      chip.className = "filter-chip";
      chip.textContent = filter;
      activeFilters.appendChild(chip);
    });
  }

  if (clearFiltersBtn) {
    clearFiltersBtn.classList.toggle("hidden", filters.length === 0);
  }
}

function getActiveFilterLabels(state, dom) {
  const filters = [];
  const freeWord = dom.getDOM("freeWordInput")?.value.trim();

  if (state.currentSelectedChannel && state.currentSelectedChannel !== "ALL") {
    filters.push(`推し: ${state.currentSelectedChannel}`);
  }

  if (state.currentSelectedGame) {
    filters.push(`ゲーム: ${state.currentSelectedGame}`);
  }

  if (freeWord) {
    filters.push(`検索: ${freeWord}`);
  }

  return filters;
}

function formatLastUpdated(rawValue) {
  if (!rawValue) return "";
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) return "";
  return `更新 ${date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/**
 * ビデオを描画
 * @param {Element} container - コンテナ要素
 * @param {Array} videos - ビデオリスト
 * @param {boolean} isBuilding - 構築中フラグ
 */
function renderVideos(container, videos, isBuilding = false) {
  const htmlContent = videos.map((item) => buildVideoCardHTML(item)).join("");
  container.innerHTML = htmlContent;

  // 構築中の場合、ローディングメッセージを追加
  if (isBuilding) {
    const loadingMsg = document.createElement("div");
    loadingMsg.className = "loading-state loading-state-compact";
    loadingMsg.innerHTML = `
      <div class="spinner"></div>
      <p class="loading-subtitle">${MESSAGES.INFO.BUILDING_BACKGROUND}</p>
    `;
    container.appendChild(loadingMsg);
  }
}

/**
 * 構築中状態を描画
 * @param {Element} container - コンテナ要素
 */
function renderBuildingState(container) {
  container.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p class="loading-title">${MESSAGES.INFO.BUILDING}</p>
      <p class="loading-subtitle">${MESSAGES.INFO.BUILDING_DETAIL}</p>
    </div>
  `;
}

/**
 * 空の状態を描画
 * @param {Element} container - コンテナ要素
 */
function renderEmptyState(container) {
  container.innerHTML = `
    <div class="empty-state">
      <p class="empty-title">${MESSAGES.INFO.NO_VIDEOS}</p>
      <p class="empty-subtitle">条件に合う配信はありません。</p>
    </div>
  `;
}

/**
 * 空のグリッドを表示
 * @param {Object} dom - DOM操作オブジェクト
 * @param {string} mode - 'official' または 'clips'
 * @param {string} message - 表示メッセージ
 */
export function renderEmptyGrid(dom, mode, message = MESSAGES.INFO.NO_VIDEOS) {
  const container = dom.getGridContainer(mode);
  if (container) {
    container.innerHTML = `<p class="message-card">${escapeHTML(message)}</p>`;
  }
}

/**
 * ローディング状態を表示
 * @param {Object} dom - DOM操作オブジェクト
 * @param {string} mode - 'official' または 'clips'
 */
export function renderLoadingGrid(dom, mode) {
  const container = dom.getGridContainer(mode);
  if (container) {
    container.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p class="loading-title">${MESSAGES.INFO.LOADING}</p>
      </div>
    `;
  }
}

/**
 * エラー状態を表示
 * @param {Object} dom - DOM操作オブジェクト
 * @param {string} mode - 'official' または 'clips'
 * @param {string} message - エラーメッセージ
 */
export function renderErrorGrid(
  dom,
  mode,
  message = MESSAGES.ERROR.FAILED_RENDER,
) {
  const container = dom.getGridContainer(mode);
  if (container) {
    container.innerHTML = `
      <p class="message-card error">${escapeHTML(message)}</p>
    `;
  }
}

/**
 * スケルトンローダーを表示
 * @param {Object} dom - DOM操作オブジェクト
 * @param {string} mode - 'official' または 'clips'
 * @param {number} count - スケルトン数
 */
export function renderSkeletonGrid(dom, mode, count = 4) {
  const container = dom.getGridContainer(mode);
  if (!container) return;

  let skeletons = "";
  for (let i = 0; i < count; i++) {
    skeletons += `
      <article class="video-card-skeleton">
        <div class="skeleton-thumbnail"></div>
        <div class="skeleton-info">
          <div class="skeleton-title"></div>
          <div class="skeleton-channel"></div>
        </div>
      </article>
    `;
  }

  container.innerHTML = skeletons;
}

export default {
  buildVideoCardHTML,
  filterVideos,
  sortVideos,
  renderGrid,
  renderEmptyGrid,
  renderLoadingGrid,
  renderErrorGrid,
  renderSkeletonGrid,
  formatRelativeTime,
};
