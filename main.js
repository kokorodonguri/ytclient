const { app, BrowserWindow, shell, session, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const DEFAULT_BACKEND_PORT = 8010;
const DEFAULT_BACKEND_URL = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
const BACKEND_READY_TIMEOUT_MS = 15000;
const BACKEND_READY_POLL_MS = 300;
const APP_ID = "com.vspo.client";
const APP_ICON_PATH = path.join(__dirname, "assets", "icon.ico");

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let mainWindow = null;
let backendProcess = null;
let isQuitting = false;
let sessionHooksInstalled = false;
let ipcHandlersInstalled = false;
let runtimeBackendUrl = DEFAULT_BACKEND_URL;
let startLocalBackend = false;

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

function isFrontendFileUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return false;
  try {
    const parsed = new URL(rawUrl);
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
    if (!parsed.port) {
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

function isLoopbackBackendUrl(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function getBackendPort(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return DEFAULT_BACKEND_PORT;
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

  if (typeof fileConfig.startLocalBackend === "boolean") {
    startLocalBackend =
      fileConfig.startLocalBackend && isLoopbackBackendUrl(runtimeBackendUrl);
  } else {
    startLocalBackend = isLoopbackBackendUrl(runtimeBackendUrl);
  }
}

function writeBackendConfig(config) {
  const configPath = path.join(app.getPath("userData"), "backend-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

async function applyBackendConfig(rawBackendUrl, shouldStartLocalBackend) {
  const backendUrl = normalizeBackendUrl(rawBackendUrl);
  if (!backendUrl) {
    return { ok: false, error: "Invalid backend URL" };
  }

  runtimeBackendUrl = backendUrl;
  startLocalBackend =
    typeof shouldStartLocalBackend === "boolean"
      ? shouldStartLocalBackend && isLoopbackBackendUrl(backendUrl)
      : isLoopbackBackendUrl(backendUrl);

  const configPath = writeBackendConfig({
    backendUrl: runtimeBackendUrl,
    startLocalBackend,
  });

  if (!startLocalBackend) {
    stopBackendProcess();
  } else {
    startBackendProcess();
    await waitForBackendReady(5000);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(getFrontendUrl());
  }

  return {
    ok: true,
    config: {
      backendUrl: runtimeBackendUrl,
      startLocalBackend,
      configPath,
    },
  };
}

function getFrontendUrl() {
  const frontendPath = app.isPackaged
    ? path.join(process.resourcesPath, "frontend", "index.html")
    : path.join(__dirname, "src", "frontend", "index.html");
  const frontendUrl = new URL(`file:///${frontendPath.replace(/\\/g, "/")}`);
  frontendUrl.searchParams.set("apiBaseUrl", runtimeBackendUrl);
  return frontendUrl.toString();
}

function getPreloadPath() {
  return path.join(__dirname, "src", "frontend", "preload.js");
}

function getBackendLaunchConfig() {
  if (!startLocalBackend) return null;

  const backendPort = getBackendPort(runtimeBackendUrl);

  if (app.isPackaged) {
    const executablePath = path.join(process.resourcesPath, "backend.exe");
    if (fs.existsSync(executablePath)) {
      return {
        command: executablePath,
        args: [String(backendPort), "127.0.0.1"],
        cwd: process.resourcesPath,
      };
    }
    console.warn(`Packaged backend not found: ${executablePath}`);
    return null;
  }

  return {
    command: process.env.PYTHON || "python",
    args: [
      path.join(__dirname, "src", "backend", "main.py"),
      String(backendPort),
      "127.0.0.1",
    ],
    cwd: __dirname,
  };
}

function startBackendProcess() {
  if (backendProcess) return;

  const launchConfig = getBackendLaunchConfig();
  if (!launchConfig) return;

  const { command, args, cwd } = launchConfig;
  // stdio: "ignore" は本番での原因究明を不可能にするため、ログへ落とす
  const logPath = path.join(app.getPath("userData"), "backend.log");
  let stdio = "ignore";
  let logFd = null;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logFd = fs.openSync(logPath, "a");
    stdio = ["ignore", logFd, logFd];
  } catch (error) {
    console.warn("Failed to open backend log, falling back to ignore:", error);
  }

  backendProcess = spawn(command, args, { cwd, stdio, windowsHide: true });

  const closeLog = () => {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* noop */
      }
      logFd = null;
    }
  };

  backendProcess.once("error", (error) => {
    console.error("Failed to start backend:", error);
    closeLog();
    backendProcess = null;
  });

  backendProcess.once("exit", (code, signal) => {
    if (!isQuitting && code !== 0 && signal !== "SIGTERM") {
      console.warn(
        `Backend exited unexpectedly: code=${code} signal=${signal} (log: ${logPath})`,
      );
    }
    closeLog();
    backendProcess = null;
  });
}

function stopBackendProcess() {
  if (!backendProcess || backendProcess.killed) return;

  const pid = backendProcess.pid;
  // PyInstaller onefile はブートローダが実体を子プロセスで起動するため、
  // 親だけを kill するとサーバが孤児化してポートを掴み続ける。
  if (process.platform === "win32" && pid) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      console.warn("taskkill failed, falling back to kill():", error);
      backendProcess.kill();
    }
  } else {
    backendProcess.kill();
  }
  backendProcess = null;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function checkBackendReady() {
  return new Promise((resolve) => {
    const client = runtimeBackendUrl.startsWith("https:") ? https : http;
    const request = client.get(runtimeBackendUrl, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) {
          request.destroy();
          resolve(false);
        }
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const payload = JSON.parse(body);
          resolve(
            payload?.status === "success" &&
              typeof payload?.message === "string" &&
              payload.message.includes("VSPO Client API"),
          );
        } catch {
          resolve(false);
        }
      });
    });

    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });

    request.on("error", () => resolve(false));
  });
}

async function waitForBackendReady(timeoutMs = BACKEND_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkBackendReady()) return true;
    await delay(BACKEND_READY_POLL_MS);
  }
  return false;
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

  ses.webRequest.onHeadersReceived(
    {
      urls: [
        "http://127.0.0.1:8000/*",
        "http://localhost:8000/*",
        "http://127.0.0.1:8010/*",
        "http://localhost:8010/*",
        `${runtimeBackendUrl}/*`,
      ],
    },
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      responseHeaders["Cache-Control"] = ["no-store, no-cache, must-revalidate"];
      responseHeaders.Pragma = ["no-cache"];
      responseHeaders.Expires = ["0"];
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
      startLocalBackend,
      defaultBackendUrl: DEFAULT_BACKEND_URL,
    },
  }));
  ipcMain.handle("app:set-backend-config", async (_event, config) => {
    if (!config || typeof config !== "object") {
      return { ok: false, error: "Invalid config" };
    }
    return applyBackendConfig(config.backendUrl, config.startLocalBackend);
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
    if (isFrontendFileUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(getFrontendUrl()).catch(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const fallbackHtml = `<html><body style="background:#0f1720;color:#ffffff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div><h1>Backend Required</h1><p>Cannot connect to backend: ${runtimeBackendUrl}</p></div></body></html>`;
    mainWindow.loadURL(
      `data:text/html;charset=UTF-8,${encodeURIComponent(fallbackHtml)}`,
    );
  });
  return mainWindow;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // 二重起動はバックエンドのポート衝突と孤児プロセスの原因になるため即終了する
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
    startBackendProcess();
    await waitForBackendReady();
    createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  stopBackendProcess();
});

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isFrontendFileUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
