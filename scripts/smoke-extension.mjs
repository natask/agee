import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const profilePath = join(tmpdir(), `agee-chrome-${Date.now()}`);
let latestChromeStderr = "";

if (!existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}`);
}

function serve() {
  const server = createServer(async (req, res) => {
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

async function waitForFile(path, timeoutMs = 10000) {
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

async function waitForTarget(port, predicate, timeoutMs = 10000) {
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

async function injectContentHarness(cdp) {
  const css = readFileSync(join(root, "extension/overlay.css"), "utf8");
  const content = readFileSync(join(root, "extension/content.js"), "utf8");
  await evaluate(cdp, `
    window.__ageeMessages = [];
    window.chrome = {
      runtime: {
        sendMessage(message) {
          window.__ageeMessages.push(message);
          return Promise.resolve({ ok: true });
        },
        onMessage: {
          addListener(listener) {
            window.__ageeListener = listener;
          }
        }
      },
      storage: {
        local: {
          get(defaults, callback) {
            callback(defaults || {});
          },
          set() {}
        }
      }
    };
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    document.documentElement.appendChild(style);
    true;
  `);
  await cdp.send("Runtime.evaluate", {
    expression: `${content}\n//# sourceURL=agee-content.js`,
    awaitPromise: true,
    returnByValue: true,
  });
  await evaluate(cdp, `
    window.__ageeSend = (message) => new Promise((resolve) => {
      window.__ageeListener(message, {}, resolve);
    });
    true;
  `);
}

async function waitForEval(cdp, expression, timeoutMs = 10000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdp, expression);
    if (lastValue) return true;
    await delay(100);
  }
  const href = await evaluate(cdp, "location.href").catch(() => "(unknown)");
  const readyState = await evaluate(cdp, "document.readyState").catch(() => "(unknown)");
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(lastValue)} href=${href} readyState=${readyState}`);
}

async function main() {
  const { server, port: serverPort } = await serve();
  mkdirSync(profilePath, { recursive: true });

  const demoUrl = `http://localhost:${serverPort}/fixtures/demo.html`;
  const chrome = spawn(chromePath, [
    `--user-data-dir=${profilePath}`,
    `--load-extension=${extensionPath}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--enable-logging=stderr",
    "--start-minimized",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stderr.on("data", (chunk) => {
    latestChromeStderr += chunk.toString();
    latestChromeStderr = latestChromeStderr.slice(-4000);
  });

  let pageCdp;
  let workerCdp;
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page");

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: demoUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(demoUrl)}) && document.readyState === "complete"`);

    try {
      await waitForEval(pageCdp, "Boolean(window.__ageeLoaded)");
    } catch (error) {
      if (latestChromeStderr.includes("--load-extension is not allowed")) {
        await injectContentHarness(pageCdp);
      } else {
      const allTargets = await targets(devToolsPort);
      throw new Error(`${error.message}\nTargets: ${JSON.stringify(allTargets.map((target) => ({
        type: target.type,
        title: target.title,
        url: target.url,
      })), null, 2)}`);
      }
    }
    await evaluate(pageCdp, `
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
      true;
    `);
    const overlayOpen = await evaluate(pageCdp, "Boolean(document.querySelector('#agee-root.agee-open'))");
    if (!overlayOpen) throw new Error("overlay did not open");

    const workerResult = await evaluate(pageCdp, `
      (async () => {
        const snapshot = await window.__ageeSend({ cmd: "snapshot" });
        const inputIndex = snapshot.elements.find((el) => el.tag === "input" && el.label.includes("Type something"));
        const buttonIndex = snapshot.elements.find((el) => el.tag === "button" && el.label === "Search");
        if (!inputIndex || !buttonIndex) return { ok: false, error: "expected demo controls missing", snapshot };
        await window.__ageeSend({ cmd: "act", action: "type", index: inputIndex.i, text: "browser agent" });
        await window.__ageeSend({ cmd: "act", action: "click", index: buttonIndex.i });
        return { ok: true, elements: snapshot.elements.length };
      })();
    `);
    if (!workerResult?.ok) throw new Error(workerResult?.error || "worker smoke failed");

    const screenshot = await pageCdp.send("Page.captureScreenshot", { format: "jpeg", quality: 40 });
    if (!screenshot?.data) throw new Error("page screenshot capture failed");

    const resultText = await evaluate(pageCdp, "document.querySelector('#results').textContent");
    if (resultText !== "Searched Docs: browser agent") {
      throw new Error(`unexpected demo result: ${resultText}`);
    }

    const mode = latestChromeStderr.includes("--load-extension is not allowed") ? "content harness" : "extension";
    console.log(`extension smoke passed (${mode}): ${workerResult.elements} elements observed, screenshot captured, action executed`);
  } finally {
    pageCdp?.close();
    workerCdp?.close();
    server.close();
    chrome.kill("SIGTERM");
    await delay(300);
    rmSync(profilePath, { recursive: true, force: true });
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
