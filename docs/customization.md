# Customization Path

Agee should be customizable from inside the application, but executable extension behavior should not be silently updated from a website.

## What Can Update From The App

These can be changed safely because they are declarative user settings:

- Overlay placement.
- Overlay size and density.
- Theme.
- Default input mode.
- Prompt templates.
- Per-site enablement.
- Declarative tweaks such as hide element, rename label, prefill text, or open URL.
- Workflow definitions that compile to the existing constrained action DSL.

These settings should live in `chrome.storage.local` for local-only use, with a later sync path only after the user chooses to save or claim their work.

## What Should Not Update From The App

These should not come from a remote website:

- Content-script JavaScript.
- Background service-worker JavaScript.
- Arbitrary user-provided JavaScript.
- Permission changes.
- Code that can read secrets, cookies, or page credentials.

If the extension needs new executable behavior, ship a new extension version or require an explicit user-controlled script permission path.

## UserScripts Later

UserScripts are the right escape hatch for advanced per-site customization, but not the first default.

The future walkthrough should be concrete:

1. Install the extension.
2. Pin it for quick access.
3. Enable script permissions.
4. Install or create a first tweak.
5. Test it on a low-risk page.
6. Save locally without signing in.
7. Offer account claim/sync only after the user has created something worth keeping.

Implementation notes:

- Do not request the `userScripts` permission in v0.
- Add it only when there is UI that explains why it is needed.
- Keep user scripts disabled by default.
- Store script source locally unless the user chooses to sync it.
- Show the exact site match patterns before enabling a script.
- Provide a one-click disable path for each script.

## No-Sign-In Creation

The first customization loop should work without an account:

- User creates a tweak.
- Tweak is saved locally.
- User can export it.
- User can later claim or sync it.

This keeps the first experience focused on creation instead of authentication.

## Dev Loop

Customization work should use the same isolated development path:

- `npm run dev` serves the demo page.
- `extension/dev.html` polls the dev server.
- Changes under `extension/` reload the unpacked extension.
- Changes under `fixtures/` reload the localhost demo page.
- Normal browsing tabs are not touched.
