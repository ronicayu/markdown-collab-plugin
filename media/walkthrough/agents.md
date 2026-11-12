### Connect your agent

**Connect an Agent…** gives your agent the review workflow and `mdc`, the
command it changes reviewed files with. `mdc` keeps the comment markers intact,
refuses an edit that would break one, and — while this window is open — makes
its change through the editor, so you can undo it.

| Pick | What it installs |
|---|---|
| Claude Code | The Markdown Collab plugin: the review skill, `mdc` on Claude's PATH, and a guard that stops an edit that would break a comment. |
| Another agent — Cursor, Codex, Copilot, Windsurf, … | The `AGENTS.md` section, and the review skill with `mdc` in `~/.agents/skills/markdown-collab/` — one copy for the whole machine, which those agents all read. |

Nothing to configure per agent, and no token in any file: `mdc` finds this
window by itself.
