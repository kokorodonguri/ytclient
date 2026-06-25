/**
 * preload.js
 * Electron main/renderer bridge with security best practices
 * - Uses contextBridge to safely expose limited APIs
 * - Validates all inputs
 * - Implements error handling and logging
 */

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Utility function to validate URL format
 */
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}

/**
 * Utility function to validate string input
 */
function isValidString(str, minLength = 1, maxLength = 5000) {
  return (
    typeof str === "string" &&
    str.length >= minLength &&
    str.length <= maxLength
  );
}

/**
 * Utility function for safe logging
 */
function secureLog(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...(data && { data }),
  };

  // Log to console in development
  if (process.env.NODE_ENV === "development") {
    console[level.toLowerCase() || "log"](
      `[${timestamp}] ${level}: ${message}`,
      data,
    );
  }

  // Send to main process for persistent logging
  try {
    ipcRenderer.send("app:log", logEntry);
  } catch (error) {
    console.error("Failed to send log to main process:", error);
  }
}

/**
 * Exposed API object
 */
const exposedAPI = {
  /**
   * Open external URL in default browser
   * @param {string} url - URL to open
   * @returns {Promise<void>}
   */
  openExternalUrl: async (url) => {
    try {
      // Input validation
      if (!isValidString(url, 1, 2048)) {
        throw new Error("Invalid URL format or length");
      }

      if (!isValidUrl(url)) {
        throw new Error("Only http(s) URLs are allowed");
      }

      // Additional security: Check for suspicious patterns
      const suspiciousPatterns = ["javascript:", "data:", "vbscript:", "file:"];

      const lowerUrl = url.toLowerCase();
      if (suspiciousPatterns.some((pattern) => lowerUrl.startsWith(pattern))) {
        throw new Error("Suspicious URL protocol detected");
      }

      secureLog("info", "Opening external URL", { url: url.substring(0, 50) });

      // Invoke IPC to main process
      const result = await ipcRenderer.invoke("app:open-external-url", url);

      secureLog("info", "External URL opened successfully");
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      secureLog("error", "Failed to open external URL", {
        error: errorMessage,
      });
      throw new Error(`Failed to open URL: ${errorMessage}`);
    }
  },

  /**
   * Get application version
   * @returns {Promise<string>}
   */
  getAppVersion: async () => {
    try {
      const version = await ipcRenderer.invoke("app:get-version");
      if (!isValidString(version, 1, 20)) {
        throw new Error("Invalid version format");
      }
      return version;
    } catch (error) {
      secureLog("error", "Failed to get app version", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  /**
   * Get application platform
   * @returns {Promise<string>}
   */
  getPlatform: async () => {
    try {
      const platform = await ipcRenderer.invoke("app:get-platform");
      const validPlatforms = ["win32", "darwin", "linux"];
      if (!validPlatforms.includes(platform)) {
        throw new Error("Invalid platform");
      }
      return platform;
    } catch (error) {
      secureLog("error", "Failed to get platform", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  getBackendConfig: async () => {
    try {
      return await ipcRenderer.invoke("app:get-backend-config");
    } catch (error) {
      secureLog("error", "Failed to get backend config", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  setBackendConfig: async (config) => {
    try {
      if (!config || typeof config !== "object") {
        throw new Error("Invalid backend config");
      }
      if (!isValidString(config.backendUrl, 1, 2048)) {
        throw new Error("Invalid backend URL");
      }
      return await ipcRenderer.invoke("app:set-backend-config", {
        backendUrl: config.backendUrl,
        startLocalBackend: Boolean(config.startLocalBackend),
      });
    } catch (error) {
      secureLog("error", "Failed to set backend config", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  /**
   * Listen to app events
   * @param {string} channel - Event channel
   * @param {Function} listener - Event listener
   * @returns {Function} Cleanup function
   */
  onAppEvent: (channel, listener) => {
    try {
      // Whitelist allowed channels
      const allowedChannels = [
        "app:theme-changed",
        "app:online-status",
        "app:update-available",
      ];

      if (!allowedChannels.includes(channel)) {
        throw new Error(`Channel '${channel}' is not allowed`);
      }

      if (typeof listener !== "function") {
        throw new Error("Listener must be a function");
      }

      // Set up listener with argument validation
      const validatedListener = (event, ...args) => {
        try {
          listener(...args);
        } catch (error) {
          secureLog("error", "Error in app event listener", {
            channel,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      ipcRenderer.on(channel, validatedListener);

      // Return cleanup function
      return () => {
        ipcRenderer.removeListener(channel, validatedListener);
      };
    } catch (error) {
      secureLog("error", "Failed to register event listener", {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  /**
   * Safe logger for renderer process
   */
  logger: {
    info: (message, data) => {
      secureLog("info", message, data);
    },
    warn: (message, data) => {
      secureLog("warn", message, data);
    },
    error: (message, data) => {
      secureLog("error", message, data);
    },
    debug: (message, data) => {
      secureLog("debug", message, data);
    },
  },

  /**
   * Get renderer process ID (for debugging)
   */
  getProcessId: () => process.pid,

  /**
   * Check if running in development
   */
  isDevelopment: () => process.env.NODE_ENV === "development",
};

/**
 * Expose API to renderer process
 */
try {
  contextBridge.exposeInMainWorld("api", exposedAPI);
  secureLog("info", "API successfully exposed to renderer process");
} catch (error) {
  console.error(
    "Failed to expose API to renderer process:",
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Handle uncaught exceptions in preload script
 */
process.on("uncaughtException", (error) => {
  secureLog("error", "Uncaught exception in preload", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
});
