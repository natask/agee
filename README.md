# agee

An open-source, browser-native interface shell. Hit **Cmd/Ctrl+K** or click the on-page control, type or speak, and experiment with an agent surface directly on the website you are using. Bring your own API key. You own the code; run it locally, modify it, or host it.

## Principles

- **You own it.** Open source. Not a silo — a unifying layer over the surfaces you already use.
- **Bring your own key.** Your intelligence and your data are personal. Keys live in your browser, calls go straight to the model.
- **Interface first.** This is not a sidebar or a separate browser agent. It is a small, movable surface on the page that can grow into user-owned workflows.
- **Browser native.** The browser is the first surface because it is where the user's work already lives and where an extension can safely start with explicit user invocation.
- **Self-host or local.** Same core whether it runs on your machine or ours.

## Status

MVP - a Chrome (Manifest V3) extension you can load unpacked today.

**Works now:** Cmd+K command palette · on-page invocation surface · optional browser-native voice dictation · a controlled localhost dev page · a dev bridge that reloads the unpacked extension when code changes · experimental Claude action loop (your key) that can click / type / select / scroll / navigate on low-risk pages · per-step progress in the overlay.

**Next:** customization from inside the app · userScripts opt-in walkthrough · richer voice mode · cross-navigation task continuity · MOA integration · local-model backend.

## Develop it (quiet by default)

Development is **headless and off-screen**. It drives **Chrome for Testing**
(from the puppeteer cache) with a throwaway profile — never your daily
Chrome/Brave — so it never opens a window, never steals focus, and never
prompts. Branded Google Chrome hard-blocks `--load-extension`; Chrome for
Testing allows it and loads the real agee service worker.

```sh
npm run dev
```

That single command:

1. Serves the demo page at `http://localhost:7777/fixtures/demo.html`.
2. Launches a headless Chrome for Testing instance that loads [extension/](extension/) and prints the stable extension id.
3. Watches [extension/](extension/) and [fixtures/](fixtures/). On every edit it reloads the real extension in the background via `chrome.runtime.reload()` (or, when the headless service worker has gone dormant, by transparently relaunching the headless instance). No window appears either way.

Options:

- `npm run dev -- --port 8080` — change the localhost port.
- `npm run dev -- --no-browser` — run just the dev server (pair with the manual visible route below).

Prerequisite: Chrome for Testing must be in the puppeteer/playwright cache. If
it is missing, install it once with `npx @puppeteer/browsers install chrome@stable`,
or point `AGEE_CHROME_PATH` at a Chrome for Testing binary. Throwaway profiles,
logs, and screenshots are written under `.gstack/background-qa/` (git-ignored).

## See it (explicit, opt-in only)

The default loop above is intentionally invisible. When you actually want to
*watch* the extension on screen, this manual route is the only one to use — it
is separate from the quiet flow on purpose:

1. Run `npm run configure`. This bakes the gateway URL and token into
   `extension/agee.config.json` (git-ignored), so the extension works on load
   with no Options visit. The token is read from the main machine over SSH (or
   `MOA_GATEWAY_TOKEN` in your environment) and never printed.
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the [extension/](extension/) folder. It stays installed across browser restarts.
3. Open any low-risk page (or run `npm run dev -- --no-browser` and open `http://localhost:7777/fixtures/demo.html`).
4. Press **Cmd+K** (Mac) / **Ctrl+K**, type an instruction (e.g. *"search docs for browser agent"*), hit Enter. If Chrome reports a shortcut conflict, set the shortcut at `chrome://extensions/shortcuts`.

The duck floats and wanders the page when idle, glows while it works, and rings
(a short chime plus a ring pulse) when a turn finishes, errors, or needs you.
To override the baked defaults, use the **agee** toolbar icon → Options.

Optionally open `chrome-extension://<extension-id>/dev.html?server=http://localhost:7777`
in that browser to get the in-page reload bridge for this manual session.

## Verify it

Run:

```sh
npm run verify
npm run smoke
```

`verify` checks that the MV3 manifest parses, required files exist, required
permissions/commands are present, and the extension/harness JavaScript has valid
syntax.

`smoke` launches headless Chrome for Testing with a throwaway profile, loads the
real [extension/](extension/), and confirms the agee background **service worker**
loads with a stable id. It then drives the real background → content-script
message path (`snapshot`, `type`, `click`) against the demo page and captures a
screenshot — no window shown, no focus taken. It exercises the **real** extension;
if the resolved Chrome ever refuses `--load-extension`, smoke fails loudly rather
than falling back to a content-script harness.

## Verify the gateway round-trip

The overlay does not talk to the model vendor directly when a gateway is
configured — it talks to **your** agent gateway. `smoke:gateway` proves that path
end to end, headless and off-screen (same quiet rules as `smoke`):

```sh
npm run smoke:gateway                        # health + loud-error legs
AGEE_GATEWAY_TOKEN=<token> npm run smoke:gateway   # + authenticated legs
```

It loads the real extension, writes the gateway URL + token into
`chrome.storage.local` (exactly as the Options page does), opens the overlay, and
drives real `run` / `describe` submits while a `fetch` recorder in the service
worker observes which gateway path produced each rendered reply. The default
gateway is the live one (`http://10.147.17.10:8788`); override with
`AGEE_GATEWAY_URL`.

**Confirmed round-trip sequence (what the smoke asserts):**

1. **Health** — with the URL configured, `GET /health` returns `200 {ok:true}`
   (no token needed). This is the reachability gate.
2. **Command** — a command submitted in the overlay is sent as `run` →
   `background.js` `POST /v1/voice/turns` (with `Authorization: Bearer <token>`)
   → the gateway's `display`/`text` reply renders as a **done** row in the
   overlay. The recorder confirms the reply originated from `/v1/voice/turns`.
3. **Describe** — "describe page" is sent as `describe` → `POST /v1/chat` → the
   gateway's `text` renders as a **done** row. The recorder confirms it
   originated from `/v1/chat`.
4. **Loud failure** — pointed at the gateway with **no/invalid token**, the same
   command hits `POST /v1/voice/turns`, the gateway returns `401`, and the
   overlay renders a clear **error** row ("Gateway rejected the token (401).
   Open agee Options and set a valid Gateway token, then Save.") with a red
   status dot. The failure is visible, never silent.

The bearer token is read **only** from `AGEE_GATEWAY_TOKEN` at run time (never
from a file, never printed — see [.env.example](.env.example)). Without it, legs
1–2 above are skipped (implemented, awaiting the token) while the **health** and
**loud-error** legs always run; the smoke does not fail just because the token is
absent.

## How it fits together

- [extension/manifest.json](extension/manifest.json) — MV3 manifest, no build step.
- [extension/content.js](extension/content.js) — the Cmd+K overlay, page perception, and action execution (the only part touching the DOM).
- [extension/background.js](extension/background.js) — holds the key, runs the agent loop, calls the model, captures screenshots.
- [extension/options.html](extension/options.html) / [options.js](extension/options.js) — key + model settings.
- [extension/dev.html](extension/dev.html) / [dev.js](extension/dev.js) — in-page reload bridge for the manual visible dev session.
- [scripts/chrome-for-testing.mjs](scripts/chrome-for-testing.mjs) — resolves the headless Chrome for Testing binary and the quiet launch flags shared by the dev loop and smoke.

The model call lives in the background service worker, not the page, so the network boundary stays in one place.

## Review artifacts

- [NEXT.md](NEXT.md) — cleaned product direction from raw notes.
- [docs/task-split.md](docs/task-split.md) — workstreams, delegated research, and next delegation candidates.
- [docs/research.md](docs/research.md) — prior art and build-vs-borrow decision.
- [docs/architecture.md](docs/architecture.md) — runtime boundaries, message contract, agent loop, and security rules.
- [docs/chrome-agent-surface.md](docs/chrome-agent-surface.md) — Chrome global command, desktop capture, and browser-based Moa decision note.
- [docs/customization.md](docs/customization.md) — customization and future userScripts path.
- [docs/validation.md](docs/validation.md) — demo script and validation questions.
- [LICENSE](LICENSE) — MIT license for the open-source promise.

`__LOG__.md` is raw thinking — not part of the product.
