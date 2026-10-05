// 最小構成。src/frontend はビルド無しの ES モジュールで、実行環境が
// 「Electron レンダラー / ブラウザ / Capacitor WebView」の 3 つある。
// 型検査もトランスパイルも入れず、「未使用」と「未定義」だけを見る。
// 構文の妥当性とモジュールグラフの解決は scripts/check-syntax.mjs が担う。

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  console: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  AbortController: "readonly",
  WebSocket: "readonly",
  IntersectionObserver: "readonly",
  MutationObserver: "readonly",
  ResizeObserver: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  HTMLElement: "readonly",
  Node: "readonly",
  matchMedia: "readonly",
  performance: "readonly",
  crypto: "readonly",
  CSS: "readonly",
  // 同梱している hls.js (vendor/hls.light.min.js) が定義するグローバル
  Hls: "readonly",
};

const nodeGlobals = {
  require: "readonly",
  module: "writable",
  process: "readonly",
  __dirname: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  Buffer: "readonly",
  URL: "readonly",
};

const rules = {
  "no-undef": "error",
  "no-unused-vars": [
    "error",
    // 意図的に受け取って使わない引数は _ 始まりで示す
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "no-unreachable": "error",
  "no-dupe-keys": "error",
  "no-dupe-class-members": "error",
  "no-duplicate-case": "error",
  "no-self-assign": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  eqeqeq: ["error", "smart"],
};

export default [
  {
    // 生成物と同梱ライブラリは対象外
    ignores: [
      "node_modules/**",
      "dist/**",
      "build_temp/**",
      "android/**",
      "src/frontend/vendor/**",
    ],
  },
  {
    // レンダラー側。ES モジュール。
    files: ["src/frontend/**/*.js"],
    ignores: ["src/frontend/preload.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: browserGlobals,
    },
    rules,
  },
  {
    // preload は CommonJS で、electron と window の両方に触る
    files: ["src/frontend/preload.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...browserGlobals, ...nodeGlobals },
    },
    rules,
  },
  {
    // Electron メインプロセスとビルドスクリプト
    files: ["main.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules,
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...nodeGlobals, console: "readonly" },
    },
    rules,
  },
];
