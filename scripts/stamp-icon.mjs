import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const exePath = path.join(rootDir, "dist", "win-unpacked", "VSPO Client.exe");
const iconPath = path.join(rootDir, "assets", "icon.ico");

if (!fs.existsSync(exePath)) {
  throw new Error(`Executable not found: ${exePath}`);
}

if (!fs.existsSync(iconPath)) {
  throw new Error(`Icon not found: ${iconPath}`);
}

const rceditPath = findRcedit();
execFileSync(rceditPath, [exePath, "--set-icon", iconPath], {
  stdio: "inherit",
});

console.log(`OK stamped icon: ${path.relative(rootDir, exePath)}`);

function findRcedit() {
  const cacheRoot = path.join(
    os.homedir(),
    "AppData",
    "Local",
    "electron-builder",
    "Cache",
    "winCodeSign",
  );

  const candidates = [];
  collectRcedit(cacheRoot, candidates);
  candidates.sort((a, b) => {
    const aTime = fs.statSync(a).mtimeMs;
    const bTime = fs.statSync(b).mtimeMs;
    return bTime - aTime;
  });

  if (candidates.length === 0) {
    throw new Error(
      `rcedit-x64.exe not found under ${cacheRoot}. Run electron-builder once to populate the cache.`,
    );
  }

  return candidates[0];
}

function collectRcedit(dir, result) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRcedit(entryPath, result);
    } else if (entry.name === "rcedit-x64.exe") {
      result.push(entryPath);
    }
  }
}
