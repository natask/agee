// agee (tweaks) — content script.
// Floating pill + shortcut → overlay → hold-to-talk voice / type → apply a tweak
// (CSS/JS) live → save per-site → re-apply on revisit. No agent, no sidebar.

(() => {
  if (window.__ageeTweaksLoaded) return;
  window.__ageeTweaksLoaded = true;

  const HOST = location.hostname;
  const isRestricted = location.protocol !== "http:" && location.protocol !== "https:";
  if (isRestricted) return; // agee can't run on chrome:// / internal pages

  const DEFAULT_SHORTCUT = { meta: true, ctrl: false, shift: true, code: "Space" };

  // ---- storage helpers --------------------------------------------------
  const get = (keys) => chrome.storage.local.get(keys);
  const set = (obj) => chrome.storage.local.set(obj);

  async function loadTweaks() {
    const { ageeTweaks = {} } = await get("ageeTweaks");
    return ageeTweaks[HOST] || [];
  }
  async function saveTweaks(list) {
    const { ageeTweaks = {} } = await get("ageeTweaks");
    ageeTweaks[HOST] = list;
    await set({ ageeTweaks });
  }

  // ---- apply / unapply tweaks ------------------------------------------
  function applyTweak(t) {
    if (t.css) {
      let style = document.getElementById(`agee-css-${t.id}`);
      if (!style) {
        style = document.createElement("style");
        style.id = `agee-css-${t.id}`;
        document.documentElement.appendChild(style);
      }
      style.textContent = t.css;
    }
    if (t.js) {
      try {
        new Function(t.js)();
      } catch (e) {
        console.warn("[agee] tweak js failed:", e);
      }
    }
  }
  function unapplyCss(id) {
    const style = document.getElementById(`agee-css-${id}`);
    if (style) style.remove();
  }

  async function applySaved() {
    const list = await loadTweaks();
    list.filter((t) => t.enabled).forEach(applyTweak);
  }

  // ---- page outline for the model --------------------------------------
  function pageOutline() {
    const lines = [];
    const seen = new Set();
    document
      .querySelectorAll("header,nav,main,footer,aside,section,h1,h2,button,a,form,input,[role],[id],[class]")
      .forEach((el) => {
        if (lines.length >= 80) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const id = el.id ? `#${el.id}` : "";
        const cls = (el.className && typeof el.className === "string")
          ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
          : "";
        const sig = `${el.tagName.toLowerCase()}${id}${cls}`;
        if (seen.has(sig)) return;
        seen.add(sig);
        const txt = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40);
        lines.push(`${sig}${txt ? ` "${txt}"` : ""}`);
      });
    return lines.join("\n");
  }

  // ---- UI: pill + overlay ----------------------------------------------
  let pill, overlay, input, statusEl, listEl, micBtn;
  let lastTweak = null; // applied-but-not-saved preview

  function buildPill(pos) {
    pill = document.createElement("button");
    pill.id = "agee-pill";
    pill.type = "button";
    pill.textContent = "agee";
    pill.style.left = (pos?.x ?? window.innerWidth - 84) + "px";
    pill.style.top = (pos?.y ?? window.innerHeight - 84) + "px";
    document.documentElement.appendChild(pill);

    // drag vs click
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    pill.addEventListener("pointerdown", (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      ox = parseInt(pill.style.left); oy = parseInt(pill.style.top);
      pill.setPointerCapture(e.pointerId);
    });
    pill.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      pill.style.left = Math.max(4, Math.min(window.innerWidth - 60, ox + dx)) + "px";
      pill.style.top = Math.max(4, Math.min(window.innerHeight - 40, oy + dy)) + "px";
    });
    pill.addEventListener("pointerup", () => {
      dragging = false;
      if (moved) set({ ageePillPos: { x: parseInt(pill.style.left), y: parseInt(pill.style.top) } });
      else openOverlay();
    });
  }

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.id = "agee-overlay";
    overlay.innerHTML = `
      <div id="agee-card">
        <div id="agee-row">
          <button id="agee-mic" type="button" title="Hold to talk">🎤</button>
          <input id="agee-in" placeholder="Tweak this page… (hold mic or Space to talk, Enter to apply)" autocomplete="off" />
          <button id="agee-go" type="button">Apply</button>
        </div>
        <div id="agee-status"></div>
        <div id="agee-list"></div>
      </div>`;
    document.documentElement.appendChild(overlay);
    input = overlay.querySelector("#agee-in");
    statusEl = overlay.querySelector("#agee-status");
    listEl = overlay.querySelector("#agee-list");
    micBtn = overlay.querySelector("#agee-mic");

    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) closeOverlay(); });
    overlay.querySelector("#agee-go").addEventListener("click", run);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") run();
      else if (e.key === "Escape") closeOverlay();
      // Hold Space to talk when the field is empty
      else if (e.code === "Space" && !input.value && !voicing) { e.preventDefault(); startVoice(); }
    });
    input.addEventListener("keyup", (e) => {
      if (e.code === "Space" && voicing) { e.preventDefault(); stopVoice(); }
    });
    micBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startVoice(); });
    micBtn.addEventListener("pointerup", stopVoice);
    micBtn.addEventListener("pointerleave", () => voicing && stopVoice());
  }

  function openOverlay() {
    if (!overlay) buildOverlay();
    overlay.classList.add("agee-show");
    renderList();
    setTimeout(() => input.focus(), 0);
  }
  function closeOverlay() {
    overlay && overlay.classList.remove("agee-show");
  }
  function setStatus(text, kind = "") {
    if (statusEl) { statusEl.textContent = text || ""; statusEl.className = kind; }
  }

  async function renderList() {
    const list = await loadTweaks();
    if (!list.length) { listEl.innerHTML = ""; return; }
    listEl.innerHTML = `<div class="agee-list-h">Saved on ${HOST}</div>`;
    list.forEach((t) => {
      const row = document.createElement("div");
      row.className = "agee-saved";
      row.innerHTML = `<label><input type="checkbox" ${t.enabled ? "checked" : ""}/> <span>${t.name}</span></label><button title="Delete">✕</button>`;
      row.querySelector("input").addEventListener("change", async (e) => {
        t.enabled = e.target.checked;
        if (t.enabled) applyTweak(t); else unapplyCss(t.id);
        const all = await loadTweaks();
        await saveTweaks(all.map((x) => (x.id === t.id ? t : x)));
      });
      row.querySelector("button").addEventListener("click", async () => {
        unapplyCss(t.id);
        const all = await loadTweaks();
        await saveTweaks(all.filter((x) => x.id !== t.id));
        renderList();
      });
      listEl.appendChild(row);
    });
  }

  // ---- voice (hold-to-talk; release = done) ----------------------------
  let recognition = null, voicing = false;
  async function startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus("Voice unavailable in this browser — type instead.", "err"); return; }
    const { ageeLang } = await get("ageeLang");
    voicing = true;
    micBtn.classList.add("on");
    setStatus("Listening… release to finish.");
    recognition = new SR();
    recognition.lang = ageeLang || navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (ev) => {
      let s = "";
      for (let i = 0; i < ev.results.length; i++) s += ev.results[i][0].transcript;
      input.value = s.trim();
    };
    recognition.onerror = (ev) => {
      voicing = false; micBtn.classList.remove("on");
      setStatus(
        ev.error === "not-allowed" || ev.error === "service-not-allowed"
          ? "Mic blocked. Allow microphone for this site, or type."
          : `Voice error: ${ev.error}. Type instead.`,
        "err"
      );
    };
    try { recognition.start(); } catch { voicing = false; }
  }
  function stopVoice() {
    if (!voicing) return;
    voicing = false;
    micBtn && micBtn.classList.remove("on");
    if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
    setStatus(input.value ? "Heard it — Enter to apply." : "");
    input.focus();
  }

  // ---- run: generate + apply (preview) + offer save --------------------
  async function run() {
    const prompt = input.value.trim();
    if (!prompt) return;
    setStatus("Thinking…");
    const res = await chrome.runtime.sendMessage({
      cmd: "generate",
      prompt,
      page: { url: location.href, title: document.title, outline: pageOutline() },
    });
    if (res.error) { setStatus(res.error, "err"); return; }
    const t = res.tweak;
    if (!t.css && !t.js) { setStatus(t.explanation || "Nothing to change.", "err"); return; }

    lastTweak = { id: "t" + Date.now(), name: t.name, prompt, css: t.css, js: t.js, enabled: true, createdAt: Date.now() };
    applyTweak(lastTweak);
    setStatus(t.explanation || "Applied.", "ok");
    showSaveBar();
  }

  function showSaveBar() {
    let bar = overlay.querySelector("#agee-savebar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "agee-savebar";
      bar.innerHTML = `<span>Keep this tweak?</span><button id="agee-save">Save</button><button id="agee-undo">Undo</button>`;
      statusEl.after(bar);
      bar.querySelector("#agee-save").addEventListener("click", async () => {
        const list = await loadTweaks();
        list.push(lastTweak);
        await saveTweaks(list);
        bar.remove(); input.value = ""; setStatus("Saved ✓", "ok"); renderList();
      });
      bar.querySelector("#agee-undo").addEventListener("click", () => {
        if (lastTweak) unapplyCss(lastTweak.id);
        lastTweak = null; bar.remove(); setStatus("");
      });
    }
  }

  // ---- shortcut ---------------------------------------------------------
  async function initShortcut() {
    const { ageeShortcut } = await get("ageeShortcut");
    const sc = ageeShortcut || DEFAULT_SHORTCUT;
    window.addEventListener("keydown", (e) => {
      if (!!sc.meta !== (e.metaKey) || !!sc.ctrl !== e.ctrlKey || !!sc.shift !== e.shiftKey) return;
      if (e.code !== sc.code) return;
      e.preventDefault();
      overlay && overlay.classList.contains("agee-show") ? closeOverlay() : openOverlay();
    }, true);
  }

  // ---- boot -------------------------------------------------------------
  (async () => {
    await applySaved();
    const { ageePillPos } = await get("ageePillPos");
    buildPill(ageePillPos);
    initShortcut();
  })();
})();
