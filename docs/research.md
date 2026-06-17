# Research: Browser-Native Interface Prior Art

This note turns the raw `__LOG__.md` question into a build decision: should Agee build its own first browser extension, borrow from an existing project, or wrap an existing agent runtime?

The latest direction is explicit: Nanobrowser is not the product shape, a sidebar is not the primary UI, and Agee should not position itself as a browser agent. The useful part to borrow is the browser-native capability surface. The product should be an interface and experimentation layer that can later host agentic behavior.

## What Exists

### Nanobrowser

Nanobrowser is the closest direct prior art: an open-source Chrome extension for AI web automation. It advertises browser-local operation, bring-your-own LLM keys, and multi-agent workflows.

What it proves:

- The category is real enough that a Chrome extension is a valid first surface.
- BYO-key browser automation is understandable to early adopters.
- A multi-agent planner/navigator/validator loop is a credible architecture for later versions.

Gap for Agee:

- Agee should not copy the browser-agent framing.
- The differentiator has to be user-owned extensibility, fast iteration, and an on-page product surface that can become the user's personal agent layer.

### Browser Use

Browser Use is an open-source browser automation framework oriented around giving agents a browser action space. It is useful prior art for action design, recovery loops, and extracting page affordances for models.

What it proves:

- DOM affordances plus screenshots are a workable first perception model.
- The hard problem is not only action execution; it is keeping state fresh after every action.

Gap for Agee:

- It is not the browser-extension product surface by itself.
- It is more useful as architecture inspiration than as the first dependency.
- Agee should avoid letting automation architecture swallow the interface thesis.

### PageAgent

PageAgent is relevant because it explores in-page GUI control through injected JavaScript and a DOM action layer.

What it proves:

- A content-script style page executor can cover many useful tasks before adding a heavy native companion.
- DOM/text-driven actions are a good first layer, with optional screenshots for disambiguation.

Gap for Agee:

- Agee still needs the product shell: Cmd/Ctrl+K, BYO keys, settings, progress, safety, and an ownership story.

### Stagehand

Stagehand is useful as a design reference because it blends deterministic automation with natural-language browser actions.

What it proves:

- Production browser agents should not hand every decision to the model.
- Structured flows plus AI fallback are easier to debug than pure autonomy.

Gap for Agee:

- Stagehand is a developer automation library, not the user-facing browser extension layer.

### agent-browser and OpenCLI

These projects point toward compact action APIs for agents operating real or controlled browsers.

What they prove:

- Stable element references and commands such as `observe`, `click(ref)`, `type(ref, text)`, and `screenshot` are easier to inspect than raw DOM dumps.
- "Use my real browser session" is a strong user-owned direction.

Gap for Agee:

- Agee's first extension can borrow the command vocabulary without adopting a CLI-first runtime.

### Automa

Automa is mature browser-extension workflow automation.

What it proves:

- Browser extension automation is an established user behavior.
- Workflow/history/status surfaces matter once users start repeating tasks.

Gap for Agee:

- Its workflow-builder model is not the first Agee surface.
- Licensing and architectural weight make it a poor code base to absorb for v0.

### WXT, Plasmo, and cmdk

These are implementation accelerators for later versions.

What they prove:

- A production extension should probably move to a real extension framework and accessible command-palette primitives.

Gap for Agee:

- The current artifact intentionally stays no-build so it can be loaded and inspected immediately.

### UserScripts and Website Customizers

UserScript managers and website customization tools prove that people understand "modify this website" when the permission and install flow are concrete.

What they prove:

- Per-site customization is legible.
- Users can opt into script-like power when there is a walkthrough.
- The install flow needs clear steps: install extension, pin it, enable script permissions, install or create tweaks.

Gap for Agee:

- Remote script updates are too risky for the first prototype.
- The v0 should support declarative customization first and document userScripts as a later explicit permission path.

### Operator-Style Products

Managed browser agents prove user demand for "ask an agent to do the web task." They also prove the trust problem: the agent sees private pages and can take real actions.

What they prove:

- Browser control is legible.
- Users will try agentic browsing when the UX is simple.

Gap for Agee:

- Hosted-only products create the exact silo Agee is trying to avoid.
- Agee must make ownership, inspectability, and modification part of the product.

### Browser Extension APIs

Chrome Manifest V3 supports the MVP:

- `commands` for keyboard shortcuts.
- `activeTab` and/or host permissions for page access after user invocation.
- `tabs.captureVisibleTab()` for visible-page screenshots.
- Content scripts for overlay UI, DOM perception, and page actions.
- A background service worker for model calls and orchestration.
- `storage.local` or `storage.session` for settings.

Constraints:

- MV3 service workers are event-driven and can be terminated, so long-running agents need careful state handling.
- Some pages are restricted.
- Cross-origin iframes, browser UI, native dialogs, file pickers, and Chrome Web Store pages are not reliable first targets.
- `captureVisibleTab()` is rate-limited.

## Build vs Borrow

Build the first Agee prototype directly as a no-build MV3 extension.

Borrow ideas, not the whole stack:

- From Nanobrowser: BYO-key positioning and browser-local extension packaging, not the product shape.
- From PageAgent: keep page actions inside the page executor before reaching for a heavier browser harness.
- From Browser Use: fresh snapshot after every action, numbered affordance list, explicit action DSL.
- From Stagehand: move repeated workflows toward deterministic steps with AI only where needed.
- From agent-browser/OpenCLI: use stable action references and compact command vocabulary.
- From extension docs: keep model calls in the service worker; keep DOM actions in the content script.

Do not start by forking another large project. The project needs a small, inspectable artifact today, and a fork would make the architecture harder to reason about before the product thesis is validated.

## First Prototype Decision

The first version should be intentionally narrow:

- Cmd/Ctrl+K opens an overlay on the current page.
- A small on-page control can invoke the same overlay.
- User types or speaks an instruction.
- Development happens through a separate `dev.html` bridge plus a localhost demo page.
- Edits under `extension/` reload into the unpacked extension through the dev bridge.
- Background can run an experimental one-action-at-a-time model loop.
- Content script executes only constrained actions.
- Every action refreshes page state.

Voice, long-running workflows, userScripts, and local model runtimes are directionally important but should not block the first reviewable artifact. Side-panel history should not be the default surface.
