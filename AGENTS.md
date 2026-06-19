# Agent Operating Contract

This is a submodule of `moa-assistant`. For trust boundaries, architecture, and
workflow, also read the parent contract:
`../../AGENTS.md`, `../../ARCHITECTURE.md`, `../../AGENT_WORKFLOW.md`.

## Done ledger (scratch/done/LEDGER.md)

When you finish a task, prepend ONE line to `scratch/done/LEDGER.md`:

`- <what you did, in plain words> — <agent: tool/model> — <commit sha / entire checkpoint>`

No timestamps, no transcript. Entire already keeps the full session and diffs;
this is the at-a-glance, up-level log of *what changed and who did it* — open the
file and see exactly what's been going on.
