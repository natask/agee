// agee — Tweaks. A SEPARATE capability/"session" from the main command path.
//
// A "tweak" is a persistent, per-origin UI customization the user describes once
// ("hide the cookie banner", "make the body font bigger", "remove the sidebar").
// People want to BUILD, not MAINTAIN, so this module takes on the maintenance
// burden: every tweak is stored per-origin and AUTO-RE-APPLIED on every load.
//
// Boundaries (thin client, no API keys):
//   - Tweaks are produced by a DETERMINISTIC local intent->DOM mapping. There is
//     no provider call here. A model-assisted path would route through the
//     gateway and return the SAME bounded tweak shape; it would never inject
//     arbitrary remote code.
//   - Generated tweak code stays inspectable: every tweak is a small, named,
//     declarative record (kind + params -> CSS) you can list and read. We never
//     eval() or new Function() opaque strings — that was the legacy harness's
//     trick and it is deliberately not reproduced.
//   - Scoped to the current origin only. Storage key is the origin, apply only
//     runs for the matching origin.

(() => {
  if (window.__ageeTweaksLoaded) return;
  window.__ageeTweaksLoaded = true;

  const ORIGIN = location.origin;
  const STORE_KEY = "ageeTweaks";
  const STYLE_PREFIX = "agee-tweak-";

  // Only run on real web pages.
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  // ---- storage (per-origin) --------------------------------------------
  const getStore = () =>
    new Promise((resolve) =>
      chrome.storage.local.get({ [STORE_KEY]: {} }, (out) => resolve(out[STORE_KEY] || {}))
    );
  const setStore = (store) =>
    new Promise((resolve) => chrome.storage.local.set({ [STORE_KEY]: store }, resolve));

  async function loadTweaks() {
    const store = await getStore();
    return Array.isArray(store[ORIGIN]) ? store[ORIGIN] : [];
  }
  async function saveTweaks(list) {
    const store = await getStore();
    store[ORIGIN] = list;
    await setStore(store);
  }

  // ---- deterministic intent -> bounded tweak ---------------------------
  // Each rule maps a natural-language instruction to a SMALL, declarative tweak
  // record. The record carries a `kind` and `params`, and compiles to CSS via a
  // pure function. This keeps the result inspectable and reversible: no opaque
  // code is ever stored or executed.
  //
  // A tweak record:
  //   { id, name, kind, params, css, source, enabled, createdAt }
  //
  // `css` is derived (cached) from kind+params so the smoke / UI can show exactly
  // what will be applied without re-running the compiler.

  function cssEscapeText(value) {
    // Defensive: tweak params come from the user, but they only ever land inside
    // CSS values we control (lengths, our own selectors). Strip anything that
    // could break out of a declaration / inject a new rule.
    return String(value).replace(/[<>{}"'\\;]/g, "");
  }

  // Selectors we treat as "common chrome" for hide-by-role instructions. Kept
  // conservative and visible-structure based, like the legacy outline approach.
  const COMMON_SELECTORS = {
    "cookie banner": [
      '[id*="cookie" i]',
      '[class*="cookie" i]',
      '[id*="consent" i]',
      '[class*="consent" i]',
      '[aria-label*="cookie" i]',
    ],
    sidebar: ['aside', '[role="complementary"]', '[id*="sidebar" i]', '[class*="sidebar" i]'],
    header: ['header', '[role="banner"]', '[id*="header" i]', '[class*="header" i]'],
    footer: ['footer', '[role="contentinfo"]', '[id*="footer" i]', '[class*="footer" i]'],
    ads: ['[id*="ad-" i]', '[class*="advert" i]', '[class*="-ads" i]', '[aria-label*="advert" i]'],
  };

  function selectorAliases(instruction) {
    for (const [name, selectors] of Object.entries(COMMON_SELECTORS)) {
      // match "sidebar", "side bar", "cookie banner", etc.
      const loose = name.replace(/\s+/g, "\\s*");
      if (new RegExp(`\\b${loose}\\b`, "i").test(instruction)) {
        return { name, selectors };
      }
    }
    return null;
  }

  // Compile a tweak record to CSS. Pure, deterministic, inspectable.
  function compileCss(kind, params) {
    switch (kind) {
      case "hide": {
        const sel = (params.selectors || []).join(",\n");
        if (!sel) return "";
        return `${sel} {\n  display: none !important;\n}`;
      }
      case "font-scale": {
        const factor = cssEscapeText(params.factor);
        return `html body {\n  font-size: ${factor}em !important;\n}`;
      }
      case "font-size": {
        const px = cssEscapeText(params.px);
        return `html body {\n  font-size: ${px}px !important;\n}`;
      }
      case "dark": {
        return [
          "html {",
          "  filter: invert(1) hue-rotate(180deg) !important;",
          "  background: #111 !important;",
          "}",
          "img, picture, video, canvas, [style*=\"background-image\"] {",
          "  filter: invert(1) hue-rotate(180deg) !important;",
          "}",
        ].join("\n");
      }
      case "width": {
        const max = cssEscapeText(params.maxWidth);
        return `html body {\n  max-width: ${max}px !important;\n  margin-left: auto !important;\n  margin-right: auto !important;\n}`;
      }
      case "css-selector-hide": {
        const sel = cssEscapeText(params.selector);
        if (!sel) return "";
        return `${sel} {\n  display: none !important;\n}`;
      }
      default:
        return "";
    }
  }

  // Map a free-text instruction to a tweak record (or null if unsupported).
  function planTweak(instruction) {
    const text = (instruction || "").trim();
    if (!text) return null;
    const lower = text.toLowerCase();

    // 1) hide / remove a known region
    if (/\b(hide|remove|kill|get rid of|dismiss)\b/.test(lower)) {
      const alias = selectorAliases(lower);
      if (alias) {
        return makeRecord({
          name: `Hide ${alias.name}`,
          kind: "hide",
          params: { selectors: alias.selectors },
        });
      }
      // explicit CSS selector: "hide .promo" / "remove #banner"
      const m = text.match(/\b(?:hide|remove|kill|dismiss)\b\s+([.#][A-Za-z0-9_\-]+(?:\s*[>,+~]\s*[.#A-Za-z0-9_\-]+)*)/);
      if (m) {
        return makeRecord({
          name: `Hide ${m[1]}`,
          kind: "css-selector-hide",
          params: { selector: m[1] },
        });
      }
    }

    // 2) font size: "make the body font bigger/smaller", "font size 20px", "1.5x font"
    const pxMatch = lower.match(/(\d{1,3})\s*px/);
    if (/\bfont\b|\btext\b/.test(lower) && pxMatch) {
      return makeRecord({
        name: `Font ${pxMatch[1]}px`,
        kind: "font-size",
        params: { px: clampNum(pxMatch[1], 8, 72) },
      });
    }
    const factorMatch = lower.match(/(\d+(?:\.\d+)?)\s*x\b/);
    if (/\bfont\b|\btext\b/.test(lower) && factorMatch) {
      return makeRecord({
        name: `Font ${factorMatch[1]}x`,
        kind: "font-scale",
        params: { factor: clampNum(factorMatch[1], 0.5, 4) },
      });
    }
    if (/\b(bigger|larger|increase)\b/.test(lower) && /\bfont\b|\btext\b/.test(lower)) {
      return makeRecord({ name: "Bigger font", kind: "font-scale", params: { factor: 1.25 } });
    }
    if (/\b(smaller|decrease|reduce)\b/.test(lower) && /\bfont\b|\btext\b/.test(lower)) {
      return makeRecord({ name: "Smaller font", kind: "font-scale", params: { factor: 0.85 } });
    }

    // 3) dark mode
    if (/\bdark\b/.test(lower) && /\bmode|theme|background|page|site\b/.test(lower)) {
      return makeRecord({ name: "Dark mode", kind: "dark", params: {} });
    }

    // 4) narrow / readable width: "narrow the page", "max width 600"
    const widthMatch = lower.match(/(?:width|narrow|readable).*?(\d{3,4})/);
    if (/\b(narrow|readable|width)\b/.test(lower)) {
      return makeRecord({
        name: "Readable width",
        kind: "width",
        params: { maxWidth: widthMatch ? clampNum(widthMatch[1], 320, 1600) : 720 },
      });
    }

    return null;
  }

  function clampNum(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function makeRecord({ name, kind, params }) {
    const css = compileCss(kind, params);
    return {
      id: `${kind}-${Math.random().toString(36).slice(2, 9)}`,
      name,
      kind,
      params,
      css,
      enabled: true,
      createdAt: Date.now(),
    };
  }

  // ---- apply / unapply (CSS only, fully reversible) --------------------
  function styleEl(id) {
    return document.getElementById(`${STYLE_PREFIX}${id}`);
  }

  function applyRecord(rec) {
    if (!rec || !rec.enabled || !rec.css) return false;
    let el = styleEl(rec.id);
    if (!el) {
      el = document.createElement("style");
      el.id = `${STYLE_PREFIX}${rec.id}`;
      el.setAttribute("data-agee-tweak", rec.name || rec.kind);
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = rec.css;
    return true;
  }

  function unapplyRecord(id) {
    const el = styleEl(id);
    if (el) el.remove();
  }

  // The "maintain it for you" core: re-apply every enabled tweak for this origin
  // on every load. Runs at content-script start.
  async function applySaved() {
    const list = await loadTweaks();
    let applied = 0;
    for (const rec of list) {
      if (applyRecord(rec)) applied += 1;
    }
    return applied;
  }

  // ---- public ops (used by overlay UI and smoke) -----------------------
  async function applyInstruction(instruction) {
    const rec = planTweak(instruction);
    if (!rec) {
      return { ok: false, error: `No bounded tweak matched: "${instruction}"` };
    }
    const list = await loadTweaks();
    list.push(rec);
    await saveTweaks(list);
    applyRecord(rec);
    return { ok: true, tweak: publicView(rec) };
  }

  async function listTweaks() {
    const list = await loadTweaks();
    return { ok: true, origin: ORIGIN, tweaks: list.map(publicView) };
  }

  async function removeTweak(id) {
    const list = await loadTweaks();
    const next = list.filter((t) => t.id !== id);
    const removed = next.length !== list.length;
    await saveTweaks(next);
    unapplyRecord(id);
    return { ok: removed, removed, remaining: next.length };
  }

  async function clearTweaks() {
    const list = await loadTweaks();
    for (const t of list) unapplyRecord(t.id);
    await saveTweaks([]);
    return { ok: true };
  }

  // Whether a tweak's <style> is currently live in the DOM. The smoke uses this
  // to prove auto-re-apply after a reload.
  function isApplied(id) {
    return !!styleEl(id);
  }

  // Inspectable view: exactly what is stored, including the compiled CSS, so a
  // user (or the smoke) can read the customization. No opaque code.
  function publicView(rec) {
    return {
      id: rec.id,
      name: rec.name,
      kind: rec.kind,
      params: rec.params,
      css: rec.css,
      enabled: rec.enabled,
    };
  }

  // ---- messaging (own namespace, OUT of the main command path) ---------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || typeof msg.cmd !== "string" || !msg.cmd.startsWith("tweak:")) return;
    switch (msg.cmd) {
      case "tweak:ping":
        reply({ ok: true, origin: ORIGIN });
        return true;
      case "tweak:apply":
        applyInstruction(msg.instruction).then(reply);
        return true;
      case "tweak:list":
        listTweaks().then(reply);
        return true;
      case "tweak:remove":
        removeTweak(msg.id).then(reply);
        return true;
      case "tweak:clear":
        clearTweaks().then(reply);
        return true;
      case "tweak:status":
        listTweaks().then((res) => {
          const applied = (res.tweaks || []).map((t) => ({ id: t.id, applied: isApplied(t.id) }));
          reply({ ok: true, origin: ORIGIN, applied });
        });
        return true;
      default:
        return false;
    }
  });

  // Auto-apply saved tweaks on every load. This is the maintenance the agent
  // takes on so the user only ever has to BUILD a tweak once.
  applySaved();

  // Expose a tiny inspectable handle for in-page debugging (no behavior beyond
  // the message API). Functions are deterministic and reference the same store.
  window.__ageeTweaks = { applyInstruction, listTweaks, removeTweak, clearTweaks, applySaved, planTweak };
})();
