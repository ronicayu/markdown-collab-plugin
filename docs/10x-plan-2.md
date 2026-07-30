# Markdown Collab — 10x Plan, Round 2

**Audience:** Opus 5, acting as implementing engineer. Each initiative has motivation, design direction, key files, and acceptance criteria. Work top-to-bottom within a tier; tiers are ordered by leverage. Round 1 (`docs/10x-plan.md`) is complete — read its "What NOT to do" section first; every rule there still stands.

**Product north star (unchanged):** one human + Claude collaborating on Markdown, all review state inline in the `.md` file. "Collab" means human ↔ AI, not multi-human.

**Context for the implementer:**
- v0.34.60, 884 unit tests (Vitest), 28 integration tests (`@vscode/test-electron`, green in CI under xvfb), headless Playwright harnesses used ad hoc for webview verification.
- Releases flow ONLY through `release.yml` (tag push). A non-`[skip-publish]` tag publishes PUBLICLY to VS Code Marketplace + Open VSX. Confirm with Ronica before any tag; use `[skip-publish]` for experimental cuts.
- The Claude skill is embedded in `src/skill.ts`, installed to `~/.claude/skills/vs-markdown-collab/`, fingerprinted with its helper scripts (`mdc.mjs`, `mdc-tail.mjs`, `mdc-channel.mjs`). The `mdc` CLI (`src/skillCli/mdc.ts`, esbuilt to `out/skill/mdc.mjs`) wraps the format engine so Claude never hand-edits markers.
- Everything Round 1 promised is real: suggestion mode (tracked changes with accept/reject), integrity guard + repair, golden corpus, one shared comment UI, converged embed pipeline, pending-reply tracking, multi-file review, send-mode auto-detection.

---

## The Round-2 thesis

Round 1 made the **data layer** trustworthy: the file can no longer silently lose a comment, and Claude's edits became reviewable. What it did not touch is the **communication layer**, which is still built on inference:

1. **Every transport is fire-and-forget.** Terminal mode pastes prose into a TTY and hopes. The extension learns that Claude did anything only by watching the file change, and learns that Claude did *nothing* only by a 10-minute timeout (`claudePending.ts` says so in its own comments: the timeout exists "because a dispatch can go unanswered forever"). There is no ack, no progress, no error path. The `mcp-channel` mode is one-way and keyed off an endpoint file that can outlive its server.
2. **Claude writes to disk behind the editor's back.** `mdc` fixed marker integrity, but its writes still bypass VS Code: they race unsaved editor buffers, they are invisible to undo, and the integrity guard checks them *after* the fact instead of refusing them *before*.
3. **Collaboration is episodic, not continuous.** Every review pass re-reads the whole document from scratch, re-raising things the human already triaged. Nothing carries project conventions between sessions. A thread whose anchored text was rewritten after Claude commented looks exactly like a live one.
4. **The last verification mile is manual.** The flows that keep needing "a dev-host pass" (accept/reject clicks, folder right-click, the live editor) are exactly the ones no CI job exercises — which is why the batch since 0.34.39 is still sitting unreleased.

The 10x version: **the extension becomes the MCP server Claude connects to, so every Claude action is a structured, acked, undoable operation instead of an inferred file change; reviews become incremental and convention-aware; and the click-level flows get CI coverage so releases stop waiting on manual passes.**

---

## P0 — The protocol move: the extension IS the MCP server

This is the round's structural centerpiece, the analogue of Round 1's `mdc` CLI. It inverts the current channel: today Claude's side spawns an MCP server (`mdc-channel.mjs`) and the extension pushes at it; after P0, the extension hosts the server and Claude calls tools on it.

### P0.1 Extension-hosted MCP server with `mdc`-shaped tools

**Problem.** The `mdc` CLI was the right fix for marker integrity, but it is still a separate process doing raw disk writes: it races dirty editor buffers, its writes are not undoable, versions can skew against the installed extension, and the extension only discovers what happened by watching the file.

**Design.** A streamable-HTTP MCP server hosted inside the extension process (localhost only, bearer token), exposing the same verbs the CLI has — because the format engine is already in-process:

```
mc_list        (file, --actionable)        → threads as JSON
mc_reply       (file, threadId, body)
mc_open        (file, quote, body, occurrence?)
mc_rewrite     (file, threadId, with)
mc_suggest     (file, threadId|quote, with, note?)
mc_check       (file)                      → integrity report
mc_status      (taskId?, note)             → progress beacon (see P0.2)
```

- **All writes go through `WorkspaceEdit`** — the same paths the panels already use (`inlineComments/mutations.ts` has the pure core). That makes every Claude action undoable with Cmd+Z, ordered against unsaved buffer state instead of racing it, and validated by the integrity machinery *before* it lands (reject the tool call with a machine-readable error instead of repairing after).
- **Registration:** write the server entry into the workspace's `.mcp.json` (`type: "http"`, url + token header) so Claude Code in the integrated terminal picks it up, and register a `McpServerDefinitionProvider` with VS Code's own `vscode.lm` API where available so other MCP clients see it too. Regenerate the token per session; never commit it — the entry must reference an env var or the existing `.markdown-collab/` (gitignored) descriptor, whichever Claude Code's config supports; verify against current Claude Code docs at implementation time. Ask before first writing `.mcp.json` into a workspace (it is a user-visible file), and remember the answer per workspace.
- **Fallbacks stay forever, and MCP is never the default.** The CLI, terminal paste, and clipboard modes keep working unchanged; `terminal` remains the default send mode. MCP can be unavailable or disabled on Claude's side (enterprise policy, `--strict-mcp-config`, user config), so `detectSendMode.ts` must not auto-select it — when the server is up and the workspace consented, *offer* `mcp` in the picker with a one-line explanation; use it only after the human explicitly picks it, remember the choice like any manual selection, and degrade to terminal with a clear toast when a connection fails. Machines where Claude runs outside this VS Code window (ssh, another editor) still need the CLI path.
- Key files: new `src/mcpServer/` (server, tool handlers, token/registration), `src/transports/detectSendMode.ts`, `src/skillCli/mdc.ts` (share handler cores — the tool handlers and CLI commands must call the same functions, not parallel implementations), `src/extension.ts` (lifecycle: start on activation of a consenting workspace, dispose cleanly, port collision handling).

**Acceptance:**
- With the server running, a full loop — send thread → Claude replies via `mc_reply` → suggestion via `mc_suggest` → human accepts — never touches the file except through `WorkspaceEdit`, and Cmd+Z undoes Claude's reply in the editor.
- A tool call that would corrupt integrity (bad thread id, quote not found, marker-splitting span) is rejected with a structured error; the file is untouched; `mdc check` agrees.
- Kill the extension host mid-session → Claude's next tool call fails with a clear error, and the CLI fallback path still completes the same operation.
- Unit tests for every tool handler (they are pure once `WorkspaceEdit` is injected); an integration test drives the real HTTP surface against a real workspace.

### P0.2 Real lifecycle signals replace inference

**Problem.** "Claude is working…" (P1.2 of Round 1) is honest guessing: marked at dispatch, cleared by observing a reply, expired by timer. With a live protocol the guessing can stop.

**Design.** The MCP surface gives the tracker facts:
- Server connection + first tool call on a dispatched task → confirmed "Claude is working" (upgrade the indicator from "sent" to "active", show which file/thread the last tool call touched).
- An explicit `mc_status` beacon lets the skill report phase ("reading 2/3 files", "opening threads") — surfaced in the pending row and the status bar.
- Completion becomes the skill's final `mc_check` per file (the skill already ends every pass with a check) — clear pending on it rather than on reply-shaped file diffs.
- Timeout stays as the fallback for non-MCP transports; `claudePending.ts` gains an `evidence: "inferred" | "protocol"` dimension rather than a rewrite. Views render the same row either way — richer text when evidence is protocol-grade.

**Acceptance:** in MCP mode, the indicator appears on dispatch, names the phase while Claude works, and clears the moment the final check lands — no timer involved; unplug the server mid-task and the indicator degrades to the inferred path instead of lying. Tracker stays pure and fully unit-tested.

### P0.3 Skill v3: thin orchestration over tools

**Problem.** `src/skill.ts` is 1011 lines because prose instructions carry integrity rules the tools now enforce. Every line of skill prose is a line Claude can misread.

**Design.** Restructure (not rewrite) the skill: when MCP tools are present, phases become "call `mc_list`, decide, call `mc_reply`/`mc_suggest`, finish with `mc_check`" — the marker-surgery lore moves to a clearly-marked fallback appendix used only when tools are absent. Keep Review Mode's never-cap rule and focus-directive handling verbatim. The fingerprint machinery (P3.4 of Round 1) already covers skill+helpers; bump it. Guard with the existing skill fingerprint tests plus a new one: the tools-first path must not mention Edit-tool marker surgery outside the fallback appendix.

**Acceptance:** skill text for the happy path fits in ~⅓ of today's; corpus runs driven through the MCP tools (simulate the calls) produce zero integrity violations; fallback appendix still passes the existing corpus when exercised via CLI.

---

## P1 — Continuous collaboration (episodic → ongoing)

### P1.1 Diff-aware re-review

**Problem.** Asking for a second review re-sends the whole document; Claude re-reads everything and tends to re-raise points the human already resolved or dismissed. Real review work is iterative — pass N+1 should cost proportional to what changed.

**Design.**
- Record a per-file review checkpoint inline (no sidecar): one region-level record, e.g. `<!--mc:rev {ts, contentHash, gitRef?}-->` in the threads region, written when a review pass completes. Extend `format.ts` + corpus; the record is invisible in rendering like the rest.
- "Ask Claude to Review" gains a third entry point: **Review changes since last pass** (and "…since git ref" when the file is tracked). The payload includes only changed regions plus minimal context, an explicit instruction to skip unchanged prose, and the list of existing thread ids so Claude cross-references instead of duplicating ("this was raised in a1b2c").
- Resolved threads are prior art: the prompt states that a concern the human resolved is settled unless the new text reintroduces it.
- Key files: `src/multiFileReview.ts` / `src/sendToClaude.ts` (payload), `src/inlineComments/format.ts` (record), `src/skill.ts` (delta-review section), diffing can be plain line-diff over the stripped prose (`proseMapping.ts` already strips markers).

**Acceptance:** review a 3-section doc, resolve the threads, edit one section, run delta review → prompt size scales with the edit, Claude opens threads only about the changed section, and no resolved concern is re-raised verbatim. Corpus gains checkpoint round-trip cases.

### P1.2 Standing conventions: the focus that persists

**Problem.** Every review starts from zero. Terminology, tone, style rules, and "we know, don't flag it" exceptions must be re-typed into the focus prompt each time or Claude re-litigates them forever.

**Design.** A conventions doc at `.markdown-collab/conventions.md` — plain Markdown the human owns (bullet lists: terminology, tone, standing focuses, known-issues-to-ignore). Every review payload appends it under a `Conventions:` header; the skill treats it as a standing focus directive layered under the per-run focus. A scaffold command (`Markdown Collab: Edit Review Conventions`) creates it with a commented template and opens it. When a human dismisses a thread with a reply like "we always write it this way", the skill suggests (never writes) a conventions line. Cap what's sent at a sane size (~4 KB) with a truncation warning, since it rides along on every dispatch.

**Acceptance:** with a conventions file saying "the product name is always 'Markdown Collab', never 'the plugin'", a general review flags a violation without any focus prompt; delete the file and the payload contains no Conventions block. Unit tests on payload assembly; skill fingerprint bumped.

### P1.3 Stale-thread detection

**Problem.** A thread anchored on text that was rewritten after the last comment looks identical to a live thread. Humans triage against comments that may no longer apply; delta review (P1.1) can't tell either.

**Design.** Store a short hash of the anchored span's text on each thread (new optional JSON field, inline, backwards-compatible — absent means unknown). The parser already re-reads spans on every pass, so comparison is nearly free. Surface as a subtle per-card badge — "text changed since this comment" — in all three surfaces via the shared `commentUi.ts` card, with a one-click "show what changed" (old text lives nowhere, so show the current span highlighted and let the comment's quote field carry the old context — quotes are already stored). Update the hash whenever a new comment lands on the thread (the author saw the current text). Delta review payloads mark stale threads so Claude re-evaluates them first.

**Acceptance:** comment on a sentence, rewrite the sentence, badge appears in inline view and live editor; reply to the thread, badge clears. Corpus cases for hash round-trip; no schema break on files written by older versions (884 existing tests stay green).

---

## P2 — The last verification mile

### P2.1 Click-level CI for the flows that keep demanding manual passes

**Problem.** The recurring release gate is always the same list: accept/reject clicks, the panel's Send button, the folder right-click, the live editor. Logic under all of them is tested; the click itself never is. Manual dev-host passes don't scale and are currently blocking a public release.

**Design.** Two moves, in order of expected payoff:
1. **Promote the ad-hoc Playwright harnesses into CI.** The inline-view harness (extract webview HTML, stub `acquireVsCodeApi`, drive in Chromium) already found real bugs; turn it into scripted `@playwright/test` specs run headless in CI: render fixtures → click Accept → assert the exact mutation message posted to the host. The host side of that message is already contract-tested (`mutations.ts`), so message-equality closes the loop end to end.
2. **Give the live editor the same treatment.** Milkdown wouldn't run in the earlier JSDOM-ish setup, but it runs in real Chromium; build a browser harness page that boots the actual live-editor bundle with a stubbed host, and cover: suggestion card accept, comment composer, pending row render, externalChange application. This deletes the standing "verified by construction, not observation" caveat.
3. Only if a flow genuinely can't be reached this way (explorer right-click menus), fall back to `vscode-extension-tester` for a minimal smoke spec — evaluate cost first; do not build a big Selenium suite.

**Acceptance:** CI gains a `webview-e2e` job; the named flows (accept, reject, send, toggle suggest mode, live-editor accept) each have a spec that fails when its handler wiring is cut; total job time under ~3 minutes.

### P2.2 Release confidence: pre-release channel + ship the backlog

**Problem.** Twenty-one versions of work (0.34.40–0.34.60) exist only as GitHub pre-releases; dogfooding requires manual `.vsix` installs, and the marketplace build ages while the gap to it grows — which itself makes releasing feel riskier.

**Design.**
- Wire the Marketplace **pre-release channel** into `release.yml`: a tag flavor (e.g. `v0.35.0-pre.1` or a `[pre-release]` marker) publishes with `vsce publish --pre-release`, so dogfood builds auto-update through VS Code itself. This publishes publicly — it ships only with Ronica's explicit go-ahead, like any tag; the initiative is the *pipeline*, the first use is her call.
- Add a release-readiness checklist the pipeline enforces where it can (CHANGELOG rollup section exists, `verify-package.mjs` green, integration + webview-e2e green) and prints where it can't (the manual-pass list, now shrunk by P2.1).
- Then propose the batched stable release of everything since 0.34.39 as its own confirmed act.

**Acceptance:** one experimental tag produces a marketplace pre-release users can opt into (after confirmation); the checklist runs in CI; the stable rollup ships when Ronica says go.

---

## P3 — Reach and polish

- **P3.1 First-run walkthrough + playground.** A `contributes.walkthroughs` tour (install skill → add a comment → send → review a suggestion) plus a `Markdown Collab: Open Tutorial` command that generates a sandbox doc pre-seeded with threads and pending suggestions — the accept/reject loop is clickable in the first minute, no Claude session required. With P0.1, setup steps collapse further (server auto-registers).
- **P3.2 Review session summary.** After a pass, a command builds a human-readable digest from thread state alone (opened/resolved/accepted/rejected, per file, with quotes) into a scratch doc for PR descriptions or notes. Pure function over parsed threads; no Claude round-trip.
- **P3.3 Suggestion ergonomics.** Edit-before-accept (open the proposed text in the composer, apply the edited version through the same engine path) and an accept-all-in-file toolbar action with a two-step confirm (the shared `confirm` affordance from Round 1 exists for exactly this).
- **P3.4 Listing polish.** README restructured around the loop (comment → send → suggestion → accept), three short GIFs (inline view, live editor, review mode) recorded from the P3.1 playground, marketplace description/categories/badges refreshed. GIFs are assets in the repo, referenced from README; keep the `.vsix` lean (exclude via `.vscodeignore`).

---

## Sequencing and dependencies

```
P0.1 MCP server ──▶ P0.2 lifecycle signals ──▶ P0.3 skill v3
    │
    └──▶ (P3.1 setup collapse benefits)
P1.1 delta review ──▶ needs P1.3's staleness signal for best results; build P1.3 first
P1.2 conventions — independent
P2.1 webview CI — independent; START EARLY, it de-risks everything else's UI work
P2.2 pre-release channel — after P2.1 gives it teeth
P3.x — after their dependencies, opportunistically
```

Recommended order: **P2.1 → P0.1 → P0.2 → P0.3 → P1.3 → P1.1 → P1.2 → P2.2 → P3.x**. P2.1 goes first deliberately: it converts the manual-pass debt that already exists, and every later initiative's UI lands with click coverage from day one.

Each initiative lands as its own version with a CHANGELOG entry, `[skip-publish]` until Ronica says otherwise. Verify current Claude Code MCP registration specifics (`.mcp.json` http servers, header/env token passing) against live docs before building P0.1 — the mechanism moves; the design above states intent, not gospel.

## What NOT to do

- Everything in Round 1's list still holds: no multi-human/relay/cloud sync, no thread-count caps, no sidecar state, no format-engine rewrites, no unconfirmed tags.
- Do not make MCP required — and do not make it the **default** either. MCP may be disabled entirely on Claude's side; `terminal` stays the default send mode, MCP is opt-in via the picker. Terminal, clipboard, and the `mdc` CLI are permanent fallbacks — the skill must keep working for a Claude session that can't reach the server.
- Do not bind the MCP server to anything but localhost, ship a fixed token, or commit a token to the workspace.
- Do not let the conventions file become config sprawl — it is prose for Claude, not a settings schema.
- Do not build a broad Selenium/e2e pyramid. P2.1 is a targeted harness for the named flows, not a UI-testing platform.
- Do not auto-write `.mcp.json` (or any user-visible file) without asking once per workspace.
