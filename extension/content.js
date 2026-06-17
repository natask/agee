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
    running = false,
    dragState = null,
    suppressLauncherClick = false;

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
      if (!open && !running && !log?.childElementCount) {
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
    if (open) setTimeout(() => input.focus(), 0);
  }

  function addLog(who, text) {
    if (!log) return;
    const row = document.createElement("div");
    row.className = `agee-row agee-${who}`;
    row.textContent = text;
    log.appendChild(row);
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

  function setStatus(state) {
    const dot = root && root.querySelector("#agee-dot");
    if (dot) dot.className = state; // "", "running", "done", "error"
    running = state === "running";
    if (stopButton) stopButton.classList.toggle("visible", running);
  }

  function submitInstruction(instruction, displayText = instruction) {
    if (!instruction) return;
    if (running) {
      addLog("error", "A task is already running. Stop it before starting another.");
      return;
    }
    running = true;
    setStatus("running");
    toggle(true);
    addLog("you", displayText);
    input.value = "";
    chrome.runtime.sendMessage({ cmd: "run", instruction }).catch((error) => {
      setStatus("error");
      addLog("error", String(error?.message || error));
    });
  }

  function describePage() {
    if (running) {
      addLog("error", "A task is already running. Stop it before starting another.");
      return;
    }
    running = true;
    setStatus("running");
    toggle(true);
    addLog("you", "Describe this page");
    chrome.runtime.sendMessage({ cmd: "describe" }).catch((error) => {
      setStatus("error");
      addLog("error", String(error?.message || error));
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
        setStatus("running");
        if (!open) toggle(true);
        addLog("agee", msg.text);
        return false;
      case "done":
        setStatus("done");
        addLog("done", msg.summary);
        return false;
      case "error":
        setStatus("error");
        addLog("error", msg.text);
        return false;
    }
  });

  build();
})();
