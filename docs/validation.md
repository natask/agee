# Validation Plan

The prototype is not validated by existing as code. It needs direct feedback.

## Product Questions

- Will anyone install an unpacked extension to try a browser-native interface?
- Does Cmd/Ctrl+K feel like the right surface?
- Does a small movable on-page control feel better than a sidebar?
- Is bring-your-own-key acceptable to early users?
- Does open source ownership matter enough to change behavior?
- Is browser-first better than starting inside Moa or desktop?
- Will users customize a website before creating an account?

## Technical Questions

- Does screenshot plus interactable-element list give the model enough context?
- How often does stale page state cause wrong actions?
- Which sites break content-script interaction first?
- How often does MV3 service worker lifecycle interrupt tasks?
- Which actions need confirmation before the first public demo?

## Today Demo Script

1. Load `extension/` unpacked in Chrome.
2. Save an Anthropic key in the options page.
3. Run `npm run dev` from the repo.
4. Open `chrome-extension://<extension-id>/dev.html?server=http://localhost:7777` in a separate extension page.
5. Open `http://localhost:7777/fixtures/demo.html`, or open another low-risk page.
6. Press Cmd/Ctrl+K. If Chrome reports a shortcut conflict, set the shortcut at `chrome://extensions/shortcuts`.
7. Ask Agee to search for something.
8. Watch the overlay show progress and execute the first click/type/key sequence.

## Automated Smoke

Run:

```sh
npm run smoke
```

This launches Chrome and verifies:

- The content script loads on the demo page, or the smoke harness injects the same script when local Chrome policy refuses `--load-extension`.
- Cmd/Ctrl+K opens the overlay.
- The content script can type and click on the page.
- A browser screenshot can be captured.

## Development Loop Check

Run:

```sh
npm run dev
```

Expected behavior:

- The server prints the unpacked extension path.
- Open `chrome-extension://<extension-id>/dev.html?server=http://localhost:7777` in a separate tab.
- Open `http://localhost:7777/fixtures/demo.html` in another separate tab.
- Editing `extension/content.js`, `extension/background.js`, or `extension/overlay.css` increments the dev-server version.
- The dev bridge reloads the extension and only localhost / 127.0.0.1 demo tabs.
- Normal browsing tabs are not part of the development loop.

## Customization Walkthrough Gate

Before enabling userScripts, the product should have a walkthrough that can be tested manually:

1. Install the extension.
2. Pin it for quick access.
3. Enable script permissions in Chrome when prompted.
4. Install or create a first tweak.
5. Try the tweak without signing in.
6. Offer account claim/save only after the user has made something worth keeping.

## What Counts As Progress

- A working demo on a low-risk localhost site.
- A README that makes the thesis clear.
- A research note showing the project is not blind to prior art.
- An architecture note reviewers can argue with.
- A list of people to ping with the artifact.
