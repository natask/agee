// Quiet headless smoke for "change settings by talking to the agent."
//
// Proves the full Stage-1 loop against a LOCAL moa_gateway instance (its working
// tree has the runtime agent-profile endpoints; the live gateway does NOT, so we
// run our own throwaway instance — no deployment, no real secret):
//
//   1.1/1.2  the settings surface (options.html) reads the effective profile
//            from the gateway (GET /v1/agent/profile) and shows what is in effect.
//   2.1/2.2  a typed settings-intent ("be terser") routed through the REAL
//            on-page overlay -> background.js -> PUT /v1/agent/profile changes
//            the profile (voice_max_chars shrinks).
//   2.3/3.1  the open settings surface refreshes LIVE (no manual reload) to show
//            the new value.
//   3.2      the changed setting takes effect on the NEXT gateway turn with no
//            restart: a voice turn's spoken reply is capped to the new limit.
//
// Same quiet rules as scripts/smoke-gateway.mjs: --headless=new, throwaway
// profile under .gstack/background-qa/<run>/, no visible window, no focus stolen.
//
// SECRET BOUNDARY: this smoke needs NO real secret. It boots the local gateway
// with a THROWAWAY MOA_GATEWAY_TOKEN generated per run and a throwaway DATA_DIR,
// running `node server.js` directly (NOT `npm start`) so the gateway's real .env
// is never loaded. No token is read from .env and none is printed.

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
const runDir = join(root, ".gstack", "background-qa", `settings-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const gatewayDataDir = join(runDir, "gateway-data");

// Throwaway token + port for THIS run only. Never a real secret.
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

// Boot the local gateway from its working tree. We run `node server.js` directly
// (not `npm start`) so --env-file-if-exists=.env does NOT load the real .env.
async function startGateway() {
  mkdirSync(gatewayDataDir, { recursive: true });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      // A minimal, explicit env — deliberately NOT process.env — so no ambient
      // secret leaks in. No MODEL_API_KEY: the gateway uses its deterministic
      // fallback reply, so chat turns work with no model and no secret.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HOST: "127.0.0.1",
      PORT: String(GATEWAY_PORT),
      DATA_DIR: gatewayDataDir,
      MOA_GATEWAY_TOKEN: GATEWAY_TOKEN,
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

  // Wait until /health answers.
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

// Record gateway calls in the service worker so we can prove WHICH endpoint each
// step hit (GET vs PUT /v1/agent/profile) from REAL traffic.
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

// Like lastGatewayCallExpr, but only returns the entry once the fetch has
// resolved (status is filled), so callers can await a completed request.
function completedGatewayCallExpr(suffix, method) {
  return `
    (() => {
      const log = globalThis.__ageeFetchLog || [];
      for (let i = log.length - 1; i >= 0; i--) {
        try {
          const u = new URL(log[i].url);
          if (u.pathname === ${JSON.stringify(suffix)}${method ? ` && log[i].method === ${JSON.stringify(method)}` : ""} && log[i].status != null) return log[i];
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

// Drive a typed instruction through the overlay exactly as a real submit does.
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

async function main() {
  const chromePath = resolveChromeForTesting();
  mkdirSync(profilePath, { recursive: true });

  console.log("agee settings-by-talking smoke (REAL extension + LOCAL gateway, headless)");
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
  let optionsCdp;
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
    const optionsUrl = `chrome-extension://${extensionId}/options.html`;

    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    await evaluate(workerCdp, INSTALL_FETCH_RECORDER);

    // Configure storage to point at the LOCAL gateway with the throwaway token.
    const cfg = await evaluate(workerCdp, configureStorageExpr(GATEWAY_URL, GATEWAY_TOKEN));
    if (cfg.url !== GATEWAY_URL || !cfg.tokenSet) {
      throw new Error(`storage did not take the local gateway config: ${JSON.stringify(cfg)}`);
    }

    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);

    // ---- Leg 1.1/1.2 — the settings surface reads the effective profile ----
    console.log("");
    console.log("Leg 1 — settings surface reads the effective profile (GET /v1/agent/profile)");
    {
      const { targetId } = await browserCdp.send("Target.createTarget", { url: optionsUrl });
      const optionsTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);
      optionsCdp = new Cdp(optionsTarget.webSocketDebuggerUrl);
      await optionsCdp.send("Runtime.enable");
      await optionsCdp.send("Page.enable");
      await waitForEval(optionsCdp, `document.readyState === "complete" ? true : null`);

      // The page loads its profile on open. Wait for the fields to populate from
      // the gateway's effective profile.
      const sysPrompt = await waitForEval(
        optionsCdp,
        `(() => { const v = document.querySelector("#systemPrompt").value; return v && v.length > 0 ? v : null; })()`,
        15000,
      );
      // The page's fetch happens in THIS page context (not the service worker),
      // so install the recorder here and click "Refresh from gateway" to capture
      // a real, recorded GET /v1/agent/profile from the surface.
      await evaluate(optionsCdp, INSTALL_FETCH_RECORDER);
      await evaluate(optionsCdp, `document.querySelector("#refreshProfile").click(); true`);
      // Wait for the recorded call to COMPLETE (status filled), not just appear.
      const getCall = await waitForEval(optionsCdp, completedGatewayCallExpr("/v1/agent/profile", "GET"), 10000);
      const maxChars = await evaluate(optionsCdp, `Number(document.querySelector("#voiceMaxChars").value)`);
      const stateText = await evaluate(optionsCdp, `document.querySelector("#profileState").textContent`);

      if (getCall && getCall.ok && getCall.status === 200 && sysPrompt && maxChars > 0) {
        pass(
          "settings surface populated from the gateway",
          `GET /v1/agent/profile -> HTTP 200; voice_max_chars=${maxChars}; state="${stateText.trim()}"`,
        );
        console.log(`         system_prompt (first 60): "${sysPrompt.slice(0, 60)}…"`);
      } else {
        failures++;
        console.log(`  [FAIL] settings surface did not populate from GET /v1/agent/profile.`);
        console.log(`         get call: ${JSON.stringify(getCall)}; voice_max_chars=${maxChars}; sysPrompt set=${Boolean(sysPrompt)}`);
      }
      // Remember the starting limit so we can prove it shrinks.
      globalThis.__startMaxChars = maxChars;
    }

    // ---- Open the overlay on a real page to drive the talk path ----
    // The overlay auto-injects on the manifest's http://localhost content_scripts
    // match, so serve a tiny localhost page and drive the REAL overlay there.
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><head><title>agee settings smoke</title></head><body><h1>fixture</h1></body></html>");
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

    // ---- Leg 2 — "be terser" via the overlay -> PUT /v1/agent/profile ----
    console.log("");
    console.log('Leg 2 — typed "be terser" routes to the gateway profile (PUT /v1/agent/profile)');
    let newMaxChars = 0;
    {
      await evaluate(pageCdp, triggerRunExpr("be terser"), { contextId: contentCtx });
      const reply = await waitForEval(pageCdp, renderedReplyExpr(), 20000, { contextId: contentCtx });
      const putCall = await evaluate(workerCdp, lastGatewayCallExpr("/v1/agent/profile", "PUT"));

      // Confirm the gateway profile actually changed (authoritative GET).
      const after = await fetch(`${GATEWAY_URL}/v1/agent/profile`, {
        headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      }).then((r) => r.json());
      newMaxChars = after.profile.voice_max_chars;

      const ok =
        reply.kind === "done" &&
        /settings updated/i.test(reply.text) &&
        putCall && putCall.ok && putCall.status === 200 &&
        after.is_overridden === true &&
        newMaxChars < globalThis.__startMaxChars;
      if (ok) {
        pass(
          "spoken settings change applied through the gateway",
          `PUT /v1/agent/profile -> HTTP 200; voice_max_chars ${globalThis.__startMaxChars} -> ${newMaxChars}; is_overridden=true`,
        );
        console.log(`         overlay reply: "${reply.text.trim()}"`);
      } else {
        failures++;
        console.log(`  [FAIL] "be terser" did not apply through the gateway profile endpoint.`);
        console.log(`         rendered: ${JSON.stringify(reply)}`);
        console.log(`         put call: ${JSON.stringify(putCall)}`);
        console.log(`         gateway profile after: voice_max_chars=${newMaxChars} is_overridden=${after.is_overridden}`);
      }
    }

    // ---- Leg 3 — the open settings surface refreshes LIVE (no reload) ----
    console.log("");
    console.log("Leg 3 — open settings surface refreshes live (no manual reload)");
    {
      // The options page never reloaded; it should reflect the new limit via
      // chrome.storage.onChanged from background.js's cache write.
      const liveValue = await waitForEval(
        optionsCdp,
        `(() => { const v = Number(document.querySelector("#voiceMaxChars").value); return v === ${newMaxChars} ? v : null; })()`,
        10000,
      );
      const stateText = await evaluate(optionsCdp, `document.querySelector("#profileState").textContent`);
      const overriddenBadge = /customized/i.test(stateText);
      if (liveValue === newMaxChars && overriddenBadge) {
        pass(
          "settings surface updated live to the spoken change",
          `#voiceMaxChars now ${liveValue} without reload; state="${stateText.trim()}"`,
        );
      } else {
        failures++;
        console.log(`  [FAIL] settings surface did not refresh live.`);
        console.log(`         #voiceMaxChars=${liveValue} (expected ${newMaxChars}); state="${stateText.trim()}"`);
      }
    }

    // ---- Leg 4 — the changed setting takes effect on the NEXT turn ----
    console.log("");
    console.log("Leg 4 — changed setting takes effect on the next turn (no restart)");
    {
      // Ask for a long answer; the gateway's deterministic fallback reply is long,
      // and the spoken text must be capped to the new voice_max_chars.
      const turn = await fetch(`${GATEWAY_URL}/v1/voice/turns`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${GATEWAY_TOKEN}` },
        body: JSON.stringify({
          source: "agee-settings-smoke",
          transcript: "tell me a long story about the gateway and the server and everything else",
        }),
      }).then((r) => r.json());

      const speakLen = String(turn.speak || "").length;
      // truncate() appends an ellipsis, so allow a few chars of slack.
      const capped = speakLen <= newMaxChars + 4 && speakLen > 0;
      if (capped) {
        pass(
          "next turn honored the new spoken-reply limit",
          `voice_max_chars=${newMaxChars}; reply speak length=${speakLen}`,
        );
        console.log(`         capped speak: "${String(turn.speak)}"`);
      } else {
        failures++;
        console.log(`  [FAIL] next turn did not honor the new limit.`);
        console.log(`         voice_max_chars=${newMaxChars}; speak length=${speakLen}; speak="${String(turn.speak)}"`);
      }
    }

    server.close();

    console.log("");
    if (failures > 0) {
      throw new Error(`${failures} settings smoke leg(s) failed`);
    }
    console.log(
      `settings-by-talking smoke passed (REAL extension + LOCAL gateway, headless): id=${extensionId}, ` +
        `surface read profile, "be terser" -> PUT /v1/agent/profile, surface refreshed live, next turn honored it, ` +
        `no window shown, no focus taken, no real secret used.`,
    );
  } finally {
    pageCdp?.close();
    optionsCdp?.close();
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
