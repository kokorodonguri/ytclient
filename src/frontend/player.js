/**
 * player.js
 * ビデオプレイヤーと弾幕機能を管理
 */

import {
  setPlayerHTML,
  updatePlayerVideoTitle,
  showPlayer,
  hidePlayer,
  showToast,
  showDescriptionContainer,
  hideDescriptionContainer,
  setPlaybackCleanup,
  restoreFocusToCard,
  updateSplitSelectionBanner,
} from './dom.js';
import {
  openExternalUrl,
  getYouTubeEmbedUrl,
  getYouTubeWatchUrl,
  connectLiveChat,
  fetchVideoComments,
  fetchVideoDescription,
  fetchVideoStream,
} from './api.js';
import state from './state.js';
import { escapeAttribute, escapeHTML } from './utils.js';
import { BUTTON_LABELS, MESSAGES } from './constants.js';

let activeHlsInstances = [];

/**
 * video 要素に HLS を張る（単一プレイヤーと2画面で共用）
 *
 * @param {Object} options
 * @param {HTMLVideoElement} options.videoEl
 * @param {?Element} options.statusEl
 * @param {string} options.streamUrl
 * @param {() => void} options.onFatal 致命的エラー時の代替手段
 */
function attachHlsPlayback({ videoEl, statusEl, streamUrl, onFatal }) {
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

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
      setStatus('HLS ネイティブ再生中 (高画質・ABR)');
      videoEl.play().catch((err) => console.warn('Autoplay prevented', err));
    });

    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        console.warn('Fatal HLS error, falling back', data);
        onFatal();
      }
    });
    return;
  }

  if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = streamUrl;
    videoEl.addEventListener('loadedmetadata', () => {
      setStatus('HLS ネイティブ再生中');
      videoEl.play().catch((err) => console.warn('Autoplay prevented', err));
    });
    videoEl.addEventListener('error', () => {
      console.warn('Native HLS error, falling back');
      onFatal();
    });
    return;
  }

  // hls.js もネイティブ HLS も無い環境
  onFatal();
}

/**
 * 配信中の動画について HLS の URL を解決する。取れなければ null。
 */
async function resolveStreamUrl(video) {
  if (!video?.isLive) return null;
  try {
    const stream = await fetchVideoStream(video.videoId);
    if (stream && stream.protocol === 'hls' && stream.url) {
      return stream.url;
    }
  } catch (error) {
    console.warn('HLS stream fetch failed, falling back to embed:', error);
  }
  return null;
}

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

  // プレイヤー DOM を捨てるときは高さ追従も必ず外す。ここに置けば
  // setPlayerHTML / clearPlayerContainer のどちらの経路からも確実に走るため、
  // closePlayer は player.js の 1 本だけ（以前は ui.js にも別実装があった）
  stopChromeHeightTracking();
}

setPlaybackCleanup(destroyActivePlayback);

// プレイヤーより上にある要素 (ヘッダ・フィード状態・戻る・タイトル・操作列) は
// 幅が狭いと折り返して高くなる (実測: 1280px 幅で 314px、420px 幅では 648px)。
// CSS の固定値では足りないので、実際の位置を測って --player-chrome-h に流し込む。
// 測るのは動画ボックスの「上端」だけで、ボックス自身の高さには依存しないため
// 再帰的なレイアウト変化は起きない。
const PLAYER_BOTTOM_GUTTER = 16;
let chromeResizeHandler = null;

// 戻るボタンは操作列と一緒に描き直されるため、playVideo の時点ではまだ存在しない。
// 「一覧から開いた直後の1回だけ」フォーカスを移すためのフラグ。
// 再読込や HLS/埋め込み切替の再描画でフォーカスを奪わないようにする
let pendingEntryFocus = false;

function focusPlayerEntry() {
  if (!pendingEntryFocus) return;
  pendingEntryFocus = false;
  const active = document.activeElement;
  // 描画待ちの間にユーザーが別の場所を操作していたら奪わない
  if (active && active !== document.body && active.id !== 'main-content') return;
  // 描画途中で閉じられていればボタン自体が無いので、ここは自然に何もしない
  document.getElementById('back-btn')?.focus();
}

function syncPlayerChromeHeight() {
  const wrap = document.querySelector('.player-main > .player-embed-wrap');
  if (!wrap) return;
  const topOffset = wrap.getBoundingClientRect().top + window.scrollY;
  document.documentElement.style.setProperty(
    '--player-chrome-h',
    `${Math.round(topOffset + PLAYER_BOTTOM_GUTTER)}px`,
  );
}

function startChromeHeightTracking() {
  syncPlayerChromeHeight();
  if (chromeResizeHandler) return;
  chromeResizeHandler = () => requestAnimationFrame(syncPlayerChromeHeight);
  window.addEventListener('resize', chromeResizeHandler);
}

function stopChromeHeightTracking() {
  if (!chromeResizeHandler) return;
  window.removeEventListener('resize', chromeResizeHandler);
  chromeResizeHandler = null;
  document.documentElement.style.removeProperty('--player-chrome-h');
}

async function renderPlayer(videoId, title, isLive, forceEmbed = false) {
  if (!videoId || typeof videoId !== 'string') {
    console.error('Invalid video ID');
    showToast(MESSAGES.ERROR.INVALID_VIDEO_ID);
    return;
  }

  try {
    const watchUrl = getYouTubeWatchUrl(videoId);
    const embedUrl = getYouTubeEmbedUrl(videoId);

    // ライブ配信時は HLS ストリーム解決を優先試行 (明示的に埋め込み指定された場合を除く)
    const streamUrl = forceEmbed
      ? null
      : await resolveStreamUrl({ videoId, isLive });

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
    // タイトル差し込み後に測る (タイトルの行数で上端が変わるため)
    startChromeHeightTracking();

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

    // 操作列が描画され終わったので、開いた直後なら戻るボタンへフォーカスを移す
    focusPlayerEntry();

    // ライブ配信の場合、弾幕WebSocketを接続
    if (isLive) {
      setupLiveChat(videoId);
    }

    // 背景で説明文を取得・表示（コメント欄もこの中で用意する）
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
            <button id="toggle-danmaku-btn" class="player-secondary-btn active" type="button" aria-pressed="true">
              <span class="btn-icon" aria-hidden="true">💬</span><span class="btn-label">${BUTTON_LABELS.DANMAKU_ON}</span>
            </button>`
    : '';

  const switchModeBtn = isLive
    ? `
            <button id="switch-player-mode-btn" class="player-secondary-btn" type="button">
              <span class="btn-icon" aria-hidden="true">⇄</span><span class="btn-label">${useHls ? '埋め込みに切替' : 'HLSに切替'}</span>
            </button>`
    : '';

  // チャットの接続状態。空のときは hidden にして場所を取らせない。
  const chatStatus = isLive
    ? '<span id="chat-status" class="chat-status" role="status" aria-live="polite" hidden></span>'
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
          <button id="back-btn" class="back-button" type="button">
            <span class="btn-icon" aria-hidden="true">←</span><span class="btn-label">${BUTTON_LABELS.BACK}</span>
          </button>
          <span class="player-panel-status" role="status" aria-live="polite">${statusLabel}</span>
          ${chatStatus}
          <div class="player-fallback-actions">${liveActions}${switchModeBtn}
            <button id="add-split-btn" class="player-secondary-btn" type="button">
              <span class="btn-icon" aria-hidden="true">⊞</span><span class="btn-label">2画面に追加</span>
            </button>
            <button id="reload-player-btn" class="player-secondary-btn" type="button">
              <span class="btn-icon" aria-hidden="true">↻</span><span class="btn-label">${BUTTON_LABELS.RELOAD_PLAYER}</span>
            </button>
            <button id="open-in-browser-btn" class="player-fallback-open-btn" type="button">
              <span class="btn-icon" aria-hidden="true">↗</span><span class="btn-label">${BUTTON_LABELS.OPEN_BROWSER}</span>
            </button>
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

function generateSplitPlayerHTML(entries) {
  const panels = entries
    .map(({ video, streamUrl }, index) => {
      // 配信中で HLS が取れたパネルは単一プレイヤーと同じネイティブ再生にする。
      // 以前は 2画面だけ常に埋め込みで、画質も安定性も単一プレイヤーに劣った。
      const media = streamUrl
        ? `<video
                class="native-player split-player-video"
                data-split-index="${index}"
                controls
                autoplay
                playsinline
              ></video>`
        : `<iframe
                class="split-player-iframe"
                data-split-index="${index}"
                title="${escapeAttribute(video.title || '')} - YouTubeプレイヤー"
                src="${getYouTubeEmbedUrl(video.videoId)}"
                loading="eager"
                referrerpolicy="strict-origin-when-cross-origin"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowfullscreen>
              </iframe>`;

      return `
        <section class="split-player-panel" data-split-index="${index}">
          <h3 class="split-player-title">${escapeHTML(video.title)}</h3>
          <div class="player-embed-wrap">
            <div class="player-embed-frame">
              ${media}
            </div>
          </div>
          <div class="player-status-bar split-player-status-bar">
            <span class="player-panel-status" role="status" aria-live="polite">${
              streamUrl ? 'HLS ネイティブ再生中' : 'YouTube 埋め込み...'
            }</span>
            <div class="player-fallback-actions">
              <button class="player-secondary-btn split-reload-btn" type="button" data-split-index="${index}">${BUTTON_LABELS.RELOAD_PLAYER}</button>
              <button class="player-fallback-open-btn split-open-btn" type="button" data-split-index="${index}">${BUTTON_LABELS.OPEN_BROWSER}</button>
            </div>
          </div>
        </section>
      `;
    })
    .join('');

  return `
    <div class="split-player-toolbar">
      <button id="back-btn" class="back-button" type="button">
        <span class="btn-icon" aria-hidden="true">←</span><span class="btn-label">${BUTTON_LABELS.BACK}</span>
      </button>
      <button id="exit-split-btn" class="player-secondary-btn" type="button">
        <span class="btn-icon" aria-hidden="true">⊟</span><span class="btn-label">1画面に戻す</span>
      </button>
    </div>
    <div class="split-player-grid">
      ${panels}
    </div>
  `;
}

async function renderSplitPlayer(primaryVideo, secondaryVideo) {
  if (!primaryVideo?.videoId || !secondaryVideo?.videoId) {
    showToast('2画面表示に必要な動画が不足しています。');
    return;
  }

  try {
    const videos = [primaryVideo, secondaryVideo];
    // 2 本まとめて解決する。直列だと 2 本目の表示が 1 本目の待ち時間ぶん遅れる。
    const streamUrls = await Promise.all(videos.map(resolveStreamUrl));
    const entries = videos.map((video, index) => ({
      video,
      streamUrl: streamUrls[index],
    }));

    setPlayerHTML(generateSplitPlayerHTML(entries));
    // 2画面はパネルごとに高さを持つので単一プレイヤー用の追従は止める
    stopChromeHeightTracking();
    updatePlayerVideoTitle('2画面表示');
    // 弾幕は 2 面に重ねると互いに読めなくなるため 2画面では出さない。
    // 概要欄も同じ理由でパネルごとには出さない。
    hideDescriptionContainer();
    setupSplitPlayerEventHandlers(entries);
    focusPlayerEntry();
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
    attachHlsPlayback({
      videoEl,
      statusEl,
      streamUrl,
      onFatal: () => {
        if (statusEl) statusEl.textContent = 'HLS エラーのため埋め込みに切替中...';
        renderPlayer(videoId, title, isLive, true);
      },
    });
  }

  // 埋め込み iframe のイベント
  if (iframeEl) {
    iframeEl.addEventListener('load', () => {
      if (statusEl) {
        statusEl.textContent = MESSAGES.INFO.PLAYER_LOADED;
      }
    });

    iframeEl.addEventListener('error', () => {
      if (statusEl) {
        statusEl.textContent = MESSAGES.INFO.PLAYER_RELOAD_FAILED;
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
        if (statusEl) statusEl.textContent = MESSAGES.INFO.PLAYER_RELOADING;
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
      beginSplitSelection({ videoId, title, isLive });
      closePlayer();
    });
  }
}

function setupSplitPlayerEventHandlers(entries) {
  document.querySelectorAll('.split-player-panel').forEach((panel) => {
    const index = Number(panel.dataset.splitIndex);
    const iframe = panel.querySelector('.split-player-iframe');
    const videoEl = panel.querySelector('.split-player-video');
    const statusEl = panel.querySelector('.player-panel-status');
    const reloadBtn = panel.querySelector('.split-reload-btn');
    const openBtns = panel.querySelectorAll('.split-open-btn');
    const { video, streamUrl } = entries[index];

    if (videoEl && streamUrl) {
      attachHlsPlayback({
        videoEl,
        statusEl,
        streamUrl,
        onFatal: () => {
          // このパネルだけ埋め込みへ落とす。もう一方の再生は止めない。
          if (statusEl) statusEl.textContent = 'HLS エラーのため埋め込みに切替';
          const frame = panel.querySelector('.player-embed-frame');
          if (!frame) return;
          frame.innerHTML = `<iframe
                class="split-player-iframe"
                data-split-index="${index}"
                title="${escapeAttribute(video.title || '')} - YouTubeプレイヤー"
                src="${getYouTubeEmbedUrl(video.videoId)}"
                loading="eager"
                referrerpolicy="strict-origin-when-cross-origin"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowfullscreen></iframe>`;
        },
      });
    }

    iframe?.addEventListener('load', () => {
      if (statusEl) statusEl.textContent = MESSAGES.INFO.PLAYER_LOADED;
    });

    iframe?.addEventListener('error', () => {
      if (statusEl) statusEl.textContent = MESSAGES.INFO.PLAYER_RELOAD_FAILED;
    });

    reloadBtn?.addEventListener('click', () => {
      if (statusEl) statusEl.textContent = MESSAGES.INFO.PLAYER_RELOADING;
      // HLS のパネルは URL が失効している可能性があるので解決し直す
      if (videoEl) {
        resolveStreamUrl(video).then((freshUrl) => {
          if (!freshUrl) {
            if (statusEl) statusEl.textContent = '配信が見つかりません。';
            return;
          }
          attachHlsPlayback({
            videoEl,
            statusEl,
            streamUrl: freshUrl,
            onFatal: () => {
              if (statusEl) statusEl.textContent = 'HLS の再読込に失敗しました。';
            },
          });
        });
        return;
      }
      if (iframe) iframe.src = getYouTubeEmbedUrl(video.videoId);
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
    const primaryVideo = entries[0].video;
    // playVideo を通すと showPlayer とフォーカス移動をもう一度やり直すことに
    // なる。すでにプレイヤーは開いているので、描画だけ差し替える。
    state.setCurrentPlayerVideos([primaryVideo]);
    renderPlayer(primaryVideo.videoId, primaryVideo.title, primaryVideo.isLive);
  });
}

/**
 * 弾幕トグルボタンのセットアップ
 */
function setupDanmakuToggle(toggleBtn) {
  const danmakuContainer = document.getElementById('danmaku-container');
  if (!danmakuContainer) return;

  let isDanmakuEnabled = true;

  // ラベルだけ差し替える。textContent を書き換えるとアイコンの span まで消え、
  // 狭い幅でアイコン表示にしたときに何のボタンか分からなくなる
  const label = toggleBtn.querySelector('.btn-label') || toggleBtn;

  toggleBtn.addEventListener('click', () => {
    isDanmakuEnabled = !isDanmakuEnabled;
    toggleBtn.classList.toggle('active', isDanmakuEnabled);
    label.textContent = isDanmakuEnabled
      ? BUTTON_LABELS.DANMAKU_ON
      : BUTTON_LABELS.DANMAKU_OFF;
    toggleBtn.setAttribute('aria-pressed', String(isDanmakuEnabled));
    danmakuContainer.style.display = isDanmakuEnabled ? 'block' : 'none';
  });
}

// 接続状態を利用者向けの文言にする。切断が黙って起きると、弾幕が流れない
// 理由が「配信にコメントが無い」のか「切れた」のか区別できない。
const CHAT_STATUS_LABELS = {
  connecting: 'チャット接続中…',
  open: '',
  reconnecting: 'チャット再接続中…',
  failed: 'チャットが切断されました',
};

function updateChatStatus(status, detail) {
  const element = document.getElementById('chat-status');
  if (!element) return;

  const base = CHAT_STATUS_LABELS[status] ?? '';
  const text = base && detail ? `${base}（${detail}）` : base;
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('chat-status-failed', status === 'failed');
}

/**
 * ライブチャット機能をセットアップ
 */
function setupLiveChat(videoId) {
  const danmakuContainer = document.getElementById('danmaku-container');
  if (!danmakuContainer) return;

  // 既存の接続を閉じる（再接続タイマーごと畳む）
  state.activeChatSocket?.close();

  const connection = connectLiveChat(videoId, {
    onMessage: (data) => {
      handleDanmakuMessage(data, danmakuContainer);
    },
    onStatus: (status, detail) => {
      updateChatStatus(status, detail);
      if (status === 'failed') {
        showToast(MESSAGES.ERROR.FAILED_CHAT, 'error');
      }
    },
  });

  state.activeChatSocket = connection;
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
      <p>${MESSAGES.INFO.FETCHING_DESCRIPTION}</p>
    </div>
  `;

  try {
    const description = await fetchVideoDescription(videoId);

    if (!description) {
      descContainer.innerHTML =
        `<p class="description-status">${MESSAGES.INFO.NO_DESCRIPTION}</p>`;
      return;
    }

    // 説明文コンテナを作成
    descContainer.innerHTML = `
      <h3 class="sr-only">動画概要</h3>
      <div id="video-description" class="collapsed"></div>
      <button id="toggle-description-btn" class="description-toggle-btn" type="button" aria-expanded="false" aria-controls="video-description">${BUTTON_LABELS.MORE}</button>
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
          toggleBtn.textContent = BUTTON_LABELS.LESS;
          toggleBtn.setAttribute('aria-expanded', 'true');
        } else {
          descEl.classList.add('collapsed');
          toggleBtn.textContent = BUTTON_LABELS.MORE;
          toggleBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }
  } catch (error) {
    console.error('Error fetching description:', error);
    descContainer.innerHTML =
      `<p class="description-status error">${MESSAGES.ERROR.FAILED_DESCRIPTION}</p>`;
  }

  appendCommentsSection(descContainer, videoId);
}

// 1 回目に取る件数と、「さらに読み込む」で取る件数。
// サーバーは動画ごとに最大件数を 1 回だけキャッシュして切り出すので、
// 2 回目の要求はキャッシュヒットで安い。
const COMMENTS_INITIAL_LIMIT = 20;
const COMMENTS_EXPANDED_LIMIT = 100;

/**
 * コメント欄を用意する
 *
 * 自動では取りに行かない。1 件あたり yt-dlp のフル抽出が走って数秒かかり、
 * 抽出系のレート制限（既定 20/分）も共有しているため、再生するたびに
 * 取りに行くと待たされるうえ枠を食い潰す。押されたときだけ取る。
 */
function appendCommentsSection(descContainer, videoId) {
  const section = document.createElement('section');
  section.className = 'comments-section';
  section.innerHTML = `
    <h3 class="comments-heading">コメント</h3>
    <div id="comments-body" class="comments-body" aria-live="polite"></div>
    <button id="load-comments-btn" class="description-toggle-btn" type="button">
      コメントを読み込む
    </button>
  `;
  descContainer.appendChild(section);

  const body = section.querySelector('#comments-body');
  const button = section.querySelector('#load-comments-btn');

  const load = async (limit) => {
    button.disabled = true;
    button.textContent = '読み込み中...';
    try {
      const payload = await fetchVideoComments(videoId, limit);
      const comments = Array.isArray(payload?.results) ? payload.results : [];

      if (comments.length === 0) {
        body.innerHTML =
          '<p class="description-status">コメントはありません。</p>';
        button.hidden = true;
        return;
      }

      body.innerHTML = comments.map(renderCommentHTML).join('');

      // 取れた件数が要求と同じなら、まだ続きがある可能性がある
      if (limit < COMMENTS_EXPANDED_LIMIT && comments.length >= limit) {
        button.disabled = false;
        button.textContent = 'さらに読み込む';
        button.onclick = () => load(COMMENTS_EXPANDED_LIMIT);
      } else {
        button.hidden = true;
      }
    } catch (error) {
      console.error('Error fetching comments:', error);
      body.innerHTML =
        '<p class="description-status error">コメントの読み込みに失敗しました。</p>';
      button.disabled = false;
      button.textContent = '再試行';
    }
  };

  button.onclick = () => load(COMMENTS_INITIAL_LIMIT);
}

function renderCommentHTML(comment) {
  const author = escapeHTML(comment.author || '名無し');
  const text = escapeHTML(comment.text || '');
  const thumbnail = escapeAttribute(comment.author_thumbnail || '');
  return `
    <article class="comment">
      <img class="comment-avatar" src="${thumbnail}" alt="" loading="lazy" width="32" height="32" />
      <div class="comment-body">
        <p class="comment-author">${author}</p>
        <p class="comment-text">${text}</p>
      </div>
    </article>
  `;
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
 * 2画面の 1 本目を選んだ状態に入る
 *
 * 状態とバナーを必ず一緒に動かす。片方だけ変えると「選択中なのに画面に
 * 何も出ていない」状態が作れてしまう。
 */
export function beginSplitSelection(video) {
  state.startSplitSelection(video);
  updateSplitSelectionBanner(video);
  showToast('2本目の動画を選んでください。');
}

/**
 * 2画面の選択を取り消す
 */
export function cancelSplitSelection() {
  if (!state.pendingSplitPrimary) return;
  state.clearSplitSelection();
  updateSplitSelectionBanner(null);
  showToast('2画面表示をやめました。');
}

function endSplitSelection() {
  state.clearSplitSelection();
  updateSplitSelectionBanner(null);
}

/**
 * ビデオ再生を開始
 */
export function playVideo(videoId, title, isLive) {
  if (!videoId) {
    console.error('No video ID provided');
    showToast(MESSAGES.ERROR.INVALID_VIDEO_ID);
    return;
  }

  const primaryVideo = state.pendingSplitPrimary;

  // 同じ動画を 2 枠に並べても意味が無い。以前はここで単一プレイヤーに
  // 落ちてしまい、選択が無反応のまま消えていた。選択は保持して知らせる。
  if (primaryVideo && primaryVideo.videoId === videoId) {
    showToast('2本目は別の動画を選んでください。', 'error');
    return;
  }

  // 既存の接続を閉じる（再接続タイマーごと）
  if (state.activeChatSocket) {
    state.activeChatSocket.close();
    state.activeChatSocket = null;
  }

  showPlayer();

  // グリッドが display:none になりフォーカスが body へ落ちる。戻るボタンは
  // まだ描画されていないので、いったん main を掴んでおき、描画完了後に移す
  pendingEntryFocus = true;
  document.getElementById('main-content')?.focus();

  const nextVideo = { videoId, title, isLive };

  if (primaryVideo) {
    endSplitSelection();
    state.setCurrentPlayerVideos([primaryVideo, nextVideo]);
    renderSplitPlayer(primaryVideo, nextVideo);
    return;
  }

  endSplitSelection();
  state.setCurrentPlayerVideos([nextVideo]);
  renderPlayer(videoId, title, isLive);
}

/**
 * プレイヤーを閉じる
 */
export function closePlayer() {
  // WebSocketをクローズ
  if (state.activeChatSocket) {
    state.activeChatSocket.close();
    state.activeChatSocket = null;
  }

  const lastVideoId = state.currentPlayerVideos?.[0]?.videoId || '';

  // 以前はここで DOM 操作を手書きしていたため、clearPlayerContainer() を通らず
  // 再生の後始末 (runPlaybackCleanup) を飛ばしていた。dom.js の hidePlayer に
  // 一本化してある。ui.js にもう 1 つあった closePlayer はこれに統合した。
  hidePlayer(state.currentMode);
  state.setCurrentPlayerVideos([]);

  // 再生前に選択していたカードへフォーカスを戻す
  restoreFocusToCard(lastVideoId);
}
