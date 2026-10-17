---
name: review
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace, AND for reviewing Markdown docs by leaving review comments for the human. Comments are stored INLINE in the .md file itself (look for `<!--mc:threads:begin-->`). TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document — trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md". ALSO TRIGGER on review-mode requests where the user asks YOU to play reviewer — "review this doc", "leave your thoughts on README", "do a review pass on docs/spec.md", "second pair of eyes on this", "what would you flag in this file", "review the markdown collab doc on X".
---

# Markdown Collab — review comments in Markdown files

The human reviews Markdown with the Markdown Collab extension in their editor; Claude does the writing. Comments live inside the `.md` file: `<!--mc:a:ID-->…<!--mc:/a:ID-->` markers around each commented passage, and a `<!--mc:threads:begin-->` block at the end with one `<!--mc:t {JSON}-->` line per thread. A file without `<!--mc:threads:begin-->` has no comments.

## The one rule: change a reviewed file only with `mdc`

One dropped `-->` silently orphans a reviewer's comment, so never edit a marker or a thread line yourself — not with an Edit tool, not with `sed`, not by rewriting the file. Every change to a reviewed file goes through `mdc`, which runs the editor's own engine: `mdc <command> <file> …`. It validates before it writes and refuses rather than guesses; when the file is open in the editor it writes through it, so the human can undo. This plugin also refuses an Edit or Write that would change a marker or thread line, and names the command to use. Plain prose that no marker touches may still be edited as usual.

If `mdc` won't run (no `node`, or the command isn't there), stop and tell the human — ask them to run **Markdown Collab: Connect an Agent** — instead of editing markers by hand. (If the `markdown-collab` MCP tools are in your tool list, their `mc_*` tools are the same engine: either is fine.)

| `mdc …` | Does |
| --- | --- |
| `list <file> [--actionable]` | Threads and pending suggestions as JSON, with each thread's live anchored text. `--actionable`: only open threads whose last comment isn't yours. |
| `reply <file> <threadId> --body TEXT` | Append your reply to a thread. |
| `rewrite <file> <threadId> --with TEXT` | Replace the commented passage; markers kept, `quote` updated. |
| `edit <file> --old TEXT --new TEXT [--occurrence N]` | Replace exact text outside commented passages. An `--old` that spans both markers of a passage deletes it. |
| `open <file> --quote TEXT --body TEXT [--occurrence N]` | Open a new thread on a passage. |
| `suggest <file> --quote TEXT --with TEXT --note TEXT [--occurrence N]` | Propose an edit for the human to accept or reject. |
| `resolve <file> <threadId>` | Resolve a thread — only when the human asks. |
| `check <file> [--repair]` | Integrity check. **Run it last on every file you touched**: it also ends the human's "Waiting for the agent…" row. `--repair` fixes what it safely can. |
| `help review` | The reviewer's rubric — read it before a review pass. |

Output is JSON. A refusal (`{"ok":false,"code":…,"message":…}`) changed nothing: an ambiguous passage wants `--occurrence`; `conflict` means the file changed meanwhile — run it again. Never work around a refusal.

## Addressing comments

1. `list <file> --actionable`, and read the file itself.
2. For each thread, in document order: make the change — `rewrite` inside the commented passage, `edit` outside it. Removing the passage leaves the thread unanchored, which is correct: never re-anchor it to nearby text. Then `reply` in one or two specific sentences quoting what changed — not "done". Can't address it? Reply with what you tried and what you need.
3. `check` each file you touched, last.

Only the human resolves, accepts or rejects. The thread record is history: reply, never edit or delete anyone's comment; if the human asks for a thread to go, reply that it can and they remove it. Open a new thread only when asked — a review request counts.

## Suggesting instead of editing

When the request asks for suggestions ("suggest edits", "as suggestions"), make every change with `suggest` — no direct edits at all. One suggestion per sentence or list item, re-reading between them; always say why in `--note`; never accept or reject your own. A rewrite that can't be split goes in a comment instead.

## Reviewing a document

When asked to review ("review this doc", "second pair of eyes", the extension's Ask Agent to Review), you open threads and never edit prose. Run `mdc help review` first and follow it.

## Reporting

Per file, by thread id: what you changed (quote it), the threads you opened, threads left unanchored and why, and anything you skipped and why. Never call a comment addressed when it isn't.
