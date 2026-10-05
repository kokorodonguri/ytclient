/**
 * Global Application State Management
 * Centralizes all application state to replace scattered global variables
 *
 * 素の代入と等価なだけのセッターは置かない（呼び出し側が結局直接代入して
 * いて、片方だけ通る状態になっていた）。ここに残すのは、後始末を伴うもの
 * だけにする。
 */

const state = {
  // UI State
  currentMode: 'official', // 'official' or 'clips'
  currentSelectedChannel: 'ALL',
  currentSelectedGame: '',

  // Data State
  appData: {
    official: [],
    clips: [],
    is_building: true,
    last_updated: null,
    last_error: null,
  },

  // Connection State
  activeChatSocket: null,
  pollingTimer: null,
  currentPlayerVideos: [],
  pendingSplitPrimary: null,

  /**
   * Update the current display mode
   * @param {string} mode - 'official' or 'clips'
   */
  setMode(mode) {
    if (mode === 'official' || mode === 'clips') {
      this.currentMode = mode;
    }
  },

  /**
   * Update the selected channel filter
   * @param {string} channel - Channel name or 'ALL'
   */
  setSelectedChannel(channel) {
    this.currentSelectedChannel = channel;
  },

  /**
   * Update the selected game filter
   * @param {string} game - Game name or empty string
   */
  setSelectedGame(game) {
    this.currentSelectedGame = game || '';
  },

  /**
   * Update app data from server
   * @param {Object} data - { official: [], clips: [], is_building: boolean, last_updated?: string, last_error?: string }
   */
  setAppData(data) {
    if (data && typeof data === 'object') {
      this.appData = {
        official: Array.isArray(data.official) ? data.official : [],
        clips: Array.isArray(data.clips) ? data.clips : [],
        is_building: Boolean(data.is_building),
        last_updated: data.last_updated || null,
        last_error: data.last_error || null,
      };
    }
  },

  /**
   * Clear the polling timer
   */
  clearPollingTimer() {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  },

  setCurrentPlayerVideos(videos) {
    this.currentPlayerVideos = Array.isArray(videos) ? videos : [];
  },

  startSplitSelection(video) {
    this.pendingSplitPrimary = video || null;
  },

  clearSplitSelection() {
    this.pendingSplitPrimary = null;
  },
};

export default state;
