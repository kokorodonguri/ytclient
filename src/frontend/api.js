/**
 * api.js
 * バックエンド API呼び出しを管理するモジュール
 * すべてのサーバー通信をここに集約
 */

import {
  API_CONFIG,
  API_BASE_URL_STORAGE_KEY,
  API_KEY_STORAGE_KEY,
  setRuntimeApiConfig,
} from "./constants.js";
import { getFromLocalStorage, log, logError } from "./utils.js";

const MODULE = "API";

/**
 * ========================================
 * 認証情報
 * ======================================== */

/**
 * 認証ヘッダーを構築
 * @returns {Object} ヘッダーオブジェクト
 */
function buildAuthHeaders() {
  return API_CONFIG.API_KEY ? { "X-API-Key": API_CONFIG.API_KEY } : {};
}

/**
 * 保存済みのバックエンド接続情報を読み込む
 * Electron では IPC 経由、それ以外は localStorage を参照する
 * @returns {Promise<void>}
 */
export async function initApiCredentials() {
  try {
    const result = await window.api?.getBackendConfig?.();
    if (result?.ok && result.config) {
      setRuntimeApiConfig({
        baseUrl: result.config.backendUrl,
        apiKey: result.config.apiKey,
      });
      log(MODULE, "Backend config loaded from host app");
      return;
    }
  } catch (error) {
    logError(MODULE, "Failed to load backend config from host app", error);
  }

  // Electron 以外（APK / ブラウザ）は端末側の保存値を使う
  const storedKey = getFromLocalStorage(API_KEY_STORAGE_KEY, "");
  const storedBaseUrl = getFromLocalStorage(API_BASE_URL_STORAGE_KEY, "");
  setRuntimeApiConfig({
    baseUrl: typeof storedBaseUrl === "string" ? storedBaseUrl : "",
    apiKey: typeof storedKey === "string" ? storedKey : "",
  });
  if (storedKey || storedBaseUrl) {
    log(MODULE, "Backend config loaded from local storage");
  }
}

/**
 * ========================================
 * ユーティリティ関数
 * ======================================== */

/**
 * タイムアウト付きfetchを実行
 * @param {string} url - リクエストURL
 * @param {Object} options - fetchオプション
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT);

  try {
    return await fetch(url, {
      ...options,
      headers: { ...buildAuthHeaders(), ...(options.headers || {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * APIレスポンスをチェック
 * @param {Response} response
 * @returns {Promise<Object>}
 */
async function handleApiResponse(response) {
  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    const contentType = response.headers.get("content-type") || "";
    const looksLikeHtml = contentType.includes("text/html") || /^\s*</.test(errorText);
    const isMissingApi = response.status === 404 && looksLikeHtml;
    if (isMissingApi) {
      const error = new Error(
        `API Error: ${response.status} ${response.statusText} - VSPO APIではないサーバーに接続しています`,
      );
      error.status = response.status;
      error.body = errorText;
      throw error;
    }

    if (response.status === 401 || response.status === 403) {
      const error = new Error(
        "APIキーが未設定または無効です。設定画面で確認してください",
      );
      error.status = response.status;
      error.body = errorText;
      throw error;
    }

    if (response.status === 429) {
      const error = new Error(
        "リクエストが多すぎます。しばらく待って再試行してください",
      );
      error.status = response.status;
      error.body = errorText;
      throw error;
    }

    const error = new Error(
      `API Error: ${response.status} ${response.statusText}`,
    );
    error.status = response.status;
    error.body = errorText;
    throw error;
  }

  try {
    return await response.json();
  } catch (e) {
    throw new Error("Invalid JSON response from server");
  }
}

/**
 * エラーメッセージを取得
 * @param {Error} error
 * @returns {string}
 */
export function getErrorMessage(error) {
  if (error?.name === "AbortError") {
    return "リクエストがタイムアウトしました";
  }

  if (error instanceof TypeError) {
    if (error.message.includes("Failed to fetch")) {
      return "ネットワークエラー: サーバーに接続できません";
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "予期しないエラーが発生しました";
}

/**
 * ========================================
 * API リクエスト
 * ======================================== */

/**
 * フィードデータを取得（公式配信と切り抜き）
 * @returns {Promise<Object>} { official: [], clips: [], is_building: boolean }
 */
export async function fetchFeed() {
  try {
    log(MODULE, "Fetching feed data...");

    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.FEED}`;
    const response = await fetchWithTimeout(url);
    const data = await handleApiResponse(response);

    if (data && data.data) {
      const feedData = {
        official: Array.isArray(data.data.official) ? data.data.official : [],
        clips: Array.isArray(data.data.clips) ? data.data.clips : [],
        is_building: Boolean(data.data.is_building),
        last_updated: data.data.last_updated || null,
        last_error: data.data.last_error || null,
      };

      log(
        MODULE,
        `Feed fetched: ${feedData.official.length} official, ${feedData.clips.length} clips`,
      );
      return feedData;
    }

    throw new Error("Invalid feed data structure");
  } catch (error) {
    logError(MODULE, "Feed fetch error", error);
    throw new Error(getErrorMessage(error));
  }
}

/**
 * ビデオの説明文とコメントを取得
 * @param {string} videoId - YouTubeビデオID
 * @param {number} limit - 取得するコメント数（0で非取得）
 * @returns {Promise<Object>} { description: string, comments: [] }
 */
export async function fetchVideoComments(videoId, limit = 0) {
  if (!videoId || typeof videoId !== "string") {
    throw new Error("Invalid video ID");
  }

  try {
    log(MODULE, `Fetching comments for video: ${videoId}`);

    const params = new URLSearchParams({
      limit: limit.toString(),
    });

    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.COMMENTS(videoId)}?${params.toString()}`;
    const response = await fetchWithTimeout(url);
    const data = await handleApiResponse(response);

    log(MODULE, `Comments fetched for video: ${videoId}`);
    return data;
  } catch (error) {
    logError(MODULE, "Comments fetch error", error);
    throw new Error("説明文の取得に失敗しました");
  }
}

/**
 * ビデオの説明文を取得（コメントなし）
 * @param {string} videoId - YouTubeビデオID
 * @returns {Promise<string|null>} 説明文またはnull
 */
export async function fetchVideoDescription(videoId) {
  try {
    const data = await fetchVideoComments(videoId, 0);
    return (data && data.description) || null;
  } catch (error) {
    logError(MODULE, "Description fetch error", error);
    return null;
  }
}

/**
 * ========================================
 * WebSocket 管理
 * ======================================== */

/**
 * ライブチャット WebSocketを作成
 * @param {string} videoId - YouTubeビデオID
 * @param {Object} handlers - { onMessage, onError, onClose }
 * @returns {WebSocket|null}
 */
export function createLiveChatWebSocket(videoId, handlers = {}) {
  if (!videoId || typeof videoId !== "string") {
    logError(MODULE, "Invalid video ID for WebSocket", null);
    return null;
  }

  try {
    log(MODULE, `Creating WebSocket for video: ${videoId}`);

    const wsBaseUrl = API_CONFIG.BASE_URL.replace(/^http/, "ws");
    // WebSocket はブラウザからカスタムヘッダーを付けられないため、
    // 認証はクエリ文字列で渡す（そのため wss/TLS が前提）
    const authQuery = API_CONFIG.API_KEY
      ? `?api_key=${encodeURIComponent(API_CONFIG.API_KEY)}`
      : "";
    const wsUrl = `${wsBaseUrl}${API_CONFIG.ENDPOINTS.LIVE_CHAT(videoId)}${authQuery}`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      log(MODULE, `WebSocket connected for video ${videoId}`);
    };

    socket.onmessage = (event) => {
      if (handlers.onMessage) {
        try {
          const data = JSON.parse(event.data);
          handlers.onMessage(data);
        } catch (e) {
          logError(MODULE, "Failed to parse WebSocket message", e);
        }
      }
    };

    socket.onerror = (error) => {
      logError(MODULE, "WebSocket error", error);
      if (handlers.onError) {
        handlers.onError(error);
      }
    };

    socket.onclose = () => {
      log(MODULE, "WebSocket closed");
      if (handlers.onClose) {
        handlers.onClose();
      }
    };

    return socket;
  } catch (error) {
    logError(MODULE, "Failed to create WebSocket", error);
    return null;
  }
}

/**
 * WebSocketを安全に閉じる
 * @param {WebSocket} socket
 */
export function closeWebSocket(socket) {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    try {
      socket.close();
      log(MODULE, "WebSocket closed successfully");
    } catch (e) {
      logError(MODULE, "Error closing WebSocket", e);
    }
  }
}

/**
 * ========================================
 * ユーティリティ
 * ======================================== */

/**
 * API接続をテスト
 * @returns {Promise<boolean>}
 */
export async function testApiConnection() {
  try {
    log(MODULE, "Testing API connection...");

    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.HEALTH}`;
    const response = await fetchWithTimeout(url, { method: "GET" });

    const isConnected = response.ok;
    log(MODULE, `API connection test: ${isConnected ? "success" : "failed"}`);
    return isConnected;
  } catch (error) {
    logError(MODULE, "API connection test failed", error);
    return false;
  }
}

/**
 * 外部URLをブラウザで開く
 * Electron環境またはWebブラウザで動作
 * @param {string} url - 開くURL
 * @returns {Promise<void>}
 */
export async function openExternalUrl(url) {
  try {
    // URL検証
    if (!url || typeof url !== "string") {
      throw new Error("Invalid URL");
    }

    // URL形式の確認
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      throw new Error("Malformed URL");
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only http(s) URLs are allowed");
    }

    log(MODULE, `Opening external URL: ${url}`);

    if (window.api?.openExternalUrl) {
      const result = await window.api.openExternalUrl(url);
      if (!result?.ok) {
        throw new Error(result?.error || "Failed to open external URL");
      }
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    logError(MODULE, "Error opening external URL", error);
    // フォールバック: 通常のwindow.openを使用
    try {
      const fallbackUrl = new URL(url);
      if (["http:", "https:"].includes(fallbackUrl.protocol)) {
        window.open(fallbackUrl.href, "_blank", "noopener,noreferrer");
      }
    } catch (fallbackError) {
      logError(MODULE, "Fallback URL open failed", fallbackError);
    }
  }
}

/**
 * YouTube埋め込みURLを生成
 * @param {string} videoId - YouTubeビデオID
 * @returns {string}
 */
export function getYouTubeEmbedUrl(videoId) {
  if (!videoId) return "";
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?controls=1&modestbranding=1`;
}

/**
 * YouTube視聴URLを生成
 * @param {string} videoId - YouTubeビデオID
 * @returns {string}
 */
export function getYouTubeWatchUrl(videoId) {
  if (!videoId) return "";
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/**
 * YouTube チャンネルURLを生成
 * @param {string} channelUrl - チャンネルURL
 * @returns {string}
 */
export function getYouTubeChannelUrl(channelUrl) {
  if (!channelUrl) return "";
  return channelUrl;
}

/**
 * ========================================
 * デバッグ・ログ
 * ======================================== */

/**
 * API設定を取得
 * @returns {Object}
 */
export function getApiConfig() {
  return { ...API_CONFIG };
}

/**
 * API状態をログ出力
 */
export function logApiStatus() {
  log(MODULE, "API Config:", {
    baseUrl: API_CONFIG.BASE_URL,
    timeout: API_CONFIG.TIMEOUT,
    endpoints: API_CONFIG.ENDPOINTS,
  });
}

export default {
  initApiCredentials,
  fetchFeed,
  fetchVideoComments,
  fetchVideoDescription,
  createLiveChatWebSocket,
  closeWebSocket,
  testApiConnection,
  openExternalUrl,
  getYouTubeEmbedUrl,
  getYouTubeWatchUrl,
  getYouTubeChannelUrl,
  getErrorMessage,
  getApiConfig,
  logApiStatus,
};
