# Architecture: Agee Browser Prototype

Agee starts as a Chrome Manifest V3 extension because the browser is the smallest surface where a user-owned interface can appear on top of real work and, when explicitly asked, experiment with page-aware actions.

## Goals

- User-owned and open source.
- Thin client for a self-hosted or hosted agent gateway.
- Provider keys, subscriptions, model routing, and durable state live on the
  gateway, not in the browser.
- Browser-native interface first, with a path to desktop/Moa/local runtimes later.
- No sidebar as the primary surface.
- Keep extension development on a dedicated dev bridge page and localhost demo page.
- Simple enough to load unpacked and review today.
- Constrained enough that the model cannot execute arbitrary code.

## Non-Goals For This Version

- Full cross-tab autonomous browsing.
- A standalone browser agent product identity.
- Sidebar-first UX.
- Account/payment/password workflows.
- Cross-origin iframe control.
- Native dialogs, file pickers, browser UI, or restricted browser pages.
- Hosted billing, usage caps, or telemetry.
- Extension marketplace polish.
- Remote JavaScript updates.

## Runtime Boundaries

### Content Script

Files:

- `extension/content.js`
- `extension/overlay.css`

Responsibilities:

- Render the command overlay.
- Render the on-page invocation surface.
- Accept typed and browser-native voice input.
- Collect visible interactable page elements.
- Execute constrained page actions.
- Show progress, completion, and errors.

The content script is the only component that touches the page DOM.

Normal pages receive the content script after user invocation through the Manifest `commands` shortcut and `chrome.scripting`. The localhost demo page is the only auto-injected content-script match so automated smoke tests can run without broad all-sites access.

### Background Service Worker

File:

- `extension/background.js`

Responsibilities:

- Read gateway connection settings from `chrome.storage.local`.
- Capture visible-tab screenshots.
- Route commands, describe requests, profile updates, and agent work to the
  configured gateway.
- Validate and translate gateway-proposed actions into content-script actions.
- Handle the extension keyboard command.

The background worker does not hold provider API keys and does not call model
vendors directly. It holds only the engine URL/session token needed to reach the
gateway.

### Options Page

Files:

- `extension/options.html`
- `extension/options.js`

Responsibilities:

- Save the user's gateway URL/token locally.
- Read and write gateway-owned runtime profile fields such as system prompt,
  model selection, temperature, language, and voice settings.
- Explain that provider credentials live on the gateway, not in the browser.

### Dev Bridge

Files:

- `extension/dev.html`
- `extension/dev.js`
- `scripts/dev-extension.mjs`

Responsibilities:

- Run development against `http://localhost:7777/fixtures/demo.html`, not arbitrary active tabs.
- Poll the local dev server for file-change versions.
- Call `chrome.runtime.reload()` when extension files change.
- Reload only localhost / 127.0.0.1 demo tabs so content scripts re-inject with the latest code.
- Keep normal browsing outside the development loop.

The dev bridge is an extension page, not a content script. It has access to extension APIs and can reload the extension, while the demo page stays a disposable target for testing page UI and actions.
It is a developer-only convenience for unpacked-extension work, not a user-facing
promotion, deployment, or customization path.

## Message Contract

Current messages are intentionally small:

```ts
type OverlayToWorker =
  | { cmd: "run"; instruction: string }
  | { cmd: "cancel" };

type WorkerToContent =
  | { cmd: "ping" }
  | { cmd: "toggle" }
  | { cmd: "open" }
  | { cmd: "confirm"; text: string }
  | { cmd: "snapshot" }
  | { cmd: "act"; action: Action; index?: number; text?: string; url?: string; direction?: "up" | "down" }
  | { cmd: "progress"; text: string }
  | { cmd: "done"; summary: string }
  | { cmd: "error"; text: string };

type Action =
  | "click"
  | "type"
  | "clear"
  | "select"
  | "scroll"
  | "navigate"
  | "key"
  | "wait";
```

Current hardening:

- One active task is allowed per tab.
- The overlay has a stop control that cancels the current task.
- Risky DOM actions and cross-origin navigation ask for user confirmation.
- Non-HTTP(S) navigation is blocked.
- Task status is checkpointed to `chrome.storage.local` after major steps so a worker interruption leaves evidence of the last known state.

Next hardening step:

- Wrap all messages in a typed envelope with `id`, `version`, `source`, `tabId`, `frameId`, `origin`, and `createdAt`.
- Add structured error codes such as `NO_ACTIVE_TAB`, `NO_PERMISSION`, `MODEL_TIMEOUT`, and `ACTION_TARGET_NOT_FOUND`.
- Persist a resumable conversation state without storing large screenshot payloads.

## Agent Loop

1. User opens overlay with Cmd/Ctrl+K through the extension command. On the localhost demo page, the content script shortcut also works directly.
2. User enters a typed or spoken instruction.
3. Content script sends `{ cmd: "run", instruction }`.
4. Background asks content script for a fresh snapshot.
5. Background captures a visible-tab screenshot.
6. Background sends instruction, DOM affordances, and screenshot to the gateway.
7. The gateway/model returns an answer, run status, or action proposal.
8. Background validates any proposed action and executes it through the content script or tab API.
9. Background waits briefly, refreshes snapshot/screenshot, and continues.
10. Loop ends when the model calls `finish`, errors, or hits the step limit.

This loop is experimental capability. The product frame remains a browser-native interface that can host multiple workflows, not an autonomous browser agent whose default behavior is to take over tabs.

## Security Rules

- Never execute model-generated JavaScript.
- Never inject remote code.
- Do not update executable extension behavior from a website.
- Keep provider API keys and subscriptions out of the extension entirely.
- Route model/API-backed actions through the configured gateway.
- Capture screenshots only after user invocation.
- Restrict model actions to the explicit action DSL.
- Block non-HTTP(S) navigation.
- Confirm cross-origin navigation.
- Reject concurrent tasks in the same tab.
- Treat screenshots and prompts as sensitive user data.
- Use `activeTab` and explicit user invocation instead of broad all-sites background access.

## Customization Boundary

Safe to update from the app:

- Theme settings.
- Shortcut preferences where Chrome allows user control.
- Overlay placement and density.
- Prompt templates.
- Declarative tweaks and workflow definitions.

Not safe to update from the app:

- Arbitrary JavaScript loaded from a website.
- Extension service-worker code.
- Content-script code.
- Permission grants without explicit Chrome approval.

If userScripts are added later, they should be an explicit opt-in path with a walkthrough, a clear permission gate, and user-owned scripts stored locally or in an account the user controls.

## Review Checklist

- Manifest parses as valid JSON.
- Extension JavaScript passes syntax checks.
- Cmd/Ctrl+K works through the Manifest `commands` entry point.
- Localhost demo content-script path works for automated smoke tests.
- Developer-only dev bridge reloads the unpacked extension when `extension/`
  files change.
- Dev bridge touches only localhost / 127.0.0.1 test tabs.
- Options page stores and reloads gateway URL/token settings.
- Runtime profile settings read/write through gateway endpoints.
- Screenshot capture path lives in the background worker.
- Gateway-routed action proposals use a constrained action schema.
- Content script can snapshot visible affordances.
- Content script can click/type/scroll/select without arbitrary code execution.
