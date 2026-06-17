import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

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

server.listen(port, host, () => {
  watchForChanges();
  printReady();
  if (options.open) openChrome(devUrl);
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
  }, 100);
}

function injectLiveReload(html) {
  if (html.includes("__ageeDevLiveReload")) return html;
  const snippet = `<script>
(() => {
  const endpoint = ${JSON.stringify(devUrl)}/replace(/\\/$/, "") + "/__agee-dev/version";
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

function printReady() {
  console.log("");
  console.log("[agee-dev] dev server ready");
  console.log(`[agee-dev] demo page:      ${devUrl}/fixtures/demo.html`);
  console.log(`[agee-dev] extension path: ${extensionDir}`);
  console.log("");
  console.log("One-time Chrome setup:");
  console.log("  1. Open chrome://extensions");
  console.log("  2. Enable Developer mode");
  console.log(`  3. Load unpacked: ${extensionDir}`);
  console.log("  4. Copy the extension id from the agee card");
  console.log("  5. Open:");
  console.log(`     chrome-extension://<extension-id>/dev.html?server=${devUrl}`);
  console.log("");
  console.log("Keep that dev bridge page open. Edits under extension/ reload the extension.");
  console.log("The localhost demo page reloads itself when this server sees a change.");
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

function openChrome(url) {
  if (process.platform !== "darwin") return;
  spawnSync("open", ["-a", "Google Chrome", url], { stdio: "ignore" });
}

function shutdown() {
  for (const watcher of watchers) watcher.close();
  server.close(() => process.exit(0));
}

function parseArgs(args) {
  const parsed = { host: "localhost", open: false, port: 7777 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--host") parsed.host = args[++i] || parsed.host;
    else if (arg.startsWith("--host=")) parsed.host = arg.slice("--host=".length);
    else if (arg === "--port") parsed.port = args[++i] || parsed.port;
    else if (arg.startsWith("--port=")) parsed.port = arg.slice("--port=".length);
    else if (arg === "--open") parsed.open = true;
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
  npm run dev
  npm run dev -- --port 7777
  npm run dev -- --open

Runs a localhost demo server and watches extension/ + fixtures/.
Keep extension/dev.html open to reload the unpacked extension on file changes.`);
}
