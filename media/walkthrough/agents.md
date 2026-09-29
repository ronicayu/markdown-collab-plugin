### Other agents

**Connect an Agent…** hooks the review tools up to whichever client you use. The list shows only the entries your editor can support.

| Client | What it writes |
|---|---|
| Claude Code | Installs the plugin and adds a `.mcp.json` entry, in one step. |
| Cursor, in-app agent | Nothing on disk. Registered live for the session, and again after each reload. |
| Cursor CLI | `.cursor/mcp.json` with environment references. Restart `cursor-agent`. |
| Codex | A `[mcp_servers.markdown-collab]` table in `.codex/config.toml`. Codex loads it once you trust the project. |
| GitHub Copilot, agent mode | Nothing on disk. Enable the Markdown Collab tools in Copilot's tool picker. |
| Anything else | A scratch document with the address and a snippet to copy. |

No token is ever written to a file — the address and a per-session token travel through the environment of terminals VS Code opens.

**Disconnect an Agent…** removes an entry you no longer want registered.
