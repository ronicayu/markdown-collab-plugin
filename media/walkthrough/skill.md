### What gets installed

The **Markdown Collab plugin for Claude Code**, installed with `claude plugin install`
from a marketplace this extension keeps on your machine — so its version always
matches the extension's:

| Part | What it does |
|---|---|
| `/markdown-collab:review` | The workflow Claude follows when it sees your comments: read threads, edit, reply, verify. |
| `mdc` | Marker-safe mutations on Claude's PATH, so it never hand-edits a marker. |
| A post-edit check | After every Edit or Write to a reviewed `.md`, tells Claude if it broke a comment marker. |

Restart running Claude sessions (or run `/reload-plugins`) to pick it up.

If your Claude Code has no plugin support, or `claude` isn't found, the command
installs the standalone skill into `~/.claude/skills/vs-markdown-collab/`
instead, and says why. Either way nothing runs in the background, and the
extension offers an update when a new version ships.
