// agee - content script. Owns the on-page surface, perceives the page, executes actions.

(() => {
  if (window.__ageeLoaded) return;
  window.__ageeLoaded = true;

  // ---- Overlay UI -------------------------------------------------------
  let root,
    launcher,
    input,
    voiceButton,
    stopButton,
    log,
    pendingConfirm = null,
    open = false,
    recognition = null,
    listening = false,
    dragState = null,
    suppressLauncherClick = false;

  // Many cues can be in flight at once: the user keeps talking, each utterance is
  // its own lane with its own card in the log. cues maps cueId -> { statusEl };
  // activeCues tracks which are still running so the launcher dot reflects "busy"
  // without ever blocking a new cue.
  let cueSeq = 0;
  const cues = new Map();
  const activeCues = new Set();
  // Chat history is loaded exactly once per page load: the first time the
  // overlay opens we fetch the persisted conversation and render it. Reopening
  // must not refetch or duplicate rows.
  let historyLoaded = false;
  // Replies are spoken one after another (parallel cues finishing together must
  // not talk over each other).
  const speechQueue = [];
  let speaking = false;

  function build() {
    root = document.createElement("div");
    root.id = "agee-root";
    root.innerHTML = `
      <button id="agee-launcher" type="button" title="Describe this page" aria-label="Describe this page">
        <span>agee</span>
      </button>
      <div id="agee-panel">
        <div id="agee-bar">
          <span id="agee-dot"></span>
          <input id="agee-input" placeholder="Tell agee what to do...  (Enter to run, Esc to close)" autocomplete="off" />
          <button id="agee-voice" type="button" title="Speak instruction">Voice</button>
          <button id="agee-stop" type="button" title="Stop current task">Stop</button>
        </div>
        <div id="agee-log"></div>
      </div>`;
    document.documentElement.appendChild(root);
    launcher = root.querySelector("#agee-launcher");
    input = root.querySelector("#agee-input");
    voiceButton = root.querySelector("#agee-voice");
    stopButton = root.querySelector("#agee-stop");
    log = root.querySelector("#agee-log");

    restoreLauncherPosition();
    launcher.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (suppressLauncherClick) {
        suppressLauncherClick = false;
        return;
      }
      if (!open && !anyActive() && !log?.childElementCount) {
        describePage();
      } else {
        toggle(true);
      }
    });
    launcher.addEventListener("pointerdown", startLauncherDrag);

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && input.value.trim()) {
        submitInstruction(input.value.trim());
      } else if (e.key === "Escape") {
        toggle(false);
      }
    });

    voiceButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleVoice();
    });

    stopButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ cmd: "cancel" });
      stopSpeaking();
      addLog("agee", "stopping…");
    });
  }

  function restoreLauncherPosition() {
    chrome.storage.local.get({ ageeLauncherPosition: null }, ({ ageeLauncherPosition }) => {
      if (!launcher || !ageeLauncherPosition) return;
      const { x, y } = ageeLauncherPosition;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      placeLauncher(x, y, false);
    });
  }

  function placeLauncher(x, y, persist) {
    if (!launcher) return;
    const rect = launcher.getBoundingClientRect();
    const nextX = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const nextY = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    launcher.style.left = `${nextX}px`;
    launcher.style.top = `${nextY}px`;
    launcher.style.right = "auto";
    launcher.style.bottom = "auto";
    if (persist) chrome.storage.local.set({ ageeLauncherPosition: { x: nextX, y: nextY } });
  }

  function startLauncherDrag(e) {
    if (e.button !== 0) return;
    const rect = launcher.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    launcher.setPointerCapture(e.pointerId);
    launcher.addEventListener("pointermove", moveLauncherDrag);
    launcher.addEventListener("pointerup", stopLauncherDrag);
    launcher.addEventListener("pointercancel", stopLauncherDrag);
  }

  function moveLauncherDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;
    placeLauncher(dragState.left + dx, dragState.top + dy, false);
  }

  function stopLauncherDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const moved = dragState.moved;
    dragState = null;
    launcher.releasePointerCapture(e.pointerId);
    launcher.removeEventListener("pointermove", moveLauncherDrag);
    launcher.removeEventListener("pointerup", stopLauncherDrag);
    launcher.removeEventListener("pointercancel", stopLauncherDrag);
    if (moved) {
      const rect = launcher.getBoundingClientRect();
      placeLauncher(rect.left, rect.top, true);
      suppressLauncherClick = true;
    }
  }

  function toggle(force) {
    open = typeof force === "boolean" ? force : !open;
    if (!root) build();
    root.classList.toggle("agee-open", open);
    if (open) {
      setTimeout(() => input.focus(), 0);
      loadHistoryOnce();
    }
  }

  // On the first overlay open, pull the persisted conversation from the gateway
  // and render each prior turn into the log: transcript as a "you" row, reply as
  // an "agee" row. Guarded so reopening never refetches or duplicates rows.
  // History is prepended so it always sits BEFORE any live turn that may have
  // started while this async fetch was in flight.
  function loadHistoryOnce() {
    if (historyLoaded) return;
    historyLoaded = true; // claim the slot up front so a fast reopen can't race a second fetch
    let response;
    try {
      response = chrome.runtime.sendMessage({ cmd: "loadHistory" });
    } catch {
      return; // extension context gone; nothing to load
    }
    Promise.resolve(response)
      .then((res) => {
        const turns = Array.isArray(res?.turns) ? res.turns : [];
        if (!turns.length || !log) return;
        const fragment = document.createDocumentFragment();
        for (const turn of turns) {
          const transcript = String(turn?.transcript || "").trim();
          const reply = String(turn?.reply || "").trim();
          if (transcript) fragment.appendChild(makeRow("you", transcript));
          if (reply) fragment.appendChild(makeRow("agee", reply));
        }
        // Prepend so restored history precedes any live cue cards already present.
        log.insertBefore(fragment, log.firstChild);
      })
      .catch(() => {
        // A history fetch failure must not break the overlay; leave it empty.
      });
  }

  function makeRow(who, text) {
    const row = document.createElement("div");
    row.className = `agee-row agee-${who}`;
    row.textContent = text;
    return row;
  }

  function addLog(who, text) {
    if (!log) return;
    log.appendChild(makeRow(who, text));
    log.scrollTop = log.scrollHeight;
  }

  function askInlineConfirm(text) {
    if (!log) return Promise.resolve(false);
    if (pendingConfirm) pendingConfirm(false);
    toggle(true);
    return new Promise((resolve) => {
      pendingConfirm = resolve;
      const row = document.createElement("div");
      row.className = "agee-row agee-confirm";
      row.innerHTML = `
        <div class="agee-confirm-text"></div>
        <div class="agee-confirm-actions">
          <button type="button" data-agee-confirm="yes">Allow</button>
          <button type="button" data-agee-confirm="no">Cancel</button>
        </div>`;
      row.querySelector(".agee-confirm-text").textContent = text || "Allow agee to continue?";
      row.addEventListener("click", (event) => {
        const button = event.target.closest("[data-agee-confirm]");
        if (!button) return;
        const ok = button.getAttribute("data-agee-confirm") === "yes";
        pendingConfirm = null;
        row.remove();
        resolve(ok);
      });
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    });
  }

  let lastTerminal = ""; // "done" | "error" — shown on the dot when nothing is running

  function anyActive() {
    return activeCues.size > 0;
  }

  // The launcher dot is "running" while any cue is in flight, otherwise it shows
  // the most recent terminal state. The Stop button is visible only while busy.
  function refreshStatus() {
    const dot = root && root.querySelector("#agee-dot");
    if (dot) dot.className = anyActive() ? "running" : lastTerminal;
    if (stopButton) stopButton.classList.toggle("visible", anyActive());
  }

  // ---- Cue cards --------------------------------------------------------
  // Each cue gets a card: the user's line plus a live status line that moves
  // from "thinking…" through progress to a final answer/error.
  function newCueId() {
    cueSeq += 1;
    return `c_${cueSeq}_${Date.now().toString(36)}`;
  }

  function createCue(cueId, label) {
    if (!log) return;
    const card = document.createElement("div");
    card.className = "agee-cue agee-cue-running";
    card.dataset.cue = cueId;
    const you = document.createElement("div");
    you.className = "agee-row agee-you";
    you.textContent = label;
    const status = document.createElement("div");
    status.className = "agee-cue-status";
    status.textContent = "thinking…";
    card.appendChild(you);
    card.appendChild(status);
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    cues.set(cueId, { statusEl: status, cardEl: card });
    activeCues.add(cueId);
    refreshStatus();
  }

  // Update a cue's status line. kind: "running" | "done" | "error".
  function updateCue(cueId, text, kind) {
    const entry = cues.get(cueId);
    // A message for an unknown cue (e.g. server-generated id) falls back to a row.
    // Tag the terminal kind so a done row is distinguishable from interim
    // progress rows (error -> agee-error, done -> agee-done, running -> agee-agee).
    if (!entry) {
      addLog(kind === "error" ? "error" : kind === "done" ? "done" : "agee", text);
      if (kind === "done" || kind === "error") {
        lastTerminal = kind;
        refreshStatus();
      }
      return;
    }
    if (typeof text === "string" && text) entry.statusEl.textContent = text;
    if (kind === "done" || kind === "error") {
      entry.cardEl.className = `agee-cue agee-cue-${kind}`;
      activeCues.delete(cueId);
      lastTerminal = kind;
    }
    refreshStatus();
    if (log) log.scrollTop = log.scrollHeight;
  }

  // Speak replies one at a time so parallel cues finishing together don't overlap.
  function speak(text) {
    const t = String(text || "").trim();
    if (!t) return;
    speechQueue.push(t);
    drainSpeech();
  }

  function drainSpeech() {
    if (speaking) return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    const next = speechQueue.shift();
    if (!next) return;
    speaking = true;
    try {
      const utterance = new SpeechSynthesisUtterance(next);
      utterance.lang = navigator.language || "en-US";
      utterance.onend = utterance.onerror = () => {
        speaking = false;
        drainSpeech();
      };
      synth.speak(utterance);
    } catch {
      speaking = false;
    }
  }

  function stopSpeaking() {
    speechQueue.length = 0;
    speaking = false;
    try {
      window.speechSynthesis && window.speechSynthesis.cancel();
    } catch {}
  }

  // Fire a cue. Never blocks on a prior cue — that is the whole point: the user
  // keeps talking, each utterance becomes its own concurrent lane.
  function submitInstruction(instruction, displayText = instruction) {
    if (!instruction) return;
    const cueId = newCueId();
    toggle(true);
    createCue(cueId, displayText);
    input.value = "";
    input.focus(); // immediately ready for the next cue
    chrome.runtime.sendMessage({ cmd: "run", instruction, cueId }).catch((error) => {
      updateCue(cueId, String(error?.message || error), "error");
    });
  }

  function describePage() {
    const cueId = newCueId();
    toggle(true);
    createCue(cueId, "Describe this page");
    chrome.runtime.sendMessage({ cmd: "describe", cueId }).catch((error) => {
      updateCue(cueId, String(error?.message || error), "error");
    });
  }

  function setVoiceState(next) {
    listening = next;
    if (voiceButton) {
      voiceButton.classList.toggle("listening", listening);
      voiceButton.textContent = listening ? "Listening" : "Voice";
    }
  }

  function startRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      addLog("error", "Voice input is not available in this browser. Type the instruction instead.");
      return false;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onstart = () => setVoiceState(true);
    recognition.onerror = (event) => {
      setVoiceState(false);
      addLog(
        "error",
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "Microphone blocked. Allow mic access for this site, or just type."
          : `Voice input failed: ${event.error || "unknown error"}`
      );
      setTimeout(() => input.focus(), 0);
    };
    recognition.onend = () => setVoiceState(false);
    recognition.onresult = (event) => {
      const transcript = [...event.results].map((r) => r[0]?.transcript || "").join(" ").trim();
      if (transcript) input.value = transcript;
    };
    recognition.start();
    return true;
  }

  function stopRecognition(submit) {
    if (recognition) {
      try {
        recognition.stop();
      } catch {}
      recognition = null;
    }
    setVoiceState(false);
    const text = input.value.trim();
    if (submit && text) {
      submitInstruction(text);
    } else {
      setTimeout(() => input.focus(), 0);
    }
  }

  // Click button: toggle listening, leave transcript in the bar (user hits Enter).
  function toggleVoice() {
    if (recognition && listening) {
      stopRecognition(false);
      return;
    }
    toggle(true);
    startRecognition();
  }

  // ---- Hotkey: tap = text bar, hold = voice ----------------------------
  const HOLD_MS = 220;
  let hotkeyDown = false;
  let holdTimer = null;
  let holdVoicing = false;

  function isHotkey(e) {
    return (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (!isHotkey(e)) return;
      e.preventDefault();
      if (hotkeyDown) return; // ignore auto-repeat
      hotkeyDown = true;
      holdTimer = setTimeout(() => {
        if (!hotkeyDown) return;
        holdVoicing = true;
        toggle(true);
        input.placeholder = "Listening... (release to run)";
        if (!startRecognition()) holdVoicing = false;
      }, HOLD_MS);
    },
    true
  );

  window.addEventListener(
    "keyup",
    (e) => {
      if (!hotkeyDown) return;
      if (!(e.key === "k" || e.key === "K" || e.key === "Meta" || e.key === "Control")) return;
      hotkeyDown = false;
      clearTimeout(holdTimer);
      input && (input.placeholder = "Tell agee what to do...  (Enter to run, Esc to close)");
      if (holdVoicing) {
        holdVoicing = false;
        stopRecognition(true); // release → run what was heard
      } else {
        toggle(true); // quick tap → text command bar
      }
    },
    true
  );

  // ---- Perception -------------------------------------------------------
  const SELECTOR =
    'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick]';

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }

  function label(el) {
    if (!el) return "";
    const text =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (el.value && el.type !== "password" ? el.value : "") ||
      el.innerText ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      "";
    return text.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  const RISKY_TEXT = /\b(delete|remove|submit|send|pay|purchase|buy|checkout|confirm|transfer|withdraw|archive|sign out|log out|logout)\b/i;

  function needsConfirmation(el, req) {
    if (req.action === "key" && (req.text || "Enter") === "Enter") {
      const active = document.activeElement;
      return !!active && active !== document.body;
    }
    if (!el) return false;
    if (req.action === "type" && el.getAttribute("type") === "password") return true;
    if (req.action !== "click") return false;
    return RISKY_TEXT.test(label(el));
  }

  let indexed = [];
  function snapshot() {
    indexed = [];
    const out = [];
    document.querySelectorAll(SELECTOR).forEach((el) => {
      if (el.closest("#agee-root")) return;
      if (!visible(el)) return;
      const i = indexed.length;
      indexed.push(el);
      out.push({ i, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", label: label(el) });
    });
    return { url: location.href, title: document.title, elements: out };
  }

  // ---- Action -----------------------------------------------------------
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function act(req) {
    const el = indexed[req.index];
    if (["click", "type", "clear", "select"].includes(req.action) && !el) {
      return { result: `no element at index ${req.index}` };
    }
    try {
      if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
      if (needsConfirmation(el, req) && !(await askInlineConfirm(`Let agee ${req.action} "${label(el || document.activeElement) || "this element"}"?`))) {
        return { result: `user cancelled ${req.action}` };
      }
      switch (req.action) {
        case "click":
          el.click();
          return { result: `clicked [${req.index}]` };
        case "type":
          el.focus();
          if (el.isContentEditable) {
            el.textContent = req.text || "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            setNativeValue(el, req.text || "");
          }
          return { result: `typed into [${req.index}]` };
        case "clear":
          if (el.isContentEditable) el.textContent = "";
          else setNativeValue(el, "");
          return { result: `cleared [${req.index}]` };
        case "select": {
          const opt = [...el.options].find((o) => o.text.trim() === (req.text || "").trim() || o.value === req.text);
          if (opt) {
            el.value = opt.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { result: `selected "${req.text}"` };
          }
          return { result: `no option "${req.text}"` };
        }
        case "scroll":
          window.scrollBy({ top: (req.direction === "up" ? -1 : 1) * innerHeight * 0.8, behavior: "instant" });
          return { result: `scrolled ${req.direction || "down"}` };
        case "key": {
          const target = document.activeElement || document.body;
          const key = req.text || "Enter";
          for (const t of ["keydown", "keypress", "keyup"]) {
            target.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true }));
          }
          return { result: `pressed ${key}` };
        }
        default:
          return { result: `unknown action ${req.action}` };
      }
    } catch (e) {
      return { result: `error: ${e.message}` };
    }
  }

  // ---- Messaging --------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.cmd) {
      case "ping":
        reply({ ok: true });
        return true;
      case "toggle":
        toggle();
        reply({ ok: true });
        return true;
      case "open":
        toggle(true);
        reply({ ok: true });
        return true;
      case "snapshot":
        reply(snapshot());
        return true;
      case "act":
        act(msg).then(reply);
        return true;
      case "confirm":
        askInlineConfirm(msg.text || "Allow agee to continue?").then((ok) => reply({ ok }));
        return true;
      case "progress":
        if (!open) toggle(true);
        updateCue(msg.cueId, msg.text, "running");
        return false;
      case "done":
        updateCue(msg.cueId, msg.summary, "done");
        speak(msg.speak);
        return false;
      case "error":
        updateCue(msg.cueId, msg.text, "error");
        return false;
    }
  });

  build();
})();
