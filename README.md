# Markdown Collab

A VS Code extension that lets you leave review comments on Markdown files in a format Claude Code (and other agentic AIs) can read and act on.

Highlight a passage, drop a review comment in the sidebar, click **Send to Claude** — Claude reads the comment, edits the doc, and replies. Loop until you mark the thread resolved.

## Quick start

1. **Install the extension.** Either build it from source (see [Development](#development)) or grab the latest `.vsix` from the [GitHub Releases page](https://github.com/ronicayu/markdown-collab-plugin/releases) and install it:
   ```bash
   code --install-extension markdown-collab-plugin-*.vsix
   ```
2. **Install the Claude skill (one-time per machine).** In VS Code: `Cmd-Shift-P` → **Markdown Collab: Install Claude Skill**. This drops the skill instructions and bundled helpers into `~/.claude/skills/vs-markdown-collab/`.
3. **Open a Markdown file** in a folder/workspace. Right-click the file → **Markdown Collab: Open Preview with Comments**, or use the command palette.
4. **Highlight a passage in the preview** → click the **Comment** popup → write your review note → submit.
5. **Click Send to Claude** in the comments sidebar. The first time, you'll be asked which delivery mode to use; the answer is remembered. **For most users, pick `terminal`** (see [Choosing a send mode](#choosing-a-send-mode)).

That's it — Claude reads the comments, edits the doc, posts a reply per thread. You toggle resolved when you're satisfied.

## How to use, day to day

### Adding a comment

Two ways:

- **Preview sidebar.** Open the preview (`Markdown Collab: Open Preview with Comments`), highlight rendered text, click the floating **Comment** button, type your note, submit.
- **Native VS Code Comments UI.** Highlight text in the editor, click the `+` in the gutter, type the comment.

Selections must contain at least **8 non-whitespace characters**. Shorter selections are rejected.

### Sending the batch to Claude

Once you've left one or more unresolved comments, click **Send N to Claude** at the top of the comments sidebar (the count updates live). The button is disabled when nothing is unresolved.

### Reviewing replies

Claude addresses each comment, edits the doc in place, and appends a reply with what it changed. The reply lands as a thread reply in VS Code. Toggle the thread to **Resolved** when satisfied; reply with more questions if not.

### Comments that survive doc edits

Comments are anchored to a text selection, not a line number. When Claude rewrites a passage that has a comment, the skill instructs it to update the anchor text to match — so comments survive revisions.

If a rewrite is drastic enough that the anchor can't be located, the comment moves to the **Orphaned Markdown Comments** TreeView (only visible when orphans exist) where you can click to re-attach it to a new selection.

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
| `Markdown Collab: Install Claude Skill` | Write `~/.claude/skills/vs-markdown-collab/SKILL.md` and bundled helpers (`mdc.mjs`, `mdc-tail.mjs`, `mdc-channel.mjs`). |
| `Markdown Collab: Initialize AGENTS.md` | Append a convention block to `<workspace>/AGENTS.md` (for non–Claude-Code agents). |
| `Markdown Collab: Open Preview with Comments` | Open the side-by-side rendered preview with the comments sidebar. |
| `Markdown Collab: Send Unresolved Comments to Claude` | Same as the **Send to Claude** button — usable from palette. |
| `Markdown Collab: Start Claude Review Terminal` | Spawn a fresh integrated terminal and launch `claude`. |
| `Markdown Collab: Copy Claude Prompt` | Copy a short "address the comments on this file" prompt to clipboard. |
| `Markdown Collab: Reset Send Mode` | Clear the remembered `ask` choice for the current workspace. |
| `Markdown Collab: Reload Comments` | Re-read the active file's sidecar from disk. |
| `Markdown Collab: Validate Sidecars` | Scan the workspace for schema violations and would-be-orphans. |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `markdownCollab.sendMode` | `ask` | One of `ask`, `terminal`, `channel`, `mcp-channel`, `clipboard`. See [Choosing a send mode](#choosing-a-send-mode). |

## Storage layout

```
<workspace>/
├── docs/guide.md
├── README.md
├── AGENTS.md                     ← optional (run "Initialize AGENTS.md")
└── .markdown-collab/
    ├── docs/guide.md.json        ← review comments for docs/guide.md
    ├── README.md.json
    ├── .events.jsonl             ← channel-mode event log (gitignore)
    ├── .events.acked.jsonl       ← addressed-event ids (gitignore)
    └── .channel.json             ← mcp-channel endpoint descriptor (gitignore)
```

Commit `.markdown-collab/*.md.json` to version control — that's your review state. The dotfiles (`.events*.jsonl`, `.channel.json`) are runtime state; add them to `.gitignore`:

```gitignore
.markdown-collab/.events*.jsonl
.markdown-collab/.channel.json
```

## Troubleshooting

**Click did nothing, no toast.** Your `markdownCollab.sendMode` is set to a stale value (e.g., `ipc` from before 0.11). v0.12.1+ falls back to `ask` and warns; if you're on something older, change the setting to `terminal`.

**Channel mode: tailer started, but lines don't arrive at Claude.**
- Make sure you're on v0.13.1+ (uses `fs.writeSync` to flush per line).
- Make sure Claude actually subscribed via `Monitor` / `BashOutput`. `TaskOutput block=true` waits for completion and will hang forever — wrong tool.
- If your harness has only `TaskOutput`, switch to `terminal` mode. Channel mode requires a streaming primitive.

**`mcp-channel`: "Channels are not currently available."** One of: Claude Code <v2.1.80, logged in with API key / Bedrock / Vertex (not `claude.ai`), or your org has `channelsEnabled: false`. Diagnose with `claude /status` and `claude --version`. Otherwise, use `terminal`.

**Comment shows up in the Orphaned Comments view.** The doc text moved or got rewritten and the anchor no longer matches. Right-click the orphan → **Re-attach Orphaned Comment** → select the new anchor text in the editor.

**Multiple gutter icons on a wrapped line.** VS Code renders a gutter icon on each visual wrap row; the sidecar still has exactly one comment. Either disable wrap for Markdown:
```json
"[markdown]": { "editor.wordWrap": "off" }
```
or use the preview, which renders anchors as inline spans (no gutter).

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
- Fuzzy anchor matching (exact + context + whitespace-normalized only; everything else → orphan).
- Cross-file overview panel.
