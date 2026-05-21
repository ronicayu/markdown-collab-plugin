# v2 — Claude-Initiated Reviews — Plan

**Status:** draft, awaiting review
**Target version:** 0.29.0
**Author:** PM + UX review session, 2026-05-15

## Goal

Let the human ask Claude to act as a reviewer on a Markdown doc. Claude reads the doc, leaves review threads on whatever it finds, and the human triages from the existing sidebar UI. The human can optionally tell Claude what to focus on.

This is "human + AI collaboration" extended to its natural shape: today the human initiates threads and Claude replies. v2 lets Claude initiate too, on explicit request.

## Non-goals (v2)

- Multi-human collaboration / author attribution across humans.
- A `severity` or `category` field on thread JSON.
- Claude reviewing its own past reviews (recursive critique).
- Cross-file batch review (one doc at a time; cross-file overview is a separate v1.1 effort).
- Autonomous / unprompted review — Claude only reviews on explicit human request.

## What's already built (substrate)

The `vs-markdown-collab` skill (`~/.claude/skills/vs-markdown-collab/SKILL.md`) already implements thread creation mechanics under **Phase 5 — Initiate a new thread**:

- Anchor passage selection (8-char minimum, code-fence avoidance, marker-safe location).
- 5-char base36 id allocation with collision retry.
- Paired `<!--mc:a:ID-->…<!--mc:/a:ID-->` marker insertion via Edit tool.
- Single-line `<!--mc:t {…}-->` JSON append into the `<!--mc:threads:begin-->`…`<!--mc:threads:end-->` region (creating the region if absent).
- `c1` comment with `author: "claude"`, ISO-8601 timestamp, body.
- Verify pass after creation.

Phase 5 is currently gated to explicit human request only (skill line 92 + Phase 6 invariant line 135). v2 keeps the gate — it only adds a new trigger pathway ("review this doc") and the critique rubric Claude uses when reviewing.

**Implication:** no storage format changes, no marker scheme changes, no transport changes. v2 is a skill update + a new VS Code command + a sidebar affordance.

## Design constraints (from product review)

1. **The command must accept a free-form focus instruction from the human.** Example focuses: *"check API examples for correctness," "find marketing-y tone," "look for contradictions with the architecture doc."* The command must not ship as a no-arg trigger.

2. **Do NOT cap the number of threads Claude can leave.** No 3–8 limit, no soft cap, no top-N curation. If Claude has 30 substantive concerns it leaves 30 threads. The human triages with sidebar UI. Volume problems are solved in the UI, not by gagging Claude.

3. **Claude does not edit prose in review mode — only opens threads.** Even obvious typos open a thread unless the human said "fix as you go." Preserves the human gate.

4. **Naming stays "Markdown Collab."** "Collab" = human + AI collab, which is exactly what v2 delivers.

## User flow (target)

1. Human opens a `.md` doc in VS Code.
2. Human runs `Markdown Collab: Ask Claude to Review This Doc` (command palette or right-click → action).
3. An InputBox prompts: *"What should Claude look for? (optional — leave blank for a general review)"* with one example placeholder.
4. Human types a focus directive (or hits Enter / Escape for general).
5. Extension builds a payload via the existing send pipeline (terminal / channel / mcp-channel / clipboard).
6. Claude triggers the `vs-markdown-collab` skill in Review Mode, reads the doc, opens one thread per substantive concern matching the focus.
7. Threads appear in the inline-comments sidebar. Sidebar header shows *"N new from Claude — 0 reviewed."* Each unread thread carries a small badge.
8. Human triages: reply, resolve, or ignore each thread.

## Work breakdown

### Chunk 1 — Skill: Review Mode workflow

**File:** `~/.claude/skills/vs-markdown-collab/SKILL.md`

Add a new section after Phase 5, before "Sidecar mode reference":

- **Trigger phrases.** *"review this doc," "leave your thoughts on X," "do a review pass on Y," "second pair of eyes on README"* — appended to the skill `description` so it auto-triggers.
- **What warrants a thread.** Factual error, unclear claim, missing context, broken example, contradictory section, structural issue, anything matching the focus directive if one was given.
- **What does NOT warrant a thread by default.** Pure typos, style preferences, nits — unless the focus directive explicitly asks for them.
- **Focus directive handling.** If the human's prompt includes a `Focus:` line, it becomes the primary filter for what counts as a concern. Without one, Claude does a general review against the rubric.
- **Anchor sizing.** Smallest passage that makes the comment make sense. Prefer one sentence over a paragraph. Avoid anchoring whole sections.
- **Specificity rule.** Every thread body must name the concern concretely. *"This could be clearer"* without saying *what* is bad. *"The claim that X implies Y skips the intermediate step Z"* is good.
- **Reuse Phase 5 mechanics.** Cross-reference, don't duplicate, the id allocation / marker insertion / JSON append / verify steps.
- **No upper bound on thread count.** Explicit instruction: *"there is no maximum. Leave a thread for every substantive concern that fits the focus directive. The human triages."*
- **Don't edit prose in Review Mode.** Even obvious typos open a thread unless the human said "fix as you go."
- **Honest empty result.** If no concerns match the focus, reply with a single message (not via a thread) saying so. Don't fabricate threads to feel productive.

Update Phase 6 invariant at line 135 to clarify Review Mode = explicit ask.

Also update the `description` field (the trigger string) to include the new review-mode phrases.

**No code changes. Skill installer rerun will redeploy.**

**Effort:** 1–2h

**Risk:** the rubric is the spec; without calibration examples (Chunk 3) different model versions may behave differently. Mitigated by Chunk 3 landing soon after.

### Chunk 2 — Extension: new command `markdownCollab.askClaudeToReview`

**Files:**
- `src/extension.ts` — register command near existing registrations (~line 287).
- `src/sendToClaude.ts` — new `buildReviewRequestPayload(doc, focus?)` builder.
- `package.json` — contribute the command + add to context menus.

**`buildReviewRequestPayload` signature:**

```ts
buildReviewRequestPayload(
  doc: vscode.TextDocument,
  focus: string | undefined,
  output: vscode.OutputChannel,
): Promise<{ kind: "ok"; payload: ReviewPayload } | { kind: "no-workspace" }>
```

Prompt template (no count limits):

```
Use the vs-markdown-collab skill in review mode on `<rel>`.
{focus ? `Focus: ${focus}` : ""}
Open a review thread for every substantive concern. Do not edit prose.
```

The `ReviewPayload` shape is unchanged. `comments` is empty (this is a request, not an existing-comments digest). `unresolvedCount` becomes `0`. Transports already tolerate this; double-check `terminal.ts` and `channel.ts` don't depend on a non-empty `comments`.

**Command handler in `extension.ts`:**

1. Get active doc; reject if not Markdown or outside workspace with a clear toast.
2. Show `vscode.window.showInputBox`:
   - `prompt`: *"What should Claude look for? (optional)"*
   - `placeHolder`: *"e.g. check API examples for correctness"*
   - `ignoreFocusOut: true`
3. If user hits Escape → cancel silently.
4. Optional: keep the last 5 used focus directives in `globalState` and offer them via a quick-pick "Use a recent focus…" entry above the InputBox. Adds ~30 min, real-world ergonomic win. **Decision pending — see Open decisions.**
5. Soft size check: if doc > 50KB, confirm before sending ("This is a large file — Claude's review may take a while. Continue?"). One-line guardrail, not a hard limit.
6. Build payload via the new builder.
7. Reuse the existing `invokeSendAllToClaude` pipeline (`extension.ts:560`) — same delivery, same send-mode resolution, same telemetry-shaped output channel.

**`package.json`:**

- Add `commands` entry: `markdownCollab.askClaudeToReview` with title `"Markdown Collab: Ask Claude to Review This Doc"`.
- Add to `editor/context` and `explorer/context` menus alongside the existing Inline Comments View entry, gated on `resourceExtname == .md`.

**Effort:** 2.5–3.5h with the recent-focus history; 2h without.

**Risk:** large files. Mitigated by the soft size check.

### Chunk 3 — Skill: critique-quality calibration

**File:** `~/.claude/skills/vs-markdown-collab/SKILL.md`

Inside the Review Mode section, add a "good vs bad threads" block with 4–6 worked examples:

- **Good:** anchoring a single ambiguous sentence with a specific question.
- **Good:** pointing out a factual error with the correction in the body.
- **Good:** flagging a contradiction between two sections, anchoring the second.
- **Bad:** *"this could be clearer"* with no specifics.
- **Bad:** anchoring a whole paragraph because *"the whole section needs work."*
- **Bad:** leaving a thread that just restates the anchored text.

**Why separate from Chunk 1:** the rubric is the spec; examples are the calibration. Land Chunk 1+2 first, watch real output for a few days, then write examples that target the actual failure modes. Premature examples calcify the wrong patterns.

**Effort:** 1h.

### Chunk 4 — UI: unread-from-Claude affordance

**Files:** `src/inlineComments/*` (webview + provider), `src/previewPanel.ts`, `src/reviewView.ts`.

Derived flag per thread, computed from existing JSON (no schema change):

```
unreadByHuman = thread.comments[0].author === "claude"
              && !thread.comments.some(c => c.author !== "claude" && !c.deleted)
              && thread.status === "open"
```

**MVP affordances (in v2 PR #1 because uncapped thread counts make this load-bearing):**

- **Sidebar header summary:** *"N new from Claude — M reviewed."* Click → jump to next unread.
- **Collapse-all unread Claude threads** button. Without this, a 30-thread review is an unreadable scroll wall.

**Deferred (later PR):**

- Per-thread dot/badge.
- Filter sidebar by "only show unread from Claude."
- Filter by focus directive (would require persisting the focus on threads — schema change, deferred).

**Effort:** 3–4h for MVP affordances.

### Chunk 5 — Empty-doc flow

**Files:** `src/extension.ts`, `SKILL.md`.

When the human asks Claude to review a doc with **zero** existing threads:

- Skill creates a fresh `<!--mc:threads:begin-->`/`<!--mc:threads:end-->` region as part of inserting `c1` for each thread (Phase 5 already covers this).
- Extension shows a one-line toast on send: *"Claude is reviewing — threads will appear when it's done."*
- After the round-trip lands, refresh the inline view and scroll to the first new thread.

**Effort:** 1h.

### Chunk 6 — Docs + changelog + version bump

**Files:** `README.md`, `CHANGELOG.md`, `package.json`.

- README: new subsection under "How to use, day to day" called **"Asking Claude to review"** — 3–4 lines, one screenshot, examples of focus directives.
- README hero: consider adding a sentence about Claude being able to initiate reviews too. Reinforces the "human + AI collab" positioning.
- CHANGELOG: `0.29.0 — <date>` entry with the three user-visible changes (command, sidebar summary + collapse-all, skill Review Mode).
- Version: bump to `0.29.0` in `package.json`.

**Effort:** 1h.

## Sequencing & PRs

**Hard dependencies:**
- Chunk 2 depends on Chunk 1 (the prompt references a skill mode that must exist).
- Chunk 5 depends on Chunks 1+2 (it's the empty-doc subset of the same flow).
- Chunk 4 (MVP affordances) depends on threads from Claude existing — so on 1+2+5.
- Chunk 6 lands with whichever PR ships user-visible behavior.

**No dependency on:**
- Chunk 3 (calibration) can ship any time after Chunk 1.

**Suggested PRs:**

- **PR #1 — v2 MVP:** Chunks 1 + 2 + 4 (MVP affordances) + 5 + 6. One PR because skill, extension, and UI are tightly coupled; you want to dogfood the full loop end-to-end before splitting work.
- **PR #2 — Calibration:** Chunk 3. Lands a week after PR #1 once real-world failure modes are observable.
- **PR #3 — UI polish (optional):** dot/badge, filter, etc.

**MVP effort estimate:** ~1 day (assuming familiarity with the codebase).
**Full v2 with calibration + polish:** ~2 days.

## Open decisions

1. **Recent-focus history.** Persist last 5 focus directives in `globalState` and surface via quick-pick? +30 min, real-world ergonomic win. **Recommendation: ship it in PR #1.**
2. **Focus directive max length.** Cap at 500 chars? Multi-paragraph focus is rare and webview promotion can come later. **Recommendation: cap at 500 in the InputBox `validateInput` hook.**
3. **What if the focus directive contradicts the doc** (e.g. "find security issues" on a recipe blog)? Skill stays honest — replies "no concerns matching that focus" instead of fabricating threads. **Recommendation: one line in the skill explicitly allows this.**
4. **Right-click menu vs palette-only.** Add to `editor/context` and `explorer/context`, or palette-only for the first release? Right-click is the discoverable path; users will look there. **Recommendation: both menus + palette.**
5. **Should the soft 50KB confirm be configurable?** A `markdownCollab.askClaude.largeDocWarnKB` setting feels like premature config. **Recommendation: hardcode 50KB for v2; revisit if real users hit it.**

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Claude leaves 50+ low-quality threads | Medium | High UX hit | Specificity rule in skill + Chunk 3 calibration |
| Different model versions interpret rubric differently | Medium | Medium | Chunk 3 worked examples, tuned to observed failures |
| Large docs (>50KB) hit context limits | Medium | Medium | Soft size confirm + skill instruction to chunk if needed |
| Human can't find the new command | Low | Medium | Right-click menu entry + README update |
| Empty-result case looks like a bug | Medium | Low | Skill replies explicitly via the send channel; toast acknowledges |
| Focus directive injection (prompt injection from the .md itself) | Low | Low | Doc contents are already trusted in existing flows; no new boundary |

## Definition of done — PR #1

- [ ] Skill installed via `Install Claude Skill` includes Review Mode section.
- [ ] `Markdown Collab: Ask Claude to Review This Doc` appears in command palette and right-click menus for `.md` files.
- [ ] Running the command on a doc with no threads creates the threads region and Claude leaves one or more threads.
- [ ] Running the command on a doc with existing threads adds new threads without disturbing existing ones.
- [ ] Sidebar header shows "N new from Claude — M reviewed" on any doc with Claude-initiated unread threads.
- [ ] Collapse-all-unread button works.
- [ ] Focus directive is included in the prompt when provided; absent line when not.
- [ ] CHANGELOG + README updated, version bumped to 0.29.0.
- [ ] Manual smoke test passed in Extension Development Host on at least one real `.md` file.
