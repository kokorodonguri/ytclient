/**
 * player.js
 * ビデオプレイヤーと弾幕機能を管理
 */

import {
  setPlayerHTML,
  updatePlayerVideoTitle,
  showPlayer,
  showToast,
  showDescriptionContainer,
  hideDescriptionContainer,
  setPlaybackCleanup,
} from './dom.js';
import {
  openExternalUrl,
  getYouTubeEmbedUrl,
  getYouTubeWatchUrl,
  createLiveChatWebSocket,
  closeWebSocket,
  fetchVideoDescription,
  fetchVideoStream,
} from './api.js';
import state from './state.js';
import { restoreFocusToCard } from './ui.js';
import { escapeAttribute, escapeHTML } from './utils.js';

let activeHlsInstances = [];

// プレイヤーを閉じるときに HLS インスタンス、video要素、iframe を確実に停止・破棄する
function destroyActivePlayback() {
  while (activeHlsInstances.length > 0) {
    const hls = activeHlsInstances.pop();
    try {
      hls.destroy();
    } catch (error) {
      console.warn('Failed to destroy Hls instance', error);
    }
  }

  document
    .querySelectorAll('#player-container video')
    .forEach((video) => {
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (error) {
        console.warn('Failed to stop video playback', error);
      }
    });

  document
    .querySelectorAll('#player-container iframe')
    .forEach((frame) => {
      try {
        frame.src = 'about:blank';
      } catch (error) {
        console.warn('Failed to stop embedded player', error);
      }
    });
}

setPlaybackCleanup(destroyActivePlayback);

export async function renderPlayer(videoId, title, isLive, forceEmbed = false) {
  if (!videoId || typeof videoId !== 'string') {
    console.error('Invalid video ID');
    showToast('ビデオIDが無効です。');
    return;
  }

  try {
    const watchUrl = getYouTubeWatchUrl(videoId);
    const embedUrl = getYouTubeEmbedUrl(videoId);

    // ライブ配信時は HLS ストリーム解決を優先試行 (明示的に埋め込み指定された場合を除く)
    let streamUrl = null;
    if (isLive && !forceEmbed) {
      try {
        const stream = await fetchVideoStream(videoId);
        if (stream && stream.protocol === 'hls' && stream.url) {
          streamUrl = stream.url;
        }
      } catch (streamError) {
        console.warn('HLS stream fetch failed, falling back to embed:', streamError);
      }
    }

    const useHls = Boolean(streamUrl);

    // プレイヤーHTMLを生成
    const playerHTML = generatePlayerHTML({
      embedUrl,
      isLive,
      title,
      useHls,
    });
    setPlayerHTML(playerHTML);
    updatePlayerVideoTitle(title);

    // プレイヤー要素の参照を取得してイベントを設定
    setupPlayerEventHandlers({
      videoId,
      title,
      watchUrl,
      embedUrl,
      isLive,
      streamUrl,
      useHls,
    });

    // ライブ配信の場合、弾幕WebSocketを接続
    if (isLive) {
      setupLiveChat(videoId);
    }

    // 背景で説明文を取得・表示
    fetchAndDisplayDescription(videoId);
  } catch (error) {
    console.error('Error rendering player:', error);
    showToast('プレイヤーの描画に失敗しました。');
  }
}

/**
 * プレイヤーHTMLを生成
 * @param {Object} options
 * @returns {string}
 */
function generatePlayerHTML({ embedUrl, isLive, title, useHls }) {
  const liveActions = isLive
    ? `
            <button id="toggle-danmaku-btn" class="player-secondary-btn active" type="button" aria-pressed="true">弾幕 ON</button>`
    : '';

  const switchModeBtn = isLive
    ? `
            <button id="switch-player-mode-btn" class="player-secondary-btn" type="button">${useHls ? '埋め込みに切替' : 'HLSに切替'}</button>`
    : '';

  // 弾幕は流れるコメントの視覚演出であり、ATには読ませない
  const danmakuContainer = isLive
    ? '<div class="danmaku-container" id="danmaku-container" aria-hidden="true"></div>'
    : '';

  const statusLabel = useHls
    ? 'HLS ネイティブ再生中 (高画質・ABR)'
    : 'YouTube 埋め込み...';

  const mediaContent = useHls
    ? `<video
         id="hls-player-video"
         class="native-player"
         controls
         autoplay
         playsinline
       ></video>`
    : `<iframe
         id="youtube-player-iframe"
         title="${escapeAttribute(title || '')} - YouTubeプレイヤー"
         src="${embedUrl}"
         loading="eager"
         referrerpolicy="strict-origin-when-cross-origin"
         allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
         allowfullscreen>
       </iframe>`;

  return `
    <div class="player-layout">
      <div class="player-main">
        <div class="player-status-bar">
          <span class="player-panel-status" role="status" aria-live="polite">${statusLabel}</span>
          <div class="player-fallback-actions">${liveActions}${switchModeBtn}
            <button id="add-split-btn" class="player-secondary-btn" type="button">2画面に追加</button>
            <button id="reload-player-btn" class="player-secondary-btn" type="button">再読込</button>
            <button id="open-in-browser-btn" class="player-fallback-open-btn" type="button">ブラウザで開く</button>
          </div>
        </div>
        <div class="player-embed-wrap">
          <div class="player-embed-frame">
            ${mediaContent}
          </div>
          ${danmakuContainer}
        </div>
      </div>
    </div>
  `;
}

function generateSplitPlayerHTML(primaryVideo, secondaryVideo) {
  const panels = [primaryVideo, secondaryVideo]
    .map(
      (video, index) => `
        <section class="split-player-panel" data-split-index="${index}">
          <h3 class="split-player-title">${escapeHTML(video.title)}</h3>
          <div class="player-embed-wrap">
            <div class="player-embed-frame">
              <iframe
                class="split-player-iframe"
                data-split-index="${index}"
                title="${escapeAttribute(video.title || '')} - YouTubeプレイヤー"
                src="${getYouTubeEmbedUrl(video.videoId)}"
                loading="eager"
                referrerpolicy="strict-origin-when-cross-origin"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowfullscreen>
              </iframe>
            </div>
          </div>
          <div class="player-status-bar split-player-status-bar">
            <span class="player-panel-status" role="status" aria-live="polite">YouTube 埋め込み...</span>
            <div class="player-fallback-actions">
              <button class="player-secondary-btn split-reload-btn" type="button" data-split-index="${index}">再読込</button>
              <button class="player-fallback-open-btn split-open-btn" type="button" data-split-index="${index}">ブラウザで開く</button>
            </div>
          </div>
        </section>
      `,
    )
    .join('');

  return `
    <div class="split-player-toolbar">
      <button id="exit-split-btn" class="player-secondary-btn" type="button">1画面に戻す</button>
    </div>
    <div class="split-player-grid">
      ${panels}
    </div>
  `;
}

export async function renderSplitPlayer(primaryVideo, secondaryVideo) {
  if (!primaryVideo?.videoId || !secondaryVideo?.videoId) {
    showToast('2画面表示に必要な動画が不足しています。');
    return;
  }

  try {
    setPlayerHTML(generateSplitPlayerHTML(primaryVideo, secondaryVideo));
    updatePlayerVideoTitle('2画面表示');
    hideDescriptionContainer();
    setupSplitPlayerEventHandlers([primaryVideo, secondaryVideo]);
  } catch (error) {
    console.error('Error rendering split player:', error);
    showToast('2画面表示の描画に失敗しました。');
  }
}

/**
 * プレイヤーのイベントハンドラーを設定
 */
function setupPlayerEventHandlers({ videoId, title, watchUrl, embedUrl, isLive, streamUrl, useHls }) {
  const statusEl = document.querySelector('.player-panel-status');
  const iframeEl = document.getElementById('youtube-player-iframe');
  const videoEl = document.getElementById('hls-player-video');
  const reloadBtn = document.getElementById('reload-player-btn');
  const openBtn = document.getElementById('open-in-browser-btn');
  const toggleDanmakuBtn = document.getElementById('toggle-danmaku-btn');
  const switchModeBtn = document.getElementById('switch-player-mode-btn');
  const addSplitBtn = document.getElementById('add-split-btn');

  const openInBrowser = async () => {
    try {
      await openExternalUrl(watchUrl);
    } catch (error) {
      console.error('Error opening URL:', error);
      window.open(watchUrl, '_blank', 'noopener,noreferrer');
    }
  };

  // HLS再生の初期化
  if (useHls && videoEl && streamUrl) {
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
      });
      activeHlsInstances.push(hls);
      hls.loadSource(streamUrl);
      hls.attachMedia(videoEl);

      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (statusEl) statusEl.textContent = 'HLS ネイティブ再生中 (高画質・ABR)';
        videoEl.play().catch((err) => console.warn('Autoplay prevented', err));
      });

      hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.warn('Fatal HLS error, falling back to iframe', data);
          if (statusEl) statusEl.textContent = 'HLS エラーのため埋め込みに切替中...';
          renderPlayer(videoId, title, isLive, true);
        }
      });
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = streamUrl;
      videoEl.addEventListener('loadedmetadata', () => {
        if (statusEl) statusEl.textContent = 'HLS ネイティブ再生中';
        videoEl.play().catch((err) => console.warn('Autoplay prevented', err));
      });
      videoEl.addEventListener('error', () => {
        console.warn('Native HLS error, falling back to iframe');
        renderPlayer(videoId, title, isLive, true);
      });
    }
  }

  // 埋め込み iframe のイベント
  if (iframeEl) {
    iframeEl.addEventListener('load', () => {
      if (statusEl) {
        statusEl.textContent = '埋め込みプレイヤーを表示しました。';
      }
    });

    iframeEl.addEventListener('error', () => {
      if (statusEl) {
        statusEl.textContent = 'プレイヤーの読み込みに失敗しました。';
      }
    });
  }

  // リロードボタン
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      if (useHls) {
        renderPlayer(videoId, title, isLive, false);
      } else if (iframeEl) {
        iframeEl.src = embedUrl;
        if (statusEl) statusEl.textContent = 'プレイヤーを再読込中...';
      }
    });
  }

  // 再生モード切替ボタン (HLS ↔ 埋め込み)
  if (switchModeBtn) {
    switchModeBtn.addEventListener('click', () => {
      renderPlayer(videoId, title, isLive, useHls);
    });
  }

  // ブラウザで開くボタン
  if (openBtn) {
    openBtn.addEventListener('click', openInBrowser);
  }

  // 弾幕トグルボタン
  if (toggleDanmakuBtn && isLive) {
    setupDanmakuToggle(toggleDanmakuBtn);
  }

  if (addSplitBtn) {
    addSplitBtn.addEventListener('click', () => {
      state.startSplitSelection({ videoId, title, isLive });
      closePlayer();
      showToast('2本目の動画を選んでください。');
    });
  }
}

function setupSplitPlayerEventHandlers(videos) {
  document.querySelectorAll('.split-player-panel').forEach((panel) => {
    const index = Number(panel.dataset.splitIndex);
    const iframe = panel.querySelector('.split-player-iframe');
    const statusEl = panel.querySelector('.player-panel-status');
    const reloadBtn = panel.querySelector('.split-reload-btn');
    const openBtns = panel.querySelectorAll('.split-open-btn');
    const video = videos[index];

    iframe?.addEventListener('load', () => {
      if (statusEl) statusEl.textContent = '埋め込みプレイヤーを表示しました。';
    });

    iframe?.addEventListener('error', () => {
      if (statusEl) statusEl.textContent = 'プレイヤーの読み込みに失敗しました。';
    });

    reloadBtn?.addEventListener('click', () => {
      if (!iframe) return;
      iframe.src = getYouTubeEmbedUrl(video.videoId);
      if (statusEl) statusEl.textContent = 'プレイヤーを再読込中...';
    });

    openBtns.forEach((openBtn) => {
      openBtn.addEventListener('click', async () => {
        const watchUrl = getYouTubeWatchUrl(video.videoId);
        try {
          await openExternalUrl(watchUrl);
        } catch (error) {
          console.error('Error opening URL:', error);
          window.open(watchUrl, '_blank', 'noopener,noreferrer');
        }
      });
    });
  });

  document.getElementById('exit-split-btn')?.addEventListener('click', () => {
    const [primaryVideo] = videos;
    playVideo(primaryVideo.videoId, primaryVideo.title, primaryVideo.isLive);
  });
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.innerText = value || '';
  return div.innerHTML;
}

/**
 * 弾幕トグルボタンのセットアップ
 */
function setupDanmakuToggle(toggleBtn) {
  const danmakuContainer = document.getElementById('danmaku-container');
  if (!danmakuContainer) return;

  let isDanmakuEnabled = true;

  toggleBtn.addEventListener('click', () => {
    isDanmakuEnabled = !isDanmakuEnabled;
    toggleBtn.classList.toggle('active', isDanmakuEnabled);
    toggleBtn.textContent = isDanmakuEnabled ? '弾幕 ON' : '弾幕 OFF';
    toggleBtn.setAttribute('aria-pressed', String(isDanmakuEnabled));
    danmakuContainer.style.display = isDanmakuEnabled ? 'block' : 'none';
  });
}

/**
 * ライブチャット機能をセットアップ
 */
function setupLiveChat(videoId) {
  const danmakuContainer = document.getElementById('danmaku-container');
  if (!danmakuContainer) return;

  // 既存のWebSocketをクローズ
  if (state.activeChatSocket) {
    closeWebSocket(state.activeChatSocket);
  }

  // 新しいWebSocketを作成
  let socket;
  socket = createLiveChatWebSocket(videoId, {
    onMessage: (data) => {
      handleDanmakuMessage(data, danmakuContainer);
    },
    onError: (error) => {
      console.error('Live chat error:', error);
      showToast('弾幕サーバーへの接続に失敗しました。');
    },
    onClose: () => {
      if (state.activeChatSocket === socket) {
        state.activeChatSocket = null;
      }
    },
  });

  if (socket) {
    state.activeChatSocket = socket;
  }
}

const DANMAKU_MAX_ON_SCREEN = 40;
const DANMAKU_MIN_INTERVAL_MS = 80;
const DANMAKU_MAX_TEXT_LENGTH = 120;
let lastDanmakuAt = 0;

// 高流量の配信では毎秒何十通も流れる。1 通ごとに MediaQueryList を
// 作り直さないよう、一度だけ作って使い回す
const reducedMotionQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

/**
 * 弾幕メッセージを処理して表示
 * 高流量配信でDOMが飽和しないよう、同時表示数と流入間隔を制限する
 */
function handleDanmakuMessage(data, container) {
  if (!container || !data || typeof data.text !== 'string' || !data.text) return;

  // 弾幕が非表示の場合はスキップ
  if (container.style.display === 'none') return;

  // 動きの抑制設定時は流れるコメントを出さない
  if (reducedMotionQuery?.matches) return;

  const now = Date.now();
  if (now - lastDanmakuAt < DANMAKU_MIN_INTERVAL_MS) return;
  lastDanmakuAt = now;

  try {
    // 上限超過分は最古のノードから破棄する
    while (container.childElementCount >= DANMAKU_MAX_ON_SCREEN) {
      container.firstElementChild?.remove();
    }

    const msgEl = document.createElement('div');
    msgEl.className = 'danmaku-comment';
    msgEl.textContent = data.text.slice(0, DANMAKU_MAX_TEXT_LENGTH);

    // ランダムな位置にコメントを表示
    const topPercent = Math.floor(5 + Math.random() * 80);
    msgEl.style.top = `${topPercent}%`;

    // アニメーション時間
    const duration = 5 + Math.random() * 4;
    msgEl.style.animationDuration = `${duration}s`;

    // アニメーション終了・タイムアウトのいずれか早い方で確実に破棄する
    const removeTimer = setTimeout(() => msgEl.remove(), (duration + 2) * 1000);
    msgEl.addEventListener('animationend', () => {
      clearTimeout(removeTimer);
      msgEl.remove();
    });

    container.appendChild(msgEl);
  } catch (error) {
    console.error('Error handling danmaku message:', error);
  }
}

/**
 * 説明文を取得して表示
 */
async function fetchAndDisplayDescription(videoId) {
  const descContainer = document.getElementById('description-container');
  if (!descContainer) return;

  showDescriptionContainer();
  descContainer.innerHTML = `
    <div class="description-status">
      <div class="spinner"></div>
      <p>概要欄を読み込み中...</p>
    </div>
  `;

  try {
    const description = await fetchVideoDescription(videoId);

    if (!description) {
      descContainer.innerHTML =
        '<p class="description-status">概要欄は提供されていません。</p>';
      return;
    }

    // 説明文コンテナを作成
    descContainer.innerHTML = `
      <h3 class="sr-only">動画概要</h3>
      <div id="video-description" class="collapsed"></div>
      <button id="toggle-description-btn" class="description-toggle-btn" type="button" aria-expanded="false" aria-controls="video-description">もっと見る</button>
    `;

    const descEl = document.getElementById('video-description');
    const toggleBtn = document.getElementById('toggle-description-btn');

    // URLをリンク化して説明文を追加
    appendLinkedText(descEl, description);

    // 折りたたみボタンのイベント
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const isCollapsed = descEl.classList.contains('collapsed');
        if (isCollapsed) {
          descEl.classList.remove('collapsed');
          toggleBtn.textContent = '一部を表示';
          toggleBtn.setAttribute('aria-expanded', 'true');
        } else {
          descEl.classList.add('collapsed');
          toggleBtn.textContent = 'もっと見る';
          toggleBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }
  } catch (error) {
    console.error('Error fetching description:', error);
    descContainer.innerHTML =
      '<p class="description-status error">概要欄の読み込みに失敗しました。</p>';
  }
}

/**
 * URLをクリック可能なリンクに変換して要素に追加
 */
function appendLinkedText(target, text) {
  if (!target || !text) return;

  const urlRegex = /https?:\/\/[^\s]+/g;
  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0];
    const start = match.index;

    // リンク前のテキストを追加
    if (start > lastIndex) {
      target.appendChild(
        document.createTextNode(text.slice(lastIndex, start))
      );
    }

    // リンク要素を作成
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.textContent = url;
    link.rel = 'noopener noreferrer';

    // リンククリック時の処理
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await openExternalUrl(url);
      } catch (error) {
        console.error('Error opening URL:', error);
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });

    target.appendChild(link);
    lastIndex = start + url.length;
  }

  // 残りのテキストを追加
  if (lastIndex < text.length) {
    target.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

/**
 * ビデオ再生を開始
 */
export function playVideo(videoId, title, isLive) {
  if (!videoId) {
    console.error('No video ID provided');
    showToast('ビデオIDが指定されていません。');
    return;
  }

  // 既存のWebSocketをクローズ
  if (state.activeChatSocket) {
    closeWebSocket(state.activeChatSocket);
    state.activeChatSocket = null;
  }

  showPlayer();

  // グリッドが非表示になりフォーカスが落ちるため、プレイヤー先頭の戻るボタンへ移す
  document.getElementById('back-btn')?.focus();

  const nextVideo = { videoId, title, isLive };
  const primaryVideo = state.pendingSplitPrimary;

  if (primaryVideo && primaryVideo.videoId !== videoId) {
    state.clearSplitSelection();
    state.setCurrentPlayerVideos([primaryVideo, nextVideo]);
    renderSplitPlayer(primaryVideo, nextVideo);
    return;
  }

  state.clearSplitSelection();
  state.setCurrentPlayerVideos([nextVideo]);
  renderPlayer(videoId, title, isLive);
}

/**
 * プレイヤーを閉じる
 */
export function closePlayer() {
  // WebSocketをクローズ
  if (state.activeChatSocket) {
    closeWebSocket(state.activeChatSocket);
    state.activeChatSocket = null;
  }

  const lastVideoId = state.currentPlayerVideos?.[0]?.videoId || '';

  // UIをリセット
  const playerView = document.getElementById('player-view');
  const officialContainer = document.getElementById('official-container');
  const clipsContainer = document.getElementById('clips-container');
  const playerContainer = document.getElementById('player-container');

  if (playerView) playerView.classList.add('hidden');

  if (state.currentMode === 'official' && officialContainer) {
    officialContainer.classList.remove('hidden');
  } else if (clipsContainer) {
    clipsContainer.classList.remove('hidden');
  }

  if (playerContainer) {
    playerContainer.innerHTML = '';
  }

  hideDescriptionContainer();
  state.setCurrentPlayerVideos([]);

  // 再生前に選択していたカードへフォーカスを戻す
  restoreFocusToCard(lastVideoId);
}

export default {
  renderPlayer,
  playVideo,
  renderSplitPlayer,
  closePlayer,
  setupLiveChat,
};
