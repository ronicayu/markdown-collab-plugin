# Markdown Collab

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/markdown-collab.markdown-collab-plugin?label=VS%20Code%20Marketplace&color=4F46E5)](https://marketplace.visualstudio.com/items?itemName=markdown-collab.markdown-collab-plugin)
[![Open VSX](https://img.shields.io/open-vsx/v/markdown-collab/markdown-collab-plugin?label=Open%20VSX&color=4F46E5)](https://open-vsx.org/extension/markdown-collab/markdown-collab-plugin)

Review Markdown *with* Claude Code, in VS Code. Comments anchor to the text and live **inside
the `.md` file**, so review state survives a commit, a branch switch, and a colleague opening
the file. There is no sidecar and no database.

## The loop

**Comment → send → Claude edits and replies → accept → resolve.**

1. **Comment.** Select a passage in the rendered preview and write a note. The thread is
   written into the file, wrapped around the exact text it points at.
2. **Send.** One button. Claude gets your unresolved threads plus the document.
3. **Claude works.** It edits the doc and replies in each thread — or, in suggest mode,
   proposes changes you accept or reject. The thread card says what it's doing while it does it.
4. **Accept.** A suggestion is a tracked change: Accept applies it, Reject keeps your wording,
   and both are ordinary editor edits you can undo.
5. **Resolve** when you're satisfied. Or reply, and go round again.

**Flip it:** right-click a `.md` → **Ask Claude to Review This Doc**, optionally say what to
focus on, and Claude opens a thread per concern for you to triage. No cap — if thirty things
warrant a thread, you get thirty.

## Try it in one minute

`Cmd-Shift-P` → **Markdown Collab: Open Tutorial Playground**.

You get a scratch document that arrives mid-review: two threads (one already answered), two
pending suggestions, and a short list of things to click. No skill install, no Claude session,
no configuration. Delete the file when you're done.

## Quick start

1. **Install the extension.**
   - **VS Code** — open Extensions (`Cmd-Shift-X`), search **Markdown Collab**, click Install. Or from the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=markdown-collab.markdown-collab-plugin), or the CLI:
     ```bash
     code --install-extension markdown-collab.markdown-collab-plugin
     ```
   - **Cursor / Windsurf / VSCodium / Gitpod** (Open VSX) — search **Markdown Collab** in Extensions, or install from the [Open VSX listing](https://open-vsx.org/extension/markdown-collab/markdown-collab-plugin).
   - **Manual / fallback** — grab the latest `.vsix` from the [GitHub Releases page](https://github.com/ronicayu/markdown-collab-plugin/releases) (`code --install-extension markdown-collab-plugin-*.vsix`), or build from source (see [Development](#development)).
2. **Install the Claude skill (one-time per machine).** `Cmd-Shift-P` → **Markdown Collab: Install Claude Skill**. This drops the skill instructions and bundled helpers into `~/.claude/skills/vs-markdown-collab/`.
3. **Open a Markdown file**, then right-click it → **Markdown Collab: Open Inline Comments View**.
4. **Select a passage in the rendered view** → **+ Comment on selection** → write your note.
5. **Click Send to Claude.** The first time you'll pick a delivery mode; the answer is
   remembered. **For most people that's `terminal`** — see [Choosing a send mode](#choosing-a-send-mode).

> What lands in the file: anchored spans wrapped in `<!--mc:a:ID-->…<!--mc:/a:ID-->`, and one
> `<!--mc:threads:begin-->`…`<!--mc:threads:end-->` block at the end holding the threads. Both
> are HTML comments, so they're invisible in GitHub, your docs site, and every other preview.

## Three surfaces

- **Inline comments view** — rendered preview on the left, threads on the right. The default,
  and where the loop above happens.
- **Live editor** — a WYSIWYG Markdown editor you and Claude share: you type, Claude edits the
  file on disk, both sides show up live. Same threads, same suggestions, no leaving the editor.
- **PR / MR review** — review the Markdown changed in a GitHub PR or GitLab MR, comment on the
  diff, reply to existing comments, post back to the platform.

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

#### Standing conventions

Some things are true of every review: the product's name, the house tone, the code-example
rule, the thing you've decided not to care about. Retyping those into the focus prompt each
time — or watching Claude re-raise them — is the tax this removes.

**Markdown Collab: Edit Review Conventions** creates `.markdown-collab/conventions.md` from
a commented template and opens it. It's plain prose you own; write what you'd tell a new
reviewer on their first day. Every review request appends it under a `Conventions:` header.

- A `Focus:` line applies to one pass; conventions apply to all of them. Where they pull
  apart, focus decides *what* warrants a thread and conventions decide *how* it's phrased —
  and a convention violation is a legitimate finding with no focus at all.
- Anything you list as known and accepted stops being a finding.
- HTML comments in the file are stripped before sending, so the template's instructions and
  your own notes-to-self never reach Claude.
- Capped at 4 KB per request, and if it's over, the payload says it was truncated rather
  than quietly dropping the rest.

#### Reviewing changes since the last pass

Once Claude has reviewed a file, **Markdown Collab: Review Changes Since Last Pass**
(right-click a `.md` file, or the command palette) reviews only what moved since then.
A second pass costs what the edit cost, not what the document costs.

The bookkeeping is inline like everything else: when Claude finishes a pass it records a
`<!--mc:rev …-->` checkpoint holding a hash of each heading-section. The next delta pass
compares those hashes, sends only the sections that changed, and tells Claude which
threads already exist — so a concern you resolved stays resolved instead of being raised
again, and a passage that was edited after its comment gets re-read first.

- Nothing changed since the last pass? You get a toast saying so, and nothing is sent.
- No checkpoint yet (first review, or a pass that ran before this feature)? It reviews the
  whole file and says so; the pass after that one can be incremental.
- The checkpoint is written by the closing integrity check, which only happens when Claude
  works through the MCP tools or the `mdc` CLI — so delta passes need one of those, not
  bare terminal editing.

#### Reviewing a whole folder

Real doc work is rarely one file, so the same command takes a **folder or a multi-select**: right-click a folder in the explorer → **Markdown Collab: Ask Claude to Review These Docs**, or select several `.md` files and use the same action. Every `.md` under the folder (excluding `node_modules`) goes into **one** review pass, so Claude can do the thing a per-file pass structurally can't — compare the documents against each other. Cross-document consistency is part of the pass: terminology that drifts between files, a claim in one file contradicted by another, duplicated guidance that has since diverged, and cross-references that no longer resolve. Such a thread is anchored in the file that's wrong and names the other file in its body.

One focus prompt covers the whole selection, and the 50 KB soft confirm applies to the summed size. Threads land per file; the Markdown Review tree shows the per-file counts, and **Next Unread from Claude** (the → button in that view's title bar) walks the unread threads across all the files in order, wrapping at the end.

### Comments that survive doc edits

Comments are anchored to a text selection, not a line number. When Claude rewrites a passage that has a comment, the skill instructs it to update the anchor text to match — so comments survive revisions.

If a rewrite removes the anchored passage entirely, the thread's markers go with it and the thread surfaces as **unanchored** in the Inline Comments view — re-anchor it by selecting fresh text and leaving the note again.

### The live editor (WYSIWYG + AI co-editing)

Prefer editing rendered Markdown directly? Right-click a `.md` file → **Markdown Collab: Open Live Editor** (or **Reopen with → Markdown Collab (live editor)**). It's a WYSIWYG editor with the same comment panel alongside it.

It's built for **one human + Claude on the same machine** — not multi-user network sync:

- You edit in the editor; your changes autosave to the `.md` on disk.
- Claude edits the same `.md` with its normal tools; those edits land back in the editor live (a brief *"Updated from disk"* note appears when they do).
- Guards keep you and Claude from overwriting each other in the normal turn-based flow.

The comment panel matches the inline view: collapse threads, an always-on reply box, resolve, delete a single comment or a whole thread, and **send one thread (or the whole file) to Claude**.

## Reviewing pull requests / merge requests

Run **Markdown Collab: Review PR / MR** to review the Markdown files changed in a GitHub Pull Request or GitLab Merge Request. It uses your existing `gh` (GitHub) or `glab` (GitLab) CLI authentication — no extra tokens to configure.

- Pick the PR/MR; its changed `.md` files appear in a **PR Review** tree in the Explorer.
- Open a file to see the rendered view with the existing review comments inline.
- Add comments, **reply** to existing threads, and edit or delete your drafts before posting.
- Click a comment's line number to jump straight to it within the review.
- Post your comments back to the PR/MR, or hand them to Claude like any other thread.

**Requires** the `gh` or `glab` CLI installed and signed in.

## Choosing a send mode

The **Send to Claude** button delivers the comment payload one of five ways. Pick one once via `markdownCollab.sendMode` and you won't be asked again.

> **TL;DR:** if MCP isn't available in your environment AND your Claude Code harness doesn't expose a streaming-stdout tool (`Monitor` or `BashOutput`), **use `terminal`**. It works everywhere with zero setup.

| Your situation | Recommended mode | Why |
|---|---|---|
| Just trying it out, or unsure | `terminal` | Zero setup. Bracketed-pastes the prompt into a `claude` REPL in your VS Code terminal. |
| MCP disabled by your company / org | **`terminal`** | Channel-based modes need MCP; terminal mode doesn't. |
| You want Claude's edits to be undoable | `mcp` | Same delivery as `terminal`, plus Claude acts through this extension's review tools, so every change lands as an editor edit you can undo. |
| Harness lacks `Monitor` / `BashOutput` | **`terminal`** | Channel mode's reactivity depends on streaming notifications; without them you'd be polling, which terminal sidesteps entirely. |
| Harness has `Monitor` / `BashOutput`, MCP allowed | `channel` | File-watcher pattern; supports long-lived watch loops without per-click setup. |
| Claude Code v2.1.80+, `claude.ai` login, channels enabled by your org | `mcp-channel` | Native `<channel>` events on Claude's next turn — cleanest semantics when supported. |
| Want to copy/paste manually each time | `clipboard` | Simplest fallback; nothing automatic. |

**Don't know which to pick? Don't.** Leave `markdownCollab.sendMode` on `ask` (the default) and the first click works it out from what's running (v0.34.58+):

- A `claude` REPL running in a terminal → `terminal`, no prompt. One toast tells you what happened.
- Otherwise, an MCP channel server that has registered itself for this workspace → `mcp-channel`, no prompt.
- Neither → the quick-pick, as before. `mcp` appears there when the review tool server is running; it is offered, never auto-selected.

The detected mode is remembered like a manual choice, and the toast names the escape hatch: **Markdown Collab: Reset Send Mode** clears it if you want to switch later. If the MCP channel turns out to be stale (its endpoint file outlived the server), the send falls back to the event log and un-remembers the choice, so the next click asks you properly instead of failing the same way twice.

## Send mode details

### `terminal` — recommended default

Bracketed-pastes the prompt into a `claude` REPL running in any VS Code terminal.

- **Detection ladder:** terminals the extension spawned → shell-integration evidence of `claude` → name match `/claude/i` → active terminal (with confirmation toast).
- **No detected terminal?** A quick-pick offers to spawn one (`claude` auto-launches inside it) or fall back to clipboard.
- **No MCP, no streaming tool, no protocol gates** — just a `paste` keystroke into your REPL.

**Setup:** none. Just have `claude` running in any integrated terminal when you click.

### `mcp` — terminal delivery, tool-driven edits

Delivered exactly like `terminal`, with one extra line asking Claude to work through this
extension's MCP review tools (`mc_list`, `mc_reply`, `mc_open`, `mc_rewrite`, `mc_suggest`,
`mc_status`, `mc_check`) instead of editing the file directly.

What that changes is the *write path*, not the delivery:

- **Undoable.** Every change arrives as a `WorkspaceEdit`, so <kbd>Cmd</kbd>+<kbd>Z</kbd> takes back
  Claude's reply or rewrite like your own typing.
- **No races with your unsaved work.** The edit is ordered against the live buffer instead of
  overwriting the file underneath it.
- **Refused before it lands, not repaired after.** A call that would break marker integrity comes
  back to Claude as a structured error and the file is untouched.

**Setup:** run **Markdown Collab: Register Review Tools with Claude Code** (or accept the prompt on
first activation). That adds a `markdown-collab` entry to the workspace's `.mcp.json`. No token is
written to that file — the URL and a per-session token travel through the environment of terminals
VS Code spawns, so a committed `.mcp.json` leaks nothing and a fresh window mints a fresh token.

**This mode is never chosen for you.** MCP can be disabled entirely on your side of the
conversation, so detection never selects it — it appears in the quick-pick only when the tool server
is actually running, and if it stops running, a send degrades to `terminal` with a toast saying so.
Claude sessions outside this VS Code window (ssh, another editor) keep using the `mdc` CLI.

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
| `Markdown Collab: Install Claude Skill` | Write `~/.claude/skills/vs-markdown-collab/SKILL.md` and the bundled helpers (`mdc.mjs`, `mdc-tail.mjs`, `mdc-channel.mjs`). |
| `Markdown Collab: Initialize AGENTS.md` | Append a convention block to `<workspace>/AGENTS.md` (for non–Claude-Code agents). |
| `Markdown Collab: Open Inline Comments View` | Open the rendered view with an inline-threads sidebar. Comments are stored inside the `.md` file. The right-click action on `.md` files. |
| `Markdown Collab: Open Live Editor` | Open the WYSIWYG live editor with the comment panel — you and Claude co-edit the same `.md` (single human + Claude, no relay). |
| `Markdown Collab: Review PR / MR` | Review the Markdown files changed in a GitHub PR or GitLab MR via the `gh` / `glab` CLI. |
| `Markdown Collab: Ask Claude to Review This Doc` | Ask Claude to act as the reviewer (v0.29+). Prompts for an optional focus directive, then sends a Review Mode payload through the configured send mode. Claude opens one thread per concern; you triage in the sidebar. |
| `Markdown Collab: Ask Claude to Review These Docs` | Same, over a folder or a multi-select of `.md` files — one review pass across all of them, including cross-document consistency (v0.34.55+). Right-click a folder in the explorer. |
| `Markdown Collab: Next Unread from Claude` | Jump to the next thread Claude opened that you haven't answered, walking across every file in the Markdown Review tree. Also the → button in that view's title bar. |
| `Markdown Collab: Send Unresolved Comments to Claude` | Same as the **Send to Claude** button — usable from palette. |
| `Markdown Collab: Start Claude Review Terminal` | Spawn a fresh integrated terminal and launch `claude`. |
| `Markdown Collab: Copy Claude Prompt` | Copy a short "address the comments on this file" prompt to clipboard. |
| `Markdown Collab: Reset Send Mode` | Clear the remembered `ask` choice for the current workspace. |
| `Markdown Collab: Remove All Resolved Comments` | Delete every resolved thread from the file at once, markers and all. Open threads and pending suggestions are left alone. Modal confirm; one undo step. Also a **Remove N resolved** button in both comment panels, shown only when there is something to remove. |
| `Markdown Collab: Show Logs` | Open the **Markdown Collab** output channel. Set its level to **Trace** (gear icon in the Output panel) to see per-send and per-tool-call detail. |
| `Markdown Collab: Report a Problem (collect diagnostics)` | Build an environment report — versions, send mode, skill and tool-server status, per-document review state — into a scratch document, ready to paste into an issue. Contains no tokens. |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `markdownCollab.showLineNumbers` | `false` | Show the source line number beside each block in the inline comments view and the live editor. Numbers are lines in the `.md` file itself — frontmatter and the stored threads block are accounted for, so they match what you'd type into "Go to Line". |
| `markdownCollab.sendMode` | `ask` | One of `ask`, `terminal`, `mcp`, `channel`, `mcp-channel`, `clipboard`. See [Choosing a send mode](#choosing-a-send-mode). |

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
    ├── .channel.json         ← mcp-channel endpoint descriptor (gitignore)
    ├── .mcp-server.json      ← review tool server address + session token (gitignore)
    └── conventions.md        ← standing review conventions (COMMIT this one)
```

```gitignore
.markdown-collab/
!.markdown-collab/conventions.md
```

Everything under `.markdown-collab/` is runtime state except `conventions.md`, which is
project prose your team should share — hence the negation above.

## Troubleshooting

**Start here for anything.** Run **Markdown Collab: Report a Problem (collect diagnostics)** — it answers the first six questions of any diagnosis in one paste (versions, send mode, whether the skill is installed and current, whether the tool server is up, whether a Claude terminal is visible, and what review state each open document holds). Then open **Markdown Collab: Show Logs**, set the level to **Trace**, and reproduce: every send, terminal resolution, MCP tool call, tool refusal, and `gh`/`glab` invocation is logged with its outcome. Both are safe to share — the session token and anything else credential-shaped is redacted before it is written.

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

Three suites, all run in CI and again on every tag:

```bash
npm test               # Vitest — pure helpers, format engine, prompts
npm run test:integration   # a real Extension Host: TextDocuments, WorkspaceEdits, undo
npm run test:webview       # the shipped webview bundles in Chromium, driven by a real pointer
```

The VS Code API surface is stubbed in `src/test/vscode-stub.ts` for tests of pure helpers.
Press **F5** to launch an Extension Development Host for the handful of things no harness
reaches (explorer context menus, the skill install flow, a live Claude session).

To produce a `.vsix` for distribution:
```bash
npx @vscode/vsce package
```

### Releasing

Bump the version in `package.json`, prepend a `## X.Y.Z — <date>` block to `CHANGELOG.md`,
commit, then tag `vX.Y.Z` and push the tag. Run `node scripts/release-checklist.mjs` first —
it prints where the tag will publish and fails on anything a script can decide.

The release commit message picks the destination:

| Marker in the commit | What the tag does |
|---|---|
| `[skip-publish]` | GitHub Release with the `.vsix`. Nothing goes public. |
| `[pre-release]` | **Publishes publicly** to the VS Code Marketplace and Open VSX pre-release channels. Users who opted into pre-releases get it as an auto-update; everyone else stays on stable. |
| *(neither)* | **Publishes publicly** as a stable release to both marketplaces. |

A marketplace version must be plain `x.y.z`, so the channel can't be encoded in the tag
name — it lives in the commit message, the same way `[skip-publish]` already did.

The workflow refuses to publish unless the tag matches `package.json`, the CHANGELOG has a
non-empty section for that version, all three test suites pass, and `verify-package` is
happy with the built `.vsix`.

## Out of scope (v1)

- Real-time **multi-user** (multi-human) collaboration. The live editor is single human + Claude; "collab" here means human ↔ AI, not multiple people editing at once.
