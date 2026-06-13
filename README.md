# Markdown Collab

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/markdown-collab.markdown-collab-plugin?label=VS%20Code%20Marketplace&color=4F46E5)](https://marketplace.visualstudio.com/items?itemName=markdown-collab.markdown-collab-plugin)
[![Open VSX](https://img.shields.io/open-vsx/v/markdown-collab/markdown-collab-plugin?label=Open%20VSX&color=4F46E5)](https://open-vsx.org/extension/markdown-collab/markdown-collab-plugin)

A VS Code extension that lets you leave review comments on Markdown files in a format Claude Code (and other agentic AIs) can read and act on.

Highlight a passage, drop a review comment in the sidebar, click **Send to Claude** — Claude reads the comment, edits the doc, and replies. Loop until you mark the thread resolved.

You can also flip the direction and ask Claude to act as the reviewer (v0.29+): right-click a `.md` file → **Markdown Collab: Ask Claude to Review This Doc**, optionally tell Claude what to focus on, and Claude opens one inline-comment thread per substantive concern for you to triage in the sidebar.

## Quick start

1. **Install the extension.**
   - **VS Code** — open Extensions (`Cmd-Shift-X`), search **Markdown Collab**, click Install. Or from the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=markdown-collab.markdown-collab-plugin), or the CLI:
     ```bash
     code --install-extension markdown-collab.markdown-collab-plugin
     ```
   - **Cursor / Windsurf / VSCodium / Gitpod** (Open VSX) — search **Markdown Collab** in Extensions, or install from the [Open VSX listing](https://open-vsx.org/extension/markdown-collab/markdown-collab-plugin).
   - **Manual / fallback** — grab the latest `.vsix` from the [GitHub Releases page](https://github.com/ronicayu/markdown-collab-plugin/releases) (`code --install-extension markdown-collab-plugin-*.vsix`), or build from source (see [Development](#development)).
2. **Install the Claude skill (one-time per machine).** In VS Code: `Cmd-Shift-P` → **Markdown Collab: Install Claude Skill**. This drops the skill instructions and bundled helpers into `~/.claude/skills/vs-markdown-collab/`.
3. **Open a Markdown file** in a folder/workspace. Right-click the file → **Markdown Collab: Open Inline Comments View**, or use the command palette.
4. **Highlight a passage in the rendered view** → click the **Comment** popup → write your review note → submit.
5. **Click Send to Claude** in the comments sidebar. The first time, you'll be asked which delivery mode to use; the answer is remembered. **For most users, pick `terminal`** (see [Choosing a send mode](#choosing-a-send-mode)).

> Comments are stored **inline** in the `.md` file itself — anchored spans are wrapped in `<!--mc:a:ID-->…<!--mc:/a:ID-->` markers and threads live in a single `<!--mc:threads:begin-->`…`<!--mc:threads:end-->` block at the end of the file. Everything ships with the document; no sidecar to commit.

That's it — Claude reads the comments, edits the doc, posts a reply per thread. You toggle resolved when you're satisfied.

## How to use, day to day

### Adding a comment

Open the **Inline Comments view** (`Markdown Collab: Open Inline Comments View`, or right-click a `.md` file), highlight rendered text, click the floating **Comment** button, type your note, submit. The thread is written into the `.md` file itself as inline marker comments — everything travels with the document.

Any selection works — even a single word. Only empty or whitespace-only selections are ignored.

### Sending the batch to Claude

Once you've left one or more unresolved comments, click **Send N to Claude** at the top of the comments sidebar (the count updates live). The button is disabled when nothing is unresolved.

### Reviewing replies

Claude addresses each comment, edits the doc in place, and appends a reply with what it changed. The reply lands as a thread reply in VS Code. Toggle the thread to **Resolved** when satisfied; reply with more questions if not.

### Asking Claude to review (Claude-initiated threads)

The flow above is human-to-Claude: you leave comments, Claude addresses them. v0.29 added the reverse direction — **Markdown Collab: Ask Claude to Review This Doc** (right-click a `.md` file or run from the command palette).

The extension prompts for an optional **focus directive** — a free-form sentence telling Claude what to look for, e.g. *"check API examples for correctness"* or *"find marketing-y tone."* Leave it blank for a general review. The last five focus directives you've used are offered in a quick-pick so you don't retype the common ones.

Claude reads the doc and opens one inline-comment thread per substantive concern it finds. There's **no cap on thread count** — if 30 things warrant a thread, Claude leaves 30. The sidebar grows two affordances when Claude-initiated threads exist:

- A summary row: *"N new from Claude · M reviewed,"* with a **Next** button that jumps to the next unread Claude thread.
- A **Collapse all** / **Expand all** toggle that folds every unread Claude card so a big review pass stays browseable.

A thread counts as "reviewed" once you reply or resolve it; the indicator clears automatically. The detection uses the existing inline-thread JSON — no schema change, no migration needed.

Files larger than 50 KB prompt a soft confirm before sending (Claude's review can use significant context on big docs). In review mode the skill never edits prose — every concern goes in a thread for you to gate. Expect *"Reviewed `<path>` — no concerns found"* via the send channel if Claude reads the doc and finds nothing matching the focus.

### Comments that survive doc edits

Comments are anchored to a text selection, not a line number. When Claude rewrites a passage that has a comment, the skill instructs it to update the anchor text to match — so comments survive revisions.

If a rewrite removes the anchored passage entirely, the thread's markers go with it and the thread surfaces as **unanchored** in the Inline Comments view — re-anchor it by selecting fresh text and leaving the note again.

## Choosing a send mode

The **Send to Claude** button delivers the comment payload one of four ways. Pick one once via `markdownCollab.sendMode` and you won't be asked again.

> **TL;DR:** if MCP isn't available in your environment AND your Claude Code harness doesn't expose a streaming-stdout tool (`Monitor` or `BashOutput`), **use `terminal`**. It works everywhere with zero setup.

| Your situation | Recommended mode | Why |
|---|---|---|
| Just trying it out, or unsure | `terminal` | Zero setup. Bracketed-pastes the prompt into a `claude` REPL in your VS Code terminal. |
| MCP disabled by your company / org | **`terminal`** | Channel-based modes need MCP; terminal mode doesn't. |
| Harness lacks `Monitor` / `BashOutput` | **`terminal`** | Channel mode's reactivity depends on streaming notifications; without them you'd be polling, which terminal sidesteps entirely. |
| Harness has `Monitor` / `BashOutput`, MCP allowed | `channel` | File-watcher pattern; supports long-lived watch loops without per-click setup. |
| Claude Code v2.1.80+, `claude.ai` login, channels enabled by your org | `mcp-channel` | Native `<channel>` events on Claude's next turn — cleanest semantics when supported. |
| Want to copy/paste manually each time | `clipboard` | Simplest fallback; nothing automatic. |

Don't know which to pick? Leave `markdownCollab.sendMode` on `ask` (the default). The first click shows a quick-pick and remembers your choice. **Markdown Collab: Reset Send Mode** clears it if you want to switch later.

## Send mode details

### `terminal` — recommended default

Bracketed-pastes the prompt into a `claude` REPL running in any VS Code terminal.

- **Detection ladder:** terminals the extension spawned → shell-integration evidence of `claude` → name match `/claude/i` → active terminal (with confirmation toast).
- **No detected terminal?** A quick-pick offers to spawn one (`claude` auto-launches inside it) or fall back to clipboard.
- **No MCP, no streaming tool, no protocol gates** — just a `paste` keystroke into your REPL.

**Setup:** none. Just have `claude` running in any integrated terminal when you click.

### `channel` — events log + tailer

Each click appends one JSON line to `<workspace>/.markdown-collab/.events.jsonl`. Claude runs the bundled `mdc-tail.mjs` in a background bash and subscribes via `Monitor` (or your harness's equivalent stream-stdout tool); each click surfaces as a model notification.

- **Auto-ack:** when every comment in an event has been addressed (last reply is `ai`, or comment is resolved/deleted), the extension appends the event id to `.events.acked.jsonl`. The tailer suppresses acked events on `--from-start` replays.
- **Per-line flush:** the tailer uses `fs.writeSync(1, …)` to bypass Node's stdout buffering on POSIX pipes — every appended JSON line surfaces immediately, never batched.

**Setup:** run **Markdown Collab: Install Claude Skill** once. Then ask Claude to start the watch loop:

> Run `node ~/.claude/skills/vs-markdown-collab/mdc-tail.mjs --workspace <abs-path>` in background, then subscribe with the Monitor tool on the returned process id.

**Won't work if** your harness only has `TaskOutput` (no streaming primitive). In that case use `terminal`.

### `mcp-channel` — native channel events

Pushes the payload to the bundled MCP server (`mdc-channel.mjs`), which emits `notifications/claude/channel`. Claude receives it as a native `<channel source="markdown-collab" file="…" id="evt_…">` tag on its next turn.

**Requires:**
- Claude Code v2.1.80+
- `claude.ai` login (not API key / Console / Bedrock)
- Channels enabled by your organization (`channelsEnabled`)
- The one-time `.mcp.json` setup below

**Setup:**
1. Run **Markdown Collab: Install Claude Skill**.
2. Register the server in `~/.claude.json` (user-level) or `<workspace>/.mcp.json`:
   ```json
   {
     "mcpServers": {
       "markdown-collab": {
         "command": "node",
         "args": ["~/.claude/skills/vs-markdown-collab/mdc-channel.mjs"]
       }
     }
   }
   ```
3. Start Claude with the research-preview flag:
   ```bash
   claude --dangerously-load-development-channels server:markdown-collab
   ```
4. Set `markdownCollab.sendMode` to `mcp-channel`.

If you see `--channels ignored (server:markdown-collab) — Channels are not currently available`, your environment fails one of the gates above. **Switch to `terminal`** — it doesn't depend on any of them.

### `clipboard` — manual paste

Copies the prompt to the clipboard. Paste into Claude however you like.

## Commands

| Command | Purpose |
|---|---|
| `Markdown Collab: Install Claude Skill` | Write `~/.claude/skills/vs-markdown-collab/SKILL.md` and the bundled helpers (`mdc-tail.mjs`, `mdc-channel.mjs`). |
| `Markdown Collab: Initialize AGENTS.md` | Append a convention block to `<workspace>/AGENTS.md` (for non–Claude-Code agents). |
| `Markdown Collab: Open Inline Comments View` | Open the rendered view with an inline-threads sidebar. Comments are stored inside the `.md` file. The right-click action on `.md` files. |
| `Markdown Collab: Ask Claude to Review This Doc` | Ask Claude to act as the reviewer (v0.29+). Prompts for an optional focus directive, then sends a Review Mode payload through the configured send mode. Claude opens one thread per concern; you triage in the sidebar. |
| `Markdown Collab: Send Unresolved Comments to Claude` | Same as the **Send to Claude** button — usable from palette. |
| `Markdown Collab: Start Claude Review Terminal` | Spawn a fresh integrated terminal and launch `claude`. |
| `Markdown Collab: Copy Claude Prompt` | Copy a short "address the comments on this file" prompt to clipboard. |
| `Markdown Collab: Reset Send Mode` | Clear the remembered `ask` choice for the current workspace. |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `markdownCollab.sendMode` | `ask` | One of `ask`, `terminal`, `channel`, `mcp-channel`, `clipboard`. See [Choosing a send mode](#choosing-a-send-mode). |

## Storage layout

**Inline view (default).** Threads live inside the `.md` file itself. Anchored spans are wrapped in paired HTML comments and threads are serialized as `<!--mc:t {JSON}-->` lines inside a fenced region at the end of the file:

```markdown
The <!--mc:a:k7q3p-->quick brown fox<!--mc:/a:k7q3p--> jumps…

<!--mc:threads:begin-->
<!--mc:t {"id":"k7q3p","quote":"quick brown fox","status":"open","comments":[{"id":"c1","author":"ronica","ts":"2026-05-13T12:00:00Z","body":"too cliched"}]}-->
<!--mc:threads:end-->
```

The markers are invisible in any rendered preview (they're HTML comments). Commit the `.md` file as-is — review state ships with the document.

The only files Markdown Collab writes under `.markdown-collab/` are runtime state for the channel send modes. Add them to `.gitignore`:

```
<workspace>/
└── .markdown-collab/
    ├── .events.jsonl         ← channel-mode event log (gitignore)
    ├── .events.acked.jsonl   ← addressed-event ids (gitignore)
    └── .channel.json         ← mcp-channel endpoint descriptor (gitignore)
```

```gitignore
.markdown-collab/
```

## Troubleshooting

**Click did nothing, no toast.** Your `markdownCollab.sendMode` is set to a stale value (e.g., `ipc` from before 0.11). v0.12.1+ falls back to `ask` and warns; if you're on something older, change the setting to `terminal`.

**Channel mode: tailer started, but lines don't arrive at Claude.**
- Make sure you're on v0.13.1+ (uses `fs.writeSync` to flush per line).
- Make sure Claude actually subscribed via `Monitor` / `BashOutput`. `TaskOutput block=true` waits for completion and will hang forever — wrong tool.
- If your harness has only `TaskOutput`, switch to `terminal` mode. Channel mode requires a streaming primitive.

**`mcp-channel`: "Channels are not currently available."** One of: Claude Code <v2.1.80, logged in with API key / Bedrock / Vertex (not `claude.ai`), or your org has `channelsEnabled: false`. Diagnose with `claude /status` and `claude --version`. Otherwise, use `terminal`.

**A thread shows up as unanchored.** The anchored passage was deleted or rewritten beyond recognition, so its markers are gone. Re-anchor it by selecting fresh text in the Inline Comments view and leaving the note again.

## Development

```bash
npm install
npm run compile
npm test
```

Unit tests run under Vitest. The VS Code API surface is stubbed in `src/test/vscode-stub.ts` for tests of pure helpers.

Press **F5** in VS Code to launch an Extension Development Host for manual verification.

To produce a `.vsix` for distribution:
```bash
npx @vscode/vsce package
```

Releases: bump the version in `package.json`, prepend a `## X.Y.Z — <date>` block to `CHANGELOG.md`, commit, then tag `vX.Y.Z` and push the tag. The release workflow gates on the CHANGELOG entry's existence and pulls the section into the GitHub Release notes automatically.

## Out of scope (v1)

- Multi-user collaboration with author attribution.
