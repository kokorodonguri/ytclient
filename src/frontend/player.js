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
} from './dom.js';
import {
  openExternalUrl,
  getYouTubeWatchUrl,
  getYouTubeEmbedUrl,
  createLiveChatWebSocket,
  closeWebSocket,
  fetchVideoDescription,
} from './api.js';
import state from './state.js';

/**
 * ビデオプレイヤーを描画
 * @param {string} videoId - YouTubeビデオID
 * @param {string} title - ビデオタイトル
 * @param {boolean} isLive - ライブ配信かどうか
 */
export async function renderPlayer(videoId, title, isLive) {
  if (!videoId || typeof videoId !== 'string') {
    console.error('Invalid video ID');
    showToast('ビデオIDが無効です。');
    return;
  }

  try {
    const embedUrl = getYouTubeEmbedUrl(videoId);
    const watchUrl = getYouTubeWatchUrl(videoId);

    // プレイヤーHTMLを生成
    const playerHTML = generatePlayerHTML(embedUrl, isLive);
    setPlayerHTML(playerHTML);
    updatePlayerVideoTitle(title);

    // プレイヤー要素の参照を取得してイベントを設定
    setupPlayerEventHandlers(videoId, title, watchUrl, embedUrl, isLive);

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
 * @param {string} embedUrl - YouTube埋め込みURL
 * @param {boolean} isLive - ライブ配信かどうか
 * @returns {string}
 */
function generatePlayerHTML(embedUrl, isLive) {
  const toggleDanmakuButton = isLive
    ? '<button id="toggle-danmaku-btn" class="player-secondary-btn active" type="button">💬 弾幕ON</button>'
    : '';

  const danmakuContainer = isLive
    ? '<div class="danmaku-container" id="danmaku-container"></div>'
    : '';

  return `
    <div class="player-layout">
      <div class="player-main">
        <div class="player-embed-wrap">
          <div class="player-embed-frame">
            <iframe
              id="youtube-player-iframe"
              src="${embedUrl}"
              loading="eager"
              referrerpolicy="strict-origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowfullscreen>
            </iframe>
          </div>
          ${danmakuContainer}
        </div>
        <div class="player-status-bar">
          <span class="player-panel-status">YouTube 埋め込み...</span>
          <div class="player-fallback-actions">
            ${toggleDanmakuButton}
            <button id="add-split-btn" class="player-secondary-btn" type="button">2画面に追加</button>
            <button id="reload-player-btn" class="player-secondary-btn" type="button">再読込</button>
            <button id="open-in-browser-btn" class="player-fallback-open-btn" type="button">ブラウザで開く</button>
          </div>
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
          <h3 class="split-player-title">${escapeHtml(video.title)}</h3>
          <div class="player-embed-wrap">
            <div class="player-embed-frame">
              <iframe
                class="split-player-iframe"
                data-split-index="${index}"
                src="${getYouTubeEmbedUrl(video.videoId)}"
                loading="eager"
                referrerpolicy="strict-origin-when-cross-origin"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowfullscreen>
              </iframe>
            </div>
          </div>
          <div class="player-status-bar split-player-status-bar">
            <span class="player-panel-status">YouTube 埋め込み...</span>
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
function setupPlayerEventHandlers(videoId, title, watchUrl, embedUrl, isLive) {
  const statusEl = document.querySelector('.player-panel-status');
  const iframeEl = document.getElementById('youtube-player-iframe');
  const reloadBtn = document.getElementById('reload-player-btn');
  const openBtn = document.getElementById('open-in-browser-btn');
  const toggleDanmakuBtn = document.getElementById('toggle-danmaku-btn');
  const addSplitBtn = document.getElementById('add-split-btn');

  // iframe読み込み完了
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
  if (reloadBtn && iframeEl) {
    reloadBtn.addEventListener('click', () => {
      iframeEl.src = embedUrl;
      if (statusEl) {
        statusEl.textContent = 'プレイヤーを再読込中...';
      }
    });
  }

  // ブラウザで開くボタン
  if (openBtn) {
    openBtn.addEventListener('click', async () => {
      try {
        await openExternalUrl(watchUrl);
      } catch (error) {
        console.error('Error opening URL:', error);
        window.open(watchUrl, '_blank', 'noopener,noreferrer');
      }
    });
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
    const openBtn = panel.querySelector('.split-open-btn');
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

    openBtn?.addEventListener('click', async () => {
      const watchUrl = getYouTubeWatchUrl(video.videoId);
      try {
        await openExternalUrl(watchUrl);
      } catch (error) {
        console.error('Error opening URL:', error);
        window.open(watchUrl, '_blank', 'noopener,noreferrer');
      }
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
    toggleBtn.textContent = isDanmakuEnabled ? '💬 弾幕ON' : '💬 弾幕OFF';
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

/**
 * 弾幕メッセージを処理して表示
 */
function handleDanmakuMessage(data, container) {
  if (!container || !data || !data.text) return;

  // 弾幕が非表示の場合はスキップ
  if (container.style.display === 'none') return;

  try {
    const msgEl = document.createElement('div');
    msgEl.className = 'danmaku-comment';
    msgEl.textContent = data.text;

    // ランダムな位置にコメントを表示
    const topPercent = Math.floor(5 + Math.random() * 80);
    msgEl.style.top = `${topPercent}%`;

    // アニメーション時間
    const duration = 5 + Math.random() * 4;
    msgEl.style.animationDuration = `${duration}s`;

    container.appendChild(msgEl);

    // アニメーション終了後に削除
    msgEl.addEventListener('animationend', () => {
      try {
        msgEl.remove();
      } catch (e) {
        console.error('Error removing danmaku:', e);
      }
    });

    // タイムアウト時の安全削除（15秒）
    setTimeout(() => {
      try {
        if (msgEl.parentElement) {
          msgEl.remove();
        }
      } catch (e) {
        console.error('Error timeout removing danmaku:', e);
      }
    }, 15000);
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
      <div id="video-description" class="collapsed"></div>
      <button id="toggle-description-btn" class="description-toggle-btn" type="button" aria-expanded="false">もっと見る</button>
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
}

export default {
  renderPlayer,
  playVideo,
  renderSplitPlayer,
  closePlayer,
  setupLiveChat,
};
