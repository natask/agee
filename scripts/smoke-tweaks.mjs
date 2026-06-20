// Quiet headless smoke for the Tweaks capability on the REAL extension.
//
// Proves the "build once, maintained for you" loop end to end:
//   1. apply a tweak ("hide the cookie banner") on the localhost origin
//   2. RELOAD -> the tweak PERSISTED and AUTO-RE-APPLIED (no re-typing)
//   3. per-origin scope: a DIFFERENT origin (127.0.0.1) has NO tweaks and the
//      banner is NOT hidden there
//   4. removal works: drop the tweak, reload, banner is back
//
// Same harness shape as smoke-extension.mjs: Chrome for Testing, --headless=new,
// throwaway profile, real unpacked extension, driven through the service worker
// -> content (tweaks.js) message path. No visible window, no focus steal.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `smoke-tweaks-${runId}`);
const profilePath = join(runDir, "chrome-profile");
let latestChromeStderr = "";

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname === "/" ? "/fixtures/demo.html" : url.pathname;
    const file = join(root, path.replace(/^\/+/, ""));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      resolveServer({ server, port: address.port });
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
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
    this.ws.close();
  }
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
}

async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < timeoutMs) {
    last = await targets(port);
    const found = last.find(predicate);
    if (found) return found;
    await delay(200);
  }
  throw new Error(`Timed out waiting for Chrome target. Last: ${JSON.stringify(last.map((t) => ({ type: t.type, url: t.url })))}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 12000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(cdp, expression).catch(() => undefined);
    if (last) return last;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(last)}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

// Drive a tweak:* message to the content script for the tab on a given origin.
async function tweakMsg(workerCdp, originGlob, payload) {
  const expr = `
    (async () => {
      const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(originGlob)} });
      if (!tab) return { __noTab: true };
      try {
        return await chrome.tabs.sendMessage(tab.id, ${JSON.stringify(payload)});
      } catch (e) {
        return { __error: String(e && e.message || e) };
      }
    })()
  `;
  const out = await waitForEval(workerCdp, expr);
  if (out && out.__noTab) throw new Error(`no tab matched ${originGlob}`);
  if (out && out.__error) throw new Error(`sendMessage failed for ${originGlob}: ${out.__error}`);
  return out;
}

// Is the demo cookie banner currently visible (not display:none)?
const BANNER_VISIBLE_EXPR = `
  (() => {
    const el = document.getElementById('cookie-banner');
    if (!el) return null;
    return getComputedStyle(el).display !== 'none';
  })()
`;

async function main() {
  const chromePath = resolveChromeForTesting();
  const { server, port } = await serve();
  mkdirSync(profilePath, { recursive: true });

  const localhostUrl = `http://localhost:${port}/fixtures/demo.html`;
  const otherOriginUrl = `http://127.0.0.1:${port}/fixtures/demo.html`;

  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath, profilePath }), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  chrome.stderr.on("data", (chunk) => {
    latestChromeStderr += chunk.toString();
    latestChromeStderr = latestChromeStderr.slice(-4000);
  });

  let browserCdp, workerCdp, pageCdp, otherCdp;
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);

    const workerTarget = await waitForTarget(
      devToolsPort,
      (t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(t.url || ""),
    );
    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error("Chrome refused --load-extension. Point AGEE_CHROME_PATH at Chrome for Testing.");
    }
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((r) => r.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);

    // --- localhost page ---
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (t) => t.type === "page" && t.id === targetId);
    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: localhostUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(localhostUrl)}) && document.readyState === "complete"`);

    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");

    // tweaks.js answers tweak:ping -> proves the separate module auto-injected.
    const pong = await waitForEval(workerCdp, `
      (async () => {
        const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
        if (!tab) return null;
        try { const r = await chrome.tabs.sendMessage(tab.id, { cmd: "tweak:ping" }); return r && r.ok ? r : null; }
        catch { return null; }
      })()
    `);
    assert(pong && pong.ok, "tweaks.js content module did not answer tweak:ping");

    // Baseline: banner visible, no tweaks yet.
    assert((await evaluate(pageCdp, BANNER_VISIBLE_EXPR)) === true, "banner should start visible");
    const before = await tweakMsg(workerCdp, "http://localhost/*", { cmd: "tweak:list" });
    assert(before.ok && before.tweaks.length === 0, "localhost should start with zero tweaks");

    // 1) APPLY: build the tweak once from a natural-language instruction.
    const applied = await tweakMsg(workerCdp, "http://localhost/*", {
      cmd: "tweak:apply",
      instruction: "hide the cookie banner",
    });
    assert(applied.ok, `apply should succeed: ${JSON.stringify(applied)}`);
    assert(applied.tweak && applied.tweak.kind === "hide", "tweak kind should be hide");
    assert(typeof applied.tweak.css === "string" && applied.tweak.css.includes("display: none"), "tweak css must be inspectable");
    const tweakId = applied.tweak.id;
    assert((await evaluate(pageCdp, BANNER_VISIBLE_EXPR)) === false, "banner should be hidden right after apply");

    // 2) RELOAD: the maintenance burden is on the agent — tweak auto-re-applies.
    await pageCdp.send("Page.reload");
    await waitForEval(pageCdp, `document.readyState === "complete" && !!document.getElementById('cookie-banner')`);
    const afterReload = await waitForEval(pageCdp, `(${BANNER_VISIBLE_EXPR}) === false ? "hidden" : null`);
    assert(afterReload === "hidden", "banner should be AUTO-RE-APPLIED (hidden) after reload");
    const status = await tweakMsg(workerCdp, "http://localhost/*", { cmd: "tweak:status" });
    assert(status.applied.some((a) => a.id === tweakId && a.applied), "tweak style should be live after reload");
    const persisted = await tweakMsg(workerCdp, "http://localhost/*", { cmd: "tweak:list" });
    assert(persisted.tweaks.length === 1 && persisted.tweaks[0].id === tweakId, "tweak should persist across reload");

    // 3) PER-ORIGIN SCOPE: a different origin must NOT see or apply this tweak.
    const { targetId: otherId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const otherTarget = await waitForTarget(devToolsPort, (t) => t.type === "page" && t.id === otherId);
    otherCdp = new Cdp(otherTarget.webSocketDebuggerUrl);
    await otherCdp.send("Runtime.enable");
    await otherCdp.send("Page.enable");
    await otherCdp.send("Page.navigate", { url: otherOriginUrl });
    await waitForEval(otherCdp, `location.href.startsWith(${JSON.stringify(otherOriginUrl)}) && document.readyState === "complete"`);
    const otherList = await tweakMsg(workerCdp, "http://127.0.0.1/*", { cmd: "tweak:list" });
    assert(otherList.ok && otherList.tweaks.length === 0, "other origin (127.0.0.1) must have zero tweaks");
    assert(otherList.origin !== persisted.origin, "origins must differ");
    assert((await evaluate(otherCdp, BANNER_VISIBLE_EXPR)) === true, "banner must remain VISIBLE on the other origin");

    // 4) REMOVAL: reversible. Drop it, reload, banner is back.
    const removed = await tweakMsg(workerCdp, "http://localhost/*", { cmd: "tweak:remove", id: tweakId });
    assert(removed.ok && removed.remaining === 0, "remove should succeed and leave zero tweaks");
    assert((await evaluate(pageCdp, BANNER_VISIBLE_EXPR)) === true, "banner should be visible immediately after removal");
    await pageCdp.send("Page.reload");
    await waitForEval(pageCdp, `document.readyState === "complete" && !!document.getElementById('cookie-banner')`);
    const afterRemoveReload = await waitForEval(pageCdp, `(${BANNER_VISIBLE_EXPR}) === true ? "visible" : null`);
    assert(afterRemoveReload === "visible", "banner should stay visible after reload once tweak is removed");
    const finalList = await tweakMsg(workerCdp, "http://localhost/*", { cmd: "tweak:list" });
    assert(finalList.tweaks.length === 0, "no tweaks should remain after removal");

    console.log(
      `tweaks smoke passed (REAL extension, headless Chrome for Testing): id=${extensionId}\n` +
        `  apply       -> "hide the cookie banner" built tweak ${tweakId} (kind=hide), banner hidden, css inspectable\n` +
        `  reload      -> tweak PERSISTED + AUTO-RE-APPLIED (style live, banner still hidden)\n` +
        `  per-origin  -> ${otherList.origin} saw 0 tweaks, banner VISIBLE (scope held)\n` +
        `  removal     -> tweak removed + reversible, banner back after reload\n` +
        `  no window shown, no focus taken.`,
    );
  } finally {
    pageCdp?.close();
    otherCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    server.close();
    chrome.kill("SIGTERM");
    await delay(300);
    rmSync(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  if (latestChromeStderr.trim()) {
    console.error("Chrome stderr tail:");
    console.error(latestChromeStderr.trim());
  }
  process.exit(1);
});
