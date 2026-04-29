# Changelog

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
