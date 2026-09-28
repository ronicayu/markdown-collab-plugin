# Markdown Collab — 10x Plan, Round 5: out of the lab

> **Status: DRAFT, 2026-09-28.** Written after Round 4 landed on `round-4`
> (v0.34.97–0.35.11). Nothing here is implemented. Several initiatives are
> Ronica's decisions or need machines this environment doesn't have; they are
> marked **(Ronica)**.

**Audience:** Opus 5.5 as implementing engineer, and Ronica for the decisions. Same shape as rounds 1–4: motivation, design direction, key files, acceptance. Work top-to-bottom; tiers are ordered by leverage. Every "What NOT to do" rule from rounds 1–4 still stands.

**Product north star (unchanged):** one human + an AI agent collaborating on Markdown, all review state inline in the `.md` file. The agent is usually Claude, but the product must not require it to be.

**Context for the implementer (verified 2026-09-28):**
- Branch `round-4`, v0.35.11, 19 commits ahead of `main`, pushed, no PR. 1866 unit tests green (9 s). 30.8k lines of source excluding tests; 39 commands, 8 settings, 3 tree views, 1 walkthrough.
- **Channels.** Marketplace stable is **0.34.80** (2026-08-20); pre-release is **0.34.87** (2026-09-04). Open VSX also serves 0.34.87. Everything from 0.34.88 to 0.35.11 exists only as GitHub releases, 24 versions in all.
- **Numbers.** Marketplace: 76 installs, 407 downloads, 4.45 rating. Open VSX: **9,654 downloads**. GitHub: 2 stars, 1 fork, 1 issue.
- `ci.yml` runs on `ubuntu-latest` only, and only on pushes to `main` and PRs against it. Round 4's commits have been tested by `release.yml` on each tag, never by CI. `release.yml` is also Ubuntu-only.
- `vsce` rewrites the README's relative image links to `github.com/ronicayu/markdown-collab-plugin/raw/HEAD/…`, and `HEAD` is `main`. `media/gifs/` does not exist on `main` (checked with `git ls-tree origin/main`).
- The agent CLIs installed on the dev machine are `claude` and `gemini`. `codex` and `cursor` are not installed, and there is no Windows machine.

---

## The Round-5 review: a finished product nobody has

Round 4 asked what stops a new user in their first minute, and removed it: headless runs, the plugin, Connect an Agent, agent identity. The machine is now very good at a first session. The audit below is about the fact that there are no first sessions.

1. **Nothing from Round 4 has shipped.** The last stable release is five weeks old, and the last pre-release is three weeks old. Every Round 4 feature has reached zero users, including the Marketplace page itself, which still describes send modes that no longer exist. `[skip-publish]` became the default because a tag without it publishes publicly. That keeps users safe, but it also switched off the feedback loop, and the loop is the only thing this product lacks.
2. **The one person who filed an issue can't get the fix.** Issue #1 asked for a Finalize button on 2026-08-06. It shipped in 0.34.88 on 2026-09-04 as *Remove All Review Data*. It is still open, and the reporter can't install the fix from any marketplace.
3. **Nobody uses it, including its author.** Across `~/projects`, the only document that ever carried a real review is honest-router's `docs/process/workflow-team-review.md`: 9 threads between ronica and claude, 8 resolved, last touched around 2026-06-10. Commit `0fff41b5` removed it from honest-router's `main`, and it survives only in 13 stale worktrees. No document anywhere is under review today. The threads blocks in this repo's README, SKILL.md and playground are examples. Rounds 3 and 4 were planned in Markdown and never reviewed with the product.
4. **The claims Round 4 couldn't verify are the ones that decide adoption.** From the 0.35.3 entry: *"Not yet tried against a real Cursor or Codex install."* Headless mode has never run on Windows, and CI never runs on Windows or macOS. These are unit-tested against documented formats, which is as far as this machine can take them.
5. **The audience may not be where the copy points.** Open VSX, which serves Cursor, Windsurf and VSCodium, shows 9,654 downloads against the Marketplace's 407. Downloads aren't installs, and Open VSX counts include mirrors and automated fetches, so this is a hypothesis, not a finding. But if it holds even partly, the least-verified path (Cursor) is the main one. Meanwhile the thread card's "→ Claude" button, the "Claude is working…" label, the walkthrough title, and 12 of 39 command titles all say Claude, whichever agent is connected.
6. **The weight is still there.** The live editor is frozen and labelled experimental, yet it is the largest cluster in the codebase: `collabEditorProvider.ts`, `webview/client.ts`, `inlineBridge.ts` and `anchorExtractor.ts` come to about 4,800 lines, plus a 4.6 MB bundle. Nobody, including its author, is known to use it.

**The 10x for this round isn't a feature. It's the first ten people who aren't Ronica, and Ronica using the product on work that isn't the product.** Every initiative below serves one of three verbs: **ship** (get Round 4 into both marketplaces), **prove** (run the paths nobody has run), and **use** (make dogfood a gate, not a hope). Subtraction comes last, and only on evidence.

---

## P0 — Ship

### P0.1 Merge `round-4` into `main`, with CI that covers three platforms

**Problem.** CI has never tested Round 4, and publishing from the current state would put broken GIFs on the Marketplace page, since they only exist off `main`.

**Design.**
- Open a PR from `round-4` into `main`, with the plan-4 status table as its body. Merging makes the GIFs resolve and gives Round 4 its first CI run.
- `ci.yml`: run unit and integration tests on a matrix of `ubuntu-latest`, `windows-latest` and `macos-latest`. The webview e2e job (Playwright) stays Ubuntu-only; it tests the webview, not the host. Integration tests need `xvfb` only on Linux; the existing step is conditioned on the OS.
- Trigger CI on pushes to every branch, not just `main`, so a round branch is tested as it's built.
- The headless integration test (`src/test/integration/suite/headless.test.ts`) already drives a stub `claude`. On `windows-latest` the stub has to go through `claudeBinary.ts`'s `.cmd` shim path (`spawnCommand` / `quoteForCmd`). Make the stub a `.cmd` wrapper on win32, so the path that real Windows users take is the one under test.
- `release.yml`: add a job that, before packaging, fails if any relative image path in `README.md` doesn't exist in the tagged tree. That's the class of bug vsce's `raw/HEAD` rewrite hides.

**Key files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `src/test/integration/suite/headless.test.ts` (and its stub), `scripts/release-checklist.mjs`.

**Acceptance:** the PR is green on all three OSes. The headless integration test runs on Windows through the `.cmd` shim (asserted by checking which spawn branch ran, not just that it passed). The README image check fails when run against a commit on `main` before the merge.

### P0.2 Release the backlog as a pre-release, then promote on evidence **(Ronica)**

**Problem.** See audit findings 1 and 2.

**Design.**
- After P0.1 merges, cut **0.35.12 as a public pre-release** on both marketplaces, with no `[skip-publish]`. It's the first tag in five weeks that reaches users. This is a publishing act, so it waits for Ronica's explicit go.
- Before tagging, run `scripts/release-checklist.mjs` plus a manual listing check. Open the Marketplace and Open VSX pages after publish and confirm the GIFs render, the README is the 0.35.10 rewrite, and the version matches on both.
- Reply on issue #1 with the release that carries *Remove All Review Data*, and close it.
- **Promotion to stable** happens after 14 days on pre-release with no regression report, **and** after P1.1's real-client passes for Claude and at least one other client. That promotion is a second confirmed act, not automatic.

**Acceptance:** 0.35.12 is visible as a pre-release on both marketplaces. Issue #1 is closed with a link. The date that starts the 14-day clock is recorded in the CHANGELOG.

### P0.3 A release cadence rule, so the gap can't reopen **(Ronica)**

**Problem.** Rounds 3 and 4 each ended with everything unreleased, because the safe default (`[skip-publish]`) needs no decision and releasing does.

**Design, proposed:** each initiative still lands as its own version and CHANGELOG entry. `[skip-publish]` stays allowed during a round, but **a round isn't done until its versions are on the pre-release channel.** `release-checklist.mjs` gains a check that reports the number of GitHub-only versions since the last published tag and fails the checklist above a threshold (proposed: 10). The threshold is a nag, not a gate on CI.

**Acceptance:** the check exists and is tested. Against today's tree it reports 24 and fails.

---

## P1 — Prove the paths nobody has run

### P1.1 A real-agent smoke suite, run locally per client

**Problem.** Every agent integration is tested against a stub or a documented format. What breaks in the field (a CLI flag renamed, a client that drops `instructions`, an auth prompt in a non-interactive run) is exactly what stubs can't catch.

**Design.**
- A new integration suite, `src/test/integration/realAgents/`, skipped unless `MC_REAL_AGENTS=1`. It never runs in CI, because it needs signed-in CLIs and spends money. For each agent CLI found on `PATH`, it opens the playground fixture in a real VS Code, starts the extension's MCP server, and drives one non-interactive review:
  - **claude**: through headless mode, end to end, exactly as a user would.
  - **gemini**: `gemini -p` with a `settings.json` that points at the server. This also answers Round 4's open point about whether Gemini can take the token from the environment. Decide from behavior; if it can, Gemini moves out of *Other* in Connect an Agent.
  - **codex**: `codex exec` with the project `.codex/config.toml` that Connect an Agent writes.
  - **cursor-agent**: with the `.cursor/mcp.json` that Connect an Agent writes.
- Each run asserts four things: threads landed through `WorkspaceEdit`, `mdc check` is clean, `author` is the agent's slug, and the run finished inside a budget (turns or time). The report (CLI version, pass/fail, cost where the CLI reports it) is appended to `docs/agent-compat.md`, a table the README links to as "tested with".
- Claude and Gemini can run on the dev machine today. **Codex and Cursor need installs and sign-ins, which is Ronica's call.**

**Key files:** new `src/test/integration/realAgents/`, new `docs/agent-compat.md`, `src/mcpServer/clients/`, `src/commands/setup.ts` (Gemini entry, if it graduates).

**Acceptance:** `MC_REAL_AGENTS=1 npm run test:integration` passes for `claude` and `gemini` on the dev machine, and `docs/agent-compat.md` has their rows. Codex and Cursor rows are either filled in or marked "not yet run" with a date; they aren't left out silently.

### P1.2 Cursor as a host, not just a client **(Ronica, needs Cursor installed)**

**Problem.** If the Open VSX numbers mean what they might, Cursor users are the audience, and Cursor has never loaded this extension.

**Design.** Install the 0.35.12 `.vsix` into Cursor and follow the README's three steps as a new user. The checklist, written into `docs/agent-compat.md`:
- Install from Open VSX inside Cursor, not just from the `.vsix`.
- The review view renders, including the webview CSP, mermaid, and the find bar.
- **Keybindings.** Cursor binds `Cmd+K` to its inline edit. Check whether the `Cmd+K Cmd+Alt+V/M/N` chords still fire, and if they don't, pick Cursor-safe alternatives with `when` clauses. Don't ship a conditional keymap unless the conflict is confirmed.
- Connect an Agent → *Cursor, in-app agent* registers through `vscode.cursor.mcp.registerServer`, and Cursor's agent can list and reply to threads.
- Headless mode with Claude Code installed alongside Cursor.
- Anything that fails becomes a fix in this round, and a CHANGELOG line that names the Cursor version tested.

**Acceptance:** a filled-in Cursor checklist with the Cursor version, and every failure either fixed or filed as an issue.

### P1.3 Windows, for real **(Ronica, or a Windows VM)**

P0.1 puts the headless machinery under test on `windows-latest` with a stub. One manual pass with real Claude Code on Windows closes the loop: install, Set Up Claude Code (plugin install from the local marketplace, since paths with a drive letter and backslashes are the risk), Review with Claude, and cancel mid-run (`SIGINT` has no Windows equivalent, so check what `HeadlessRun`'s cancel actually does to the process tree). Record the result in `docs/agent-compat.md`.

---

## P2 — Use it

### P2.1 Dogfood as a gate, on documents that aren't about the product **(Ronica)**

**Problem.** A product for reviewing Markdown with an agent, whose author reviews Markdown with an agent every day in chat instead, has a signal in that gap. This round finds out why.

**Design.**
- For the 14 days of the P0.2 pre-release window, every Markdown document Ronica asks an agent to review, across any project (honest-router process docs, personal-site posts, plans in this repo including this one), goes through the product: *Review with Claude* or *Send to Claude*, triaged in the file.
- A friction log at `docs/dogfood-log.md`, one line per moment they reached for chat instead, or the product got in the way: date, document, what happened, and what they did instead. The agent that implements this round reads the log at the start of each session.
- **This document is the first entry.** Before any of P1–P4 is implemented, run a headless review on `docs/10x-plan-5.md` and triage the threads in-file. The threads stay until the round is done, as the round's own evidence.

**Acceptance:** at least 3 real documents outside this repo each carry at least 5 triaged threads by the end of the window, and the friction log has entries. If both are empty, that's the finding: the round's next step is understanding why, not P3 or P4.

### P2.2 A feedback path that isn't telemetry

A **Send Feedback** entry in the review view's overflow menu and the palette opens a prefilled GitHub issue: extension version, VS Code or Cursor version, and send mode, from the same collection code as *Report a Problem*, with every field visible before submitting and nothing sent automatically. The `bugs.url` in `package.json` already points there. This adds one command and removes a step for the only feedback channel the product allows itself.

**Acceptance:** the prefilled URL is under GitHub's URL length limit (unit test), and it contains no path, no token, and no document content (guard test).

---

## P3 — Copy follows the agent (conditional)

**Condition:** start only if P1.2 confirms Cursor works as a host, or P2.2 or issues show non-Claude users. Without that evidence, Round 4's wording rule stands and this tier is skipped.

**Problem.** See audit finding 5. Round 4 made authorship agent-aware; the verbs are still Claude-only.

**Design.**
- A **workspace agent**, derived rather than configured: the agent slug of the last MCP client that called a tool in this workspace (already known from Round 4's P1.2 session attribution), falling back to Claude when the send mode is `headless` or `terminal` with a Claude terminal. It's stored in workspace state and exposed through `agentIdentity.ts`.
- Per-thread and webview copy reads from it: "→ Claude" becomes "→ {agent}", and "Claude is working…" becomes "{agent} is working…" (`commentUi.ts`, both webview clients, `threadListState.ts`).
- **Command titles are static in `package.json`.** The Claude-only ones keep their names (Set Up Claude Code, Start Claude Review Terminal, headless). Agent-neutral commands get neutral titles: *Send Unresolved Comments*, *Ask for a Review of This Doc*, *Next Unread Agent Comment*. This is a visible rename for existing users, so it's **Ronica's call**; the plan recommends it only if the condition above is met.

**Acceptance:** with a Codex session as the last tool caller, the thread card and the status bar say Codex. A Claude-only workspace renders exactly as before (snapshot test). A grep guard allows literal "Claude" in webview copy only inside Claude-only paths.

---

## P4 — Subtract, on evidence

### P4.1 Retire the live editor, or don't **(Ronica)**

**Evidence to gather in P2.1:** did Ronica open the live editor once in 14 days of real use, and did any feedback (P2.2, issues) mention it?

**If not, retire it over two releases**, the way channels were retired in Round 4. The first release hides the command, marks the editor deprecated in `customEditors.displayName`, and shows a one-time notice for anyone whose file is associated with it. The next release deletes `src/collab/`, `src/webview/client.ts`, their tests and the `collab.test.ts` integration suite, the `markdownCollab.collab.userName` setting, the bundle budget guard, and the Milkdown, mermaid-in-editor and mxgraph dependencies it alone uses. The expected result is about 4,800 fewer lines of source and a much smaller package. The inline view keeps mermaid, PlantUML and draw.io rendering. **If Ronica does use it**, the freeze stands and this item closes.

### P4.2 Fewer commands in the palette

39 commands is more than a new user can scan. Hide from the palette (`commandPalette` `when: false`), without deleting, the ones that are reachable from a better place:
- *Register Review Tools with Claude Code* is Connect an Agent → Claude Code.
- *Copy Claude Prompt* is the clipboard send mode.
- *Start Claude Review Terminal* is the terminal send mode's fallback.
- Any command with an identical toolbar or context-menu entry and no keyboard-only use.

Target: 30 or fewer palette-visible commands. Update the README commands table to list what the palette shows.

**Acceptance:** a guard test counts palette-visible commands against the target, and every hidden command is still reachable from the UI surface named in its test.

### P4.3 Housekeeping

- Drop `stash@{0}`. It's the `mdc check --hook` WIP, superseded by `src/skillCli/checkHook.ts`.
- Delete the four stale `.vsix` files at the repo root. They're untracked.
- Prune honest-router's 13 stale worktrees, which is honest-router's business. Mention it to Ronica; don't do it.

---

## Sequencing

```
P4.3 housekeeping ─ any time
P0.1 merge + CI matrix ─▶ P0.2 pre-release (Ronica: go) ─▶ 14-day window ─▶ stable (Ronica: go)
                                     │                        │
                                     ├─▶ P1.1 real-agent smoke (claude, gemini now; codex, cursor after installs)
                                     ├─▶ P1.2 Cursor pass ─┐
                                     ├─▶ P1.3 Windows pass │
                                     └─▶ P2.1 dogfood ─────┴─▶ evidence ─▶ P3 (if met) · P4.1 (decide)
P0.3 cadence rule, P2.2 feedback, P4.2 palette ─ independent, small
```

Recommended order: **P4.3 → P0.1 → P2.1's first step (review this plan in-file) → P0.3 → P2.2 → P0.2 → P1.1 → P1.2 / P1.3 / P2.1 (the window) → P4.2 → P3 and P4.1 on the evidence.** P2.2 lands before the pre-release so the first users who arrive have a way to say something.

## Open questions for Ronica

1. **Go for 0.35.12 as a public pre-release** once P0.1 is merged and green? That's the one act this whole round waits on.
2. **Cadence rule:** is a threshold of 10 unreleased versions the right nag, and is "a round isn't done until it's on pre-release" acceptable?
3. **Codex and Cursor installs** on the dev machine, for P1.1 and P1.2: yours to install and sign into, or skip and rely on reports?
4. **Dogfood window:** will you run 14 days of real reviews through the product, and keep the friction log? Without it, P3 and P4.1 have no evidence to act on.
5. **P3 rename,** if the condition is met: neutral command titles, or keep Claude in every title?

## What NOT to do

Everything in rounds 1–4 stands: no multi-human sync, no thread caps, no sidecars, no format-engine rewrites, no unconfirmed tags, no webview framework rewrite, no activity-bar container, no global keybindings, no toasts for progress, MCP never *required*, no `--bare` or skip-permissions headless, no tokens on disk, no Agent SDK, no forked skill, no telemetry. In addition:

- **Do not build new features this round** beyond what is listed. The backlog isn't the constraint; the lack of users is.
- **Do not tag anything without `[skip-publish]` without Ronica's explicit go for that version.** P0.2 is a decision, not a step.
- **Do not treat the Open VSX number as an audience.** It is a reason to test Cursor, not a reason to rewrite the copy. P3 has its own evidence bar.
- **Do not add usage tracking to settle P4.1.** The evidence is Ronica's own usage and what people say, nothing else.
- **Do not start a Round 6 plan before the dogfood window closes.** Its findings are the input.
- **Do not run the real-agent suite in CI.** It needs sign-ins and spends money; it runs locally and its results are written down.
