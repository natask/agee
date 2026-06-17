// agee (tweaks) — background. One model call that turns a request + page summary
// into a website tweak (CSS/JS). BYO key. No agent loop.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-4-8";

const SYSTEM = `You modify the web page the user is currently looking at.

You receive the user's request and a compact summary of the page (url, title, an outline of notable elements with their tag/id/classes). Return STRICT JSON, nothing else:
{
  "name": "<=4 word label for this tweak",
  "css": "CSS applied to the page via a <style> tag (use this for hiding, recoloring, resizing, repositioning, fonts, layout)",
  "js": "optional JS that runs against the live DOM (document.querySelectorAll etc.) for changes CSS can't do; '' if not needed",
  "explanation": "one short sentence on what you changed"
}

Rules:
- Prefer CSS. Only use js for DOM changes CSS cannot express.
- Use selectors grounded in the provided outline; if unsure, target by visible structure (e.g. common cookie-banner / header patterns).
- Keep it minimal and reversible. No network requests, no external resources, no data exfiltration.
- If the request is unclear or impossible, set css and js to "" and explain why in "explanation".`;

async function getConfig() {
  const { ageeApiKey, ageeModel } = await chrome.storage.local.get(["ageeApiKey", "ageeModel"]);
  return { apiKey: ageeApiKey, model: ageeModel || DEFAULT_MODEL };
}

function extractJson(text) {
  // Tolerate code fences / stray prose around the JSON object.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON.");
  return JSON.parse(raw.slice(start, end + 1));
}

async function generateTweak({ prompt, page }) {
  const { apiKey, model } = await getConfig();
  if (!apiKey) return { error: "No API key set. Open agee setup (toolbar icon) and add your key." };

  const userText =
    `REQUEST: ${prompt}\n\n` +
    `PAGE\nurl: ${page.url}\ntitle: ${page.title}\nOUTLINE:\n${page.outline}`;

  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { error: `API ${resp.status}: ${body.slice(0, 200)}` };
    }
    const data = await resp.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const tweak = extractJson(text);
    return {
      tweak: {
        name: tweak.name || "Tweak",
        css: tweak.css || "",
        js: tweak.js || "",
        explanation: tweak.explanation || "",
      },
    };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.cmd === "generate") {
    generateTweak(msg).then(reply);
    return true; // async
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
