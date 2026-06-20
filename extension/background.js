// agee — background service worker.
// Holds the API key, runs the agent loop, talks to the page via the content script.
// The model call lives here (not the page) so we control the network boundary.

import { parseSettingsIntent, parseProfileQueryIntent } from "./settings-intent.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-4-8";

// Baked defaults so a fresh install works with no Options visit. The gateway URL
// is safe to ship in code; the token is injected locally by `npm run configure`
// into the git-ignored agee.config.json. Loaded at runtime via fetch (MV3
// service workers forbid top-level await, so no import here). A missing config
// file just means "configure has not been run yet" — the URL fallback applies.
const BAKED_FALLBACK = { gatewayUrl: "http://10.147.17.10:8788", gatewayToken: "", model: DEFAULT_MODEL };
let bakedCache = null;

async function getBaked() {
  if (bakedCache) return bakedCache;
  try {
    const resp = await fetch(chrome.runtime.getURL("agee.config.json"));
    if (resp.ok) {
      const cfg = await resp.json();
      bakedCache = {
        gatewayUrl: String(cfg.gatewayUrl || BAKED_FALLBACK.gatewayUrl),
        gatewayToken: String(cfg.gatewayToken || ""),
        model: String(cfg.model || DEFAULT_MODEL),
      };
      return bakedCache;
    }
  } catch {
    // No local config yet; the URL fallback keeps the agent usable for any
    // endpoint that does not require the token (e.g. /health).
  }
  bakedCache = { ...BAKED_FALLBACK };
  return bakedCache;
}

// Seed storage from the baked defaults on install/update so the Options page
// shows the live values and the user never has to fill them in by hand. Only
// fills blanks — a value the user typed always wins.
chrome.runtime.onInstalled.addListener(async () => {
  const baked = await getBaked();
  const cur = await chrome.storage.local.get(["ageeGatewayUrl", "ageeGatewayToken", "ageeModel"]);
  const patch = {};
  if (!cur.ageeGatewayUrl && baked.gatewayUrl) patch.ageeGatewayUrl = baked.gatewayUrl;
  if (!cur.ageeGatewayToken && baked.gatewayToken) patch.ageeGatewayToken = baked.gatewayToken;
  if (!cur.ageeModel && baked.model) patch.ageeModel = baked.model;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});
const MAX_STEPS = 20;
const MAX_ELEMENTS = 100;
const ALLOWED_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
// Cues run concurrently: the user keeps talking, each utterance is its own lane.
// Keyed by cueId (a per-cue string), each value is { controller, tabId } so we
// can cancel one cue or all cues on a tab without blocking new ones.
const tasks = new Map();

const SYSTEM_PROMPT = `You are agee, an agent that operates a web browser on the user's behalf.

Each turn you receive: the page URL/title, a numbered list of interactable elements, and a screenshot.
Decide the single next action that moves toward the user's goal, then call a tool.

Rules:
- Refer to elements by their index from the list.
- Prefer one concrete action per turn. After it runs you get a fresh snapshot.
- To type into a field, click it first if it is not already focused, or use action "type" which focuses by index.
- When the goal is achieved (or you are blocked and need the user), call "finish" with a short summary.
- Be decisive. Do not narrate options you won't take.`;

const DESCRIBE_PROMPT = `You are agee, a concise browser companion.

Describe the current page from the user's point of view. Use the supplied page metadata, visible controls, and screenshot. Do not suggest actions unless they are obvious next steps available on the page. Do not claim you clicked, typed, navigated, or changed anything.`;

const TOOLS = [
  {
    name: "act",
    description: "Perform one action in the browser.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "type", "clear", "select", "scroll", "navigate", "key", "wait"],
          description:
            "click/type/clear/select target element by index; scroll the page; navigate to a url; key presses a key (e.g. Enter); wait pauses briefly.",
        },
        index: { type: "integer", description: "Element index for click/type/clear/select." },
        text: { type: "string", description: "Text to type, option label to select, or key to press." },
        url: { type: "string", description: "Absolute URL for navigate." },
        direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
      },
      required: ["action"],
    },
  },
  {
    name: "finish",
    description: "End the task: goal achieved, or blocked and handing control back to the user.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", description: "One or two sentences on what happened." } },
      required: ["summary"],
    },
  },
];

async function getConfig() {
  const { ageeApiKey, ageeModel, ageeGatewayUrl, ageeGatewayToken } = await chrome.storage.local.get([
    "ageeApiKey",
    "ageeModel",
    "ageeGatewayUrl",
    "ageeGatewayToken",
  ]);
  // Fall back to the baked defaults so the agent works before storage is seeded
  // (e.g. the very first turn after install, or on a page that loaded the worker
  // before onInstalled ran). A stored value always overrides the default.
  const baked = await getBaked();
  return {
    apiKey: ageeApiKey,
    model: ageeModel || baked.model || DEFAULT_MODEL,
    gatewayUrl: String(ageeGatewayUrl || baked.gatewayUrl || "").replace(/\/+$/, ""),
    gatewayToken: String(ageeGatewayToken || baked.gatewayToken || ""),
  };
}

// Pipe a request into the user's own agent gateway instead of the model vendor.
// Returns the parsed JSON body for the given path (e.g. "/v1/chat", "/health").
async function callGateway(cfg, path, { method = "POST", body, signal } = {}) {
  if (!cfg.gatewayUrl) {
    throw new Error("No gateway URL set. Open agee Options and set the Agent gateway URL.");
  }
  const headers = { "content-type": "application/json" };
  if (cfg.gatewayToken) headers.authorization = `Bearer ${cfg.gatewayToken}`;
  const resp = await fetch(`${cfg.gatewayUrl}${path}`, {
    method,
    signal,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new Error(
        "Gateway rejected the token (401). Open agee Options and set a valid Gateway token, then Save."
      );
    }
    throw new Error(`gateway ${resp.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gateway returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function gatewayHealth(cfg, signal) {
  return callGateway(cfg, "/health", { method: "GET", signal });
}

// ---- Router activation loop (the gateway side of a branch) -----------------
// The sterile router on the gateway launches a disposable agent run and never
// speaks. We POST the intent to /v1/router/activate (202 + run id), then poll
// /v1/router/activations/:id for the durable router_ping the gateway emits on
// completion. This is the loop the integration fuses to the CDP task agent: the
// gateway tracks + pings the run, the browser does the actual page work.
//
// `parentRunId` threads fan-out lineage so two concurrent activations share a
// parent. The harness/echo output stays a proposal — we only render its summary.
async function routerActivate(cfg, { intent, screen, parentRunId, signal }) {
  const body = { intent, source: "agee-extension" };
  if (screen) body.screen = screen;
  if (parentRunId) body.parent_run_id = parentRunId;
  const activation = await callGateway(cfg, "/v1/router/activate", { signal, body });
  const runId = activation && (activation.run_id || activation.activation_id);
  if (!runId) throw new Error("router activate returned no run id");
  return { runId, statusUrl: activation.status_url || `/v1/router/activations/${runId}` };
}

// Poll a router activation until its durable router_ping appears (or timeout).
// Returns the ping event { type:"router_ping", ok, run_status, summary, ... }.
async function waitForRouterPing(cfg, runId, signal, { timeoutMs = 12000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    last = await callGateway(cfg, `/v1/router/activations/${runId}`, { method: "GET", signal });
    if (last && last.ping) return last.ping;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`router activation ${runId} did not ping in time`);
}

// ---- Runtime agent profile (the settings the agent reads/writes) ----------
// Cache key shared with the options page so a change applied here refreshes an
// open settings surface live (chrome.storage.onChanged).
const PROFILE_CACHE_KEY = "ageeProfileCache";

// Read the effective profile from the gateway (GET /v1/agent/profile).
async function getGatewayProfile(cfg, signal) {
  return callGateway(cfg, "/v1/agent/profile", { method: "GET", signal });
}

// Patch + persist a profile change through the gateway (PUT /v1/agent/profile)
// and cache the authoritative result so the settings surface stays in sync.
async function putGatewayProfile(cfg, patch, signal, source = "agee-extension") {
  const payload = await callGateway(cfg, "/v1/agent/profile", {
    method: "PUT",
    signal,
    body: { profile: patch, source },
  });
  await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: payload });
  return payload;
}

// Read the queryable prompt-change history from the gateway.
async function getGatewayProfileHistory(cfg, signal) {
  return callGateway(cfg, "/v1/agent/profile/history?system_prompt_only=1&limit=50", { method: "GET", signal });
}

// "Change settings by talking to the agent": if the instruction is a settings
// request, turn it into a concrete profile patch and apply it through the
// gateway profile endpoints, then render a confirmation. Returns true when the
// instruction was handled as a settings change (so the caller skips the normal
// conversational turn); false otherwise.
async function maybeApplySettingsChange(tabId, instruction, cfg, signal, cueId) {
  // A quick pre-check avoids a profile GET for ordinary commands: only fetch
  // the current profile (needed for relative changes like "be terser") when the
  // text already looks like a settings intent given gateway defaults.
  let current = null;
  if (!parseSettingsIntent(instruction, current)) {
    return false;
  }
  try {
    const profilePayload = await getGatewayProfile(cfg, signal);
    current = profilePayload?.profile || null;
    await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: profilePayload });
  } catch {
    // Fall back to defaults-based parsing if the GET fails; the PUT below will
    // surface any real gateway error loudly.
  }

  const intent = parseSettingsIntent(instruction, current);
  if (!intent) return false;

  await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "applying settings change", tabId });
  send(tabId, { cmd: "progress", cueId, text: "updating settings…" });
  throwIfAborted(signal);

  await putGatewayProfile(cfg, intent.patch, signal, "agee-extension");
  const summary = `Settings updated — ${intent.summary}. It takes effect on the next turn.`;
  send(tabId, { cmd: "done", cueId, summary });
  await saveTaskState(cueId, { status: "done", instruction, step: 1, lastResult: summary.slice(0, 400), tabId });
  return true;
}

// "What prompts have I set?" / "how many system prompts?" → answer from the
// gateway's prompt-change history instead of running a model turn.
async function maybeAnswerProfileQuery(tabId, instruction, cfg, signal, cueId) {
  if (!parseProfileQueryIntent(instruction)) {
    return false;
  }
  send(tabId, { cmd: "progress", cueId, text: "checking prompt history…" });
  throwIfAborted(signal);
  let data;
  try {
    data = await getGatewayProfileHistory(cfg, signal);
  } catch (error) {
    send(tabId, { cmd: "error", cueId, text: `Could not read prompt history: ${String(error?.message || error)}` });
    return true;
  }
  const count = Number(data?.system_prompt_changes || 0);
  const entries = Array.isArray(data?.history) ? data.history : [];
  const lines = [
    count === 0
      ? "You haven't set any system prompts yet."
      : `You've set ${count} system prompt${count === 1 ? "" : "s"}.`,
  ];
  if (data?.current_system_prompt) {
    lines.push(`Current: "${truncate(data.current_system_prompt, 160)}"`);
  }
  entries.slice(0, 5).forEach((entry, i) => {
    const when = String(entry.ts || "").replace("T", " ").slice(0, 16);
    lines.push(`${i + 1}. [${when}] ${truncate(entry.system_prompt || "", 120)}`);
  });
  const summary = lines.join("\n");
  send(tabId, { cmd: "done", cueId, summary, speak: lines[0] });
  await saveTaskState(cueId, { status: "done", instruction, step: 1, lastResult: summary.slice(0, 400), tabId });
  return true;
}

function truncate(text, max) {
  const t = String(text || "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// One session id per cue. Each cue is its own conversation lane on the gateway —
// this is what lets the user keep cueing ("do X", "now Y", "also Z") and have
// each routed independently underneath instead of forced into one thread.
function sessionIdForCue(cueId) {
  return `agee_${String(cueId || "").replace(/[^a-zA-Z0-9_]/g, "") || Date.now().toString(36)}`;
}

// One stable session id for the whole conversation, persisted in
// chrome.storage.local. Conversational turns share this id so the gateway
// accumulates them under one session and the overlay can reload chat history
// across reopens. Per-cue/branch distinction is preserved via branch_id (the
// cueId), not by minting a throwaway session per message. Not a secret.
async function getStableSessionId() {
  const { ageeSessionId } = await chrome.storage.local.get("ageeSessionId");
  if (ageeSessionId) return ageeSessionId;
  const sessionId = `agee_${crypto.randomUUID()}`;
  await chrome.storage.local.set({ ageeSessionId: sessionId });
  return sessionId;
}

// Read the persisted conversation's ordered turns from the gateway so the
// overlay can render prior turns when it reopens. Returns [] when nothing is
// configured/stored yet (a fresh conversation simply has no history).
async function loadHistory(cfg) {
  if (!cfg.gatewayUrl) return [];
  const sessionId = await getStableSessionId();
  const data = await callGateway(cfg, `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: "GET",
  });
  return Array.isArray(data?.turns) ? data.turns : [];
}

// Conversational turn through the user's gateway (/v1/voice/turns).
// The gateway classifies chat vs. home-machine agent runs and replies with
// display text; we render it. Page-DOM actions are a later wave.
async function runViaGateway(tabId, instruction, cfg, signal, cueId) {
  await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "sending to gateway", tabId });
  send(tabId, { cmd: "progress", cueId, text: "thinking…" });
  throwIfAborted(signal);

  let screen;
  try {
    const snap = await ask(tabId, { cmd: "snapshot" });
    screen = snapToScreen(snap);
  } catch {
    screen = undefined; // restricted page; send without screen context
  }

  throwIfAborted(signal);
  // Share one stable session+conversation id across turns so the gateway
  // accumulates them (and the overlay can reload them). The cueId becomes the
  // branch_id, preserving per-cue distinction without fragmenting the session.
  const sessionId = await getStableSessionId();
  const data = await callGateway(cfg, "/v1/voice/turns", {
    signal,
    body: {
      source: "agee-extension",
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: cueId,
      transcript: instruction,
      screen,
    },
  });

  const reply = String(data.display || data.text || data.speak || "").trim();
  // The gateway returns a separate TTS-safe `speak` string (short, markdown-
  // stripped). Forward it so the overlay can speak the reply aloud; the gateway
  // decides when to stay silent by sending an empty speak (e.g. control turns).
  const speak = String(data.speak || "").trim();
  const runs = Array.isArray(data.agent_runs) ? data.agent_runs : [];
  const summary = reply || (runs.length ? `Started ${runs.length} agent run(s).` : "Done.");
  send(tabId, { cmd: "done", cueId, summary, speak });
  await saveTaskState(cueId, {
    status: "done",
    instruction,
    step: 1,
    tabId,
    lastResult: `[${data.classification || "chat"}] ${summary.slice(0, 400)}`,
  });
}

function send(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function ask(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { cmd: "ping" });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Task cancelled.");
}

// Persist per-cue state (keyed by cueId) so concurrent cues don't clobber each
// other. Falls back to a synthetic key when no id is given.
async function saveTaskState(id, patch) {
  const key = `ageeCue:${id || "default"}`;
  const previous = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({
    [key]: {
      ...previous,
      ...patch,
      cueId: id,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function captureScreenshot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
    return dataUrl.split(",")[1]; // strip data: prefix
  } catch {
    return null;
  }
}

function elementsText(snap) {
  const lines = (snap.elements || []).slice(0, MAX_ELEMENTS).map((e) => `[${e.i}] <${e.tag}${e.type ? " " + e.type : ""}> ${e.label}`);
  return `URL: ${snap.url}\nTITLE: ${snap.title}\nINTERACTABLE ELEMENTS:\n${lines.join("\n") || "(none found)"}`;
}

async function snapshotBlocks(tabId, signal) {
  throwIfAborted(signal);
  const snap = await ask(tabId, { cmd: "snapshot" });
  const blocks = [{ type: "text", text: elementsText(snap) }];
  throwIfAborted(signal);
  const shot = await captureScreenshot(tabId);
  if (shot) blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot } });
  return blocks;
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 8000);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 400);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function confirmNavigation(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  const from = tab.url ? new URL(tab.url).origin : "";
  const to = url.origin;
  if (from === to) return true;
  try {
    const response = await ask(tabId, {
      cmd: "confirm",
      text: `Allow agee to navigate from ${from || "this page"} to ${to}?`,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function executeAction(tabId, input, signal) {
  throwIfAborted(signal);
  if (input.action === "navigate" && input.url) {
    let url;
    try {
      url = new URL(input.url);
    } catch {
      return `blocked invalid URL: ${input.url}`;
    }
    if (!ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol)) {
      return `blocked navigation to ${url.protocol}`;
    }
    if (!(await confirmNavigation(tabId, url))) {
      return `user cancelled navigation to ${url.origin}`;
    }
    throwIfAborted(signal);
    await chrome.tabs.update(tabId, { url: url.href });
    await waitForLoad(tabId);
    return "navigated";
  }
  if (input.action === "wait") {
    await new Promise((r) => setTimeout(r, 1000));
    return "waited";
  }
  let result;
  try {
    result = await ask(tabId, { cmd: "act", ...input });
  } catch {
    // Page likely navigated and tore down the content script.
    await waitForLoad(tabId);
    return "action sent; page navigated";
  }
  // Settle: clicks/typing may trigger navigation or async updates.
  await new Promise((r) => setTimeout(r, 700));
  return (result && result.result) || "done";
}

async function callClaude({ apiKey, model }, messages, signal, { system = SYSTEM_PROMPT, tools = TOOLS } = {}) {
  const body = { model, max_tokens: 1500, system, messages };
  if (tools?.length) body.tools = tools;
  const resp = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

// Map a page snapshot into the gateway's screen-context shape so the same
// home-machine context format works for browser and Android surfaces.
function snapToScreen(snap) {
  const nodes = (snap.elements || []).slice(0, MAX_ELEMENTS).map((e) => ({
    text: e.label,
    clickable: true,
  }));
  return {
    available: true,
    package: snap.url || "",
    class: snap.title || "",
    summary: elementsText(snap),
    nodes,
  };
}

async function describePageViaGateway(tabId, cfg, signal, cueId) {
  await saveTaskState(cueId, { status: "running", instruction: "Describe this page", step: 0, lastResult: "reading page (gateway)", tabId });
  send(tabId, { cmd: "progress", cueId, text: "reading the page…" });
  throwIfAborted(signal);
  const snap = await ask(tabId, { cmd: "snapshot" });
  throwIfAborted(signal);
  const data = await callGateway(cfg, "/v1/chat", {
    signal,
    body: {
      source: "agee-extension",
      screen: snapToScreen(snap),
      messages: [
        { role: "user", content: "Describe this page in 3-5 compact bullets. Include what it is and what the user can do here. Do not claim you took any action." },
      ],
    },
  });
  const text = String(data.text || "").trim() || "The gateway returned an empty description.";
  send(tabId, { cmd: "done", cueId, summary: text });
  await saveTaskState(cueId, { status: "done", instruction: "Describe this page", step: 1, lastResult: text.slice(0, 500), tabId });
}

async function describePage(tabId, controller, cueId) {
  const signal = controller.signal;

  try {
    const cfg = await getConfig();

    // Prefer the user's own agent gateway (the pipe) when configured.
    if (cfg.gatewayUrl) {
      await describePageViaGateway(tabId, cfg, signal, cueId);
      return;
    }

    if (!cfg.apiKey) {
      send(tabId, { cmd: "error", cueId, text: "No gateway URL and no API key set. Click the agee toolbar icon -> Options to set a gateway URL or add your Anthropic key." });
      return;
    }

    await saveTaskState(cueId, { status: "running", instruction: "Describe this page", step: 0, lastResult: "reading page", tabId });
    send(tabId, { cmd: "progress", cueId, text: "reading the page…" });
    const blocks = await snapshotBlocks(tabId, signal);
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this page in 3-5 compact bullets. Include what it is and what the user can do here." },
          ...blocks,
        ],
      },
    ];
    const resp = await callClaude(cfg, messages, signal, { system: DESCRIBE_PROMPT, tools: [] });
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || "I could not describe this page.";
    send(tabId, { cmd: "done", cueId, summary: text });
    await saveTaskState(cueId, { status: "done", instruction: "Describe this page", step: 1, lastResult: text.slice(0, 500), tabId });
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : String(err.message || err);
    send(tabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction: "Describe this page", lastResult: message, tabId });
  } finally {
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

async function runAgent(tabId, instruction, controller, cueId) {
  const signal = controller.signal;

  try {
    const cfg = await getConfig();

    // Prefer the user's own agent gateway (the pipe). Conversational + home-machine
    // agent runs; customize behavior by editing the gateway's SYSTEM_PROMPT.
    if (cfg.gatewayUrl) {
      // First, see if the user is asking *about* their prompt history, then if
      // they are changing settings by talking to the agent ("be terser", "set
      // the system prompt to …"). Either is handled through the profile
      // endpoints instead of running a conversational turn.
      if (await maybeAnswerProfileQuery(tabId, instruction, cfg, signal, cueId)) {
        return;
      }
      if (await maybeApplySettingsChange(tabId, instruction, cfg, signal, cueId)) {
        return;
      }
      await runViaGateway(tabId, instruction, cfg, signal, cueId);
      return;
    }

    if (!cfg.apiKey) {
      send(tabId, { cmd: "error", cueId, text: "No gateway URL and no API key set. Click the agee toolbar icon → Options to set a gateway URL or add your Anthropic key." });
      return;
    }

    await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "started", tabId });
    send(tabId, { cmd: "progress", cueId, text: "thinking…" });
    const first = await snapshotBlocks(tabId, signal);
    const messages = [
      { role: "user", content: [{ type: "text", text: `TASK: ${instruction}` }, ...first] },
    ];
    for (let step = 0; step < MAX_STEPS; step++) {
      await saveTaskState(cueId, { status: "running", instruction, step, lastResult: "calling model", tabId });
      throwIfAborted(signal);
      const resp = await callClaude(cfg, messages, signal);
      messages.push({ role: "assistant", content: resp.content });

      const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) send(tabId, { cmd: "progress", cueId, text });
      if (text) await saveTaskState(cueId, { status: "running", instruction, step, lastResult: text.slice(0, 500), tabId });

      if (resp.stop_reason !== "tool_use") {
        send(tabId, { cmd: "done", cueId, summary: text || "Stopped." });
        await saveTaskState(cueId, { status: "done", instruction, step, lastResult: text || "Stopped.", tabId });
        return;
      }

      const toolResults = [];
      let finished = false;
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "finish") {
          send(tabId, { cmd: "done", cueId, summary: block.input.summary || "Done." });
          await saveTaskState(cueId, { status: "done", instruction, step, lastResult: block.input.summary || "Done.", tabId });
          finished = true;
          break;
        }
        const result = await executeAction(tabId, block.input, signal);
        await saveTaskState(cueId, { status: "running", instruction, step, lastResult: result, tabId });
        const snap = await snapshotBlocks(tabId, signal);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: [{ type: "text", text: `Result: ${result}` }, ...snap],
        });
      }
      if (finished) return;
      messages.push({ role: "user", content: toolResults });
    }
    send(tabId, { cmd: "done", cueId, summary: `Reached the ${MAX_STEPS}-step limit.` });
    await saveTaskState(cueId, { status: "done", instruction, step: MAX_STEPS, lastResult: `Reached the ${MAX_STEPS}-step limit.`, tabId });
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : String(err.message || err);
    send(tabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction, lastResult: message, tabId });
  } finally {
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

// ---- CDP task agent (router → disposable background-tab agent) -------------
// The product framing: a sterile router launches N disposable task agents, each
// driving its OWN background tab via chrome.debugger (Chrome DevTools Protocol).
// This is the minimal verifiable spike of ONE such agent: open a background tab
// (active:false, no focus steal), attach the debugger, navigate + screenshot +
// one input event + read a little page state over CDP, detach, dispose the tab,
// and ping the overlay "done" on the cue path the rest of the extension uses.
//
// Trust boundary: this drives a browser tab; it touches NO API keys and makes
// NO model calls. The instruction is a label for the disposable run, not an
// executable command.

const CDP_PROTOCOL_VERSION = "1.3";

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, CDP_PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach(target, () => {
        void chrome.runtime.lastError; // tolerate already-detached / gone tab
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function debuggerSend(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result || {});
    });
  });
}

// Wait until the background tab reports a non-loading state, or time out. We
// avoid focusing the tab; we only poll its status via chrome.tabs.get.
async function waitForBackgroundTabLoad(tabId, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return;
    } catch {
      return; // tab gone
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Run one disposable task agent in its own background tab. `overlayTabId` is the
// user's foreground tab whose overlay shows the cue; `instruction`/`url` come
// from the {cmd:"branch"} intent. Never activates the background tab.
//
// `opts.parentRunId` (optional) threads fan-out lineage so concurrent workers in
// one BRANCH-TO-TWO trigger share a gateway parent. When a gateway is configured
// we ALSO register a router activation for this worker: the gateway launches its
// disposable agent run, tracks it, and emits a durable router_ping the overlay
// renders. The CDP browser work and the gateway activation run concurrently; the
// gateway's harness output is a proposal we summarize, never an executable
// command.
async function runBranchTaskAgent(overlayTabId, instruction, url, controller, cueId, opts = {}) {
  const signal = controller.signal;
  let bgTabId = null;
  let attached = false;
  const target = {};
  const navUrl = (() => {
    try {
      const u = new URL(url);
      return ALLOWED_NAVIGATION_PROTOCOLS.has(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  })();

  try {
    if (!navUrl) {
      send(overlayTabId, { cmd: "error", cueId, text: `branch: blocked or invalid url: ${url}` });
      await saveTaskState(cueId, { status: "error", instruction, lastResult: `invalid url ${url}`, tabId: overlayTabId });
      return;
    }

    await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "launching background task agent", tabId: overlayTabId });
    send(overlayTabId, { cmd: "progress", cueId, text: "launching background agent…" });
    throwIfAborted(signal);

    // Fuse the two PoCs: if a gateway is configured, register a router activation
    // for this worker. The gateway launches + tracks a disposable run and emits a
    // durable router_ping; we poll for it CONCURRENTLY with the CDP browser work
    // below so neither blocks the other. Best-effort: a gateway hiccup must not
    // sink the local browser task.
    const cfg = await getConfig();
    let routerPromise = null;
    let routerRunId = null;
    if (cfg.gatewayUrl) {
      routerPromise = (async () => {
        const { runId } = await routerActivate(cfg, {
          intent: instruction,
          parentRunId: opts.parentRunId,
          signal,
        });
        routerRunId = runId;
        await saveTaskState(cueId, { status: "running", instruction, routerRunId: runId, tabId: overlayTabId });
        return waitForRouterPing(cfg, runId, signal);
      })().catch((err) => ({ error: String(err?.message || err) }));
    }

    // Disposable background tab — the agent's own surface. active:false is the
    // whole contract: it must never steal the user's focus.
    const bgTab = await chrome.tabs.create({ url: "about:blank", active: false });
    bgTabId = bgTab.id;
    target.tabId = bgTabId;

    // One debugger client per tab: attach can fail (e.g. DevTools already
    // attached). Emit an error cue instead of throwing.
    try {
      await debuggerAttach(target);
      attached = true;
    } catch (err) {
      send(overlayTabId, { cmd: "error", cueId, text: `branch: could not attach debugger (${err.message})` });
      await saveTaskState(cueId, { status: "error", instruction, lastResult: `attach failed: ${err.message}`, tabId: overlayTabId });
      return;
    }

    throwIfAborted(signal);
    await debuggerSend(target, "Page.enable");
    await debuggerSend(target, "Runtime.enable");

    send(overlayTabId, { cmd: "progress", cueId, text: "navigating background tab…" });
    await debuggerSend(target, "Page.navigate", { url: navUrl });
    await waitForBackgroundTabLoad(bgTabId);
    throwIfAborted(signal);

    // Capture a screenshot of the BACKGROUND tab over CDP (no foreground capture,
    // so the user's visible tab is untouched).
    send(overlayTabId, { cmd: "progress", cueId, text: "capturing background screenshot…" });
    const shot = await debuggerSend(target, "Page.captureScreenshot", { format: "jpeg", quality: 40 });
    const screenshotBytes = shot?.data ? shot.data.length : 0;
    if (!screenshotBytes) throw new Error("background screenshot capture returned no data");

    // Dispatch exactly ONE input event into the background tab. A keyboard event
    // is enough to prove we can drive input over CDP without focusing the tab.
    throwIfAborted(signal);
    await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });

    // Read a little page state back over CDP.
    const evalRes = await debuggerSend(target, "Runtime.evaluate", {
      expression: "JSON.stringify({ title: document.title, url: location.href, ready: document.readyState })",
      returnByValue: true,
    });
    let pageState = {};
    try {
      pageState = JSON.parse(evalRes?.result?.value || "{}");
    } catch {
      pageState = {};
    }

    // Confirm the background tab never became active (focus contract).
    let stayedBackground = true;
    try {
      const finalTab = await chrome.tabs.get(bgTabId);
      stayedBackground = finalTab.active === false;
    } catch {
      // tab already gone — treat as background (it was never surfaced)
    }

    // Await the gateway router_ping (if we started one) so the overlay reflects
    // both sides of the fused loop: the CDP browser work AND the durable router
    // ping. The ping summary is a proposal we render, never executed.
    let routerPing = null;
    if (routerPromise) {
      send(overlayTabId, { cmd: "progress", cueId, text: "awaiting router ping…" });
      routerPing = await routerPromise;
    }

    const title = pageState.title || "(untitled)";
    let summary =
      `Background task agent done — opened "${title}", captured ${Math.round(screenshotBytes / 1024)}KB screenshot, ` +
      `dispatched 1 input event${stayedBackground ? ", tab stayed in background." : " (warning: tab became active)."}`;
    if (routerPing && !routerPing.error && routerPing.summary) {
      summary += ` Router ping: ${truncate(String(routerPing.summary), 160)}`;
    } else if (routerPing && routerPing.error) {
      summary += ` (router ping unavailable: ${truncate(routerPing.error, 120)})`;
    }
    send(overlayTabId, { cmd: "done", cueId, summary });
    await saveTaskState(cueId, {
      status: "done",
      instruction,
      step: 1,
      tabId: overlayTabId,
      routerRunId,
      routerPingOk: Boolean(routerPing && !routerPing.error && routerPing.ok),
      lastResult: summary.slice(0, 400),
    });
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : `branch failed: ${String(err.message || err)}`;
    send(overlayTabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction, lastResult: message, tabId: overlayTabId });
  } finally {
    if (attached) await debuggerDetach(target);
    // Dispose the throwaway tab — task agents are disposable by design.
    if (bgTabId != null) {
      try {
        await chrome.tabs.remove(bgTabId);
      } catch {
        // tab already closed
      }
    }
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

// BRANCH-TO-TWO (the headline): one trigger fans out to N disposable task
// agents that run CONCURRENTLY, each in its OWN background tab with its OWN cue.
// Neither steals focus; each pings independently on completion; each registers
// its own gateway router activation under a shared parent run, so the gateway
// records one router_ping per worker.
//
// `branches` is an array of { instruction, url, cueId }. We start every worker
// in the same tick (no awaiting between launches) so they are genuinely
// in-flight together, then let each finish on its own lane.
async function runBranchFanout(overlayTabId, branches, controllersByCue) {
  // A shared parent gateway run ties the fan-out together as lineage. Best-effort:
  // if the gateway is down or unset, the workers still run locally.
  let parentRunId = null;
  try {
    const cfg = await getConfig();
    if (cfg.gatewayUrl) {
      const parent = await routerActivate(cfg, {
        intent: `fan-out: ${branches.length} concurrent task agents`,
        signal: undefined,
      });
      parentRunId = parent.runId;
    }
  } catch {
    parentRunId = null; // lineage is a nicety, not a requirement
  }

  // Launch every worker without awaiting between them: they share this tick and
  // are therefore concurrently in flight.
  for (const branch of branches) {
    const controller = controllersByCue.get(branch.cueId);
    if (!controller) continue;
    runBranchTaskAgent(overlayTabId, branch.instruction, branch.url, controller, branch.cueId, {
      parentRunId,
    });
  }
}

// Generate a cueId server-side if the content script didn't supply one, so old
// callers still work. Each cue is independent — we never reject a new one.
function nextCueId(provided) {
  if (typeof provided === "string" && provided) return provided;
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Cancel every running cue on a tab (Stop button with no specific cue).
function cancelTabCues(tabId) {
  for (const [cueId, task] of tasks) {
    if (task.tabId === tabId) {
      task.controller.abort();
      tasks.delete(cueId);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // No sessions: the overlay never asks for prior history. (loadHistory remains
  // available to the gateway plumbing but is no longer wired to the surface.)
  if (msg.cmd === "run" && sender.tab) {
    const tabId = sender.tab.id;
    const cueId = nextCueId(msg.cueId);
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId });
    runAgent(tabId, msg.instruction, controller, cueId);
  }
  if (msg.cmd === "branch" && sender.tab) {
    // Router intent: launch a disposable task agent in its OWN background tab.
    const overlayTabId = sender.tab.id;
    const cueId = nextCueId(msg.cueId);
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId: overlayTabId });
    runBranchTaskAgent(overlayTabId, msg.instruction, msg.url, controller, cueId);
  }
  if (msg.cmd === "branchFanout" && sender.tab && Array.isArray(msg.branches)) {
    // BRANCH-TO-TWO: one trigger, N concurrent disposable task agents, each its
    // own background tab + own cue + own gateway router activation.
    const overlayTabId = sender.tab.id;
    const controllersByCue = new Map();
    const branches = msg.branches.map((b) => {
      const cueId = nextCueId(b.cueId);
      const controller = new AbortController();
      tasks.set(cueId, { controller, tabId: overlayTabId });
      controllersByCue.set(cueId, controller);
      return { instruction: b.instruction, url: b.url, cueId };
    });
    runBranchFanout(overlayTabId, branches, controllersByCue);
  }
  if (msg.cmd === "describe" && sender.tab) {
    const tabId = sender.tab.id;
    const cueId = nextCueId(msg.cueId);
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId });
    describePage(tabId, controller, cueId);
  }
  if (msg.cmd === "cancel" && sender.tab) {
    const tabId = sender.tab.id;
    if (msg.cueId && tasks.has(msg.cueId)) {
      tasks.get(msg.cueId).controller.abort();
      tasks.delete(msg.cueId);
    } else {
      cancelTabCues(tabId);
    }
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, { cmd: "open" });
  } catch {
    // Restricted browser pages cannot receive content scripts.
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-agee" || !tab?.id) return;
  try {
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, { cmd: "open" });
  } catch {
    // Restricted browser pages cannot receive content scripts.
  }
});
