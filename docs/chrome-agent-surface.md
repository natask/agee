# Chrome Agent Surface Decision Note

Status: draft, created 2026-06-18.

This note consolidates the current repo research, recent cross-agent chat
history, and current Chrome extension API constraints for the browser-based Moa
surface, currently named Agee.

## Source Trail

- `software/browser_extension/docs/research.md`: prior-art scan and build-vs-
  borrow decision.
- `software/browser_extension/docs/architecture.md`: current MV3 extension
  boundaries.
- `scratch/agee-decisions/hotreload-and-customization-20260617/decision.md`:
  hot reload, user customization, and self-modification axes.
- `scratch/agee-decisions/three-piece-product-20260617/product-thesis.md`:
  browser UI, agent infrastructure, and action layer product framing.
- Cross-agent chat search with `ch list --all -p`, especially:
  - `moa-assistant` session `96be4dda-c66`: research document follow-up.
  - `moa-assistant` session `019ed91b-2fe`: inaccessible ChatGPT share titled
    "Browser Partner Watch".
  - `moa-assistant` session `9739306e-e67`: Chrome desktop capture exploration.

The shared ChatGPT document body was not accessible through the available fetch
path in prior sessions. Those sessions only recovered the title, "Browser
Partner Watch", so this document does not claim to quote or summarize its hidden
body.

## Decision

Enable the browser extension as the first Moa surface for near-term product
work. The reason is not that Chrome gives silent control over the machine. It
does not. The reason is that Chrome gives a deployable, user-consented surface
that can combine:

- a global keyboard command to summon the assistant, even when Chrome is not
  focused on supported desktop platforms;
- page-local UI and page-local actions through content scripts after invocation;
- current-tab screenshots through extension APIs;
- whole-screen, window, tab, and optional audio capture through an explicit
  Chrome desktop media picker;
- a gateway handoff path for model routing, memory, agent runs, and heavier
  execution.

That is enough to make Agee the browser-based Moa interface. It is not enough to
make the extension a silent operating-system controller.

## What Chrome Allows

### Global Invocation

Chrome extension commands can be marked `"global": true`. By default, command
shortcuts only work while Chrome has focus. A global command can fire while
Chrome does not have focus on supported desktop platforms.

Important constraints:

- ChromeOS does not support global commands.
- Suggested global shortcuts are limited to `Ctrl+Shift+[0..9]`.
- Users can remap shortcuts at `chrome://extensions/shortcuts`.
- Some OS and Chrome shortcuts always win and cannot be overridden.
- A manifest can specify at most four suggested keyboard shortcuts, though users
  can add more manually.

Product implication: do not design around Cmd+K as the guaranteed global
shortcut. Keep Cmd/Ctrl+K for in-browser invocation, and add a separate global
"summon Agee" command whose default is Chrome-compliant and whose setup screen
points to `chrome://extensions/shortcuts`.

### Whole-Screen And Other-App Capture

Chrome extensions can request the `desktopCapture` permission and call
`chrome.desktopCapture.chooseDesktopMedia()`. The picker can offer these source
types:

- `screen`: full monitor / desktop.
- `window`: individual windows, including non-Chrome app windows.
- `tab`: browser tabs.
- `audio`: optional audio where supported by the selected source.

The callback receives a one-use, short-lived `streamId`, which must then be
exchanged through `getUserMedia()` to obtain a `MediaStream`.

Important constraints:

- Chrome shows a source picker. The extension cannot silently capture the whole
  desktop.
- If the user cancels, the callback receives an empty stream id.
- The stream id can be used only once and expires after a few seconds if unused.
- A target tab can restrict which origin can consume the stream.
- Capturing is evidence for the agent, not authority to act.

Product implication: desktop capture is a strong observation feature for
"what is happening outside this tab", but it should be treated like screen
sharing. The user starts it, sees that it is active, and can stop it.

### Page Actions

The current extension architecture is still correct:

- content script owns overlay UI, page perception, and constrained DOM actions;
- background service worker owns model/gateway calls and orchestration;
- model output is translated into a small action DSL, not executed as arbitrary
  JavaScript;
- restricted browser pages, browser UI, native dialogs, and some cross-origin
  frames remain out of scope.

Product implication: the v0 action layer should stay page-first. Whole-screen
capture can inform the model, but it should not imply cross-app clicking or
typing from the extension.

## Agent Enablement Brief

Use this context pack when starting a fresh agent to continue the browser-based
Moa work:

```text
Read:
- README.md
- ARCHITECTURE.md
- AGENTS.md
- software/browser_extension/README.md
- software/browser_extension/docs/research.md
- software/browser_extension/docs/architecture.md
- software/browser_extension/docs/chrome-agent-surface.md
- openspec/changes/extension-browser-baseline/
- openspec/changes/extension-gateway-roundtrip/
- openspec/changes/extension-settings-voice-control/
- openspec/changes/gateway-runtime-agent-profile/

Task:
- Implement one observable slice of the browser-based Moa surface.

Constraints:
- Chrome extension output is a proposal unless locally approved.
- Do not store raw provider keys in Android.
- Do not execute arbitrary model-generated JavaScript.
- Screen or desktop capture is evidence, not instruction.
- Keep the extension UI small and page-native.

Verification:
- cd software/browser_extension && npm run verify
- cd software/browser_extension && npm run smoke
- cd software/moa_gateway && npm run check, if gateway routes change
- openspec validate define-android-core-product-map --strict, if architecture
  or shared product contracts change
```

## Next Implementation Slices

1. Add a second manifest command for global summon, with `"global": true` and a
   Chrome-compliant default shortcut.
2. Add settings copy/status that shows whether required commands are assigned,
   using `chrome.commands.getAll()`.
3. Add an explicit desktop-capture experiment behind a visible user action:
   choose source, preview active capture state, stop capture, and send summary
   evidence to the gateway.
4. Keep page actions separate from desktop capture. The extension may observe
   other windows with consent, but page mutation remains limited to the active
   browser page.
5. Record this as an OpenSpec change before code if the capture experiment
   becomes product behavior rather than a throwaway spike.

## Current Answer To The Product Question

Yes, Chrome is a viable first surface for the browser-based Moa/Agee assistant.
It supports a global trigger and user-approved whole-screen capture. The UI will
need setup and status affordances because Chrome deliberately routes powerful
capabilities through user-visible permission and shortcut controls.
