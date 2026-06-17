# agee — tweak any website

Not a browser agent. Not a sidebar. agee lets you **change the website you're on**: pop the bar, speak or type, and the page changes. Save tweaks; they re-apply on revisit. No login to start.

## The loop
```
on a page → click the floating "agee" pill, or press the shortcut → overlay
   → HOLD the mic (or Space) to talk, release = done   — or just type
   → Enter → model returns a tweak (CSS/JS) → applied live
   → "Save" → stored per-site, re-applied on every revisit
```

## Design decisions (the open questions)
- **Invoke:** a **draggable pill** (place it anywhere — primary, zero memory) + a customizable shortcut, default **Cmd/Ctrl+Shift+Space**. `fn` isn't reliably exposed to browser JS, so it's not the default.
- **"How do we know when they finished speaking?"** — **hold-to-talk: release = done.** Deterministic, no silence-guessing, no cut-offs.
- **"What language?"** — defaults to your browser language with a picker in setup. True auto-detect (any language) is the roadmap item, via cloud transcription (Whisper-class) — which also fits the "use your ChatGPT subscription" path.

## Run it
1. `chrome://extensions` → Developer mode → **Load unpacked** → select this `tweaks/` folder.
2. Click the agee toolbar icon → paste your Anthropic API key → Save.
3. Open any normal website → click the **agee** pill (bottom-right, draggable) → hold the mic and say e.g. *"hide the cookie banner"* / *"make the background dark"* / *"bigger body text"* → release → Enter → Save.

## What's built vs next
- **Built:** floating pill + shortcut, overlay, hold-to-talk voice (Web Speech) + text, model→CSS/JS tweak, live apply, per-site save + toggle/delete + re-apply on load, onboarding page.
- **Next:** cloud STT for auto-language; share/import tweaks; no-login local→claim-later + credits; `chrome.userScripts` for persistent arbitrary code; "build/customize agee from within"; tab management.

## Files
- [manifest.json](manifest.json) · [content.js](content.js) (pill, overlay, voice, apply, save) · [background.js](background.js) (one model call → tweak) · [overlay.css](overlay.css) · [onboarding.html](onboarding.html)/[onboarding.js](onboarding.js)

> Supersedes the browser-agent direction in `../extension/`. That folder (and the parallel docs) belong to the old, now-retired concept.
