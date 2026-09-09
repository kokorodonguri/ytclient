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
export function buildVideoCardHTML(item, currentUnixSeconds) {
  if (!item || typeof item !== "object") {
    return "";
  }

  try {
    // サムネイル上に載せるのは経過時間だけに絞る。
    // 種別は本文側の .card-status に 1 つだけ出す
    let badgesHTML = "";
    let statusClass = "";
    let statusLabel = "";

    if (item.is_live) {
      statusClass = "is-live";
      statusLabel = "LIVE";
    } else if (item.is_upcoming) {
      statusClass = "is-upcoming";
      statusLabel = "配信予定";
    } else if (item.is_live_archive) {
      statusClass = "is-archive";
      statusLabel = "アーカイブ";
    } else {
      statusClass = "is-video";
      statusLabel = "動画";
    }

    if (!item.is_live && !item.is_upcoming && item.timestamp) {
      const timeStr = formatRelativeTime(item.timestamp, currentUnixSeconds);
      if (timeStr) {
        badgesHTML += `<span class="badge time-badge">${timeStr}</span>`;
      }
    }

    // データをエスケープ（HTMLエスケープ結果は属性・本文双方で安全に共用可能）
    const videoId = escapeAttribute(item.video_id || "");
    const title = escapeHTML(item.title || "");
    const uploader = escapeHTML(item.uploader || "");
    const thumbnail = escapeAttribute(item.thumbnail || "");
    const isLive = item.is_live ? "true" : "false";
    const ariaLabel = `ビデオ: ${title} - ${uploader}`;

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
            alt=""
          />
          <div class="badges-container">${badgesHTML}</div>
        </div>
        <div class="video-info">
          <span class="card-status ${statusClass}">${statusLabel}</span>
          <span class="title">${title}</span>
          <span class="channel-title">${uploader}</span>
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

  const hasChannel = Boolean(filters.channel && filters.channel !== "ALL");
  const channelFilter = hasChannel ? filters.channel : null;

  const searchTerms = [];
  if (filters.game) {
    searchTerms.push(filters.game.toLowerCase());
  }
  if (filters.searchWords) {
    const words = filters.searchWords.split(/\s+/);
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i].toLowerCase();
      if (w.length > 0) searchTerms.push(w);
    }
  }

  const hasSearch = searchTerms.length > 0;

  // フィルタ条件が何もない場合は配列コピーを避ける
  if (!hasChannel && !hasSearch) {
    return videos;
  }

  // 単一走査 (1パス) でフィルタリングし、中間配列の多重生成を抑制
  const filtered = [];
  const searchTermsCount = searchTerms.length;

  for (let i = 0; i < videos.length; i += 1) {
    const v = videos[i];
    if (!v) continue;

    if (hasChannel && !(v.uploader || "").includes(channelFilter)) {
      continue;
    }

    if (hasSearch) {
      // 検索インデックス（小文字化されたタイトルと投稿者名）を遅延生成してキャッシュ
      // ユーザーの入力毎の大量の文字列結合・toLowerCase()・GC 負荷をゼロにする
      const searchIndex =
        v._searchIndex ||
        (v._searchIndex = `${v.title || ""} ${v.uploader || ""}`.toLowerCase());

      let matches = true;
      for (let j = 0; j < searchTermsCount; j += 1) {
        if (!searchIndex.includes(searchTerms[j])) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
    }

    filtered.push(v);
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
  // 既に降順なら並べ替えも複製もしない (サーバは新しい順で返す)。
  let sortedAlready = true;
  for (let i = 1; i < videos.length; i += 1) {
    if ((Number(videos[i - 1].timestamp) || 0) < (Number(videos[i].timestamp) || 0)) {
      sortedAlready = false;
      break;
    }
  }
  if (sortedAlready) return videos;

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
      cancelPendingRender();
      renderBuildingState(container);
      return;
    }

    // 結果がある場合
    if (sorted.length > 0) {
      renderVideos(container, sorted, state.appData.is_building);
    } else {
      cancelPendingRender();
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
 * ========================================
 * 段階描画
 * ======================================== */

// 一覧は 4000 件規模になる。全件を一度に DOM 化すると 33,000 ノード /
// HTML 3.4MB になり、1 回の描画で 400〜700ms メインスレッドが止まる
// (実測: build 28ms + innerHTML 110ms + layout 566ms)。
// 画面に入る分だけ描き、番兵が見えたら続きを足す。
const RENDER_CHUNK_SIZE = 60;

let pendingRender = null;

/**
 * 進行中の段階描画を止める。再描画・画面切り替えの前に必ず呼ぶ
 */
function cancelPendingRender() {
  if (!pendingRender) return;
  pendingRender.observer?.disconnect();
  window.removeEventListener("scroll", onScrollMaybeAppend);
  pendingRender = null;
}

// IntersectionObserver は描画が止まっている間 (ウィンドウが背面にある、
// 一部の埋め込み環境など) コールバックが呼ばれない。スクロールでも
// 到達を見て、取りこぼしを防ぐ
const SCROLL_CHECK_INTERVAL_MS = 100;
let lastScrollCheckAt = 0;

function onScrollMaybeAppend() {
  if (!pendingRender) return;
  // requestAnimationFrame は描画が止まっている間 呼ばれないため、
  // 時刻での間引きにする (計測するのは番兵 1 要素の矩形だけ)
  const now = Date.now();
  if (now - lastScrollCheckAt < SCROLL_CHECK_INTERVAL_MS) return;
  lastScrollCheckAt = now;

  const rect = pendingRender.sentinel.getBoundingClientRect();
  if (rect.top <= window.innerHeight + 800) appendChunk();
}

function appendChunk() {
  if (!pendingRender) return;

  const { videos, sentinel } = pendingRender;
  const start = pendingRender.offset;
  const end = Math.min(start + RENDER_CHUNK_SIZE, videos.length);
  if (start >= end) {
    cancelPendingRender();
    sentinel?.remove();
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let html = "";
  for (let i = start; i < end; i += 1) {
    html += buildVideoCardHTML(videos[i], nowSec);
  }
  // 番兵の手前に差し込む。innerHTML の作り直しではないので
  // 既存カードのノードもスクロール位置も維持される
  sentinel.insertAdjacentHTML("beforebegin", html);
  pendingRender.offset = end;

  if (end >= videos.length) {
    cancelPendingRender();
    sentinel.remove();
  }
}

/**
 * ビデオを描画
 * @param {Element} container - コンテナ要素
 * @param {Array} videos - ビデオリスト
 * @param {boolean} isBuilding - 構築中フラグ
 */
function renderVideos(container, videos, isBuilding = false) {
  cancelPendingRender();

  // 再描画でフォーカス中のカードが破棄されるため、復元用にIDを保持
  const focusedVideoId =
    document.activeElement?.closest?.(".video-card")?.dataset.videoId || null;

  const firstCount = Math.min(RENDER_CHUNK_SIZE, videos.length);
  const nowSec = Math.floor(Date.now() / 1000);
  let html = "";
  for (let i = 0; i < firstCount; i += 1) {
    html += buildVideoCardHTML(videos[i], nowSec);
  }
  container.innerHTML = html;

  if (videos.length > firstCount) {
    const sentinel = document.createElement("div");
    sentinel.className = "grid-sentinel";
    sentinel.setAttribute("aria-hidden", "true");
    container.appendChild(sentinel);

    pendingRender = { container, videos, offset: firstCount, sentinel, observer: null };

    if (typeof IntersectionObserver === "function") {
      // 画面下端の手前で先読みする。rootMargin を広めに取り、
      // スクロールしてから描き始めることによる空白を避ける
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) appendChunk();
        },
        { rootMargin: "800px 0px" },
      );
      observer.observe(sentinel);
      pendingRender.observer = observer;
    }

    window.addEventListener("scroll", onScrollMaybeAppend, { passive: true });
    // 初回描画で画面が埋まらない場合に備えて 1 度だけ判定する
    onScrollMaybeAppend();
  }

  if (focusedVideoId) {
    container
      .querySelector(`.video-card[data-video-id="${CSS.escape(focusedVideoId)}"]`)
      ?.focus();
  }

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
