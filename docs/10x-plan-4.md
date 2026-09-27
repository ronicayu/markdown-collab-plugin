# Markdown Collab — 10x Plan, Round 4: zero setup, any agent

> **Status: IMPLEMENTED on branch `round-4`** (v0.34.97–0.35.8, all `[skip-publish]`,
> nothing pushed or tagged). Every initiative landed as its own version with a
> CHANGELOG entry; unit, webview e2e, and integration suites green at every step.
>
> | Initiative | Version | Notes |
> |---|---|---|
> | P3.2 split `extension.ts` | 0.34.97 | 1848 → 198 lines; guard keeps it under 400 |
> | P0.3 subtraction | 0.35.0 | channel transports deleted in one step (normalization of legacy values stays permanently); skill cut 30% by words, guarded by a word ceiling, not a line ceiling |
> | P2.1 icon + keybindings | 0.35.1 | Round 3's `cmd+k cmd+m` / `cmd+k cmd+c` collide with VS Code defaults; shipped `cmd+k cmd+alt+v/m/n`, verified free in VS Code 1.139 |
> | P0.1 headless runs | 0.35.2 | `--tools Read,Glob,Grep` instead of a deny list; no `--max-turns` in the CLI, so a 30-minute budget; user hooks off via `--settings {"disableAllHooks":true}`; prompt on stdin. Also fixed: a fenced sample threads block was parsed as the live one |
> | P1.1 connect an agent | 0.35.3 | Cursor in-app via `vscode.cursor.mcp.registerServer`; Gemini deliberately under "Other" (its config can't take the token from the environment); `engines.vscode` not raised |
> | P0.2 plugin + P1.3 instructions | 0.35.4 | plugin ships inside the `.vsix` and installs from a local marketplace the extension owns (always the extension's version); the GitHub marketplace also exists; `mc_edit` can delete complete anchored spans |
> | P2.4 empty state, reverse nav, a11y | 0.35.5 | "Review with Claude" forces headless for that one dispatch; availability never blocks first paint |
> | P1.2 agent identity | 0.35.6 | optional `"agent": true` on comments; attribution from MCP sessions, verified against real Claude Code |
> | P3.1 / P3.3 / P3.4 | 0.35.7 | live editor frozen + bundle budget; two GIFs (text-editor presence can't be recorded from the harness); diagnostics for the new paths |
> | P2.2 review-pass progress | 0.35.8 | waiting → receiving → arrived, completion from `mc_check`, a fresh checkpoint, or a 90 s quiet period; also fixed `mdc check` never writing the checkpoint the README promised |
> | P2.3 picker wording | 0.35.0 | done as part of the subtraction |
>
> **Open questions — defaults taken:** (1) headless is offered first, never
> auto-selected; (2) live editor frozen; (3) marketplace manifest lives in this
> repo; (4) Claude copy kept for Claude users, agent names follow authorship —
> whether all copy should follow the workspace's configured agent is raised for
> a later round; (5) nothing promoted to stable.
>
> **Not done, needs Ronica:** promotion to stable / any tag or push; Anthropic
> plugin-directory submission; manual passes against real Cursor and Codex
> installs; a Windows run of headless mode.

**Audience:** Opus 5.5, acting as implementing engineer. Each initiative has motivation, design direction, key files, and acceptance criteria. Work top-to-bottom within a tier; tiers are ordered by leverage. Every "What NOT to do" rule from rounds 1–3 still stands; the new ones are at the end.

**Product north star (unchanged):** one human + an AI agent collaborating on Markdown, all review state inline in the `.md` file. "Collab" means human ↔ AI, not multi-human. New this round: *the agent is usually Claude, but the product must not require it to be.*

**Context for the implementer (verified 2026-09-27):**
- v0.34.96. 1317 unit tests in 88 files (Vitest, green locally in 6.7s), 49 integration tests (`@vscode/test-electron`), 81 webview e2e specs (Playwright, real Chromium). CI runs all three; `release.yml` runs them again on every tag.
- Marketplace: stable channel is **0.34.80**, pre-release is **0.34.87**, 0.34.88–0.34.96 exist only as GitHub releases. 75 installs, 407 downloads, 4.45 rating, 2 GitHub stars, 1 issue. Real dogfood exists (`honest-router/docs/process/workflow-team-review.md`: 9 threads, human + claude, bilingual) but it is thin. This is a product with a very good machine and almost no users; the round is shaped by that.
- Releases flow ONLY through `release.yml` (tag push). A tag without `[skip-publish]` publishes PUBLICLY. Land each initiative as its own `[skip-publish]` version with a CHANGELOG entry. Promotion to stable is Ronica's call, per initiative or as a batch.
- The review verbs live once in `src/inlineComments/docOps.ts`, shared by the `mdc` CLI (`src/skillCli/mdc.ts`) and the MCP tools (`src/mcpServer/tools.ts`). Guard tests forbid front ends from calling the format engine's mutators directly. Nothing in this round changes that layer.
- The MCP server (`src/mcpServer/`) is streamable-HTTP on 127.0.0.1, bearer token minted per session, registered into the workspace `.mcp.json` through `${MARKDOWN_COLLAB_MCP_URL}` / `${MARKDOWN_COLLAB_MCP_TOKEN}` env vars that the extension injects into every VS Code terminal via `EnvironmentVariableCollection`. **Any CLI agent launched from a VS Code terminal already inherits those two variables.** P1 is built on that fact.
- Local Claude Code is v2.1.283. Platform facts the plan depends on, checked against current docs: `claude -p` (non-bare) uses the user's existing login, accepts `--mcp-config` + `--strict-mcp-config`, `--allowedTools`, `--output-format stream-json`, `--append-system-prompt-file`, `--max-turns`, and emits a `system/init` event listing `mcp_servers[{name,status}]` and a final `result` with `total_cost_usd` and `session_id`. Plugins are a directory with `.claude-plugin/plugin.json`, `skills/<name>/SKILL.md`, `hooks/hooks.json`, optional `.mcp.json`, and a `bin/` folder that goes on `PATH` while the plugin is enabled; a marketplace is a GitHub repo with `.claude-plugin/marketplace.json`; `claude plugin validate` exists (v2.1.281+). Channels are still research preview, `--channels` accepts only allowlisted plugins, and the `server:` form works only under `--dangerously-load-development-channels` — i.e. the `mcp-channel` send mode can never reach ordinary users.
- Other agents: Cursor reads `.cursor/mcp.json` (`url`, `headers`, `${env:NAME}` interpolation in both). Codex reads `~/.codex/config.toml` and, for trusted projects, `.codex/config.toml` (`[mcp_servers.<name>]` with `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`; no `${VAR}` expansion in `url`). VS Code exposes `vscode.lm.registerMcpServerDefinitionProvider` (`McpHttpServerDefinition` with `uri`, `headers`, `version`) and `contributes.languageModelTools` + `vscode.lm.registerTool` for Copilot agent mode; both need an `engines.vscode` floor higher than today's `^1.80.0` — verify the exact minimum at implementation time.

---

## The Round-4 review: a finished machine nobody can start

Round 1 made the **data** trustworthy. Round 2 made the **protocol** real. Round 3 started making the product **visible** and then drifted: after P0 landed (v0.34.74–75), twenty versions of unplanned work followed — line numbers, an outline, markdown comment bodies, remove-resolved, an uncommitted-changes diff view with staging, finalize, change-navigation arrows. All of it is good. None of it was the plan, and the plan's remaining items (title-bar icon, keybindings, review-pass progress, picker rewrite, empty states, reverse navigation, a11y) are still unbuilt. That drift is itself a finding: the backlog rewards polishing the surfaces the author already inhabits over removing the obstacles a new user hits first.

The honest audit of a first session today:

1. **Three concepts before the first result.** Install the extension → run *Install Claude Skill* (writes into `~/.claude/skills/`) → have a `claude` REPL running in an integrated terminal → accept the prompt to write `.mcp.json` → click Send → (auto-detected now) a bracketed paste lands in the REPL. The value only appears if the user already runs Claude Code in a VS Code terminal. Everyone else stalls at "start Claude where?" A user who does not run Claude Code at all — a Codex or Cursor user — has nothing.
2. **The agent is hardcoded as Claude, all the way down.** `mc_reply` stamps `author: "claude"`. `claudeUnread.ts`, `claudePending.ts`, `claudeStatusBar.ts`, "Send to Claude", "Ask Claude to Review". The MCP server itself is agent-neutral; only the registration and the wording are not. Ronica's own first dogfood comment on the README (April 2026) was *"it can be other tools too. not just claude."* Still true, still unaddressed.
3. **Five send modes, two of them dead ends.** `channel` (a tailer + `Monitor`) and `mcp-channel` (research-preview channels that will never be enabled for a `server:` entry outside dev mode) carry roughly a third of the README's setup text and ~120 lines of the skill. They exist for harness configurations that no longer describe how anyone runs Claude Code. Round 3 proposed hiding them behind a separator; the right move is deleting them.
4. **The skill is still a manual.** ~570 lines after the "thin orchestration" rewrite, because it must cover the CLI path, the tools path, the hand-edit appendix, and two transports. Every line is a line an agent can misread, and every non-Claude agent gets none of it.
5. **Waits are still silent in the default mode**, and the product still has no icon, no keybinding, and no empty state that teaches. Round 3's findings 1, 5, and 6 stand verbatim.
6. **The live editor is the most expensive surface per user-visible win.** 11 of the 76 `### Fixed` entries in the CHANGELOG are live-editor sync/highlight bugs; its bundle is 4.4 MB (Milkdown + mermaid + mxgraph) against 1.0 MB for the inline view; its client is 2352 lines. It is a secondary surface that costs like a primary one.

The 10x version: **a new user clicks one button and watches the agent work — no skill install, no terminal to find, no `.mcp.json` question — and that user does not have to be a Claude Code user. Everything the previous rounds built (undoable tool-driven edits, integrity refusal, suggestions, delta review, conventions) becomes the thing any agent gets through one MCP server, and the product stops describing itself in terms of transports.**

---

## P0 — Zero setup: the extension drives the agent

### P0.1 Headless runs: "Review with Claude" spawns `claude -p` against the extension's own MCP server

**Problem.** Every send mode hands a prompt to a Claude session the *user* had to start and keep visible. The extension already hosts the tool server the agent needs; it just never starts the agent.

**Design.**
- A new send mode `headless` (settings label: *"Run Claude for me"*). On send, the extension spawns the `claude` binary non-interactively in the workspace folder:
  ```
  claude -p <prompt>
    --output-format stream-json --verbose
    --mcp-config <0600 temp file: {mcpServers:{"markdown-collab":{type:"http",url,headers}}}>
    --strict-mcp-config
    --allowedTools "Read,Glob,Grep,mcp__markdown-collab__*"
    --disallowedTools "Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch"
    --append-system-prompt-file <0600 temp file holding the skill text>
    --max-turns <per-mode ceiling>
    --permission-mode default --permission-prompts none
  ```
  Not `--bare`: bare mode skips the user's subscription login and needs an API key. The temp files (token, skill) are written 0600 and deleted when the process exits; the token never appears on the command line. `cwd` is the workspace folder (or the file's directory for a loose `.md`).
- **Closed tool set.** With `Edit`/`Write`/`Bash` disallowed, the guarantee from round 2 becomes total: nothing touches the file except through `WorkspaceEdit`. That requires one new tool, **`mc_edit(file, old, new, occurrence?)`** — a plain prose replacement that goes through the same `docOps` core and the integrity guard, for edits *outside* anchored spans (the case the skill currently hands to the Edit tool). The CLI gets the matching `edit` verb (shared handler core, as always).
- **Progress from facts, not inference.** The `stream-json` stream is the lifecycle: `system/init` (feature detection: is `markdown-collab` in `mcp_servers` with a healthy status? if not, kill and fall back to `terminal` with a toast naming the reason), `assistant` messages with `tool_use` blocks (the existing `onToolCall` → `pendingSignalsFromToolCalls` path already turns `mc_status`/`mc_check` into UI state; headless adds "turn N, tool X" to it), and the final `result` (done, `is_error`, `total_cost_usd`, `session_id`). This closes Round 3's P2.1 for headless mode for free: the status bar shows a real spinner with elapsed time, the current tool, and the cost at the end.
- **Cancel** is a status-bar click: SIGINT first (ends the turn cleanly), SIGTERM after a grace period. One run per workspace at a time; a second click while one runs offers cancel-and-resend.
- **Failure paths are explicit.** `claude` not on PATH → the picker never offers headless (detection: resolve the binary once per activation; cache). Auth failure in the stream (`api_retry` with `authentication_failed`, or a `result` that is an error naming login) → toast *"Run `claude` once in a terminal to sign in, then try again"*, fall back to terminal for this send only. MCP disabled by policy → same detection through `system/init`; remember the failure per workspace and stop offering headless until *Reset Send Mode*.
- **Prompt builders** (`src/inlineComments/sendToClaude.ts`, `dispatchReviewPayload` in `extension.ts`) grow a `skillDelivery: "installed" | "inline"` parameter. The current first line — *"Use the vs-markdown-collab skill…"* — is wrong when the skill rides along as a system prompt; inline delivery says *"Follow the Markdown Collab review workflow in your instructions."*
- **Trust.** Only run headless in a trusted workspace (`vscode.workspace.isTrusted`); `-p` shows no trust dialog and would otherwise run the project's own hooks and `.mcp.json` servers (that is why `--strict-mcp-config` is there — the project's other MCP servers are irrelevant to a review and should not start).
- **Detection ladder update** (`src/transports/detectSendMode.ts`): a running `claude` terminal still wins (the user is already in a session — do not start a second one behind their back). Otherwise, if the binary exists and headless has not failed in this workspace, *offer* headless first in the picker with a plain description. Whether headless may be *auto-selected* when nothing else is running is an open question for Ronica (see the end); default to offering, not choosing.
- **Do not embed the Agent SDK.** `@anthropic-ai/claude-agent-sdk` spawns the same CLI and would couple the extension's release to the SDK's; the subprocess costs nothing to ship and uses whatever Claude Code the user has. Revisit only if `stream-json` proves insufficient.

**Key files:** new `src/transports/headless.ts` (spawn, stream parser, lifecycle), `src/transports/detectSendMode.ts`, `src/claudeStatusBar.ts`, `src/claudePendingService.ts`, `src/mcpServer/tools.ts` + `src/skillCli/mdc.ts` + `src/inlineComments/docOps.ts` (`mc_edit`), `src/inlineComments/sendToClaude.ts`, `src/extension.ts` (`pickSendMode`, `dispatchReviewPayload`), `package.json` (enum + enumDescriptions).

**Acceptance:**
- Unit: the stream parser is pure and tested against recorded `stream-json` fixtures (init with server present / absent / failed, tool_use turns, result with cost, api_retry auth error, truncated stream). Argument builder tested: token never in argv; temp files 0600; `--strict-mcp-config` and the disallow list always present.
- Integration: with a stubbed `claude` binary (a node script that replays a fixture stream and calls the real tool server), a review-request dispatch results in threads written via `WorkspaceEdit` (undoable), the status bar transitions sent → working (naming a tool) → done with a cost, and the pending record clears without any timer.
- Guard: `mc_edit` refuses a replacement that would split a marker or touch the threads region, exactly like `mc_rewrite`; the CLI `edit` verb and the tool share one handler.
- Manual (dev host, Ronica): one real headless review on a real doc, and one cancel mid-run.

### P0.2 Ship the Claude side as a plugin, generated from the same source

**Problem.** *Install Claude Skill* writes files into `~/.claude/skills/` by hand, versions them with a fingerprint the extension has to nag about, and puts the `mdc` CLI at a path (`node ~/.claude/skills/vs-markdown-collab/mdc.mjs`) that every skill instruction has to spell out. Claude Code now has a first-class unit for exactly this bundle.

**Design.**
- `scripts/build-plugin.mjs` emits `plugin/` at build time from the existing sources — the skill text from `src/skill.ts`, the CLI from the existing esbuild step — so there is still one source of truth:
  ```
  plugin/
    .claude-plugin/plugin.json      name "markdown-collab", version = package.json version
    skills/review/SKILL.md          the skill; also runnable as /markdown-collab:review
    bin/mdc                         shim → node "$CLAUDE_PLUGIN_ROOT/lib/mdc.mjs"
    lib/mdc.mjs
    hooks/hooks.json                see below
  ```
  With `bin/` on `PATH`, every CLI reference in the skill becomes `mdc check <file>` — shorter, and no home-directory path to get wrong.
- **The integrity hook.** `hooks/hooks.json` registers a `PostToolUse` hook on `Edit|Write` with `if: "Edit(*.md)"` (and the `Write` equivalent) running `mdc check --hook`: it reads `tool_input.file_path` from stdin, does nothing unless the file contains `<!--mc:threads:begin-->`, and on a violation exits 2 with the integrity report on stderr — so Claude is told, immediately and mechanically, that its edit broke a marker, in every session where the plugin is enabled. This is the Claude-side guard round 1 wanted and could only ask for in prose.
- **No `.mcp.json` inside the plugin by default.** The server is per-VS-Code-window with a per-session token, so the workspace `.mcp.json` + env-var registration from round 2 stays. *Evaluate* a plugin-level http entry using `${MARKDOWN_COLLAB_MCP_URL}` / `${MARKDOWN_COLLAB_MCP_TOKEN}` expansion: if Claude Code fails quietly when the vars are unset (a session outside VS Code), prefer it and drop the asked-once workspace write entirely; if it produces a visible connection error in every non-VS-Code session, keep the workspace registration. Decide from behavior, not docs.
- **Marketplace.** `.claude-plugin/marketplace.json` at the root of `ronicayu/markdown-collab-plugin` listing `./plugin`. The extension's *Install Claude Skill* command becomes **Set Up Claude Code**: it runs `claude plugin marketplace add ronicayu/markdown-collab-plugin` and `claude plugin install markdown-collab@<marketplace-name>` in a terminal (or copies them when no terminal is wanted), then verifies with `claude plugin list`. The legacy skill-directory install stays for one minor cycle as a fallback for Claude Code versions without plugin support, then goes. Submission to Anthropic's plugin directory is outward-facing — Ronica's call, after the first stable release that carries it.
- **CI.** `claude plugin validate plugin/` in the build job (installs Claude Code on the runner — a network dependency; fall back to a JSON-schema check of `plugin.json` and `hooks.json` if the install is flaky). Guard test: `plugin.json` version equals `package.json` version; the skill text inside `plugin/` equals `SKILL_CONTENT`; `verify-package.mjs` asserts `plugin/` is *excluded* from the `.vsix` (it ships via the marketplace, not the extension).

**Key files:** new `scripts/build-plugin.mjs`, new `plugin/` (generated; commit it so the marketplace can fetch it), `.claude-plugin/marketplace.json`, `src/skill.ts` (install command rewrite, CLI path strings), `src/skillCli/mdc.ts` (`check --hook`), `.vscodeignore`, `.github/workflows/ci.yml`, `scripts/verify-package.mjs`.

**Acceptance:** `claude --plugin-dir ./plugin -p "…"` in a fixture workspace loads the skill (visible in `system/init` plugins), `mdc` resolves on `PATH`, and an `Edit` that drops a `-->` triggers the hook with a non-empty report; the skill fingerprint test is replaced by the version-equality guard; `npm run compile` regenerates `plugin/` deterministically (a CI step diffs it and fails on drift).

### P0.3 Subtraction: three send modes, not five; one skill path, not three

**Problem.** `channel` and `mcp-channel` are dead ends (see the audit), `mcp` is `terminal` plus one directive line, and the skill carries every transport's ceremony. Round 3 wanted to reorder the picker; this round removes what it was reordering.

**Design.**
- Send modes become **`ask` · `headless` · `terminal` · `clipboard`**. `mcp` folds into `terminal`: the directive *"use the `markdown-collab` tools if you have them"* is appended to every terminal send unconditionally — it is harmless when the tools are absent (the skill already falls back to the CLI), and it removes a mode whose only difference was that line. Existing `mcp`/`channel`/`mcp-channel` values in settings normalize to `terminal` with a one-time toast (the same pattern `ipc` got in 0.12.1).
- Delete, over two releases: first hide (picker, enum, README, skill) and normalize; next release remove `src/transports/eventLog.ts`, `src/transports/mcpChannel.ts`, `mdc-tail.mjs`, `mdc-channel.mjs`, their tests, the `.events*.jsonl` / `.channel.json` runtime files, and the walkthrough copy that mentions them.
- **Skill shrink.** Remove *MCP channel mode*, *Channel watch loop*, and *Getting the MCP tools* (the plugin makes it moot); collapse the tools/CLI tables into one table with two columns (tool · `mdc` verb). Target: the skill fits in ≤ 300 lines with the hand-edit appendix intact. Round 2's guard (tools-first path never mentions Edit-tool marker surgery outside the appendix) stays.
- **README.** The "Choosing a send mode" and "Send mode details" sections shrink to one short table (three rows) and a paragraph on headless. The storage-layout section drops the runtime files.
- `enumDescriptions` rewritten for someone who has not read the README (Round 3 P2.2's wording rule: no "bracketed paste", no "Monitor", no file names).

**Key files:** `src/transports/detectSendMode.ts`, `src/extension.ts` (`pickSendMode`, `normalizeSendMode`), `package.json`, `src/skill.ts`, `README.md`, `media/walkthrough/send.md`, the transports and tests named above.

**Acceptance:** guard test that every mode in the settings enum appears in the picker builder and vice versa; unit test for legacy-value normalization; skill line count asserted under the ceiling; `grep -c "mdc-tail\|mdc-channel\|Monitor" README.md src/skill.ts` is zero after the second release.

---

## P1 — Any agent

### P1.1 "Connect an Agent": one command writes the right config for Cursor, Codex, Copilot, Gemini

**Problem.** The server is agent-neutral and the env vars already reach every VS Code terminal; only Claude Code gets a registration.

**Design.** A quick-pick command **Markdown Collab: Connect an Agent** with one entry per client, each writing the smallest correct config into the workspace and telling the user what happened:
- **Claude Code** → today's `.mcp.json` entry (or the plugin path from P0.2).
- **Cursor** → `.cursor/mcp.json`: `{"markdown-collab": {"url": "${env:MARKDOWN_COLLAB_MCP_URL}", "headers": {"Authorization": "Bearer ${env:MARKDOWN_COLLAB_MCP_TOKEN}"}}}` — Cursor interpolates `${env:NAME}` in `url` and `headers`, so no port or token lands on disk.
- **Codex** → `.codex/config.toml` `[mcp_servers.markdown-collab]` with `url` set to the current literal loopback URL (Codex does not expand variables in `url`) and `bearer_token_env_var = "MARKDOWN_COLLAB_MCP_TOKEN"`. The literal port means this file is rewritten when the port moves (the existing `.mcp.json` merge logic already handles "rewrite only if changed"); note in the toast that Codex must trust the project for project-scoped config to load.
- **Copilot (VS Code agent mode)** → no file at all: `vscode.lm.registerMcpServerDefinitionProvider` returning one `McpHttpServerDefinition` with the live URL and the bearer header, re-provided when the port changes. Requires declaring `contributes.mcpServerDefinitionProviders` and raising `engines.vscode`; feature-detect `vscode.lm?.registerMcpServerDefinitionProvider` so older hosts simply omit the entry. (A parallel `contributes.languageModelTools` surface is possible but duplicates the MCP server; do not build both — MCP is the one every client speaks.)
- **Gemini CLI / other** → show the URL and token with copy buttons and a one-line generic MCP snippet; mark as unverified.
- Merge semantics mirror `src/mcpServer/registration.ts`: preserve every other server, rewrite only on change, never write a token into a committed file except where the client has no env mechanism (Codex `url` has the port, never the token). The `.gitignore` guidance in README gains the new files.

**Key files:** new `src/mcpServer/clients/{cursor,codex,copilot,generic}.ts` sharing the merge helpers in `registration.ts`; `src/extension.ts` (command); `package.json` (`mcpServerDefinitionProviders`, `engines`); README.

**Acceptance:** unit tests per writer (fresh file, existing file with other servers, unchanged file → no write, port moved → rewrite); the Cursor writer is asserted to contain no digits from the port and no token; a guard asserts the Copilot provider is registered only when the API exists; one manual pass each with Cursor and Codex against a fixture workspace (Ronica or a dev-host session) recorded in the CHANGELOG entry.

### P1.2 The agent has a name, and it is not always "claude"

**Problem.** `mc_reply` and `mc_open` stamp `author: "claude"`; unread/pending logic, the status bar, and every label assume it.

**Design.**
- The MCP server records `clientInfo.name` from each session's `initialize` handshake and maps it to a short author slug (`claude-code` → `claude`, `codex*` → `codex`, `cursor*` → `cursor`, `Visual Studio Code*` → `copilot`, unknown → the lowercased first token). Tool handlers take the author from the session; the CLI takes `--author` (default `claude` for compatibility) and the headless runner passes it explicitly. `markdownCollab.agentName` overrides the display name.
- Every `=== "claude"` check in `src/` moves behind `isAgentAuthor(author)` and `agentDisplayName()` in a new `src/agentIdentity.ts`; `claudeUnread.ts` / `claudePending.ts` / `claudeStatusBar.ts` keep their file names (churn for nothing) but read through the helper. The inline format does not change — `author` was always a free-form string.
- **Wording rule:** where the connected or detected agent is Claude, UI copy stays "Send to Claude" / "Ask Claude to Review" — do not genericize the product for the users it already serves. Where another agent is connected (P1.1) or the author of a thread is another agent, labels use that agent's name; when unknown, "the agent".

**Key files:** `src/mcpServer/protocol.ts` (capture `clientInfo`), `src/mcpServer/tools.ts`, `src/skillCli/mdc.ts`, `src/inlineComments/docOps.ts` (author parameter threads through), new `src/agentIdentity.ts`, `src/inlineComments/claudeUnread.ts`, `src/inlineComments/claudePending.ts`, `src/claudeStatusBar.ts`, `src/webviewShared/commentUi.ts` (card label), `src/reviewView.ts`.

**Acceptance:** a `mc_open` from a session whose `clientInfo.name` is `codex-cli` lands with `author: "codex"` and shows as "1 new from Codex" in the review tree and sidebar; existing fixtures with `author: "claude"` render unchanged (roundtrip corpus green); grep guard: no literal `"claude"` author comparison outside `agentIdentity.ts`.

### P1.3 The workflow travels with the server

**Problem.** A non-Claude agent connecting to the server gets ten tool descriptions and none of the workflow (list → act → check; never resolve; suggest mode; review-mode rubric).

**Design.** Return a compact workflow (≤ 2 KB) as the MCP `initialize` result's `instructions` field, and add a **`mc_help`** tool that returns the full tools-first section of the skill for clients that do not surface `instructions` (verify Claude Code, Cursor, Codex behavior at implementation; document which do). Every mutating tool description ends with *"If unsure of the workflow, call mc_help first."* The skill (P0.2) and `instructions` are generated from the same `src/skill.ts` sections so they cannot drift.

**Acceptance:** unit test that `instructions` is under the size cap and contains the three phase names and the "only the human resolves" rule; `mc_help` returns the same bytes as the skill's tools-first section; corpus run driven by a scripted client that reads only `instructions` + tool descriptions (no skill installed) completes an address pass with zero integrity violations.

---

## P2 — Close the daily loop (Round 3's unbuilt tiers, re-cut)

These are Round 3's P1–P3, unchanged in intent; read the original text in `10x-plan-3.md` for design detail. Only the deltas are noted here.

### P2.1 Title-bar icon + keybindings (Round 3 P1.1, P1.2) — as written
One `$(comment-discussion)` icon in `editor/title` for Markdown; `cmd+k cmd+m` / `cmd+k cmd+c` / `cmd+k cmd+n` contributed, all `when`-scoped; `n`/`p`/`r`/`e` inside the inline view when no input has focus. **Delta:** the inline client already binds `n`/`p` for diff navigation (`diffNav.step`, 0.34.92); unify the two into one keyboard map so `n` walks *changes* in the diff view and *threads* elsewhere, with the mode shown in the button `title`.

### P2.2 Every wait has a pulse (Round 3 P2.1) — halved by P0.1
Headless mode gets protocol-grade progress for free. For `terminal` mode implement the inferred review-pass record exactly as Round 3 specifies (status bar `Sent for review · 1m 20s`, resolves on new agent threads host-side, 10-minute timeout → warning with Resend/Dismiss). Detection of new threads moves host-side (`claudeUnread.ts`) so it works with no panel open.

### P2.3 Picker wording (Round 3 P2.2) — mostly done by P0.3
With three modes there is nothing to separate. Remaining work is the plain-language `enumDescriptions` and the "No Claude terminal detected" detail row.

### P2.4 Empty states, reverse navigation, a11y (Round 3 P3.1–P3.3) — as written
**Delta for the empty state:** when `claude` is on PATH and headless is available, the empty-sidebar card's button is *"Review with Claude"* and runs headless directly — the first-minute path for a brand-new user. When it is not, the card explains the one thing to do (open a terminal and run `claude`).

---

## P3 — Stop the sprawl

### P3.1 Decide the live editor: freeze (default) or invest

**Evidence.** 11/76 fixes, 4.4 MB bundle, 2352-line client, and the most recent bug-fix release (0.34.95) was live-editor highlight drift. It is the secondary surface by the README's own framing ("Prefer editing rendered Markdown directly?").

**Default recommendation: freeze.** Label it *Markdown Collab (live editor, preview)* in `customEditors.displayName`; no new features land there — every new capability lands in the inline view first and is ported only on request; bugs are triaged, not hunted. Add a bundle-size guard test (`out/webview/client.js` must not grow; `mermaid` and `mxgraph` are already dynamic imports, so the guard is on growth, not on splitting) so the freeze is enforced, not remembered. If Ronica uses the live editor daily, the alternative is the opposite call — make it the primary surface and port the inline view's features into it — but that is a round of its own, not a side quest in this one. **This is Ronica's decision; see the open questions.**

### P3.2 Split `extension.ts`

1848 lines, ~40 command registrations, and the send/dispatch/pick logic all in one file. Move each command family into `src/commands/<family>.ts` (review, send, comments, skill, pr, diagnostics), leaving `activate` as registration and wiring only. Behavior-preserving; the 49 integration tests are the net. Guard: `extension.ts` under 400 lines. Do this *before* P0.1 adds the headless dispatcher, or that code lands in the wrong place too.

### P3.3 Release the backlog, and make the listing say what the product now is

- Propose promoting 0.34.88–0.34.96 (plus this round's early initiatives) to **stable** — Ronica's call, one confirmed act. The pre-release channel has been live since 0.34.82; nothing in the batch has been reported broken.
- **Three GIFs**, recorded automatically from the playground fixture through the existing Playwright harness (`recordVideo` → ffmpeg → GIF, ≤ 1.5 MB each): the inline loop (comment → accept a suggestion), headless review (button → status bar → threads land), and the text-editor presence (decorations, hover, CodeLens). Committed under `media/`, referenced from README, excluded from the `.vsix`. A `scripts/record-gifs.mjs` so they can be re-recorded after a UI change instead of rotting.
- README leads with *"Click Review. Claude reads your doc and leaves comments you triage — no setup"* once P0.1 ships; marketplace description and keywords updated; `galleryBanner` set; Open VSX listing checked for parity.
- Anthropic plugin directory submission after P0.2 is stable (Ronica's call).

### P3.4 Diagnostics for the new paths

`Report a Problem` gains: `claude` binary path and version, last headless run summary (exit status, turns, cost, `system/init` server statuses — never the prompt or the transcript), which agent clients are registered (P1.1), and the plugin install state (`claude plugin list` output, if available). Trace-level logging of the `stream-json` stream to the output channel, token redacted as everything else is.

---

## Sequencing and dependencies

```
P3.2 split extension.ts ─┐  (first: everything below adds code to it)
P0.3 subtraction ────────┼─▶ P0.1 headless ─▶ P0.2 plugin ─▶ P1.3 instructions
                         │        │
                         │        └─▶ P2.2 progress (terminal half), P2.4 empty state
P2.1 icon + keys ────────┘  (independent; cheapest visible win — do it early)
P1.1 connect agents ─▶ P1.2 agent identity   (P1.2 needs P1.1's client info to matter)
P3.1 live-editor decision — a conversation, then a small PR either way
P3.3 release + listing — after P0.1 (the GIFs and copy depend on it)
P3.4 diagnostics — alongside P0.1 and P1.1, not after
```

Recommended order: **P3.2 → P0.3 → P2.1 → P0.1 → P0.2 → P1.1 → P1.2 → P1.3 → P2.2 → P2.4 → P2.3 → P3.1 → P3.3**. Subtraction before addition: P0.3 shrinks the skill, the README, and the picker that P0.1 and P0.2 then extend. P2.1 is early because it is a day of work and the single most visible change for an existing user.

Each initiative = one `[skip-publish]` version + CHANGELOG entry, as in rounds 1–3. Verify current Claude Code flags (`--permission-prompts`, `--strict-mcp-config`, plugin `bin/` semantics, `${VAR}` expansion in plugin `.mcp.json`) against live docs before building P0.1/P0.2 — the plan states intent as of 2026-09-27, not gospel.

## Open questions for Ronica (decide before the corresponding initiative)

1. **Headless as default?** When `claude` is on PATH and no Claude terminal is running, may the first click run headless without asking? The plan defaults to *offer first, never choose*; auto-selecting would remove the last setup question a new user sees.
2. **Live editor: freeze or invest?** P3.1 defaults to freeze.
3. **Marketplace home.** `.claude-plugin/marketplace.json` in this repo (simplest) or a separate `ronicayu/claude-plugins` repo that can hold future plugins?
4. **Wording for non-Claude agents.** P1.2 keeps "Claude" copy for Claude users and names other agents when connected. Alternative: rename the product surface to "Send to agent" everywhere. The plan recommends against it.
5. **Promote 0.34.88–0.34.96 to stable now**, ahead of this round, or batch with P0.3?

## What NOT to do

Everything in rounds 1–3 stands (no multi-human sync, no thread caps, no sidecars, no format-engine rewrites, no unconfirmed tags, no webview framework rewrite, no activity-bar container, no global keybindings, no toasts for progress, MCP never *required*). Additionally:

- **Do not run headless with `--bare` or `--dangerously-skip-permissions`.** Bare mode drops the user's login; skip-permissions drops the closed tool set. The headless guarantee *is* the disallow list plus `--strict-mcp-config`.
- **Do not put the token on the command line or in any committed file.** Temp files 0600, deleted on exit; env vars for clients that expand them; literal ports only where a client cannot expand (Codex `url`), never literal tokens.
- **Do not embed the Agent SDK** in this round. The subprocess is the integration.
- **Do not remove `terminal` or `clipboard`.** They are the paths that work when the extension cannot start or reach an agent, and they are the paths for a Claude session on another machine.
- **Do not keep `channel` / `mcp-channel` "just in case."** Hide, normalize, then delete. A mode that cannot reach users is a maintenance liability, not an option.
- **Do not fork the skill per agent.** One skill text, one `instructions` blob, one `mc_help` — generated from `src/skill.ts`. Agent-specific wording belongs in P1.1's toasts, not in the workflow.
- **Do not add telemetry** to learn how the product is used. The diagnostics report is opt-in and pasted by the user; that remains the only channel.
- **Do not let the live editor absorb this round.** If P3.1 lands on "invest," that is Round 5.
