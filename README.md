# Markdown Collab

A VS Code extension that lets you leave review comments on Markdown files in a format Claude Code (and other agentic AIs) can read and act on.

## Workflow

1. Claude Code (or you) writes a Markdown document.
2. You highlight text in VS Code and add a review comment via the native Comments UI.
3. Comments persist to a JSON sidecar at `.markdown-collab/<path>/<file>.md.json`.
4. You run `claude` and say _"address the review comments on docs/guide.md"_.
5. Claude Code reads the sidecar, edits the doc, and appends a reply to each comment explaining what it did.
6. You review the replies (optionally push back with more replies), then mark the thread resolved.

## Install

From source:

```bash
cd markdown-collab-plugin
npm install
npm run compile
```

Open this folder in VS Code and press **F5** to launch an Extension Development Host window, or package into a `.vsix`:

```bash
npx @vscode/vsce package
code --install-extension markdown-collab-plugin-*.vsix
```

## One-time setup per machine

After installing, run the command **"Markdown Collab: Install Claude Skill"** from the Command Palette. This copies a skill file to `~/.claude/skills/markdown-collab/SKILL.md`. Claude Code will discover the skill automatically.

## One-time setup per workspace (optional)

For agents other than Claude Code (Cursor, Cline, etc.), run **"Markdown Collab: Initialize AGENTS.md"** in each workspace. It appends a convention block to `AGENTS.md` at the workspace root.

## Commands

| Command                                 | Purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `Markdown Collab: Install Claude Skill` | Write `~/.claude/skills/markdown-collab/SKILL.md`.              |
| `Markdown Collab: Initialize AGENTS.md` | Append convention to workspace `AGENTS.md`.                     |
| `Markdown Collab: Copy Claude Prompt`   | Copy a "address the comments on this file" prompt to clipboard. |
| `Markdown Collab: Reload Comments`      | Re-read the active file's sidecar from disk.                    |
| `Markdown Collab: Validate Sidecars`    | Scan the workspace for schema violations and would-be-orphans.  |

## Storage layout

```
<workspace>/
├── docs/guide.md
├── README.md
├── AGENTS.md                     ← optional (run "Initialize AGENTS.md")
└── .markdown-collab/
    ├── docs/guide.md.json
    └── README.md.json
```

The `.markdown-collab/` folder should be committed to version control — it's your review state.

## Anchors

Comments are anchored to a text selection, not a line number. When Claude Code rewrites a passage that has a comment, the skill instructs it to update the comment's anchor text to match — so comments survive revisions. If that fails, the comment appears in the **Orphaned Markdown Comments** TreeView (only visible when orphans exist), where you can click to re-attach it to a new selection.

Selections must contain at least 8 non-whitespace characters. Shorter selections are rejected at creation time.

## Development

```bash
npm install
npm run compile
npm test
```

Unit tests run under Vitest. VS Code API surface is stubbed in `src/test/vscode-stub.ts` for tests of pure helpers.

Press **F5** in VS Code to launch an Extension Development Host for manual verification.

## Known issues

### Multiple gutter icons on word-wrapped lines

When `editor.wordWrap` is on and an anchor lives on a long logical line, VS Code
renders a comment gutter icon on **every visual wrap row** of that line. This
is how VS Code's Comments API renders glyph-margin decorations; extensions
cannot override it. The sidecar still stores exactly one comment — only the
visual icon count is inflated.

Workarounds:

- Disable word-wrap for markdown only. Add to `settings.json`:

  ```json
  "[markdown]": { "editor.wordWrap": "off" }
  ```
- Use the preview (`Markdown Collab: Open Preview with Comments`). The preview
  renders anchor highlights as plain inline spans and is unaffected.

## Out of scope (v1)

- Multi-user collaboration with author attribution.
- Fuzzy anchor matching (exact + context + whitespace-normalized only; everything else → orphan).
- Sidecar file-system watcher (reload-on-focus is the refresh mechanism).
- Cross-file overview panel.
- MCP server / CLI tool.
