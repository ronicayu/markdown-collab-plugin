# Markdown Collab — 10x Plan, Round 3: the UX round

> **Progress:** P0 is complete — P0.1 + P0.3 in v0.34.74, P0.2 in v0.34.75.
> P1, P2, P3 remain.

**Audience:** Opus 5, acting as implementing engineer. Each initiative has motivation, design direction, key files, and acceptance criteria. Work top-to-bottom within a tier; tiers are ordered by leverage. Rounds 1 and 2 are complete — their "What NOT to do" rules all still stand, plus the ones at the end of this file.

**Product north star (unchanged):** one human + Claude collaborating on Markdown, all review state inline in the `.md` file. "Collab" means human ↔ AI, not multi-human.

**Context for the implementer:**
- v0.34.69, 1108 unit tests (Vitest), 37 integration tests, 24 webview e2e specs (Playwright, real Chromium). All green.
- Releases flow ONLY through `release.yml` (tag push). A non-`[skip-publish]` tag publishes PUBLICLY. Land each initiative as its own `[skip-publish]` version with a CHANGELOG entry, as in rounds 1–2.
- The review verbs live once in `src/inlineComments/docOps.ts`, shared by the `mdc` CLI and the MCP tools. Guard tests forbid front ends from calling the format engine's mutators directly. Nothing in this round changes that layer.

---

## The Round-3 review: where the UX actually is

Rounds 1–2 built the right machine. Round 1 made the **data layer** trustworthy (the file can't silently lose a comment); Round 2 made the **communication layer** real (tool calls instead of inference, undoable edits, incremental reviews). What neither round touched is how a person *finds and operates* any of it.

The honest audit:

**What's genuinely good.**
- The core loop in the inline comments view is complete and careful: chunked rendering for 300-thread passes, reply text that survives re-renders, two-click destructive actions with auto-disarm, find-in-preview, filters, collapse state that survives reloads, auto-scroll to Claude's first new finding.
- Onboarding has a real floor now: the walkthrough, the playground doc built by the real format engine, the once-per-version skill nudge.
- Send-mode auto-detection means many users never see the picker at all.

**Where it is expert-shaped.** Every capability exists — as a command palette entry you must already know the name of.

1. **The product is invisible from the surfaces people actually inhabit.** There are no contributed keybindings (`package.json` has no `keybindings` section at all), no editor-title icon (only `editor/title/context` — the tab's right-click menu, which nobody opens), and nothing in the raw text editor. The built-in Markdown preview earns its usage with one always-visible title-bar icon; this extension's equivalent surface is `Cmd-Shift-P` + typing "inline".
2. **The raw `.md` editor — where Markdown authors actually live — shows the format at its worst.** Open a reviewed file in the plain text editor and you see `<!--mc:a:x7k2p-->` marker soup and a wall of thread JSON at the bottom. No decorations, no folding, no hovers, no gutter marks, no CodeLens (verified: zero `setDecorations`/`FoldingRangeProvider`/`CodeLens` references in `src/`). The inline format is the product's core virtue, and its first impression on a collaborator is "something corrupted my file."
3. **You cannot comment without the webview.** The only path to a new thread is: open the inline view, select rendered text with the mouse, click the floating button. A keyboard-driven author with the source file open has no path at all.
4. **"Next Unread from Claude" dumps you in the wrong surface.** `extension.ts` (`invokeNextUnreadFromClaude`) opens the *raw text editor* with a selection — marker soup — when the thing being read is a thread, whose home is the review view. The walk's destination contradicts the product's own model.
5. **"Ask Claude to Review" goes silent for minutes.** Review-request payloads deliberately mark no pending threads (`markPayloadPending` no-ops on empty `comments`), and the status bar only shows protocol-backed waits. So in terminal mode — the default — the user gets one toast ("threads will appear when it's done") and then *nothing* until threads land. No spinner, no elapsed time, no way to tell "Claude is thinking" from "the paste never arrived."
6. **The send-mode picker is a jargon cliff.** Five modes; descriptions include "bracketed paste", "`mdc-tail.mjs` in a background bash + Monitor", and "requires Claude Code v2.1.80+ and a one-time `.mcp.json` setup". Two of the five are for a rare harness setup, yet they sit at the same rank as the one ~everyone should pick. This is the single scariest moment of the first session.

The 10x version: **the product becomes legible from the surfaces the user already occupies — the text editor, the title bar, the keyboard — instead of requiring them to come find it; and every wait has a visible pulse.**

---

## P0 — Meet the user in the raw text editor

The highest-leverage tier. Markdown authors live in the source view; today the extension is at best absent there and at worst actively ugly.

### P0.1 Markers stop looking like corruption ✅ *(v0.34.74)*

**Problem.** Anchors and the threads block are exposed plumbing in the text editor. A collaborator without the extension sees noise (acceptable — HTML comments are the format's deal); a collaborator *with* the extension sees the same noise (not acceptable — the extension knows exactly what every marker means and says nothing).

**Design.**
- A `TextEditorDecorationType` pass over visible Markdown editors: render anchor markers (`<!--mc:a:ID-->`, `<!--mc:/a:ID-->`) at near-zero visual weight (fold to a thin colored bracket or dim to ~30% opacity via `opacity`/`letterSpacing` decoration tricks — pick what actually reads well, and prefer the approach that keeps click-to-position sane), and tint the anchored span itself with a faint background matching the webview highlight color. Resolved threads get the fainter tint.
- A `FoldingRangeProvider` for the `<!--mc:threads:begin-->` … `<!--mc:threads:end-->` region, folded by default on open (fold via the provider + a one-time `editor.fold` nudge when a doc with a threads block becomes visible; never re-fold a region the user opened).
- A `HoverProvider` over anchored spans: author, age, body of the latest comment, and command links — "Open in review view", "Reply", "Resolve".
- Decorations must be cheap: reuse the existing parse (`parseInline`) on the document version already flowing through the panels; never re-parse per scroll event. Gate everything on files that actually contain `mc:` markers.

**Key files:** new `src/editorPresence/decorations.ts`, `src/editorPresence/foldingProvider.ts`, `src/editorPresence/hoverProvider.ts`; `src/extension.ts` (registration); reuse `src/inlineComments/format.ts` parse output.

**Acceptance:** integration test asserts decorations are applied to a fixture with threads and not to a clean file; folding provider unit-tested on the golden corpus; hover content unit-tested; a guard test asserts the decoration pass never mutates the document. e2e not required (decorations aren't in the webview), but the integration suite must cover open → decorate → edit → re-decorate.

### P0.2 Comment from anywhere: selection → thread, no webview ✅ *(v0.34.75)*

**Problem.** Creating a thread requires the inline view and a mouse. The format engine can already anchor to any prose offset; only the UI path is missing.

**Design.**
- New command `markdownCollab.commentOnSelection` ("Markdown Collab: Comment on Selection"): takes the active text editor's selection in a `.md` file, maps source offsets → prose offsets (the mapping exists — `proseMapping.ts`), rejects selections inside markers/code with a clear message, then collects the body via `showInputBox` (single line is fine for v1; `ignoreFocusOut: true`) and writes the thread through the same docOps path the panels use.
- Contribute it to `editor/context` for Markdown and give it a keybinding (see P1.2).
- After creation: toast with "Open review view" button; if an inline view for the doc is already open it updates automatically (existing push machinery).

**Key files:** `src/extension.ts`, `src/inlineComments/docOps.ts` (should need no changes — that's the point), `src/inlineComments/proseMapping.ts`.

**Acceptance:** integration test: select prose in a fixture, invoke command programmatically with a stubbed input box, assert the thread lands with the right quote and the buffer is dirty-safe (WorkspaceEdit, undoable — assert `undo` removes it, or the source-level guard from round 2 if undo won't deliver headless). Unit tests for the selection→prose edge cases (selection touching a marker, inside code, empty).

### P0.3 Threads land where threads live ✅ *(v0.34.74)*

**Problem.** `invokeNextUnreadFromClaude` opens the raw source; the review tree's `revealComment` opens the raw source and doesn't even scroll ("Opening the doc is enough"). Both walks end on marker soup.

**Design.**
- Both commands route to the inline comments view: open (or reveal) the panel for the doc and scroll to the thread — the `scroll-to` message and anchor machinery already exist; add a `scroll-to-thread` message that also highlights the card (the highlight path exists as `highlightedThreadId`).
- Keep a modifier escape hatch: the status-bar count stays, and holding the walk in the source view is not a supported mode — the source view now has hovers (P0.1) for that.
- A `CodeLens` at the top of any Markdown file containing threads: "N comments, M unresolved — Open review view" (and "K unread from Claude" when nonzero). One lens, top of file only — not per-thread; per-thread presence is P0.1's job.

**Key files:** `src/extension.ts`, `src/reviewView.ts`, `src/inlineComments/inlineCommentsPanel.ts` (+ its webview client message handler), new `src/editorPresence/codeLens.ts`.

**Acceptance:** integration test: with a fixture containing a claude-unread thread, `nextUnreadFromClaude` results in the inline panel visible for that doc (assert via panel registry, not pixels); webview e2e: `scroll-to-thread` message highlights and scrolls to the card. CodeLens unit test on parse output; lens absent on clean files.

---

## P1 — One obvious button, and hands on the keyboard

### P1.1 The title-bar icon

**Problem.** The built-in preview's split-pane icon is the single most-used affordance in VS Code's Markdown story. This extension has no icon anywhere.

**Design.**
- Add `icon` to `markdownCollab.openInlineCommentsView` (`$(comment-discussion)`) and contribute it to `editor/title` (`group: "navigation"`, `when: resourceLangId == markdown` — mirror the built-in preview's `when` so the icons sit together). One icon only — the other commands stay in menus; a row of five icons is how extensions get uninstalled.
- The icon opens the view beside the editor (`ViewColumn.Beside`) if it isn't already open, else reveals it.

**Key files:** `package.json` (contributes), `src/extension.ts`, `src/inlineComments/inlineCommentsPanel.ts`.

**Acceptance:** guard test on `package.json` (icon present, one `editor/title` navigation entry, correct `when`); integration test for open-beside behavior.

### P1.2 Keybindings, contributed and in-webview

**Problem.** Zero contributed keybindings; inside the webview, only Cmd+F and Cmd/Ctrl+Enter exist. GitHub's review UI taught everyone `n`/`p`/`r`/`e`; none of it works here.

**Design.**
- Contributed (in `package.json`, all `when`-scoped to Markdown so they don't squat on global chords):
  - `cmd+k cmd+m` → open inline comments view (chord under the VS Code `cmd+k` namespace; low collision risk)
  - `cmd+k cmd+c` → comment on selection (P0.2)
  - `cmd+k cmd+n` → next unread from Claude
- In-webview (inline comments client, when focus is NOT in a textarea/input):
  - `n` / `p` — next / previous thread card (moves highlight + scrolls both panes; reuses the `claudeNext` scroll logic generalized to any filter)
  - `r` — focus the highlighted thread's reply box
  - `e` — resolve/reopen the highlighted thread
  - `a` — accept the first pending suggestion's… no. Accept stays a click; a single-key destructive-ish action with no target visible is a footgun. `a` does nothing.
- Document the keys in the walkthrough send step and in a `title` attribute on the relevant buttons.

**Key files:** `package.json`, `src/inlineComments/webview/client.ts`, `src/webviewShared/threadListState.ts` (next/prev pure helpers + tests).

**Acceptance:** guard test on the keybindings block (every entry `when`-scoped); unit tests for next/prev traversal across filters and collapsed cards; webview e2e: press `n`, assert highlight moved and card scrolled; press `r`, assert reply textarea focused; keys are inert while a textarea has focus.

---

## P2 — Every wait has a pulse

### P2.1 Review-pass progress that exists

**Problem.** Finding 5 above: "Ask Claude to Review" in terminal mode produces one toast and then silence until threads appear. The user cannot distinguish a thinking Claude from a failed paste.

**Design.**
- A review-pass pending record, parallel to `claudePending` but for passes rather than threads: created at dispatch (`dispatchReviewPayload`, `intent.kind === "review-request"`), keyed by folder+files, carrying dispatch time.
- Status bar (extend `claudeStatusBar.ts`): while a pass is pending, show `$(loading~spin) Claude is reviewing <file> · 1m 20s` for ALL evidence levels — this is precisely the wait the current "protocol-only" rule hides. The round-2 honesty rule bends but doesn't break: inferred passes say "Sent for review · 1m 20s" (a fact), protocol passes say what `mc_status` reports (also a fact). Neither claims "working" without evidence.
- The pass resolves when: new threads land in any of its files (the `pendingReviewSnapshot` machinery already detects exactly this in the webview — move the detection host-side so it works with no panel open), `mc_check`/`mc_status` closes it (protocol), or a 10-minute timeout expires — on timeout the item becomes `$(warning) Review sent 10m ago — nothing arrived` with a click action offering Resend / Dismiss.
- Clicking the running item reveals the target file's review view.

**Key files:** `src/claudePendingService.ts` or new `src/reviewPassPending.ts`, `src/claudeStatusBar.ts`, `src/extension.ts` (dispatch + resolution wiring), `src/inlineComments/claudeUnread.ts` (host-side new-thread detection).

**Acceptance:** unit tests for the status text at each evidence/phase/timeout state; integration test: dispatch a review request with a stubbed transport, write a claude thread into the file, assert the pending record resolves. Timeout path unit-tested with injected clock.

### P2.2 The picker leads with the answer

**Problem.** Finding 6: five equally-ranked modes, jargon descriptions, and the two harness modes crowding the one most people need. (Constraint, unchanged: every mode stays supported; MCP is never auto-selected.)

**Design.**
- Rank one: `Send to Claude terminal — recommended` with a plain-language description ("Types the prompt into your running Claude session. Works everywhere."). Rank two: clipboard. Then a separator (`kind: QuickPickItemKind.Separator`, label "Advanced") above `mcp` (when available), `channel`, `mcp-channel`, with descriptions rewritten for a person who has not read the README: say *when you'd want it*, not how it's implemented ("For a Claude session that watches a log file instead of receiving pastes").
- The settings-UI `enumDescriptions` get the same rewrite; implementation detail moves to the README.
- Detail row under the recommended item when no Claude terminal is detected: "No Claude terminal detected — you'll be offered to start one."

**Key files:** `src/extension.ts` (`pickSendMode`), `package.json` (enumDescriptions), README.

**Acceptance:** unit test on the picker item builder (extract it pure): order, separator position, mcp only when available; guard test that every mode in the settings enum appears in the picker builder (no orphan modes); wording asserted to not contain "bracketed paste"/"mdc-tail"/"Monitor" in the non-advanced items.

---

## P3 — Polish that compounds

### P3.1 Empty states that teach

The threads sidebar with zero threads shows one gray line. Replace with a small card: how to comment (select text → button, or the P0.2 keybinding), and — when the file has never been reviewed — an inline "Ask Claude to review this doc" button wired to the existing command. When the skill is missing, the existing warning banner already covers its ground; don't duplicate it. **Files:** `webviewShell.ts`, `client.ts`, `threadListState.ts` (`emptyListMessage` grows into a structured empty-state descriptor). **Acceptance:** e2e spec for both empty variants and for the review button posting the right message.

### P3.2 Reverse navigation: preview → source

The panels can scroll the preview to a prose offset, but a reviewer who spots a typo has no path back to the source line. Add "Open in editor" to the thread card's hover actions and a double-click… no — double-click selects text. A small `↗` icon button in the card header and an entry in the anchored-span hover (P0.1) that opens the text editor at the anchor's source position (`proseMapping` gives the offset; `revealRange` centered). **Files:** `client.ts`, `inlineCommentsPanel.ts`, `proseMapping.ts`. **Acceptance:** integration test asserts the editor opens with the selection on the anchored text; e2e asserts the button posts the message.

### P3.3 A11y pass on the review surfaces

The bones are decent (aria-labels on icon buttons, radios for filters, `role="switch"` on suggest mode). Close the gaps: `aria-live="polite"` on the pending row and the claude-summary line (state changes are currently silent to screen readers); `role="feed"`/`article` semantics on the thread list; visible focus rings on cards (keyboard nav from P1.2 makes this urgent); `prefers-reduced-motion` guard on every `scrollIntoView({behavior:"smooth"})` and the flash animation. **Files:** `client.css`, `client.ts`, `commentUi.ts`. **Acceptance:** e2e assertions on aria attributes; a guard test that every `behavior: "smooth"` call site goes through one shared `scrollTo` helper that respects reduced motion.

---

## Sequencing and dependencies

1. **P0.1 → P0.3 → P0.2** — decorations first (the hover surface P0.3 links into), then the navigation fixes, then the new-comment path.
2. **P1.1, P1.2** — independent of each other; P1.2's `cmd+k cmd+c` needs P0.2.
3. **P2.1, P2.2** — independent of everything above; can interleave.
4. **P3.x** — last; P3.2 reuses P0.1's hover, P3.3 hardens P1.2's keyboard nav.

Each initiative = one `[skip-publish]` version + CHANGELOG entry, as in rounds 1–2.

## What NOT to do

Everything in rounds 1–2 stands. Additionally:

- **Do not rewrite the webviews in a framework.** The vanilla-DOM clients are tested to the tooth (24 e2e specs); a React port would be a quarter of churn for zero user-visible gain.
- **Do not hide the markers so hard the format becomes deniable.** Dim, fold, decorate — but a user who wants to see exactly what's in their file must be able to (folding is reversible, decorations are toggleable via the standard decoration behavior). The format's honesty is a feature.
- **Do not add a sidebar view container / activity-bar icon.** The explorer views are enough chrome; a whole activity-bar entry for a review tool is self-importance, and the title-bar icon (P1.1) is the affordance that actually matters.
- **Do not grab global keybindings.** Everything `when`-scoped; nothing single-key outside the webview.
- **No toasts for progress.** P2.1 lives in the status bar; toasts are for outcomes and questions, and the extension already sends enough of them.
- **MCP stays opt-in; thread counts stay uncapped; state stays in the file.** (Standing rules — restated because P2 touches the picker and P0 touches parsing.)
