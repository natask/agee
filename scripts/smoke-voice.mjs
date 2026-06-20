// Quiet headless smoke for "the agent changes its OWN spoken voice by talking."
//
// Mirrors scripts/smoke-settings.mjs: a typed instruction routed through the
// REAL on-page overlay -> background.js -> PUT /v1/agent/profile changes the
// runtime agent profile against a LOCAL moa_gateway instance. Here the field is
// `voice` (a Gemini Live core voice), and we prove the spoken gender aliases:
//
//   "switch to a female voice" -> PUT voice=Aoede ; gateway GET reflects it.
//   "use a male voice"         -> PUT voice=Charon ; gateway GET reflects it.
//
// Same quiet rules as smoke-settings.mjs: --headless=new, throwaway Chrome
// profile under .gstack/background-qa/<run>/, no visible window, no focus stolen.
//
// SECRET BOUNDARY: needs NO real secret. Boots the local gateway with a THROWAWAY
// MOA_GATEWAY_TOKEN + DATA_DIR via `node server.js` (NOT `npm start`) so the real
// .env is never loaded. The voice change is a pure profile round-trip — no Gemini
// key, no live audio session.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(root, "..", "..");
const gatewayDir = join(repoRoot, "software", "moa_gateway");
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `voice-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const gatewayDataDir = join(runDir, "gateway-data");

const GATEWAY_TOKEN = `smoke-${randomBytes(12).toString("hex")}`;
const GATEWAY_PORT = 8700 + Math.floor(Math.random() * 800);
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

let latestChromeStderr = "";
let gatewayStderr = "";

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

async function startGateway() {
  mkdirSync(gatewayDataDir, { recursive: true });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HOST: "127.0.0.1",
      PORT: String(GATEWAY_PORT),
      DATA_DIR: gatewayDataDir,
      MOA_GATEWAY_TOKEN: GATEWAY_TOKEN,
      // Force gemini-live so the provider's status() exposes `voice`; no key is
      // set, so it stays unconfigured — we never open a live audio session.
      VOICE_PROVIDER: "gemini-live",
      GEMINI_LIVE_VOICE: "Kore",
    },
  });
  child.stdout.on("data", (chunk) => {
    gatewayStderr += chunk.toString();
    gatewayStderr = gatewayStderr.slice(-4000);
  });
  child.stderr.on("data", (chunk) => {
    gatewayStderr += chunk.toString();
    gatewayStderr = gatewayStderr.slice(-4000);
  });

  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const resp = await fetch(`${GATEWAY_URL}/health`);
      if (resp.ok) {
        const body = await resp.json();
        if (body.ok) return child;
      }
    } catch {}
    await delay(150);
  }
  throw new Error(`local gateway did not become healthy on ${GATEWAY_URL}.\nGateway output tail:\n${gatewayStderr}`);
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

function lastGatewayCallExpr(suffix, method) {
  return `
    (() => {
      const log = globalThis.__ageeFetchLog || [];
      for (let i = log.length - 1; i >= 0; i--) {
        try {
          const u = new URL(log[i].url);
          if (u.pathname === ${JSON.stringify(suffix)}${method ? ` && log[i].method === ${JSON.stringify(method)}` : ""}) return log[i];
        } catch {}
      }
      return null;
    })()
  `;
}

function configureStorageExpr(url, token) {
  return `
    (async () => {
      await chrome.storage.local.set({
        ageeGatewayUrl: ${JSON.stringify(url)},
        ageeGatewayToken: ${JSON.stringify(token)},
        ageeApiKey: "",
      });
      const got = await chrome.storage.local.get(["ageeGatewayUrl", "ageeGatewayToken"]);
      return { url: got.ageeGatewayUrl, tokenSet: Boolean(got.ageeGatewayToken) };
    })()
  `;
}

function triggerRunExpr(instruction) {
  return `
    (() => {
      const log = document.querySelector("#agee-log");
      window.__ageeRowsBefore = log ? log.childElementCount : 0;
      chrome.runtime.sendMessage({ cmd: "run", instruction: ${JSON.stringify(instruction)} }).catch(() => {});
      return true;
    })()
  `;
}

function renderedReplyExpr() {
  return `
    (() => {
      const log = document.querySelector("#agee-log");
      if (!log) return null;
      const before = window.__ageeRowsBefore || 0;
      const rows = [...log.children].slice(before);
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

async function fetchGatewayVoice() {
  const profile = await fetch(`${GATEWAY_URL}/v1/agent/profile`, {
    headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
  }).then((r) => r.json());
  const health = await fetch(`${GATEWAY_URL}/health`).then((r) => r.json());
  return {
    profileVoice: profile.profile?.voice,
    isOverridden: profile.is_overridden,
    providerVoice: health?.voice_stream?.provider?.voice,
  };
}

async function main() {
  const chromePath = resolveChromeForTesting();
  mkdirSync(profilePath, { recursive: true });

  console.log("agee voice-by-talking smoke (REAL extension + LOCAL gateway, headless)");
  console.log(`  gateway: ${GATEWAY_URL} (local, throwaway token + data dir)`);

  const gateway = await startGateway();
  console.log(`  local gateway healthy on ${GATEWAY_URL}`);

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

    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    await evaluate(workerCdp, INSTALL_FETCH_RECORDER);

    const cfg = await evaluate(workerCdp, configureStorageExpr(GATEWAY_URL, GATEWAY_TOKEN));
    if (cfg.url !== GATEWAY_URL || !cfg.tokenSet) {
      throw new Error(`storage did not take the local gateway config: ${JSON.stringify(cfg)}`);
    }

    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);

    // Starting voice: env default Kore, no override.
    const start = await fetchGatewayVoice();
    console.log("");
    console.log(`Leg 0 — starting voice is the env default (no override): voice=${start.providerVoice}, is_overridden=${start.isOverridden}`);

    // Open the overlay on a localhost fixture page (manifest content_scripts match).
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><head><title>agee voice smoke</title></head><body><h1>fixture</h1></body></html>");
    });
    const serverPort = await new Promise((resolveServer) => {
      server.listen(0, "localhost", () => resolveServer(server.address().port));
    });
    const pageUrl = `http://localhost:${serverPort}/`;

    const { targetId: pageId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === pageId);
    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    const isolatedContexts = [];
    pageCdp.on("Runtime.executionContextCreated", ({ context }) => {
      const aux = context.auxData || {};
      if (aux.type === "isolated" || context.name) isolatedContexts.push(context.id);
    });
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: pageUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(pageUrl)}) && document.readyState === "complete"`);

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

    // ---- Leg 1 — "switch to a female voice" -> PUT voice=Aoede ----
    console.log("");
    console.log('Leg 1 — typed "switch to a female voice" routes to the gateway profile (PUT /v1/agent/profile, voice=Aoede)');
    {
      await evaluate(pageCdp, triggerRunExpr("switch to a female voice"), { contextId: contentCtx });
      const reply = await waitForEval(pageCdp, renderedReplyExpr(), 20000, { contextId: contentCtx });
      const putCall = await evaluate(workerCdp, lastGatewayCallExpr("/v1/agent/profile", "PUT"));
      const after = await fetchGatewayVoice();

      const ok =
        reply.kind === "done" &&
        /settings updated/i.test(reply.text) &&
        putCall && putCall.ok && putCall.status === 200 &&
        after.profileVoice === "Aoede" &&
        after.providerVoice === "Aoede" &&
        after.isOverridden === true;
      if (ok) {
        pass(
          'female-voice alias applied through the gateway',
          `PUT /v1/agent/profile -> HTTP 200; voice=Aoede; provider voice=Aoede; is_overridden=true`,
        );
        console.log(`         overlay reply: "${reply.text.trim()}"`);
      } else {
        failures++;
        console.log(`  [FAIL] "switch to a female voice" did not set voice=Aoede through the gateway.`);
        console.log(`         rendered: ${JSON.stringify(reply)}`);
        console.log(`         put call: ${JSON.stringify(putCall)}`);
        console.log(`         gateway after: ${JSON.stringify(after)}`);
      }
    }

    // ---- Leg 2 — "use a male voice" -> PUT voice=Charon ----
    console.log("");
    console.log('Leg 2 — typed "use a male voice" routes to the gateway profile (PUT /v1/agent/profile, voice=Charon)');
    {
      await evaluate(pageCdp, triggerRunExpr("use a male voice"), { contextId: contentCtx });
      const reply = await waitForEval(pageCdp, renderedReplyExpr(), 20000, { contextId: contentCtx });
      const putCall = await evaluate(workerCdp, lastGatewayCallExpr("/v1/agent/profile", "PUT"));
      const after = await fetchGatewayVoice();

      const ok =
        reply.kind === "done" &&
        /settings updated/i.test(reply.text) &&
        putCall && putCall.ok && putCall.status === 200 &&
        after.profileVoice === "Charon" &&
        after.providerVoice === "Charon" &&
        after.isOverridden === true;
      if (ok) {
        pass(
          'male-voice alias applied through the gateway',
          `PUT /v1/agent/profile -> HTTP 200; voice=Charon; provider voice=Charon; is_overridden=true`,
        );
        console.log(`         overlay reply: "${reply.text.trim()}"`);
      } else {
        failures++;
        console.log(`  [FAIL] "use a male voice" did not set voice=Charon through the gateway.`);
        console.log(`         rendered: ${JSON.stringify(reply)}`);
        console.log(`         put call: ${JSON.stringify(putCall)}`);
        console.log(`         gateway after: ${JSON.stringify(after)}`);
      }
    }

    server.close();

    console.log("");
    if (failures > 0) {
      throw new Error(`${failures} voice smoke leg(s) failed`);
    }
    console.log(
      `voice-by-talking smoke passed (REAL extension + LOCAL gateway, headless): id=${extensionId}, ` +
        `"switch to a female voice" -> PUT voice=Aoede, "use a male voice" -> PUT voice=Charon, ` +
        `gateway profile + provider status reflect each change, no window shown, no real secret used.`,
    );
  } finally {
    pageCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    chrome.kill("SIGTERM");
    gateway.kill("SIGTERM");
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
  if (gatewayStderr.trim()) {
    console.error("Gateway output tail:");
    console.error(gatewayStderr.trim());
  }
  process.exit(1);
});
