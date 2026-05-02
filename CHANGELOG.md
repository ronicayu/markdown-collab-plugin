# Changelog

## 0.16.0 — 2026-05-02 (trial)

### Known gap: review comments in the collab editor

The CommentController API used by the existing review feature attaches its UI (gutter icons, inline thread cards) to a Monaco text editor. The collab editor is a webview with Milkdown inside — there is no Monaco surface to attach to, so **review comments do not show up while a file is open in the collab editor**. Nothing on disk is harmed: the `.md.json` sidecar is untouched, anchors remain valid, and reopening the file with the standard Markdown editor brings the comment threads back. For now: edit collaboratively in the WYSIWYG editor, review/comment in the standard editor.

Verified by integration test (`comments.test.ts`) that opening a file with an existing sidecar in the collab editor does not mutate the on-disk markdown and does not invalidate the comment anchors.

### Changed: collab editor is now WYSIWYG (Milkdown), not raw markdown

The collaborative editor previously rendered the markdown source as a CodeMirror code editor — fine for engineers, but jarring for non-technical reviewers who expected to see *the rendered document* (headings actually look like headings, **bold** is bold, lists are lists). The editor is now Milkdown (ProseMirror under the hood) with the nord theme and the commonmark preset. Users type into a rendered document; markdown shortcuts auto-style as they type (e.g. typing `# ` becomes a heading). The on-disk file format is still plain commonmark — Milkdown's serializer round-trips the document on every save.

Real-time collaboration runs through `@milkdown/plugin-collab` (which wraps `y-prosemirror`). Awareness, remote cursors, and convergence still go through the same `y-websocket` relay we shipped in 0.15.

Trade-off: Milkdown's CRDT shape is `Y.XmlFragment("prosemirror")` — different from the old `Y.Text("doc")`. The server's pre-existing `?init=` text-seeding code path is now a no-op for the new editor; the first peer's Milkdown `applyTemplate` populates the room. There is a small race window if two peers connect within the same network round-trip (both could observe an empty doc and both apply the template), which would duplicate the seed. We accept this for the trial — opening the same file simultaneously on two machines is rare in practice; we'll add server-side ProseMirror seeding if it shows up.

### Added: webview error reporting

Failures inside the webview (Milkdown init errors, ProseMirror schema mismatches, missing CSS, etc.) now post a `webview-error` message back to the extension and surface in the **Markdown Collab** output channel. This made the bring-up of the new editor much faster to debug and is useful in production for triaging real-world issues.

## 0.15.1 — 2026-05-02 (trial)

### Fixed: collab editor sometimes rendered an empty document

The webview created the CodeMirror EditorView synchronously after instantiating the WebsocketProvider, but the provider hadn't completed sync at that point — `ytext.toString()` returned `""` and `y-codemirror.next` did not always backfill the seed once the relay's update arrived. The editor now waits for either the `provider.sync` event or a 1.5s grace period (whichever comes first) and only then constructs the EditorView with the actual seeded content. If the relay is unreachable, the webview falls back to seeding `Y.Text` locally so the user always sees the file's contents.

### Fixed: EADDRINUSE on the relay port crashed the extension host

`new WebSocketServer({ server })` re-emits the underlying HTTP server's `error` event on the `wss` instance. We listened on the HTTP server (good — that path correctly rejected our `startCollabServer` promise) but not on `wss`, so the same `EADDRINUSE` bubbled up as an `uncaughtException` and tore down the extension host on the next reload. A no-op `wss.on('error', …)` swallow paired with the existing HTTP-server error handler restores the original "log and reuse the existing relay" behaviour.

### Added: configurable relay port

New setting `markdownCollab.collab.port` (default `1234`). Useful when port 1234 is already taken by an unrelated tool, or when running the integration tests alongside a developer's normal VSCode session.

### Added: @vscode/test-electron integration test harness

`npm run test:integration` boots a real downloaded VSCode (Electron) into the Extension Test Host, loads the extension against a fixture workspace, and runs five end-to-end tests covering: command/customEditor registration, relay-port HTTP signature probe, relay-side seed pipeline (using a test-only server introspection hook so we don't race the webview), webview-side post-sync content length (the regression guard for this version's empty-doc bug), and a relay-side multi-peer broadcast.

## 0.15.0 — 2026-05-02 (trial)

### Added: experimental real-time collaborative editor (CodeMirror 6 + Yjs)

Opt-in `CustomTextEditor` for `.md` files (priority `option`, so the default Markdown editor and the existing comment / preview UI are unchanged). Open via **Reopen Editor With… → Markdown Collab (real-time, experimental)** or the new `markdownCollab.openCollabEditor` command.

- CodeMirror 6 + `y-codemirror.next` running inside a webview, bundled with esbuild (~592 KB minified).
- A minimal `y-websocket`-compatible relay (HTTP + WebSocket + `y-protocols`) is embedded in the extension and started on activation at `ws://127.0.0.1:1234`. Multi-window collisions are detected: if port 1234 is already serving our relay (HTTP probe matches our signature), the new window reuses it.
- Server-side seeding via `?init=<base64>` query param. The single-process relay accepts the first connection's seed text and ignores every later one — no first-peer race.
- Awareness propagates remote cursors and user-name/color between peers.
- New settings: `markdownCollab.collab.serverUrl`, `markdownCollab.collab.startLocalServer`, `markdownCollab.collab.userName`.

Known gaps in this trial: relay state lives in memory only (on-disk file is the persistent source of truth); review comments are not yet synced through Yjs (they still flow through the existing `.md.json` sidecar); opening the same file in *both* the Monaco editor and the collab editor at once will fight over edits — pick one.

13 new tests cover the relay sync, room isolation, seeding (incl. UTF-8), awareness, HTTP probe contract, and base64 round-trips.

## 0.14.3 — 2026-05-02

### Fixed: preview comments on selections that cross headings or blockquotes

`locateSelectionInSource`'s tolerant-separator fallback let the regex bridge runs of whitespace plus a small set of markdown punctuation (`|`, `*`, `_`, `~`, `` ` ``, `-`) between the words of a selection, so that a DOM `Selection.toString()` — which strips markdown syntax — could still match the source. The class missed `#` and `>`, so selections that crossed an ATX heading marker (`# Header 1\n\n## Header 2`) or a multi-line blockquote (`> quoted\n> more`) failed to resolve and the comment couldn't be created.

Separator class extended to `[\s|*_~`\-#>]+`. Both characters only carry block-syntax meaning at line start, so the broader class only bridges whitespace + leading-line markers between selected tokens — never inside a token. Three regression tests added: heading + paragraph, two consecutive headings + paragraph, multi-line blockquote into paragraph.

## 0.14.2 — 2026-04-29

### Fixed: preview panel sometimes auto-closed mid-typing

The preview panel listened to `onDidCloseTextDocument` on the source `.md` and disposed itself when fired. That event also fires for transient close/reopen cycles (preview-mode tab cycling, encoding switches, memory unloading) — not just user-initiated tab closes. The panel could vanish while the user was typing into the compose textarea inside the webview, since VS Code is free to recycle the underlying doc independently of the webview's focus.

Auto-dispose on doc-close removed. The panel now persists until the user closes it explicitly via the tab's `✕`. `render()` already falls back to reading from disk when the buffer is unloaded, so the preview keeps working in that state. The file watcher's `onDidDelete` still disposes the panel when the underlying file actually disappears from disk (rename or delete).

## 0.14.1 — 2026-04-29

### Preview content now fills the available width

The preview's main content area was capped at `max-width: 960px`, leaving large empty gutters on wide monitors (especially with the comments sidebar pinned at 360px on the right). The cap is removed; the main column now grows to fill whatever the viewport offers minus the sidebar. Mermaid diagrams, tables, and wide code blocks no longer scroll horizontally on screens that have plenty of room.

## 0.14.0 — 2026-04-29

### Comments and replies render as Markdown in the preview sidebar

Both the collapsed card snippets and the expanded message bodies now render Markdown via the same `markdown-it` instance the document body uses. Bold, italics, inline `code`, fenced blocks, links, lists, blockquotes, and tables all render in place.

- Server-side rendering: `bodyHtml` is computed in the host (TypeScript) and injected into the webview JSON. `markdown-it` runs with `html: false`, so any raw HTML in a comment body is escaped — same XSS posture as before.
- The collapsed two-line preview keeps the inline-paragraph treatment (no awkward block-level margin) and still clamps at two lines.
- The textarea editor for **Edit** keeps the raw markdown source — what the human typed is what they see.
- Falls back to escaped plain text if a comment was authored before this version (`c.bodyHtml || esc(c.body)`).

Bumps to 0.14.0.

## 0.13.3 — 2026-04-29

### Removed: terminal-mode "Send N to terminal …?" confirmation toast

The terminal transport's detection ladder used to show a *Send / Cancel* toast for medium- and low-reliability matches (name-based or active-terminal). That toast fires on every click against an already-spawned `Claude Review` terminal once VS Code restarts and the in-memory owned-set is empty, which is exactly the steady-state path. The friction outweighed the safety it bought; the click is the user's explicit intent already. Toast removed; injection is unconditional now.

## 0.13.2 — 2026-04-29

### README rewrite for users

The README is reorganized into a top-down "what is this → quick start → daily use → mode picker → troubleshooting" flow rather than a feature dump. Adds:

- **Quick start**: 5 numbered steps from `code --install-extension` to first review reply.
- **Choosing a send mode**: a decision matrix that explicitly recommends `terminal` when MCP and channel features aren't available in the user's environment, and explains *why* for each row.
- **Send mode details**: per-mode setup blocks with copy-pasteable commands.
- **Settings reference**: documents `markdownCollab.sendMode` and its values.
- **Troubleshooting**: covers the four most common stuck states from this iteration cycle (silent click on stale `ipc` value, channel-mode lines not arriving, `--channels ignored`, orphaned comments, gutter icon multiplication).
- **Storage layout**: now lists the runtime dotfiles (`.events.jsonl`, `.events.acked.jsonl`, `.channel.json`) with the recommended `.gitignore` snippet.

No code change.

## 0.13.1 — 2026-04-29

### Fixed: tailer + channel server may buffer their stdout

Both `mdc-tail.mjs` and `mdc-channel.mjs` were using `process.stdout.write`. Per [Node docs](https://nodejs.org/api/process.html#a-note-on-process-io), that call is **asynchronous on POSIX when stdout is a pipe** — and Claude Code captures both scripts' stdout via a pipe. Lines could sit in the libuv write queue until the event loop ticked, especially when the script was busy doing other work (reading, watching, JSON-parsing).

Both scripts now write through `fs.writeSync(1, …)`: a synchronous, immediate write to file descriptor 1. Each emitted line / JSON-RPC message arrives at Claude Code's reader the instant the underlying `appendFile` (or `notification`) fires, with no buffering window. This is the same fix the previous `tail -f` → `mdc-tail.mjs` switch was meant to guarantee — but only `tail`'s buffering was actually being addressed; Node's own pipe-write buffering was still in play.

## 0.13.0 — 2026-04-29

### New transport: `mcp-channel` — native Claude Code channel events

Adds a fifth `markdownCollab.sendMode`: **`mcp-channel`**. The skill installer now also drops `mdc-channel.mjs` next to `mdc.mjs` and `mdc-tail.mjs`. That script is a hand-rolled MCP server (no SDK dep) that:

- Speaks the minimum JSON-RPC handshake to declare `experimental.capabilities['claude/channel']`.
- Listens on a localhost HTTP port and writes the port + per-session bearer token to `<workspace>/.markdown-collab/.channel.json`.
- On `POST /push`, fires `notifications/claude/channel`, so the payload arrives in Claude's next turn as a native `<channel source="markdown-collab" file="…" count="N" id="evt_…">` tag — no streaming tool, no Bash 600s ceiling, no polling.

When the user clicks **Send to Claude** in `mcp-channel` mode, the extension looks up `.channel.json`, POSTs the same envelope it would have written to the events log (and still does — `mcp-channel` mode appends to both the events log and the channel, so ack-based suppression still works), and shows a success toast.

**One-time setup** for users who want this mode (added to the README):

1. Run **Markdown Collab: Install Claude Skill**.
2. Add to `~/.claude.json` or the workspace's `.mcp.json`:
   ```json
   { "mcpServers": { "markdown-collab": { "command": "node", "args": ["~/.claude/skills/vs-markdown-collab/mdc-channel.mjs"] } } }
   ```
3. Start Claude with `claude --dangerously-load-development-channels server:markdown-collab`.

### Caveats

- Channels are research preview as of Claude Code v2.1.80 — protocol may change.
- Requires claude.ai login (not API-key / Console).
- Doesn't help when MCP is fully disabled by enterprise policy — channels are MCP under the hood. Use `terminal` mode in that case.

### Tests

5 new tests cover the extension-side transport (not-running, 401, 500, ECONNREFUSED, success-with-bearer-auth-and-correct-body). The MCP server itself was end-to-end smoke-verified during development: spawn → handshake → POST → `notifications/claude/channel` line on stdout with correct meta.

## 0.12.3 — 2026-04-29

### SKILL.md: harness-capability fallbacks for the channel watch loop

Some Claude Code harnesses don't expose a per-line stdout-streaming tool (`Monitor` / `BashOutput`) — they only have `TaskOutput`, which waits for completion and is therefore the wrong fit for the long-running `mdc-tail.mjs`. The skill's "Channel watch loop" section now spells out three fallbacks for that case: switch the VS Code setting to `terminal` mode, poll with `TaskOutput block=false`, or `Read` the events file directly each turn. The terminal transport remains the recommended path for harnesses without streaming.

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
