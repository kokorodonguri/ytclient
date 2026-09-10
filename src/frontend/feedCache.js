/**
 * feedCache.js
 * 最後に成功したフィードを端末側に保持する。
 *
 * サーバー集約により、バックエンドが落ちるとアプリは何も表示できなくなった。
 * クライアントはこれまでキャッシュを一切持たず (state.appData はメモリのみ)、
 * オフライン起動ではエラーと空グリッドのまま固まっていた。
 * サーバー側は VSPO_FEED_CACHE_PATH で同じことをしているので、
 * クライアント側にも同じ耐性を持たせる。
 */

import { FEED_CACHE_STORAGE_KEY } from "./constants.js";
import { log, logError } from "./utils.js";

const MODULE = "FeedCache";

// 保存形式を変えたら上げる。古い形式は黙って捨てる。
const CACHE_VERSION = 1;

// 取り出したキャッシュをそのまま表示していい上限。これを超えて古いものは
// 「サーバーが長期間落ちている」状態なので、出しても誤解を招くだけ。
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 保存済みフィードを読む
 * @returns {{official: Array, clips: Array, savedAt: number}|null}
 */
export function readCachedFeed() {
  let raw;
  try {
    raw = localStorage.getItem(FEED_CACHE_STORAGE_KEY);
  } catch (error) {
    // プライベートウィンドウや保存無効の環境では読み取り自体が投げる
    logError(MODULE, "localStorage is unavailable", error);
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CACHE_VERSION) return null;
    if (!Array.isArray(parsed.official) || !Array.isArray(parsed.clips)) {
      return null;
    }
    if (!parsed.official.length && !parsed.clips.length) return null;

    const savedAt = Number(parsed.savedAt) || 0;
    if (!savedAt || Date.now() - savedAt > MAX_AGE_MS) {
      log(MODULE, "Cached feed is too old to show");
      return null;
    }

    log(
      MODULE,
      `Loaded cached feed: ${parsed.official.length} official, ${parsed.clips.length} clips`,
    );
    return {
      official: parsed.official,
      clips: parsed.clips,
      last_updated: parsed.last_updated || null,
      savedAt,
    };
  } catch (error) {
    logError(MODULE, "Ignoring unreadable cached feed", error);
    return null;
  }
}

function write(payload) {
  localStorage.setItem(FEED_CACHE_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * 成功したフィードを保存する
 *
 * フィードは 1MB を超えることがあり、localStorage の割り当てを超えると
 * setItem が投げる。その場合は切り抜きを落として本編だけでも残す
 * (メンバーの配信一覧のほうが起動直後の価値が高い)。
 *
 * @param {{official: Array, clips: Array, last_updated: ?string}} feedData
 * @returns {boolean} 保存できたか
 */
export function writeCachedFeed(feedData) {
  const base = {
    version: CACHE_VERSION,
    savedAt: Date.now(),
    last_updated: feedData.last_updated || null,
  };

  try {
    write({
      ...base,
      official: feedData.official || [],
      clips: feedData.clips || [],
    });
    return true;
  } catch (error) {
    logError(MODULE, "Feed cache did not fit, retrying without clips", error);
  }

  try {
    write({ ...base, official: feedData.official || [], clips: [] });
    return true;
  } catch (error) {
    logError(MODULE, "Giving up on caching the feed", error);
    return false;
  }
}

/**
 * 保存済みフィードを消す
 */
export function clearCachedFeed() {
  try {
    localStorage.removeItem(FEED_CACHE_STORAGE_KEY);
  } catch (error) {
    logError(MODULE, "Failed to clear the cached feed", error);
  }
}
