const params = new URLSearchParams(location.search);
const server = params.get("server") || "http://localhost:7777";
const statusEl = document.getElementById("status");
const reloadExtensionButton = document.getElementById("reload-extension");
const reloadLocalhostButton = document.getElementById("reload-localhost");

let currentVersion = null;
let polling = true;

function writeStatus(lines) {
  statusEl.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines);
}

async function loadVersion() {
  const resp = await fetch(`${server}/__agee-dev/version?ts=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`dev server returned ${resp.status}`);
  return resp.json();
}

async function reloadLocalhostTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://localhost/*", "http://127.0.0.1/*"] });
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.reload(tab.id)));
  return tabs.length;
}

async function reloadExtension(reason) {
  polling = false;
  sessionStorage.setItem("agee-dev-reloading", reason);
  writeStatus([
    `Reloading extension: ${reason}`,
    "Chrome will refresh this dev bridge after the extension restarts.",
  ]);
  try {
    await reloadLocalhostTabs();
  } catch {}
  chrome.runtime.reload();
  setTimeout(() => location.reload(), 1000);
}

async function poll() {
  if (!polling) return;
  try {
    const info = await loadVersion();
    if (currentVersion === null) {
      currentVersion = info.version;
      const previous = sessionStorage.getItem("agee-dev-reloading");
      sessionStorage.removeItem("agee-dev-reloading");
      writeStatus([
        "Connected.",
        `Dev server: ${server}`,
        `Version: ${info.version}`,
        `Changed: ${info.changedAt}`,
        previous ? `Previous reload: ${previous}` : "Watching for extension file changes...",
      ]);
    } else if (info.version !== currentVersion) {
      await reloadExtension(`change ${currentVersion} -> ${info.version}`);
      return;
    }
  } catch (error) {
    writeStatus([
      "Waiting for dev server...",
      `Dev server: ${server}`,
      String(error.message || error),
    ]);
  }
  setTimeout(poll, 900);
}

reloadExtensionButton.addEventListener("click", () => reloadExtension("manual reload"));
reloadLocalhostButton.addEventListener("click", async () => {
  const count = await reloadLocalhostTabs();
  writeStatus(`Reloaded ${count} localhost tab(s).`);
});

poll();
