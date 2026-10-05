/**
 * utils.js
 * 共通ユーティリティ関数を集約するモジュール
 * 複数のモジュールで使用される関数を一元管理
 */

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const HTML_ESCAPE_REGEX = /[&<>"']/g;

/**
 * HTML文字列をエスケープ (高速な正規表現置換)
 * DOM 生成 (createElement/innerText) を完全排除し GC とレイアウト負荷をゼロにする
 * @param {string} str - エスケープする文字列
 * @returns {string} エスケープされた文字列
 */
export function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(HTML_ESCAPE_REGEX, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * 属性値をエスケープ (escapeHTMLと同一の文字セットをエスケープ)
 * @param {string} str - エスケープする文字列
 * @returns {string} エスケープされた文字列
 */
export function escapeAttribute(str) {
  if (!str) return '';
  return String(str).replace(HTML_ESCAPE_REGEX, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * 要素にCSSクラスを追加
 * @param {Element} element - 対象要素
 * @param {string} className - 追加するクラス名
 */
export function addClass(element, className) {
  element?.classList?.add(className);
}

/**
 * 要素からCSSクラスを削除
 * @param {Element} element - 対象要素
 * @param {string} className - 削除するクラス名
 */
export function removeClass(element, className) {
  element?.classList?.remove(className);
}


/**
 * 要素のCSSクラスを切り替え
 * @param {Element} element - 対象要素
 * @param {string} className - 切り替えるクラス名
 * @param {boolean} [force] - 強制状態
 */
export function toggleClass(element, className, force) {
  if (!element?.classList) return;
  if (force === undefined) {
    element.classList.toggle(className);
    return;
  }
  element.classList.toggle(className, force);
}

/**
 * 相対時間をフォーマット（例：「3時間前」）
 * @param {number} timestamp - Unix timestamp (秒)
 * @param {number} [currentUnixSeconds] - 事前計算済みの現在Unix秒（ループ内のDate.now()呼び出しを省く）
 * @returns {string} フォーマットされた相対時間
 */
export function formatRelativeTime(timestamp, currentUnixSeconds) {
  if (!timestamp || timestamp <= 0) return '';

  const now = currentUnixSeconds || Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}日前`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}ヶ月前`;
  return `${Math.floor(diff / 31536000)}年前`;
}

/**
 * ディバウンス処理を実行
 * 指定時間内の連続実行を1回にまとめる
 * @param {Function} func - 実行する関数
 * @param {number} delay - 遅延時間(ms)
 * @returns {Function} ディバウンスされた関数
 */
export function debounce(func, delay = 300) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
}







/**
 * ローカルストレージから値を取得
 * @param {string} key - キー
 * @param {*} defaultValue - デフォルト値
 * @returns {*} 値またはデフォルト値
 */
export function getFromLocalStorage(key, defaultValue = null) {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch (error) {
    console.error(`Error reading from localStorage:`, error);
    return defaultValue;
  }
}

/**
 * ローカルストレージに値を保存
 * @param {string} key - キー
 * @param {*} value - 保存する値
 * @returns {boolean} 成功したかどうか
 */
export function saveToLocalStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Error writing to localStorage:`, error);
    return false;
  }
}












/**
 * ログ関数（デバッグ時の識別を容易にする）
 * @param {string} module - モジュール名
 * @param {*} message - メッセージ
 * @param {*} data - 追加データ
 */
export function log(module, message, data = null) {
  const timestamp = new Date().toLocaleTimeString('ja-JP');
  const prefix = `[${timestamp}] [${module}]`;
  if (data !== null) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

/**
 * エラーログ関数
 * @param {string} module - モジュール名
 * @param {string} message - メッセージ
 * @param {Error} error - エラーオブジェクト
 */
export function logError(module, message, error) {
  const timestamp = new Date().toLocaleTimeString('ja-JP');
  console.error(`[${timestamp}] [${module}] ${message}`, error);
}
