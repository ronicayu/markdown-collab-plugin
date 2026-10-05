### Connect your agent

**Connect an Agent…** hooks the review tools up to whichever client you use, so
its edits land as edits you can undo. The list shows only the entries your
editor can support. Skip it and any agent still works: copy the prompt
(clipboard send mode), the agent edits the file following `AGENTS.md`, and
**Repair Comment Anchors** is the safety net if a marker breaks.

| Client | What it writes |
|---|---|
| Claude Code | Installs the plugin and adds a `.mcp.json` entry, in one step. |
| Cursor, in-app agent | No config file. Registered live for the session, and again after each reload. |
| Cursor CLI | `.cursor/mcp.json` with environment references. Open a new terminal in this window and start `cursor-agent` there. |
| Windsurf (Cascade) | No config file. A scratch document with the address and a session token to paste into Windsurf's MCP config. |
| Codex | A `[mcp_servers.markdown-collab]` table in `.codex/config.toml`. Codex loads it once you trust the project, so run `codex` in this folder from a new terminal in this window. |
| GitHub Copilot, agent mode | No config file. Enable the Markdown Collab tools in Copilot's tool picker. |
| Anything else | A scratch document with the address and a snippet to copy. |

Every client but Claude Code also gets the review skill in `~/.agents/skills/markdown-collab/`, one copy for the whole machine that Codex, Cursor, Copilot and Windsurf read.

No token is ever written to a file — the address and a per-session token travel through the environment of terminals your editor opens.

**Disconnect an Agent…** removes an entry you no longer want registered.
