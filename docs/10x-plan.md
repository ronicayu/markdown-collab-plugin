# Markdown Collab — 10x Improvement Plan

**Audience:** Opus 4.8, acting as implementing engineer. Each initiative below is scoped to be actionable: motivation, design direction, key files, and acceptance criteria. Work top-to-bottom within a priority tier; tiers are ordered by leverage.

**Product north star (unchanged):** one human + Claude collaborating on Markdown, with all review state living inline in the `.md` file. "Collab" means human ↔ AI, not multi-human. Do not reintroduce multi-user sync.

**Context for the implementer:**
- ~24k LOC TypeScript, 515 unit tests. v0.34.33.
- Releases flow ONLY through `release.yml` (tag push → CI → publishes PUBLICLY to VS Code Marketplace + Open VSX). Never build/release manually. A tag is an outward-facing act — confirm with Ronica before tagging.
- The Claude skill is embedded as string constants in `src/skill.ts` and installed to `~/.claude/skills/vs-markdown-collab/`. It is the contract between the extension and Claude.
- The four chronic failure classes, per CHANGELOG analysis across 126 versions: **anchoring/markers (24 entries)**, **live-editor sync (27)**, **image/diagram rendering (21)**, **table handling (10)**. This plan attacks the causes, not the symptoms.

---

## The 10x thesis

Today the plugin works, but every pillar rests on a fragile base:

1. **Comment integrity depends on an LLM following prose instructions.** A single dropped `-->` orphans a thread. The skill repeats the marker-preservation warning three times — a tell that it fails in practice.
2. **Claude's edits are irreversible and unreviewed.** Claude edits the doc in place; the human's only recourse is git. For a *review* tool, that inverts the trust model.
3. **Three webviews, two markdown renderers** (markdown-it vs Milkdown) guarantee divergent rendering bugs forever.
4. **Test coverage is inverted from risk**: the pure modules are well-tested; the churned webview/host glue has almost none.

The 10x version: **the round-trip becomes structurally incapable of losing a comment, Claude's edits become reviewable suggestions, and the rendering/UI stack collapses to one implementation.** Everything else compounds from there.

---

## P0 — Structural integrity (kills the top failure class) — ✅ LANDED

*Status: complete as of v0.34.41–0.34.43 (2026-07-25). The corpus found two
real engine bugs on its first run — anchoring inside a code span silently
produced a broken thread, and add/remove cycles appended a blank line to the
document every time. Both fixed in 0.34.41.*

### P0.1 `mdc` CLI: structured mutations instead of trusting Claude with raw markers — ✅ v0.34.42

**Problem.** The skill asks Claude to hand-edit `<!--mc:a:ID-->` markers and `<!--mc:t {JSON}-->` lines with Edit-tool string surgery. This is the single most common way the workflow breaks (the skill says so itself). All the marker-integrity risk lives in the model's diligence.

**Design.** Ship a small CLI alongside the existing helpers (`mdc-tail.mjs`, `mdc-channel.mjs`) — call it `mdc.mjs` — that wraps the already-battle-tested format engine so Claude never touches markers directly:

```
node mdc.mjs reply <file> <threadId> --body "…"        # append a claude comment
node mdc.mjs list <file> [--actionable]                # threads as JSON (id, quote, status, comments)
node mdc.mjs rewrite <file> <threadId> --with "new text"  # replace the anchored span, markers preserved
node mdc.mjs open <file> --quote "text to anchor" --body "…" [--occurrence N]  # Review Mode: open a thread
node mdc.mjs check <file>                              # integrity report: unpaired markers, orphans, JSON errors
```

- Reuse `src/inlineComments/format.ts` (parse/serialize, code-masking, `safeStringify`) as the engine. The CLI must be dependency-free ESM like the other helpers, so either extract the format module into a shared build artifact bundled at skill-install time (preferred: esbuild it to `out/skill/mdc.mjs` and embed via the same install path in `src/skill.ts`), or generate it from the same source at compile time. Do not fork the parser.
- **Prose edits stay with Claude's normal tools** — `mdc rewrite` is only for edits *inside* an anchored span, where marker surgery is riskiest. For general prose edits, `mdc check` becomes the post-edit verification step.
- Rewrite the skill (in `src/skill.ts`) so Phases 1/3/5/7 route through the CLI: discover via `mdc list`, reply via `mdc reply`, anchored-span edits via `mdc rewrite`, open threads via `mdc open`, verify via `mdc check`. Keep manual-edit instructions as a documented fallback for environments where the helper isn't installed.
- Keep the never-cap rule: Review Mode has **no upper bound on thread count**. The command flow must keep accepting a free-form focus instruction.

**Acceptance:**
- Round-trip property test: for a corpus of gnarly docs (tables, code fences containing fake markers, frontmatter, emoji, nested lists), any sequence of CLI ops yields a file where `parse()` reports zero unanchored/broken threads.
- Skill updated + fingerprint bumped so the update nag fires.
- `mdc check` exits non-zero on integrity violations, with machine-readable JSON output.

### P0.2 Anchor integrity guard in the extension (defense in depth) — ✅ v0.34.43

**Problem.** Even with the CLI, Claude (or the human, or another tool) can still corrupt markers via raw edits. Today corruption is discovered lazily, as an "unanchored" badge, often after the context needed for recovery is gone.

**Design.** Add a validation-and-repair pass that runs in the extension whenever a watched `.md` changes on disk (the file watcher in `src/reviewView.ts` and the external-change path in `src/collab/collabEditorProvider.ts` already see these events):

- Detect: unpaired markers, thread JSON that references missing anchors, anchors referencing missing threads, malformed `<!--mc:t …-->` JSON.
- Auto-repair what is safe: the existing `recoverUnanchoredByQuote` (unique-quote match) plus the 4-tier re-anchorer in `src/collab/inlineBridge.ts`, applied at watch time rather than only inside the live editor. Log every repair.
- Surface what isn't: a single non-modal warning with a "Show damaged threads" action into the Inline Comments view, immediately — not on next open.

**Acceptance:** deliberately corrupt a marker with a raw text edit; within the watcher debounce the thread is either repaired (quote unique) or flagged, and no repair ever modifies prose content — markers/threads-block only.

*As shipped (v0.34.43), with one deliberate deviation:* the guard **reports
and offers** repair rather than auto-writing it. `repairIntegrity` is
prose-safe by construction, but a review tool that silently rewrites the file
under review spends the trust it exists to build. Damage is surfaced
immediately (the stated goal); the write stays a human decision, one click
away, and lands through a `WorkspaceEdit` so it is undoable.

### P0.3 Golden round-trip corpus + regression harness — ✅ v0.34.41

**Problem.** The four chronic failure classes (tables, short selections, duplicate values, emoji, code-fence false markers, frontmatter) each got fixed one CHANGELOG entry at a time. Nothing prevents regressions across the *combination* space.

**Design.** A fixture corpus (`src/test/fixtures/roundtrip/`) of real-world-shaped documents, each with a script of operations (comment on table cell with duplicate value, edit inside anchored span, delete anchored text + undo, reflow table padding…). One Vitest suite drives every operation through both the format engine and the inlineBridge, asserting: no thread lost, no marker orphaned, no prose mutated except as requested. Add every future anchoring bug here first (test-first) before fixing.

**Acceptance:** suite covers at least the failure modes named in CHANGELOG 0.34.23–0.34.31; runs in `npm test`.

---

## P1 — The 10x product move: reviewable AI edits

### P1.1 Suggestion mode (tracked changes) — ◑ PART 1 + INLINE UI LANDED (v0.34.48–0.34.49)

*Landed: `<!--mc:s ...-->` storage + accept/reject transforms (format.ts),
integrity, `mdc suggest/accept/reject` CLI, skill Suggest Mode section, corpus
cases (v0.34.48); and the graphical accept/reject UI in the INLINE comments view
— shared `buildSuggestionCard` (affix-aware inline diff), preview highlight of
the original, host accept/reject via the panel's WorkspaceEdit path (v0.34.49),
all verified headlessly. Remaining: (b) the same suggestion rendering in the
live editor (host write path needs a dev-host pass, like P2.2), and (c) the
'propose as suggestions' send-mode toggle on Send-to-Claude. The full
suggest→review→accept/reject loop already works today via the inline view (ask
Claude to suggest, or `mdc suggest`) — the toggle is a convenience over asking.*

**Problem.** The tool's premise is *review*, but Claude's own edits are the one thing that can't be reviewed in it. Claude rewrites the file; the human sees "Updated from disk" and must trust it or read a git diff elsewhere. This is the inverted trust model, and fixing it is the single biggest product upgrade available.

**Design.** A per-request mode where Claude's edits land as **pending suggestions** the human accepts/rejects per hunk, Google-Docs style:

- **Storage:** same inline philosophy — a suggestion is a thread variant: `<!--mc:s {JSON}-->` carrying `{threadId?, anchorId, original, proposed, note}`. Anchored with the same paired-marker scheme, parsed by the same format engine (extend `src/inlineComments/format.ts`; the code-mask and `safeStringify` machinery carry over). The file stays valid renderable Markdown showing the *original* text; suggestions are invisible in any other renderer — consistent with the existing no-sidecar principle.
- **Authoring:** `mdc suggest <file> <threadId|--quote …> --with "new text" --note "why"` (extends P0.1). The skill gains a "Suggest Mode" section: when the send payload says suggest, Claude never edits prose directly — every change goes through `mdc suggest`.
- **UI:** in the Inline Comments view and the live editor, a suggestion renders as an inline diff (original struck through, proposed highlighted) with Accept / Reject / Accept-all-in-thread. Accept = apply proposed text via the format engine (marker-safe); Reject = drop the suggestion, thread stays open for discussion. Both existing comment-card surfaces share `src/webviewShared/commentUi.ts` — build the suggestion card there once (see P2.1).
- **Flow integration:** "Send to Claude" gets a toggle (default off, remembered per workspace like sendMode): *Apply edits directly* vs *Propose as suggestions*. "Ask Claude to Review" stays comment-only (review mode already never edits prose).

**Acceptance:** full loop works end-to-end in the Extension Development Host: human comments → send in suggest mode → Claude proposes → human accepts one, rejects one → file content and thread state correct, zero orphaned markers. Corpus tests from P0.3 extended with suggestion ops.

### P1.2 Claude presence in the live editor

**Problem.** The live editor's "co-editing" is invisible: Claude's edits appear as an unexplained flash + toast. The collaboration doesn't *feel* live, which undercuts the headline feature.

**Design.** Cheap, high-perceived-value affordances on the existing externalChange push path (`collabEditorProvider.ts` already diffs old vs new content):

- Compute changed regions of each disk-side update and decorate them in the editor for a few seconds ("Claude edited this") with a distinct highlight, plus a gutter pip that fades.
- A one-line status strip: "Claude edited §Heading · 12s ago", clickable to scroll there.
- While a send-to-Claude round-trip is in flight (the extension knows: it dispatched the payload and hasn't seen the reply land in the threads block), show a subtle "Claude is working…" indicator on the affected thread cards.

Explicitly **not** cursor-level streaming presence — no relay exists and none should be added.

**Acceptance:** Claude edits the file mid-session → changed spans flash and the status strip names the nearest heading; indicator clears when the thread reply arrives.

### P1.3 Multi-file review sessions

**Problem.** "Ask Claude to Review" is per-file, but real doc work is a `docs/` folder or a PR's worth of files. The cross-file TreeView (`src/reviewView.ts`) already aggregates threads; only the initiation is single-file.

**Design.** Extend the command: when invoked on a folder (explorer context) or with multi-select, build one Review Mode payload listing all files (respecting the existing 50 KB-per-file soft confirm, summed). The skill's Review Mode already handles "read end-to-end, open threads per concern" — instruct it to process files in order and to include cross-document consistency as a default review dimension (terminology drift, contradictory claims between files). The summary row in the sidebar ("N new from Claude") already aggregates; verify it counts across files in the Markdown Review tree.

**Acceptance:** right-click a folder with 3 `.md` files → one focus prompt → Claude opens threads across all three → tree view shows per-file counts and Next-unread walks across files.

---

## P2 — Consolidation (halts the churn treadmill)

### P2.1 One comment UI, shared by all three surfaces — ◑ MOSTLY LANDED (v0.34.47)

*The live editor now renders its comment cards + composers from the shared
commentUi.ts (buildCommentCard/buildComposer), matching inline + PR; added a
shared two-step `confirm` action option. Remaining minor item: ship
comments.css via one shared bundle step instead of three copyFileSyncs.*

**Problem.** The live editor reimplements comment cards inside its 1927-line `src/webview/client.ts`; inline + PR share `src/webviewShared/commentUi.ts` but the live editor doesn't. Every card feature ships 2–3 times (CHANGELOG: repeated "comment-panel parity" entries).

**Design.** Move the live editor's comment panel onto `commentUi.ts` (`buildComposer`/`buildCommentCard`), extending the shared module where the live editor has extra affordances (per-thread send, always-on reply box). Ship `comments.css` once via a shared bundle step instead of three `copyFileSync`s. This is a refactor with screenshot-diff verification, not a redesign — and it's a prerequisite for building P1.1's suggestion card once.

**Acceptance:** all three webviews render cards from the shared module; `rg 'buildCommentCard|composer' src/webview/client.ts` shows usage, not reimplementation; visual parity confirmed in the dev host.

### P2.2 Delete the dead CRDT layer — ✅ LANDED (v0.34.44 + v0.34.46)

*Part 1 (network layer) shipped in v0.34.44: server.ts, seedEncoding.ts,
computeRoom, room/serverUrl, ws/y-websocket/@types/ws/y-codemirror.next.
Part 2 (local Yjs) shipped in v0.34.46 after a manual live-editor pass:
applyExternalChange rewritten to parserCtx doc-replace; @milkdown/plugin-collab,
yjs, y-protocols, y-prosemirror removed. Undo is prosemirror-history. ~700 lines
of source + 8 dependencies gone total; ~110 KB off the webview bundle.*

**Problem.** The multi-peer relay was walked back in 0.34.6/0.34.7 but the machinery remains: `src/collab/server.ts` (265 lines, imported only by its tests), `seedEncoding.ts`, `computeRoom()`, `room`/`serverUrl` in `InitPayload`, `y-websocket`/`ws` in dependencies, and Yjs awareness wiring for a single local peer. It's bundle weight, conceptual overhead, and a standing invitation to confusion.

**Design.** Remove `server.ts`, `seedEncoding.ts`, room/serverUrl plumbing, `collabServer.test.ts`, `seedEncoding.test.ts`, and the `ws`/`y-websocket` dependencies. Keep Yjs itself **only if** `@milkdown/plugin-collab` remains the cheapest way to drive the editor's document model — evaluate: if the editor works as a plain Milkdown instance with the same undo behavior, drop `plugin-collab`, `yjs`, `y-protocols`, `y-prosemirror`, `y-codemirror.next` too and measure the webview bundle delta. If Yjs must stay for undo/mapping semantics, keep it local-only and delete just the network layer.

**Acceptance:** compile + full test suite green; live editor manual pass (edit, undo, comment, Claude external change) unaffected; report bundle-size before/after in the PR description.

### P2.3 Converge the two markdown pipelines where they can converge

**Problem.** markdown-it (inline + PR) vs Milkdown/ProseMirror (live editor) will never render identically — this drove 21 image/diagram CHANGELOG entries. Full unification is not realistic (the live editor needs ProseMirror), but the *asset-resolution and embedded-diagram* layer can be one implementation.

**Design.** Extract a single shared module for: image `src` resolution (the `..`-aware resolver from 0.34.31 — already partially shared in `webviewShared/imageSrc.ts`, extend to PR view), mermaid, PlantUML (`src/plantumlPlugin.ts`), and drawio handling (currently the inline panel reaches into `CollabEditorProvider.runDrawioRead` — invert this into a shared service both consume). Add a fixture-driven test: one document exercising every embed type, rendered through both pipelines, asserting both produce a resolvable URL/SVG for each asset.

**Acceptance:** the shared-embeds test passes; PR view renders `../sibling.png` and PlantUML identically to the inline view.

### P2.4 Test the fragile layer

**Problem.** The churned code (three webview clients, `collabEditorProvider.ts`, `inlineCommentsPanel.ts`, `prReviewController.ts`) has near-zero coverage; the CHANGELOG's regression history maps 1:1 onto it.

**Design.** Don't chase full webview E2E. Three pragmatic moves:
1. **Extract-and-test:** pull pure logic out of the webview clients (selection→anchor computation, thread-list state, unread/summary counting) into importable modules covered by Vitest — the codebase already does this well elsewhere; finish the job for the clients.
2. **Message-protocol contract tests:** each host↔webview pair speaks a postMessage protocol; snapshot the message schemas and test host handlers (`inlineCommentsPanel.applyMutation` etc.) against recorded message fixtures using the existing `vscode-stub.ts`.
3. **Grow the `@vscode/test-electron` integration suite** with the top 5 historical regressions (comment on table cell, edit inside anchored span, undo-orphan, external change during edit, send-mode dispatch).

**Acceptance:** coverage report shows the extracted modules tested; the 5 named integration scenarios pass in CI.

---

## P3 — Polish and reach

- **P3.1 Zero-friction send-mode onboarding.** Auto-detect at first click: MCP channel reachable → offer `mcp-channel`; a `claude` REPL visible in a terminal → default `terminal`, no quick-pick at all (one toast: "Sent to your Claude terminal — change in settings"). Reduce the decision the README currently needs a comparison table for.
- **P3.2 Performance headroom.** Fix the known O(n)-per-keystroke costs before large docs hurt: binary search in `inlineCommentsPanel.findProseIndex` (the code even invites it), incremental thread-block reserialization (only the threads region changes on comment ops — stop rewriting the whole file via full-document `WorkspaceEdit`), and virtualize the thread list past ~100 cards. Add a 500 KB fixture to the corpus with timing assertions.
- **P3.3 Docs hygiene.** `docs/v1.1-plan.md`, `docs/COLLAB-EXPERIMENT.md`, `docs/preview-anchor-fix-plan.md` describe a dead sidecar/preview-panel architecture — move to `docs/archive/` with a one-line disclaimer each. Keep `v2-claude-initiated-reviews-plan.md` (shipped, still accurate rationale). Make this file the live roadmap; update it as initiatives land.
- **P3.4 Skill self-update.** The skill install is manual + nag-driven. On activation, if the installed fingerprint is stale, offer one-click reinstall (already close to existing `checkClaudeSkill` logic); with P0.1 the skill and CLI must version together, so the fingerprint should cover the helper scripts too.

---

## Sequencing and dependencies

```
P0.1 mdc CLI ──────────┬──▶ P1.1 Suggestion mode (needs mdc + shared card)
P0.2 integrity guard   │
P0.3 corpus ───────────┘        P2.1 shared comment UI ──▶ P1.1
P2.2 CRDT deletion — DONE (v0.34.44 network layer, v0.34.46 local Yjs)
P2.3 render convergence (independent)
P2.4 tests (start with P0.3, grow alongside every P1/P2 change)
P1.2, P1.3, P3.x — independent, schedule opportunistically
```

Recommended order: **P0.3 → P0.1 → P0.2 → P2.2 → P2.1 → P1.1 → P1.2 → P2.3 → P1.3 → P2.4 (continuous) → P3.x**.

**Progress:** P0.3, P0.1, P0.2 landed (v0.34.41–0.34.43). Next up is P2.2
(delete the dead CRDT layer) — it is a deletion whose acceptance criteria
require a manual live-editor pass in the Extension Development Host, so it
needs a human in the loop before it can be called done.

Each initiative should land as its own version with a CHANGELOG entry, following the existing release discipline (`[skip-publish]` trial commits, tag only after Ronica confirms — tags publish publicly).

## What NOT to do

- Do not add multi-human collaboration, network relays, or cloud sync — explicitly out of scope for this product.
- Do not cap Review Mode thread counts or remove the focus-instruction prompt.
- Do not introduce a sidecar file for any new state (suggestions included) — inline-in-the-`.md` is the product's identity.
- Do not rewrite the format engine or the 4-tier re-anchorer from scratch — they encode 126 versions of hard-won edge cases. Wrap, extend, and test them.
- Do not tag/release without explicit confirmation.
