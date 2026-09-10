const { app, BrowserWindow, shell, session, ipcMain } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");

// gzip の効果が薄いバイナリ形式には掛けない (二重圧縮で逆にサイズが増える)
const COMPRESSIBLE_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg"]);

const DEFAULT_BACKEND_PORT = 8010;
const DEFAULT_BACKEND_URL = "https://youtube.dongurihub.com";
const APP_ID = "com.vspo.client";
const APP_ICON_PATH = path.join(__dirname, "assets", "icon.ico");

const FRONTEND_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
};

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// file:// の画面から YouTube を開くときに送る Referer
const EMBED_REFERER = "https://www.youtube.com/";


let mainWindow = null;
let sessionHooksInstalled = false;
let ipcHandlersInstalled = false;
let frontendServer = null;
let frontendServerOrigin = null;
let frontendServerStarting = null;
let runtimeBackendUrl = DEFAULT_BACKEND_URL;
let runtimeApiKey = "";

if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

function isSafeExternalUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isFrontendUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return false;
  try {
    const parsed = new URL(rawUrl);

    // ループバック配信時は、同一オリジンかつルートまたは index.html を許可
    if (frontendServerOrigin && parsed.origin === frontendServerOrigin) {
      return parsed.pathname === "/" || parsed.pathname === "/index.html";
    }

    if (parsed.protocol !== "file:") return false;
    const expected = new URL(getFrontendUrl());
    return decodeURIComponent(parsed.pathname) === decodeURIComponent(expected.pathname);
  } catch {
    return false;
  }
}

function normalizeBackendUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
  let candidate = rawUrl.trim();
  if (!candidate.includes("://")) {
    candidate = `http://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    // スキーム既定ポートで到達する公開エンドポイント (https://example.com) に
    // 8010 を付けると接続できなくなるため、既定ポートの補完は http のみに限る。
    if (!parsed.port && parsed.protocol === "http:") {
      parsed.port = String(DEFAULT_BACKEND_PORT);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function getConfigPaths() {
  const paths = [];
  if (process.env.VSPO_BACKEND_CONFIG) {
    paths.push(process.env.VSPO_BACKEND_CONFIG);
  }
  paths.push(path.join(app.getPath("userData"), "backend-config.json"));
  if (app.isPackaged) {
    paths.push(path.join(path.dirname(process.execPath), "backend-config.json"));
  } else {
    paths.push(path.join(__dirname, "backend-config.json"));
  }
  return paths;
}

function readBackendConfigFile() {
  for (const configPath of getConfigPaths()) {
    try {
      if (!fs.existsSync(configPath)) continue;
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      console.warn(`Failed to read backend config: ${configPath}`, error);
    }
  }
  return {};
}

function loadRuntimeBackendConfig() {
  const fileConfig = readBackendConfigFile();
  const configuredUrl = normalizeBackendUrl(
    process.env.VSPO_BACKEND_URL || fileConfig.backendUrl,
  );
  runtimeBackendUrl = configuredUrl || DEFAULT_BACKEND_URL;
  runtimeApiKey = String(process.env.VSPO_API_KEY || fileConfig.apiKey || "").trim();

  if (!configuredUrl) {
    console.log(`No backend config found, using ${DEFAULT_BACKEND_URL}.`);
  }
}

function writeBackendConfig(config) {
  const configPath = path.join(app.getPath("userData"), "backend-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // API キーを含むため所有者のみ読み書き可とする
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return configPath;
}

async function applyBackendConfig(rawBackendUrl, rawApiKey) {
  const backendUrl = normalizeBackendUrl(rawBackendUrl);
  if (!backendUrl) {
    return { ok: false, error: "Invalid backend URL" };
  }

  runtimeBackendUrl = backendUrl;
  runtimeApiKey = typeof rawApiKey === "string" ? rawApiKey.trim() : runtimeApiKey;

  const configPath = writeBackendConfig({
    backendUrl: runtimeBackendUrl,
    apiKey: runtimeApiKey,
  });

  // 画面は apiBaseUrl をクエリで受け取るため、URL を変えたら読み直す
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(getFrontendUrl());
  }

  return {
    ok: true,
    config: { backendUrl: runtimeBackendUrl, configPath },
  };
}

function getFrontendDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "frontend")
    : path.join(__dirname, "src", "frontend");
}

// file:// から読み込むと YouTube 埋め込みが「この動画は再生できません
// (152/153)」で止まる。オリジンも Referer も無い要求を YouTube が
// 不正な埋め込みとして弾くため。ループバックの HTTP で配ると
// http://127.0.0.1:<port> という実体のあるオリジンになり、通常の
// ブラウザと同じ扱いになる (実測で再生できることを確認済み)。
function startFrontendServer() {
  if (frontendServerOrigin) return Promise.resolve(frontendServerOrigin);
  if (frontendServerStarting) return frontendServerStarting;

  const root = getFrontendDir();

  frontendServerStarting = new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(
          new URL(request.url, "http://127.0.0.1").pathname,
        );
      } catch {
        response.writeHead(400).end();
        return;
      }

      if (pathname === "/") pathname = "/index.html";

      // 配信対象はフロントエンドのディレクトリ配下だけに閉じる
      const target = path.join(root, pathname);
      const relative = path.relative(root, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403).end();
        return;
      }

      fs.stat(target, (statError, stats) => {
        if (statError) {
          response.writeHead(404).end();
          return;
        }

        // mtime は 1 秒未満を切り捨てるため toUTCString() で秒単位に揃える
        // (If-Modified-Since はそもそも秒精度なので、これで一致判定できる)
        const lastModified = new Date(stats.mtimeMs).toUTCString();
        const headers = {
          "Content-Type": FRONTEND_MIME_TYPES[path.extname(target).toLowerCase()]
            || "application/octet-stream",
          // ループバックのみで自分自身に配るだけの静的ファイルなので、
          // 短時間キャッシュしても実害はない。must-revalidate で
          // 期限切れ後は必ず If-Modified-Since を送らせる
          "Cache-Control": "private, max-age=60, must-revalidate",
          "Last-Modified": lastModified,
        };

        if (request.headers["if-modified-since"] === lastModified) {
          response.writeHead(304, headers).end();
          return;
        }

        fs.readFile(target, (error, body) => {
          if (error) {
            response.writeHead(404).end();
            return;
          }

          const acceptEncoding = request.headers["accept-encoding"] || "";
          const canGzip =
            COMPRESSIBLE_EXTENSIONS.has(path.extname(target).toLowerCase()) &&
            /\bgzip\b/.test(acceptEncoding);

          if (!canGzip) {
            response.writeHead(200, headers);
            response.end(request.method === "HEAD" ? undefined : body);
            return;
          }

          zlib.gzip(body, (gzipError, compressed) => {
            if (gzipError) {
              response.writeHead(200, headers);
              response.end(request.method === "HEAD" ? undefined : body);
              return;
            }
            response.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
            response.end(request.method === "HEAD" ? undefined : compressed);
          });
        });
      });
    });

    server.on("error", (error) => {
      console.warn("Frontend server failed to start:", error);
      frontendServerStarting = null;
      resolve(null);
    });

    // ループバックのみ。ポートは OS に選ばせる
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      frontendServer = server;
      frontendServerOrigin = `http://127.0.0.1:${port}`;
      resolve(frontendServerOrigin);
    });
  });

  return frontendServerStarting;
}

function getFrontendUrl() {
  if (frontendServerOrigin) {
    const url = new URL(`${frontendServerOrigin}/index.html`);
    url.searchParams.set("apiBaseUrl", runtimeBackendUrl);
    return url.toString();
  }

  // 配信サーバが起動できなかったときの保険。埋め込みは動かないが、
  // 一覧と外部ブラウザでの再生は使える。
  const frontendPath = path.join(getFrontendDir(), "index.html");
  const frontendUrl = new URL(`file:///${frontendPath.replace(/\\/g, "/")}`);
  frontendUrl.searchParams.set("apiBaseUrl", runtimeBackendUrl);
  return frontendUrl.toString();
}

function getPreloadPath() {
  return path.join(__dirname, "src", "frontend", "preload.js");
}

function openExternalSafely(url) {
  if (!isSafeExternalUrl(url)) return;
  shell.openExternal(url).catch((error) => {
    console.error("Failed to open external URL:", error);
  });
}

function installSessionHooksOnce() {
  if (sessionHooksInstalled) return;
  sessionHooksInstalled = true;

  const youtubeUrls = [
    "*://*.youtube.com/*",
    "*://*.youtube-nocookie.com/*",
    "*://*.googlevideo.com/*",
    "*://*.ytimg.com/*",
    "*://*.ggpht.com/*",
  ];

  const ses = session.defaultSession;

  // このアプリはカメラ/マイクを必要としない。全画面のみ、既知オリジンに限って許可する。
  const FULLSCREEN_ALLOWED_HOSTS = /(^|\.)youtube(-nocookie)?\.com$/i;

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission !== "fullscreen") {
      callback(false);
      return;
    }
    try {
      const { hostname } = new URL(webContents.getURL());
      callback(FULLSCREEN_ALLOWED_HOSTS.test(hostname));
    } catch {
      callback(false);
    }
  });

  ses.setPermissionCheckHandler((_webContents, permission) => permission === "fullscreen");

  ses.webRequest.onBeforeSendHeaders(
    { urls: youtubeUrls },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      requestHeaders["User-Agent"] = CHROME_UA;

      // Referer が全く無い (file:// 読み込み) 要求は YouTube に不正な埋め込みと
      // みなされ「この動画は再生できません (152/153)」で止まるため、その場合だけ
      // 埋め込み元を youtube.com として補う。
      //
      // ループバック配信 (http://127.0.0.1:<port>) の Referer は書き換えない。
      // 実在するオリジンなので YouTube は通常の埋め込みとして受け付ける
      // (実測: 素のループバック Referer では再生でき、youtube.com へ
      // 書き換えると Referer とオリジンの不一致で逆に 152 で弾かれる)。
      const referer = requestHeaders.Referer || requestHeaders.referer;
      const hasUsableReferer = Boolean(referer) && !/^file:/i.test(referer);
      if (!hasUsableReferer) {
        delete requestHeaders.referer;
        requestHeaders.Referer = EMBED_REFERER;
      }

      callback({ cancel: false, requestHeaders });
    },
  );

  ses.webRequest.onHeadersReceived(
    {
      urls: [
        "*://*.youtube.com/*",
        "*://youtube.com/*",
        "*://*.youtube-nocookie.com/*",
        "*://youtube-nocookie.com/*",
      ],
    },
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      for (const key of Object.keys(responseHeaders)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === "x-frame-options") {
          delete responseHeaders[key];
          continue;
        }
        if (lowerKey === "content-security-policy") {
          const values = responseHeaders[key];
          if (Array.isArray(values)) {
            const sanitizedValues = values.filter(
              (value) => !/frame-ancestors/i.test(String(value)),
            );
            if (sanitizedValues.length > 0) {
              responseHeaders[key] = sanitizedValues;
            } else {
              delete responseHeaders[key];
            }
          } else {
            delete responseHeaders[key];
          }
        }
      }
      callback({ responseHeaders });
    },
  );

  // 配信の HLS は hls.js が XHR で取りに行く。画面は file:// なので Origin は
  // null になり、googlevideo は CORS ヘッダを返さないため既定では弾かれる。
  // 該当ホストの応答にだけ許可ヘッダを差し込む (既存値は上書きして重複を避ける)。
  ses.webRequest.onHeadersReceived(
    {
      urls: [
        "*://*.googlevideo.com/*",
        "*://manifest.googlevideo.com/*",
      ],
    },
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      for (const key of Object.keys(responseHeaders)) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "access-control-allow-origin" ||
          lowerKey === "access-control-allow-headers" ||
          lowerKey === "access-control-expose-headers"
        ) {
          delete responseHeaders[key];
        }
      }
      responseHeaders["Access-Control-Allow-Origin"] = ["*"];
      responseHeaders["Access-Control-Allow-Headers"] = ["*"];
      responseHeaders["Access-Control-Expose-Headers"] = ["*"];
      callback({ responseHeaders });
    },
  );
}

function installIpcHandlersOnce() {
  if (ipcHandlersInstalled) return;
  ipcHandlersInstalled = true;

  ipcMain.handle("app:open-external-url", async (_event, rawUrl) => {
    if (!isSafeExternalUrl(rawUrl)) return { ok: false, error: "Invalid URL" };
    try {
      await shell.openExternal(rawUrl);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:get-platform", () => process.platform);
  ipcMain.handle("app:get-backend-config", () => ({
    ok: true,
    config: {
      backendUrl: runtimeBackendUrl,
      apiKey: runtimeApiKey,
      defaultBackendUrl: DEFAULT_BACKEND_URL,
    },
  }));
  ipcMain.handle("app:set-backend-config", async (_event, config) => {
    if (!config || typeof config !== "object") {
      return { ok: false, error: "Invalid config" };
    }
    return applyBackendConfig(config.backendUrl, config.apiKey);
  });

  ipcMain.on("app:log", (_event, logEntry) => {
    if (!logEntry || typeof logEntry !== "object") return;
    const level = ["debug", "info", "warn", "error"].includes(logEntry.level)
      ? logEntry.level
      : "log";
    const message = `[renderer] ${logEntry.message || ""}`;
    if (logEntry.data) {
      console[level](message, logEntry.data);
    } else {
      console[level](message);
    }
  });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 600,
    title: "ぶいすぽっ! クライアント",
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    icon: APP_ICON_PATH,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: "no-user-gesture-required",
      preload: getPreloadPath(),
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // preload を持つウィンドウをリモートオリジンで開かせない。外部リンクは常に既定ブラウザへ。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isFrontendUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // ここが失敗するのは「画面そのものを読めなかった」場合だけで、
  // バックエンドに繋がらない場合ではない (それは画面側が扱う)。
  // 以前の文言は Backend Required で、発火条件と食い違っていた。
  mainWindow.loadURL(getFrontendUrl()).catch((error) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.error("Failed to load the app UI:", error);
    const fallbackHtml =
      `<html lang="ja"><body style="background:#0f1720;color:#ffffff;` +
      `display:flex;align-items:center;justify-content:center;height:100vh;` +
      `margin:0;font-family:system-ui,sans-serif;text-align:center;">` +
      `<div><h1>画面を読み込めませんでした</h1>` +
      `<p>アプリを再起動してください。</p></div></body></html>`;
    mainWindow.loadURL(
      `data:text/html;charset=UTF-8,${encodeURIComponent(fallbackHtml)}`,
    );
  });
  return mainWindow;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // 2 つ目のウィンドウを開かず、既存のウィンドウを前に出す
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    loadRuntimeBackendConfig();
    installSessionHooksOnce();
    installIpcHandlersOnce();
    // 画面の配信サーバはウィンドウを作る前に上げる (URL が決まらないため)
    await startFrontendServer();
    createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on("before-quit", () => {
  if (frontendServer) {
    try {
      frontendServer.close();
    } catch (error) {
      console.warn("Failed to close frontend server", error);
    }
    frontendServer = null;
  }
});

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isFrontendUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
