// Quiet headless gateway round-trip smoke for the REAL agee extension.
//
// Proves the on-page overlay actually talks to the configured gateway end to
// end: a command round-trips through POST /v1/voice/turns, "describe page"
// through POST /v1/chat, and an unreachable/unauthorized gateway renders a
// CLEAR, non-silent error in the overlay.
//
// Same quiet rules as scripts/smoke-extension.mjs: --headless=new, throwaway
// profile under .gstack/background-qa/<run>/, no visible window, no focus
// stolen, never the daily profile. Loads the unpacked extension/ and drives the
// REAL background service worker -> content overlay path against the live
// gateway off-screen.
//
// SECRET BOUNDARY: the bearer token is read ONLY from AGEE_GATEWAY_TOKEN at run
// time. It is never read from .env or printed. If AGEE_GATEWAY_TOKEN is unset
// the two authenticated legs (command, describe) are implemented but SKIPPED
// (awaiting the token) — the run does not fail and does not hunt for a token.
// The no-token legs (health, loud-error) are always verified.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `gateway-${runId}`);
const profilePath = join(runDir, "chrome-profile");

// The live gateway. /health needs no token; all /v1/* require a bearer token.
const GATEWAY_URL = (process.env.AGEE_GATEWAY_URL || "http://10.147.17.10:8788").replace(/\/+$/, "");
// Read the token ONLY from the environment. Never from .env, never printed.
const GATEWAY_TOKEN = process.env.AGEE_GATEWAY_TOKEN || "";
const HAS_TOKEN = GATEWAY_TOKEN.length > 0;

let latestChromeStderr = "";

// Serve the demo fixture over http://localhost so the manifest's content_scripts
// match auto-injects the overlay (same approach as scripts/smoke-extension.mjs).
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
    server.listen(0, "localhost", () => {
      const address = server.address();
      resolveServer({ server, port: address.port });
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
    this.listeners = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.onopen = resolveReady;
      this.ws.onerror = rejectReady;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method) {
        const handlers = this.listeners.get(msg.method);
        if (handlers) for (const handler of handlers) handler(msg.params);
        return;
      }
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolveCall, rejectCall } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rejectCall(new Error(`${msg.error.message}: ${msg.error.data || ""}`));
      else resolveCall(msg.result);
    };
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
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
  return fetch(`http://127.0.0.1:${port}/json/list`).then((resp) => resp.json());
}

async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let lastTargets = [];
  while (Date.now() - started < timeoutMs) {
    lastTargets = await targets(port);
    const found = lastTargets.find(predicate);
    if (found) return found;
    await delay(200);
  }
  throw new Error(`Timed out waiting for Chrome target. Last targets: ${JSON.stringify(lastTargets.map((target) => ({
    type: target.type,
    title: target.title,
    url: target.url,
  })), null, 2)}`);
}

async function evaluate(cdp, expression, { contextId } = {}) {
  const params = { expression, awaitPromise: true, returnByValue: true };
  // Target a specific execution context (e.g. the content script's isolated
  // world, where chrome.runtime messaging to the background is available).
  if (contextId != null) params.contextId = contextId;
  const result = await cdp.send("Runtime.evaluate", params);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 12000, opts = {}) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdp, expression, opts).catch(() => undefined);
    if (lastValue) return lastValue;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(lastValue)}`);
}

// Install a fetch recorder in the service worker so we can observe WHICH gateway
// path produced each rendered reply (and its HTTP status) from REAL traffic —
// we do not mock the gateway, we watch it. Idempotent per page/worker context.
const INSTALL_FETCH_RECORDER = `
  (() => {
    if (globalThis.__ageeFetchLog) return globalThis.__ageeFetchLog.length;
    const log = [];
    globalThis.__ageeFetchLog = log;
    const orig = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const entry = { url, method: (init && init.method) || "GET", status: null, ok: null, error: null };
      log.push(entry);
      try {
        const resp = await orig(input, init);
        entry.status = resp.status;
        entry.ok = resp.ok;
        return resp;
      } catch (err) {
        entry.error = String((err && err.message) || err);
        throw err;
      }
    };
    return 0;
  })()
`;

// Read the recorder's view of the LAST gateway call whose path matches `suffix`.
function lastGatewayCallExpr(suffix) {
  return `
    (() => {
      const log = globalThis.__ageeFetchLog || [];
      for (let i = log.length - 1; i >= 0; i--) {
        try {
          const u = new URL(log[i].url);
          if (u.pathname === ${JSON.stringify(suffix)}) return log[i];
        } catch {}
      }
      return null;
    })()
  `;
}

// Configure the extension exactly as options.js would: write gateway URL + token
// into chrome.storage.local. background.js reads these via getConfig().
function configureStorageExpr(url, token) {
  return `
    (async () => {
      await chrome.storage.local.set({
        ageeGatewayUrl: ${JSON.stringify(url)},
        ageeGatewayToken: ${JSON.stringify(token)},
        ageeApiKey: "",
      });
      const got = await chrome.storage.local.get(["ageeGatewayUrl", "ageeGatewayToken"]);
      // Never echo the token value; only confirm whether one is set.
      return { url: got.ageeGatewayUrl, tokenSet: Boolean(got.ageeGatewayToken) };
    })()
  `;
}

// Drive the overlay the way a real submit does: the content script sends
// { cmd: "run" | "describe" } to the background, which calls the live gateway and
// posts { cmd: "done"|"error" } back. We then read the rendered overlay row.
function triggerExpr(cmd, instruction) {
  const msg = cmd === "run"
    ? `{ cmd: "run", instruction: ${JSON.stringify(instruction)} }`
    : `{ cmd: "describe" }`;
  return `
    (() => {
      // Mark the log length so we can detect the NEW rendered row.
      const log = document.querySelector("#agee-log");
      window.__ageeRowsBefore = log ? log.childElementCount : 0;
      // Fire-and-forget like the overlay does; swallow the channel-closed
      // rejection (the real result arrives via a separate tabs.sendMessage
      // -> our onMessage "done"/"error" handler, not via this reply).
      chrome.runtime.sendMessage(${msg}).catch(() => {});
      return true;
    })()
  `;
}

// Wait for a NEW terminal row (done or error) to render in the overlay, then
// return its kind + text. This is the actual user-visible result.
function renderedReplyExpr() {
  return `
    (() => {
      const log = document.querySelector("#agee-log");
      if (!log) return null;
      const before = window.__ageeRowsBefore || 0;
      const rows = [...log.children].slice(before);
      // Find the latest terminal row (done or error), ignoring the "you" echo
      // and any interim "agee" progress rows.
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.classList.contains("agee-done")) return { kind: "done", text: row.textContent };
        if (row.classList.contains("agee-error")) return { kind: "error", text: row.textContent };
      }
      return null;
    })()
  `;
}

function pass(label, detail) {
  console.log(`  [PASS] ${label}${detail ? ` — ${detail}` : ""}`);
}
function skip(label, detail) {
  console.log(`  [SKIP] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const { server, port: serverPort } = await serve();
  mkdirSync(profilePath, { recursive: true });

  console.log("agee gateway round-trip smoke (REAL extension, headless Chrome for Testing)");
  console.log(`  gateway: ${GATEWAY_URL}`);
  console.log(`  token:   ${HAS_TOKEN ? "supplied via AGEE_GATEWAY_TOKEN" : "NOT set (authenticated legs will be SKIPPED)"}`);

  // Serve the demo page on http://localhost so the manifest's content_scripts
  // match auto-injects the real overlay (no manual injection needed).
  const demoUrl = `http://localhost:${serverPort}/fixtures/demo.html`;
  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath, profilePath }), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  chrome.stderr.on("data", (chunk) => {
    latestChromeStderr += chunk.toString();
    latestChromeStderr = latestChromeStderr.slice(-4000);
  });

  let browserCdp;
  let workerCdp;
  let pageCdp;
  let failures = 0;
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);

    const workerTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );

    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error(
        "The resolved Chrome refused --load-extension (branded Chrome blocks it). " +
          "Point AGEE_CHROME_PATH at a Chrome for Testing binary.",
      );
    }

    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    // Open a real page we control. We inject the overlay content script here.
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    // Capture the content script's ISOLATED world context. Production overlay
    // submits call chrome.runtime.sendMessage, which only reaches the background
    // from the content script's isolated world (not the page main world). We
    // collect candidate isolated contexts created after navigation and resolve
    // the right one by probing for the overlay (window.__ageeLoaded).
    const isolatedContexts = [];
    pageCdp.on("Runtime.executionContextCreated", ({ context }) => {
      const aux = context.auxData || {};
      if (aux.type === "isolated" || context.name) isolatedContexts.push(context.id);
    });
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: demoUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(demoUrl)}) && document.readyState === "complete"`);

    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");

    // The content script auto-injected on the http://localhost match. Confirm it
    // answers ping via the service worker, then open the overlay so rows render
    // into #agee-log — exactly the production background -> content path.
    const tabId = await waitForEval(workerCdp, `
      (async () => {
        const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
        if (!tab) return null;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { cmd: "ping" });
          return res && res.ok ? tab.id : null;
        } catch { return null; }
      })()
    `);
    if (!tabId) throw new Error("real content script did not answer ping via the service worker");

    await evaluate(workerCdp, `chrome.tabs.sendMessage(${tabId}, { cmd: "open" })`);
    await waitForEval(pageCdp, `document.querySelector("#agee-log") ? true : null`);

    // Resolve the content script's isolated world: the context where the overlay
    // (window.__ageeLoaded) lives and chrome.runtime.sendMessage reaches the
    // background. We probe each captured isolated context.
    let contentCtx = null;
    for (const candidate of isolatedContexts) {
      const isOverlay = await evaluate(
        pageCdp,
        `Boolean(window.__ageeLoaded && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage)`,
        { contextId: candidate },
      ).catch(() => false);
      if (isOverlay) {
        contentCtx = candidate;
        break;
      }
    }
    if (contentCtx == null) {
      throw new Error(`could not resolve the overlay's isolated execution context (candidates: ${isolatedContexts.length})`);
    }

    // Install the fetch recorder in the service worker (gateway calls live there).
    await evaluate(workerCdp, INSTALL_FETCH_RECORDER);

    // ---- Leg 1.4 prerequisite is independent; run health first ----
    console.log("");
    console.log("Leg 1.1 — /health (no token required)");
    {
      // Configure storage WITHOUT a token first; /health must still succeed.
      const cfg = await evaluate(workerCdp, configureStorageExpr(GATEWAY_URL, ""));
      if (cfg.url !== GATEWAY_URL) throw new Error(`storage did not take the gateway URL: ${JSON.stringify(cfg)}`);
      // Hit /health from the service worker (recorded), exactly as gatewayHealth would.
      const health = await evaluate(workerCdp, `
        (async () => {
          const resp = await fetch(${JSON.stringify(GATEWAY_URL)} + "/health");
          const body = await resp.json().catch(() => ({}));
          const tokenRequired = body && body.agent_loop ? body.agent_loop.token_required : undefined;
          return { status: resp.status, ok: resp.ok && body && body.ok === true, provider: body.provider, tokenRequired };
        })()
      `);
      if (!health.ok) {
        failures++;
        console.log(`  [FAIL] /health did not return ok: ${JSON.stringify(health)}`);
      } else {
        pass("/health succeeded", `HTTP ${health.status}, provider=${health.provider}, token_required=${health.tokenRequired}`);
      }
    }

    // ---- Leg 1.4 — unauthorized gateway renders a CLEAR, non-silent error ----
    // This is the most important no-token leg: point at the LIVE gateway with NO
    // token and drive a real command. background.js must surface the 401 loudly.
    console.log("");
    console.log("Leg 1.4 — unauthorized gateway -> loud, visible overlay error");
    {
      // Storage already has the URL with an EMPTY token from leg 1.1.
      await evaluate(workerCdp, configureStorageExpr(GATEWAY_URL, ""));
      await evaluate(pageCdp, triggerExpr("run", "say hello"), { contextId: contentCtx });
      const reply = await waitForEval(pageCdp, renderedReplyExpr(), 20000, { contextId: contentCtx });
      const call = await evaluate(workerCdp, lastGatewayCallExpr("/v1/voice/turns"));

      const looksLikeAuthError =
        reply.kind === "error" &&
        /401|token|unauthor/i.test(reply.text) &&
        reply.text.trim().length > 0;

      // Prove it actually reached the live gateway and got a 401 (loud, not silent).
      const got401 = call && call.status === 401;

      // Prove the overlay dot also reflects the error state (visible signal).
      const dotState = await evaluate(pageCdp, `(() => { const d = document.querySelector("#agee-dot"); return d ? d.className : null; })()`, { contextId: contentCtx });

      if (looksLikeAuthError && got401 && dotState === "error") {
        pass(
          "unauthorized command rendered a clear error",
          `gateway POST /v1/voice/turns -> HTTP 401; overlay error row + red dot`,
        );
        console.log(`         overlay error text: "${reply.text.trim()}"`);
      } else {
        failures++;
        console.log(`  [FAIL] expected a loud auth error in the overlay.`);
        console.log(`         rendered: ${JSON.stringify(reply)}`);
        console.log(`         recorded gateway call: ${JSON.stringify(call)}`);
        console.log(`         overlay dot state: ${JSON.stringify(dotState)}`);
      }
    }

    // ---- Legs 1.2 / 1.3 — authenticated round-trips (only with a real token) ----
    console.log("");
    if (!HAS_TOKEN) {
      console.log("Legs 1.2 / 1.3 — authenticated command + describe round-trips");
      skip("1.2 command via /v1/voice/turns", "implemented; awaiting AGEE_GATEWAY_TOKEN to confirm live");
      skip("1.3 describe via /v1/chat", "implemented; awaiting AGEE_GATEWAY_TOKEN to confirm live");
      console.log("         Operator: re-run with the token to verify both legs live, e.g.:");
      console.log("           AGEE_GATEWAY_TOKEN=*** npm run smoke:gateway");
    } else {
      // Configure WITH the real token for the authenticated legs.
      await evaluate(workerCdp, configureStorageExpr(GATEWAY_URL, GATEWAY_TOKEN));

      console.log("Leg 1.2 — command round-trips through POST /v1/voice/turns");
      {
        await evaluate(pageCdp, triggerExpr("run", "Say a one word greeting."), { contextId: contentCtx });
        const reply = await waitForEval(pageCdp, renderedReplyExpr(), 60000, { contextId: contentCtx });
        const call = await evaluate(workerCdp, lastGatewayCallExpr("/v1/voice/turns"));
        const ok = reply.kind === "done" && call && call.ok === true && call.status === 200;
        if (ok) {
          pass(
            "command reply originated from /v1/voice/turns",
            `gateway POST /v1/voice/turns -> HTTP 200; overlay done row`,
          );
          console.log(`         overlay reply: "${reply.text.trim().slice(0, 200)}"`);
        } else {
          failures++;
          console.log(`  [FAIL] command did not round-trip cleanly through /v1/voice/turns.`);
          console.log(`         rendered: ${JSON.stringify(reply)}`);
          console.log(`         recorded gateway call: ${JSON.stringify(call)}`);
        }
      }

      console.log("");
      console.log("Leg 1.3 — describe round-trips through POST /v1/chat");
      {
        await evaluate(pageCdp, triggerExpr("describe"), { contextId: contentCtx });
        const reply = await waitForEval(pageCdp, renderedReplyExpr(), 60000, { contextId: contentCtx });
        const call = await evaluate(workerCdp, lastGatewayCallExpr("/v1/chat"));
        const ok = reply.kind === "done" && call && call.ok === true && call.status === 200;
        if (ok) {
          pass(
            "describe reply originated from /v1/chat",
            `gateway POST /v1/chat -> HTTP 200; overlay done row`,
          );
          console.log(`         overlay description: "${reply.text.trim().slice(0, 200)}"`);
        } else {
          failures++;
          console.log(`  [FAIL] describe did not round-trip cleanly through /v1/chat.`);
          console.log(`         rendered: ${JSON.stringify(reply)}`);
          console.log(`         recorded gateway call: ${JSON.stringify(call)}`);
        }
      }
    }

    console.log("");
    if (failures > 0) {
      throw new Error(`${failures} gateway round-trip leg(s) failed`);
    }
    console.log(
      `gateway round-trip smoke passed (REAL extension, headless): id=${extensionId}, ` +
        `health verified, loud-error verified${HAS_TOKEN ? ", command + describe verified live" : " (auth legs skipped: AGEE_GATEWAY_TOKEN unset)"}, ` +
        `no window shown, no focus taken.`,
    );
  } finally {
    pageCdp?.close();
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
