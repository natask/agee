// agee dev loop — quiet by default.
//
// Serves the localhost demo page, watches extension/ + fixtures/, and drives a
// headless Chrome for Testing instance that loads the real extension. When you
// edit files under extension/, the controller reloads the extension in that
// headless instance via chrome.runtime.reload() — no visible window, no focus
// steal, never the user's daily Chrome.
//
// There is intentionally no `open`/`open -a` path here. To SEE the extension,
// use the manual chrome://extensions -> Load unpacked route documented in the
// README; that is the only "I want to see it" flow.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const options = parseArgs(process.argv.slice(2));
const host = options.host || "localhost";
const port = Number(options.port || 7777);
const devUrl = `http://${host}:${port}`;
const extensionDir = join(root, "extension");

let version = Date.now();
let changedAt = new Date().toISOString();
let changeTimer = null;
const watchers = [];
let bridge = null; // headless controller state when --browser is on

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", devUrl);
  if (url.pathname === "/__agee-dev/version") {
    sendJson(res, { version, changedAt });
    return;
  }

  const pathname = url.pathname === "/" ? "/fixtures/demo.html" : url.pathname;
  const file = resolve(root, pathname.replace(/^\/+/, ""));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  let body = readFileSync(file);
  const type = contentType(file);
  if (type === "text/html") {
    body = Buffer.from(injectLiveReload(body.toString("utf8")));
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
});

server.listen(port, host, async () => {
  watchForChanges();
  printReady();
  if (options.browser) {
    try {
      await startHeadlessBridge();
    } catch (error) {
      console.error(`[agee-dev] could not start headless bridge: ${error.message || error}`);
      console.error("[agee-dev] dev server still running; load the extension manually to develop. See README.");
    }
  }
});

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function watchForChanges() {
  for (const relPath of ["extension", "fixtures"]) {
    const absPath = join(root, relPath);
    if (!existsSync(absPath)) continue;
    watchers.push(watch(absPath, { recursive: true }, (_event, fileName) => {
      const changed = fileName ? normalize(join(relPath, fileName)) : relPath;
      if (changed.includes(".DS_Store")) return;
      scheduleVersionBump(changed);
    }));
  }
}

function scheduleVersionBump(changed) {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    version = Date.now();
    changedAt = new Date().toISOString();
    console.log(`[agee-dev] changed ${changed}; version=${version}`);
    if (bridge) reloadExtension(changed);
  }, 120);
}

function injectLiveReload(html) {
  if (html.includes("__ageeDevLiveReload")) return html;
  const snippet = `<script>
(() => {
  const endpoint = ${JSON.stringify(devUrl)}.replace(/\\/$/, "") + "/__agee-dev/version";
  let version = null;
  async function poll() {
    try {
      const response = await fetch(endpoint + "?ts=" + Date.now(), { cache: "no-store" });
      const info = await response.json();
      if (version === null) version = info.version;
      else if (info.version !== version) location.reload();
    } catch {}
    setTimeout(poll, 900);
  }
  window.__ageeDevLiveReload = true;
  poll();
})();
</script>`;
  return html.includes("</body>") ? html.replace("</body>", `${snippet}</body>`) : `${html}${snippet}`;
}

// ---- Headless controller -------------------------------------------------
//
// Owns a headless Chrome for Testing instance with the real extension loaded.
// On a file change we try chrome.runtime.reload() in the background service
// worker. In headless mode an extension loaded via --load-extension goes
// dormant after that first reload and cannot be re-woken, so when the worker is
// dormant we transparently relaunch the headless instance instead. Either path
// stays off-screen and never steals focus. The extension id is derived from the
// unpacked path, so it stays stable across relaunches.

async function startHeadlessBridge() {
  bridge = await launchHeadless();
  console.log(`[agee-dev] headless Chrome for Testing running (extension id=${bridge.extensionId}); no window shown.`);
  console.log("[agee-dev] demo page open headlessly; edits under extension/ reload the extension in the background.");
  console.log("");
}

async function launchHeadless() {
  const chromePath = resolveChromeForTesting();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(root, ".gstack", "background-qa", `dev-${runId}`);
  const profilePath = join(runDir, "chrome-profile");
  mkdirSync(profilePath, { recursive: true });

  let stderr = "";
  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath: extensionDir, profilePath }), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    stderr = stderr.slice(-4000);
  });

  const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
  const workerTarget = await waitForTarget(
    devToolsPort,
    (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
  );
  if (stderr.includes("--load-extension is not allowed")) {
    throw new Error("resolved Chrome refused --load-extension; set AGEE_CHROME_PATH to a Chrome for Testing binary");
  }
  const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

  // Keep the demo page open so its content script is exercised on each cycle.
  const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
  const browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
  await browserCdp.send("Target.createTarget", { url: `${devUrl}/fixtures/demo.html` });

  return { chrome, runDir, devToolsPort, browserCdp, extensionId };
}

let reloadInFlight = Promise.resolve();
function reloadExtension(reason) {
  // Serialize reloads so rapid edits do not race a relaunch.
  reloadInFlight = reloadInFlight.then(() => doReload(reason)).catch((error) => {
    console.error(`[agee-dev] reload failed: ${error.message || error}`);
  });
  return reloadInFlight;
}

async function doReload(reason) {
  if (!bridge) return;

  const worker = await findWorker(bridge.devToolsPort);
  if (worker) {
    const workerCdp = new Cdp(worker.webSocketDebuggerUrl);
    try {
      await workerCdp.send("Runtime.enable");
      await workerCdp.send("Runtime.evaluate", { expression: "chrome.runtime.reload()" }).catch(() => {});
    } finally {
      workerCdp.close();
    }
    // If the worker survives as inspectable, the in-place reload took.
    if (await findWorker(bridge.devToolsPort, 1500)) {
      await reloadLocalhostTabs(bridge.devToolsPort);
      console.log(`[agee-dev] reloaded extension (${reason}) headlessly via chrome.runtime.reload().`);
      return;
    }
  }

  // Worker dormant (headless can't re-wake a command-line-loaded extension after
  // its first reload): relaunch the headless instance. Still no window, no focus.
  await relaunchHeadless(reason);
}

async function relaunchHeadless(reason) {
  const previous = bridge;
  bridge = null;
  if (previous) {
    previous.browserCdp?.close();
    try {
      previous.chrome.kill("SIGTERM");
    } catch {}
  }
  await delay(300);
  if (previous) {
    try {
      rmSync(previous.runDir, { recursive: true, force: true });
    } catch {}
  }
  bridge = await launchHeadless();
  console.log(`[agee-dev] reloaded extension (${reason}) by relaunching headless Chrome for Testing; no window shown.`);
}

async function reloadLocalhostTabs(devToolsPort) {
  const list = await targets(devToolsPort);
  const localhostPages = list.filter(
    (target) => target.type === "page" && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(target.url || ""),
  );
  await Promise.all(
    localhostPages.map(async (page) => {
      const cdp = new Cdp(page.webSocketDebuggerUrl);
      try {
        await cdp.send("Page.enable");
        await cdp.send("Page.reload");
      } catch {
        // ignore; tab may have been torn down by a prior reload
      } finally {
        cdp.close();
      }
    }),
  );
}

async function findWorker(devToolsPort, timeoutMs = 1500) {
  const started = Date.now();
  do {
    const list = await targets(devToolsPort);
    const worker = list.find(
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );
    if (worker) return worker;
    await delay(200);
  } while (Date.now() - started < timeoutMs);
  return null;
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.onopen = resolveReady;
      this.ws.onerror = rejectReady;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolveCall, rejectCall } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rejectCall(new Error(`${msg.error.message}: ${msg.error.data || ""}`));
      else resolveCall(msg.result);
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolveCall, rejectCall });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function targets(devToolsPort) {
  return fetch(`http://127.0.0.1:${devToolsPort}/json/list`).then((resp) => resp.json()).catch(() => []);
}

async function waitForFile(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await delay(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForTarget(devToolsPort, predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const list = await targets(devToolsPort);
    const found = list.find(predicate);
    if (found) return found;
    await delay(200);
  }
  throw new Error("timed out waiting for the extension service worker target");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function printReady() {
  console.log("");
  console.log("[agee-dev] dev server ready (quiet background mode)");
  console.log(`[agee-dev] demo page:      ${devUrl}/fixtures/demo.html`);
  console.log(`[agee-dev] extension path: ${extensionDir}`);
  if (!options.browser) {
    console.log("");
    console.log("[agee-dev] running server only (--no-browser).");
    console.log("[agee-dev] To SEE the extension, load it manually: chrome://extensions -> Load unpacked. See README.");
  }
  console.log("");
}

function sendJson(res, data) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function contentType(file) {
  return {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
  }[extname(file)] || "text/plain";
}

function shutdown() {
  for (const watcher of watchers) watcher.close();
  if (bridge) {
    bridge.browserCdp?.close();
    try {
      bridge.chrome.kill("SIGTERM");
    } catch {}
    try {
      rmSync(bridge.runDir, { recursive: true, force: true });
    } catch {}
  }
  server.close(() => process.exit(0));
}

function parseArgs(args) {
  const parsed = { host: "localhost", browser: true, port: 7777 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--host") parsed.host = args[++i] || parsed.host;
    else if (arg.startsWith("--host=")) parsed.host = arg.slice("--host=".length);
    else if (arg === "--port") parsed.port = args[++i] || parsed.port;
    else if (arg.startsWith("--port=")) parsed.port = arg.slice("--port=".length);
    else if (arg === "--no-browser" || arg === "--server-only") parsed.browser = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run dev                  quiet background loop: server + headless Chrome for Testing
  npm run dev -- --port 7777   change the localhost port
  npm run dev -- --no-browser  server only (pair with manual Load unpacked)

Serves the localhost demo, watches extension/ + fixtures/, and reloads the real
extension in a headless Chrome for Testing instance on file changes. No window
is shown and focus is never taken. To SEE the extension, load it manually via
chrome://extensions -> Load unpacked (see README).`);
}
