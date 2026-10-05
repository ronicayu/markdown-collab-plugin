# Product and UX review — 2026-09-28

Reviewed at round-4 head (3599a1c, 0.35.11). Method: `package.json`
contributes, README, walkthrough, frames from both README GIFs, and three
read-only code sweeps (human-facing copy, in-editor loop, agent side). Every
finding marked **[verified]** I reproduced or read myself; the rest are from
the sweeps with the file:line they cited. Nothing was edited.

## Verdict

The Claude Code path is a good product. The rest is a good product's
unfinished second identity.

The loop itself — anchor a comment in the file, send, agent edits and
replies, accept or reject a suggestion, resolve — is coherent, the
suggestion card is the best thing in the UI, destructive actions are honest
(counts, what survives, one undo step), and the status bar refuses to guess.
That is the part to protect.

Three things pull against it:

1. **Two products in one.** The marketplace description says "Works with
   Cursor, Codex, and Copilot agents too." The walkthrough, every prompt the
   extension composes, the clipboard toasts, the status-bar tooltip, and the
   `AGENTS.md` snippet still assume Claude Code. A Cursor user who finishes
   the walkthrough never learns Connect an Agent exists.
2. **Too many front doors and too many verbs.** Three setup commands do
   overlapping things; 27 palette commands, five of them starting with
   "Review" and pointing in opposite directions; four names for the sidebar.
3. **The agent write path has real data-safety holes** — one of them
   corrupts a file and then reports it clean. These are small fixes but they
   are the kind of bug this product exists to prevent.

Recommended order: P0 data safety (days), P1 one setup and one voice, P2
declutter, P3 sidebar polish, P4 subtract. Details below. Five product
questions for Ronica at the end.

---

## P0 — Data safety in the agent write path

**0.1 `--occurrence <non-number>` corrupts the file and `check` calls it clean. [verified, reproduced]**
`src/skillCli/mdc.ts` parses `--occurrence` as `Number(flag)` with no
validation; `locatePassage` (`src/inlineComments/docOps.ts:148-179`) guards
`=== 0` and `index >= hits.length`, both false for `NaN`, so it returns
`hits[NaN]` and the `!` assertion hides it. Repro on a clean file:
`mdc open occ.md --quote alpha --body "which?" --occurrence banana` → exit 0,
JSON says `"quote":"alpha"`, file gets
`<!--mc:a:ID--><!--mc:/a:ID-->` at byte 0 and a thread with `"quote":""`.
Then `mdc check occ.md` → `ok: true, issues: []`.
The MCP side already validates (`tools.ts:345-353 occurrenceOf`). Fix in the
shared layer: `locatePassage` rejects non-integer/negative occurrence; `mdc`
validates the flag; integrity flags a zero-width anchor or empty quote as
broken. Add the repro as a test for both front ends.

**0.2 `mdc` writes raw to disk; the MCP path writes through the buffer.**
`mdc.ts:173-201 apply()` → `writeFileSync`, no dirty-buffer awareness.
`mcpServer/index.ts:106-128` goes through `WorkspaceEdit` (undoable,
reconciled). The extension already injects `MARKDOWN_COLLAB_MCP_URL`/`_TOKEN`
into VS Code terminals. Make `mdc` a thin client: when those env vars are
present and the server answers, forward the verb to the running extension;
otherwise fall back to the current direct write. One write path, and the
"Claude replied in the terminal but the file didn't change" troubleshooting
entry mostly disappears with it.

**0.3 Keyboard comment path leaves the file dirty; the sidebar path force-saves. [verified]**
`commands/comments.ts` (`Comment on Selection`) never calls `save()`;
`inlineCommentsPanel.ts:851-865` saves after every mutation and says why in
a comment. An agent reading from disk right after a `Cmd+K Cmd+Alt+M` comment
does not see it. Pick one behaviour; the panel's reasoning is right.

**0.4 `AGENTS.md` teaches hand-editing markers. [verified]**
`src/agents.ts:6-27` tells any agent to append JSON to the `<!--mc:t-->`
line and wrap passages by hand — exactly what `mdc.ts:3-8` and
`skillText.ts:128` call "the single most common way this workflow breaks".
It never mentions `mdc` or the MCP tools. Rewrite the snippet to the same
hierarchy the skill uses (MCP tools → `mdc` → hand-edit as last resort), or
generate it from `renderSkill("other")`.

**0.5 A flag value starting with `--` is swallowed. [verified]**
`mdc.ts:118-137`: `--body "--this"` → `mdc: missing required --body`. An
em-dash shorthand or a quoted CLI flag in a doc triggers it, and the error
points at the wrong cause. Only treat `next` as a flag if it matches
`/^--[a-z]/i`, or support `--flag=value`.

**0.6 Reply to a resolved thread succeeds and stays resolved. [verified]**
`docOps.ts:267-288 opReply` never touches `status`. The default sidebar
filter is Open, so the reply lands where the human isn't looking, and the
tool says nothing. Either reopen on reply (matches every review tool the
user knows) or return a warning field in the result.

**0.7 `--help` says "All commands print JSON to stdout"; errors go to stderr as prose.**
`mdc.ts:79` vs `fail()` at `:85-88`. An agent that parses stdout per the
help text gets an empty parse on every error. Fix the sentence, and emit
`{"ok":false,"code":…}` on failure so the CLI and the MCP refusal shape
match (the CLI already computes the code for its exit status).

## P1 — One setup, one voice

**1.1 Three setup commands, no map.** `Set Up Claude Code` (plugin),
`Register Review Tools with Claude Code (.mcp.json)`, and
`Connect an Agent… → Claude Code` (same code path as Register, per
`setup.ts:398`). README step 2 says Set Up; the "Registering" section says
Register; "Other agents" says Connect. Proposal: **Connect an Agent…** is
the only setup command. Its Claude Code entry does plugin *and* `.mcp.json`
in one go and says what it did. The other two become hidden aliases
(`when: false`) for a release, then go. The first-activation nudge
(`setup.ts:184-192`) points at Connect an Agent.

**1.2 The walkthrough is Claude-only and quotes a label that doesn't exist. [verified]**
Five steps, zero mentions of Connect, Cursor, Codex, Copilot. Step 4 says
"'Send to active terminal' works everywhere"; the picker label is
"Send to your Claude terminal" (`sendModePicker.ts:50`).
`media/walkthrough/send.md` lists terminal and clipboard only — headless,
the README's hero, is absent. Fix the label, add headless to the table, add
a sixth step "Using another agent?" → `command:markdownCollab.connectAgent`.

**1.3 Prompts and toasts hardcode Claude Code for every agent. [verified]**
`skillDelivery.ts:22-29 workflowOpener` opens every prompt with "Use the
Markdown Collab review skill (`markdown-collab:review`…)" regardless of
target. `commands/send.ts:67,342,424,427,567` "paste into Claude Code" on
the generic clipboard path. `claudeStatusBar.ts:82 PROTOCOL_TOOLTIP` names
Claude while the adjacent text names the real agent. `agentDisplayName()` in
`agentIdentity.ts` already exists — wire it through. This is plan-5 P3;
the list above is the concrete worklist.

**1.4 Which send mode is recommended? Three answers.** Setting enum and
walkthrough: terminal is "the recommended choice". README hero and picker:
headless first when available. Decide once — headless when it can work,
terminal otherwise — and use that sentence in the setting, the picker, the
walkthrough and the README.

## P2 — Declutter the host

**2.1 Two Explorer trees are always visible. [verified]**
`markdownCollab.prReviewFiles` and `markdownCollab.uncommittedFiles` have
no `when` and no `visibility` (`package.json:545-552`); `markdownCollab.review`
correctly has `when: markdownCollab.hasReview`. Every workspace, git or not,
markdown or not, gets two empty panels on install. Gate both on a context
key (workspace has git and `.md`), or move all three into one
`Markdown Collab` view container with `visibility: collapsed`.

**2.2 Six top-level entries in every `.md` right-click, including a destructive one. [verified]**
`explorer/context` adds Open Inline Comments View, Ask Claude to Review This
Doc, Review Changes Since Last Pass, Remove All Resolved Comments, Remove
All Review Data — all in `navigation@30-34`, no submenu (`grep submenus` →
none). Put them under one **Markdown Collab** submenu; keep only
Open Review View at top level.

**2.3 Palette: 27 visible commands; hide or merge these.**
Hide (`when: false`): `uncommittedRefresh`, `prReviewRefresh` (icon-only
view actions), `askClaudeToReviewFolder` (from the palette it silently
reviews only the active file — `review.ts:120-128`, one handler for both
commands **[verified]**), `registerMcpServer`, `installClaudeSkill` (after
1.1), `startClaudeTerminal`, `copyClaudePrompt` (clipboard send mode already
does this), `initializeAgents` (after 0.4, fold into Connect an Agent →
Other). `resetSendMode` → a link in the setting description instead.
`openCollabEditor` → see P4.

**2.4 Five commands start with "Review" and point both ways.**
"Ask Claude to Review This Doc", "Review Changes Since Last Pass" (agent
reviews you) vs. "Review Uncommitted Changes", "Review PR / MR" (you review a
diff), plus "Review Session Summary". Rule: agent-direction verbs start with
**Ask \<Agent\> to…**; human-direction start with **Open …** (Open
Uncommitted Changes, Open PR Review). "Review Changes Since Last Pass" →
"Ask \<Agent\> to Review What Changed".

**2.5 Four names for one surface.** Webview title "Comments"; command "Open
Inline Comments View"; README "the review view"; Explorer tree
"Markdown Review". Pick **Review view** everywhere (command: "Open Review
View"; webview heading "Review"; tree "Review threads").

**2.6 Three nouns for the markup.** "marker" (README, skill.md), "anchor"
("Repair Comment Anchors"), "comment" ("Reveal Markdown Comment").
Standardise: *anchor* = the markup, *thread* = the review object, *comment* =
one message in a thread.

## P3 — Sidebar polish (from the GIF frames and `client.ts`/`client.css`)

**3.1 Toolbar has no hierarchy.** Four filter radios wrap onto two lines
with the primary **Send to Claude** button crammed beside "New from Claude".
Below it "Suggest: off" (reads as status, is a toggle) sits at equal weight
with **Remove all** / **Remove 1 resolved** (destructive). **Copy** next to
Send is ambiguous and duplicates the clipboard send mode.
Proposal: row 1 = filter segmented control; row 2 = **Send to \<Agent\> ▾**
(dropdown: apply edits / propose suggestions / copy prompt) as the only
primary button, a labelled switch for suggest mode, and an overflow **…**
menu holding Remove resolved, Remove all review data, Collapse all.

**3.2 Every card carries five equal buttons and an open reply box.**
`↗ · → Claude · Copy · Resolve · Delete` per thread, plus a "Reply…"
textarea always rendered (`client.ts:1633,1651-1676`). README promises
"no cap; thirty things, thirty threads" — that is thirty textareas. Keep
Resolve and Reply visible; collapse the textarea until Reply is clicked;
move ↗ (unlabelled), send-this-one, Copy and Delete into a per-card **…**.
Delete already two-click-confirms (`client.ts:1598-1612`) — good, keep.

**3.3 No loading state. [verified]** `webviewShell.ts:35,68` ships empty
`#preview` and `#threads-list`; `init` arrives async
(`inlineCommentsPanel.ts:902-924`). The panel flashes blank on every open.
A one-line skeleton ("Loading guide.md…") fixes it.

**3.4 Outline breakpoint is defeated by specificity. [verified]**
`client.css:41-43 #app.with-outline` (0,1,1) beats
`client.css:578-581 @media (max-width:900px) #app` (0,1,0). With the outline
on, a narrow split keeps three columns and clips the preview.
`outline.spec.ts` only runs at 1400×700. Add `#app.with-outline` to the
media rule; add a 700px case to the spec.

**3.5 Keyboard hint line is permanent.** "n / p to move between threads · r
reply · e resolve · o open in editor" is always shown. Show it until the
user has pressed one of those keys, then fold into a `?` affordance.

**3.6 Theming gaps.** Highlight colours `--hl-open/--hl-resolved/--hl-flash`
are raw `rgba()` (`client.css:6-8`); two unthemed danger reds disagree with
`comments.css:18`'s `--mc-danger`; no high-contrast rules anywhere. Long
comment bodies have no `max-height` (`comments.css:83-88`).

**3.7 Reply / resolve exist only inside the webview.** Hover is read-only
(`presence.ts:214-219`), the CodeLens is one per file, and there are no
commands for reply/resolve/reopen, so no palette or keybinding path. The
in-webview `n/p/r/e/o` are a `keydown` listener (`client.ts:949-963`), not
keybindings, so users can't remap them. Low priority, but it's why the
webview is load-bearing for everything.

**3.8 Small ones.** "Reopen" (review view) vs "Unresolve" (live editor).
"Comment added to the file." toast after every keyboard comment — drop it or
make it a status-bar message. PR Review tree has no empty-state message
(`prReviewController.ts`; `uncommittedController.ts` has one).

## P4 — Subtract

**4.1 Live editor.** Frozen, "experimental", still registers a
`customEditor` for every `*.md` (shows in Open With…), owns a setting
(`collab.userName`), and is the only place the dirty-buffer race in 0.2 is
mitigated (`collabEditorProvider.ts:335-372`). Once 0.2 lands, remove it or
gate it behind a setting that defaults off.

**4.2 PR review is a silo.** Its comments never become threads
(`pr/types.ts`), so they miss Next Unread, the session summary, and the
review tree; "resolved" there is read-only platform state. Seven commands, a
tree and a webview for a feature that doesn't join the loop. Either make PR
comments land as ordinary threads on the checked-out file, or label the
feature *preview* and stop expanding it.

**4.3 Dead anchor code.** `src/anchor.ts`, `collab/anchorExtractor.ts`,
`collab/anchorLocator.ts` have no production importers; only their tests
reference them. Delete with the tests.

**4.4 `Connect an Agent` has no inverse.** No disconnect/unregister for any
of the five clients; Cursor CLI and Codex entries persist until hand-edited.
Add **Disconnect Agent…** or at least document the manual removal.

## What to keep exactly as it is

- Destructive confirms with counts, what survives, and "one undo step"
  (`commands/comments.ts:48-53,162-166`).
- The integrity guard never rewrites unasked; `Repair` re-verifies prose is
  byte-identical before applying (`integrity.ts`).
- `mdc check --repair` diagnoses and fixes a dropped closer precisely.
- MCP writes through `WorkspaceEdit`; the server is loopback-only,
  constant-time token, Origin-rejecting.
- One rendered source for the skill, plugin `SKILL.md`, headless preamble,
  and MCP instructions — verified byte-identical.
- The suggestion card (diff, note, Accept / Reject) and the empty-state
  copy with the keyboard fallback.
- Status bar states are observations, not guesses; the ten-minute
  "nothing arrived" fallback.

## Test gaps worth closing with the fixes

| Flow | Today | Add |
|---|---|---|
| CLI arg validation | none | 0.1 and 0.5 repros, both front ends |
| Dirty buffer + agent write | none | integration: dirty editor, `mdc reply`, assert no conflict prompt after 0.2 |
| Reopen | never exercised | e2e click on a resolved card |
| Outline at narrow width | 1400×700 only | 700px case |
| `opFinalize` on gnarly fixtures | none | run against `roundtripCorpus` inputs |
| Real formatter | hand-rolled reflow only | Prettier over a fixture, assert markers survive |

## Questions for Ronica

1. **Claude-first or agent-neutral?** P1 assumes neutral copy with Claude as
   the polished default. The cheaper alternative is to say "Claude Code
   first; other agents get the MCP tools and drive themselves" and stop
   claiming parity. Either is defensible; the current half-and-half is not.
2. **Does `mdc` become a client of the running extension (0.2)?** It means
   `mdc` behaves differently inside a VS Code terminal than outside. I think
   that's right, but it's a contract change for the plugin.
3. **Keep PR review?** (4.2)
4. **Remove the live editor?** (4.1)
5. **Keep "no cap" on review threads?** Thirty threads with thirty open
   reply boxes is the current experience. If yes, the sidebar needs grouping
   (by section, or agent-assigned severity) before that promise is kind.

---

## Status — implemented in 0.35.12 (2026-09-28)

Every numbered item above landed, with these deviations:

- **0.1** Integrity keys the new issue on an empty quote, not a zero-width
  anchor: the round-trip corpus deliberately allows a zero-width point anchor
  whose quote is intact. The document the bug produced has an empty quote,
  so it is caught. The issue is a warning and not repairable.
- **0.2** No fallback after a `tools/call` that got no answer — the write
  may have landed. A file outside the extension's workspace falls back to a
  direct write, since a VS Code terminal must still be able to edit files
  the window doesn't own. `--author` rides as the session's client name,
  normalised by `agentSlugFromClientName`.
- **0.6** Only an agent's reply reopens a resolved thread; a human's note on
  a closed thread is theirs to make. Both surfaces return `reopened`.
- **1.3** The opener names both paths unconditionally ("… or, if you are not
  Claude Code, the MCP tools or the `mdc` CLI —") rather than being
  parameterised, because the prompt is built before the target is known.
  The webview's Send button and pending-state text still say Claude; the
  host does not send the panel a target-agent name yet.
- **2.1** Gated on `markdownCollab.workspaceHasGit`, set by the uncommitted
  controller, plus `visibility: collapsed`.
- **2.3** The folder-review command is hidden from the palette rather than
  taught to prompt for files.
- **3.7** Hover links only; `n`/`p`/`r`/`e`/`o` stay a webview listener.
- **4.1, 4.2 — reversed.** Both were gated/labelled, then undone the same
  day: Ronica uses the live editor and PR review more than anything else in
  the extension. The review inferred "edge feature" from code shape (frozen,
  separate data model) without asking. PR review is a review client for a
  colleague's Markdown, agent-free by design; the live editor is the editable
  surface, and the plan is to merge it with the review view, read-only by
  default. See `docs/10x-plan-6.md`.
- **4.3** Moved to `src/test/support/`, not deleted: six alignment tests use
  them as the reference locator.
- **Not done:** README GIFs still show the old toolbar (`npm run
  record:gifs`); `mc_reopen` / `mdc reopen` verbs (agents reopen by
  replying); a Disconnect for the "Other agent…" path has nothing to remove.
