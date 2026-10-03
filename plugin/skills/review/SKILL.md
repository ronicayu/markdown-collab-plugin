---
name: review
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace, AND for reviewing Markdown docs by leaving review comments for the human. Comments are stored INLINE in the .md file itself (look for `<!--mc:threads:begin-->`). TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document — trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md". ALSO TRIGGER on review-mode requests where the user asks YOU to play reviewer — "review this doc", "leave your thoughts on README", "do a review pass on docs/spec.md", "second pair of eyes on this", "what would you flag in this file", "review the markdown collab doc on X".
---

# Markdown Collab — agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. The user runs the IDE; you do the writing.

## Storage format

Comments are stored INLINE in the `.md` file itself — there is no sidecar.

- Anchored spans are paired HTML comments: `<!--mc:a:ID-->anchored text<!--mc:/a:ID-->` (ID = 1–12 char base36).
- One block at the end of the file holds one `<!--mc:t {JSON}-->` line per thread, fenced by `<!--mc:threads:begin-->`/`<!--mc:threads:end-->`: `{"id":"<ID>","quote":"<original anchor text>","status":"open"|"resolved","comments":[Comment, …]}`.
- Each `Comment`: `{"id":"c<N>","parent"?:"c<N>","author":"<name>","ts":"<ISO-8601 UTC>","body":"<markdown>","editedTs"?:"<ISO-8601 UTC>","deleted"?:true}`.

**Detection:** the file contains the literal string `<!--mc:threads:begin-->` — its absence means no comments yet. A named file with no threads region: if the user asked you to **address** comments, there are none — tell them and stop; if they asked you to **initiate** a thread (opt-in, Phase 5), create the region.

## How to change a document — the two safe paths

Marker surgery by hand is the single most common way this workflow breaks: one dropped `-->` silently orphans a reviewer's comment. So you never hand-edit a marker or a thread line — every change goes through the *same* engine the editor itself uses, whichever front end is available: the **MCP tools** (first choice, when they're in your tool list — edits go through the editor, undoable with Cmd+Z, validated before they land), or the **`mdc` CLI** (`mdc <command> <file> [args]` — on your PATH while this plugin is enabled — same verbs, for when the tools aren't there — a session outside this VS Code window, MCP disabled by policy, or the server not running).

`mdc` itself is reachable only inside a Claude Code session — this plugin, or the standalone skill; an agent that isn't Claude Code has neither and instead follows `docs/format.md`, asking you to run **Markdown Collab: Repair Comment Anchors** when it can't run a check itself.

Hand-editing markers with the Edit tool is a distant third and only when neither exists — see *Appendix: hand-editing markers* at the end of this file.

| MCP tool | `mdc` CLI form | What it does |
| --- | --- | --- |
| `mc_list(file, actionable?)` | `list <file> [--actionable]` | Threads and pending suggestions as JSON, including each thread's live anchored text. The actionable flag keeps only open threads whose last comment is not yours. |
| `mc_reply(file, threadId, body)` | `reply <file> <threadId> --body TEXT` | Appends a reply authored by `claude` with the correct `c<N>` id and timestamp. |
| `mc_rewrite(file, threadId, with)` | `rewrite <file> <threadId> --with TEXT` | Replaces the text between a thread's markers and updates its `quote`. Both markers are preserved by construction. |
| `mc_edit(file, old, new, occurrence?)` | `edit <file> --old TEXT --new TEXT [--occurrence N]` | Replaces exact text outside anchored spans (prose, frontmatter), or deletes an anchored passage when `old` spans both of its markers. Refuses anything that splits a marker pair or touches the threads region — use `mc_rewrite` inside an anchor. |
| `mc_open(file, quote, body, occurrence?)` | `open <file> --quote TEXT --body TEXT [--occurrence N]` | Opens a new thread on a passage: mints a unique id, wraps the passage, appends the thread line. |
| `mc_resolve(file, threadId)` | `resolve <file> <threadId>` | Marks a thread resolved. Only when the human asks. |
| `mc_suggest(file, quote, with, note?, occurrence?)` | `suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N]` | Proposes an edit without applying it (suggest mode). Keeps the original in the prose. |
| `mc_accept(file, anchorId)` / `mc_reject(file, anchorId)` | `accept <file> <anchorId>` / `reject <file> <anchorId>` | Apply / drop a pending suggestion. Normally the human's call in the UI. |
| `mc_check(file)` | `check <file> [--repair]` | Integrity report. **Run this last on every file you touched** — see below. CLI-only `--repair` fixes what it safely can. |
| `mc_status(note, file?)` | *(no CLI form — interactive only)* | Say what you're doing right now ("reading 2 of 3 files", "opening threads on §Setup"). |

Two of these do more than they look like they do: **`mc_check` ends the pass** — the extension shows the human a "Claude is working…" row on every thread it sent you, and your closing `mc_check` on a file is what clears it; skip it and they're left watching a spinner for work you already finished. **`mc_status` is free and worth it** — a review pass over three files is minutes of silence otherwise, and one short present-tense phrase per phase shows up next to the indicator and in the status bar.

Ordinary prose edits — text outside an anchored span — may use `mc_edit` (CLI: `mdc edit`), which refuses anything that would break a marker or touch the threads region; the Edit tool remains fine too in interactive sessions. Every `mdc` command prints JSON to stdout — a failure is `{"ok":false,"code":…,"message":…}` — with exit codes `0` ok, `1` usage error or refusal, `2` integrity violation; mutating commands validate before writing and refuse a change that would introduce a new integrity problem, so a failed command leaves the file untouched rather than half-edited.

**Both paths refuse rather than guess.** Ambiguous passage (appears more than once)? Pass the occurrence. Inside a code span? Choose a different anchor. Never work around a refusal by hand-editing — it's telling you the edit was unsafe, and the hand-edit would perform it anyway.

**If neither path is available** (older install, no `node` on PATH, no tools), follow the appendix, and run a check as soon as either is back.

## Workflow

### Phase 1 — Discover

Call `mc_list(file, actionable: true)` (CLI: `list <file> --actionable`) for the threads still waiting on you — open, last spoken to by someone other than you. Each comes with `id`, `quote`, `comments`, and `anchoredText` (the live text between that thread's markers — the passage the reviewer meant). A thread with `"anchored": false` has lost its markers; treat `quote` as the locator and see Phase 7.

Read the file itself too — the threads are only the part someone commented on.

### Phase 2 — Plan

Group by file. Within a file, order edits by anchor position (earlier first). For each thread, write down: the reviewer's intent, the concrete edit, and whether the anchored passage will be rewritten in place (marker pair must move with it) or removed (markers go away, thread orphans).

### Phase 3 — Edit & reply

For each thread, in order:

1. **Make the prose change.** Rewriting the anchored passage: replace the text *between* the markers with `mc_rewrite(file, threadId, with: "…")` (CLI: `rewrite <file> <threadId> --with "…"`) — updates `quote` in the same operation, can't drop or split a marker. Editing prose outside the anchored span: use `mc_edit`/`mdc edit` (or the Edit tool interactively), markers stay put. Removing the anchored passage: delete the open marker, the passage, and the close marker together with `mc_edit`/`mdc edit` (or the Edit tool interactively) — `old` spans both markers, so nothing is split; the thread orphans and shows as "broken anchor", the correct outcome; do NOT re-anchor to nearby unrelated text.

2. **Append a reply:** `mc_reply(file, threadId, body: "…")` (CLI: `reply <file> <threadId> --body "…"`). Assigns the next `c<N>` id, sets `author` to `"claude"` and `ts` to now, appends to the thread, leaves everything else untouched. Write one or two specific sentences — quote the new wording, name the section or file/function you changed. Don't say "done".

3. **For threads you can't fully address** (ambiguous, missing info, conflicting with another thread), reply explaining what you tried and what you need — don't pretend it's done.

### Phase 4 — Deletion (opt-in)

You only delete or tombstone a thread when the human's body or trailing reply unambiguously asks for it ("delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"):

- Remove the matching `<!--mc:t {…}-->` line outright AND remove the matching anchor marker pair from the prose. Both edits in one pass.
- Never delete to "clean up". Never delete just because you addressed a comment — the human resolves.

### Phase 5 — Initiate a new thread (opt-in)

Only **create** a thread when the human explicitly asks — "leave a comment on X", "flag this for follow-up", "drop a TODO comment here". Never spontaneously, as a reminder to yourself, or mid-maintenance-edit. Works whether the file already has a threads region or not (a fresh file gets one created).

**Pick the passage:** a verbatim, meaningful substring — a word at minimum, usually a sentence. Code spans, frontmatter, and the threads region are refused for you; judge instead whether it's the *right* span and whether wrapping it would split something markdown cares about (a link target, an image alt, a table cell delimiter). **Open it:** `mc_open(file, quote: "…", body: "…")` (CLI: `open <file> --quote "…" --body "…" [--occurrence N]`) — mints an id, wraps the passage, appends the thread line; an ambiguous passage tells you how many matches exist, so re-run with `occurrence`. **Verify** with `mc_check` (Phase 7).

Adding several threads in one turn? Do them one at a time, re-reading between each — earlier edits shift the offsets the next anchor depends on.

### Phase 6 — Invariants (inline mode)

These are judgement calls the tools can't make for you. You MUST NOT:

- Change any thread's `status` (only the human resolves), or edit any comment other than to APPEND a new one (the record is history).
- Re-anchor an orphaned thread to nearby unrelated text (let it orphan), or move anchor markers without also moving the passage they wrap.
- Initiate a new thread (Phase 5) unless the human explicitly asked — the Review Mode trigger below counts as an explicit ask and unlocks it.
- Edit prose in Review Mode: there you OPEN threads, never modify doc text. Even obvious typos go in a thread unless told to "fix as you go".
- Reformat the threads region (newlines, key order, escaping) for any reason.

The mechanical invariants — `c<N>` id sequence, thread ids/quotes staying put, threads-region formatting — are enforced by the tools and CLI, and only yours to maintain when hand-editing (see the appendix). Reporting isn't exempt either: quote what changed rather than saying "applied", and never say a comment is addressed when it isn't.

### Review Mode (inline) — Claude as the reviewer

When the human's request matches **Review Mode** trigger phrases — "review this doc", "leave your thoughts on X", "do a review pass on Y", "second pair of eyes on README", "what would you flag in this file", or the Markdown Collab extension's "Ask Agent to Review This Doc" / "Ask Agent to Review These Docs" commands — you switch from addressing existing comments to **initiating** new review threads. The human will triage them in the sidebar. When the prompt names more than one file, read the *Multi-file review passes* section below before starting.

The mechanics are the same as Phase 5: pick a passage, allocate an id, insert paired markers, append a `<!--mc:t {…}-->` line with a single `c1` comment authored by `"claude"`, verify. Read Phase 5 first if you have not — it carries the invariants you must respect when wrapping passages.

#### Focus directive

The prompt may include a `Focus:` line — a free-form instruction from the human (e.g. *"check API examples for correctness," "find marketing-y tone," "look for contradictions with the architecture doc"*). When a focus directive is present:

- It is the **primary filter** for what counts as a concern worth a thread. Only flag things that match the focus.
- A general-quality issue that doesn't match the focus does **not** warrant a thread unless it's a hard error (e.g. broken example, factually wrong claim).
- If no concerns match the focus after a careful read, reply (via the send channel, not via a thread) saying so. **Do not fabricate threads to feel productive.**

Without a focus directive, do a general review against the rubric below.

#### Standing conventions

A payload may carry a **Conventions:** block — the project's standing rules (from `.markdown-collab/conventions.md`): terminology, tone, house style, and "we know, don't flag it" exceptions.

- They apply to **every** pass, where `Focus:` applies to one. Where they pull apart, focus wins on **scope** (what warrants a thread); conventions still hold on **wording**. A convention violation is a legitimate thread even with no matching focus — that's what makes it standing.
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

Every `c1` body must name the concern concretely — **good:** *"The claim that `X` implies `Y` skips intermediate step `Z`. Either justify the jump or add the step."* **bad:** *"This could be clearer"* / *"The whole section needs work"* / restating the anchored text with no analysis.

The body should fit in 1–3 sentences. If you need more, split into separate threads on different anchors.

#### Worked examples — good vs bad

These calibrate the rubric. Mirror the *shape* of the good examples; avoid the failure modes in the bad ones.

**Good — concrete factual correction.** Doc says: *"The CLI accepts `--all` to include resolved comments."* Code says the flag is `--include-resolved`. Anchor the literal `--all` token only (smallest meaningful span). Body: *"CLI flag is `--include-resolved` per `cli.ts:142`, not `--all`. Either rename the doc or update the CLI."*

**Good — unclear claim with a named ambiguity.** Doc says: *"The skill triggers on review-mode phrases."* Anchor the sentence. Body: *"\'Review-mode phrases\' isn't defined here — the rubric for what counts as one is in Phase 5+. Either inline a one-line definition or link to the Review Mode section."*

**Good — contradiction across sections.** Doc's `Quick start` says `Send to Claude` is in the right-click menu; doc's `Commands` table says it's palette-only. Anchor the quick-start claim (because it's the one that's likely wrong). Body: *"Conflicts with the Commands table, which marks this palette-only as of v0.28. Update one or the other to match reality."*

**Good — structural issue, anchored at a heading.** Doc has a `## Settings` heading before `## Storage layout`, but Storage explains terms used in Settings. Anchor the `## Settings` heading. Body: *"Settings references the `<!--mc:threads:begin-->` marker introduced in Storage layout below. Move Storage layout above Settings, or forward-link explicitly."*

**Bad — vague.** *"This could be clearer."* No anchored specifics, no named problem, nothing the human can act on without re-deriving the concern. Either name the specific issue or skip.

**Bad — anchor too wide.** Anchoring an entire 8-paragraph section because *"the whole section needs work."* The human can't tell which sentence drove the comment. Pick the single sentence (or heading) that crystallizes the issue.

**Bad — restating the anchor.** Anchored: *"Channels need MCP."* Body: *"This sentence is about channels needing MCP."* Adds nothing the reader doesn't see. Either explain *why* the claim is problematic (it's incomplete? wrong? unclear in this context?) or skip.

**Bad — opinion presented as fact.** *"This intro is too marketing-y."* — only valid if the focus directive explicitly asks for tone. Without that, style preferences aren't a substantive concern.

**Bad — fix dressed as a comment.** Body: *"I changed this to X."* You don't edit prose in Review Mode. Open a thread proposing the change in the body; let the human accept it.

#### Rank, cap at five, then summarize

Rank concerns by severity and open threads for the **five** that matter most. Put everything else in one summary thread anchored to the document's title (its first `#` heading, or the very first line when it has none): `Also noticed (N): …`, one line per item naming its passage — so the human can read it and say "open 3 and 7" for exactly the ones they want promoted. The `Focus:` line can override the cap explicitly ("give me ten", "everything"); absent that, five is it, whether the pass turns up six issues or sixty.

Don't drop a finding to make the cap — every concern still reaches the human, in its own thread if it's top five, in the summary line otherwise. The human triages with the sidebar UI; your job is signal, ranked.

#### Honest empty result

If you read the doc carefully and find no concerns that match the focus (or no general-rubric concerns if no focus was given), say so explicitly via the send channel. Do **not** open a thread to comment "looks good" — threads are for actionable concerns. A short reply of *"Reviewed `<path>` against focus `<focus>`. No concerns found."* is the correct outcome.

#### Delta passes — "review changes since last pass"

A prompt may ask you to review **only what changed since your last pass**. It names the changed sections, includes their current text, and lists the threads that already exist.

Do not review unchanged prose — it was reviewed already, and re-raising it is noise in the triage queue. Cross-reference by id instead of duplicating: if a concern is already covered by a listed thread, reply there rather than opening a second one. A resolved thread is settled — don't raise it again unless the new text genuinely reintroduces the problem, and say which thread it was ("this brings back the issue from a1b2c") when it does. Threads flagged "text changed" first, since their passage was edited and the concern may already be handled or moved. Unchanged text is fair game only when the change made it wrong — say why in the body. Finish with `mc_check` as always — it's what makes the *next* delta pass possible.

#### Multi-file review passes

A Review Mode prompt may name **several files** instead of one — the extension's "Ask Agent to Review These Docs" command builds one pass over a folder or a multi-select. The prompt lists the files; treat that list as the work order.

1. **Read every listed file end to end before opening any thread** — you can't judge cross-file consistency otherwise, and a thread opened in file 1 may be answered by file 3. Then open threads file by file, in the order listed (same Phase 5 mechanics; ids unique only within their own file).
2. **Cross-document consistency is part of the pass**, not an optional extra: terminology drift, a claim in one file contradicted by another, duplicated guidance that's diverged, cross-references that no longer resolve. Anchor such a thread in the file that's wrong (or the more prominent one), quoting the other file's conflicting text — the human is reading without it open.
3. **Focus applies per pass; the five-thread cap applies per file.** Each file gets its own top five and its own summary thread for the rest — not one shared cap or one shared summary across the whole pass. Verify each file with `mc_check` before moving to the next — cheaper to catch a broken marker in file 1 before editing files 2 and 3 — and report per file, with cross-document findings called out separately.

#### Workflow — Review Mode pass, in short

Read the doc end to end first. Initiate threads one at a time, in document order, with `mc_open`/`mdc open` — never edit prose. Narrate long passes with `mc_status`. Verify with `mc_check`, which also ends the human's wait.

### Phase 7 — Verify, and end the pass

Finish every file you touched with `mc_check(file)` (CLI: `check <file>`). `"ok": true` means every marker is paired, every thread is anchored, and every thread line is valid JSON; otherwise you get the list — unpaired markers, orphaned anchors, unanchored threads, empty quotes, malformed thread JSON, duplicate ids — each saying whether it's `repairable` (the CLI also exits `2`).

This call does double duty: it's your correctness check, **and** it's how the extension learns your pass on that file is over — clearing the "Claude is working…" row the human is watching. Skip it and they're left watching a spinner for work you already finished.

If the check reports damage you introduced, fix it — the CLI's `check --repair` strips stray markers and re-anchors threads whose quote still matches exactly one place in the prose (never guessing at an ambiguous one); anything it can't repair is yours to fix by hand. One case is not damage: **a thread whose passage you deliberately removed is expected to be unanchored.** Deletions become orphans by design — report it, don't "fix" it by re-anchoring to unrelated text.

Then confirm, from `mc_list`, that each addressed thread ends with your comment and is still `"status":"open"`.

## Suggest Mode — propose edits instead of applying them

When the human asks you to **suggest** or **propose** changes rather than make them ("suggest edits", "don't apply, let me accept them", or a send payload requesting suggest mode), do NOT edit the prose directly — every change becomes a pending suggestion via `mc_suggest(file, quote: "…", with: "…", note: "why")` (CLI: `suggest <file> --quote "…" --with "…" --note "…"`).

The original text stays in the file; the proposal is recorded separately. `--note` is your rationale, shown on the suggestion card — always include it. Same anchoring rules as opening a thread: ambiguous, or in code/frontmatter/the threads region, gets refused — pass `occurrence` or pick a different span. **One suggestion changes one sentence or one list item.** Re-read between several so offsets stay valid. A paragraph-level rewrite is split into several suggestions, one per sentence; when it genuinely can't be split (the change reworks the paragraph as a whole), open a comment carrying the proposed text instead of forcing it into one giant suggestion. A `with` far longer than the quoted passage is refused (`suggestion_too_large`) — that's the tool telling you to split it, not a limit to work around. **Do NOT accept or reject your own suggestions** — that's the human's call in the review UI, only on explicit instruction. Verify with `mc_check` and `mc_list` (reports each suggestion's `original` and `proposed`).

Mutually exclusive with direct edits per request: if the human wants suggestions, route ALL changes through `suggest`, never mix in a few direct edits. Review Mode is unaffected — it never edits prose at all.

## When this skill applies

Invoke when:
- The user names one or more `.md` files and asks you to act on review comments / feedback / notes.
- The user says "address the markdown collab comments" without naming files (operate workspace-wide).
- The user references a specific comment thread or quote and asks you to apply / respond.

## Anchor maintenance applies on EVERY `.md` edit, not just comment-driven ones

Whenever you modify a `.md` file in a Markdown Collab workspace — for any reason, not only when addressing review comments — reconcile that file's anchors after the edit. Rewording a sentence, refactoring a heading, fixing a typo: any of these can break an existing anchor.

After your Edit, run `mc_check` (or `mdc check <file>`) — it reports every unpaired, dropped, or duplicated marker an ordinary prose edit introduces; fix anything it reports. This plugin also runs that check after every Edit and Write, and tells you when one broke a marker. For each thread whose markers are still paired: if you **rewrote the passage in place**, keep the markers on the new wording (`mc_rewrite`/`mdc rewrite` can't drop a marker); if you **removed the passage**, both markers should be gone and the thread surfaces as unanchored — correct, don't re-add markers to wrap unrelated nearby text. Do NOT change any `<!--mc:t {…}-->` line during maintenance — only the human reviewer and the reply workflow append to threads. This applies whether or not a review batch was active.

## Getting the MCP tools (if you don't have them)

If `mc_list` and friends aren't in your tool list, add them with **Markdown Collab: Connect an Agent…** → Claude Code, then restart. They only exist while that VS Code window stays open; elsewhere, or with MCP disabled by policy, use the `mdc` CLI instead — not degraded, just different.

## Reporting

Tell the user, per file, using each thread's id (1–12 char base36) so they can find it in VS Code: threads addressed (+ one-line summary of each change), threads initiated on explicit request (+ anchored passage + the note you left), threads deleted on explicit request, threads left unanchored/orphaned because their target was removed (+ why), threads answered without a prose change (+ the question you replied with), and anything you skipped and why.

## Appendix: hand-editing markers (last resort)

**Only when neither the `markdown-collab` MCP tools nor the `mdc` CLI is
available.** Everything below is string surgery on a format that is unforgiving
about it — one dropped `-->` silently orphans a reviewer's comment. If either
path exists, use it instead; if one comes back mid-task, switch to it and run a
check.

**Rewriting an anchored passage.** Put the markers *inside* your Edit:
`old_string` = open marker + old passage + close marker; `new_string` = the same
open marker + the NEW passage + the same close marker. Do NOT Edit the bare
visible text — the markers sit flush against it, so a bare-text `old_string`
either fails to match or eats a marker.

- `old_string`: `### <!--mc:a:aopzy-->Main business flows<!--mc:/a:aopzy-->`
- `new_string`: `### <!--mc:a:aopzy-->Core business processes<!--mc:/a:aopzy-->`

Same id, both markers kept, only the wrapped text changed. Then update that
thread's `quote` field to the new text.

**Appending a reply.** Locate the matching `<!--mc:t {…}-->` line by its
`"id":"<thread-id>"` and Edit only that line — append a comment object at the
END of the `comments` array with the next sequential `c<N>` id, `"parent"` set
to the last non-deleted comment's id, `"author":"claude"`, an ISO-8601 UTC
`"ts"`, and your `"body"`. Preserve the JSON exactly otherwise: same key order,
same escaping, same trailing `-->`, all on one line. **Do NOT change `status`.**
**Do NOT mutate any existing comment.**

**Opening a thread.** Pick a 5-char lowercase base36 id (`[a-z0-9]{5}`) unique
across every `<!--mc:a:ID-->` marker and every `"id":"…"` in existing thread
lines. Edit the passage to `<!--mc:a:ID-->` + passage + `<!--mc:/a:ID-->` with no
extra whitespace, then insert a line just before `<!--mc:threads:end-->` (or
append a fresh region at the end of the file):

```

<!--mc:threads:begin-->
<!--mc:t {"id":"ID","quote":"<anchored text>","status":"open","comments":[{"id":"c1","author":"claude","ts":"<ISO-8601 UTC>","body":"<your note>"}]}-->
<!--mc:threads:end-->
```

The thread JSON must be on a single line. `quote` is the verbatim anchored text.
`status` is always `"open"` — never seed a thread as resolved. Adding several
threads means re-reading between each one, because earlier edits shift the
offsets the next anchor depends on.

**Verifying by hand.** Re-read the threads region and confirm: each addressed
thread ends with your comment; every rewritten passage still has exactly one
matched marker pair; removed passages have both markers gone; opt-in deletions
removed both the thread line and the marker pair; any thread you initiated has a
paired marker plus a valid single-`c1` thread line with a unique id. Search for
`<!--mc:a:` and `<!--mc:/a:` — every opener needs a closer with the same id.

Hand-edits skip the two things the other paths give you for free: the pre-write
integrity check, and the signal that ends the human's "Claude is working…" wait.
Say in your report that you worked without them.
