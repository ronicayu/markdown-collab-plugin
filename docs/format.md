<!-- source of truth: src/inlineComments/format.ts (parse, inspect, renderThreadsRegion, addThread, appendReply, addSuggestion), src/inlineComments/integrity.ts (checkIntegrity, repairIntegrity), src/inlineComments/docOps.ts (opList, opReply, opOpen, opSuggest, opCheckAndCheckpoint), src/inlineComments/staleness.ts (hashAnchorText), src/inlineComments/deltaReview.ts (checkpointFor), src/agentIdentity.ts (isAgentComment), src/skillCli/mdc.ts (check exit codes). Checked against src/test/inlineCommentsFormat.test.ts, roundtripCorpus.test.ts, integrity.test.ts, frontmatter.test.ts, docOps.test.ts, skillCli.test.ts. -->

# The Markdown Collab file format

Markdown Collab keeps review comments inside the `.md` file they are about. This page is the contract any
agent writing to such a file is held to. Claude Code gets the `mdc` CLI with its plugin — `mdc` is on PATH
only inside Claude Code sessions — and an agent the human registered gets the `markdown-collab` MCP tools.
Both write this format for you. Everyone else writes it by hand, and this page is all there is.

A file is under review when it contains the literal string `<!--mc:threads:begin-->`.

```markdown
# Setup

Run the <!--mc:a:k3x9q-->installer with --global<!--mc:/a:k3x9q--> first.

<!--mc:threads:begin-->
<!--mc:t {"id":"k3x9q","quote":"installer with --global","status":"open","anchorHash":"f0dc1056","comments":[{"id":"c1","author":"ronica","ts":"2026-09-28T09:00:00.000Z","body":"Why global?"},{"id":"c2","author":"codex","agent":true,"via":"tools","ts":"2026-09-28T09:05:00.000Z","body":"Only a global install puts it on PATH.","parent":"c1"}]}-->
<!--mc:threads:end-->
```

## Anchor markers

A comment points at a passage by wrapping it in a pair of HTML comments: `<!--mc:a:ID-->` before it and
`<!--mc:/a:ID-->` after it. Any Markdown viewer renders the passage as if the markers weren't there.

- **IDs** are 1–12 characters of `a-z` and `0-9`. The tools always mint 5. Anything else (uppercase, 13
  characters) isn't a marker at all: it renders as literal text and the thread reads as unanchored.
- **One pair per ID.** A second open marker with an ID already in use is an unpaired marker. The ID is shared
  with the thread (or suggestion) record that owns the pair, and is unique across both.
- **Pairing is by ID, not by nesting,** so anchors with different IDs may nest or sit side by side.
- **On a heading line** the open marker goes after the `#`s — `## <!--mc:a:ID-->Heading<!--mc:/a:ID-->` —
  or the line stops being a heading.
- **Never inside code.** Markers in a fenced block (```` ``` ```` or `~~~`), a line indented four spaces, or
  an inline code span are ignored by the parser, so a thread anchored there comes back unanchored. The tools
  refuse to anchor there.
- **Never in the frontmatter** (a `---`/`+++` block at the very top) and never in the threads block. The
  tools refuse both.

## The threads block

Every record lives between two fence lines, `<!--mc:threads:begin-->` and `<!--mc:threads:end-->`, at the
very end of the file: the tools write one blank line, the block, and a single newline. (The parser takes the
last begin fence that has an end fence after it and isn't inside code, so prose after the block still
parses — but don't put it there.) Inside the block, one record per line:

- `<!--mc:t {JSON}-->` — a thread, one line each
- `<!--mc:s {JSON}-->` — a pending suggestion
- `<!--mc:rev {JSON}-->` — the review checkpoint, at most one

The tools write threads, then suggestions, then the checkpoint; the parser doesn't mind the order and
ignores any other text in the block. A record outside the block is ignored.

**Escaping.** The JSON sits inside an HTML comment, so its strings never contain a literal `-->` or `<!--`.
Write them as `-->` and `<!--`; `JSON.parse` turns them back. A literal `-->` ends the HTML
comment early, so other Markdown viewers show the rest of the line as text (and `}-->` inside a string
breaks the record); a literal `<!--mc:a:…-->` inside a string is read as a real marker.

## Threads (`<!--mc:t {…}-->`)

| Field | | Meaning |
|---|---|---|
| `id` | required | The anchor ID. A line whose JSON doesn't parse, or has no string `id`, is skipped and reported. |
| `quote` | expected | The anchored text when the thread was opened, other markers removed. Repair re-anchors by it. Missing reads as `""`. |
| `status` | expected | `"open"` or `"resolved"`. Anything else reads as `"open"`. |
| `resolvedBy`, `resolvedTs` | optional | Who resolved it and when (ISO-8601 UTC). Present only while resolved. |
| `anchorHash` | optional | FNV-1a 32-bit hash (8 hex digits) of the anchored text as it read at the last comment. When the live text hashes differently the thread shows "text changed since this comment". Absent means unknown, never "unchanged". |
| `comments` | expected | The conversation, oldest first. Missing reads as none. |

The tools write the keys in the order above. A thread-level field not in this table is dropped the next
time anything rewrites the block.

### Comments

| Field | | Meaning |
|---|---|---|
| `id` | required | `c1`, `c2`, …; a new comment takes one more than the highest `c<N>` in the thread. |
| `author` | required | A person's name, or an agent's slug (`claude`, `codex`, `cursor`, `copilot`, `gemini`, …). |
| `ts` | required | When it was written, ISO-8601 UTC. |
| `body` | required | Markdown. |
| `parent` | optional | The `id` of the comment this one answers. |
| `agent` | optional | `true` on every comment an agent writes. Without it, only the slugs above (any case, plus `agent`) count as an agent. An open thread whose last live comment is a person's is "waiting on" an agent. |
| `via` | optional | How an agent's comment arrived — see below. |
| `editedTs` | optional | Set when the body was edited in the review view. |
| `deleted` | optional | `true` on a tombstone: the body is emptied, the comment kept so its replies keep their parent. |

A comment missing any of the four required fields, or with a non-string value in one, is silently skipped —
`mdc check` does not report it — and is gone the next time the block is rewritten. Comment fields not in
this table are kept.

**`via`** records the path an agent's write took, so the human can see which loop is actually in use:

- `"tools"` — through the extension's MCP tools (`mc_open`, `mc_reply`, `mc_suggest`), including an `mdc`
  command forwarded to the running extension, which is what `mdc` does whenever it can reach one.
- `"cli"` — by `mdc` writing the file itself (no extension reachable, or `--direct`).
- absent — written in the review view, written by hand, or written before the field existed.

Any other value reads as absent and is dropped on the next rewrite. Never write `via` by hand: its absence
is how a hand-written reply is told apart. `mdc list` and `mc_list` report it on comments and suggestions.

## Suggestions (`<!--mc:s {…}-->`)

A pending suggestion leaves the original text in the prose, wrapped in its own marker pair, so the file
still reads as the original everywhere. The proposed text lives only in the record:

```markdown
<!--mc:s {"anchorId":"p7m2w","author":"claude","agent":true,"via":"tools","ts":"2026-09-28T09:10:00.000Z","original":"30 seconds","proposed":"60 seconds","note":"Matches the default in config.ts."}-->
```

| Field | | Meaning |
|---|---|---|
| `anchorId` | required | The ID of the marker pair around the original text. |
| `original` | required | The text between those markers when the suggestion was made. |
| `proposed` | required | The replacement. |
| `threadId` | optional | A thread this suggestion answers. |
| `author`, `agent`, `via`, `ts` | | As on a comment. A missing `author` reads as `"claude"`. |
| `note` | optional | One line of rationale, shown on the card. |

A record missing `anchorId`, `original` or `proposed` is skipped silently, and its markers then show up as an
orphan anchor. **Accept** replaces the whole anchored span, markers included, with `proposed`; **reject**
removes the markers and keeps the original. Either way the record goes. A suggestion whose markers are lost
can't be accepted. Without the tools, propose a change as a comment that quotes the new text instead.

## The review checkpoint (`<!--mc:rev {…}-->`)

`{"ts":…,"contentHash":…,"gitRef":…,"sections":[{"heading":…,"hash":…}]}` — "an agent reviewed this file in
this state". `mdc check` and `mc_check` write it, and only on a file with no integrity issues. `contentHash`
hashes the prose with every marker and the block removed; `sections` holds one hash per heading section
(`heading` is `null` for the text above the first heading), which is what lets the next review cover only the
sections that changed. `gitRef` is optional. If there are several, the last wins; a malformed one reads as
no checkpoint. Never write or edit it by hand. Deleting it is safe: the next review is a full pass.

## Integrity: what `mdc check` enforces

| Issue | Severity | Means | Repair |
|---|---|---|---|
| `unpaired-marker` | error | An open marker with no close, a close with no open, or an ID opened twice. | Removes the stray marker. |
| `malformed-thread-json` | error | A `t` line whose JSON doesn't parse or has no `id`. That thread is invisible. | No. |
| `duplicate-thread-id` | error | The same `id` on two `t` lines. | No. |
| `orphan-anchor` | warning | A marker pair whose ID has no thread and no suggestion. | Removes both markers, keeps the text. |
| `unanchored-thread` | warning | A thread whose markers are gone. | Re-wraps its `quote` if that text occurs exactly once in the prose; otherwise no. |
| `empty-quote` | warning | An anchored thread whose `quote` is `""`. | No. |
| `unanchored-suggestion` | warning | A suggestion whose markers are gone. | No. |

`mdc check <file>` prints this report as JSON and exits `0` only when there are no issues at all, warnings
included, and `2` otherwise. (Claude Code's post-edit hook, `mdc check --hook`, reports errors only.) An
unanchored thread is the correct result of deleting the passage it was about; it stays a warning.

**Repair** — "Markdown Collab: Repair Comment Anchors" in VS Code, or `mdc check --repair` — fixes the three
repairable kinds in the order above: stray markers, then orphan pairs, then re-anchoring by quote. It only
adds or removes markers; if any step would change a character of prose it abandons the whole batch and leaves
the file as it was. Everything marked "No" needs a person, and Repair says how many remain. The extension
checks a reviewed file whenever it changes on disk, warns, and offers Repair when something is repairable;
it never repairs on its own.

## How to write to this file by hand

1. **Reply.** Find the thread's `<!--mc:t {…}-->` line and append one object to its `comments` array:
   `{"id":"c<next>","parent":"<id you answer>","author":"<you>","agent":true,"ts":"<now, ISO-8601 UTC>","body":"<reply>"}`.
   Leave `agent` out if you are a person, and never add `via`. Don't change `status`, `quote`, `anchorHash`
   or any existing comment.
2. **New thread.** Pick a 5-character ID from `a-z0-9` that no marker, thread or suggestion in the file uses.
   Wrap the passage in `<!--mc:a:ID-->…<!--mc:/a:ID-->` (outside code, the frontmatter and the block; after
   the `#`s on a heading). Add a line just before `<!--mc:threads:end-->` — or, with no block yet, add the
   two fence lines at the very end of the file after a blank line:
   `<!--mc:t {"id":"ID","quote":"<the wrapped text>","status":"open","comments":[<one c1 comment>]}-->`.
3. **Edit prose** anywhere outside the markers. Never type inside a marker. To change anchored text, keep
   both markers around the new wording. To delete an anchored passage, delete the open marker, the text and
   the close marker together and leave the thread line: it becomes unanchored, which is the correct outcome
   — don't re-anchor it to nearby text.
4. **Keep every record one line of valid JSON**, with `-->` and `<!--` escaped as above.
5. **Check.** Run `mdc check <file>` if `mdc` is on your PATH. Otherwise ask the human to run "Markdown
   Collab: Repair Comment Anchors" on the file, and fix whatever it reports it couldn't.
