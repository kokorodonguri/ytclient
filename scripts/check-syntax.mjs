import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const scriptFiles = ["main.js", "src/frontend/preload.js"];
const moduleEntry = path.resolve("src/frontend/renderer.js");
const moduleCache = new Map();
const officialBackendChannels = new Set([
  "https://www.youtube.com/@Vspo77",
  "https://www.youtube.com/@VSPO-EN",
]);

let hasError = false;

function getSourceModule(file) {
  const resolved = path.resolve(file);
  if (!moduleCache.has(resolved)) {
    moduleCache.set(
      resolved,
      new vm.SourceTextModule(fs.readFileSync(resolved, "utf8"), {
        identifier: resolved,
      }),
    );
  }
  return moduleCache.get(resolved);
}

async function linkFrontendModules() {
  const entryModule = getSourceModule(moduleEntry);

  await entryModule.link((specifier, referencingModule) => {
    if (!specifier.startsWith(".")) {
      throw new Error(`Unsupported import "${specifier}"`);
    }

    const resolved = path.resolve(
      path.dirname(referencingModule.identifier),
      specifier,
    );
    return getSourceModule(resolved);
  });

  for (const file of moduleCache.keys()) {
    console.log(`OK ${path.relative(process.cwd(), file)}`);
  }
}

try {
  await linkFrontendModules();
} catch (error) {
  hasError = true;
  console.error("FAIL frontend module graph");
  console.error(error.stack || error.message);
}

for (const file of scriptFiles) {
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });
    console.log(`OK ${file}`);
  } catch (error) {
    hasError = true;
    console.error(`FAIL ${file}`);
    console.error(error.stack || error.message);
  }
}

try {
  validateChannelParity();
} catch (error) {
  hasError = true;
  console.error("FAIL channel parity");
  console.error(error.stack || error.message);
}

if (hasError) {
  process.exitCode = 1;
}

function validateChannelParity() {
  const frontendSource = fs.readFileSync("src/frontend/constants.js", "utf8");
  const backendSource = fs.readFileSync("src/backend/main.py", "utf8");
  const frontendUrls = extractUrls(frontendSource);
  const backendUrls = extractTargetChannelUrls(backendSource).filter(
    (url) => !officialBackendChannels.has(url),
  );

  const missingFrontend = backendUrls.filter((url) => !frontendUrls.has(url));
  const missingBackend = [...frontendUrls].filter((url) => !backendUrls.includes(url));

  if (missingFrontend.length > 0 || missingBackend.length > 0) {
    const details = [];
    if (missingFrontend.length > 0) {
      details.push(`Backend only: ${missingFrontend.join(", ")}`);
    }
    if (missingBackend.length > 0) {
      details.push(`Frontend only: ${missingBackend.join(", ")}`);
    }
    throw new Error(details.join("\n"));
  }

  console.log(`OK channel parity (${frontendUrls.size} members)`);
}

function extractUrls(source) {
  return new Set(
    [
      ...source.matchAll(
        /https:\/\/www\.youtube\.com\/(?:@[^'"\s,]+|channel\/[A-Za-z0-9_-]+)/g,
      ),
    ].map((match) => match[0]),
  );
}

function extractTargetChannelUrls(source) {
  const listMatch = source.match(/TARGET_CHANNELS\s*=\s*\[(?<body>[\s\S]*?)\]/);
  if (!listMatch?.groups?.body) {
    throw new Error("TARGET_CHANNELS not found in src/backend/main.py");
  }
  return [...extractUrls(listMatch.groups.body)];
}
