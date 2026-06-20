# Customization Path

Agee should be customizable from inside the application, but the extension
package is a stable thin client. User-specific customization is served by the
engine as data, not by silently updating executable extension behavior from a
website.

## What Can Update From The App

These can be changed safely because they are declarative user settings or
engine-served UI spec:

- Overlay placement.
- Overlay size and density.
- Theme.
- Default input mode.
- Runtime profile fields and prompt templates stored on the gateway.
- Per-site enablement.
- Declarative tweaks such as hide element, rename label, prefill text, or open URL.
- Workflow definitions that compile to the existing constrained action DSL.
- Extension UI structure represented as a declarative spec interpreted by the
  stable renderer.

Gateway URL/token live in `chrome.storage.local`. Customization state should
live on the configured engine so the same packaged extension works against a
self-hosted or hosted gateway.

## What Should Not Update From The App

These should not come from a remote website:

- Content-script JavaScript.
- Background service-worker JavaScript.
- Arbitrary user-provided JavaScript.
- Permission changes.
- Code that can read secrets, cookies, or page credentials.

If the extension needs new executable behavior, ship a new extension version or require an explicit user-controlled script permission path. Do not create an end-user "reload the unpacked extension" deployment path; disk reload is a developer convenience only.

## UserScripts Later

UserScripts are the right escape hatch for advanced per-site customization, but
not the first default. The default path is engine-served declarative UI spec.

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

Extension development should use the same isolated development path:

- `npm run dev` serves the demo page.
- `extension/dev.html` polls the dev server.
- Changes under `extension/` reload the unpacked extension.
- Changes under `fixtures/` reload the localhost demo page.
- Normal browsing tabs are not touched.

This loop is for development only. User customization must travel through the
engine-served spec/sandbox/userScripts paths above, not by promoting local disk
reload to an end-user feature.
