# Changelog

## 0.12.2 — 2026-04-29

### SKILL.md: tighten Monitor-vs-TaskOutput guidance

Claude sessions were hanging on `TaskOutput block=true` against the long-running `mdc-tail.mjs` background bash, because `TaskOutput` waits for *completion* — and the tailer never completes by design. The watch-loop section of the bundled SKILL.md now explicitly says "use **Monitor** (not TaskOutput)" and explains why, with a fallback hint for harnesses that expose the same capability under a different name (e.g. `BashOutput`).

## 0.12.1 — 2026-04-29

### Fixed: silent no-op when sendMode was an unknown value (e.g. "ipc")

Users upgrading from 0.10.x had `markdownCollab.sendMode: "ipc"` in their workspace settings.json. After the rename to "channel" in 0.11.0, that value is no longer in the schema enum but VS Code still serves it via `config.get`. The dispatcher's three `if (mode === ...)` branches all missed, so the **Send to Claude** button silently did nothing — the events log never grew.

Now the dispatcher normalizes any unrecognized value back to "ask" (so the user gets the quick-pick instead of a no-op), surfaces a one-line warning naming the offending value, and writes a longer note to the output channel telling them about the 0.11.0 rename.

## 0.12.0 — 2026-04-29

### Channel events auto-ack once Claude has addressed them

Each event written to `.markdown-collab/.events.jsonl` now carries a unique `evt_…` id. After every sidecar mutation the extension reconciles the event log: when every comment referenced by an unacked event is either resolved, deleted, or has an `ai`-authored last reply, the event id is appended to a sibling `.markdown-collab/.events.acked.jsonl`.

`mdc-tail.mjs` reads the ack file on startup, watches it for new ids, and silently suppresses any event whose id is acked. So:

- Restarting the watch (or running with `--from-start`) no longer re-bothers Claude with batches it has already addressed.
- The events file stays append-only — both files are race-free; no in-place rewrites, no torn reads.

### Removed

- The "torn appends" gap where a tailer restarted after a long session would re-emit every historical batch.

## 0.11.4 — 2026-04-29

### Marketplace publish prerequisites

- Added MIT `LICENSE` at repo root.
- Added `repository`, `homepage`, `bugs`, `license`, and `keywords` fields to `package.json`.

These were the two `vsce` warnings blocking marketplace publish; with these in place, set `VSCE_PAT` (and optionally `OVSX_PAT`) as repo secrets, push a `v*` tag, and the existing release workflow handles the publish step.

## 0.11.3 — 2026-04-29

### Remember the Send to Claude mode after first pick

When `markdownCollab.sendMode` is `ask` (default), the first quick-pick choice is now persisted to workspace state, so subsequent clicks send straight through without prompting again. The first-success toast names the new **Markdown Collab: Reset Send Mode** command for clearing the remembered choice. The settings UI now also exposes per-option `enumDescriptions` so each transport's behavior is visible at a glance.

## 0.11.2 — 2026-04-29

### Adaptive preview layout

The preview's comments panel now becomes a slide-in drawer at narrow widths (≤900px) instead of stacking below the document. A **Comments (N)** button appears in the toolbar at narrow widths; clicking opens the drawer over the document. Click the backdrop, the X, or press Escape to close. At wide widths the panel stays pinned as before.

This fixes a regression where users with the preview docked side-by-side with the editor couldn't see the comments at all without scrolling far below the document body.

## 0.11.1 — 2026-04-29

### Fixed: channel transport delivered nothing to Claude's Monitor

`tail -f` block-buffers its stdout when run as a background bash whose stdout is a pipe (which is how Claude Code captures it), so appended lines didn't surface to `Monitor` until ~4 KB accumulated. Reported by users who saw the JSONL file growing but Claude receiving no notifications.

The skill installer now also writes `~/.claude/skills/vs-markdown-collab/mdc-tail.mjs` — a small Node tailer that:

- Watches `.markdown-collab/.events.jsonl` via `fs.watch` plus a 500ms safety poll.
- Flushes each appended line via `process.stdout.write` (per-call flush when stdout is a pipe).
- Skips existing history by default (matches `tail -n 0`); `--from-start` replays.
- Survives truncate/rotate by re-seeking to 0.

The "Channel watch loop" section of SKILL.md now instructs Claude to invoke this tailer instead of `tail -f`.

## 0.11.0 — 2026-04-29

### Send to Claude — channel transport (replaces IPC long-poll)

A new **Send to Claude** button in the preview sidebar bundles every unresolved comment on the active file and delivers them to Claude Code via one of three MCP-free transports:

- **`terminal`** — bracketed-paste injection into a running `claude` REPL with a layered detection ladder (extension-owned terminals → shell-integration evidence → name match → active terminal w/ confirmation toast) and a "spawn a new Claude terminal" fallback.
- **`channel`** — append-only `<workspace>/.markdown-collab/.events.jsonl`. Claude Code reads it via a background `tail -f` paired with the `Monitor` tool, so each click surfaces as a model notification — no polling, no HTTP server, no token, no Bash-tool 600s ceiling.
- **`clipboard`** — copies the prompt for manual paste.

The mode is selected by `markdownCollab.sendMode` (default `ask`).

### Why this replaces 0.10.0's IPC server

0.10.0 shipped a localhost long-poll HTTP server paired with an `mdc-wait.mjs` CLI. It worked but Claude Code's Bash tool caps at 600s, forcing a re-invocation loop on every timeout. The channel transport sidesteps the ceiling entirely by leaning on Claude Code's native background-bash + `Monitor` notification stream.

### Removed

- `IpcServer` (`src/transports/ipcServer.ts`) and its tests.
- `mdc-wait.mjs` from the skill installer.
- `markdownCollab.sendMode: "ipc"` enum value.

### Added

- `EventLog` (`src/transports/eventLog.ts`) — atomic line appends via `fs.appendFile`.
- "Channel watch loop" section in the bundled SKILL.md teaching Claude the `tail -f` + `Monitor` pattern.
- 5 new event-log tests covering create-on-first-append, line-per-event, ISO `ts` stamping, append-not-truncate, and concurrent-append non-tearing.

## 0.10.0 — 2026-04-28

### Added (later replaced in 0.11.0)

- Initial **Send to Claude** button in the preview sidebar.
- Three transports: `terminal` (bracketed-paste injection), `ipc` (localhost long-poll HTTP server with token-authed `mdc-wait.mjs` CLI), `clipboard`.
- `markdownCollab.sendMode` setting (`ask` | `terminal` | `ipc` | `clipboard`).
- `Markdown Collab: Send Unresolved Comments to Claude` and `Markdown Collab: Start Claude Review Terminal` commands.
- `TerminalTracker` for shell-integration-aware detection of running `claude` REPLs.

> **Note:** the `ipc` transport from this release was removed in 0.11.0 in favour of the channel transport. Users on 0.10.0 should upgrade.
