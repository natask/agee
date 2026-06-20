// Integration smoke: router + disposable task agents, fused, with REAL parallelism.
//
// Fuses the two green PoCs into ONE runnable demo:
//   - moa_gateway @ feat/router-activation-loop: POST /v1/router/activate launches
//     a disposable agent run (202 + run id), GET /v1/router/activations/:id yields
//     a durable router_ping; keyless deterministic `echo` harness.
//   - browser_extension @ feat/cdp-background-task-agent: a task agent drives its
//     OWN background tab via chrome.debugger (CDP), no focus steal, pings the
//     overlay on completion.
//
// The headline this asserts is BRANCH-TO-TWO: one overlay trigger fans out to TWO
// background-tab workers running CONCURRENTLY. We prove:
//   (1) TWO distinct background tabs were created and NEITHER became active,
//   (2) they were in flight AT THE SAME TIME (overlap, not serialized),
//   (3) BOTH rendered a completion "done" cue in the overlay (two pings),
//   (4) the gateway recorded a router_ping event for the activated runs.
//
// Boot model (per the contract): the gateway is started with `node server.js`
// DIRECTLY on a throwaway port + token + DATA_DIR, so the real .env is never
// loaded and no model key is required (echo harness). The REAL extension is
// loaded into headless Chrome for Testing and pointed at that throwaway gateway
// via chrome.storage.local (ageeGatewayUrl/ageeGatewayToken) — never .env, never
// printed. No API key is set in the browser.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const gatewayDir = resolve(root, "..", "moa_gateway");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `smoke-integration-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const GATEWAY_TOKEN = "integration-smoke-token";
let latestChromeStderr = "";

// ---- tiny static server for the demo page ---------------------------------
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
      resolveServer({ server, port: server.address().port });
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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on("error", reject);
  });
}

// ---- throwaway gateway (node server.js directly; real .env NOT loaded) -----
async function startGateway(dataDir, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  // A minimal, secret-free env. No model/provider keys: the loop runs on the
  // deterministic echo harness alone. Spawned with `node server.js` directly, so
  // package start scripts and the real .env file are bypassed.
  const env = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: GATEWAY_TOKEN,
    ROUTER_DEFAULT_HARNESS: "echo",
    DEFAULT_AGENT_HARNESS: "echo",
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "integration-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
    AGENT_RUN_TIMEOUT_MS: "5000",
    HARNESS_STATUS_TIMEOUT_MS: "200",
  };
  const server = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let exited = false;
  const append = (chunk) => {
    logs += chunk.toString("utf8");
    if (logs.length > 12000) logs = logs.slice(-12000);
  };
  server.stdout.on("data", append);
  server.stderr.on("data", append);
  server.on("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) {
        const health = await resp.json();
        const echo = (health.agent_loop?.harnesses || []).find((h) => h.name === "echo");
        if (!echo?.available) throw new Error("echo harness not available on throwaway gateway");
        return { server, baseUrl };
      }
    } catch {
      // still starting
    }
    if (exited) throw new Error(`gateway exited before health was ready\n${logs}`);
    await delay(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs}`);
}

function gatewayGet(baseUrl, path) {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${GATEWAY_TOKEN}` } }).then((r) => r.json());
}

// ---- CDP plumbing (mirrors smoke-cdp.mjs) ---------------------------------
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
      const m = JSON.parse(event.data);
      if (!m.id || !this.pending.has(m.id)) return;
      const { resolveCall, rejectCall } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) rejectCall(new Error(`${m.error.message}: ${m.error.data || ""}`));
      else resolveCall(m.result);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => this.pending.set(id, { resolveCall, rejectCall }));
  }
  close() {
    this.ws.close();
  }
}

function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
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
  throw new Error(
    `Timed out waiting for Chrome target. Last: ${JSON.stringify(
      lastTargets.map((t) => ({ type: t.type, url: t.url })),
      null,
      2,
    )}`,
  );
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(cdp, expression).catch(() => undefined);
    if (last) return last;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(last)}`);
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const tempDir = mkdtempSync(join(tmpdir(), "moa-integration-smoke-"));
  const dataDir = join(tempDir, "data");
  const { server: gateway, baseUrl } = await startGateway(dataDir, await freePort());
  const { server, port: serverPort } = await serve();
  mkdirSync(profilePath, { recursive: true });

  const demoUrl = `http://localhost:${serverPort}/fixtures/demo.html`;
  const branchUrlA = `http://localhost:${serverPort}/fixtures/demo.html?branch=A`;
  const branchUrlB = `http://localhost:${serverPort}/fixtures/demo.html?branch=B`;

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
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);

    // Proof the REAL extension loaded: its service worker target exists.
    const workerTarget = await waitForTarget(
      devToolsPort,
      (t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(t.url || ""),
    );
    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error("Resolved Chrome refused --load-extension; point AGEE_CHROME_PATH at Chrome for Testing.");
    }
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    // Point the REAL extension at the throwaway gateway via storage — never .env,
    // never an API key in the browser. Token comes only from this storage write.
    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    await evaluate(
      workerCdp,
      `chrome.storage.local.set(${JSON.stringify({
        ageeGatewayUrl: baseUrl,
        ageeGatewayToken: GATEWAY_TOKEN,
      })}).then(() => true)`,
    );

    // Open the user's foreground overlay tab on the demo page.
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((r) => r.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (t) => t.type === "page" && t.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: demoUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(demoUrl)}) && document.readyState === "complete"`);

    // Confirm the real content script is alive on the overlay tab.
    const ping = await waitForEval(
      workerCdp,
      `(async () => {
        const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
        if (!tab) return null;
        try { const r = await chrome.tabs.sendMessage(tab.id, { cmd: "ping" }); return r && r.ok ? { tabId: tab.id } : null; }
        catch { return null; }
      })()`,
    );
    if (!ping?.tabId) throw new Error("real content script did not answer ping via the service worker");
    await waitForEval(pageCdp, `Boolean(document.getElementById("agee-root"))`);

    const pagesBefore = (await targets(devToolsPort)).filter((t) => t.type === "page").length;

    // THE TRIGGER: one fan-out message dispatching TWO branches. We send it from
    // the overlay tab's content-script world (the production path: sender.tab is
    // the overlay tab), exactly as the overlay would when fanning out.
    const cueA = `int_A_${Date.now().toString(36)}`;
    const cueB = `int_B_${Date.now().toString(36)}`;
    const dispatched = await evaluate(
      workerCdp,
      `(async () => {
        await chrome.scripting.executeScript({
          target: { tabId: ${ping.tabId} },
          func: (a, b) => {
            chrome.runtime.sendMessage({
              cmd: "branchFanout",
              branches: [
                { instruction: "smoke: worker A", url: a.url, cueId: a.cueId },
                { instruction: "smoke: worker B", url: b.url, cueId: b.cueId },
              ],
            });
          },
          args: [
            ${JSON.stringify({ url: branchUrlA, cueId: cueA })},
            ${JSON.stringify({ url: branchUrlB, cueId: cueB })},
          ],
        });
        return true;
      })()`,
    );
    if (!dispatched) throw new Error("failed to dispatch branchFanout from the overlay tab");

    // (2) Prove CONCURRENCY: poll the page target list and require that at some
    // moment there were TWO extra page tabs in flight at the same time (the two
    // disposable background workers overlapping, not serialized one-after-another).
    let maxExtraConcurrent = 0;
    const concurrencyDeadline = Date.now() + 20000;
    while (Date.now() < concurrencyDeadline) {
      const pageTargets = (await targets(devToolsPort)).filter((t) => t.type === "page");
      const extra = pageTargets.length - pagesBefore;
      if (extra > maxExtraConcurrent) maxExtraConcurrent = extra;
      if (maxExtraConcurrent >= 2) break;
      await delay(60);
    }
    if (maxExtraConcurrent < 2) {
      throw new Error(`expected TWO concurrent background tabs, max extra observed = ${maxExtraConcurrent}`);
    }

    // (1) Neither background worker tab ever became active while it existed. We
    // assert it from the service worker, which sees chrome.tabs state directly:
    // every non-overlay page tab must be active:false.
    const noActiveBackground = await evaluate(
      workerCdp,
      `(async () => {
        const tabs = await chrome.tabs.query({});
        const overlay = ${ping.tabId};
        return tabs.filter((t) => t.id !== overlay && t.active).length === 0;
      })()`,
    );
    if (!noActiveBackground) throw new Error("a background worker tab became active (focus/ownership violation)");

    // (3) BOTH workers rendered a completion "done" cue in the overlay (two pings).
    // The test injects cueIds the content script did not register, so each "done"
    // message renders via the overlay's fallback path as an `.agee-done` row (the
    // same row smoke-cdp.mjs asserts). Two workers => TWO done rows, each carrying
    // the CDP summary AND confirming the tab stayed in background.
    const doneCount = await waitForEval(
      pageCdp,
      `(() => {
        const rows = [...document.querySelectorAll("#agee-log .agee-done")]
          .map((r) => r.textContent || "")
          .filter((t) => /background task agent done/i.test(t) && /tab stayed in background/i.test(t));
        return rows.length >= 2 ? rows.length : 0;
      })()`,
      25000,
    );
    if (!doneCount) throw new Error("overlay did not render BOTH done cues with the background-stayed confirmation");

    // Both done rows must also surface the gateway router ping (the fused loop).
    const pingedRows = await waitForEval(
      pageCdp,
      `(() => {
        const rows = [...document.querySelectorAll("#agee-log .agee-done")]
          .map((r) => r.textContent || "")
          .filter((t) => /background task agent done/i.test(t) && /Router ping:/i.test(t));
        return rows.length >= 2 ? rows.length : 0;
      })()`,
      25000,
    );
    if (!pingedRows) throw new Error("overlay done rows did not surface the gateway router ping");

    // (4) The gateway recorded a router_ping for the activated runs. Each worker
    // registered its own activation (under a shared parent); pull the persisted
    // cue state for the worker run ids, then assert the gateway event log carries
    // a router_ping for each.
    const cueStates = await evaluate(
      workerCdp,
      `(async () => {
        const ids = [${JSON.stringify(cueA)}, ${JSON.stringify(cueB)}];
        const out = {};
        for (const id of ids) {
          const key = "ageeCue:" + id;
          const got = await chrome.storage.local.get(key);
          out[id] = got[key] || null;
        }
        return out;
      })()`,
    );
    const workerRunIds = [cueA, cueB].map((id) => cueStates[id]?.routerRunId).filter(Boolean);
    if (workerRunIds.length !== 2) {
      throw new Error(`expected 2 gateway worker run ids, got ${JSON.stringify(workerRunIds)}`);
    }
    if (![cueA, cueB].every((id) => cueStates[id]?.routerPingOk === true)) {
      throw new Error(`both workers must report router_ping ok; states=${JSON.stringify(cueStates)}`);
    }

    // Assert the gateway router_ping events are present for each activated run,
    // straight from the gateway API (durable observability, not just the cue).
    for (const wid of workerRunIds) {
      const activation = await gatewayGet(baseUrl, `/v1/router/activations/${wid}`);
      const ping = activation?.ping;
      if (!ping || ping.type !== "router_ping") {
        throw new Error(`gateway has no router_ping for ${wid}: ${JSON.stringify(activation?.status)}`);
      }
      const hasPingEvent = Array.isArray(activation.events) && activation.events.some((e) => e.type === "router_ping");
      if (!hasPingEvent) throw new Error(`gateway event log missing router_ping for ${wid}`);
    }

    // Belt-and-suspenders: the persisted event logs on the gateway DATA_DIR carry
    // router_ping for both activated runs (durable across process boundaries).
    const eventsDir = join(dataDir, "agent-runs");
    const eventFiles = readdirSync(eventsDir).filter((f) => f.endsWith(".events.jsonl"));
    let pingFilesForWorkers = 0;
    for (const wid of workerRunIds) {
      const file = join(eventsDir, `${wid}.events.jsonl`);
      if (!existsSync(file)) continue;
      const types = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
      if (types.includes("router_activated") && types.includes("router_ping")) pingFilesForWorkers += 1;
    }
    if (pingFilesForWorkers !== 2) {
      throw new Error(`expected durable router_ping logs for 2 workers, found ${pingFilesForWorkers} (of ${eventFiles.length} run logs)`);
    }

    // The overlay tab itself was never navigated to a branch URL.
    const overlayUrl = await evaluate(pageCdp, "location.href");
    if (/branch=(A|B)/.test(overlayUrl)) {
      throw new Error("overlay tab was navigated by a task agent (focus/ownership violation)");
    }

    // Background tabs are disposable: page count settles back to baseline.
    let pagesAfter = pagesBefore;
    const settleStart = Date.now();
    while (Date.now() - settleStart < 6000) {
      pagesAfter = (await targets(devToolsPort)).filter((t) => t.type === "page").length;
      if (pagesAfter === pagesBefore) break;
      await delay(150);
    }

    console.log(
      "Integration smoke passed (REAL extension + throwaway gateway, headless Chrome for Testing):\n" +
        `  service worker id=${extensionId}; gateway=${baseUrl}\n` +
        `  BRANCH-TO-TWO: ${maxExtraConcurrent} background tabs in flight concurrently, neither became active;\n` +
        `  two overlay done cues rendered (two pings); both tabs stayed in background and were disposed;\n` +
        `  gateway router_ping recorded for worker runs ${workerRunIds.join(", ")};\n` +
        `  pages baseline=${pagesBefore} after=${pagesAfter}; no window shown, no focus taken, no API key in browser.`,
    );
  } finally {
    pageCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    server.close();
    chrome.kill("SIGTERM");
    await delay(300);
    try {
      gateway.kill("SIGTERM");
    } catch {}
    await delay(300);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
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
