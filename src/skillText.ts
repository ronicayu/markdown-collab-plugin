// The review workflow, for every place an agent reads it.
//
// Agents that can run a command — Claude Code with the plugin or the
// standalone skill, and every agent Connect gives the skill in
// `~/.agents/skills/` — get one short skill whose single rule is "change a
// reviewed file only with `mdc`" (\`compactSkill\`). The review rubric is not
// in it: it is printed by \`mdc help review\` when a review pass needs it, so
// it costs nothing on the turns that only answer comments.
//
// A headless run has no shell, only the MCP tools, so it keeps the full
// tools-only workflow below as its system prompt (and \`mc_help\` returns it);
// the MCP server's \`instructions\` are the sections' one-line briefs. The
// rubric itself is written once (\`reviewRubric\`) and rendered for both.
//
// Pure — no fs, no vscode. Imported by the skill installers, the headless
// runner, the MCP server, the \`mdc\` bundle, and scripts/build-plugin.mjs.

export type SkillTarget = "legacy" | "plugin" | "agents" | "headless";

/** The standalone skill's name, and its directory under `~/.claude/skills/`. */
export const LEGACY_SKILL_NAME = "vs-markdown-collab";
/** The plugin's name — every component in it is namespaced under this. */
export const PLUGIN_NAME = "markdown-collab";
/** The skill's name inside the plugin: `/markdown-collab:review`. */
export const PLUGIN_SKILL_NAME = "review";

const SKILL_NAMES: Record<Exclude<SkillTarget, "headless">, string> = {
  legacy: LEGACY_SKILL_NAME,
  plugin: PLUGIN_SKILL_NAME,
  agents: PLUGIN_NAME,
};

/** How each skill's reader runs `mdc`. */
export const MDC_INVOCATION: Record<Exclude<SkillTarget, "headless">, string> = {
  // The plugin's `bin/` is on PATH while it is enabled.
  plugin: "mdc",
  legacy: "node ~/.claude/skills/vs-markdown-collab/mdc.mjs",
  agents: "node ~/.agents/skills/markdown-collab/mdc.mjs",
};

/** The verbs the rubric names, for the reader's own way of acting. */
interface RubricVerbs {
  check: string;
  anchorRules: string;
  openMechanics: string;
}

const TOOL_VERBS: RubricVerbs = {
  check: "mc_check",
  anchorRules: "Phase 5 constraints",
  openMechanics: "same Phase 5 mechanics",
};

const CLI_VERBS: RubricVerbs = {
  check: "mdc check",
  anchorRules: "the anchoring rules `open` enforces",
  openMechanics: "same `open` mechanics",
};

/** What makes a good review pass: focus, what to flag, anchors, bodies, the cap, delta and multi-file passes. */
function reviewRubric(v: RubricVerbs): string {
  return `#### Focus directive

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
- Anchors must still satisfy ${v.anchorRules}: a meaningful span, outside code spans, marker-safe location.

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

#### Rank, cap at five, then summarize

Rank concerns by severity and open threads for the **five** that matter most. Put everything else in one summary thread anchored to the document's title (its first \`#\` heading, or the very first line when it has none): \`Also noticed (N): …\`, one line per item naming its passage — so the human can read it and say "open 3 and 7" for exactly the ones they want promoted. The \`Focus:\` line can override the cap explicitly ("give me ten", "everything"); absent that, five is it, whether the pass turns up six issues or sixty.

Don't drop a finding to make the cap — every concern still reaches the human, in its own thread if it's top five, in the summary line otherwise. The human triages with the sidebar UI; your job is signal, ranked.

#### Honest empty result

If you read the doc carefully and find no concerns that match the focus (or no general-rubric concerns if no focus was given), say so explicitly via the send channel. Do **not** open a thread to comment "looks good" — threads are for actionable concerns. A short reply of *"Reviewed \`<path>\` against focus \`<focus>\`. No concerns found."* is the correct outcome.

#### Delta passes — "review changes since last pass"

A prompt may ask you to review **only what changed since your last pass**. It names the changed sections, includes their current text, and lists the threads that already exist.

Do not review unchanged prose — it was reviewed already, and re-raising it is noise in the triage queue. Cross-reference by id instead of duplicating: if a concern is already covered by a listed thread, reply there rather than opening a second one. A resolved thread is settled — don't raise it again unless the new text genuinely reintroduces the problem, and say which thread it was ("this brings back the issue from a1b2c") when it does. Threads flagged "text changed" first, since their passage was edited and the concern may already be handled or moved. Unchanged text is fair game only when the change made it wrong — say why in the body. Finish with \`${v.check}\` as always — it's what makes the *next* delta pass possible.

#### Multi-file review passes

A Review Mode prompt may name **several files** instead of one — the extension's "Ask Agent to Review These Docs" command builds one pass over a folder or a multi-select. The prompt lists the files; treat that list as the work order.

1. **Read every listed file end to end before opening any thread** — you can't judge cross-file consistency otherwise, and a thread opened in file 1 may be answered by file 3. Then open threads file by file, in the order listed (${v.openMechanics}; ids unique only within their own file).
2. **Cross-document consistency is part of the pass**, not an optional extra: terminology drift, a claim in one file contradicted by another, duplicated guidance that's diverged, cross-references that no longer resolve. Anchor such a thread in the file that's wrong (or the more prominent one), quoting the other file's conflicting text — the human is reading without it open.
3. **Focus applies per pass; the five-thread cap applies per file.** Each file gets its own top five and its own summary thread for the rest — not one shared cap or one shared summary across the whole pass. Verify each file with \`${v.check}\` before moving to the next — cheaper to catch a broken marker in file 1 before editing files 2 and 3 — and report per file, with cross-document findings called out separately.`;
}

/**
 * The reviewer's guide `mdc help review` prints: the rubric, for an agent
 * that acts through `mdc`. Read at the start of a review pass.
 */
export function renderReviewGuide(): string {
  return `# Reviewing a document with Markdown Collab

You are the reviewer: you open threads on passages for the human to triage, and you never edit the prose — not even an obvious typo (open a thread on it). Read the whole document first, then open threads one at a time, in document order, with \`mdc open <file> --quote "…" --body "…"\` — re-reading between them, since each one moves the text after it. Finish every file with \`mdc check <file>\`, which also ends the human's "Waiting for the agent…" row.

${reviewRubric(CLI_VERBS).replace(/^#### /gm, "## ")}
`;
}

/**
 * The skill for an agent that can run \`mdc\`. One rule, the commands, the
 * workflow in brief; the rubric is one command away.
 */
function compactSkill(t: Exclude<SkillTarget, "headless">): string {
  const mdc = MDC_INVOCATION[t];
  const who = t === "agents" ? "you" : "Claude";
  const author =
    t === "agents"
      ? ` Pass \`--author <your name>\` (e.g. \`codex\`, \`cursor\`) to \`reply\`, \`open\` and \`suggest\`, so the human sees who wrote it.`
      : "";
  const guard =
    t === "plugin"
      ? " This plugin also refuses an Edit or Write that would change a marker or thread line, and names the command to use."
      : "";
  const legacy = t === "legacy" ? " If you are not Claude Code and have a \`markdown-collab\` skill, use that one instead of this." : "";
  return `---
name: ${SKILL_NAMES[t]}
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace, AND for reviewing Markdown docs by leaving review comments for the human. Comments are stored INLINE in the .md file itself (look for \`<!--mc:threads:begin-->\`). TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document — trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md". ALSO TRIGGER on review-mode requests where the user asks YOU to play reviewer — "review this doc", "leave your thoughts on README", "do a review pass on docs/spec.md", "second pair of eyes on this", "what would you flag in this file", "review the markdown collab doc on X".
---

# Markdown Collab — review comments in Markdown files

The human reviews Markdown with the Markdown Collab extension in their editor; ${who === "you" ? "you do" : "Claude does"} the writing.${legacy} Comments live inside the \`.md\` file: \`<!--mc:a:ID-->…<!--mc:/a:ID-->\` markers around each commented passage, and a \`<!--mc:threads:begin-->\` block at the end with one \`<!--mc:t {JSON}-->\` line per thread. A file without \`<!--mc:threads:begin-->\` has no comments.

## The one rule: change a reviewed file only with \`mdc\`

One dropped \`-->\` silently orphans a reviewer's comment, so never edit a marker or a thread line yourself — not with an Edit tool, not with \`sed\`, not by rewriting the file. Every change to a reviewed file goes through \`mdc\`, which runs the editor's own engine: \`${mdc} <command> <file> …\`. It validates before it writes and refuses rather than guesses; when the file is open in the editor it writes through it, so the human can undo.${guard} Plain prose that no marker touches may still be edited as usual.

If \`mdc\` won't run (no \`node\`, or the command isn't there), stop and tell the human — ask them to run **Markdown Collab: Connect an Agent** — instead of editing markers by hand. (If the \`markdown-collab\` MCP tools are in your tool list, their \`mc_*\` tools are the same engine: either is fine.)

| \`${mdc} …\` | Does |
| --- | --- |
| \`list <file> [--actionable]\` | Threads and pending suggestions as JSON, with each thread's live anchored text. \`--actionable\`: only open threads whose last comment isn't yours. |
| \`reply <file> <threadId> --body TEXT\` | Append your reply to a thread. |
| \`rewrite <file> <threadId> --with TEXT\` | Replace the commented passage; markers kept, \`quote\` updated. |
| \`edit <file> --old TEXT --new TEXT [--occurrence N]\` | Replace exact text outside commented passages. An \`--old\` that spans both markers of a passage deletes it. |
| \`open <file> --quote TEXT --body TEXT [--occurrence N]\` | Open a new thread on a passage. |
| \`suggest <file> --quote TEXT --with TEXT --note TEXT [--occurrence N]\` | Propose an edit for the human to accept or reject. |
| \`resolve <file> <threadId>\` | Resolve a thread — only when the human asks. |
| \`check <file> [--repair]\` | Integrity check. **Run it last on every file you touched**: it also ends the human's "Waiting for the agent…" row. \`--repair\` fixes what it safely can. |
| \`help review\` | The reviewer's rubric — read it before a review pass. |

Output is JSON. A refusal (\`{"ok":false,"code":…,"message":…}\`) changed nothing: an ambiguous passage wants \`--occurrence\`; \`conflict\` means the file changed meanwhile — run it again. Never work around a refusal.${author}

## Addressing comments

1. \`list <file> --actionable\`, and read the file itself.
2. For each thread, in document order: make the change — \`rewrite\` inside the commented passage, \`edit\` outside it. Removing the passage leaves the thread unanchored, which is correct: never re-anchor it to nearby text. Then \`reply\` in one or two specific sentences quoting what changed — not "done". Can't address it? Reply with what you tried and what you need.
3. \`check\` each file you touched, last.

Only the human resolves, accepts or rejects. The thread record is history: reply, never edit or delete anyone's comment; if the human asks for a thread to go, reply that it can and they remove it. Open a new thread only when asked — a review request counts.

## Suggesting instead of editing

When the request asks for suggestions ("suggest edits", "as suggestions"), make every change with \`suggest\` — no direct edits at all. One suggestion per sentence or list item, re-reading between them; always say why in \`--note\`; never accept or reject your own. A rewrite that can't be split goes in a comment instead.

## Reviewing a document

When asked to review ("review this doc", "second pair of eyes", the extension's Ask Agent to Review), you open threads and never edit prose. Run \`${mdc} help review\` first and follow it.

## Reporting

Per file, by thread id: what you changed (quote it), the threads you opened, threads left unanchored and why, and anything you skipped and why. Never call a comment addressed when it isn't.
`;
}

/**
 * How a section appears in the compact MCP `instructions`: an opening line, a
 * numbered workflow step, or a rule.
 */
interface Brief {
  kind: "intro" | "step" | "rule";
  text: string;
}

interface SkillSection {
  id: string;
  text: string;
  /** The section's rule in a line, for the MCP `instructions` (≤ 2 KB in total). */
  brief?: Brief;
}

/** The tools-only workflow of a headless run, which has no shell and no Edit tool. */
const SECTIONS: readonly SkillSection[] = [
  {
    id: "intro",
    text: `# Markdown Collab — agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. The user runs the IDE; you do the writing.`,
  },
  {
    id: "storage",
    text: `## Storage format

Comments are stored INLINE in the \`.md\` file itself — there is no sidecar.

- Anchored spans are paired HTML comments: \`<!--mc:a:ID-->anchored text<!--mc:/a:ID-->\` (ID = 1–12 char base36).
- One block at the end of the file holds one \`<!--mc:t {JSON}-->\` line per thread, fenced by \`<!--mc:threads:begin-->\`/\`<!--mc:threads:end-->\`: \`{"id":"<ID>","quote":"<original anchor text>","status":"open"|"resolved","comments":[Comment, …]}\`.
- Each \`Comment\`: \`{"id":"c<N>","parent"?:"c<N>","author":"<name>","ts":"<ISO-8601 UTC>","body":"<markdown>","editedTs"?:"<ISO-8601 UTC>","deleted"?:true}\`.

**Detection:** the file contains the literal string \`<!--mc:threads:begin-->\` — its absence means no comments yet. A named file with no threads region: if the user asked you to **address** comments, there are none — tell them and stop; if they asked you to **initiate** a thread (opt-in, Phase 5), create the region.`,
    brief: { kind: "intro", text: "Review threads and suggestions live INLINE in the .md file — `<!--mc:a:ID-->…<!--mc:/a:ID-->` anchor markers plus one `<!--mc:threads:begin-->` block at the end. These tools are the only safe way to change them: never hand-edit a marker or a thread line." },
  },
  {
    id: "change-paths",
    text: `## How to change a document — the tools

Marker surgery by hand is the single most common way this workflow breaks: one dropped \`-->\` silently orphans a reviewer's comment. So you never hand-edit a marker or a thread line — every change goes through the **MCP tools**, which run the *same* engine the editor itself uses: edits go through the editor, undoable with Cmd+Z, validated before they land.

| MCP tool | What it does |
| --- | --- |
| \`mc_list(file, actionable?)\` | Threads and pending suggestions as JSON, including each thread's live anchored text. The actionable flag keeps only open threads whose last comment is not yours. |
| \`mc_reply(file, threadId, body)\` | Appends a reply authored by \`claude\` with the correct \`c<N>\` id and timestamp. |
| \`mc_rewrite(file, threadId, with)\` | Replaces the text between a thread's markers and updates its \`quote\`. Both markers are preserved by construction. |
| \`mc_edit(file, old, new, occurrence?)\` | Replaces exact text outside anchored spans (prose, frontmatter), or deletes an anchored passage when \`old\` spans both of its markers. Refuses anything that splits a marker pair or touches the threads region — use \`mc_rewrite\` inside an anchor. |
| \`mc_open(file, quote, body, occurrence?)\` | Opens a new thread on a passage: mints a unique id, wraps the passage, appends the thread line. |
| \`mc_resolve(file, threadId)\` | Marks a thread resolved. Only when the human asks. |
| \`mc_suggest(file, quote, with, note?, occurrence?)\` | Proposes an edit without applying it (suggest mode). Keeps the original in the prose. |
| \`mc_accept(file, anchorId)\` / \`mc_reject(file, anchorId)\` | Apply / drop a pending suggestion. Normally the human's call in the UI. |
| \`mc_check(file)\` | Integrity report. **Run this last on every file you touched** — see below. |
| \`mc_status(note, file?)\` | Say what you're doing right now ("reading 2 of 3 files", "opening threads on §Setup"). |

Two of these do more than they look like they do: **\`mc_check\` ends the pass** — the extension shows the human a "Waiting for the agent…" row on every thread it sent you, and your closing \`mc_check\` on a file is what clears it; skip it and they're left watching a spinner for work you already finished. **\`mc_status\` is free and worth it** — a review pass over three files is minutes of silence otherwise, and one short present-tense phrase per phase shows up next to the indicator and in the status bar.

Ordinary prose edits — text outside an anchored span — use \`mc_edit\`, which refuses anything that would break a marker or touch the threads region. Every mutating tool validates before writing and refuses a change that would introduce a new integrity problem, so a refused call leaves the file untouched rather than half-edited.

**The tools refuse rather than guess.** Ambiguous passage (appears more than once)? Pass the occurrence. Inside a code span? Choose a different anchor. The file kept changing under the call (\`conflict\`)? Nothing was written — re-read it with \`mc_list\` and make the call again. Never work around a refusal — it's telling you the edit was unsafe.`,
    brief: { kind: "intro", text: "Writes go through the editor (the human can undo them) and are validated first. A refusal means the edit was unsafe — pass `occurrence` for an ambiguous passage; never work around it." },
  },
  {
    id: "discover",
    text: `## Workflow

### Phase 1 — Discover

Call \`mc_list(file, actionable: true)\` for the threads still waiting on you — open, last spoken to by someone other than you. Each comes with \`id\`, \`quote\`, \`comments\`, and \`anchoredText\` (the live text between that thread's markers — the passage the reviewer meant). A thread with \`"anchored": false\` has lost its markers; treat \`quote\` as the locator and see Phase 7.

Read the file itself too — the threads are only the part someone commented on.`,
    brief: { kind: "step", text: "Discover — `mc_list(file, actionable: true)` gives the threads waiting on you, with ids and live anchored text. Read the file too." },
  },
  {
    id: "plan",
    text: `### Phase 2 — Plan

Group by file. Within a file, order edits by anchor position (earlier first). For each thread, write down: the reviewer's intent, the concrete edit, and whether the anchored passage will be rewritten in place (marker pair must move with it) or removed (markers go away, thread orphans).`,
  },
  {
    id: "edit-reply",
    text: `### Phase 3 — Edit & reply

For each thread, in order:

1. **Make the prose change.** Rewriting the anchored passage: replace the text *between* the markers with \`mc_rewrite(file, threadId, with: "…")\` — updates \`quote\` in the same operation, can't drop or split a marker. Editing prose outside the anchored span: use \`mc_edit\`, markers stay put. Removing the anchored passage: delete the open marker, the passage, and the close marker together with \`mc_edit\` — \`old\` spans both markers, so nothing is split; the thread orphans and shows as "broken anchor", the correct outcome; do NOT re-anchor to nearby unrelated text.

2. **Append a reply:** \`mc_reply(file, threadId, body: "…")\`. Assigns the next \`c<N>\` id, sets \`author\` to \`"claude"\` and \`ts\` to now, appends to the thread, leaves everything else untouched. Write one or two specific sentences — quote the new wording, name the section or file/function you changed. Don't say "done".

3. **For threads you can't fully address** (ambiguous, missing info, conflicting with another thread), reply explaining what you tried and what you need — don't pretend it's done.`,
    brief: { kind: "step", text: "Act — `mc_rewrite` changes text inside a thread's anchor; `mc_edit` changes prose outside anchors (an `old` spanning both markers of an anchor deletes that passage: the thread is left unanchored by design — never re-anchor it to nearby text). Then `mc_reply` with one or two specific sentences quoting what changed." },
  },
  {
    id: "deletion",
    text: `### Phase 4 — Deletion (opt-in)

You only delete a thread when the human's body or trailing reply unambiguously asks for it ("delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"). There is no tool for removing a thread record — reply that it can go and list it in your report; the human deletes it from the review view.

- Never delete to "clean up". Never delete just because you addressed a comment — the human resolves.`,
  },
  {
    id: "initiate",
    text: `### Phase 5 — Initiate a new thread (opt-in)

Only **create** a thread when the human explicitly asks — "leave a comment on X", "flag this for follow-up", "drop a TODO comment here". Never spontaneously, as a reminder to yourself, or mid-maintenance-edit. Works whether the file already has a threads region or not (a fresh file gets one created).

**Pick the passage:** a verbatim, meaningful substring — a word at minimum, usually a sentence. Code spans, frontmatter, and the threads region are refused for you; judge instead whether it's the *right* span and whether wrapping it would split something markdown cares about (a link target, an image alt, a table cell delimiter). **Open it:** \`mc_open(file, quote: "…", body: "…")\` — mints an id, wraps the passage, appends the thread line; an ambiguous passage tells you how many matches exist, so re-run with \`occurrence\`. **Verify** with \`mc_check\` (Phase 7).

Adding several threads in one turn? Do them one at a time, re-reading between each — earlier edits shift the offsets the next anchor depends on.`,
  },
  {
    id: "invariants",
    text: `### Phase 6 — Invariants (inline mode)

These are judgement calls the tools can't make for you. You MUST NOT:

- Change any thread's \`status\` (only the human resolves), or edit any comment other than to APPEND a new one (the record is history).
- Re-anchor an orphaned thread to nearby unrelated text (let it orphan), or move anchor markers without also moving the passage they wrap.
- Initiate a new thread (Phase 5) unless the human explicitly asked — the Review Mode trigger below counts as an explicit ask and unlocks it.
- Edit prose in Review Mode: there you OPEN threads, never modify doc text. Even obvious typos go in a thread unless told to "fix as you go".
- Reformat the threads region (newlines, key order, escaping) for any reason.

The mechanical invariants — \`c<N>\` id sequence, thread ids/quotes staying put, threads-region formatting — are enforced by the tools; the judgement calls above are yours. Reporting isn't exempt either: quote what changed rather than saying "applied", and never say a comment is addressed when it isn't.`,
    brief: { kind: "rule", text: "Only the human resolves: never call `mc_resolve`, `mc_accept` or `mc_reject` unless asked. The record is append-only history — add replies, never edit or delete anyone's comments." },
  },
  {
    id: "review-mode",
    text: `### Review Mode (inline) — Claude as the reviewer

When the human's request matches **Review Mode** trigger phrases — "review this doc", "leave your thoughts on X", "do a review pass on Y", "second pair of eyes on README", "what would you flag in this file", or the Markdown Collab extension's "Ask Agent to Review This Doc" / "Ask Agent to Review These Docs" commands — you switch from addressing existing comments to **initiating** new review threads. The human will triage them in the sidebar. When the prompt names more than one file, read the *Multi-file review passes* section below before starting.

The mechanics are the same as Phase 5: pick a passage, allocate an id, insert paired markers, append a \`<!--mc:t {…}-->\` line with a single \`c1\` comment authored by \`"claude"\`, verify. Read Phase 5 first if you have not — it carries the invariants you must respect when wrapping passages.\n\n${reviewRubric(TOOL_VERBS)}\n\n#### Workflow — Review Mode pass, in short

Read the doc end to end first. Initiate threads one at a time, in document order, with \`mc_open\` — never edit prose. Narrate long passes with \`mc_status\`. Verify with \`mc_check\`, which also ends the human's wait.`,
    brief: { kind: "rule", text: "Review mode (\"review this doc\"): open a thread with `mc_open` for the five most severe concerns, then one summary thread for the rest (\"Also noticed (N): …\"). Never edit prose." },
  },
  {
    id: "verify",
    text: `### Phase 7 — Verify, and end the pass

Finish every file you touched with \`mc_check(file)\`. \`"ok": true\` means every marker is paired, every thread is anchored, and every thread line is valid JSON; otherwise you get the list — unpaired markers, orphaned anchors, unanchored threads, empty quotes, malformed thread JSON, duplicate ids — each saying whether it's \`repairable\`.

This call does double duty: it's your correctness check, **and** it's how the extension learns your pass on that file is over — clearing the "Waiting for the agent…" row the human is watching. Skip it and they're left watching a spinner for work you already finished.

The tools refuse any change that would introduce damage, so anything the check reports was already there — name it in your report (the human can run **Markdown Collab: Repair Comment Anchors**) rather than trying to fix markers yourself. One case is not damage: **a thread whose passage you deliberately removed is expected to be unanchored.** Deletions become orphans by design — report it, don't "fix" it by re-anchoring to unrelated text.

Then confirm, from \`mc_list\`, that each addressed thread ends with your comment and is still \`"status":"open"\`.`,
    brief: { kind: "step", text: "Verify — `mc_check(file)` LAST on every file you touched: it is the integrity check, and it ends the human's wait. `mc_status(note)` narrates a long pass." },
  },
  {
    id: "suggest-mode",
    text: `## Suggest Mode — propose edits instead of applying them

When the human asks you to **suggest** or **propose** changes rather than make them ("suggest edits", "don't apply, let me accept them", or a send payload requesting suggest mode), do NOT edit the prose directly — every change becomes a pending suggestion via \`mc_suggest(file, quote: "…", with: "…", note: "why")\`.

The original text stays in the file; the proposal is recorded separately. \`note\` is your rationale, shown on the suggestion card — always include it. Same anchoring rules as opening a thread: ambiguous, or in code/frontmatter/the threads region, gets refused — pass \`occurrence\` or pick a different span. **One suggestion changes one sentence or one list item.** Re-read between several so offsets stay valid. A paragraph-level rewrite is split into several suggestions, one per sentence; when it genuinely can't be split (the change reworks the paragraph as a whole), open a comment carrying the proposed text instead of forcing it into one giant suggestion. A \`with\` far longer than the quoted passage is refused (\`suggestion_too_large\`) — that's the tool telling you to split it, not a limit to work around. **Do NOT accept or reject your own suggestions** — that's the human's call in the review UI, only on explicit instruction. Verify with \`mc_check\` and \`mc_list\` (reports each suggestion's \`original\` and \`proposed\`).

Mutually exclusive with direct edits per request: if the human wants suggestions, route ALL changes through \`mc_suggest\`, never mix in a few direct edits. Review Mode is unaffected — it never edits prose at all.`,
    brief: { kind: "rule", text: "Suggest mode: route every change through `mc_suggest` (with a `note`) — no direct edits at all." },
  },
  {
    id: "maintenance",
    text: `## Every \`.md\` edit goes through the tools

Whenever you change a file that contains \`<!--mc:threads:begin-->\` — for any reason, not only to address a comment — make the change with \`mc_edit\` or \`mc_rewrite\`: they refuse an edit that would break a marker, which a plain text edit can't. If you **rewrote an anchored passage**, \`mc_rewrite\` kept its markers on the new wording; if you **removed one**, the thread surfaces as unanchored — correct, don't re-anchor it to unrelated nearby text. Do NOT change any \`<!--mc:t {…}-->\` line — only the human reviewer and the reply workflow append to threads. Finish with \`mc_check\`.`,
  },
  {
    id: "reporting",
    text: `## Reporting

Tell the user, per file, using each thread's id (1–12 char base36) so they can find it in VS Code: threads addressed (+ one-line summary of each change), threads initiated on explicit request (+ anchored passage + the note you left), threads deleted on explicit request, threads left unanchored/orphaned because their target was removed (+ why), threads answered without a prose change (+ the question you replied with), and anything you skipped and why.`,
  },
];

/**
 * The skill for one target. `legacy` is `~/.claude/skills/vs-markdown-collab/SKILL.md`,
 * `plugin` is the plugin's `skills/review/SKILL.md`, `agents` is
 * `~/.agents/skills/markdown-collab/SKILL.md` — all three the short \`mdc\`
 * skill. `headless` is the tools-only workflow a headless run's system prompt
 * carries and `mc_help` returns.
 */
export function renderSkill(t: SkillTarget): string {
  if (t !== "headless") return compactSkill(t);
  return `${SECTIONS.map((s) => s.text).join("\n\n")}\n`;
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
