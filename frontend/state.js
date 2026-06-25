/**
 * Global Application State Management
 * Centralizes all application state to replace scattered global variables
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
   * Set the active WebSocket for live chat
   * @param {WebSocket} socket - WebSocket connection
   */
  setActiveChatSocket(socket) {
    this.activeChatSocket = socket;
  },

  /**
   * Set the polling timer
   * @param {number} timer - Timer ID from setTimeout
   */
  setPollingTimer(timer) {
    this.pollingTimer = timer;
  },

  /**
   * Close and reset the active chat socket
   */
  closeActiveChatSocket() {
    if (this.activeChatSocket) {
      try {
        this.activeChatSocket.close();
      } catch (e) {
        console.error('Error closing chat socket:', e);
      }
      this.activeChatSocket = null;
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

  /**
   * Reset all state to initial values
   */
  reset() {
    this.currentMode = 'official';
    this.currentSelectedChannel = 'ALL';
    this.currentSelectedGame = '';
    this.appData = {
      official: [],
      clips: [],
      is_building: true,
      last_updated: null,
      last_error: null,
    };
    this.closeActiveChatSocket();
    this.clearPollingTimer();
    this.currentPlayerVideos = [];
    this.pendingSplitPrimary = null;
  },

  /**
   * Get current filter status
   * @returns {Object} { mode, channel, game, appData }
   */
  getFilterStatus() {
    return {
      mode: this.currentMode,
      channel: this.currentSelectedChannel,
      game: this.currentSelectedGame,
      appData: this.appData,
    };
  },
};

export default state;
