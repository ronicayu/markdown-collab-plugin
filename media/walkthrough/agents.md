### Other agents

The default path needs no registration: copy the prompt (clipboard send mode)
→ the agent edits the file following `AGENTS.md` → **Repair Comment
Anchors** is the safety net if a marker breaks. `mdc check` does the same
check, but only from inside a Claude Code session — it isn't on any other
agent's PATH.

**Connect an Agent…** is the optional second step: it hooks the review tools
up to whichever client you use, so its edits land as edits you can undo
instead. The list shows only the entries your editor can support.

| Client | What it writes |
|---|---|
| Claude Code | Installs the plugin and adds a `.mcp.json` entry, in one step. |
| Cursor, in-app agent | Nothing on disk. Registered live for the session, and again after each reload. |
| Cursor CLI | `.cursor/mcp.json` with environment references. Open a new terminal in this window and start `cursor-agent` there. |
| Codex | A `[mcp_servers.markdown-collab]` table in `.codex/config.toml`. Codex loads it once you trust the project, so run `codex` in this folder from a new terminal in this window. |
| GitHub Copilot, agent mode | Nothing on disk. Enable the Markdown Collab tools in Copilot's tool picker. |
| Anything else | A scratch document with the address and a snippet to copy. |

No token is ever written to a file — the address and a per-session token travel through the environment of terminals VS Code opens.

**Disconnect an Agent…** removes an entry you no longer want registered.
