// Resolve a headless-capable Chrome for Testing binary and the shared quiet
// launch flags used by the background QA harness. Branded Google Chrome
// hard-blocks --load-extension; Chrome for Testing (from the puppeteer cache)
// allows it and loads the real agee service worker with no visible window.

import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Where puppeteer/playwright drop downloaded browsers.
function cacheRoots() {
  const home = homedir();
  const roots = [
    process.env.PUPPETEER_CACHE_DIR,
    join(home, ".cache", "puppeteer"),
    join(home, ".cache", "ms-playwright"),
    join(home, "Library", "Caches", "puppeteer"),
  ];
  return roots.filter(Boolean);
}

// Map a Chrome for Testing install dir to its executable for this platform.
function binaryInInstall(installDir) {
  if (platform() === "darwin") {
    for (const app of ["chrome-mac-arm64", "chrome-mac-x64"]) {
      const bin = join(installDir, app, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (existsSync(bin)) return bin;
    }
    return null;
  }
  if (platform() === "win32") {
    for (const app of ["chrome-win64", "chrome-win"]) {
      const bin = join(installDir, app, "chrome.exe");
      if (existsSync(bin)) return bin;
    }
    return null;
  }
  for (const app of ["chrome-linux64", "chrome-linux"]) {
    const bin = join(installDir, app, "chrome");
    if (existsSync(bin)) return bin;
  }
  return null;
}

// Find the newest Chrome for Testing build under any known cache root.
export function resolveChromeForTesting() {
  if (process.env.AGEE_CHROME_PATH) {
    if (!existsSync(process.env.AGEE_CHROME_PATH)) {
      throw new Error(`AGEE_CHROME_PATH is set but does not exist: ${process.env.AGEE_CHROME_PATH}`);
    }
    return process.env.AGEE_CHROME_PATH;
  }

  const builds = [];
  for (const root of cacheRoots()) {
    const chromeDir = join(root, "chrome");
    if (!existsSync(chromeDir)) continue;
    for (const entry of readdirSync(chromeDir)) {
      const bin = binaryInInstall(join(chromeDir, entry));
      if (bin) builds.push({ version: entry, bin });
    }
  }

  if (!builds.length) {
    throw new Error(
      [
        "Chrome for Testing was not found in the puppeteer/playwright cache.",
        "Branded Google Chrome hard-blocks --load-extension, so the headless",
        "QA harness needs Chrome for Testing. Install it with:",
        "  npx @puppeteer/browsers install chrome@stable",
        "or set AGEE_CHROME_PATH to a Chrome for Testing binary.",
      ].join("\n"),
    );
  }

  // Highest version string wins (e.g. mac_arm-143.0.7499.192 > mac_arm-127...).
  builds.sort((a, b) => compareVersions(b.version, a.version));
  return builds[0].bin;
}

function compareVersions(a, b) {
  const na = a.replace(/[^0-9.]/g, "").split(".").map(Number);
  const nb = b.replace(/[^0-9.]/g, "").split(".").map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i += 1) {
    const diff = (na[i] || 0) - (nb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Quiet launch flags: headless, off-screen, no focus, no prompts, no keychain.
// `extensionPath` and `profilePath` are absolute paths; both must already exist.
export function quietChromeArgs({ extensionPath, profilePath, initialUrl = "about:blank" } = {}) {
  return [
    "--headless=new",
    `--user-data-dir=${profilePath}`,
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-component-update",
    // Never prompt the macOS keychain or any password store while we run.
    "--use-mock-keychain",
    "--password-store=basic",
    "--enable-logging=stderr",
    initialUrl,
  ];
}
