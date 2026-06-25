/**
 * utils.js
 * 共通ユーティリティ関数を集約するモジュール
 * 複数のモジュールで使用される関数を一元管理
 */

/**
 * HTML文字列をエスケープ
 * XSS対策として使用
 * @param {string} str - エスケープする文字列
 * @returns {string} エスケープされた文字列
 */
export function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

/**
 * 属性値をエスケープ
 * HTML属性内で使用する値のエスケープ
 * @param {string} str - エスケープする文字列
 * @returns {string} エスケープされた文字列
 */
export function escapeAttribute(str) {
  return escapeHTML(str).replace(/"/g, '&quot;');
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
 * 要素がCSSクラスを持つか確認
 * @param {Element} element - 対象要素
 * @param {string} className - 確認するクラス名
 * @returns {boolean}
 */
export function hasClass(element, className) {
  return Boolean(element?.classList?.contains(className));
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
 * @returns {string} フォーマットされた相対時間
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp || timestamp <= 0) return '';

  const now = Math.floor(Date.now() / 1000);
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
 * スロットル処理を実行
 * 指定時間ごとに最大1回の実行
 * @param {Function} func - 実行する関数
 * @param {number} limit - 制限時間(ms)
 * @returns {Function} スロットルされた関数
 */
export function throttle(func, limit = 300) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * イベントリスナーを安全に追加
 * @param {Element} element - 対象要素
 * @param {string} eventType - イベント種別
 * @param {Function} handler - ハンドラー関数
 * @param {Object} options - イベントリスナーオプション
 * @returns {Function} リスナー削除用関数
 */
export function safeAddEventListener(element, eventType, handler, options = {}) {
  if (!element) return () => {};

  element.addEventListener(eventType, handler, options);

  // リスナー削除用関数を返す
  return () => element.removeEventListener(eventType, handler, options);
}

/**
 * 複数のイベントリスナーを一括追加
 * @param {Element} element - 対象要素
 * @param {Object} handlers - { eventType: handler, ... }
 * @returns {Function} すべてのリスナー削除用関数
 */
export function addMultipleEventListeners(element, handlers) {
  const removers = [];

  for (const [eventType, handler] of Object.entries(handlers)) {
    removers.push(safeAddEventListener(element, eventType, handler));
  }

  return () => removers.forEach(remover => remover());
}

/**
 * 要素が画面内に表示されているかチェック
 * Intersection Observer APIを使用
 * @param {Element} element - チェック対象要素
 * @param {Function} callback - 表示状態変更時のコールバック
 * @param {Object} options - Intersection Observerオプション
 * @returns {Function} オブザーバー停止用関数
 */
export function observeElementVisibility(element, callback, options = {}) {
  if (!element || typeof IntersectionObserver === 'undefined') {
    return () => {};
  }

  const observer = new IntersectionObserver(
    ([entry]) => callback(entry.isIntersecting),
    { threshold: 0.1, ...options }
  );

  observer.observe(element);

  return () => observer.disconnect();
}

/**
 * 複数のPromiseを順序保持で実行
 * @param {Array<Function>} tasks - Promise返却関数の配列
 * @returns {Promise<Array>} すべての結果
 */
export async function executeSequentially(tasks) {
  const results = [];
  for (const task of tasks) {
    results.push(await task());
  }
  return results;
}

/**
 * 複数のPromiseを並列実行（エラーは無視）
 * @param {Array<Promise>} promises - Promise配列
 * @returns {Promise<Array>} すべての結果（失敗時はnull）
 */
export async function executeInParallel(promises) {
  return Promise.allSettled(promises).then(results =>
    results.map(r => r.status === 'fulfilled' ? r.value : null)
  );
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
 * ローカルストレージからキーを削除
 * @param {string} key - キー
 * @returns {boolean} 成功したかどうか
 */
export function removeFromLocalStorage(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.error(`Error removing from localStorage:`, error);
    return false;
  }
}

/**
 * クエリパラメータをパース
 * @param {string} queryString - クエリ文字列
 * @returns {Object} パースされたオブジェクト
 */
export function parseQueryParams(queryString = '') {
  const params = new URLSearchParams(queryString);
  const result = {};

  for (const [key, value] of params) {
    result[key] = value;
  }

  return result;
}

/**
 * オブジェクトをクエリ文字列に変換
 * @param {Object} params - パラメータオブジェクト
 * @returns {string} クエリ文字列
 */
export function buildQueryString(params) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') {
      searchParams.append(key, String(value));
    }
  }

  return searchParams.toString();
}

/**
 * 深いオブジェクトのコピー
 * @param {Object} obj - コピーするオブジェクト
 * @returns {Object} コピーされたオブジェクト
 */
export function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;

  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }

  if (obj instanceof Array) {
    return obj.map(item => deepClone(item));
  }

  if (obj instanceof Object) {
    const clonedObj = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = deepClone(obj[key]);
      }
    }
    return clonedObj;
  }
}

/**
 * オブジェクトをマージ（浅いマージ）
 * @param {Object} target - ターゲットオブジェクト
 * @param {Object} source - ソースオブジェクト
 * @returns {Object} マージされたオブジェクト
 */
export function mergeObjects(target, source) {
  return { ...target, ...source };
}

/**
 * 配列から重複を削除
 * @param {Array} array - 対象配列
 * @returns {Array} 重複削除後の配列
 */
export function removeDuplicates(array) {
  return [...new Set(array)];
}

/**
 * 配列をグループ化
 * @param {Array} array - 対象配列
 * @param {Function} keyFn - キー取得関数
 * @returns {Object} グループ化されたオブジェクト
 */
export function groupBy(array, keyFn) {
  return array.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

/**
 * デフォルト値付きのオブジェクトアクセス
 * @param {Object} obj - オブジェクト
 * @param {string} path - ドット区切りパス（例：'user.profile.name'）
 * @param {*} defaultValue - デフォルト値
 * @returns {*} 値またはデフォルト値
 */
export function getNestedValue(obj, path, defaultValue = undefined) {
  const keys = path.split('.');
  let current = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return defaultValue;
    }
    current = current[key];
  }

  return current !== undefined ? current : defaultValue;
}

/**
 * 数値をフォーマット（3桁区切り）
 * @param {number} num - 数値
 * @returns {string} フォーマットされた文字列
 */
export function formatNumber(num) {
  return Math.floor(num).toLocaleString('ja-JP');
}

/**
 * ミリ秒を人間が読みやすい時間文字列に変換
 * @param {number} ms - ミリ秒
 * @returns {string} フォーマットされた文字列
 */
export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}時間${minutes % 60}分`;
  if (minutes > 0) return `${minutes}分${seconds % 60}秒`;
  return `${seconds}秒`;
}

/**
 * テキストをクリップボードにコピー
 * @param {string} text - コピーするテキスト
 * @returns {Promise<boolean>} 成功したかどうか
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      const success = document.execCommand('copy');
      textArea.remove();
      return success;
    }
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
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

export default {
  escapeHTML,
  escapeAttribute,
  addClass,
  removeClass,
  hasClass,
  toggleClass,
  formatRelativeTime,
  debounce,
  throttle,
  safeAddEventListener,
  addMultipleEventListeners,
  observeElementVisibility,
  executeSequentially,
  executeInParallel,
  getFromLocalStorage,
  saveToLocalStorage,
  removeFromLocalStorage,
  parseQueryParams,
  buildQueryString,
  deepClone,
  mergeObjects,
  removeDuplicates,
  groupBy,
  getNestedValue,
  formatNumber,
  formatDuration,
  copyToClipboard,
  log,
  logError,
};
