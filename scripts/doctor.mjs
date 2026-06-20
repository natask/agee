// agee operational doctor.
//
// Local diagnostic for the user-visible failure mode where Chrome is still
// running an old unpacked extension/service worker. This never reads .env and
// never prints bearer tokens.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionDir = join(root, "extension");
const configPath = join(extensionDir, "agee.config.json");
const defaultGatewayUrl = "http://10.147.17.10:8788";
const staleError = "No gateway URL and no API key set";

let failures = 0;

function pass(text) {
  console.log(`[PASS] ${text}`);
}

function fail(text) {
  failures += 1;
  console.log(`[FAIL] ${text}`);
}

function warn(text) {
  console.log(`[WARN] ${text}`);
}

function info(text) {
  console.log(`[INFO] ${text}`);
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`non-JSON response ${resp.status}: ${text.slice(0, 120)}`);
    }
    return { resp, json };
  } finally {
    clearTimeout(timeout);
  }
}

function checkSource() {
  const background = readFileSync(join(extensionDir, "background.js"), "utf8");
  const config = readFileSync(join(extensionDir, "config.js"), "utf8");
  if (background.includes(staleError)) {
    fail("current background.js still contains the old Anthropic-key fallback error");
  } else {
    pass("current background.js does not contain the stale Anthropic-key fallback error");
  }
  if (config.includes(defaultGatewayUrl)) {
    pass(`current config.js has the live gateway default ${defaultGatewayUrl}`);
  } else {
    fail(`current config.js is missing the live gateway default ${defaultGatewayUrl}`);
  }
}

function checkBakedConfig() {
  if (!existsSync(configPath)) {
    fail("extension/agee.config.json is missing; run `npm run configure`");
    return null;
  }
  let config;
  try {
    config = readJson(configPath);
  } catch (error) {
    fail(`extension/agee.config.json is not valid JSON: ${error.message}`);
    return null;
  }

  const gatewayUrl = normalizeUrl(config.gatewayUrl);
  const gatewayToken = String(config.gatewayToken || "");
  if (!gatewayUrl) {
    fail("baked config has no gatewayUrl");
  } else if (gatewayUrl === "http://10.147.17.10:8787") {
    fail("baked config still points at legacy port 8787; run `npm run configure`");
  } else {
    pass(`baked config gateway URL is ${gatewayUrl}`);
  }

  if (gatewayToken) {
    pass(`baked config gateway token is set (${gatewayToken.length} chars, not shown)`);
  } else {
    fail("baked config gateway token is empty; run `npm run configure`");
  }

  return { gatewayUrl, gatewayToken };
}

async function checkGateway(config) {
  if (!config?.gatewayUrl) return;
  try {
    const { resp, json } = await fetchJson(`${config.gatewayUrl}/health`);
    if (resp.ok && json.ok) {
      pass(`/health ok: provider=${json.provider || "unknown"}, model=${json.model || "unknown"}`);
    } else {
      fail(`/health returned HTTP ${resp.status}`);
    }
  } catch (error) {
    fail(`/health unreachable: ${error.message}`);
    return;
  }

  if (!config.gatewayToken) return;
  try {
    const { resp, json } = await fetchJson(`${config.gatewayUrl}/v1/voice/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: `agee-doctor-${Date.now()}`,
        turn_id: `turn-${Date.now()}`,
        forced_action: "agent_run",
        harness: "echo",
        transcript: "agee doctor gateway-token check",
        screen_context: {
          surface: "agee-doctor",
          text: "local extension operational doctor; use deterministic echo harness",
        },
      }),
    });
    if (resp.ok) {
      const reply = String(json.display || json.text || "").replace(/\s+/g, " ").slice(0, 80);
      pass(`/v1/voice/turns accepted the baked token and replied: ${JSON.stringify(reply)}`);
    } else if (resp.status === 401) {
      fail("/v1/voice/turns rejected the baked token (401); run `npm run configure`");
    } else {
      fail(`/v1/voice/turns returned HTTP ${resp.status}`);
    }
  } catch (error) {
    fail(`/v1/voice/turns failed: ${error.message}`);
  }
}

function browserRoots() {
  const home = process.env.HOME;
  return [
    ["Google Chrome", join(home, "Library/Application Support/Google/Chrome")],
    ["Chrome Canary", join(home, "Library/Application Support/Google/Chrome Canary")],
    ["Chromium", join(home, "Library/Application Support/Chromium")],
    ["Brave", join(home, "Library/Application Support/BraveSoftware/Brave-Browser")],
    ["Microsoft Edge", join(home, "Library/Application Support/Microsoft Edge")],
    ["Arc", join(home, "Library/Application Support/Arc/User Data")],
  ];
}

function findInstalledAgee() {
  const matches = [];
  for (const [browser, base] of browserRoots()) {
    if (!existsSync(base)) continue;
    const profiles = execFileSync("find", [base, "-maxdepth", "2", "-name", "Preferences", "-print"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").filter(Boolean);

    for (const prefsPath of profiles) {
      let prefs;
      try {
        prefs = readJson(prefsPath);
      } catch {
        continue;
      }
      const profile = prefsPath.slice(base.length + 1).replace(/\/Preferences$/, "");
      const settings = prefs.extensions?.settings || {};
      for (const [id, ext] of Object.entries(settings)) {
        const manifest = ext.manifest || {};
        const name = String(manifest.name || ext.name || "");
        const description = String(manifest.description || "");
        const extPath = String(ext.path || "");
        const relevant =
          /\bagee\b/i.test(`${name} ${description}`) ||
          resolve(extPath || "/") === extensionDir ||
          /moa-assistant\/software\/browser_extension\/extension/.test(extPath);
        if (relevant) {
          matches.push({
            browser,
            profile,
            id,
            name,
            state: ext.state,
            path: extPath,
            version: manifest.version || ext.version || "",
          });
        }
      }
    }
  }
  return matches;
}

function checkBrowserProfiles() {
  const matches = findInstalledAgee();
  if (!matches.length) {
    warn("no agee extension is registered in common daily-browser profiles");
    info(`load unpacked at: ${extensionDir}`);
  } else {
    for (const match of matches) {
      const currentPath = resolve(match.path || "/") === extensionDir;
      const state = match.state === 1 ? "enabled" : `state=${match.state}`;
      const prefix = currentPath ? "PASS" : "WARN";
      console.log(
        `[${prefix}] ${match.browser}/${match.profile} has agee id=${match.id} ${state}, version=${match.version || "unknown"}, path=${match.path || "(packed)"}`
      );
      if (!currentPath) {
        warn(`that profile is not using this repo extension path: ${extensionDir}`);
      }
    }
  }

  try {
    const ps = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
    const runningWithCurrentExtension = ps
      .split("\n")
      .some((line) => line.includes("--load-extension=") && line.includes(extensionDir));
    if (runningWithCurrentExtension) {
      info("a Chrome/Chromium process is currently running with this repo extension loaded");
    }
  } catch {
    // Best-effort only.
  }
}

console.log("agee operational doctor");
console.log("");

checkSource();
const config = checkBakedConfig();
await checkGateway(config);
checkBrowserProfiles();

console.log("");
if (failures) {
  console.log(`agee doctor failed: ${failures} issue(s) need action`);
  process.exit(1);
}
console.log("agee doctor passed");
