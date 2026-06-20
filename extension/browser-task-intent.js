// Detect typed requests that should launch the browser task-agent path.
// The service worker owns execution; this module only extracts a safe http(s)
// target from natural language.

const ACTION_RE = /\b(open|visit|go to|navigate to|load)\b/i;
const REPORT_RE = /\b(report|summari[sz]e|describe|check|find|look up|read|tell me|what(?:'s| is)?|inspect)\b/i;
const FULL_HTTP_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const LOCALHOST_RE = /\b(?:localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s<>"']*)?/i;
const DOMAIN_RE = /\b(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s<>"']*)?/i;

function parseBrowserTaskIntent(text) {
  const raw = String(text || "").trim();
  if (!raw || !ACTION_RE.test(raw) || !REPORT_RE.test(raw)) {
    return null;
  }
  const url = extractHttpUrl(raw);
  if (!url) return null;
  return { url, instruction: raw };
}

function extractHttpUrl(text) {
  const raw = String(text || "");
  const explicit = raw.match(FULL_HTTP_RE)?.[0];
  if (explicit) return normalizeHttpUrl(explicit);

  const local = raw.match(LOCALHOST_RE)?.[0];
  if (local) return normalizeHttpUrl(`http://${local}`);

  const domain = raw.match(DOMAIN_RE)?.[0];
  if (domain) return normalizeHttpUrl(`https://${domain}`);

  return null;
}

function normalizeHttpUrl(value) {
  const token = String(value || "")
    .trim()
    .replace(/^[<("']+/, "")
    .replace(/[>)"',.;!?]+$/g, "");
  try {
    const url = new URL(token);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export { parseBrowserTaskIntent, extractHttpUrl };
