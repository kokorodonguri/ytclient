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

// ライブチャットの再接続。配信が終わってもサーバーは正常終了で閉じるため、
// 無制限に張り直すと「ルーム作成 → 即クローズ」の往復を延々と続けてしまう。
const LIVE_CHAT_MAX_ATTEMPTS = 5;
const LIVE_CHAT_BASE_RETRY_MS = 2000;
const LIVE_CHAT_MAX_RETRY_MS = 30000;
// 接続がこの時間続いたら健全とみなして再試行回数を戻す
const LIVE_CHAT_STABLE_MS = 30000;
// 1008 Policy Violation: 動画IDが不正・Origin 不許可・認証失敗。再試行しない。
const LIVE_CHAT_CLOSE_POLICY_VIOLATION = 1008;
// 1013 Try Again Later: サーバー側のルーム上限。少し待てば入れる。
const LIVE_CHAT_CLOSE_TRY_AGAIN_LATER = 1013;

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
  } catch {
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
    const etag = response.headers.get("ETag") || "";
    const data = await handleApiResponse(response);

    if (data && data.data) {
      const feedData = {
        official: Array.isArray(data.data.official) ? data.data.official : [],
        clips: Array.isArray(data.data.clips) ? data.data.clips : [],
        is_building: Boolean(data.data.is_building),
        last_updated: data.data.last_updated || null,
        last_error: data.data.last_error || null,
        // 中身が前回と同一かの判定に使う。サーバが出さない場合は空文字
        etag,
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
 * 配信中の再生用ストリーム (HLS) または動画ストリーム情報を取得
 * 配信中は HLS (ABRマスタープレイリスト)、開始前は 409 (upcoming) を返す。
 * フロントエンドは HLS が利用可能な場合にネイティブ高画質再生を行い、それ以外は iframe にフォールバックする。
 * @param {string} videoId - YouTubeビデオID
 * @returns {Promise<{url: string, protocol: string, height: number|null, is_live: boolean, title: string}>}
 */
export async function fetchVideoStream(videoId) {
  if (!videoId || typeof videoId !== "string") {
    throw new Error("Invalid video ID");
  }

  const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.STREAM(videoId)}`;
  const response = await fetchWithTimeout(url);
  const data = await handleApiResponse(response);

  const stream = data?.data;
  if (!stream?.url) {
    const error = new Error("再生URLを取得できませんでした");
    error.status = 404;
    throw error;
  }

  log(MODULE, `Stream resolved for video: ${videoId}`);
  return stream;
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
 * ライブチャットへ接続する（自動再接続つき）
 *
 * 以前は素の WebSocket を返すだけで再接続が無く、切断がユーザーに何も
 * 見えなかった（弾幕が黙って止まる）。ここで指数バックオフの再接続と
 * 状態通知を持つ。
 *
 * @param {string} videoId
 * @param {Object} handlers
 * @param {(message: Object) => void} handlers.onMessage
 * @param {(status: string, detail: ?string) => void} [handlers.onStatus]
 *   status: "connecting" | "open" | "reconnecting" | "ended" | "failed"
 * @returns {{close: () => void}|null}
 */
export function connectLiveChat(videoId, handlers = {}) {
  if (!videoId || typeof videoId !== "string") {
    logError(MODULE, "Invalid video ID for live chat", null);
    return null;
  }

  const notify = (status, detail = null) => {
    try {
      handlers.onStatus?.(status, detail);
    } catch (error) {
      logError(MODULE, "Live chat status handler threw", error);
    }
  };

  let socket = null;
  let retryTimer = null;
  let stableTimer = null;
  let attempt = 0;
  let closedByCaller = false;

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  // 開いた直後に閉じられる接続 (終わった配信など) で回数を戻すと
  // LIVE_CHAT_MAX_ATTEMPTS に届かず無限に張り直すため、メッセージを受け取るか
  // 一定時間つながり続けてから戻す。
  const clearStableTimer = () => {
    if (stableTimer !== null) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  };

  const markHealthy = () => {
    clearStableTimer();
    attempt = 0;
  };

  const scheduleReconnect = (reason) => {
    if (closedByCaller) return;

    if (attempt >= LIVE_CHAT_MAX_ATTEMPTS) {
      // 配信が終わった場合もここに来る。無限に張り直すと、そのたびに
      // サーバー側で pytchat のルームが作られて即閉じる往復になる。
      notify("failed", reason);
      return;
    }

    // オフライン中は時間で粘らない。復帰イベントを待つ方が速く確実。
    if (navigator.onLine === false) {
      notify("reconnecting", "オフライン");
      window.addEventListener("online", connect, { once: true });
      return;
    }

    const delay = Math.min(
      LIVE_CHAT_BASE_RETRY_MS * 2 ** attempt,
      LIVE_CHAT_MAX_RETRY_MS,
    );
    attempt += 1;
    notify("reconnecting", reason);
    log(MODULE, `Reconnecting live chat in ${delay}ms (attempt ${attempt})`);
    clearRetryTimer();
    retryTimer = setTimeout(connect, delay);
  };

  function connect() {
    if (closedByCaller) return;
    clearRetryTimer();
    notify(attempt === 0 ? "connecting" : "reconnecting");

    const wsBaseUrl = API_CONFIG.BASE_URL.replace(/^http/, "ws");
    // WebSocket はブラウザからカスタムヘッダーを付けられない。クエリ文字列は
    // プロキシ/トンネルのアクセスログにフルURLごと残ることがあるため使わず、
    // 接続確立後の最初のメッセージでAPIキーを送る（サーバー側もそれを待つ）
    const wsUrl = `${wsBaseUrl}${API_CONFIG.ENDPOINTS.LIVE_CHAT(videoId)}`;

    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      logError(MODULE, "Failed to create WebSocket", error);
      scheduleReconnect("接続できません");
      return;
    }

    socket.onopen = () => {
      if (API_CONFIG.API_KEY) {
        try {
          socket.send(
            JSON.stringify({ type: "auth", api_key: API_CONFIG.API_KEY }),
          );
        } catch (error) {
          logError(MODULE, "Failed to send WebSocket auth message", error);
        }
      }
      clearStableTimer();
      stableTimer = setTimeout(markHealthy, LIVE_CHAT_STABLE_MS);
      log(MODULE, `Live chat connected for video ${videoId}`);
      notify("open");
    };

    socket.onmessage = (event) => {
      if (attempt !== 0) markHealthy();
      try {
        handlers.onMessage?.(JSON.parse(event.data));
      } catch (error) {
        logError(MODULE, "Failed to parse live chat message", error);
      }
    };

    socket.onerror = (error) => {
      // 実際の後始末は onclose で行う（error の直後に必ず来る）
      logError(MODULE, "Live chat socket error", error);
    };

    socket.onclose = (event) => {
      socket = null;
      clearStableTimer();
      if (closedByCaller) return;

      // 1008 は「動画IDが不正 / Origin 不許可 / 認証失敗」。張り直しても同じ。
      if (event.code === LIVE_CHAT_CLOSE_POLICY_VIOLATION) {
        logError(MODULE, `Live chat refused (code ${event.code})`, null);
        notify("failed", "接続を拒否されました");
        return;
      }

      // 1013 = Try Again Later。サーバー側のルーム上限なので、少し長く待つ。
      if (event.code === LIVE_CHAT_CLOSE_TRY_AGAIN_LATER) {
        attempt = Math.max(attempt, 2);
        scheduleReconnect("混み合っています");
        return;
      }

      scheduleReconnect("切断されました");
    };
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      clearRetryTimer();
      clearStableTimer();
      window.removeEventListener("online", connect);
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      ) {
        try {
          socket.close();
          log(MODULE, "Live chat closed by caller");
        } catch (error) {
          logError(MODULE, "Error closing live chat socket", error);
        }
      }
      socket = null;
    },
  };
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
    } catch {
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
 * ========================================
 * デバッグ・ログ
 * ======================================== */


