
/**
 * constants.js
 * アプリケーション全体で使用される定数を一元管理
 * 設定値、API定数、ゲーム定義などをここで定義
 */

/* ========================================
   🌐 API設定
   ======================================== */
const DEFAULT_API_BASE_URL = 'http://192.168.1.33:8010';

function normalizeApiBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function getRuntimeApiBaseUrl() {
  const configuredUrl = normalizeApiBaseUrl(
    new URLSearchParams(globalThis.location?.search || '').get('apiBaseUrl'),
  );
  if (configuredUrl) {
    return configuredUrl;
  }

  const origin = globalThis.location?.origin;
  const isLocalWebViewOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin || '');
  if (isLocalWebViewOrigin) {
    return DEFAULT_API_BASE_URL;
  }

  if (origin && origin !== 'null' && /^https?:\/\//.test(origin)) {
    return origin;
  }
  return DEFAULT_API_BASE_URL;
}

export const API_CONFIG = {
  BASE_URL: getRuntimeApiBaseUrl(),
  TIMEOUT: 15000, // 15 seconds
  ENDPOINTS: {
    HEALTH: '/api/v1/health',
    FEED: '/api/v1/feed',
    COMMENTS: (videoId) => `/api/v1/videos/${encodeURIComponent(videoId)}/comments`,
    LIVE_CHAT: (videoId) => `/api/v1/ws/live-chat/${encodeURIComponent(videoId)}`,
  },
};

/* ========================================
   📺 チャンネル設定
   ======================================== */
export const CHANNELS = {
  ALL: {
    value: 'ALL',
    label: '全メンバー',
  },
  MEMBERS: [
    { name: '花芽すみれ', url: 'https://www.youtube.com/@KagaSumire' },
    { name: '花芽なずな', url: 'https://www.youtube.com/@nazunakaga' },
    { name: '小雀とと', url: 'https://www.youtube.com/@totokogara' },
    { name: '一ノ瀬うるは', url: 'https://www.youtube.com/@uruhaichinose' },
    { name: '胡桃のあ', url: 'https://www.youtube.com/@963Noah' },
    { name: '橘ひなの', url: 'https://www.youtube.com/@hinanotachiba7' },
    { name: '如月れん', url: 'https://www.youtube.com/@ren_kisaragi__' },
    { name: '兎咲ミミ', url: 'https://www.youtube.com/@tosakimimi3369' },
    { name: '空澄セナ', url: 'https://www.youtube.com/@asumi_sena' },
    { name: '英リサ', url: 'https://www.youtube.com/@lisahanabusa' },
    { name: '神成きゅぴ', url: 'https://www.youtube.com/@KaminariQpi' },
    { name: '八雲べに', url: 'https://www.youtube.com/channel/UCjXBuHmWkieBApgBhDuJMMQ' },
    { name: '藍沢エマ', url: 'https://www.youtube.com/@AizawaEma' },
    { name: '紫宮るな', url: 'https://www.youtube.com/@shinomiyaruna' },
    { name: '猫汰つな', url: 'https://www.youtube.com/@tsuna_nekota' },
    { name: '白波らむね', url: 'https://www.youtube.com/@shiranamiramune' },
    { name: '小森めと', url: 'https://www.youtube.com/@Met_Komori' },
    { name: '夢野あかり', url: 'https://www.youtube.com/@akarindao' },
    { name: '夜乃くろむ', url: 'https://www.youtube.com/@YanoKuromu' },
    { name: '紡木こかげ', url: 'https://www.youtube.com/@Kokage_Tsumugi' },
    { name: '千燈ゆうひ', url: 'https://www.youtube.com/@SendoYuuhi' },
    { name: '蝶屋はなび', url: 'https://www.youtube.com/@HanabiChoya' },
    { name: '甘結もか', url: 'https://www.youtube.com/@Moka_Amayui' },
    { name: '銀城サイネ', url: 'https://www.youtube.com/@Saine_Ginjo' },
    { name: '龍巻ちせ', url: 'https://www.youtube.com/@Chise_Tatsumaki' },
    { name: 'Remia Aotsuki', url: 'https://www.youtube.com/@RemiaAotsuki' },
    { name: 'Arya Kuroha', url: 'https://www.youtube.com/@AryaKuroha' },
    { name: 'Jira Jisaki', url: 'https://www.youtube.com/@jirajisaki' },
    { name: 'Narin Mikure', url: 'https://www.youtube.com/@narinmikure' },
    { name: 'Riko Solari', url: 'https://www.youtube.com/@rikosolari' },
    { name: 'Eris Suzukami', url: 'https://www.youtube.com/@erissuzukami' },
    { name: 'Juno Umezono', url: 'https://www.youtube.com/@JunoUmezono' },
  ],
};

/* ========================================
   🎮 ゲームフィルター設定
   ======================================== */
export const GAME_FILTERS = [
  { value: '', label: 'すべてのゲーム' },
  { value: 'Apex', label: 'Apex Legends' },
  { value: 'Valorant', label: 'VALORANT' },
  { value: 'スプラ', label: 'Splatoon / スプラ' },
  { value: 'Minecraft', label: 'Minecraft / マイクラ' },
  { value: '歌枠', label: '歌枠 / 歌ってみた' },
  { value: '雑談', label: '雑談' },
];

/* ========================================
   🎬 ビデオモード設定
   ======================================== */
export const VIDEO_MODES = {
  OFFICIAL: 'official',
  CLIPS: 'clips',
};

export const MODES = VIDEO_MODES;

/* ========================================
   🎨 UI定数
   ======================================== */
export const UI_CONSTANTS = {
  SIDEBAR_WIDTH: 260,
  HEADER_HEIGHT: 72,
  GRID_GAP: 16,
  TOAST_DURATION: 5000,
  SIDEBAR_ANIMATION_DURATION: 300,
};

/* ========================================
   ⏱️ アニメーション・タイミング
   ======================================== */
export const TIMING = {
  ANIMATION_FAST: 150,
  ANIMATION_BASE: 200,
  ANIMATION_SLOW: 300,
  POLLING_INTERVAL: 5000, // 5 seconds
  DEBOUNCE_SEARCH: 300,
  DANMAKU_DURATION: 5000, // 5 seconds
  DANMAKU_TIMEOUT: 15000, // 15 seconds
};

/* ========================================
   🔔 メッセージテンプレート
   ======================================== */
export const MESSAGES = {
  ERROR: {
    NETWORK: 'ネットワークエラー: サーバーに接続できません',
    TIMEOUT: 'リクエストがタイムアウトしました',
    INVALID_VIDEO_ID: 'ビデオIDが無効です',
    FAILED_RENDER: 'グリッドの表示に失敗しました',
    FAILED_PLAYBACK: 'ビデオの再生に失敗しました',
    FAILED_DESCRIPTION: '概要欄の読み込みに失敗しました',
    FAILED_CHAT: '弾幕サーバーへの接続に失敗しました',
    INITIALIZATION_FAILED: 'アプリケーションの初期化に失敗しました',
  },
  SUCCESS: {
    COPIED: 'クリップボードにコピーしました',
  },
  INFO: {
    LOADING: '読み込み中...',
    BUILDING: 'サーバーで最新データを構築中です...',
    BUILDING_BACKGROUND: '最新データを取得中です。表示中の結果は順次更新されます。',
    BUILDING_DETAIL: '（初回起動時は少し時間がかかります）',
    FETCHING_DESCRIPTION: '概要欄を読み込み中...',
    NO_DESCRIPTION: '概要欄は提供されていません。',
    NO_VIDEOS: '動画が見つかりませんでした。',
    INVALID_DATA: 'データが不正な形式です。',
    PLAYER_LOADING: 'YouTube 埋め込み...',
    PLAYER_LOADED: '埋め込みプレイヤーを表示しました。',
    PLAYER_RELOAD_FAILED: 'プレイヤーの読み込みに失敗しました。',
    PLAYER_RELOADING: 'プレイヤーを再読込中...',
  },
};

/* ========================================
   🏷️ UIボタンラベル
   ======================================== */
export const BUTTON_LABELS = {
  REFRESH: '最新を読み込む',
  LOADING: '更新中...',
  BACK: '一覧に戻る',
  MORE: 'もっと見る',
  LESS: '一部を表示',
  DANMAKU_ON: '💬 弾幕ON',
  DANMAKU_OFF: '💬 弾幕OFF',
  RELOAD_PLAYER: '再読込',
  OPEN_BROWSER: 'ブラウザで開く',
  CLOSE: '閉じる',
  CANCEL: 'キャンセル',
  SAVE: '保存',
  DELETE: '削除',
};

export default {
  API_CONFIG,
  CHANNELS,
  GAME_FILTERS,
  VIDEO_MODES,
  MODES,
  UI_CONSTANTS,
  TIMING,
  MESSAGES,
  BUTTON_LABELS,
};
