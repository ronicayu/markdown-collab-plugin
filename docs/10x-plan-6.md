# Round 6: what Ronica actually uses

Draft, 2026-09-29. Source: a grill session on the evening of 2026-09-28,
right after `docs/ux-review-2026-09.md` shipped as 0.35.12. The review had
been built from code shape and three read-only sweeps; the grill asked the
one person who uses the product. Six of the review's judgements did not
survive. This plan is what replaces them.

## What the grill established

| The review assumed | What is true | Decision |
|---|---|---|
| MCP registration is the path for other agents | The only non-Claude loop ever run was Copilot: copy the prompt, paste, Copilot hand-edited the markers. They survived. Nobody has run the MCP path with a non-Claude client. `mdc` is only on PATH inside Claude Code. | **The format is the API.** Connect an Agent → non-Claude writes AGENTS.md by default; MCP is the optional second step. |
| "Review state survives a commit" is the storage pitch | Threads rarely get committed; the file is finalized first. Threads do live across days. | Say "survives the night". A stage-time reminder, never an automatic finalize. |
| Headless is the hero | Not used. Built for "people who can't use a terminal" — who can't sign in to Claude Code either. | Hero is terminal. Headless stays as "Other ways to send". |
| "No cap" on review threads is right | Too many comments. Most do lead to a document change, so the quality is fine; the volume isn't. | Rank by severity, open the top 5, one summary thread for the rest. |
| PR review and the live editor are edge features | They are the two most-used surfaces. PR review is a review client for a colleague's Markdown — agent-free by design. The live editor is opened by hand every time via Open With. | Reversed the same day. Merge the review view and the live editor into one view, read-only by default. |
| Suggest mode is a headline feature | Off, because it's unusable: the agent ignores it and edits directly; a suggestion that rewrites a paragraph is unreadable. | Enforce it at the tool layer; word-level diff in the card. |

The lesson for the process is in the ux-review's status section: the
review inferred "edge" from `frozen` and a separate data model without
asking. Every plan from here starts with a usage question, not a code sweep.

Added 2026-09-29: most installs come through **Open VSX** (~9.7k downloads —
Cursor, Windsurf, VSCodium), not the VS Code marketplace. The typical user
is not on VS Code with Claude Code. That makes P1 the mainstream path, a
dogfooded Cursor loop (P1.5) the most important unproven thing, and "in VS
Code" the wrong phrase for any copy.

## P0 — Correct the story (one version, copy only)

- README: hero path is **terminal**. "Review with Claude" in the empty state
  dispatches through the terminal. Headless moves to an "Other ways to send"
  subsection and stops saying "no terminal".
- "Survives a commit, a branch switch, and a colleague opening the file" →
  "stays in the file overnight and across sessions; strip it before you
  commit". Mention the stage-time reminder once it exists (P5).
- PR review gets its own section: what it is (read a colleague's Markdown
  changes rendered, comment back through `gh`/`glab`), what it isn't (an
  agent loop).
- "Other agents" becomes three lines: copy the prompt → the agent edits the
  file following AGENTS.md → `mdc check` / Repair is the safety net. The
  Connect an Agent table moves under "Optional: undoable edits through MCP".
- Marketplace description: keep "Works with Cursor, Codex, and Copilot
  agents too" only after P1 ships; until then it is an untested promise.

## P1 — The format is the API

1. **Connect an Agent → Cursor / Codex / Copilot / Other** writes (or
   refreshes) the AGENTS.md snippet first and says so; the MCP registration
   is offered as a second, optional step in the same flow ("also register the
   review tools so edits are undoable?"). Disconnect mirrors it.
2. **`docs/format.md`**: one page. Anchor markers, the threads block, the
   thread JSON (every field, which are optional), the suggestion shape, the
   checkpoint, the integrity rules `mdc check` enforces, and what Repair
   will and won't do. This is the contract other agents are held to; the
   AGENTS.md snippet links to it.
3. **Stop implying other agents have `mdc`.** The snippet, the README, and
   the skill text say `mdc` is on PATH only inside Claude Code; anyone else
   hand-edits per the spec and runs `mdc check` if they can, or asks the
   human to.
4. **Know how each reply arrived.** The extension can tell an MCP write from
   an external file change. Record it per comment (`via: "tools" | "cli"`,
   absent = written straight into the file) and show a small marker on the
   card. After a week there is data, not
   "应该是 mdc".
5. **One dogfooded loop per agent before the marketplace description claims
   it.** Cursor and Codex have none yet.

## P2 — Suggest mode that works

1. **Enforce, don't ask.** When suggest mode is on for a file, `mc_edit` and
   `mc_rewrite` refuse with `suggest_mode_on` and point at `mc_suggest`; the
   forwarded `mdc edit` / `mdc rewrite` inherit the refusal. The Claude Code
   PostToolUse hook reports a direct Edit-tool write to a file in suggest
   mode. Tests in mcpTools and skillCli.
2. **Word-level diff in the card.** The suggestion card shows the changed
   words inside the sentence, not a whole-paragraph `-`/`+` pair. Keep the
   paragraph view behind a "show full" toggle for large rewrites.
3. **One suggestion, one change.** Skill text: a suggestion changes one
   sentence or one list item; a paragraph rewrite is split into several, or
   becomes a comment with a proposed text when it can't be. Add a size guard
   in `mc_suggest` (refuse a suggestion whose `--with` is more than ~3× the
   quote, with a message saying to split).
4. Then turn suggest mode on by default in Review Mode: a concern that has an
   obvious fix arrives as a suggestion with a one-line reason; a concern
   without one arrives as a comment.

## P3 — Five threads, then a summary

- Review Mode ranks concerns by severity and opens threads for the top five.
  Everything else goes into one summary thread at the top of the file: "Also
  noticed (8): …", each item one line with its passage, so the human can say
  "open 3 and 7".
- The focus directive can override the count ("give me ten", "everything").
- Skill text, review prompt, README, and the walkthrough drop "There is no
  cap". The skillText fixture gets an `INTENTIONAL_CHANGES` entry.

## P4 — One view

The review view (markdown-it, read-only, owns mermaid/PlantUML/draw.io, the
outline, find, line numbers, diff stripes, suggestion cards) and the live
editor (milkdown, editable, its own anchor locator) share the threads
sidebar and differ in whether the rendered text can be edited. Ronica opens
the live editor by hand for most work and wants one view, **read-only by
default, editing a toggle**.

This is a round of work on its own. Do the spike first:

1. **Spike (one week, go/no-go):** render the review view's fixtures through
   milkdown in read-only mode. Check: fenced diagrams, tables, HTML images,
   the outline and find bar, diff stripes for the uncommitted view, the
   suggestion card and highlight alignment. List what's missing and estimate
   each. Separately, check whether round-tripping through milkdown ever
   changes Markdown the user didn't edit (list markers, table padding,
   escapes) — that decides whether edit mode can ever be the default.
2. If go: migrate the review view's features onto the live editor's renderer
   one at a time behind the read-only mode; the live editor's locator becomes
   the only one. If no-go: the alternative is adding editing to the
   markdown-it view, which means building an editor — say so and stop.
3. Retire "frozen; new capabilities land in the review view first" either
   way. Decide whether the merged view becomes the default editor for `.md`
   (`priority: default`, text editor in Open With) — open question 3.

## P5 — Small, from the grill

- Stage-time reminder: the Uncommitted Markdown tree marks files that still
  carry threads; staging one shows "3 threads still in guide.md". No
  automatic finalize.
- The review view's Send button and pending text take the agent's name from
  the host (the panel gets an `agentName` in `init`).
- README GIFs re-recorded after P0 copy changes if the toolbar text changes.

## What NOT to do

- Don't remove headless. Demote it.
- Don't auto-finalize. Threads live across days on purpose.
- Don't build Cursor- or Codex-specific flows before one loop has been run
  with them.
- Don't add a severity field to the thread format. The cap is a prompt rule
  (option A), not a schema change (option B).
- Don't start the view merge without the spike.

## Status — 0.35.13 (2026-09-29)

P0, P1, P2.1–2.3, P3 and P5 shipped in 0.35.13. Deviations:

- **P1.1** Connect → non-Claude asks the MCP question as one non-modal
  toast right after writing AGENTS.md, not a second QuickPick. The
  snippet links `docs/format.md` by its GitHub URL — `docs/` isn't in the
  `.vsix`, so a relative link would break in every user's workspace; the
  link resolves once round-4 reaches `main`.
- **P1.4** `via: "tools" | "cli"`, absent for a hand edit. `opResolve`
  isn't stamped; resolving writes no comment.
- **P2.1** The hook reads only `<cwd>/.vscode/settings.json` and only
  flags files that already have a threads block. A multi-root
  `.code-workspace` isn't read; it stays silent rather than guess.
- **P2.4** Dropped: suggest mode stays off by default (question 2,
  answered 2026-09-29).
- **P3** Five per file in a multi-file pass, one summary per file.
- **P4** Spike in `docs/spike-one-view.md`: **go with conditions**.
  Read-only milkdown renders the same content (better on footnotes and
  HTML `<img>`; gaps: PlantUML, draw.io, task checkboxes, `<br>`, mermaid
  source shown, suggestion text not highlighted — all S). Porting: diff
  stripes M, sidebar parity M, highlight alignment L. Round-trip: 2 of 8
  fixtures byte-clean; one keystroke rewrites 40–624 lines of a real doc
  (`-`→`*` bullets, tight→loose lists, table re-padding, escapes, setext→ATX,
  reference links inlined, `<br>` deleted). That answers question 4: yes.
  Edit mode can never be the default; the conditions are to fix the two
  bugs below, anchor by source position with 0 misplaced highlights, and
  have edit mode write back only the edited blocks. The spike also found
  two shipped bugs: the live editor drops pending suggestions and the
  checkpoint on every edit or comment (`inlineBridge.ts` never passes
  suggestions to `withThreads`), and draw.io renders in neither view (the
  mxgraph factory is called without `this` in a strict-mode bundle). Both
  fixed in 0.35.14.
- **P4 phase A — 0.35.15.** Read-only mode anchored by source position
  (`docs/one-view-design.md`): 0/164 thread and 0/19 suggestion probes
  misplaced, 0 prose lines changed per comment on 17 documents; drag bug
  fixed; all six rendering gaps closed. Behind
  `markdownCollab.liveEditor.readOnly`, off by default. Remaining before it
  can be the default surface: an in-view read-only/edit toggle, sidebar
  parity (filters, suggest switch, keyboard nav, unanchored marking), diff
  stripes, and the block-splice write-back for edit mode.
- **P4 phase B — 0.35.16. One view.** Edit/read-only switch per panel;
  sidebar parity via `src/webviewShared/threadSidebar.ts` +
  `src/collab/sidebarHost.ts`; uncommitted-diff stripes and change nav;
  block-splice write-back (gate: 1,596 blocks, 0 failures); one router
  (`src/commands/reviewViewRouter.ts`) sends every entry point to the live
  editor, read-only by default (`liveEditor.readOnly` now `true`). The
  markdown-it panel stays one release behind `classicReviewView`. Freeze
  retired. Open: edit-mode add-comment still adopts the editor's
  serialization; the classic panel's removal; hand testing of reveal in a
  real window.
- **0.35.17–0.35.18.** The view is named Markdown Collab (Reading ·
  Editing); PR review resolves threads; every card collapses. A four-way
  code review then found Editing mode could lose typing, fuse paragraphs,
  delete link definitions and create frontmatter, and that draw.io had been
  rendering empty since 0.35.14; all fixed test-first, with a write-time
  safety net and a 400-case fuzz test (see `docs/one-view-design.md`).
  Edit-mode comments are byte-exact now. Still open: the classic panel's
  removal; versioned edits for the outside-change window.
- **P5.2** The "New from Claude" filter chip already derived its name
  per thread; only the Send button, switch and pending text changed.
- **Not done:** question 5 (marketplace description) — untouched.

## Open questions for Ronica

1. Cap number — 5 is the default in P3. Fine?
2. P2.4 turns suggest mode on by default for Review Mode once enforcement
   works. Yes?
3. Should the merged view be the default editor for `.md` (text editor via
   Open With), or stay opt-in?
4. Has the live editor ever changed Markdown you didn't touch? (Asked in the
   grill, not answered; it decides P4 step 1's second check.)
5. Marketplace description: drop "Works with Cursor, Codex, and Copilot
   agents too" until P1.5 has one loop per agent, or leave it?
