// agee — background service worker.
// Holds the API key, runs the agent loop, talks to the page via the content script.
// The model call lives here (not the page) so we control the network boundary.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_STEPS = 20;
const MAX_ELEMENTS = 100;
const ALLOWED_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
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
  return {
    apiKey: ageeApiKey,
    model: ageeModel || DEFAULT_MODEL,
    gatewayUrl: String(ageeGatewayUrl || "").replace(/\/+$/, ""),
    gatewayToken: String(ageeGatewayToken || ""),
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

// Stable per-tab session id so the gateway can keep conversation continuity.
const tabSessions = new Map();
function sessionIdFor(tabId) {
  let id = tabSessions.get(tabId);
  if (!id) {
    id = `agee_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    tabSessions.set(tabId, id);
  }
  return id;
}

// Conversational turn through the user's gateway (/v1/voice/turns).
// The gateway classifies chat vs. home-machine agent runs and replies with
// display text; we render it. Page-DOM actions are a later wave.
async function runViaGateway(tabId, instruction, cfg, signal) {
  await saveTaskState(tabId, { status: "running", instruction, step: 0, lastResult: "sending to gateway" });
  send(tabId, { cmd: "progress", text: "thinking…" });
  throwIfAborted(signal);

  let screen;
  try {
    const snap = await ask(tabId, { cmd: "snapshot" });
    screen = snapToScreen(snap);
  } catch {
    screen = undefined; // restricted page; send without screen context
  }

  throwIfAborted(signal);
  const data = await callGateway(cfg, "/v1/voice/turns", {
    signal,
    body: {
      source: "agee-extension",
      session_id: sessionIdFor(tabId),
      transcript: instruction,
      screen,
    },
  });

  const reply = String(data.display || data.text || data.speak || "").trim();
  const runs = Array.isArray(data.agent_runs) ? data.agent_runs : [];
  const summary = reply || (runs.length ? `Started ${runs.length} agent run(s).` : "Done.");
  send(tabId, { cmd: "done", summary });
  await saveTaskState(tabId, {
    status: "done",
    instruction,
    step: 1,
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

async function saveTaskState(tabId, patch) {
  const key = `ageeTask:${tabId}`;
  const previous = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({
    [key]: {
      ...previous,
      ...patch,
      tabId,
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

async function describePageViaGateway(tabId, cfg, signal) {
  await saveTaskState(tabId, { status: "running", instruction: "Describe this page", step: 0, lastResult: "reading page (gateway)" });
  send(tabId, { cmd: "progress", text: "reading the page…" });
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
  send(tabId, { cmd: "done", summary: text });
  await saveTaskState(tabId, { status: "done", instruction: "Describe this page", step: 1, lastResult: text.slice(0, 500) });
}

async function describePage(tabId, controller) {
  const signal = controller.signal;

  try {
    const cfg = await getConfig();

    // Prefer the user's own agent gateway (the pipe) when configured.
    if (cfg.gatewayUrl) {
      await describePageViaGateway(tabId, cfg, signal);
      return;
    }

    if (!cfg.apiKey) {
      send(tabId, { cmd: "error", text: "No gateway URL and no API key set. Click the agee toolbar icon -> Options to set a gateway URL or add your Anthropic key." });
      return;
    }

    await saveTaskState(tabId, { status: "running", instruction: "Describe this page", step: 0, lastResult: "reading page" });
    send(tabId, { cmd: "progress", text: "reading the page…" });
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
    send(tabId, { cmd: "done", summary: text });
    await saveTaskState(tabId, { status: "done", instruction: "Describe this page", step: 1, lastResult: text.slice(0, 500) });
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : String(err.message || err);
    send(tabId, { cmd: signal.aborted ? "done" : "error", summary: message, text: message });
    await saveTaskState(tabId, { status: signal.aborted ? "cancelled" : "error", instruction: "Describe this page", lastResult: message });
  } finally {
    if (tasks.get(tabId) === controller) tasks.delete(tabId);
  }
}

async function runAgent(tabId, instruction, controller) {
  const signal = controller.signal;

  try {
    const cfg = await getConfig();

    // Prefer the user's own agent gateway (the pipe). Conversational + home-machine
    // agent runs; customize behavior by editing the gateway's SYSTEM_PROMPT.
    if (cfg.gatewayUrl) {
      await runViaGateway(tabId, instruction, cfg, signal);
      return;
    }

    if (!cfg.apiKey) {
      send(tabId, { cmd: "error", text: "No gateway URL and no API key set. Click the agee toolbar icon → Options to set a gateway URL or add your Anthropic key." });
      return;
    }

    await saveTaskState(tabId, { status: "running", instruction, step: 0, lastResult: "started" });
    send(tabId, { cmd: "progress", text: "thinking…" });
    const first = await snapshotBlocks(tabId, signal);
    const messages = [
      { role: "user", content: [{ type: "text", text: `TASK: ${instruction}` }, ...first] },
    ];
    for (let step = 0; step < MAX_STEPS; step++) {
      await saveTaskState(tabId, { status: "running", instruction, step, lastResult: "calling model" });
      throwIfAborted(signal);
      const resp = await callClaude(cfg, messages, signal);
      messages.push({ role: "assistant", content: resp.content });

      const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) send(tabId, { cmd: "progress", text });
      if (text) await saveTaskState(tabId, { status: "running", instruction, step, lastResult: text.slice(0, 500) });

      if (resp.stop_reason !== "tool_use") {
        send(tabId, { cmd: "done", summary: text || "Stopped." });
        await saveTaskState(tabId, { status: "done", instruction, step, lastResult: text || "Stopped." });
        return;
      }

      const toolResults = [];
      let finished = false;
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "finish") {
          send(tabId, { cmd: "done", summary: block.input.summary || "Done." });
          await saveTaskState(tabId, { status: "done", instruction, step, lastResult: block.input.summary || "Done." });
          finished = true;
          break;
        }
        const result = await executeAction(tabId, block.input, signal);
        await saveTaskState(tabId, { status: "running", instruction, step, lastResult: result });
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
    send(tabId, { cmd: "done", summary: `Reached the ${MAX_STEPS}-step limit.` });
    await saveTaskState(tabId, { status: "done", instruction, step: MAX_STEPS, lastResult: `Reached the ${MAX_STEPS}-step limit.` });
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : String(err.message || err);
    send(tabId, { cmd: signal.aborted ? "done" : "error", summary: message, text: message });
    await saveTaskState(tabId, { status: signal.aborted ? "cancelled" : "error", instruction, lastResult: message });
  } finally {
    if (tasks.get(tabId) === controller) tasks.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.cmd === "run" && sender.tab) {
    const tabId = sender.tab.id;
    if (tasks.has(tabId)) {
      send(tabId, { cmd: "error", text: "A task is already running. Stop it before starting another." });
      return;
    }
    const controller = new AbortController();
    tasks.set(tabId, controller);
    runAgent(tabId, msg.instruction, controller);
  }
  if (msg.cmd === "describe" && sender.tab) {
    const tabId = sender.tab.id;
    if (tasks.has(tabId)) {
      send(tabId, { cmd: "error", text: "A task is already running. Stop it before starting another." });
      return;
    }
    const controller = new AbortController();
    tasks.set(tabId, controller);
    describePage(tabId, controller);
  }
  if (msg.cmd === "cancel" && sender.tab) {
    const controller = tasks.get(sender.tab.id);
    if (controller) controller.abort();
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
