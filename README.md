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

## Run it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the [extension/](extension/) folder.
2. Click the **agee** toolbar icon → paste your Anthropic API key → Save.
3. For the demo and development loop, run `npm run dev` and open `http://localhost:7777/fixtures/demo.html`. For any other low-risk page, open it normally.
4. Press **Cmd+K** (Mac) / **Ctrl+K**, type an instruction (e.g. *"search docs for browser agent"*), hit Enter. If Chrome reports a shortcut conflict, set the shortcut at `chrome://extensions/shortcuts`.

## Develop it

Use a separate localhost page and a separate extension page for development:

```sh
npm run dev
```

Then:

1. Load unpacked [extension/](extension/) once in `chrome://extensions`.
2. Copy the extension id from the agee extension card.
3. Open `chrome-extension://<extension-id>/dev.html?server=http://localhost:7777`.
4. Open `http://localhost:7777/fixtures/demo.html` as the page you test against.

Keep both pages open. When you edit files under [extension/](extension/) or [fixtures/](fixtures/), the dev bridge reloads the extension and localhost demo tabs. The next Cmd/Ctrl+K run uses the latest code.

This keeps development on a controlled page instead of your normal tabs. The dev bridge only reloads `localhost` / `127.0.0.1` tabs, so normal browsing is not part of the test loop.

## Verify it

Run:

```sh
npm run verify
npm run smoke
```

`verify` checks that the MV3 manifest parses, required files exist, required permissions/commands are present, and extension JavaScript has valid syntax.

`smoke` launches Chrome, opens the demo page, confirms the overlay loads, snapshots page affordances, executes type/click actions, and captures a screenshot. If local Chrome policy refuses `--load-extension`, the script falls back to injecting the same content script into the browser page as a harness and says so in the output.

## How it fits together

- [extension/manifest.json](extension/manifest.json) — MV3 manifest, no build step.
- [extension/content.js](extension/content.js) — the Cmd+K overlay, page perception, and action execution (the only part touching the DOM).
- [extension/background.js](extension/background.js) — holds the key, runs the agent loop, calls the model, captures screenshots.
- [extension/options.html](extension/options.html) / [options.js](extension/options.js) — key + model settings.
- [extension/dev.html](extension/dev.html) / [dev.js](extension/dev.js) — local reload bridge for extension development.

The model call lives in the background service worker, not the page, so the network boundary stays in one place.

## Review artifacts

- [NEXT.md](NEXT.md) — cleaned product direction from raw notes.
- [docs/task-split.md](docs/task-split.md) — workstreams, delegated research, and next delegation candidates.
- [docs/research.md](docs/research.md) — prior art and build-vs-borrow decision.
- [docs/architecture.md](docs/architecture.md) — runtime boundaries, message contract, agent loop, and security rules.
- [docs/customization.md](docs/customization.md) — customization and future userScripts path.
- [docs/validation.md](docs/validation.md) — demo script and validation questions.
- [LICENSE](LICENSE) — MIT license for the open-source promise.

`__LOG__.md` is raw thinking — not part of the product.
