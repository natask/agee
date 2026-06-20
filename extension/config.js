const DEFAULT_GATEWAY_URL = "http://10.147.17.10:8788";
const LEGACY_DEFAULT_GATEWAY_URLS = new Set(["http://10.147.17.10:8787"]);

let bakedCache = null;

function normalizeGatewayUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeDefaultGatewayUrl(value) {
  const url = normalizeGatewayUrl(value);
  if (!url || LEGACY_DEFAULT_GATEWAY_URLS.has(url)) return DEFAULT_GATEWAY_URL;
  return url;
}

function effectiveGatewayUrl(storedValue, bakedValue) {
  const stored = normalizeGatewayUrl(storedValue);
  if (!stored || LEGACY_DEFAULT_GATEWAY_URLS.has(stored)) return bakedValue;
  return stored;
}

async function getBakedConfig() {
  if (bakedCache) return bakedCache;
  try {
    const resp = await fetch(chrome.runtime.getURL("agee.config.json"));
    if (resp.ok) {
      const cfg = await resp.json();
      bakedCache = {
        gatewayUrl: normalizeDefaultGatewayUrl(cfg.gatewayUrl),
        gatewayToken: String(cfg.gatewayToken || ""),
      };
      return bakedCache;
    }
  } catch {
    // Missing local config is normal on a fresh checkout. The gateway URL still
    // defaults to the main-machine endpoint; the token can be added later.
  }
  bakedCache = { gatewayUrl: DEFAULT_GATEWAY_URL, gatewayToken: "" };
  return bakedCache;
}

async function seedGatewayConfig() {
  const baked = await getBakedConfig();
  const cur = await chrome.storage.local.get(["ageeGatewayUrl", "ageeGatewayToken"]);
  const curUrl = normalizeGatewayUrl(cur.ageeGatewayUrl);
  const patch = {};
  if (!curUrl || LEGACY_DEFAULT_GATEWAY_URLS.has(curUrl)) {
    patch.ageeGatewayUrl = baked.gatewayUrl;
  }
  if (!cur.ageeGatewayToken && baked.gatewayToken) {
    patch.ageeGatewayToken = baked.gatewayToken;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return patch;
}

async function getEffectiveGatewayConfig() {
  const stored = await chrome.storage.local.get(["ageeGatewayUrl", "ageeGatewayToken"]);
  const baked = await getBakedConfig();
  const hasStoredToken = Object.prototype.hasOwnProperty.call(stored, "ageeGatewayToken");
  return {
    gatewayUrl: effectiveGatewayUrl(stored.ageeGatewayUrl, baked.gatewayUrl),
    gatewayToken: String(hasStoredToken ? stored.ageeGatewayToken || "" : baked.gatewayToken || ""),
  };
}

export {
  DEFAULT_GATEWAY_URL,
  getEffectiveGatewayConfig,
  normalizeGatewayUrl,
  seedGatewayConfig,
};
