const keyEl = document.getElementById("key");
const modelEl = document.getElementById("model");
const gatewayUrlEl = document.getElementById("gatewayUrl");
const gatewayTokenEl = document.getElementById("gatewayToken");
const statusEl = document.getElementById("status");

chrome.storage.local
  .get(["ageeApiKey", "ageeModel", "ageeGatewayUrl", "ageeGatewayToken"])
  .then(({ ageeApiKey, ageeModel, ageeGatewayUrl, ageeGatewayToken }) => {
    if (ageeApiKey) keyEl.value = ageeApiKey;
    modelEl.value = ageeModel || "claude-opus-4-8";
    if (ageeGatewayUrl) gatewayUrlEl.value = ageeGatewayUrl;
    if (ageeGatewayToken) gatewayTokenEl.value = ageeGatewayToken;
  });

function normalizeGatewayUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function flash(text, ok = true) {
  statusEl.textContent = text;
  statusEl.style.color = ok ? "#35a35a" : "#c0392b";
}

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    ageeApiKey: keyEl.value.trim(),
    ageeModel: modelEl.value.trim() || "claude-opus-4-8",
    ageeGatewayUrl: normalizeGatewayUrl(gatewayUrlEl.value),
    ageeGatewayToken: gatewayTokenEl.value.trim(),
  });
  flash("Saved ✓");
  setTimeout(() => (statusEl.textContent = ""), 1500);
});

document.getElementById("testGateway").addEventListener("click", async () => {
  const url = normalizeGatewayUrl(gatewayUrlEl.value);
  if (!url) {
    flash("Enter a gateway URL first.", false);
    return;
  }
  flash("Testing…");
  try {
    const token = gatewayTokenEl.value.trim();
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const resp = await fetch(`${url}/health`, { headers });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      flash(`OK ✓ ${data.provider || "provider"} · ${data.model || "model"}`);
    } else {
      flash(`Gateway responded ${resp.status}`, false);
    }
  } catch (err) {
    flash(`Unreachable: ${String(err.message || err)}`, false);
  }
});
