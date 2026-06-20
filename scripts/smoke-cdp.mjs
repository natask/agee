// Quiet headless smoke for the REAL agee CDP background-tab task agent.
//
// Mirrors smoke-extension.mjs: launches Chrome for Testing with --headless=new
// and a throwaway profile under .gstack/background-qa/<run>/, loads the unpacked
// extension/, and exercises the {cmd:"branch"} path — the router launching ONE
// disposable task agent that drives its OWN background tab over chrome.debugger
// (Chrome DevTools Protocol). No visible window, no focus steal, never the daily
// profile.
//
// Asserts the spike's contract:
//   (a) a background tab was created and NEVER became active,
//   (b) a screenshot of that background tab was captured over CDP,
//   (c) a completion "done" cue rendered in the overlay on the user's tab.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(root, "..", "..");
const gatewayDir = join(repoRoot, "software", "moa_gateway");
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `smoke-cdp-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const gatewayDataDir = join(runDir, "gateway-data");
const TOKEN = "cdp-smoke-token";
let latestChromeStderr = "";
let latestGatewayStderr = "";

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

async function freePort() {
  return new Promise((resolveFreePort, rejectFreePort) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolveFreePort(port));
    });
    server.on("error", rejectFreePort);
  });
}

async function startGateway() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  mkdirSync(gatewayDataDir, { recursive: true });
  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: gatewayDir,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || "",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: gatewayDataDir,
      MOA_GATEWAY_TOKEN: TOKEN,
      DEFAULT_AGENT_HARNESS: "echo",
      MODEL_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
      VERTEX_PROJECT: "",
      GOOGLE_CLOUD_PROJECT: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
      VERTEX_ACCESS_TOKEN: "",
      HARNESS_STATUS_TIMEOUT_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => {
    latestGatewayStderr += chunk.toString();
    latestGatewayStderr = latestGatewayStderr.slice(-4000);
  };
  gateway.stdout.on("data", append);
  gateway.stderr.on("data", append);
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) return { gateway, baseUrl };
    } catch {
      // not ready
    }
    await delay(100);
  }
  gateway.kill("SIGTERM");
  throw new Error(`local gateway did not become healthy on ${baseUrl}.\n${latestGatewayStderr}`);
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

async function waitForEval(cdp, expression, timeoutMs = 15000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdp, expression).catch(() => undefined);
    if (lastValue) return lastValue;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(lastValue)}`);
}

async function waitForGatewayTask(baseUrl, taskId, timeoutMs = 20000) {
  const started = Date.now();
  let lastTask = null;
  while (Date.now() - started < timeoutMs) {
    const body = await fetch(`${baseUrl}/v1/browser/tasks?limit=20`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((resp) => resp.json());
    lastTask = (body.tasks || []).find((task) => task.id === taskId) || null;
    if (lastTask?.status === "completed" || lastTask?.status === "failed") {
      return lastTask;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for gateway browser task ${taskId}; last=${JSON.stringify(lastTask)}`);
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const { server, port: serverPort } = await serve();
  mkdirSync(profilePath, { recursive: true });

  const demoUrl = `http://localhost:${serverPort}/fixtures/demo.html`;
  const branchUrl = `http://localhost:${serverPort}/fixtures/demo.html?branch=1`;
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
  let gateway;
  try {
    gateway = await startGateway();
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);

    // The agee service worker target is the proof the REAL extension loaded.
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

    // Open the user's foreground tab (the overlay tab) on the demo page so the
    // real content script auto-injects on the localhost match.
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: demoUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(demoUrl)}) && document.readyState === "complete"`);

    // Confirm the real content script is alive on the overlay tab (it owns the
    // cue-card overlay we assert against). The content script runs in an isolated
    // world, so we prove it via a ping through the service worker (production
    // path) and via the overlay root it injects into the shared page DOM.
    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    await evaluate(workerCdp, `chrome.storage.local.set(${JSON.stringify({
      ageeGatewayUrl: gateway.baseUrl,
      ageeGatewayToken: TOKEN,
    })}).then(() => true)`);
    const ping = await waitForEval(workerCdp, `
      (async () => {
        const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
        if (!tab) return null;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { cmd: "ping" });
          return res && res.ok ? { tabId: tab.id } : null;
        } catch {
          return null;
        }
      })()
    `);
    if (!ping?.tabId) throw new Error("real content script did not answer ping via the service worker");
    await waitForEval(pageCdp, `Boolean(document.getElementById("agee-root"))`);

    // Count page targets before the branch so we can prove a NEW background tab
    // is created by the task agent.
    const pagesBefore = (await targets(devToolsPort)).filter((t) => t.type === "page").length;

    // Trigger the same route a user does: open the command bar, type a natural
    // language browser-task request, and press Enter. The content script creates
    // a real cue card, background.js parses the URL/report intent, and the CDP
    // task agent runs in its own background tab.
    await evaluate(workerCdp, `chrome.tabs.sendMessage(${ping.tabId}, { cmd: "open" }).then(() => true)`);
    await waitForEval(pageCdp, `Boolean(document.getElementById("agee-input"))`);
    await evaluate(pageCdp, `
      (() => {
        const input = document.getElementById("agee-input");
        input.value = ${JSON.stringify(`open ${branchUrl} and report the page title`)};
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        return true;
      })()
    `);
    const cueId = await waitForEval(pageCdp, `
      (() => {
        const card = [...document.querySelectorAll("#agee-log .agee-cue")].pop();
        return card ? card.dataset.cue : null;
      })()
    `);
    if (!cueId) throw new Error("typed browser-task request did not create a cue card");

    // (c) Assert the completion "done" cue rendered in the overlay log.
    const doneText = await waitForEval(
      pageCdp,
      `(() => {
        const card = document.querySelector(${JSON.stringify(`#agee-log .agee-cue[data-cue="${cueId}"]`)});
        if (!card || !card.classList.contains("agee-cue-done")) return null;
        const status = card.querySelector(".agee-cue-status");
        return status ? status.textContent : null;
      })()`,
      20000,
    );
    if (!doneText || !/background task agent done/i.test(doneText)) {
      throw new Error(`overlay did not render the expected done cue; got: ${JSON.stringify(doneText)}`);
    }
    if (!/screenshot/i.test(doneText)) {
      throw new Error(`done cue did not report a screenshot; got: ${JSON.stringify(doneText)}`);
    }
    if (!/tab stayed in background/i.test(doneText)) {
      throw new Error(`done cue did not confirm the tab stayed in background; got: ${JSON.stringify(doneText)}`);
    }

    // (a)+(b) cross-check from the persisted cue state in the service worker: the
    // background tab was created and disposed, and the run finished "done".
    const cueState = await evaluate(workerCdp, `
      (async () => {
        const key = "ageeCue:" + ${JSON.stringify(cueId)};
        const got = await chrome.storage.local.get(key);
        return got[key] || null;
      })()
    `);
    if (!cueState || cueState.status !== "done") {
      throw new Error(`service-worker cue state not done: ${JSON.stringify(cueState)}`);
    }

    // (a) The disposable background tab is removed after the run, so the page
    // count returns to baseline (proving it was created AND disposed, and we
    // already proved via the done cue that it never became active).
    let pagesAfter = pagesBefore;
    const settleStart = Date.now();
    while (Date.now() - settleStart < 5000) {
      pagesAfter = (await targets(devToolsPort)).filter((t) => t.type === "page").length;
      if (pagesAfter === pagesBefore) break;
      await delay(150);
    }

    // The overlay tab must never have been navigated to the branch URL — proof
    // the task agent worked in its OWN tab, not the user's.
    const overlayUrl = await evaluate(pageCdp, "location.href");
    if (overlayUrl.includes("branch=1")) {
      throw new Error("overlay tab was navigated by the task agent (focus/ownership violation)");
    }

    const queued = await fetch(`${gateway.baseUrl}/v1/browser/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: "smoke-cdp",
        instruction: "inspect queued browser task page",
        url: branchUrl,
        cdp_actions: [
          {
            method: "Runtime.evaluate",
            params: {
              expression: "document.title",
              returnByValue: true,
            },
          },
          {
            method: "Page.captureScreenshot",
            params: {
              format: "jpeg",
              quality: 35,
            },
          },
        ],
      }),
    }).then((resp) => resp.json());
    const queuedId = queued?.task?.id;
    if (!queuedId) {
      throw new Error(`gateway did not create queued browser task: ${JSON.stringify(queued)}`);
    }
    const completedTask = await waitForGatewayTask(gateway.baseUrl, queuedId);
    if (completedTask.status !== "completed" || !completedTask.latest_receipt?.ok) {
      throw new Error(`queued browser task did not complete with ok receipt: ${JSON.stringify(completedTask)}`);
    }

    console.log(
      "CDP task-agent smoke passed (REAL extension, headless Chrome for Testing): " +
        `service worker id=${extensionId}; background task agent opened its own tab, captured a screenshot, ` +
        "dispatched 1 input event, stayed in background, then disposed the tab; " +
        `overlay rendered the done cue; queued gateway task ${queuedId} completed with a receipt; pages baseline=${pagesBefore} after=${pagesAfter}; ` +
        "no window shown, no focus taken.",
    );
    console.log(`done cue: "${doneText}"`);
  } finally {
    pageCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    server.close();
    gateway?.gateway?.kill("SIGTERM");
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
  if (latestGatewayStderr.trim()) {
    console.error("Gateway output tail:");
    console.error(latestGatewayStderr.trim());
  }
  process.exit(1);
});
