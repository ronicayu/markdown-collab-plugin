### What gets installed

`~/.claude/skills/vs-markdown-collab/` — the instructions Claude follows when it
sees your comments, plus one helper:

| File | What it does |
|---|---|
| `SKILL.md` | The workflow: read threads, edit, reply, verify. |
| `mdc.mjs` | Marker-safe mutations, so Claude never hand-edits a marker. |

Nothing runs in the background. The extension checks the installed copy against
the bundled one and offers an update when they differ.
