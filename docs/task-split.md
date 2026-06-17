# Task Split

This is the current split for turning the notes into a reviewable artifact and a working prototype.

## Workstreams

### 1. Product Thesis

Output:

- `NEXT.md`
- `README.md`

Questions answered:

- What is Agee?
- Why browser first?
- Why interface first?
- Why open source?
- What can someone try today?

### 2. Prior-Art Research

Output:

- `docs/research.md`

Questions answered:

- Who is already building in this space?
- What should Agee borrow?
- What should Agee avoid?
- Does the first prototype build on another project or start small?

Delegated result:

- A research subagent surveyed Nanobrowser, PageAgent, Browser Use, Stagehand, agent-browser, OpenCLI, Skyvern, Automa, BrowserOS, WXT, Plasmo, and cmdk.

Decision:

- Build the v0 extension shell directly.
- Borrow architectural patterns, not code or a full stack.

### 3. Browser Extension Capability Research

Output:

- `docs/architecture.md`

Questions answered:

- Can an extension capture page context and screenshots?
- Where should model calls live?
- What permissions are needed?
- What should be blocked or deferred?

Delegated result:

- A capability subagent checked MV3 boundaries, `commands`, `activeTab`, `scripting`, `tabs.captureVisibleTab()`, `storage`, service-worker lifecycle, content scripts, options pages, and Chrome Web Store policy concerns.

Decision:

- Use MV3.
- Keep model calls in the service worker.
- Keep DOM perception/actions in the content script.
- Add `commands` for Cmd/Ctrl+K.
- Treat screenshots and prompts as sensitive.

### 4. Prototype Implementation

Output:

- `extension/manifest.json`
- `extension/background.js`
- `extension/content.js`
- `extension/overlay.css`
- `extension/options.html`
- `extension/options.js`

Current capability:

- Cmd/Ctrl+K overlay.
- Cmd/Ctrl+K extension command entry point.
- On-page invocation surface.
- Optional voice dictation via browser-native speech recognition.
- BYO Anthropic key and model settings.
- Page affordance snapshot.
- Visible-tab screenshot capture.
- Experimental model-backed action loop.
- Constrained actions: click, type, clear, select, scroll, navigate, key, wait.
- Blocked non-HTTP(S) navigation.
- Confirmation for risky DOM actions and cross-origin navigation.
- Per-tab run lock and stop/cancel flow.
- Lightweight task-state checkpointing in extension storage.
- Local dev bridge: edit extension files, reload the unpacked extension, and test on a dedicated localhost page.
- Dev loop is isolated from normal browsing; only localhost / 127.0.0.1 test tabs reload.

### 5. Customization Path

Output:

- `docs/customization.md`

Questions answered:

- What can be customized from inside the app?
- What should not be remotely updated?
- How should userScripts become an explicit opt-in later?

Decision:

- Allow declarative customization first.
- Do not ship remote JavaScript updates.
- Add userScripts only behind a user-controlled Chrome permission walkthrough.

### 6. Verification

Output:

- `scripts/verify-extension.mjs`
- `docs/validation.md`

Checks:

- Manifest parses.
- Required files exist.
- Required permissions and command are present.
- Extension JavaScript has valid syntax.

Manual runtime gate:

- Load `extension/` unpacked in Chrome.
- Save API key in options.
- Open a low-risk site.
- Press Cmd/Ctrl+K.
- Ask Agee to act.
- Confirm overlay progress and page action.

## Next Delegation Candidates

These are separable follow-ups:

- Frontend worker: replace plain overlay with a polished movable command surface, not a sidebar.
- Agent-runtime worker: add typed envelopes, structured errors, cancellation, and confirmation gates.
- Research worker: inspect Nanobrowser/PageAgent internals for action-loop design without copying code.
- QA worker: run extension across five representative sites and record failure modes.
