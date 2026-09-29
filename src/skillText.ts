// The review workflow, as named sections rendered for every place it is read
// (10x-plan-4 P0.2 and P1.3).
//
// WHY THIS EXISTS. The same workflow reaches an agent four ways: the
// standalone skill older installs keep in `~/.claude/skills/`, the Claude Code
// plugin's skill (where `mdc` is on PATH), the system prompt of a headless run
// (tools only — no CLI, no Edit tool), and the MCP server's `instructions` for
// any client that connects without either. Four hand-kept copies would drift
// the way the old per-transport sections did — one of them eventually telling
// an agent to do something another forbids. So there is one text, cut into
// sections, and each target is a rendering of it: a rule changes in one place
// and lands everywhere.
//
// The legacy rendering is byte-for-byte the skill this file replaced, apart
// from deliberate edits; `src/test/skillText.test.ts` pins that against a
// snapshot so a refactor here can't quietly rewrite what installed users read.
//
// Pure — no fs, no vscode. Imported by the skill installer, the headless
// runner, the MCP server, and (through esbuild) scripts/build-plugin.mjs.

/** Where a rendering of the skill is read. */
export type SkillTarget = "legacy" | "plugin" | "headless";

/** The standalone skill's name, and its directory under `~/.claude/skills/`. */
export const LEGACY_SKILL_NAME = "vs-markdown-collab";
/** The plugin's name — every component in it is namespaced under this. */
export const PLUGIN_NAME = "markdown-collab";
/** The skill's name inside the plugin: `/markdown-collab:review`. */
export const PLUGIN_SKILL_NAME = "review";

/** Text that only exists where the `mdc` CLI does (not in a headless run). */
function cliOnly(t: SkillTarget, text: string): string {
  return t === "headless" ? "" : text;
}

/** How the rendering tells the agent to invoke the CLI. */
function cliInvocation(t: SkillTarget): string {
  // Only the plugin can say plain `mdc`: its `bin/` is on PATH while it is
  // enabled. The standalone skill has no PATH entry, so it spells the file out.
  return t === "plugin"
    ? "`mdc <command> <file> [args]` — on your PATH while this plugin is enabled —"
    : "`node ~/.claude/skills/vs-markdown-collab/mdc.mjs <command> <file> [args]`,";
}

/** One row of the tools table: the MCP tool, its `mdc` verb, what it does. */
interface ToolRow {
  tool: string;
  cli: string;
  what: string;
  /** Appended to `what` only where the CLI exists. */
  cliNote?: string;
}

const TOOL_ROWS: readonly ToolRow[] = [
  {
    tool: "`mc_list(file, actionable?)`",
    cli: "`list <file> [--actionable]`",
    what: "Threads and pending suggestions as JSON, including each thread's live anchored text. The actionable flag keeps only open threads whose last comment is not yours.",
  },
  {
    tool: "`mc_reply(file, threadId, body)`",
    cli: "`reply <file> <threadId> --body TEXT`",
    what: "Appends a reply authored by `claude` with the correct `c<N>` id and timestamp.",
  },
  {
    tool: "`mc_rewrite(file, threadId, with)`",
    cli: "`rewrite <file> <threadId> --with TEXT`",
    what: "Replaces the text between a thread's markers and updates its `quote`. Both markers are preserved by construction.",
  },
  {
    tool: "`mc_edit(file, old, new, occurrence?)`",
    cli: "`edit <file> --old TEXT --new TEXT [--occurrence N]`",
    what: "Replaces exact text outside anchored spans (prose, frontmatter), or deletes an anchored passage when `old` spans both of its markers. Refuses anything that splits a marker pair or touches the threads region — use `mc_rewrite` inside an anchor.",
  },
  {
    tool: "`mc_open(file, quote, body, occurrence?)`",
    cli: "`open <file> --quote TEXT --body TEXT [--occurrence N]`",
    what: "Opens a new thread on a passage: mints a unique id, wraps the passage, appends the thread line.",
  },
  {
    tool: "`mc_resolve(file, threadId)`",
    cli: "`resolve <file> <threadId>`",
    what: "Marks a thread resolved. Only when the human asks.",
  },
  {
    tool: "`mc_suggest(file, quote, with, note?, occurrence?)`",
    cli: "`suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N]`",
    what: "Proposes an edit without applying it (suggest mode). Keeps the original in the prose.",
  },
  {
    tool: "`mc_accept(file, anchorId)` / `mc_reject(file, anchorId)`",
    cli: "`accept <file> <anchorId>` / `reject <file> <anchorId>`",
    what: "Apply / drop a pending suggestion. Normally the human's call in the UI.",
  },
  {
    tool: "`mc_check(file)`",
    cli: "`check <file> [--repair]`",
    what: "Integrity report. **Run this last on every file you touched** — see below.",
    cliNote: " CLI-only `--repair` fixes what it safely can.",
  },
  {
    tool: "`mc_status(note, file?)`",
    cli: "*(no CLI form — interactive only)*",
    what: "Say what you're doing right now (\"reading 2 of 3 files\", \"opening threads on §Setup\").",
  },
];

function toolTable(t: SkillTarget): string {
  if (t === "headless") {
    return ["| MCP tool | What it does |", "| --- | --- |", ...TOOL_ROWS.map((r) => `| ${r.tool} | ${r.what} |`)].join(
      "\n",
    );
  }
  return [
    "| MCP tool | `mdc` CLI form | What it does |",
    "| --- | --- | --- |",
    ...TOOL_ROWS.map((r) => `| ${r.tool} | ${r.cli} | ${r.what}${r.cliNote ?? ""} |`),
  ].join("\n");
}

const PASS_SIGNALS =
  "Two of these do more than they look like they do: **`mc_check` ends the pass** — the extension shows the human a \"Claude is working…\" row on every thread it sent you, and your closing `mc_check` on a file is what clears it; skip it and they're left watching a spinner for work you already finished. **`mc_status` is free and worth it** — a review pass over three files is minutes of silence otherwise, and one short present-tense phrase per phase shows up next to the indicator and in the status bar.";

function changePaths(t: SkillTarget): string {
  if (t === "headless") {
    return `## How to change a document — the tools

Marker surgery by hand is the single most common way this workflow breaks: one dropped \`-->\` silently orphans a reviewer's comment. So you never hand-edit a marker or a thread line — every change goes through the **MCP tools**, which run the *same* engine the editor itself uses: edits go through the editor, undoable with Cmd+Z, validated before they land.

${toolTable(t)}

${PASS_SIGNALS}

Ordinary prose edits — text outside an anchored span — use \`mc_edit\`, which refuses anything that would break a marker or touch the threads region. Every mutating tool validates before writing and refuses a change that would introduce a new integrity problem, so a refused call leaves the file untouched rather than half-edited.

**The tools refuse rather than guess.** Ambiguous passage (appears more than once)? Pass the occurrence. Inside a code span? Choose a different anchor. Never work around a refusal — it's telling you the edit was unsafe.`;
  }
  return `## How to change a document — the two safe paths

Marker surgery by hand is the single most common way this workflow breaks: one dropped \`-->\` silently orphans a reviewer's comment. So you never hand-edit a marker or a thread line — every change goes through the *same* engine the editor itself uses, whichever front end is available: the **MCP tools** (first choice, when they're in your tool list — edits go through the editor, undoable with Cmd+Z, validated before they land), or the **\`mdc\` CLI** (${cliInvocation(t)} same verbs, for when the tools aren't there — a session outside this VS Code window, MCP disabled by policy, or the server not running).

Hand-editing markers with the Edit tool is a distant third and only when neither exists — see *Appendix: hand-editing markers* at the end of this file.

${toolTable(t)}

${PASS_SIGNALS}

Ordinary prose edits — text outside an anchored span — may use \`mc_edit\` (CLI: \`mdc edit\`), which refuses anything that would break a marker or touch the threads region; the Edit tool remains fine too in interactive sessions. Every \`mdc\` command prints JSON to stdout — a failure is \`{"ok":false,"code":…,"message":…}\` — with exit codes \`0\` ok, \`1\` usage error or refusal, \`2\` integrity violation; mutating commands validate before writing and refuse a change that would introduce a new integrity problem, so a failed command leaves the file untouched rather than half-edited.

**Both paths refuse rather than guess.** Ambiguous passage (appears more than once)? Pass the occurrence. Inside a code span? Choose a different anchor. Never work around a refusal by hand-editing — it's telling you the edit was unsafe, and the hand-edit would perform it anyway.

**If neither path is available** (older install, no \`node\` on PATH, no tools), follow the appendix, and run a check as soon as either is back.`;
}

const VERIFY_DAMAGE_WITH_CLI =
  "If the check reports damage you introduced, fix it — the CLI's `check --repair` strips stray markers and re-anchors threads whose quote still matches exactly one place in the prose (never guessing at an ambiguous one); anything it can't repair is yours to fix by hand.";

// A tools-only session can't introduce damage (every mutating tool refuses a
// change that would), and has nothing to repair markers with — so anything the
// check reports predates the pass, and the useful move is to say so.
const VERIFY_DAMAGE_TOOLS_ONLY =
  "The tools refuse any change that would introduce damage, so anything the check reports was already there — name it in your report (the human can run **Markdown Collab: Repair Comment Anchors**) rather than trying to fix markers yourself.";

// Thread records have no delete tool — deliberately: the record is history, and
// the one-click delete belongs to the human in the review view.
const DELETION_TOOLS_ONLY = `### Phase 4 — Deletion (opt-in)

You only delete a thread when the human's body or trailing reply unambiguously asks for it ("delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"). There is no tool for removing a thread record — reply that it can go and list it in your report; the human deletes it from the review view.

- Never delete to "clean up". Never delete just because you addressed a comment — the human resolves.`;

const MAINTENANCE_TOOLS_ONLY = `## Every \`.md\` edit goes through the tools

Whenever you change a file that contains \`<!--mc:threads:begin-->\` — for any reason, not only to address a comment — make the change with \`mc_edit\` or \`mc_rewrite\`: they refuse an edit that would break a marker, which a plain text edit can't. If you **rewrote an anchored passage**, \`mc_rewrite\` kept its markers on the new wording; if you **removed one**, the thread surfaces as unanchored — correct, don't re-anchor it to unrelated nearby text. Do NOT change any \`<!--mc:t {…}-->\` line — only the human reviewer and the reply workflow append to threads. Finish with \`mc_check\`.`;

/**
 * How a section appears in the compact MCP `instructions`: an opening line, a
 * numbered workflow step, or a rule. Sections without one aren't summarised.
 */
interface Brief {
  kind: "intro" | "step" | "rule";
  text: string;
}

interface SkillSection {
  id: string;
  /** The section for one target, or null where it doesn't apply. */
  render(t: SkillTarget): string | null;
  /** The section's rule in a line, for the MCP `instructions` (≤ 2 KB in total). */
  brief?: Brief;
}

const SECTIONS: readonly SkillSection[] = [
  {
    id: "frontmatter",
    // Skill-loader metadata. A headless run's system prompt isn't loaded as a
    // skill, so it would only be noise there.
    render: (t) => (t === "headless" ? null : `---
name: ${t === "plugin" ? PLUGIN_SKILL_NAME : LEGACY_SKILL_NAME}
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace, AND for reviewing Markdown docs by leaving review comments for the human. Comments are stored INLINE in the .md file itself (look for \`<!--mc:threads:begin-->\`). TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document — trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md". ALSO TRIGGER on review-mode requests where the user asks YOU to play reviewer — "review this doc", "leave your thoughts on README", "do a review pass on docs/spec.md", "second pair of eyes on this", "what would you flag in this file", "review the markdown collab doc on X".
---`),
  },
  { id: "intro", render: () => `# Markdown Collab — agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. The user runs the IDE; you do the writing.` },
  {
    id: "storage",
    render: () => `## Storage format

Comments are stored INLINE in the \`.md\` file itself — there is no sidecar.

- Anchored spans are paired HTML comments: \`<!--mc:a:ID-->anchored text<!--mc:/a:ID-->\` (ID = 1–12 char base36).
- One block at the end of the file holds one \`<!--mc:t {JSON}-->\` line per thread, fenced by \`<!--mc:threads:begin-->\`/\`<!--mc:threads:end-->\`: \`{"id":"<ID>","quote":"<original anchor text>","status":"open"|"resolved","comments":[Comment, …]}\`.
- Each \`Comment\`: \`{"id":"c<N>","parent"?:"c<N>","author":"<name>","ts":"<ISO-8601 UTC>","body":"<markdown>","editedTs"?:"<ISO-8601 UTC>","deleted"?:true}\`.

**Detection:** the file contains the literal string \`<!--mc:threads:begin-->\` — its absence means no comments yet. A named file with no threads region: if the user asked you to **address** comments, there are none — tell them and stop; if they asked you to **initiate** a thread (opt-in, Phase 5), create the region.`,
    brief: {
      kind: "intro",
      text: "Review threads and suggestions live INLINE in the .md file — `<!--mc:a:ID-->…<!--mc:/a:ID-->` anchor markers plus one `<!--mc:threads:begin-->` block at the end. These tools are the only safe way to change them: never hand-edit a marker or a thread line.",
    },
  },
  {
    id: "change-paths",
    render: changePaths,
    brief: {
      kind: "intro",
      text: "Writes go through the editor (the human can undo them) and are validated first. A refusal means the edit was unsafe — pass `occurrence` for an ambiguous passage; never work around it.",
    },
  },
  {
    id: "discover",
    render: (t) => `## Workflow

### Phase 1 — Discover

Call \`mc_list(file, actionable: true)\`${cliOnly(t, " (CLI: `list <file> --actionable`)")} for the threads still waiting on you — open, last spoken to by someone other than you. Each comes with \`id\`, \`quote\`, \`comments\`, and \`anchoredText\` (the live text between that thread's markers — the passage the reviewer meant). A thread with \`"anchored": false\` has lost its markers; treat \`quote\` as the locator and see Phase 7.

Read the file itself too — the threads are only the part someone commented on.`,
    brief: {
      kind: "step",
      text: "Discover — `mc_list(file, actionable: true)` gives the threads waiting on you, with ids and live anchored text. Read the file too.",
    },
  },
  { id: "plan", render: () => `### Phase 2 — Plan

Group by file. Within a file, order edits by anchor position (earlier first). For each thread, write down: the reviewer's intent, the concrete edit, and whether the anchored passage will be rewritten in place (marker pair must move with it) or removed (markers go away, thread orphans).` },
  {
    id: "edit-reply",
    render: (t) => `### Phase 3 — Edit & reply

For each thread, in order:

1. **Make the prose change.** Rewriting the anchored passage: replace the text *between* the markers with \`mc_rewrite(file, threadId, with: "…")\`${cliOnly(t, ' (CLI: `rewrite <file> <threadId> --with "…"`)')} — updates \`quote\` in the same operation, can't drop or split a marker. Editing prose outside the anchored span: use \`mc_edit\`${cliOnly(t, "/`mdc edit` (or the Edit tool interactively)")}, markers stay put. Removing the anchored passage: delete the open marker, the passage, and the close marker together with \`mc_edit\`${cliOnly(t, "/`mdc edit` (or the Edit tool interactively)")} — \`old\` spans both markers, so nothing is split; the thread orphans and shows as "broken anchor", the correct outcome; do NOT re-anchor to nearby unrelated text.

2. **Append a reply:** \`mc_reply(file, threadId, body: "…")\`${cliOnly(t, ' (CLI: `reply <file> <threadId> --body "…"`)')}. Assigns the next \`c<N>\` id, sets \`author\` to \`"claude"\` and \`ts\` to now, appends to the thread, leaves everything else untouched. Write one or two specific sentences — quote the new wording, name the section or file/function you changed. Don't say "done".

3. **For threads you can't fully address** (ambiguous, missing info, conflicting with another thread), reply explaining what you tried and what you need — don't pretend it's done.`,
    brief: {
      kind: "step",
      text: "Act — `mc_rewrite` changes text inside a thread's anchor; `mc_edit` changes prose outside anchors (an `old` spanning both markers of an anchor deletes that passage: the thread is left unanchored by design — never re-anchor it to nearby text). Then `mc_reply` with one or two specific sentences quoting what changed.",
    },
  },
  { id: "deletion", render: (t) => (t === "headless" ? DELETION_TOOLS_ONLY : `### Phase 4 — Deletion (opt-in)

You only delete or tombstone a thread when the human's body or trailing reply unambiguously asks for it ("delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"):

- Remove the matching \`<!--mc:t {…}-->\` line outright AND remove the matching anchor marker pair from the prose. Both edits in one pass.
- Never delete to "clean up". Never delete just because you addressed a comment — the human resolves.`) },
  { id: "initiate", render: (t) => `### Phase 5 — Initiate a new thread (opt-in)

Only **create** a thread when the human explicitly asks — "leave a comment on X", "flag this for follow-up", "drop a TODO comment here". Never spontaneously, as a reminder to yourself, or mid-maintenance-edit. Works whether the file already has a threads region or not (a fresh file gets one created).

**Pick the passage:** a verbatim, meaningful substring — a word at minimum, usually a sentence. Code spans, frontmatter, and the threads region are refused for you; judge instead whether it's the *right* span and whether wrapping it would split something markdown cares about (a link target, an image alt, a table cell delimiter). **Open it:** \`mc_open(file, quote: "…", body: "…")\`${cliOnly(t, ' (CLI: `open <file> --quote "…" --body "…" [--occurrence N]`)')} — mints an id, wraps the passage, appends the thread line; an ambiguous passage tells you how many matches exist, so re-run with \`occurrence\`. **Verify** with \`mc_check\` (Phase 7).

Adding several threads in one turn? Do them one at a time, re-reading between each — earlier edits shift the offsets the next anchor depends on.` },
  {
    id: "invariants",
    render: (t) => `### Phase 6 — Invariants (inline mode)

These are judgement calls the tools can't make for you. You MUST NOT:

- Change any thread's \`status\` (only the human resolves), or edit any comment other than to APPEND a new one (the record is history).
- Re-anchor an orphaned thread to nearby unrelated text (let it orphan), or move anchor markers without also moving the passage they wrap.
- Initiate a new thread (Phase 5) unless the human explicitly asked — the Review Mode trigger below counts as an explicit ask and unlocks it.
- Edit prose in Review Mode: there you OPEN threads, never modify doc text. Even obvious typos go in a thread unless told to "fix as you go".
- Reformat the threads region (newlines, key order, escaping) for any reason.

The mechanical invariants — \`c<N>\` id sequence, thread ids/quotes staying put, threads-region formatting — ${t === "headless" ? "are enforced by the tools; the judgement calls above are yours." : "are enforced by the tools and CLI, and only yours to maintain when hand-editing (see the appendix)."} Reporting isn't exempt either: quote what changed rather than saying "applied", and never say a comment is addressed when it isn't.`,
    brief: {
      kind: "rule",
      text: "Only the human resolves: never call `mc_resolve`, `mc_accept` or `mc_reject` unless asked. The record is append-only history — add replies, never edit or delete anyone's comments.",
    },
  },
  {
    id: "review-mode",
    render: (t) => `### Review Mode (inline) — Claude as the reviewer

When the human's request matches **Review Mode** trigger phrases — "review this doc", "leave your thoughts on X", "do a review pass on Y", "second pair of eyes on README", "what would you flag in this file", or the Markdown Collab extension's "Ask Agent to Review This Doc" / "Ask Agent to Review These Docs" commands — you switch from addressing existing comments to **initiating** new review threads. The human will triage them in the sidebar. When the prompt names more than one file, read the *Multi-file review passes* section below before starting.

The mechanics are the same as Phase 5: pick a passage, allocate an id, insert paired markers, append a \`<!--mc:t {…}-->\` line with a single \`c1\` comment authored by \`"claude"\`, verify. Read Phase 5 first if you have not — it carries the invariants you must respect when wrapping passages.

#### Focus directive

The prompt may include a \`Focus:\` line — a free-form instruction from the human (e.g. *"check API examples for correctness," "find marketing-y tone," "look for contradictions with the architecture doc"*). When a focus directive is present:

- It is the **primary filter** for what counts as a concern worth a thread. Only flag things that match the focus.
- A general-quality issue that doesn't match the focus does **not** warrant a thread unless it's a hard error (e.g. broken example, factually wrong claim).
- If no concerns match the focus after a careful read, reply (via the send channel, not via a thread) saying so. **Do not fabricate threads to feel productive.**

Without a focus directive, do a general review against the rubric below.

#### Standing conventions

A payload may carry a **Conventions:** block — the project's standing rules (from \`.markdown-collab/conventions.md\`): terminology, tone, house style, and "we know, don't flag it" exceptions.

- They apply to **every** pass, where \`Focus:\` applies to one. Where they pull apart, focus wins on **scope** (what warrants a thread); conventions still hold on **wording**. A convention violation is a legitimate thread even with no matching focus — that's what makes it standing.
- Anything the block lists as known and accepted is **not** a finding — flagging it is the re-litigation the file exists to stop.
- If the human dismisses a thread by stating a rule ("we always write it this way"), **suggest** adding it to the conventions file — don't write to that file yourself, it's theirs.

#### What warrants a thread

Factual error; an unclear claim a reader could plausibly misread; missing context (an undefined term used in passing); a broken example (code that won't run, a wrong flag, a link to a nonexistent file); a contradiction with another section or scoped-in file; a structural issue (order, heading hierarchy, buried info); anything matching the focus directive.

#### What does NOT warrant a thread by default

Pure typos — skip unless the focus is "copy-edit". Style preferences (Oxford comma, sentence length, voice) — skip unless the focus is "tone"/"style". A generic "could be clearer" with no named problem — if you can't name it, you can't anchor it. Restating the anchored text — the body must add something the human doesn't already see.

#### Anchor sizing in Review Mode

- The anchor should be the **smallest passage that makes the comment make sense**. Prefer one sentence over a paragraph. Prefer one phrase over a sentence when the issue is local.
- Avoid wrapping a whole section. If the issue is structural ("this section is in the wrong place"), anchor the section heading line, not the body.
- Anchors must still satisfy Phase 5 constraints: a meaningful span, outside code spans, marker-safe location.

#### Thread body — specificity rule

Every \`c1\` body must name the concern concretely — **good:** *"The claim that \`X\` implies \`Y\` skips intermediate step \`Z\`. Either justify the jump or add the step."* **bad:** *"This could be clearer"* / *"The whole section needs work"* / restating the anchored text with no analysis.

The body should fit in 1–3 sentences. If you need more, split into separate threads on different anchors.

#### Worked examples — good vs bad

These calibrate the rubric. Mirror the *shape* of the good examples; avoid the failure modes in the bad ones.

**Good — concrete factual correction.** Doc says: *"The CLI accepts \`--all\` to include resolved comments."* Code says the flag is \`--include-resolved\`. Anchor the literal \`--all\` token only (smallest meaningful span). Body: *"CLI flag is \`--include-resolved\` per \`cli.ts:142\`, not \`--all\`. Either rename the doc or update the CLI."*

**Good — unclear claim with a named ambiguity.** Doc says: *"The skill triggers on review-mode phrases."* Anchor the sentence. Body: *"\\'Review-mode phrases\\' isn't defined here — the rubric for what counts as one is in Phase 5+. Either inline a one-line definition or link to the Review Mode section."*

**Good — contradiction across sections.** Doc's \`Quick start\` says \`Send to Claude\` is in the right-click menu; doc's \`Commands\` table says it's palette-only. Anchor the quick-start claim (because it's the one that's likely wrong). Body: *"Conflicts with the Commands table, which marks this palette-only as of v0.28. Update one or the other to match reality."*

**Good — structural issue, anchored at a heading.** Doc has a \`## Settings\` heading before \`## Storage layout\`, but Storage explains terms used in Settings. Anchor the \`## Settings\` heading. Body: *"Settings references the \`<!--mc:threads:begin-->\` marker introduced in Storage layout below. Move Storage layout above Settings, or forward-link explicitly."*

**Bad — vague.** *"This could be clearer."* No anchored specifics, no named problem, nothing the human can act on without re-deriving the concern. Either name the specific issue or skip.

**Bad — anchor too wide.** Anchoring an entire 8-paragraph section because *"the whole section needs work."* The human can't tell which sentence drove the comment. Pick the single sentence (or heading) that crystallizes the issue.

**Bad — restating the anchor.** Anchored: *"Channels need MCP."* Body: *"This sentence is about channels needing MCP."* Adds nothing the reader doesn't see. Either explain *why* the claim is problematic (it's incomplete? wrong? unclear in this context?) or skip.

**Bad — opinion presented as fact.** *"This intro is too marketing-y."* — only valid if the focus directive explicitly asks for tone. Without that, style preferences aren't a substantive concern.

**Bad — fix dressed as a comment.** Body: *"I changed this to X."* You don't edit prose in Review Mode. Open a thread proposing the change in the body; let the human accept it.

#### No upper bound on thread count

There is **no maximum number of threads** per review pass. Leave a thread for every substantive concern that fits the focus directive (or the general rubric, if no focus was given). If you find 30 issues, leave 30 threads. The human triages with the sidebar UI; your job is signal, not curation.

Do not "leave the top N" — dropping findings to hit a count target risks suppressing the one that matters most.

#### Honest empty result

If you read the doc carefully and find no concerns that match the focus (or no general-rubric concerns if no focus was given), say so explicitly via the send channel. Do **not** open a thread to comment "looks good" — threads are for actionable concerns. A short reply of *"Reviewed \`<path>\` against focus \`<focus>\`. No concerns found."* is the correct outcome.

#### Delta passes — "review changes since last pass"

A prompt may ask you to review **only what changed since your last pass**. It names the changed sections, includes their current text, and lists the threads that already exist.

Do not review unchanged prose — it was reviewed already, and re-raising it is noise in the triage queue. Cross-reference by id instead of duplicating: if a concern is already covered by a listed thread, reply there rather than opening a second one. A resolved thread is settled — don't raise it again unless the new text genuinely reintroduces the problem, and say which thread it was ("this brings back the issue from a1b2c") when it does. Threads flagged "text changed" first, since their passage was edited and the concern may already be handled or moved. Unchanged text is fair game only when the change made it wrong — say why in the body. Finish with \`mc_check\` as always — it's what makes the *next* delta pass possible.

#### Multi-file review passes

A Review Mode prompt may name **several files** instead of one — the extension's "Ask Agent to Review These Docs" command builds one pass over a folder or a multi-select. The prompt lists the files; treat that list as the work order.

1. **Read every listed file end to end before opening any thread** — you can't judge cross-file consistency otherwise, and a thread opened in file 1 may be answered by file 3. Then open threads file by file, in the order listed (same Phase 5 mechanics; ids unique only within their own file).
2. **Cross-document consistency is part of the pass**, not an optional extra: terminology drift, a claim in one file contradicted by another, duplicated guidance that's diverged, cross-references that no longer resolve. Anchor such a thread in the file that's wrong (or the more prominent one), quoting the other file's conflicting text — the human is reading without it open.
3. **Focus and the no-upper-bound rule apply per pass, not per file.** Verify each file with \`mc_check\` before moving to the next — cheaper to catch a broken marker in file 1 before editing files 2 and 3 — and report per file, with cross-document findings called out separately.

#### Workflow — Review Mode pass, in short

Read the doc end to end first. Initiate threads one at a time, in document order, with \`mc_open\`${cliOnly(t, "/`mdc open`")} — never edit prose. Narrate long passes with \`mc_status\`. Verify with \`mc_check\`, which also ends the human's wait.`,
    brief: {
      kind: "rule",
      text: "Review mode (\"review this doc\"): open a thread with `mc_open` for every substantive concern and never edit prose. There is no upper bound on threads — never drop findings to hit a count.",
    },
  },
  {
    id: "verify",
    render: (t) => `### Phase 7 — Verify, and end the pass

Finish every file you touched with \`mc_check(file)\`${cliOnly(t, " (CLI: `check <file>`)")}. \`"ok": true\` means every marker is paired, every thread is anchored, and every thread line is valid JSON; otherwise you get the list — unpaired markers, orphaned anchors, unanchored threads, empty quotes, malformed thread JSON, duplicate ids — each saying whether it's \`repairable\`${cliOnly(t, " (the CLI also exits `2`)")}.

This call does double duty: it's your correctness check, **and** it's how the extension learns your pass on that file is over — clearing the "Claude is working…" row the human is watching. Skip it and they're left watching a spinner for work you already finished.

${t === "headless" ? VERIFY_DAMAGE_TOOLS_ONLY : VERIFY_DAMAGE_WITH_CLI} One case is not damage: **a thread whose passage you deliberately removed is expected to be unanchored.** Deletions become orphans by design — report it, don't "fix" it by re-anchoring to unrelated text.

Then confirm, from \`mc_list\`, that each addressed thread ends with your comment and is still \`"status":"open"\`.`,
    brief: {
      kind: "step",
      text: "Verify — `mc_check(file)` LAST on every file you touched: it is the integrity check, and it ends the human's wait. `mc_status(note)` narrates a long pass.",
    },
  },
  {
    id: "suggest-mode",
    render: (t) => `## Suggest Mode — propose edits instead of applying them

When the human asks you to **suggest** or **propose** changes rather than make them ("suggest edits", "don't apply, let me accept them", or a send payload requesting suggest mode), do NOT edit the prose directly — every change becomes a pending suggestion via \`mc_suggest(file, quote: "…", with: "…", note: "why")\`${cliOnly(t, ' (CLI: `suggest <file> --quote "…" --with "…" --note "…"`)')}.

The original text stays in the file; the proposal is recorded separately. \`${t === "headless" ? "note" : "--note"}\` is your rationale, shown on the suggestion card — always include it. Same anchoring rules as opening a thread: ambiguous, or in code/frontmatter/the threads region, gets refused — pass \`occurrence\` or pick a different span. One suggestion per contiguous change, re-reading between several so offsets stay valid. **Do NOT accept or reject your own suggestions** — that's the human's call in the review UI, only on explicit instruction. Verify with \`mc_check\` and \`mc_list\` (reports each suggestion's \`original\` and \`proposed\`).

Mutually exclusive with direct edits per request: if the human wants suggestions, route ALL changes through \`${t === "headless" ? "mc_suggest" : "suggest"}\`, never mix in a few direct edits. Review Mode is unaffected — it never edits prose at all.`,
    brief: {
      kind: "rule",
      text: "Suggest mode: route every change through `mc_suggest` (with a `note`) — no direct edits at all.",
    },
  },
  // When a skill loader should pick the skill up. Nothing to trigger in a
  // headless run.
  { id: "when-applies", render: (t) => (t === "headless" ? null : `## When this skill applies

Invoke when:
- The user names one or more \`.md\` files and asks you to act on review comments / feedback / notes.
- The user says "address the markdown collab comments" without naming files (operate workspace-wide).
- The user references a specific comment thread or quote and asks you to apply / respond.`) },
  { id: "maintenance", render: (t) => (t === "headless" ? MAINTENANCE_TOOLS_ONLY : `## Anchor maintenance applies on EVERY \`.md\` edit, not just comment-driven ones

Whenever you modify a \`.md\` file in a Markdown Collab workspace — for any reason, not only when addressing review comments — reconcile that file's anchors after the edit. Rewording a sentence, refactoring a heading, fixing a typo: any of these can break an existing anchor.

After your Edit, run \`mc_check\` (or \`mdc check <file>\`) — it reports every unpaired, dropped, or duplicated marker an ordinary prose edit introduces; fix anything it reports.${t === "plugin" ? " This plugin also runs that check after every Edit and Write, and tells you when one broke a marker." : ""} For each thread whose markers are still paired: if you **rewrote the passage in place**, keep the markers on the new wording (\`mc_rewrite\`/\`mdc rewrite\` can't drop a marker); if you **removed the passage**, both markers should be gone and the thread surfaces as unanchored — correct, don't re-add markers to wrap unrelated nearby text. Do NOT change any \`<!--mc:t {…}-->\` line during maintenance — only the human reviewer and the reply workflow append to threads. This applies whether or not a review batch was active.`) },
  // A headless run is handed the tools; there is nothing to go and get.
  { id: "getting-tools", render: (t) => (t === "headless" ? null : `## Getting the MCP tools (if you don't have them)

If \`mc_list\` and friends aren't in your tool list, add them with **Markdown Collab: Connect an Agent…** → Claude Code, then restart. They only exist while that VS Code window stays open; elsewhere, or with MCP disabled by policy, use the \`mdc\` CLI instead — not degraded, just different.`) },
  { id: "reporting", render: () => `## Reporting

Tell the user, per file, using each thread's id (1–12 char base36) so they can find it in VS Code: threads addressed (+ one-line summary of each change), threads initiated on explicit request (+ anchored passage + the note you left), threads deleted on explicit request, threads left unanchored/orphaned because their target was removed (+ why), threads answered without a prose change (+ the question you replied with), and anything you skipped and why.` },
  // Edit-tool marker surgery: meaningless where there is no Edit tool.
  { id: "appendix", render: (t) => (t === "headless" ? null : `## Appendix: hand-editing markers (last resort)

**Only when neither the \`markdown-collab\` MCP tools ${t === "plugin" ? "nor the `mdc` CLI is" : "nor `mdc.mjs` is"}
available.** Everything below is string surgery on a format that is unforgiving
about it — one dropped \`-->\` silently orphans a reviewer's comment. If either
path exists, use it instead; if one comes back mid-task, switch to it and run a
check.

**Rewriting an anchored passage.** Put the markers *inside* your Edit:
\`old_string\` = open marker + old passage + close marker; \`new_string\` = the same
open marker + the NEW passage + the same close marker. Do NOT Edit the bare
visible text — the markers sit flush against it, so a bare-text \`old_string\`
either fails to match or eats a marker.

- \`old_string\`: \`### <!--mc:a:aopzy-->Main business flows<!--mc:/a:aopzy-->\`
- \`new_string\`: \`### <!--mc:a:aopzy-->Core business processes<!--mc:/a:aopzy-->\`

Same id, both markers kept, only the wrapped text changed. Then update that
thread's \`quote\` field to the new text.

**Appending a reply.** Locate the matching \`<!--mc:t {…}-->\` line by its
\`"id":"<thread-id>"\` and Edit only that line — append a comment object at the
END of the \`comments\` array with the next sequential \`c<N>\` id, \`"parent"\` set
to the last non-deleted comment's id, \`"author":"claude"\`, an ISO-8601 UTC
\`"ts"\`, and your \`"body"\`. Preserve the JSON exactly otherwise: same key order,
same escaping, same trailing \`-->\`, all on one line. **Do NOT change \`status\`.**
**Do NOT mutate any existing comment.**

**Opening a thread.** Pick a 5-char lowercase base36 id (\`[a-z0-9]{5}\`) unique
across every \`<!--mc:a:ID-->\` marker and every \`"id":"…"\` in existing thread
lines. Edit the passage to \`<!--mc:a:ID-->\` + passage + \`<!--mc:/a:ID-->\` with no
extra whitespace, then insert a line just before \`<!--mc:threads:end-->\` (or
append a fresh region at the end of the file):

\`\`\`

<!--mc:threads:begin-->
<!--mc:t {"id":"ID","quote":"<anchored text>","status":"open","comments":[{"id":"c1","author":"claude","ts":"<ISO-8601 UTC>","body":"<your note>"}]}-->
<!--mc:threads:end-->
\`\`\`

The thread JSON must be on a single line. \`quote\` is the verbatim anchored text.
\`status\` is always \`"open"\` — never seed a thread as resolved. Adding several
threads means re-reading between each one, because earlier edits shift the
offsets the next anchor depends on.

**Verifying by hand.** Re-read the threads region and confirm: each addressed
thread ends with your comment; every rewritten passage still has exactly one
matched marker pair; removed passages have both markers gone; opt-in deletions
removed both the thread line and the marker pair; any thread you initiated has a
paired marker plus a valid single-\`c1\` thread line with a unique id. Search for
\`<!--mc:a:\` and \`<!--mc:/a:\` — every opener needs a closer with the same id.

Hand-edits skip the two things the other paths give you for free: the pre-write
integrity check, and the signal that ends the human's "Claude is working…" wait.
Say in your report that you worked without them.`) },
];

/**
 * The skill for one target. `legacy` is `~/.claude/skills/vs-markdown-collab/SKILL.md`,
 * `plugin` is the plugin's `skills/review/SKILL.md`, `headless` is the
 * tools-only workflow (no frontmatter, no CLI, no Edit tool) that a headless
 * run's system prompt carries and `mc_help` returns.
 */
export function renderSkill(t: SkillTarget): string {
  const parts: string[] = [];
  for (const s of SECTIONS) {
    const text = s.render(t);
    if (text !== null) parts.push(text);
  }
  return `${parts.join("\n\n")}\n`;
}

/**
 * Prepended to the headless rendering for a headless run. It says which paths
 * exist in this session, so Claude doesn't spend turns reaching for tools it
 * lacks. Not part of `mc_help`'s text: another agent calling that tool is not
 * running headless, and has whatever tools its own client gives it.
 */
export const HEADLESS_PREAMBLE =
  "You are running non-interactively inside the Markdown Collab VS Code extension. " +
  "Your only tools are Read, Glob, Grep and the markdown-collab MCP tools. " +
  "There is no Edit/Write/Bash: use mc_edit for prose outside anchored spans, " +
  "mc_rewrite inside them, mc_suggest in suggest mode. Finish every file you touched with mc_check. " +
  "Your final message is shown to the human as your report — keep it to the per-file summary the " +
  "Reporting section describes.";

/** The system prompt for a headless run: the preamble, then the tools-only skill. */
export function headlessSystemPrompt(): string {
  return `${HEADLESS_PREAMBLE}\n\n${renderSkill("headless")}`;
}

/** The ceiling on `instructions`: small enough that a client can inline it unread. */
export const MCP_INSTRUCTIONS_MAX_CHARS = 2000;

/**
 * The MCP `initialize` result's `instructions`: the workflow in brief, from the
 * sections' own one-line summaries, for a client that connects with no skill
 * installed. Everything else is one `mc_help` call away.
 */
export function renderMcpInstructions(): string {
  const of = (kind: Brief["kind"]): string[] =>
    SECTIONS.flatMap((s) => (s.brief && s.brief.kind === kind ? [s.brief.text] : []));
  return [
    `Markdown Collab review tools. ${of("intro").join(" ")}`,
    ["Workflow, per file:", ...of("step").map((text, i) => `${i + 1}. ${text}`)].join("\n"),
    ["Rules:", ...of("rule").map((text) => `- ${text}`)].join("\n"),
    "Call `mc_help` for the full workflow — review-mode rubric, suggest mode, multi-file passes, reporting.",
  ].join("\n\n");
}
