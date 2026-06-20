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
    voiceState,
    transcriptEl,
    recognition = null,
    listening = false,
    dragState = null,
    suppressLauncherClick = false,
    // The duck is alive: it floats, wanders the page when idle, reacts to state,
    // and rings when something lands. audioCtx is created lazily on first gesture.
    audioCtx = null,
    wanderTimer = null,
    wanderPauseUntil = 0,
    wanderHover = false;

  // The overlay's voice surface runs a small state machine so the screen always
  // shows whether the agent is up and what it is doing:
  //   idle      - no voice session
  //   listening - mic open, transcript bar live with the user's words
  //   thinking  - utterance submitted, waiting on the gateway
  //   speaking  - reply is being spoken back
  let agentState = "idle";

  // Many cues can be in flight at once: the user keeps talking, each utterance is
  // its own lane with its own card in the log. cues maps cueId -> { statusEl };
  // activeCues tracks which are still running so the launcher dot reflects "busy"
  // without ever blocking a new cue.
  let cueSeq = 0;
  const cues = new Map();
  const activeCues = new Set();
  // Replies are spoken one after another (parallel cues finishing together must
  // not talk over each other).
  const speechQueue = [];
  let speaking = false;

  function build() {
    root = document.createElement("div");
    root.id = "agee-root";
    root.innerHTML = `
      <button id="agee-launcher" type="button" title="⌘. to talk · ⌘, to type" aria-label="agee">
        <span class="agee-ring" aria-hidden="true"></span>
        <span class="agee-shadow" aria-hidden="true"></span>
        <svg class="agee-bird" viewBox="0 0 50 50" aria-hidden="true">
          <g fill="currentColor" stroke="none">
            <polygon points="9,29 1,33 11,37"/>
            <ellipse cx="22" cy="29" rx="13" ry="10"/>
            <circle cx="33" cy="20" r="7"/>
            <polygon points="40,18 49,19.5 40,23"/>
          </g>
          <path d="M14 26 Q 24 33 31 26" fill="none" stroke="#111114" stroke-width="1.6" stroke-linecap="round"/>
          <circle cx="34.5" cy="18.5" r="1.3" fill="#111114"/>
          <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="21" y1="38" x2="20" y2="46"/>
            <line x1="27" y1="38" x2="28" y2="46"/>
          </g>
        </svg>
      </button>
      <div id="agee-panel">
        <div id="agee-voice-state" aria-hidden="true">
          <span id="agee-orb"></span>
          <span id="agee-transcript" aria-live="polite"></span>
        </div>
        <div id="agee-bar">
          <span id="agee-dot"></span>
          <input id="agee-input" placeholder="Ask agee…  ⌘. to talk" autocomplete="off" />
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
    voiceState = root.querySelector("#agee-voice-state");
    transcriptEl = root.querySelector("#agee-transcript");

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

    // Hovering the duck pauses its wandering so it is easy to grab or click; a
    // pointerdown anywhere primes the audio context so the chime can play later
    // (browsers only allow sound after a user gesture).
    launcher.addEventListener("pointerenter", () => {
      wanderHover = true;
    });
    launcher.addEventListener("pointerleave", () => {
      wanderHover = false;
    });
    window.addEventListener("pointerdown", primeAudio, { once: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleWander();
    });
    scheduleWander();
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
    }
  }

  // No sessions, no history. The overlay shows only the live turns of this page
  // load. Prior conversation is not fetched or rendered — context belongs to the
  // agent, not a scrollback the user has to manage.

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
    reactLauncher("attention"); // a question needs the user: ring for attention
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
    // The duck glows while it is working so the user can tell it is busy even
    // with the panel closed. Busy also halts wandering — it stays put and thinks.
    if (launcher) launcher.classList.toggle("agee-busy", anyActive());
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
    if (!next) {
      // Nothing left to say: a live voice session falls back to idle so the orb
      // stops pulsing and the surface settles.
      if (agentState !== "idle") setAgentState("idle");
      return;
    }
    speaking = true;
    if (agentState !== "idle") setAgentState("speaking");
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
    if (agentState === "speaking") setAgentState("idle");
    try {
      window.speechSynthesis && window.speechSynthesis.cancel();
    } catch {}
  }

  // ---- The duck: sound, reactions, wandering ----------------------------
  // A short synthesized chime so something *rings* when a turn lands. No asset,
  // no network: two quick sine notes. "done" rises (happy), "error" falls,
  // "attention" is a single insistent note (a question needs the user).
  function primeAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch {}
  }

  function chime(kind = "done") {
    primeAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const notes =
      kind === "error" ? [493.9, 329.6] : kind === "attention" ? [587.3, 587.3] : [659.3, 880.0];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.13;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
  }

  // Make the launcher visibly react: a one-shot body animation plus an expanding
  // ring, plus the chime. Called when a cue finishes, errors, or needs the user.
  function reactLauncher(kind = "done") {
    if (!launcher) return;
    const ring = launcher.querySelector(".agee-ring");
    launcher.classList.remove("agee-hop", "agee-shake", "agee-attention");
    void launcher.offsetWidth; // restart the animation even on back-to-back events
    launcher.classList.add(kind === "error" ? "agee-shake" : kind === "attention" ? "agee-attention" : "agee-hop");
    if (ring) {
      ring.dataset.kind = kind;
      ring.classList.remove("agee-ring-go");
      void ring.offsetWidth;
      ring.classList.add("agee-ring-go");
    }
    chime(kind);
    // A reaction means something happened: hop in place, then resume roaming.
    wanderPauseUntil = Date.now() + 2600;
  }

  // ---- Wandering --------------------------------------------------------
  // When idle (overlay closed, nothing running, not just dragged or hovered),
  // the duck glides to a new spot every so often so it feels alive on the page.
  function scheduleWander() {
    clearTimeout(wanderTimer);
    wanderTimer = setTimeout(wanderStep, 5000 + Math.random() * 7000);
  }

  function wanderStep() {
    const blocked =
      !launcher || open || anyActive() || wanderHover || dragState || document.hidden ||
      Date.now() < wanderPauseUntil;
    if (!blocked) {
      const rect = launcher.getBoundingClientRect();
      const margin = 18;
      const x = margin + Math.random() * Math.max(0, window.innerWidth - rect.width - margin * 2);
      const y = margin + Math.random() * Math.max(0, window.innerHeight - rect.height - margin * 2);
      glideTo(x, y);
    }
    scheduleWander();
  }

  // Glide (not snap) to a target, facing the direction of travel. Wander moves
  // are not persisted — only a deliberate drag pins the duck (see stopLauncherDrag).
  function glideTo(x, y) {
    if (!launcher) return;
    const from = launcher.getBoundingClientRect().left;
    launcher.classList.add("agee-gliding");
    launcher.classList.toggle("agee-face-left", x < from);
    placeLauncher(x, y, false);
    setTimeout(() => launcher && launcher.classList.remove("agee-gliding"), 2400);
  }

  // Fire a cue. Never blocks on a prior cue — that is the whole point: the user
  // keeps talking, each utterance becomes its own concurrent lane.
  function submitInstruction(instruction, displayText = instruction) {
    if (!instruction) return;
    const cueId = newCueId();
    toggle(true);
    createCue(cueId, displayText);
    // A voice-launched turn keeps the agent surface up and moves it to thinking;
    // a typed command leaves the voice surface untouched.
    if (agentState !== "idle") {
      setTranscript(displayText);
      setAgentState("thinking");
    }
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

  // Drive the visible "agent is up" surface. Adds a class on the root so the
  // orb, transcript bar, and panel chrome reflect the live phase. The transcript
  // bar is only present while listening or just-submitted; it clears on idle.
  function setAgentState(next) {
    agentState = next;
    if (!root) return;
    for (const s of ["idle", "listening", "thinking", "speaking"]) {
      root.classList.toggle(`agee-state-${s}`, s === next);
    }
    const voicing = next !== "idle";
    root.classList.toggle("agee-voicing", voicing);
    if (voiceState) voiceState.setAttribute("aria-hidden", voicing ? "false" : "true");
    if (next === "idle") setTranscript("");
  }

  // Render the live transcript bar. `interim` softens still-being-heard words so
  // the user sees speech land word-by-word as the recognizer firms it up.
  function setTranscript(text, interim = false) {
    if (!transcriptEl) return;
    transcriptEl.textContent = text || "";
    transcriptEl.classList.toggle("agee-interim", !!interim && !!text);
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
    recognition.onstart = () => {
      setVoiceState(true);
      setAgentState("listening");
    };
    recognition.onerror = (event) => {
      setVoiceState(false);
      setAgentState("idle");
      addLog(
        "error",
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "Microphone blocked. Allow mic access for this site, or just type."
          : `Voice input failed: ${event.error || "unknown error"}`
      );
      setTimeout(() => input.focus(), 0);
    };
    recognition.onend = () => {
      setVoiceState(false);
      // Leave the transcript visible if a turn is mid-flight (thinking/speaking);
      // only an idle end clears the bar.
      if (agentState === "listening") setAgentState("idle");
    };
    recognition.onresult = (event) => {
      let firmed = "";
      let pending = "";
      for (const result of event.results) {
        const piece = result[0]?.transcript || "";
        if (result.isFinal) firmed += piece;
        else pending += piece;
      }
      const transcript = `${firmed} ${pending}`.replace(/\s+/g, " ").trim();
      // Live transcript bar shows words as they land; interim styling fades the
      // not-yet-firmed tail. The input bar mirrors it so Enter still works.
      setTranscript(transcript, !!pending && !firmed.trim());
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

  // Dedicated "wake the agent" path (double-tap ⌘). Opens the overlay, shows the
  // agent surface, and starts listening immediately. Triggering it again while
  // listening stops and runs what was heard, so the same gesture starts and
  // finishes a turn.
  function toggleVoiceSession() {
    if (recognition && listening) {
      stopRecognition(true); // second press → run what was heard
      return;
    }
    stopSpeaking(); // barge-in: a new turn cuts off any reply still playing
    toggle(true);
    setAgentState("listening");
    setTranscript("Listening…", true);
    startRecognition();
  }

  // ---- Hotkeys: ⌘. = voice, ⌘, = text, double-tap ⌘ = voice -----------
  // Two ways in, both hands-on-keyboard, no clicking:
  //   ⌘.  (or Ctrl+.)         → wake the agent and listen (speech); again to run
  //   ⌘,  (or Ctrl+,)         → open the text command bar (type)
  //   double-tap ⌘ (or Ctrl)  → same as ⌘. (kept as a no-chord shortcut)
  const DOUBLE_TAP_MS = 400;
  let lastMetaTap = 0;

  function isVoiceHotkey(e) {
    return (e.metaKey || e.ctrlKey) && e.key === ".";
  }

  function isTextHotkey(e) {
    return (e.metaKey || e.ctrlKey) && e.key === ",";
  }

  window.addEventListener(
    "keydown",
    (e) => {
      // ⌘. → voice/speech.
      if (isVoiceHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!root) build();
        toggleVoiceSession();
        lastMetaTap = 0;
        return;
      }
      // ⌘, → text command bar.
      if (isTextHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!root) build();
        toggle(true);
        setTimeout(() => input.focus(), 0);
        lastMetaTap = 0;
        return;
      }
      // Double-tap the bare modifier → voice. A held key (auto-repeat) or any
      // other key in between resets the window so chords never trigger it.
      if (e.key === "Meta" || e.key === "Control") {
        if (e.repeat) return;
        const now = Date.now();
        if (now - lastMetaTap < DOUBLE_TAP_MS) {
          lastMetaTap = 0;
          if (!root) build();
          toggleVoiceSession();
        } else {
          lastMetaTap = now;
        }
        return;
      }
      lastMetaTap = 0;
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
        reactLauncher("done"); // hop + ring + happy chime
        speak(msg.speak);
        // No spoken reply queued: settle the voice surface instead of leaving the
        // orb stuck on "thinking".
        if (!speaking && agentState === "thinking") setAgentState("idle");
        return false;
      case "error":
        updateCue(msg.cueId, msg.text, "error");
        reactLauncher("error"); // shake + ring + falling chime
        if (agentState === "thinking" || agentState === "speaking") setAgentState("idle");
        return false;
    }
  });

  build();
})();
