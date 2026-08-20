# Changelog

## 0.34.85 — 2026-08-20 (pre-release)

### Changed: "Remove resolved" is in the comment panels

It shipped as a command only, which meant using it required knowing its name —
while the resolved comments it acts on are sitting in the panel in front of
you. Both panels now carry a **Remove N resolved** button, in the inline
comments view's filter row and the live editor's sidebar toolbar.

The button appears only when there is something to remove, and names the count.
A permanently visible control for an action that usually does nothing is noise,
and its absence says "nothing to clean up here" more directly than a greyed-out
button would.

Clicking it runs the same command: the modal confirm, the shared verb, and the
undoable write stay defined once, so every route into this behaves identically.
The webview only asks — it cannot show a modal of its own, and a quiet two-click
arm is the wrong weight for deleting a dozen threads at once.

## 0.34.84 — 2026-08-20 (pre-release)

### Fixed: outline entries that went nowhere when clicked

Clicking a heading in the outline often did nothing. The cause was navigating
by name: the panel handed the surface a slug, and the surface looked for a
rendered heading whose text slugified to match. Two sections with the same
name — "What changed", "Security assessment", "Open questions", the ordinary
repeats of a structured document — collide on that slug, so the outline
disambiguates the second to `what-changed-1`, GitHub-style. No rendered heading
ever spells that, so the second entry matched nothing and the view stayed
exactly where it was.

Headings are now addressed by **position**: the Nth heading in the source is
the Nth heading the renderer emits. That is true regardless of how many
sections share a name, and regardless of any disagreement between the source
and the renderer about how to spell one. The same change fixes the
active-section highlight, which had the same flaw and would light up both
entries at once.

Slugs are still computed and still used for `#fragment` links, which address
by name because that is what a fragment is.

## 0.34.83 — 2026-08-20 (pre-release)

### Fixed: opening the outline broke the layout

Both review surfaces lay out with a CSS grid whose columns are listed
explicitly — preview and comments, editor and comments. The outline was added
as a third child without extending either list, so the browser auto-placed
every pane one slot across: the outline took the flexible column, the preview
was squeezed into the 360px comments column, and the comments pane wrapped onto
a second row entirely.

Both grids now grow a column while the outline is showing.

**Why the tests missed it.** The outline specs asserted structure — the right
rows, the right nesting depth, collapse, navigation — and every one of those
still passed while the layout was unusable, because the rows really were all
there and really did work. Nothing measured geometry. There are now four specs
that do: the preview stays the widest pane, the comments pane keeps its width,
every pane stays on one row, and closing the outline restores the original
widths exactly. All four fail against the broken CSS.

## 0.34.82 — 2026-08-20 (pre-release)

Publishes 0.34.81's two features to the marketplaces' **pre-release channel**:
`Markdown Collab: Remove All Resolved Comments`, and the collapsible
table-of-contents panel in the inline comments view and the live editor. See
the 0.34.81 entry below for what they do and the judgement calls behind them.

Stable users stay on 0.34.80 until this is promoted. To get it, enable
pre-releases for the extension in the VS Code Extensions view.

## 0.34.81 — 2026-08-20 (trial)

### Added: remove all resolved comments

`Markdown Collab: Remove All Resolved Comments` deletes every resolved thread
from a file in one step — records, replies, and anchor markers. Resolved
threads are the sediment of a long review: settled, never read again, and in
the way of the ones still waiting on someone. Clearing them one at a time
through the per-thread confirm was the tedium this replaces. Also on the
explorer right-click menu for a `.md`.

It is deliberate about what it leaves: open threads, obviously, but also
**pending suggestions** — a suggestion nobody has accepted or rejected is
unfinished business, not sediment, even when the thread beside it is closed.
The confirm names the count and says it is a single undo step, and the command
refuses with "no resolved comments in this file" rather than silently doing
nothing.

### Added: a table-of-contents panel

Both rendered surfaces get a collapsible outline: the inline comments view via
an **Outline** button in the preview header, the live editor via one in the
sidebar toolbar. Headings nest by level, each section expands and collapses,
clicking one scrolls the document to it, and in the inline view the section you
are reading stays highlighted as you scroll.

The outline is read from the markdown, not from the rendered DOM, so it agrees
with the document rather than with whatever a renderer happened to produce.
Some details that follow from that:

- **A `#` inside a fenced code block is not a heading.** A shell comment in an
  example would otherwise get an entry that scrolls somewhere arbitrary.
- **Untidy documents still get a full outline.** A file that skips from `h1` to
  `h3`, or starts at `h2`, nests against whatever is above it rather than
  dropping headings — an outline that omits sections because the document is
  irregular is one nobody trusts.
- **Repeated headings are disambiguated** the way GitHub does (`notes`,
  `notes-1`), or both entries would scroll to the first one.
- Setext headings (`===` / `---` underlines) are read too.

Collapse state and the panel's visibility persist across reloads in the inline
view, keyed by heading slug so an edit above a section does not transfer your
collapsed state to a different one.

## 0.34.80 — 2026-08-20

**First stable release since 0.34.39.** Everything below has been shipping as
`[skip-publish]` builds; this promotes the whole batch. The headline changes,
newest first — the per-version entries follow.

**The extension hosts an MCP server.** Claude's edits arrive as tool calls
instead of raw disk writes, which makes them undoable with Cmd+Z, ordered
against your unsaved buffer instead of racing it, and validated before they
land rather than repaired afterwards. MCP is offered, never chosen for you:
`terminal` remains the default send mode, because MCP can be disabled entirely
on Claude's side.

**The extension is visible in the plain text editor.** Markers are dimmed,
anchored text is tinted, the stored threads block folds away, hovering a
passage shows its thread, and a single CodeLens gives the counts and a way into
the review view. Reviewed files used to look corrupted in the source view.

**Review is incremental and convention-aware.** "Review Changes Since Last
Pass" re-reads only what moved, per-section, with the checkpoint stored in the
file itself. Standing conventions in `.markdown-collab/conventions.md` ride
along with every request.

**Comment bodies render as markdown**, and both rendered surfaces can show
source line numbers (`markdownCollab.showLineNumbers`, off by default).

**A playground and a walkthrough.** `Markdown Collab: Open Tutorial Playground`
writes a scratch document that arrives mid-review — threads, a reply, two
pending suggestions — so the accept/reject loop is clickable in the first
minute with no skill install and no Claude session.

**Diagnostics.** `Markdown Collab: Report a Problem` collects the environment a
bug report needs, and the output channel now has levels, timestamps, and a
per-subsystem tag. Nothing credential-shaped is ever written to it.

Fixes worth calling out: GitLab review drafts post correctly (they were sent
with the local HEAD as `position[head_sha]`, which GitLab refused); a `.md`
opened outside any workspace folder is fully usable; `![](../diagrams/x.png)`
loads; accepting a suggestion in the live editor updates the text immediately.

## 0.34.79 — 2026-08-19 (trial)

### Changed: comment bodies render as markdown

They always were markdown — Claude writes bulleted lists and fenced code into
replies constantly, and GitHub and GitLab comments are markdown by definition —
but the three surfaces showed them three different ways: inline-only markdown
in the inline comments view (so `**bold**` worked but a list did not), escaped
text with regex autolinking in the live editor, and flat text in the PR view.
A reply containing a list read as a run-on line with stray hyphens in two of
the three places it could appear.

All three now use one renderer, and so do suggestion notes. Lists, fenced code,
tables, block quotes, and headings render; headings are toned down to the
surrounding text size, because a heading in a comment is emphasis rather than
document structure.

Two deliberate differences from the document renderer:

- **A single newline is a line break.** A comment is written like a message and
  every comment UI treats it that way; CommonMark would join the lines of a
  two-line reply into one paragraph. The document renderer is unchanged — a
  hard break there would alter how every wrapped paragraph in every `.md`
  renders.
- **Images render as a link, not a picture.** A comment body can come from
  anyone: Claude, a colleague's commit, another user on a pull request.
  Rendering `![](https://…)` would make opening a review fetch a third-party
  URL and hand whoever wrote it the reader's IP and a read receipt. GitHub
  proxies comment images for exactly this reason; there is no proxy here, so
  the image becomes a labelled link and nothing is silently fetched.

Raw HTML in a comment is escaped, as it always has been — a comment cannot
inject markup into the surface displaying it, which is now covered by a test
that puts an `onerror` payload in a comment body and asserts it never fires.

One fix fell out: links inside PR/MR comments now open. Nothing routed them
before, because those bodies were plain text and had no links to route.

## 0.34.78 — 2026-08-18 (trial)

### Added: `markdownCollab.showLineNumbers`

Off by default. Switch it on and both rendered surfaces — the inline comments
view and the live editor — show the source line beside each top-level block.

**They are lines in the `.md` file, not lines of what's on screen.** Both
surfaces render *prose*: the document with anchor markers, the stored threads
block, and frontmatter stripped out. Counting lines in that puts every number
off by the height of the frontmatter, which is exactly the kind of number that
looks authoritative and sends you to the wrong place in your own file. The host
maps prose lines back through the same offset table the anchoring uses, so what
you see matches "Go to Line".

Details worth knowing:

- Only top-level blocks are numbered. Numbering each list item would put a
  cluster of numbers beside every list instead of a tidy column.
- The inline view carries no line markup at all when the option is off — the
  attribute is gated per render, not per renderer, so turning the setting on
  and off takes effect immediately without re-rendering anything for people who
  leave it off.
- In the live editor the numbers are ProseMirror widget decorations, never
  document content, so they cannot reach the markdown that gets saved. A test
  types into the editor and asserts the serialized text is unchanged.
- The live editor has no source positions of its own, so blocks are matched to
  CommonMark's top-level block sequence by position. If the two ever disagree
  the gutter switches off for that render rather than showing a column that is
  quietly off by one.

## 0.34.77 — 2026-08-03 (trial)

### Fixed: a Markdown file opened on its own is now fully usable

Adding a comment in the live editor failed with *"Could not save comment: File
is outside any workspace folder."* The check was left over from the era when
review state lived in a sidecar file that had to be placed somewhere. It
doesn't any more — comments live inside the `.md`, and the write goes out as a
`WorkspaceEdit` against the open document, which works for any file. Nothing
about adding a comment needs a workspace folder, and the guard was refusing
every comment on a file opened on its own.

The same assumption had been copied across most of the extension, so the next
click would have hit it again. Send to Claude, Copy Prompt, Ask Claude to
Review (single file and multi-select), and the per-thread send all refused a
loose file outright. They now resolve a base directory instead of demanding
one: the real workspace folder when there is a workspace, the file's own
directory when there isn't. That base is only ever used for three things — the
path Claude is given, where review conventions are looked for, and where the
event log goes — and a file's own directory answers all three.

Guard tests now fail if any surface starts gating on a workspace folder again.

If you hit the image problem in 0.34.76, this is very likely the same root
cause wearing a different hat: a file opened outside a workspace was the case
where `../diagrams/x.png` fell outside the granted resource roots.

## 0.34.76 — 2026-08-03 (trial)

### Fixed: images that wouldn't load in the review surfaces

Two separate reasons a picture could be missing, both now closed.

**`![](../diagrams/x.png)` could be refused by the host.** A webview may only
read files under its `localResourceRoots`, and both review surfaces granted the
workspace folder *or* — for a file opened outside one — only the document's own
directory. A `../` path climbs straight out of that, so the image was refused.
Nothing reports this: the `<img src>` is correct, the file exists, and the
picture is simply absent. Both surfaces now grant every workspace folder plus
the document's directory and its parent, through one shared computation, and
the live editor logs the roots it granted.

Never the filesystem root, though: a document sitting at `/proj/x.md` has `/`
as its parent, and granting that would hand the webview read access to the
whole disk — and, because nested paths collapse into their ancestors, would
have quietly replaced every other root in the list. Found by a test written
against the first version of the fix.

**Raw HTML `<img>` rendered as literal text.** Markdown can't centre an image
or set its width, so real documents write `<img src="x.png" width="400">` or
`<p align="center"><img …></p>`. The live editor keeps raw HTML as an opaque
node and renders its source, so those appeared as angle brackets on screen.

The surfaces escape raw HTML deliberately — the document under review may be
untrusted — so this narrows that posture rather than dropping it: a blob is
recognized only when it contains exactly one `<img>` and nothing else but
whitespace and bare wrappers, only `src`/`alt`/`title`/`width`/`height` survive,
dimensions must be plain numbers, schemes are limited to http(s)/data-image/
file/webview, and anything carrying an `on*` handler is refused whole. A
`<script>`, an `onerror=`, or a `javascript:` src still renders as the escaped
text it did before.

## 0.34.75 — 2026-08-01 (trial)

### Added: Comment on Selection — a thread without the webview (10x-plan-3 P0.2)

The only way to open a thread was: open the rendered view, select text with the
mouse, click the floating button. A keyboard-driven author with the source file
in front of them had no path at all. The format engine could always anchor to
any range in the document; what was missing was a way to reach it.

**`Markdown Collab: Comment on Selection`** takes the selection in the text
editor, asks for the comment, and writes the thread into the file. It is on the
editor's right-click menu whenever there is a selection in a Markdown file.

It refuses what it should, with a reason: an empty selection, a range in
frontmatter, and a range inside a fenced code block (the parser strips markers
in code, so a thread anchored there would be orphaned the moment it was
written).

Behind it is a new shared verb, `opOpenAt`, alongside the existing `opOpen`.
They aren't the same operation: `opOpen` finds a passage by its text and must
refuse an ambiguous quote, because Claude describes what it wants; a human has
already pointed at one specific range, where "that text appears three times"
would be a nonsense answer. It runs the same integrity gate as every other
verb, attributes the comment to the human rather than to `claude`, and writes
through a `WorkspaceEdit` — so the comment is undoable with Cmd+Z like any
other edit. A guard test holds extension.ts to the rule the CLI and the MCP
tools already follow: no front end calls the format engine's mutators itself.

## 0.34.74 — 2026-08-01 (trial)

### Added: the extension shows up in the plain text editor (10x-plan-3 P0.1, P0.3)

Open a reviewed `.md` in the ordinary text editor and until now you saw
`<!--mc:a:x7k2p-->` marker soup and a wall of thread JSON at the bottom. The
inline format is the product's core virtue — review state travels inside the
document — and its first impression on a collaborator was "something corrupted
my file." The extension knew what every one of those bytes meant and said
nothing.

- **Markers are dimmed, anchored text is tinted.** Open threads get a highlight,
  resolved ones a quiet dotted underline, a suggestion's original the diff
  colour, each with an overview-ruler mark so you can see where the review is
  from the scrollbar. Colours are theme colours, so this reads correctly in
  light, dark, and high contrast. The markers are dimmed rather than hidden:
  a user who wants to see exactly what is in their file still can.
- **The threads region folds.** One collapsed line instead of a screen of JSON,
  via a folding provider — so your own fold or unfold always wins.
- **Hovering an anchored passage shows the thread**: how many comments, badges
  for resolved / new-from-Claude / has-a-suggestion, and the latest comment with
  its author and age, plus a link into the review view.
- **One CodeLens at the top of a reviewed file** — "3 comments · 1 unresolved ·
  1 new from Claude — open review view". A clean file gets nothing; unreviewed
  documents stay uncluttered.

**Threads now open where threads live.** "Next Unread from Claude" and clicking a
comment in the Markdown Review tree both used to open the *raw source* — the
former with a selection, the latter not even scrolling ("opening the doc is
enough"). Both dropped you on the marker soup the thread is stored in. They now
open the review view scrolled to the thread.

None of this costs anything on files that aren't reviewed: a substring test
skips the parse entirely, and decoration passes are debounced per document.

## 0.34.73 — 2026-07-31 (trial)

### Fixed: the webview e2e suite on CI

The v0.34.72 tag failed its release run: all 13 inline-view specs died with
`SyntaxError: Unexpected token 'export'` on GitHub's runner while all 24 passed
locally. The harness reached for the webview's DOM skeleton through a runtime
`await import("../../inlineComments/webviewShell")` — a module resolution that
only the local environment agreed with. It is a static import now, resolved by
Playwright's own transform like every other import in the suite, so there is
nothing left for the two environments to disagree about. A guard test keeps
runtime imports out of the harness.

This was the webview e2e job's first run on a pushed tag — it was added in this
same unreleased batch, so nothing before it had exercised the job in CI.

## 0.34.72 — 2026-07-31 (trial)

### Added: logs you can actually diagnose from

The extension had 46 log lines and 63 silent `catch` blocks. When a send didn't
arrive, a tool call was refused, or a panel came up empty, the output channel
said nothing — every diagnosis started by adding logging and asking for a
reproduction.

**The channel is now a `LogOutputChannel`**, so VS Code stamps each line with a
level and a timestamp and gives the Output panel a level picker: a user can turn
on Trace for one reproduction without a setting or a reload. Lines are tagged
with the subsystem that wrote them (`[send]`, `[mcp]`, `[pr]`, `[live-editor]`,
`[review]`, `[skill]`, `[format]`).

What now leaves a trace, all of it previously silent:

- **Sends.** Every dispatch logs its file, intent, thread count, and prompt
  size; how the mode was decided (configured, remembered, auto-detected with the
  reason, or picked); and the delivery outcome. Cancelling at the picker is a
  logged fact rather than a shrug.
- **Terminal delivery.** Which terminal was chosen and on what evidence —
  owned, shell-integration, name match, or merely the active one. A paste that
  lands in a plain shell instead of the Claude REPL used to be indistinguishable
  from nothing happening.
- **MCP tool calls, and refusals especially.** A refusal goes back to Claude as
  an `isError` result, which means the human never sees it: the model reads the
  error and moves on and the document simply doesn't change. Every refusal is
  now logged with its code.
- **`gh` / `glab` invocations.** Command, exit code, duration, and stderr on
  failure. PR/MR work is entirely subprocesses, so "the review didn't post" was
  almost always a non-zero exit nobody saw.
- **Failures at the right level.** Save, autosave, `applyEdit`, scan, integrity,
  and skill errors logged at `error` with their stack instead of `info` with
  their message.

**`Markdown Collab: Report a Problem (collect diagnostics)`** builds the
environment report a bug should open with — versions, send mode, skill status,
tool-server port and registration, visible terminals, and each open document's
thread/suggestion/broken-anchor counts — into a scratch document to paste into
an issue. **`Markdown Collab: Show Logs`** opens the channel.

**Nothing credential-shaped is written.** Bearer tokens, `token=`/`api_key=`
style values, and bare 32+ char hex runs (the shape of the MCP session token)
are redacted from every line, in the logger itself rather than at chosen call
sites, so a future call site can't leak by forgetting. The MCP server logs its
port, never its URL — the URL carries the token. Guard tests hold all of it,
including that no other module opens a second output channel.

## 0.34.71 — 2026-07-31 (trial)

### Fixed: submitting review drafts to GitLab

Drafts failed to post as MR diff comments. The PR controller overwrote the
context's head SHA with the local `git rev-parse HEAD` at session start, and
the GitLab adapter sends that value as `position[head_sha]` — so the moment the
branch had a commit that wasn't pushed, GitLab was handed a SHA it had never
seen. It rejected the position outright, or accepted the note without anchoring
it to the diff. GitHub's `commit_id` had the same exposure.

The platform's head SHA and the local checkout's HEAD are now separate fields:
`headSha` stays whatever GitHub or GitLab reported (and is the only one that
goes into an API payload), while the new `localHeadSha` records the local
checkout. Starting a review on a branch with unpushed commits now says so up
front, rather than looking fine until submit.

Two things fell out of the same read:

- **GitLab errors say what to do.** "400 Bad Request" is now "GitLab rejected
  the comment on `docs/a.md:12`. This branch has commits that aren't pushed —
  push and refresh the review, then submit again."
- **A swallowed error.** The "GitLab accepted the note but didn't anchor it"
  check lived inside the same `try` as the JSON parse, so its own error was
  caught and rewritten as a generic parse failure unless the message text
  matched a string test. Parse and check are now separate.

Drafts also survive local commits again: the draft store was keyed on the
overwritten (local) head, so every commit while reviewing moved the drafts to a
fresh slot and they disappeared from the panel. It keys on the PR/MR head now,
which is what its own comment always said it did.

## 0.34.70 — 2026-07-30 (trial)

### Fixed: accepting a suggestion in the live editor now refreshes the text

Accepting a suggestion in the live editor updated the file — but the editor kept
showing the old wording until the next external edit. The cause was the editor's
own echo guard: `writeDocument` re-baselines it to whatever it just wrote (so
the provider's writes aren't bounced back as "external changes"), which also
suppressed the one push that would have shown the accepted text. The
accept/reject path now captures what the editor is showing before the write and
pushes the refreshed prose itself, with the same changed-span summary a Claude
edit gets — so the accepted text lands with the usual "edited §Heading" flash.
Reject is unaffected (it never changed the prose, which is why it always looked
fine).

## 0.34.69 — 2026-07-30 (trial)

### Added: a playground, a walkthrough, a session digest, and accept-all (10x-plan-2 P3)

**Try it in one minute.** `Markdown Collab: Open Tutorial Playground` writes a
scratch document that arrives *mid-review* — two threads (one already answered by
Claude), two pending suggestions, and a short list of things to click — and opens
it in the review view. No skill install, no send mode, no Claude session, no
network. The install-to-value path was previously six steps long and none of them
showed what the thing feels like.

It's built by the real format engine rather than hand-written, so what you click
is the machinery a real review uses; a fixture would drift, and would teach the
wrong thing when it did. Timestamps are fixed, because a tutorial that says
"3 minutes ago" every single time is a lie.

**A walkthrough** in VS Code's Get Started page, five steps, each completing when
you actually run the command. The step pages explain the storage format, the send
modes, and what the skill installs — the questions the README answers on page
three.

**`Markdown Collab: Review Session Summary`** builds a Markdown digest of the
review state — headline counts, what's still waiting on whom, every thread by id
with its gist and latest reply, resolved ones, pending suggestions — into an
untitled document you can paste into a PR description. Multi-file selections group
by file. It's a pure read: everything it says is already in the files, and asking
a model to restate facts it can read would be slower, costlier, and occasionally
wrong.

**Accept all N** appears above the suggestion cards when there's more than one
(with one, it would be a second button doing what Accept already does). Two-step
confirm, since it rewrites the document in one go; applied sequentially against
the running source because each accept moves the next one's offsets; and a
suggestion that lost its anchor is skipped and counted rather than guessed at —
the same rule a single accept follows.

**Listing polish:** README restructured around the loop (comment → send → Claude
edits and replies → accept → resolve) with the playground up top, and the
marketplace categories corrected to `AI` + `Other`.

### Fixed: a release-commit body could choose the publish channel

Found while writing 0.34.68's own entry. The publish gate matched `[skip-publish]`
and `[pre-release]` anywhere in the commit message, so a release commit whose body
*described* a marker — as that one's did — would have picked the channel from a
sentence of prose. Both the workflow and the checklist now read the subject line
only.

## 0.34.68 — 2026-07-30 (trial)

### Added: a pre-release channel, and gates that decide "is this safe to ship" (10x-plan-2 P2.2)

Twenty-eight versions of work exist only as GitHub pre-releases, which means
dogfooding requires hand-installing a `.vsix` while the marketplace build ages.
The gap itself then makes releasing feel riskier, which is how a backlog like
this one forms.

A release commit can now say `[pre-release]`, and the tag publishes **publicly**
to the VS Code Marketplace and Open VSX pre-release channels — users who opted
into pre-releases get it as an ordinary auto-update, everyone else stays on
stable. The GitHub Release is marked as a prerelease too, so both channels agree
about what "latest" means. `[skip-publish]` still means nothing goes public;
neither marker still means a stable release. (The channel lives in the commit
message rather than the tag because a marketplace version must be plain `x.y.z`.)

And the gates. A tag used to run the unit suite; it now runs **everything the
project has** — unit, integration, webview e2e — and `verify-package` on the
built `.vsix`, the same assertion CI makes on every push. Plus
`scripts/release-checklist.mjs`, which prints where the tag will publish and
fails on what a script can decide: version mismatch, a missing CHANGELOG
section, an *empty* CHANGELOG section, contradictory markers. What it can't
decide it prints — dev-host-only flows, whether the notes say anything a user
would want to know, whether a stable release was dogfooded first.

The pipeline is the deliverable here. **Using it is a separate, confirmed act:**
publishing is outward-facing and irreversible, so the first pre-release tag ships
when Ronica says so, not because the machinery exists.

## 0.34.67 — 2026-07-30 (trial)

### Added: standing review conventions (10x-plan-2 P1.2)

Every review started from zero. The product's name, the house tone, the
code-example rule, the thing you've already decided not to care about — all of it
had to be retyped into the focus prompt each time, or Claude re-litigated it
forever.

**Markdown Collab: Edit Review Conventions** creates `.markdown-collab/conventions.md`
from a commented template and opens it. It is plain prose you own — terminology,
tone, standing focuses, known-and-accepted — and every review request appends it
under a `Conventions:` header.

The distinction the skill now draws: a `Focus:` line applies to one pass;
conventions apply to all of them. Where they pull apart, focus decides **what**
warrants a thread and conventions decide **how** it's phrased — and a convention
violation is a legitimate finding with no focus at all. Anything the file lists
as known and accepted stops being a finding, which is the re-litigation the file
exists to end. When you dismiss a thread by stating a rule, the skill suggests
adding it to the file; it never writes there itself.

Four restraints worth naming:

- **Prose, not schema.** No keys, no validation, no settings UI. The moment it
  grows those it becomes config sprawl to document, migrate, and keep in sync.
- **HTML comments are stripped before sending**, so the template's own
  instructions and your notes-to-self never reach Claude.
- **A file that's still just the scaffold weighs nothing.** Headings alone don't
  count as content — otherwise every payload would carry a block that says
  nothing and Claude would treat it as if it did.
- **4 KB cap, and it says when it truncated.** Silent truncation would look
  exactly like Claude ignoring a rule that was never actually sent.

Appended inside `dispatchReviewPayload`, before the mode branches — so every send
path carries it and no payload builder can be the one that forgets. A guard test
enforces both halves of that.

## 0.34.66 — 2026-07-30 (trial)

### Added: review only what changed (10x-plan-2 P1.1)

A second review pass used to cost exactly what the first one did — the whole
file went out, Claude re-read all of it, and it re-raised things you had already
triaged. Real review work is iterative; pass N+1 should cost what the edit cost.

**Markdown Collab: Review Changes Since Last Pass** (right-click a `.md`, or the
palette) sends only the sections that moved since Claude's last pass, plus the
list of threads that already exist.

The bookkeeping is inline and self-contained. When Claude ends a pass with
`mc_check`, the extension records a `<!--mc:rev …-->` checkpoint holding a hash
per heading-section — about twenty bytes a heading, invisible in any rendered
view. The next delta pass compares those hashes to name exactly which sections
changed. **No sidecar, no git dependency**, and it works on a file that was never
committed. (`gitRef` is in the record for later; nothing needs it.)

What the delta prompt carries beyond the changed text:

- **Existing threads, by id**, so a concern already covered gets a reply instead
  of a duplicate.
- **Resolved means settled** — not to be raised again unless the new text
  genuinely reintroduces it, and then by name ("this brings back a1b2c").
- **Stale threads first** (the badge from 0.34.65): their comment was written
  about a passage that has since been edited.
- Sections that were **deleted** since the last pass, as context — something
  else may still point at them.

Three ways it declines to overclaim:

- Nothing changed → a toast, and nothing is sent. Not re-reading an unchanged
  file is the entire point.
- No checkpoint (first review, or a pass from before this existed) → a full pass,
  said out loud, and the pass after that one is incremental.
- A checkpoint with no section hashes → also a full pass. Guessing "everything
  changed" would be a full pass wearing a delta's clothes.

`mc_check` grew the one job it didn't have: it now records the checkpoint as
well as reporting integrity. That is the only moment we actually know a pass
finished — and it **refuses to checkpoint a document with integrity problems**,
because a checkpoint over damage tells the next pass the damage was reviewed and
approved.

*Build note:* writing the threads region appends a trailing newline, so the
content hash normalizes trailing whitespace. Without that, every thread Claude
opened would have made the document look edited, and every "delta" pass would
have quietly been a full one.

## 0.34.65 — 2026-07-30 (trial)

### Added: threads say when their text moved out from under them (10x-plan-2 P1.3)

A thread whose anchored passage was rewritten after the last comment looked
exactly like a live one — same quote in the header, same replies, no hint that
the comment might be answering text that no longer exists. You'd triage it, or
send it to Claude, and only find out mid-conversation.

Threads now carry an optional hash of their anchored span as it read when the
last comment was written. When the live span hashes differently, the card shows
a muted **text changed** badge — in the inline comments view and the live
editor, from the same shared card. Replying resets the baseline, because the
replier just read the passage as it now stands. `mc_list` reports it too
(`"stale": true`), so Claude re-evaluates those threads first instead of
answering a passage that moved.

Three deliberate restraints:

- **Absent means unknown, never unchanged.** Files written before this version
  carry no hash, and they render no badge — an invented hash would read as a
  clean bill of health forever.
- **`quote` was not reused.** It's the creation-time text kept as the
  re-anchoring locator, and moving it whenever someone commented would break the
  repair path that depends on it. The hash is a separate field with separate
  semantics.
- **No badge on a broken anchor.** That thread already has the louder problem;
  two badges about one failure is noise.

The hash is FNV-1a over the span — not cryptographic, and it doesn't need to be:
both sides are the extension's own data, and the question is only "same string
or not". No `crypto` import, so the same code runs in the webviews and in the
dependency-free `mdc.mjs`.

## 0.34.64 — 2026-07-30 (trial)

### Changed: the Claude skill is tools-first (10x-plan-2 P0.3)

The skill carried three separate warnings about dropping a `-->` while
hand-editing markers — a tell that prose was doing a job code should do. Now
that the tools enforce it, the instructions can stop.

The workflow phases read as orchestration: `mc_list` to see what's waiting,
`mc_reply` / `mc_open` / `mc_rewrite` / `mc_suggest` to act, `mc_check` to
finish. Each step names the MCP tool first and the `mdc` CLI command beside it —
they're two front ends over one implementation, so the skill treats them as one
instruction with two spellings rather than a preferred path and a degraded one.

Every *Fallback (no helper)* block — build an Edit around the raw markers, mint
a base36 id by hand, hand-write the thread JSON — moved into a single
**Appendix: hand-editing markers (last resort)** at the end, with the rule that
it applies only when neither the tools nor the CLI exist. That's ~57 lines Claude
skips entirely in the normal case, instead of marker surgery sitting inside the
step that has a tool for it.

Two things the skill now says that it couldn't before:

- **`mc_check` ends the pass.** It was already the correctness check; since
  0.34.63 it's also what clears the human's "Claude is working…" row. The skill
  says so, because a skipped check now leaves someone watching a spinner.
- **`mc_status` is free.** A three-file review pass is minutes of silence
  otherwise.

Phase 6's invariants got split: the judgement calls Claude must make (never
change `status`, never re-anchor an orphan, never initiate a thread unasked,
never edit prose in Review Mode) stay as rules; the mechanical ones (comment id
sequence, thread ids, threads-region formatting) are noted as enforced by the
tools and left to the appendix, where they're actually the reader's problem.

Untouched, deliberately: the Review Mode rubric, the worked examples, the
never-cap rule ("If you find 30 issues, leave 30 threads"), the focus directive
as primary filter, and the multi-file pass rules. Those are judgement, not
mechanics — no tool replaces them, and tests now pin them verbatim.

*On the plan's "⅓ of today's" target:* the marker-mechanics prose did collapse
that far — it's an appendix Claude doesn't read. The document as a whole grew
slightly (a tool table and a setup section arrived), because the parts that
aren't mechanics are exactly the parts worth keeping.

New tests: the tools-first body may not contain marker-surgery instructions
(they must live in the appendix and nowhere else); the skill and the server may
not disagree about tool names in either direction; and the three corpus
documents now get a full review pass driven entirely through `callTool` —
open → reply → suggest → rewrite → accept → check — asserting integrity holds
and prose is untouched.

## 0.34.63 — 2026-07-30 (trial)

### Changed: "Claude is working…" stopped guessing (10x-plan-2 P0.2)

The waiting indicator was honest guessing: marked at dispatch, cleared by
watching for a reply-shaped file change, expired by a ten-minute timer. With the
tool server from 0.34.62 in play, the guessing can stop — tool calls are facts.

Waits now carry their evidence grade, and the two grades read differently:

- **`inferred`** (terminal, event log, clipboard) — unchanged. Still
  "Claude is working…", still resolved by a Claude-authored comment appearing,
  still backstopped by the timeout. It's a guess and it reads like one.
- **`protocol`** (the `mcp` send mode) — the first tool call against the file
  turns *"Sent to Claude…"* into *"Claude is working on this file…"*; an
  `mc_status` beacon replaces that with what Claude is actually doing
  (*"Claude: reading 2 of 3 files"*); and the pass's closing `mc_check` clears
  the wait outright — no reply required, because a review pass can legitimately
  end without one.

The timeout stops being a guess about Claude's lifetime and becomes a silence
detector: it runs from the last signal rather than from dispatch, so a
forty-minute pass that keeps reporting never expires mid-work, while a session
that dies still stops claiming to be in flight.

Also new: a status-bar item carrying the phase, for when you've gone back to the
editor and aren't looking at the panel. It stays **silent for inferred waits** —
putting the extension's least reliable claim in its most prominent spot is the
same lie the timeout exists to avoid.

Both surfaces render the row from the host's wording, so there is one place that
decides what the extension is willing to claim.

*Build note:* the live editor's reconciler skips cards whose content signature is
unchanged, and a phase update changes nothing else about a thread — so the
signature now carries the row's text, not just "is waiting". Same class of bug as
the one 0.34.61 fixed, caught the same way, before it shipped.

## 0.34.62 — 2026-07-30 (trial)

### Added: the extension is now an MCP server Claude can call (10x-plan-2 P0.1)

Until now every Claude edit reached a document the same way — a separate process
wrote the file, and the extension found out by watching it change. That loses
three things at once: the write races whatever you have unsaved, it can't be
undone, and integrity gets checked *after* the damage instead of before it.

The extension now hosts an MCP server (localhost, per-session bearer token) with
the same verbs the `mdc` CLI has:

```
mc_list  mc_reply  mc_open  mc_rewrite  mc_resolve
mc_suggest  mc_accept  mc_reject  mc_check  mc_status
```

Every write goes out as a `WorkspaceEdit` against the live `TextDocument`. So:

- **Cmd+Z undoes Claude.** Its reply or rewrite is on the same undo stack as
  your own typing.
- **Your unsaved work survives.** The edit is ordered against the buffer instead
  of overwriting the file underneath it.
- **A bad call is refused, not repaired.** A tool call that would break marker
  integrity — unknown thread id, a quote that isn't there, a replacement
  carrying a stray marker — comes back to Claude as a structured error with a
  machine-readable code, and the document is untouched. The CLI checked after
  writing; the ops now check before returning.
- **An ambiguous quote is refused too**, with the occurrence count, instead of
  guessing which of three identical sentences you meant.

**The CLI and the tools are one implementation, not two.** The verbs moved to
`src/inlineComments/docOps.ts`; `mdc.ts` and the tool handlers are thin front
ends over them, supplying only their own I/O and error reporting. Two guard
tests enforce it: neither front end may call the format engine's mutators
directly, and both must import the shared ops. A CLI that accepted an edit the
tools refused would be a second, quieter definition of the file format.

**Registration keeps no secret.** `Markdown Collab: Register Review Tools with
Claude Code` (offered once per workspace, never written without a yes) adds a
`markdown-collab` entry to `.mcp.json` whose url and Authorization header are
`${VAR}` references. The real values ride in the environment of terminals VS
Code spawns, so a committed `.mcp.json` leaks nothing, a fresh window mints a
fresh token, and a teammate without the extension sees a server that simply
doesn't connect. The port is derived from the workspace path so the registered
URL usually survives a reload, and falls back to an ephemeral port when taken.

**MCP is supported, never the default.** It can be disabled entirely on Claude's
side — enterprise policy, `--strict-mcp-config`, user config — so `detectSendMode`
never selects it. `terminal` stays the default; the new `mcp` mode appears in the
picker only while the server is running, is used only after you pick it, and
degrades to `terminal` with a toast if the server goes away. Terminal, clipboard,
event log, and the `mdc` CLI are unchanged and permanent.

Security posture of the listener: loopback bind, per-request peer check,
constant-time token compare, `Origin`-bearing requests refused (a localhost port
is reachable from any page the user has open), 1 MB body cap, and paths outside
the workspace refused. 39 new unit tests plus an Extension Host suite that drives
the real HTTP surface against a real workspace.

## 0.34.61 — 2026-07-30 (trial)

### Added: click-level CI for the webviews (10x-plan-2 P2.1)

Every release used to end at the same gate: a manual dev-host pass over
accept/reject, the panel's **Send** button, the suggest toggle, and the live
editor. The logic under each of those was well covered; the click never was. A
batch of twenty-one versions sat unreleased partly for that reason.

There is now a `webview-e2e` CI job that boots the **shipped** webview bundles
(`out/**/client.js`) in real Chromium with `acquireVsCodeApi` stubbed, drives
them with a real pointer, and asserts the exact message each control posts to
the extension host. The host half of every one of those messages is already
contract-tested (`mutations.ts`, `inlineBridge.ts`), so message-equality closes
the loop end to end. 18 specs, ~8 seconds.

Covered: suggestion accept/reject in both surfaces, Send to Claude, the
suggest-mode toggle (including that the webview does *not* flip its own label
before the host confirms), reply, resolve, two-step delete confirm, the pending
"Claude is working…" row, the live editor's select-text→add-comment composer,
and an external (Claude) change landing without echoing back as a local edit.

The live editor got the same treatment as the inline view, which retires the
standing "verified by construction, not observation" caveat on that surface —
Milkdown wouldn't boot in the old JSDOM-ish harness, but it runs fine in
Chromium.

To keep the harness honest rather than merely green:

- **The DOM skeleton has one source.** `inlineCommentsAppBody()` (new
  `src/inlineComments/webviewShell.ts`) is what the panel serves *and* what the
  harness boots. A copy in the test would have kept passing through a rename; a
  unit test now also asserts the skeleton carries every id the client resolves
  at load.
- **Fixtures are built by the real format engine.** Init payloads come from
  `serialize`/`commentsOf`/`suggestionsOf` — the same functions the host uses —
  so a wire-shape change breaks the fixture instead of sliding past it.
  `serialize` moved to `src/inlineComments/serializeState.ts` (vscode-free) and
  is re-exported from the panel.

### Fixed: "Claude is working…" never appeared in the live editor

Found by the new suite on its first run. The live editor's sidebar reconciler
skips repainting a card whose content signature is unchanged, and the signature
didn't include the pending flag — the one thing that flips with no content
change at all. So a dispatch marked the thread, the host pushed the update, and
the card stayed exactly as it was. The inline comments view was unaffected (it
re-renders wholesale).

## 0.34.60 — 2026-07-28 (trial)

### Added: "Claude is working…" on threads awaiting a reply (completes 10x-plan P1.2)

Sending comments to Claude was the one moment in the workflow with no feedback:
you clicked, the payload went out, and nothing changed until the file was
rewritten underneath you. Threads you've sent now carry a muted
**Claude is working…** row, under the last comment — where the reply will land.

This closes P1.2, whose other two affordances (changed spans flashing, the
clickable "Claude edited §Heading" strip) shipped back in v0.34.52.

How it decides:

- **Answered is comment-shaped, not time-shaped.** A thread stops waiting when a
  comment authored by Claude appears that wasn't there at dispatch. Counting
  comments alone would clear the indicator when *you* add a note while waiting;
  checking the author alone would clear it instantly on a thread Claude had
  already replied to before you sent it.
- **Resolving or deleting the thread also ends the wait** — there is nothing
  left to wait for.
- **A 10-minute timeout exists only as a backstop.** A dispatch can go
  unanswered forever (Claude closed, the terminal paste never ran), and a
  permanent "working…" is a lie. Elapsed time otherwise means nothing.
- **Clipboard sends don't mark anything.** Nothing has been delivered until you
  paste it, so claiming Claude is working would be a guess.
- **Review-mode sends don't mark anything** either: they create threads rather
  than addressing existing ones, so there is no card to annotate.

The state lives in the extension host, not a webview, so it survives a panel
reload, appears in whichever view you open next, and reads the same in the
inline comments view and the live editor. Both render it from the same shared
card, and both re-render when the pending set changes — neither marking nor
expiry has a file write to hang off.

*Build note:* marking started at each send call site and immediately missed
one, which the new source-level guard caught on its first run. It now happens
inside `dispatchReviewPayload`'s delivery branches, derived from the payload
itself, so no send path can forget it.

## 0.34.59 — 2026-07-28 (trial)

### Fixed: suggest mode was ignored by the button next to its own toggle

Turning **Suggest: on** in the inline comments view and clicking **Send to
Claude** sent an ordinary prompt, so Claude edited the file directly instead of
proposing accept/reject suggestions.

The toggle, the setting (`markdownCollab.proposeEditsAsSuggestions`), the
command, and the badge were all correct — the flag was simply never read on the
way out. `buildInlinePayload` takes suggest mode as an *optional* argument, and
four of the five send paths didn't pass it:

- the inline panel's **Send to Claude** button (the one beside the toggle),
- the inline panel's **Copy prompt**,
- per-thread **→ Claude** and **Copy**, from both the panel and the live editor
  — `buildSingleThreadPayload` didn't even accept the option, so single-thread
  sends could never request suggest mode at all.

Only the command-palette *Send Unresolved Comments to Claude* passed it, which
is why the feature worked in testing and looked inert in use. All five paths
now read the setting, and single-thread sends carry the directive too: suggest
mode is a property of the request, not of how many threads it covers.

Guarded three ways, because the builders were never wrong and builder tests
would not have caught this: unit tests that both payload builders carry the
directive when asked; an Extension Host test that the per-thread copy path
respects the toggle; and a source-level test asserting every
`buildInlinePayload` / `buildSingleThreadPayload` call site passes a
`suggestMode` read from the setting (verified to fail, naming the exact line,
when the original bug is reintroduced).

## 0.34.58 — 2026-07-28 (trial)

### Added: the first Send to Claude click works it out for you (10x-plan P3.1)

The first click used to open a four-way quick-pick — terminal vs event log vs
MCP channel vs clipboard — whose options the README needs a comparison table to
explain, asked before you have any way to know which your setup supports. Most
of the time the environment already answers it, so now the extension looks:

- A `claude` REPL running in a terminal → **terminal**, no prompt, one toast.
- Otherwise, an MCP channel server registered for this workspace →
  **mcp-channel**, no prompt.
- Neither → the quick-pick, exactly as before.

The terminal wins when both are present: it's live evidence from a
shell-integration event, whereas an endpoint file can outlive the server that
wrote it. The detected mode is remembered like a manual choice and the toast
names the escape hatch (**Reset Send Mode**). If an auto-detected MCP channel
turns out to be stale, the payload still lands in the event log and the choice
un-remembers itself, so the next click asks properly instead of failing the
same way twice. `channel` and `clipboard` are never auto-selected — both need
you to do something afterwards, so they stay explicit.

### Changed: performance headroom for large documents (10x-plan P3.2)

- **`findProseIndex` is a binary search.** It was a linear scan, and
  `mapProseToSource` calls it twice per thread — so building the preview for a
  document with 200 threads scanned the file 400 times.
- **Comment writes are minimal edits, not whole-file rewrites.** Replying to a
  thread changes one line in the threads region; the panel used to apply that
  as a `WorkspaceEdit` replacing the entire file, which re-tokenizes the
  buffer, disturbs folds and decorations, and tells every watcher that
  everything changed. `minimalEdit` strips the common prefix and suffix so the
  edit is the size of the change. (Not a full diff: two distant changes
  collapse into one covering span — correct, still far smaller than the file,
  no diff dependency.)
- **The thread list builds 100 cards per pass**, with a "Show N more" control
  for the rest. Deliberately progressive rendering rather than virtualization:
  cards already built stay in the DOM, so Cmd+F, find-in-page, and scroll
  position keep working, where a windowed list would silently hide threads from
  all three. Counters and preview highlights still cover every thread — the cap
  is a render budget, not a filter. When a review pass lands a new thread past
  the cap, the budget is raised so "jump to Claude's first finding" still has a
  card to jump to.
- **A ~500 KB fixture pins all of it** with deliberately loose timing budgets:
  they exist to catch a return to quadratic behavior, not to benchmark the
  machine.

### Changed: docs hygiene (10x-plan P3.3)

`v1.1-plan.md`, `COLLAB-EXPERIMENT.md`, and `preview-anchor-fix-plan.md`
describe architectures this project no longer has — the JSON sidecar, the
CodeMirror + Yjs spike, and the read-only preview panel. They moved to
`docs/archive/` with a disclaimer each saying what replaced them and why
they're kept. `docs/10x-plan.md` is the live roadmap.

### Changed: the skill and its helpers can't drift apart (10x-plan P3.4)

The activation-time update nag, the one-click reinstall, and a fingerprint
covering `SKILL.md` plus all three helper scripts were already in place from
P0.1. What was missing was the guard that they stay in sync: a test now fails
if a fresh install writes a file the fingerprint doesn't hash — otherwise a
future helper could ship stale forever, because nothing would ever detect that
the installed copy was out of date.

**With this, every initiative in `docs/10x-plan.md` — P0 through P3 — has
landed.**

## 0.34.57 — 2026-07-28 (trial)

### Fixed: `../images` didn't render in the PR/MR review view

The PR review preview carried its own hand-rolled image-src resolver — a copy
of the logic from before v0.34.31, which fixed exactly this — so a relative
image that climbs out of the document's directory resolved to
`<docDir>/diagrams/flow.png` instead of `<docDir>/../diagrams/flow.png` and
404'd. It rendered correctly in the inline comments view and the live editor
the whole time, because those two share the fixed resolver.

The PR view now uses the same `resolveImageSrc` as the other surfaces.
Verified headlessly: the same document through the inline view and the PR view
now produces byte-identical image URLs, the same PlantUML URL, and the same
mermaid block.

### Changed: one asset/embed layer for every surface (10x-plan P2.3)

Two renderers is a permanent fact of this codebase — the inline and PR views
use markdown-it, the live editor uses Milkdown/ProseMirror — and that split has
produced 21 image/diagram entries in this changelog. Full unification isn't
realistic, but the layer where the divergences actually happen is the asset and
embed handling, and that is now one implementation:

- **`webviewShared/markdownPipeline.ts`** builds the markdown-it renderer for
  both markdown-it surfaces. They previously constructed it by copy-paste,
  which is how the PR view drifted. Plugin install order is now stated as the
  contract it is: the PlantUML fence rule chains to whatever fence rule was
  registered before it, so installing it before the source-offset plugin
  silently loses mermaid and comment anchoring on every fence.
- **`collab/drawioService.ts`** owns reading a `.drawio` file for a webview.
  Both hosts call it, so the inline comments panel no longer imports the live
  editor's `CollabEditorProvider` just to resolve a diagram path — that import
  was the only thing coupling the two views. `drawioRejectReasonMessage` moved
  next to the rejection reasons it explains, so every surface refuses a bad
  href with the same words.
- **`src/test/fixtures/embeds.md`** is one document with every embed type —
  sibling / nested / parent-relative / workspace-absolute / remote /
  protocol-relative / data images, mermaid, both PlantUML fence spellings, a
  drawio link, and lookalikes inside code. `sharedEmbeds.test.ts` renders it
  through the shared pipeline and asserts both surfaces agree, every image
  reference resolves to something loadable with no un-normalized `/../`,
  mermaid and PlantUML emit what their clients expect, and drawio hrefs resolve
  inside the workspace and are refused outside it.

## 0.34.56 — 2026-07-28 (trial)

### Fixed: only the first comment in a paragraph was highlighted

In the inline comments view, a paragraph with two or more anchored comments
showed a highlight for only the first one. `wrapSpanRange` looked at a prose
span's *first* text node, but the first highlight splits that node in three —
so every later comment in the same paragraph computed offsets against text
that was no longer there and silently gave up. It also rebuilt the span's
children with `appendChild`, which appends at the end: had the offsets
happened to line up, it would have reordered the paragraph's text rather than
losing a highlight.

It now walks every text node under the span, wraps in place with `splitText`,
and skips text already inside a highlight (nested marks render as one darker
blob and say nothing). Verified headlessly with three comments in one
paragraph: all three highlight, in order, with the prose byte-identical
through a find cycle.

Also: closing the find bar left a stale "No results" counter behind it — the
label was recomputed before the query was cleared.

### Changed: test the fragile layer (10x-plan P2.4)

The webview clients and host glue are where this project's regressions have
always lived, and they had almost no coverage. Three moves, +107 unit tests
and a working integration suite:

**Pure logic extracted from the webview clients** into
`webviewShared/threadListState.ts` (filters, counters, the "N new from Claude"
summary, the next-unread walk, collapse-all, and the live editor's
reconciliation signature), `webviewShared/findState.ts` (match finding, index
stepping, counter label), `webviewShared/highlightSlices.ts` (the offset
arithmetic behind the fix above), and `inlineComments/proseMapping.ts` (prose
↔ source offsets, moved out of the panel so it no longer needs `vscode` to be
tested). The inline view and the live editor now compute their counters from
the same code.

**Message-protocol contract tests.** Every document mutation the inline
webview can request now goes through one pure
`applyClientMutation(parsed, msg, ctx)` in `inlineComments/mutations.ts`; the
panel keeps the `WorkspaceEdit`, the save, and the warning toast. Tests drive
recorded messages against real documents and assert the resulting file:
anchoring a duplicate table-cell value, mapping offsets past frontmatter,
refusing to anchor inside a code fence, tombstoning a comment that has replies
versus deleting a leaf, accept/reject of suggestions, and whole
comment→reply→resolve→reopen→delete sequences that must leave the file
byte-identical to where they started.

**The integration suite works again.** It had been red for months without
anyone being able to tell: a stale `out/` directory fed the test glob compiled
tests from the deleted sidecar architecture. `npm run test:integration` now
cleans first; the dead tests are gone; fixtures use inline threads instead of
sidecar JSON; and the inline-bridge contract test was updated to the behavior
we actually chose (an unplaceable anchor is saved loosely rather than
refused — a comment is never lost). Then grown with the regressions that
actually happened, replayed in a real Extension Host: duplicate table-cell
anchoring, editing inside an anchored span, orphaning a thread by deleting its
passage, one-click repair of stripped markers, an external change reaching an
open document, and suggest mode reaching the dispatched prompt. 28 passing.

### Fixed: CI has been red since v0.34.44 for a stale reason

CI's "verify runtime deps are bundled" step asserted that `yjs`, `y-protocols`,
`lib0`, `ws`, and `markdown-it` were present inside the packaged `.vsix`. Those
dependencies were deleted in v0.34.44–0.34.46 (and the rest are inlined by
esbuild), so the step had failed on every push since — a guard that fails for a
reason no one is reading is worse than no guard.

Replaced with `scripts/verify-package.mjs`, which checks what the package
actually needs: every asset the extension loads by URI (all three webview
bundles, their stylesheets, the shared comment CSS, the mermaid script) and
that `out/extension.js` requires nothing that wasn't bundled — the real form of
"a runtime dependency went missing". CI also gained an `integration` job that
runs the Extension Host suite under `xvfb`, which had never run in CI at all.

## 0.34.55 — 2026-07-28 (trial)

### Added: multi-file review sessions (10x-plan P1.3)

"Ask Claude to Review" was per-file, but real doc work is a `docs/` folder or a
PR's worth of files. It now takes a **folder or a multi-select**: right-click a
folder in the explorer → **Markdown Collab: Ask Claude to Review These Docs**,
or select several `.md` files and use the same action. Every `.md` under the
selection (excluding `node_modules`) goes into **one** review pass.

One pass rather than N is the point: it lets Claude do the thing a per-file
review structurally cannot — compare the documents against each other.
**Cross-document consistency is part of the pass**, not an optional extra:
terminology that drifts between files, a claim in one file contradicted by
another, guidance duplicated in two files that has since diverged, and
cross-references that no longer resolve. Such a thread is anchored in the file
that's wrong (or the more prominent one when neither clearly is) and names the
other file and its conflicting text in the body, since the human reads the
thread without the other file open.

Details:

- One focus prompt covers the whole selection, with the same recent-focus
  quick-pick as the single-file flow.
- The 50 KB soft confirm now applies to the **summed** size, read via
  `fs.stat` — no documents are opened just to measure them.
- A selection spanning several workspace folders is reviewed one folder at a
  time (relative paths and the event log are both folder-scoped); the skipped
  count is reported rather than silently dropped.
- The payload gained a `files` array; `file` carries a human label
  ("3 files under docs/") for toasts and the event-log envelope.
- Every open Inline Comments panel in the selection gets the pending-review
  notification, so each scrolls to Claude's first new thread when the pass
  lands.
- The skill gained a **Multi-file review passes** section: read every listed
  file end to end *before* opening any thread, then work file by file in the
  listed order, verify each with `mdc check` before moving on, and report
  per-file counts with cross-document findings called out separately.

### Added: Next Unread from Claude walks across files

The "N new from Claude · Next" affordance was per-document. **Markdown Collab:
Next Unread from Claude** — also the → button in the Markdown Review view's
title bar — walks every thread Claude opened and you haven't answered, across
all files in the tree, in path order, wrapping at the end. It opens the file
with the thread's anchored passage selected, and shows position ("3/12") in the
status bar. Backed by `ReviewView.listClaudeUnread()`, which reads the tree's
existing cache; `ensureScanned()` populates it for the command even when the
tree was never expanded.

## 0.34.54 — 2026-07-28 (EXPERIMENTAL — dogfood build, not for the marketplace)

**Experimental pre-release for hands-on testing in real VS Code.** It bundles
everything since the last public release (0.34.39) — a large batch implementing
most of the 10x plan. Install it to dogfood; keep real work on the published
marketplace version until this is promoted.

Highlights to exercise (see the individual entries below for detail):

- **Suggest mode (reviewable AI edits) — the headline feature.** Turn on the
  **Suggest: on** toggle next to Send-to-Claude (or the *Toggle Suggest Mode*
  command), send, and Claude proposes edits as accept/reject **suggestions**
  instead of applying them. Review them as inline-diff cards in **both** the
  inline comments view and the live editor; Accept applies, Reject keeps the
  original.
- **Marker-safe comment editing.** Claude now mutates comments through the
  bundled `mdc` helper (structured, integrity-checked) rather than hand-editing
  markers. Damaged anchors are detected on save with a one-click **Repair**.
- **Claude presence in the live editor.** When Claude edits the open file, the
  changed span flashes and a "Claude edited §Heading" strip points you to it.
- **Live editor is lighter.** The dead multi-peer relay and the local Yjs layer
  are gone (~110 KB off the webview bundle, 8 dependencies removed). Undo,
  typing, and external-change convergence should behave exactly as before.
- **Unified comment UI** across all three review surfaces.

**Please focus testing on the document write paths** — accepting/rejecting
suggestions, addressing comments, and Claude editing the file while the live
editor is open — since those write-and-refresh flows are the parts verified so
far only by unit tests and headless checks, not a running Extension Host.

## 0.34.53 — 2026-07-27 (trial)

### Changed: one shared bundle step for comments.css (completes 10x-plan P2.1)

The shared comment stylesheet was copied to each webview's output directory by
three separate `copyFileSync` calls scattered inside the three `bundle:*`
scripts. They're now a single `copy:shared-css` step
(`scripts/copy-shared-css.mjs`) — one source of truth for the copy, so the
shared CSS can't be updated for one view's build and forgotten for another's.
No output change (each webview still loads `comments-shared.css` from its own
localResourceRoot). This finishes the last remaining item of P2.1.

## 0.34.52 — 2026-07-27 (trial)

### Added: Claude presence in the live editor (10x-plan P1.2)

When Claude edits the open `.md`, the change is no longer a silent flash. The
live editor now:

- **flashes the exact span Claude edited** with a green tint that fades over a
  few seconds, so the eye lands on what changed, and
- shows a **clickable status strip naming the nearest heading** — "Claude
  edited §Heading ↗" — that scrolls the editor to the change.

The host computes the changed span (a prefix/suffix diff of the old vs new
prose) and the nearest heading on the existing externalChange push; the webview
locates that text in the rendered document and decorates it. Best-effort by
design: a change whose text carries markdown syntax simply isn't flashed, and
the notice still fires. New `src/collab/changeSummary.ts` is pure and unit
tested. Not included: cursor-level streaming presence (there is no relay, by
design) or the "Claude is working…" in-flight indicator.

## 0.34.51 — 2026-07-27 (trial)

### Added: "propose as suggestions" toggle on Send-to-Claude (10x-plan P1.1, part 2c — completes P1.1)

Send-to-Claude now has a suggest-mode toggle. When on, the prompt asks Claude
to propose every edit as a suggestion (`mdc suggest`) instead of applying it
directly — closing the loop that started with the storage foundation: toggle
on → send → Claude proposes → you accept/reject in the review view.

- A per-workspace setting `markdownCollab.proposeEditsAsSuggestions` (default
  off), a **Toggle Suggest Mode** command, and a **Suggest: on/off** toggle in
  the inline comments view next to Send-to-Claude. All three stay in sync.
- The send prompt gains a terse suggest-mode directive only when the toggle is
  on; the skill's Suggest Mode section (0.34.48) does the rest. Both the
  inline "Send to Claude" and the live editor route through the same payload
  builder, so the toggle governs both.

Verified: the prompt directive is unit-tested (present only when on), and the
inline toggle's reflect-state / post-message / update-on-refresh loop was
checked headlessly.

**P1.1 (suggestion mode / reviewable AI edits) is now complete:** authoring via
`mdc suggest` + the skill, graphical accept/reject in both the inline view and
the live editor, and a send-mode toggle to request it. The document write paths
(inline WorkspaceEdit + live-editor writeDocument) remain worth a dev-host pass.

## 0.34.50 — 2026-07-27 (trial)

### Added: accept/reject suggestions in the live editor (10x-plan P1.1, part 2b)

The suggestion review UI from 0.34.49 now also appears in the live collab
editor. Pending suggestions render as cards above the comment threads in the
sidebar — the same shared `buildSuggestionCard` (inline diff + rationale +
Accept / Reject) the inline view uses, so both review surfaces are identical.

- New `suggestionsOf` in `inlineBridge.ts` serializes `parse().suggestions`
  with the same text+ordinal anchor scheme the live editor uses for comments.
- The collab editor host includes suggestions in its init and `sidecar-changed`
  payloads, and applies accept/reject through the format engine and its normal
  `writeDocument` → save → refresh path (the same path comment mutations use).
  Accept is guarded on a live anchor; an unanchored suggestion offers only
  Reject.

Verified headlessly against the compiled bundle: the card renders in the live
editor sidebar with the affix-aware diff, and Accept/Reject post the correct
host messages. With this, suggest mode's review loop works in both the inline
comments view and the live editor. (The remaining P1.1 item is the optional
"propose as suggestions" toggle on Send-to-Claude.)

## 0.34.49 — 2026-07-27 (trial)

### Added: accept/reject suggestions in the inline comments view (10x-plan P1.1, part 2a)

The suggestion foundation (0.34.48) gets its graphical loop in the inline
comments view. A pending suggestion now renders as a card with an inline
diff — the original struck through, the proposed text inserted, and only the
changed middle emphasized against the common prefix/suffix so a small edit
reads at a glance — plus a rationale note and **Accept** / **Reject** buttons.

- Accept applies the proposed text into the prose; Reject drops the suggestion
  and keeps the original. Both go through the same marker-safe format-engine
  transforms and the panel's existing WorkspaceEdit → save → refresh path, so
  undo/redo and dirty state work normally. An unanchored suggestion (markers
  lost) disables Accept and offers only Reject.
- The suggestion's original text is marked in the preview with a dashed accent
  underline (distinct from the solid comment highlight); clicking it scrolls to
  the card, and clicking the card scrolls to the preview.
- New shared `buildSuggestionCard` in `commentUi.ts` — built once, so the live
  editor (next) reuses it. The host serializes `parse().suggestions` (their
  anchors are already in the same prose-space map as comment anchors).

Verified headlessly against the compiled bundle: the card's affix-aware diff,
the preview highlight, and Accept/Reject posting the correct host messages.

## 0.34.48 — 2026-07-27 (trial)

### Added: suggestion storage + CLI — the foundation for reviewable AI edits (10x-plan P1.1, part 1)

The tool's premise is *review*, but Claude's own edits were the one thing that
couldn't be reviewed in it: Claude rewrote the file and the human saw "Updated
from disk". Suggest mode fixes that inverted trust model — Claude's edits
become pending suggestions the human accepts or rejects. This release lands
the storage and authoring foundation; the accept/reject UI follows.

A suggestion keeps the **original** text in the prose, wrapped in the same
paired anchor markers a comment uses, and stores the **proposed** replacement
in a `<!--mc:s {JSON}-->` line inside the threads region. So the file still
renders as the original in any Markdown viewer — the proposal is invisible,
consistent with the no-sidecar principle. Accepting swaps original→proposed
(marker-safe); rejecting keeps the original. Both are byte-reversible.

- `src/inlineComments/format.ts`: `InlineSuggestion` model, parse/serialize of
  `mc:s` lines, and `addSuggestion` / `acceptSuggestion` / `rejectSuggestion`
  transforms. `withThreads` preserves pending suggestions across thread edits.
- Integrity: suggestion anchors are recognised (not flagged as orphans), and a
  suggestion that loses its markers is reported as `unanchored-suggestion`.
- `mdc` CLI: `suggest`, `accept`, `reject` commands, and `list` now surfaces
  suggestions with their original + proposed text. Same refuse-don't-guess
  posture as the rest of the CLI (ambiguous passages, code spans).
- The round-trip corpus gained suggestion-in-combination cases (a comment and
  a suggestion on the same gnarly document, accept/reject invariants).
- The Claude skill gained a **Suggest Mode** section: when the human asks for
  proposed (not applied) changes, Claude routes every edit through
  `mdc suggest` and never accepts its own suggestions.

The accept/reject UI in the review views, the "propose as suggestions"
send-mode toggle, and full end-to-end verification are the next increment.

## 0.34.47 — 2026-07-27 (trial)

### Changed: the live editor renders comments from the shared UI module (10x-plan P2.1)

The live collab editor built its comment cards, reply box, and composer from
its own string-HTML templates, duplicating what the inline-comments and PR
views already get from `src/webviewShared/commentUi.ts`. Every card feature
had to be written two or three times. The live editor now builds its inner
comment cards with the shared `buildCommentCard` and its reply/add-comment
composers with the shared `buildComposer`, so all three surfaces render from
one implementation.

The `.mdc-comment` thread frame, the anchor-quote header, the thread-action
row (→ Claude / Copy / Resolve / Delete thread), and the incremental
reconciler that preserves an in-progress reply across updates stay
view-specific — only the per-comment card and composer chrome moved to the
shared module. The shared module gained one small, reusable addition: a
two-step `confirm` option on card actions (used for the in-place
"Confirm?" → "Deleting…" delete), replacing a bespoke copy.

As a side effect the live composer picks up the shared composer's niceties it
lacked — submit disabled while empty, Cmd/Ctrl+Enter to submit, Esc to
cancel — and ~130 lines of duplicated rendering plus the now-dead
`.mdc-composer-*` / `.mdc-reply-input` / `.mdc-delete-confirm-*` CSS are gone.

Verified headlessly against the compiled bundle: thread and shared-card
rendering, resolve/reply/two-step-delete all posting the same host messages as
before, and the incremental reconciler preserving an unchanged thread's DOM
(and its half-typed reply) while rebuilding a changed one. A dev-host visual
pass is still worth doing — the reply box and composer now wear the shared
`.mc-composer` styling instead of the old `.mdc-*` styling (intended).

## 0.34.46 — 2026-07-27 (trial)

### Removed: the local Yjs layer from the live editor (10x-plan P2.2, part 2)

With the relay gone (0.34.44), the live editor's Yjs document was doing almost
nothing: undo is prosemirror-history, saving serializes the ProseMirror doc,
and awareness/cursors were inert with no peers. The one thing Yjs still drove
was applying Claude's disk-side `.md` edits into the open editor.

That path is rewritten to parse the incoming markdown with Milkdown's
`parserCtx` and dispatch a document-replace transaction (marked
`addToHistory:false`, so an external edit stays out of your local undo stack —
matching the old collab behaviour). With that, the collab plugin and the Yjs
document/awareness wiring are removed, and so are the dependencies
`@milkdown/plugin-collab`, `yjs`, `y-protocols`, and `y-prosemirror` — about
110 KB off the webview bundle. Undo stays on prosemirror-history; the editor
seeds its content from `defaultValueCtx`.

Verified with a manual live-editor pass (typing/saving, undo, cursor and
scroll preservation across an external change, comment-anchor highlight
tracking), after a headless smoke test of the compiled bundle confirmed boot,
seed, and external-change apply. Shipped first as the experimental pre-release
v0.34.45 for that verification; this is the finalized landing.

## 0.34.44 — 2026-07-25 (trial)

### Removed: the dead multi-peer relay layer (10x-plan P2.2, part 1)

The real-time collaborative relay was walked back in v0.34.6/0.34.7 — the
live editor is one human plus Claude, converging through the `.md` file, with
no websocket. The machinery lingered: a 265-line y-websocket server, the
seed-encoding module, per-document "room" hashing, a `serverUrl` setting, and
the `ws` / `y-websocket` dependencies. All of it was unreferenced by runtime
code — bundle-adjacent weight, supply-chain surface, and a standing source of
confusion.

Removed:

- `src/collab/server.ts` and `src/collab/seedEncoding.ts` (both proven to
  have no non-test importers), plus their unit tests.
- `computeRoom()`, the `room` and `serverUrl` fields in the editor's init
  payload, and the `collab.serverUrl` setting read — none were consumed by
  the webview.
- The `connect-src ws: wss:` Content-Security-Policy directive: the editor
  webview opens no sockets or fetches, so `connect-src` now falls back to
  `default-src 'none'`, blocking all of them. A small security tightening.
- Dependencies `ws`, `y-websocket`, `@types/ws`, and `y-codemirror.next`
  (the last was already imported nowhere). Net ~700 lines of dead code and
  four packages out of the tree.

The editor itself is unchanged: it keeps its local-only Yjs document
(`yjs`, `y-protocols`, `y-prosemirror`, `@milkdown/plugin-collab`), so how
the human types and how Claude's disk-side edits land are exactly as before.
Bundle size is essentially unchanged, because the relay was never reachable
from a bundle entry point in the first place — the win here is the dead code
and the dependency tree.

A follow-up will evaluate removing the local Yjs layer too (analysis shows
undo is prosemirror-history, not Yjs, and the only load-bearing Yjs use is
the external-change apply path). That change touches the headline
convergence path and will land separately, after a manual live-editor pass.

## 0.34.43 — 2026-07-25 (trial)

### Added: damaged comment anchors are reported immediately (10x-plan P0.2)

The `mdc` helper stops Claude from breaking markers. It cannot stop a
formatter, a merge, or a hand edit — and until now that damage surfaced
lazily as a "broken anchor" badge, often long after the context needed to
fix it was gone.

Every watched `.md` change is now checked. When a document's anchors are
damaged, a single non-modal warning names the file and the number of
problems, and offers a one-click **Repair**. A new command,
**Markdown Collab: Repair Comment Anchors**, does the same for the active
file from the palette.

Repair strips stray markers, removes anchors whose thread is gone, and
re-anchors threads whose quote still matches exactly one place in the prose.
It never guesses at an ambiguous quote, and it never alters prose — if a
repair would change a single character of prose, the whole batch is abandoned
and reported instead.

Notifications are deduplicated per file and per distinct problem set, so a
damaged document warns once rather than on every save; if the file is fixed
and later breaks the same way again, that is reported as new.

Note the guard reports rather than auto-writes. Repair is safe by
construction, but a review tool that silently rewrites the file it is
reviewing spends exactly the trust it exists to build, so the decision stays
with the human.

## 0.34.42 — 2026-07-25 (trial)

### Added: the `mdc` helper — Claude no longer hand-edits comment markers (10x-plan P0.1)

The skill used to ask Claude to edit `<!--mc:a:ID-->` markers and
`<!--mc:t {JSON}-->` lines with string surgery, and warned about dropping a
marker three separate times — a tell that prose instructions were not enough.
One dropped `-->` silently orphans a reviewer's comment, so all of that risk
lived in the model's diligence.

A new helper, installed alongside the skill at
`~/.claude/skills/vs-markdown-collab/mdc.mjs`, now performs every
marker-level mutation through the same engine the extension itself uses:

| Command | What it does |
| --- | --- |
| `list <file> [--actionable]` | Threads as JSON, with each thread's live anchored text |
| `reply <file> <id> --body TEXT` | Appends a reply with the correct `c<N>` id and timestamp |
| `rewrite <file> <id> --with TEXT` | Replaces the anchored span; markers preserved by construction |
| `open <file> --quote TEXT --body TEXT` | Opens a thread: mints an id, wraps the passage, appends the line |
| `resolve <file> <id>` | Marks a thread resolved |
| `check <file> [--repair]` | Integrity report; repairs what can be fixed without guessing |

The helper refuses rather than guesses: an ambiguous passage asks for
`--occurrence`, and anchoring inside a code span, frontmatter, or the threads
region is rejected outright. Mutating commands re-check the document before
writing and refuse if the change would introduce a new integrity problem, so
a failed command leaves the file untouched rather than half-edited.

The skill's phases now route through it — discovery via `mdc list`, edits via
`mdc rewrite`, replies via `mdc reply`, new threads via `mdc open`, and
verification via `mdc check` — with the previous hand-editing instructions
kept as a documented fallback for installs without the helper.

The helper is `src/skillCli/mdc.ts` bundled with the real format engine into
a dependency-free ESM script; a test fails the build if the committed bundle
is stale, so the CLI and the engine can never drift apart.

## 0.34.41 — 2026-07-25 (trial)

### Added: golden round-trip corpus and a shared integrity checker (10x-plan P0.3)

Anchoring bugs in this project have historically been fixed one at a time,
with nothing guarding the *combination* space — a comment on a table cell
with a duplicate value, in a document with frontmatter, edited in place,
then undone. There is now a corpus of realistic documents driven through
scripts of realistic operations, asserting five invariants after every
single step: integrity, prose fidelity, anchoring, quote fidelity, and
serialization stability.

New `src/inlineComments/integrity.ts` is the shared checker behind it —
it names every way a document can be broken (unpaired markers, orphaned
anchors, unanchored threads, malformed thread JSON, duplicate ids) and
repairs the subset that can be fixed without guessing. Repairs may only
touch markers and the threads region; if a repair would alter a single
character of prose, the whole batch is abandoned and reported instead.

The corpus found two real bugs on its first run, both fixed here:

- **Commenting inside a code span silently produced a broken thread.**
  Markers inside code are deliberately ignored by the parser so that a
  `<!--mc:a:xxx-->` in a code sample stays inert — which meant markers
  written there for a real comment were inert too, and the thread came
  back unanchored with no explanation. Anchoring inside a code block or
  code span is now refused up front, the same way anchoring inside
  frontmatter or the threads region already was.
- **Adding then deleting a comment appended a blank line to the document,
  every time.** Removing the threads region stripped only one of the two
  newlines around it, so the file grew by one line per cycle. Add/remove
  is now byte-for-byte reversible.

## 0.34.40 — 2026-07-25 (trial)

### Fixed: the reply box in the inline comments view can be resized

Replying to an existing comment used a fixed-height textarea (`resize: none`)
while every other composer in the extension allows vertical resizing. Drag
its bottom edge to make room for a longer reply.

## 0.34.39 — 2026-07-23

### Published to the marketplaces

Public release rolling up since 0.34.37:

- Live collab editor: ⌘F / Ctrl+F find widget — searches the document and
  the comments sidebar with match highlighting and next/prev.

## 0.34.38 — 2026-07-23 (trial)

### Added: find in the live editor

The live collab editor now enables VS Code's find widget — press ⌘F /
Ctrl+F to search the document and the comments sidebar with match
highlighting and next/prev.

## 0.34.37 — 2026-07-21

### Published to the marketplaces

Public release rolling up everything since 0.34.34:

- PR/MR review: All / Open / Resolved filter chips on existing comments,
  with GitHub resolved state fetched via the GraphQL `reviewThreads` API.
- PR/MR review: 💬 comment markers in the preview — blocks with existing
  threads or drafts show a clickable chip that jumps to the matching
  card(s) in the right pane.
- PR/MR review: ⌘F / Ctrl+F find widget enabled in the review panel.

## 0.34.36 — 2026-07-21 (trial)

### Added: comment markers in the PR review preview

Blocks whose source lines carry existing PR threads or your drafts now show
a clickable 💬 chip (with a count when there's more than one) on their right
edge. Clicking scrolls the right pane to the matching card(s) and flashes
them — the reverse of the cards' "Line N" jump buttons. Chips go muted when
every thread on them is resolved, and clicking a thread hidden by the
Open/Resolved filter widens the filter to "All" first.

### Added: find in the PR review view

The review panel now enables VS Code's find widget — press ⌘F / Ctrl+F to
search the rendered preview, drafts, and existing comments with match
highlighting and next/prev.

## 0.34.35 — 2026-07-16 (trial)

### Added: filter existing PR/MR comments by resolved state

The PR review view's "Existing comments" section now has All / Open /
Resolved filter chips (with counts), so a long review can be narrowed to
just the open threads. The choice is remembered per webview and the chips
only appear when at least one thread is resolved — nothing changes on PRs
where everything is still open.

GitHub reviews now carry resolved state at all: the REST comments endpoint
doesn't expose it, so the platform adapter additionally queries the GraphQL
`reviewThreads` API (paginated) and marks each comment with its thread's
`isResolved`. GitLab already provided it. If the GraphQL call fails (older
`gh`, restricted token), every thread is treated as open and the review
works as before.

## 0.34.34 — 2026-07-15

### Published to the marketplaces

Public release rolling up everything since 0.34.28:

- Comment anchors now survive editing the commented text in place — the live
  editor tracks each marker through edits via its own position mapping, with a
  hardened text-matching fallback for moved text (table cells, line-start
  anchors, emoji included).
- Undo after deleting commented text no longer orphans the comment.
- Local images referenced by relative paths that climb out of the file's
  folder (e.g. `../diagrams/arch.png`) now render in both the inline preview
  and the live editor.
- The PR review preview shows source line numbers in a left gutter for every
  top-level block, matching the comment cards' "Line N" buttons.
- The PR review submit bar stays pinned to the bottom of the pane instead of
  floating mid-window when the draft list is short.

## 0.34.33 — 2026-07-15 (trial)

### Fixed: submit bar no longer floats mid-window

With few (or no) drafts, the PR review view's submit bar (verdict +
summary + Submit button) sat in the middle of the sidebar instead of at
the bottom — `position: sticky` only pins while content overflows. The
bar is now pushed to the pane's bottom edge when content is short, and
still sticks to the bottom while a long draft list scrolls.

## 0.34.32 — 2026-07-15 (trial)

### Added: source line numbers in the PR review view

The PR review preview now shows the source line number of every top-level
block in a left gutter — headings, paragraphs, lists, tables, and code
blocks each carry a muted number where they start in the `.md` file. The
numbers use the same source mapping as the draft and existing-comment
cards' "Line N" buttons, so a card's line and the gutter number always
agree. Rendered as unselectable pseudo-elements, they never leak into a
text selection when drafting a comment.

## 0.34.31 — 2026-06-20 (trial)

### Fixed: local images (incl. `../sibling/x.png`) now render in both views

Markdown images referenced by a relative path that climbs out of the file's
folder — e.g. `![](../diagrams/arch.png)` — didn't show. The inline preview
resolved the `..` wrong (it never left the document's own directory), and the
live editor didn't rewrite image paths at all, so neither could load the file.

Both views now resolve image `src` the same way (a shared, `..`-aware resolver)
and the live editor renders local images via a node view that rewrites the
display URL only — the markdown still saves with the original relative path.
Images load for any path the workspace folder covers.

### Fixed: undo no longer orphans a comment

Deleting commented text and then pressing undo left the comment orphaned — the
editor can't resurrect a highlight whose text was deleted, so it reported
nothing on undo. The host now recovers such a comment by re-anchoring it to a
unique occurrence of its stored quote when the text reappears.

## 0.34.30 — 2026-06-16 (trial)

### Comment anchors now track edits via the editor's own position mapping

Reworked how a comment's marker survives editing the commented text. The live
editor's anchor highlights are ProseMirror decorations that map through every
edit losslessly, so the editor now reports each comment's current position on
each edit and the host places the marker exactly there — no re-deriving
positions by matching the old quote. Editing inside a commented span (even one
character, even in a table cell that re-pads) keeps the marker and the
highlight, with no need to reopen the editor.

The previous text-matching re-anchoring is kept as a fallback (and for moved
text), now hardened:

- The live highlight no longer rebuilds from stale data on every keystroke (it
  maps through the edit instead), so a just-edited highlight stops vanishing
  until reopen.
- Editing inside a commented span no longer jumps the marker to a duplicate of
  the old text elsewhere; line-start anchors survive; deleting the whole
  anchored text unanchors cleanly instead of leaving an empty marker; markers no
  longer wrap padding whitespace; editing an emoji mid-anchor can't corrupt it.
- Resolved comments are tracked too, so editing near one keeps its marker.

## 0.34.29 — 2026-06-15 (trial)

### Fixed: editing commented text no longer removes its marker

Changing a character inside a commented span dropped the comment's anchor: the
live editor re-anchored only by re-finding the original quote, so any in-place
edit (even one character in the middle) made the quote unmatchable and orphaned
the thread. Tables made it worse — the file's column padding differs from the
editor's, so the first edit looked like the whole table changed.

Re-anchoring is now three-tier: find the unchanged quote (edits elsewhere /
reflow); else, if the edit is enclosed by the marker, map the marker's bounds
through it (paragraphs, headings, lists); else re-anchor by the unchanged text
bracketing the span on its own line, whitespace-normalised so table column
re-padding and separator-row reflow don't defeat it. The comment now tracks the
edited text instead of disappearing.

## 0.34.28 — 2026-06-15

### Published to the marketplaces

Public release. Brings the table-cell commenting fix from 0.34.27 public:
commenting on a table cell (including repeated values like "Yes") now anchors
the thread with inline markers instead of saving it loosely.

## 0.34.27 — 2026-06-15 (trial)

### Fixed: commenting on a table cell now adds markers (even for duplicate values)

Commenting on a table cell saved the thread but often dropped the inline
markers, so the comment wasn't anchored in the file. The editor can't compute
exact source offsets for a cell, so the host located the text by its rendered
surrounding context — which never matches the markdown source (no `|`, no `**`).
For a repeated value like "Yes" that was un-disambiguable, so it saved loosely
with no markers.

Fix: the editor now reports which occurrence of the selected text it is
(`anchorOrdinal`), and the host places the marker on that occurrence when
context can't. Same ordinal approach the highlight uses, so a fresh table-cell
comment is anchored and highlighted immediately.

## 0.34.26 — 2026-06-15

### Published to the marketplaces

Public release rolling up everything since 0.34.15:

- Anchor highlights now show on table cells, headings, and lists (located by
  marker ordinal instead of surrounding-markdown context).
- Short selections (< 8 chars) get a marker again.
- Tables fill the editor width with auto column sizing.
- Per-thread "→ Claude" / "Copy" and an always-on reply box in the live editor;
  per-comment delete with an inline confirm.
- Comment cards reconcile in place instead of re-rendering the whole list.
- Document-style links in the comment panel open as document links.
- Prompt to install/update the Claude skill on activation; stronger
  marker-migration guidance so AI edits don't orphan comments.
- Inline view: simpler "Select text to add a comment" hint (floating button
  only; the `C` shortcut is gone).
- Fixed a stray NUL byte in the live-editor source.

## 0.34.25 — 2026-06-15 (trial)

### Changed: simpler "add a comment" hint in the inline comments view

The preview hint now reads "Select text in the preview to add a comment" — the
floating button that appears on selection is affordance enough, so the
"press C or use the floating button" instruction (and the `C` keyboard shortcut
it advertised) are gone.

## 0.34.24 — 2026-06-15 (trial)

### Fixed: stray NUL byte in the live-editor source; verified the table-cell highlight

A stray NUL byte had crept into `src/webview/client.ts` (the `lastHighlightSig`
initializer was a NUL instead of a space). It made the file read as binary to
tooling and risked corrupting the bundled output. Replaced it with the intended
space.

Also added a small `highlight-report` message: the live editor now reports which
comment anchors it actually decorated. That made it possible to verify the
0.34.23 table-cell highlight fix against the real compiled webview bundle — the
bold-table-cell anchor ("Single writer per domain", whose stored context is pure
table markdown) is highlighted by ordinal, confirmed end-to-end.

## 0.34.23 — 2026-06-15 (trial)

### Fixed: comment highlights now show on table cells, headings, and lists

The live editor located an anchored span by matching its text **plus the
surrounding markdown as "context"** against the editor's rendered text. For an
anchor inside a table cell (or a heading, or a list), that context carried
markdown structure — `|`, the `:----` separator row, `#`, `**` — that doesn't
exist in the rendered text, so the match failed and the span went un-highlighted.
(That's why it looked like there was "no highlight", and why it sometimes
reappeared only after Claude re-edited.)

Fix: the marker already records **which occurrence** of the text is anchored, so
the highlight now finds that occurrence by its ordinal and drops context
matching entirely — no more structural-markdown false negatives. Removed the
temporary 0.34.17 diagnostic logging.

## 0.34.22 — 2026-06-14 (trial)

### Added: startup prompt to install/update the Claude skill

The only signal that the Claude skill was missing or out of date used to be a
banner in the inline comments panel — which you'd never see if you worked in the
live editor or didn't open that panel. Now, on activation, if the skill is
missing or out of date the extension shows a notification with an **Install
skill** / **Update skill** button. It's gated per skill version, so it prompts
once when the bundled skill changes, not on every window.

## 0.34.21 — 2026-06-14 (trial)

### Changed: live editor tables fill the editor width

Follow-up to 0.34.20 — the auto-sized table now stretches to the editor width
(`width: 100%`) with content-proportional columns, instead of shrinking to its
content and floating narrow in a wide pane. The "#"/No. column still stays
narrow; the prose columns share the slack.

## 0.34.20 — 2026-06-14 (trial)

### Changed: live editor tables size columns to their content

Tables in the live editor used an even, fixed column layout, so a one-character
"#" / No. column got the same width as a prose column. Columns now size to their
content (auto table layout) and the table only takes the width it needs — short
columns stay narrow. (Trade-off: drag-to-resize column handles stop taking
effect.) The inline and PR/MR views already auto-sized table columns.

## 0.34.19 — 2026-06-14 (trial)

### Changed: the Claude skill now spells out how to migrate anchor markers

When Claude rewrites an anchored passage it has to move the `<!--mc:a:ID-->` /
`<!--mc:/a:ID-->` markers onto the new text (same id) — otherwise the reviewer's
comment orphans. The skill said this conceptually but gave no procedure, so
Claude would Edit the bare visible text and drop the flush markers. It now gives
the exact procedure (put the markers *inside* `old_string`/`new_string`) with a
before/after example, and tells Claude to update the thread's `quote` to match.

**Update your installed skill** for this to take effect — the comment panel will
show an "update skill" banner, or run **Markdown Collab: Install Claude Skill**.

## 0.34.18 — 2026-06-14 (trial)

### Fixed: short selections can be commented on in the live editor

A leftover minimum-length gate in the live editor (the last remnant of the old
"at least 8 non-whitespace characters" rule) silently refused to open the
composer for selections under 3 non-whitespace characters. Any non-whitespace
selection can now be commented on. (The heading-highlight diagnostic logging
from 0.34.17 is still active.)

## 0.34.17 — 2026-06-14 (trial, diagnostic)

Diagnostic build for the heading-comment highlight issue: the live editor's
anchor highlighter now reports each anchor's locate/map outcome to the
**Markdown Collab** output channel, so we can see why a heading anchor isn't
highlighted in the running editor (the logic checks out in isolation). No
behavior change beyond the logging.

## 0.34.16 — 2026-06-14

### Fixed: a new live-editor comment's highlight now shows immediately

Adding a comment in the live editor didn't highlight the anchored text until the
next external change (e.g. Claude editing the file). When the comment was saved,
a save participant (format-on-save / trim-trailing-whitespace /
insert-final-newline) could rewrite the prose, leaving the editor out of sync
with the saved `.md` so the anchor couldn't be located. The editor now re-syncs
to the saved file, and the highlight is re-applied once the doc settles.

## 0.34.15 — 2026-06-13

Docs: refresh the marketplace listing. The README and the extension description
now cover all three surfaces — inline comments, the live editor (single human +
Claude co-editing), and GitHub/GitLab PR/MR review — and the keywords were
expanded. No code changes.

## 0.34.14 — 2026-06-13

First public release of the 0.34 line — published to the VS Code Marketplace and
Open VSX. Rolls up everything since 0.33.16 (the prior entries below shipped as
GitHub-only trial builds):

- **Sidecar removed** — comments live inline in the `.md` itself; the
  "8 non-whitespace characters" selection rule is gone.
- **Live editor reworked** — single human + Claude on one machine (no relay).
  Edits autosave to disk so Claude reads the latest; guards keep the human and
  Claude from overwriting each other; the panel patches only changed threads.
- **Unified comment panels** across the inline, PR/MR, and live-editor views,
  with per-thread Send to Claude, an always-on reply box, per-comment delete
  (inline confirm), and collapsible threads.
- **PR/MR review** — reply to existing comments; jump to a comment's line within
  the review.
- **Quality of life** — drawio diagrams in the inline view, a skill-update
  banner with one-click install, in-doc fragment links in every view, and
  heading-safe comment markers.

## 0.34.13 — 2026-06-13 (trial)

### Added: delete a single comment in the live editor

Each comment (and reply) in a live-editor thread now has its own **Delete**,
separate from the thread-level **Delete thread**. Deleting a comment that has
replies tombstones it so the replies survive; deleting the last comment removes
the whole thread.

### Changed: delete confirmation lives on the button

Both "Delete thread" and the per-comment Delete now confirm in place — the
button becomes **Confirm?** for a few seconds and a second click deletes. No
more scrolling to a confirm dialog at the bottom of the thread.

## 0.34.12 — 2026-06-13 (trial)

### Fixed: typing a reply in the live editor no longer loses focus

When Claude (or another tool) edited the file while you were mid-reply, the
comment panel rebuilt itself and dropped your cursor. Comment updates now patch
only the threads that actually changed — unchanged threads, including the one
you're replying in, are left untouched — and the transient "Updated from disk"
notice updates just the banner instead of re-rendering the whole list.

## 0.34.11 — 2026-06-13 (trial)

### Added: per-thread Send to Claude in the live editor

Each comment thread in the live editor now has its own **→ Claude** and **Copy**
actions (matching the inline view), so you can send a single thread to Claude
instead of the whole file. Both save your edits to disk first.

### Changed: replying in the live editor is an always-on box

The "Reply" button (which opened a composer) is gone — each thread now has an
always-visible reply box at the bottom. Type and hit **Reply** (or
Cmd/Ctrl+Enter). In-progress reply text survives sidebar re-renders.

## 0.34.10 — 2026-06-13 (trial)

### Changed: live editor comment panel matches the inline view

The live editor renders each comment as the same shared comment card the inline
and PR/MR panels use — quoted text + actions on top, then the comment (and
replies) as identical cards. Replaced the bespoke card layout and the icon-only
actions with the shared card + text actions, so the three comment panels look
the same.

### Fixed: document links inside comments opened as web links

A link in a comment body — a `#section` fragment or a relative `other.md` path —
was treated as an external web link, because the link interceptor only covered
the rendered preview, not the comment panel. It's now document-level: a fragment
link scrolls to that section and a relative link opens that document, the same
as links in the preview.

## 0.34.9 — 2026-06-13 (trial)

### Fixed: comment-panel bugs

- **Skill banner stuck on "Installing…".** The "update skill" banner never hid
  after the skill updated (and showed an empty yellow box on reopen) — its
  `display: flex` was overriding the `hidden` attribute. It now disappears as
  soon as the skill is current.
- **Live editor: Send to Claude was buried in a "⋯" menu.** Send to Claude and
  Copy are now direct buttons under the panel header, matching the inline
  comments view. The overflow menu is gone.
- **Comments wouldn't collapse.** The only fold control was scoped to unread
  Claude threads and hidden outside a review. Every thread now has a collapse
  chevron (folds to just its quote), and a **Collapse all / Expand all** toggle
  in the header works on all threads. The collapsed set persists across reloads.

## 0.34.8 — 2026-06-13 (trial)

### Added: guards so the human and Claude don't overwrite each other

The live editor (single human + Claude) now keeps the two from clobbering each
other's edits in the normal turn-based flow:

- **Autosave-through.** Your edits flush to disk ~0.8s after you stop typing
  (echo-guarded, so a format-on-save rewrite doesn't bounce back into the
  editor). Claude reads the `.md` from disk, so it always sees your latest
  instead of a stale copy — no more "save first or Claude misses it".
- **Save on hand-off.** Send to Claude / Copy prompt now saves first, so the
  review Claude runs is against exactly what you see.
- **No stale overwrite.** When Claude's change lands in the editor, a
  still-pending keystroke post is cancelled so it can't fire afterward and
  revert Claude's edit.
- A brief "Sent to Claude — your edits are saved" note confirms the hand-off.

This is turn-based safety: you write, hand off, Claude revises, you watch it
land. It does not merge truly simultaneous edits — if you and Claude write in
the same instant, that one tick is still last-writer-wins.

## 0.34.7 — 2026-06-13 (trial)

### Changed: the live editor is now single-human + AI, no relay

The live WYSIWYG editor is back (0.34.6 had turned it off with the rest of the
collaboration feature), but reworked around the actual use case: **one human and
Claude on the same machine**, not multiple humans over a network.

- **No y-websocket relay.** The editor no longer spawns or connects to a relay,
  and there are no `markdownCollab.collab.serverUrl/port/startLocalServer`
  settings. It opens instantly instead of waiting on a connection.
- **The file is the shared canvas.** You edit in the live editor; Claude edits
  the `.md` on disk with its normal tools. The editor pushes your changes to the
  file and applies Claude's file changes back into the view live — a brief
  "Updated from disk" note appears when that happens.
- Removed the multi-human chrome (connection banner, peer-presence avatars)
  since the collaborator is Claude-via-file, not another person.
- The editor is reached the same way: **Open Live Editor** command, or
  **Reopen with → Markdown Collab (live editor)**.

This is turn-based co-editing (you ask, Claude revises, you see it land), not
character-level co-typing.

## 0.34.6 — 2026-06-13 (trial)

### Removed: real-time collaborative editor (disabled)

The experimental real-time collaborative editor (Milkdown + Yjs over a local
y-websocket relay) is turned off. Gone from the UI: the **"Reopen with → Markdown
Collab (real-time, experimental)"** custom editor, the **Open Collaborative
Editor** command, and the `markdownCollab.collab.*` settings. The extension no
longer spawns a y-websocket relay on activation.

Inline comments, Ask Claude to Review, and PR/MR review are unaffected. The
editor's implementation stays in the source tree, so it can be wired back up
later.

## 0.34.5 — 2026-06-13 (trial)

### Fixed: review follow-ups in the comment panels

- Inline `` `code` `` inside comment bodies is styled again (it lost its
  background/mono treatment when the cards moved to the shared design system).
- The "update skill" banner no longer flags an update on a transient or
  permission read error of a helper script — only when a script is genuinely
  missing, matching how the `SKILL.md` check already behaves.
- Editing an existing inline comment no longer re-grabs focus on a re-render,
  matching the add/reply composers.
- Skill doc wording corrected: the channel payload's `prompt` field points at
  this skill rather than claiming to "self-document the format".

## 0.34.4 — 2026-06-13 (trial)

### Changed: live editor comments match the other panels visually

The live editor's comment cards now use the same design tokens as the inline and
PR/MR comment panels — consistent card background, border, spacing, timestamp
color, and indented replies — so all three comment panels look alike.

## 0.34.3 — 2026-06-13 (trial)

### Added: in-doc section ("fragment") links work in every view

A link to a heading in the same doc — `[Setup](#setup)` — now scrolls to that
section in the inline comments view, the PR/MR review view, and the live editor
(matched by heading id or slug).

### Fixed: commenting on a heading keeps it a heading

Anchoring a comment on `## Heading` now puts the marker *after* the hashes
(`## <!--mc:a:…-->Heading<!--mc:/a:…-->`) so the line still renders as a heading,
in both the inline view and the live editor.

### Fixed: live editor saves the file when you act on a comment

Adding, replying to, resolving, or deleting a comment in the live editor now
saves the file (typing still doesn't auto-save).

### Changed: every "Send to Claude" prompt invokes the `vs-markdown-collab` skill

All send paths now consistently tell Claude to use the skill (the source of
truth for the comment format) rather than re-documenting the format inline.

### Changed: shared comment-panel UX

The inline comments and PR/MR review panels now render comment cards and
composers from one shared component + design system (consistent styling,
buttons, and keyboard shortcuts — Cmd/Ctrl+Enter to submit, Esc to cancel).

## 0.34.2 — 2026-06-13 (trial)

### Added: a warning + one-click update when the Claude skill is out of date

The inline comments panel now checks whether the installed `vs-markdown-collab`
Claude skill matches the version this build ships. If it's missing or out of
date, a banner appears at the top of the comments panel with an **Install
skill** / **Update skill** button. Installing a customized skill still asks
before overwriting. The banner clears itself once the skill is current.

## 0.34.1 — 2026-06-13 (trial)

### Added: reply to existing comments in the PR/MR review view

Each existing comment thread in the PR/MR review now has a **Reply** affordance.
Type a reply and it posts straight to the thread on GitHub (review-comment
reply) or GitLab (discussion note), then the thread refreshes to show it nested.

### Fixed: inline comments viewer now renders `.drawio` diagrams

A `![…](diagram.drawio)` image showed a broken-image icon in the inline comments
viewer, because `.drawio` isn't a browser image format. The viewer now reads the
diagram (confined to the workspace, same as the live editor) and renders it to an
inline SVG, matching how the real-time editor already handled drawio links.

## 0.34.0 — 2026-06-13 (trial)

### Removed: the legacy JSON sidecar storage and its UI

Comments now live only inline in the `.md` file itself. The old sidecar
solution — comments stored in `.markdown-collab/<file>.md.json` — is gone,
along with everything that only served it: the **Open Preview with Comments**
view, the native VS Code gutter Comments UI, the **Orphaned Comments** view and
re-attach flow, the **Validate Sidecars** and **Reload Comments** commands, and
the `mdc.mjs` sidecar CLI + `SIDECAR.md` reference from the installed Claude
skill. The installed skill now documents inline mode only.

### Changed: the cross-file Markdown Review tree reads inline comments

The **Markdown Review** sidebar — the workspace-wide list of files with open
review threads — now scans the inline comment markers in each `.md` instead of
JSON sidecars, and refreshes as files change.

### Changed: short selections can be commented on

Commenting no longer requires selecting 8+ non-whitespace characters. Any
selection works — even a single word — in both the inline view and the live
editor; only empty/whitespace-only selections are ignored.

## 0.33.16 — 2026-06-13 (trial)

### Added: extension icon + first Marketplace / Open VSX publish

Markdown Collab now ships with an icon (a review-comment bubble around the
markdown mark), so it has a proper tile on the listing. This is also the first
build published to the VS Code Marketplace and to Open VSX, so the extension
can be installed directly from your editor rather than from a downloaded
`.vsix`.

## 0.33.15 — 2026-06-12 (trial)

### Fixed: raw comment markers showing in the PR/MR review view

The PR/MR review view rendered the file's raw bytes, so the invisible
inline-comment markers (`<!--mc:a:…-->`) and the threads block leaked into
the preview as literal text — and a marker sitting in front of a heading
stopped it from rendering as a heading (`## How to use this template` showed
as plain text with the markers). The review preview now strips those markers
before rendering, the same way the live editor does. Headings, body prose,
and the diff highlight stripes are unaffected.

## 0.33.14 — 2026-06-11 (trial)

### Fixed: comment line numbers now jump within the review view, not the raw file

In the PR/MR review view, clicking a comment's line number opened the raw
`.md` text editor and pulled you out of the review. It now scrolls the
rendered review preview to that line and briefly flashes the block, so you
stay in the review while you look at what a comment refers to. Both your draft
comments and existing platform comments behave this way.

## 0.33.13 — 2026-06-09 (trial)

### Fixed: raw `<!--mc:...-->` marks showing in comment cards + broken highlights

When you commented on text next to an existing comment, the new comment's
stored quote could swallow the neighbor's invisible marker. That raw marker
then showed up in the comment card's "commenting on" preview, and — because
the marker text isn't present in the rendered document — the comment's
highlight could no longer be located, so the anchored text stopped
highlighting.

Quotes are now kept free of embedded markers when a comment is created, and
existing marker-laden quotes are cleaned up when displayed. This also makes
the inline comments view's quotes cleaner.

## 0.33.12 — 2026-06-08 (trial)

### Fixed: live editor jumping to the top of the file

The live editor snapped back to the top of the document — losing your scroll
position and cursor — after saving (when format-on-save touched the file) and
whenever the file changed externally. Refreshing the editor's content
replaced the whole document without remembering where you were. It now
preserves the scroll position and cursor across that refresh, so you stay put.

## 0.33.11 — 2026-06-07 (trial)

### Fixed: can't comment on table cells / formatted text in the live editor

Selecting text inside a table cell (or some bold/inline-formatted spans) and
adding a comment failed silently — the live editor serializes such a
selection to something that doesn't appear verbatim in the file, so anchoring
gave up. Commenting now works on any selection:

- The selection's visible text drives the anchor (reliable for tables, bold,
  links), with exact source placement kept as a bonus when the text maps
  cleanly into the file.
- Adding a comment never fails to save. When the exact text can't be located
  in the source (e.g. a table cell), the comment is saved loosely-anchored —
  still highlighted in the live editor by matching its text — instead of
  being refused.
- Lowered the overly strict minimum selection length.

Note: a loosely-anchored comment is highlighted in the live editor but shows
as an unanchored thread in the other comment surfaces.

## 0.33.10 — 2026-06-07 (trial)

### Fixed: unreadable table columns in the live editor (dark-on-dark)

Tables in the live editor rendered every other column (1st, 3rd, …) as
dark-on-dark and effectively invisible. The bundled editor theme zebra-
stripes table columns with a hardcoded near-black that ignored your VS Code
theme. Table cells now follow VS Code's editor colors: readable text on a
faint, theme-aware stripe, with a uniform header tint.

## 0.33.9 — 2026-06-07 (trial)

### Fixed: "Could not save comment — could not locate the text" in the live editor

Adding a comment in the live editor could fail with "could not locate the
selected text," even though the whole point of the invisible markers is that
the selection's position is known. The host was fuzzy-searching the saved
`.md` for the selected text, but the live editor reformats the Markdown as
you load/edit it, so the text often didn't match the saved copy verbatim and
the search failed.

The editor now reports the exact selection offsets against its own current
text, and the host places the invisible marker at those offsets directly —
no search. Commenting works regardless of how the file was formatted on
disk. (A text-anchored fallback remains for the rare case the editor can't
resolve offsets.)

## 0.33.8 — 2026-06-07 (trial)

### Fixed: live editor comment panel after the move to inline comments

Two leftovers from the inline-comment storage switch:

- **"Send to Claude" now works in the live editor.** It previously read the
  legacy sidecar, so the live editor's in-file comments looked empty and
  nothing got sent. It now reads the inline comments stored in the Markdown
  file (and any inline-mode doc does the same), falling back to the sidecar
  for older files.
- **Corrected the empty-state hint.** It no longer claims comments show up
  in VS Code's gutter (that path reads the sidecar). It now says comments
  are saved in the Markdown file itself and appear in the Inline Comments
  view.

## 0.33.7 — 2026-06-07 (trial)

### Added: frontmatter support in the live editor

The live (collaborative) editor now handles a document's YAML/TOML
frontmatter (the `---` / `+++` block at the top) instead of letting
Milkdown turn the fences into horizontal rules and scramble the metadata
on save. The frontmatter is shown in a labeled, read-only panel above the
editor and is preserved verbatim through every edit and save. To change
it, open the file in the plain text editor.

## 0.33.6 — 2026-06-07 (trial)

### Fixed: live editor no longer reverts your edits on save

0.33.5 introduced a regression where saving in the live (collab) editor
could snap the document back to an earlier state, losing what you'd just
typed. Two causes, both fixed:

- Stripping the inline comment markers left a stray trailing newline, so
  the prose the extension compared against never quite matched what the
  editor had — making the editor↔document sync echo back on every change.
- That echo replaced the whole editor document. Combined with the brief
  save/typing debounce, a save could push slightly-stale text back into the
  editor and wipe recent keystrokes.

The extension now only refreshes the editor when the file's prose genuinely
changes outside it (another window, git, a real format-on-save), never for
its own marker rewrites or no-op saves.

## 0.33.5 — 2026-06-07 (trial)

### Changed: the live editor stores comments inline in the .md, not a sidecar

The real-time collaborative editor now keeps review comments as the same
invisible `<!--mc:...-->` markers the rest of Markdown Collab uses, written
into the `.md` file itself, instead of a separate `.markdown-collab/<file>.md.json`
sidecar. Comments now travel with the file and are shared with the standard
editor's comment view, the preview, and the Claude skill.

The editor still shows clean prose; the markers are stripped before display
and re-materialized around the same text after you edit. Comment add / reply /
resolve / delete now change the `.md` and persist on save (Ctrl+S), the same
as the inline-comments view.

Notes:
- Legacy `.md.json` sidecars are not read by the live editor anymore. Files
  that only have a sidecar will show no comments here until re-commented.
- Anchoring across edits is best-effort: a comment whose quoted text is
  rewritten or duplicated may fall back to "unanchored" (the comment is kept,
  just without a highlight).

## 0.33.4 — 2026-06-06 (trial)

### Changed: the Changed Files refresh button now starts and restarts reviews

The refresh button in the "PR Review (markdown files)" panel does more
than refresh now:

- With no review running, clicking it starts one for the current branch
  (the same as `Markdown Collab: Review PR / MR`).
- After you check out a different branch, clicking it retires the old
  review and starts a fresh one for the branch you're now on, disposing
  the previous review's draft comment threads and closing its open file
  panels so nothing stale lingers.
- On the base/default branch (resolved from `origin/HEAD`, falling back
  to `main`/`master`) or a detached HEAD there's nothing to review, so it
  clears the panel and hints to check out a PR/MR branch instead.
- With a review already running on the current branch, it still refreshes
  in place exactly as before.

## 0.33.3 — 2026-06-02 (trial)

### Changed: the extension is now bundled, shrinking the published package

The host extension is now bundled into a single `out/extension.js` with
esbuild (`npm run bundle:extension`), so its runtime dependencies
(markdown-it, yjs, y-protocols, lib0, ws, pako) are inlined instead of
shipped as loose `node_modules` trees. `.vscodeignore` no longer ships
those packages — only mermaid remains, since the webviews load it as a
script asset by URL rather than requiring it. Source maps are excluded
from the package too.

Net effect: the `.vsix` drops from ~1300 files (221 JavaScript files) to
~60 files, and the vsce "you should bundle your extension" packaging
warning is gone. No runtime behavior changes.

The release workflow also opts into the Node 24 runtime for its GitHub
Actions (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`), ahead of GitHub forcing
the switch on 2026-06-16, so it stops emitting the Node 20 deprecation
warning.

## 0.33.2 — 2026-06-02 (trial)

### Added: refresh button in the PR review Changed Files panel

The "PR Review (markdown files)" sidebar view now has a refresh button
in its title bar. Click it to re-pull the review without restarting:
the changed-file list and per-file diff ranges are recomputed (so new
local commits show up), the cached platform comments are dropped and
re-fetched, draft threads are rebuilt against the fresh diff, and any
open file panels re-render with the new source, ranges, drafts, and
comments.

Note: this does not run `git fetch` — commits pushed to the PR's head
or base won't appear until you fetch them yourself, since the draft
store is keyed to HEAD's SHA and silently shifting that baseline would
strand your in-progress drafts.

## 0.33.1 — 2026-05-29 (trial)

### Changed: thread action buttons stack below the quote instead of to its right

In the inline-comments view, each thread card had its action buttons
(→ Claude / Copy / Resolve / Delete) sitting in a row to the right of
the quoted text. On narrower panel widths the row got cramped and the
buttons crowded the quote.

The header is now a vertical flex: quote on top, buttons on a new row
below it. Buttons wrap when there isn't room for all of them. The
indent matches the quote's border so the row still visually belongs
to its anchor.

## 0.33.0 — 2026-05-29 (trial)

### Added: PlantUML diagrams in every preview surface

```` ```plantuml ```` (and ```` ```puml ````) fenced code blocks now
render as inline diagrams across all three markdown surfaces:

- The legacy preview (`Markdown Collab: Open Preview with Comments`).
- The inline-comments view.
- The PR review preview.

Same markdown-it plugin shared across host-side rendering and the
webview bundles. Encoding uses PlantUML's `~h<hex>` prefix path —
UTF-8 bytes of the source as a hex string after `~h`. No deflate
dependency, no extra npm package.

By default the plugin posts to the public `https://www.plantuml.com/plantuml`
server. Two new settings let you point it elsewhere:

- `markdownCollab.plantuml.serverUrl` — base URL (e.g.
  `http://localhost:8080` for a self-hosted server, keeping your
  diagrams off the public web).
- `markdownCollab.plantuml.format` — `svg` (default) or `png`.

CSP on the legacy preview widened from `img-src ${webview} data:` to
`img-src ${webview} https: data:` so PlantUML images render — the
inline-comments and PR review CSPs already allowed this.

## 0.32.0 — 2026-05-29 (trial)

### Added: existing PR / MR comments in the side panel

The drafts pane now has an "Existing comments" section below your own
drafts. When the panel opens it fires off a `gh api …/pulls/N/comments`
(or `glab api …/merge_requests/N/discussions`) and renders the
line-anchored review comments others have left on the file.

Each thread shows the line anchor (clickable, jumps to source), the
authors and timestamps, the comment bodies, and a `↗` link to the
comment on the platform. Replies nest under their parent thread.
Resolved discussions get a faded card + "resolved" badge. v1 is
read-only — reply support is the next obvious thing to add but isn't
in this drop.

### Added: explorer-style tree view of changed files

The QuickPick file picker is gone. `Markdown Collab: Review PR / MR`
now populates a tree view in the Explorer sidebar called "PR Review
(markdown files)", nested by directory the same way the file
explorer is. Each leaf shows the file name plus a description with
the status (added / modified / renamed) and unsubmitted draft count.
Click a leaf to open the preview panel; the tree is the persistent
navigation while the preview panels open and close. Single-file PRs
still skip the click and open directly.

## 0.31.6 — 2026-05-29 (trial)

### Changed: PR review diff stripes are more visible

The 3px stripe + translucent diff-editor variable from 0.31.0 was too
quiet — on dense themes the changed blocks looked identical to
unchanged content.

- Stripe is now **5px** wide with a hard `gitDecoration-addedResource`
  green that's defined on every theme (instead of the diff editor's
  translucent background variable).
- Changed blocks get a faint **background tint** (14% of the stripe
  color) so they pop even when scanning quickly. Hover bumps the tint
  to 24% so a moused-over block self-identifies.
- Images and `<hr>` get a `border-left: 5px solid` + tint since they
  don't have inline padding to grow into.
- Nested `pr-changed` (a changed inline span inside an already-changed
  paragraph) is suppressed — only the outermost block carries the bar
  + tint to avoid doubled stripes inside paragraphs.

## 0.31.5 — 2026-05-29 (trial)

### Changed: → Claude / Copy buttons live on the thread, not on each comment

In 0.29.4 I put a `→ Claude` and `Copy` button on every comment in an
inline thread. They all sent the *whole thread* to Claude, which made
the per-comment placement misleading — a 4-message thread had four
identical buttons that all did the same thing.

Moved to the thread-actions row at the top of the card, next to
Resolve / Delete. One thread, one button. Sends the entire thread
(initial comment + every reply, with the anchor quote) — exactly the
same payload as before, just unambiguous about scope now.

## 0.31.4 — 2026-05-29 (trial)

### Changed: verdict + review summary are in the drafts pane, no more popups

Clicking **Submit review** previously fired two modal-ish prompts in
sequence — a QuickPick for the verdict (Comment / Approve / Request
changes) and an InputBox for the optional review summary. Both are gone.

The submit footer in the drafts pane now hosts:

- Three radio buttons for the verdict, defaulting to **Comment**.
- A small textarea for the optional review summary, placeholder
  "Optional review summary…".
- The submit button (already there).

Clicking submit sends whatever's currently selected + typed. The stale-
drafts modal warning is also gone — stale drafts are dropped silently
and the post-submit toast tells you how many were kept for rework. Same
toast still surfaces the "Open review" link on success.

## 0.31.3 — 2026-05-29 (trial)

### Fixed: GitLab MR comments now anchor to the diff line

0.31.1 switched the GitLab submit path to `glab -f position[base_sha]=…`
style form fields to fix HTTP 415. That stopped the 415, but glab treats
the `position[*]` keys as flat fields, not nested-object lookups —
GitLab received `body=…` and seven unrelated top-level fields, dropped
all of them on the floor, and stored the comment as a general MR note
with no anchor.

Switched back to JSON via `glab api --input -`, this time with an
explicit `--header "Content-Type: application/json"` so GitLab parses
it (the missing header is what caused the original 415). The `position`
object now arrives intact and the discussion comes back as a `DiffNote`.

Defensive: after POSTing the discussion, the response is parsed and
inspected. If `notes[0].position` is null — meaning GitLab accepted the
request but couldn't anchor it (SHA mismatch, line outside the diff,
etc.) — submit fails loudly with the raw response in the error
message, instead of silently shipping a hidden general note.

## 0.31.2 — 2026-05-28 (trial)

### Changed: submit-review moved into the drafts pane

The "Submit Review" affordance is now a sticky button at the bottom of
the drafts pane, not a status-bar item or palette command. The button
shows the total draft count across the PR (e.g. "Submit review (5)")
and a hint line below it breaks the count down by "on this file" vs
"on other files". Disabled when there are zero drafts.

The status-bar item and the `markdownCollab.submitPrReview` palette
command both went away — submit lives in the panel, where the drafts
do. Click it, pick a verdict, the same batched-POST pipeline ships
your review.

## 0.31.1 — 2026-05-28 (trial)

### Fixed: GitLab MR submit (HTTP 415) and floating comment button position

Two bugs in the preview-mode PR review from 0.31.0:

1. **GitLab discussion submit failed with HTTP 415.** I was sending the
   request body as JSON via stdin (`glab api ... --input -`). GitLab's
   `/discussions` endpoint expects form-encoded data — without an
   explicit `Content-Type: application/json` header, glab handed the
   raw JSON to the server with a Content-Type the server didn't accept.

   The fix switches to glab's `-f key=value` field syntax, which uses
   form encoding and bracket notation for the nested `position` object.
   Same pattern used for the verdict `/notes` and `/approve` calls. No
   stdin JSON anywhere in the GitLab path now.

2. **"+ Comment on selection" button stuck near the top of the page.**
   The CSS positioned the button with `position: absolute` while the
   client wrote viewport-relative `getBoundingClientRect()` coords plus
   `window.scrollY` to its top. Absolute positioning made those coords
   relative to the nearest positioned ancestor (`#preview-pane`), so
   the scroll math doubled up and the button drifted up.

   The fix changes the CSS to `position: fixed` and drops the scroll
   offset from the JS — `getBoundingClientRect` is already in viewport
   coords, which is exactly what fixed positioning wants. Button now
   follows the selection wherever it is on the page.

## 0.31.0 — 2026-05-28 (trial)

### Changed: PR / MR review opens the file in a rendered preview, not the source editor

Picking a file from `Markdown Collab: Review PR / MR` now opens it in a
preview-mode webview instead of the raw editor. The view has two panes:

- **Left:** the head-side markdown rendered as prose. Any block whose
  source byte range overlaps an added-line range from the PR diff gets
  a left side stripe. The stripe is painted on *anything* the diff
  touches — paragraphs, headings, list items, code blocks, frontmatter
  rows, link nodes whose URL changed even when the rendered text
  didn't. If git says the line changed, the stripe appears.
- **Right:** the drafts pane for this file. Cards show the comment body
  and the source line(s) it anchors to; click the line label to jump
  to that line in the source editor in a side column. Edit / Delete
  inline.

Adding a comment: select prose in the preview, click the floating
"+ Comment on selection" button, type the body, hit "Add draft". The
selection is mapped from the rendered DOM back to source line numbers
via the existing source-offset plugin (the same one inline-comments
uses for anchor highlighting). Single-line and multi-line ranges both
work.

The source-mode comment-controller code from 0.30.x is still in the
tree but no longer reachable from the main flow — `pickAndOpenFile`
opens the preview instead. The submit pipeline (verdict picker, draft
re-validation against the current diff, batched POST to GitHub or
GitLab) is unchanged from 0.30.0.

## 0.30.2 — 2026-05-28 (trial)

### Fixed: bundled .vsix is missing runtime dependencies → all commands "not found"

0.30.0 and 0.30.1 were packaged with `vsce package --no-dependencies`,
which skipped the dependency-bundling step entirely. The resulting
`.vsix` shipped zero `node_modules` entries — so on a clean install
`out/collab/server.js` failed its top-level `require("y-protocols/awareness")`,
the extension's `activate()` aborted, and every command (including
`markdownCollab.startClaudeTerminal`) was reported as "not found".

On my dev machine the previous releases looked fine because the bundled
deps were already present in the working tree, so the require resolved
from there. The `.vsix` only manifests the bug on a machine without the
deps installed.

0.30.2 is packaged without `--no-dependencies`. The `.vscodeignore`
re-include patterns for `yjs`, `y-protocols`, `lib0`, `ws`, etc. now
apply, so the .vsix carries the runtime deps it needs.

## 0.30.1 — 2026-05-28 (trial)

### Fixed: PR review init crash no longer takes down the rest of the extension

If the PR-review controller throws at construction or activation, the
crash is now caught, the stack trace logged to the "Markdown Collab"
output channel, and a toast surfaces the error message. The rest of
`activate()` continues — `startClaudeTerminal`, `openInlineCommentsView`,
and all the other commands stay available.

(0.30.0 had the inverse: a throw inside `new PrReviewController(...)` or
its `activate()` would short-circuit the whole extension's activation,
leaving every command registered as "not found".)

## 0.30.0 — 2026-05-28 (trial)

### Added: PR / MR review for `.md` files

Open the command palette, run `Markdown Collab: Review PR / MR`, and the
extension walks the user through reviewing the markdown files changed in
the current branch's pull request (GitHub) or merge request (GitLab).
Comments are posted back as native PR / MR review comments — the `.md`
file itself is never touched.

The flow:

1. Check out the PR branch locally (`gh pr checkout <n>` /
   `glab mr checkout <n>`).
2. Run `Markdown Collab: Review PR / MR`. The platform is picked from
   the `origin` remote — any URL containing "gitlab" routes to GitLab,
   everything else routes to GitHub. The matching CLI (`gh` or `glab`)
   is probed for installation + auth before anything else happens; if
   either is missing the toast tells you exactly which `auth login` to
   run.
3. A QuickPick lists the changed `.md` / `.markdown` files (added /
   modified / renamed). Picking one opens it in a regular editor with
   the native commenting gutter active *only* on head-side added lines
   — clicking `+` on an unchanged line is impossible, by design.
4. Type your comment in the native UI. Single-line and multi-line
   selections both work. Drafts persist in workspace state keyed by
   `sha1(remoteUrl + baseSha + headSha)`, so they survive a VS Code
   restart but rescope cleanly if you check out a different PR.
5. A `PR: N drafts ▸ Submit` status-bar item appears. Clicking it
   prompts for a verdict (Comment / Approve / Request changes) and an
   optional review-summary body, then submits the whole batch in one
   round trip per platform.

GitHub goes via `gh api repos/.../pulls/.../reviews` with the full
`{event, body, commit_id, comments[]}` payload. GitLab goes via
`glab api .../discussions` (one POST per inline note, GitLab has no
batch endpoint) plus an `/approve` or summary `/notes` call for the
verdict.

Self-hosted is handled by setting `GH_HOST` / `GITLAB_HOST` in the
spawn env when the parsed remote host isn't `github.com` /
`gitlab.com`. Submit-time validation re-runs the diff against the
current HEAD and drops any drafts whose anchor line has moved out of
the diff (with a confirm-before-submit prompt naming the count), so
force-pushes mid-review don't silently send comments to the wrong
lines.

Out of scope for v1: replying to existing PR threads, reading existing
PR comments back into VS Code, `suggestion` blocks, editing already-
submitted comments, `LEFT`-side base-file comments, `.mdx`, deleted
files.

## 0.29.5 — 2026-05-28 (trial)

### Added: find-in-preview (Cmd+F / Ctrl+F)

The inline-comments view has its own find bar now, scoped to the
rendered prose pane. Press `Cmd+F` (macOS) or `Ctrl+F` (Linux/Windows)
to open it; `Esc` to close.

Matches are highlighted live as you type — case-insensitive plain-text
search. The current match gets a stronger highlight and scrolls into
view. `Enter` jumps to the next match, `Shift+Enter` to the previous;
the `↑` / `↓` buttons do the same. The counter on the right of the bar
shows `N / M`.

The walker skips `<svg>` subtrees so wrapping text nodes inside a
mermaid diagram doesn't break the rendered output. When the doc
re-renders (file changed on disk, comment added, etc.) the find bar
stays open and re-runs the query against the new DOM, so you don't lose
your place.

## 0.29.4 — 2026-05-28 (trial)

### Added: per-thread Send-to-Claude and Copy buttons

Each comment in the inline-comments view now has its own `→ Claude` and
`Copy` button alongside Edit / Delete. They scope the existing
document-level "Send to Claude" / "Copy prompt" actions down to the
single thread the button lives on — useful when a doc has dozens of
threads and you only want Claude to look at one.

The dispatched prompt is a two-liner that just invokes the
`vs-markdown-collab` skill with the thread's id and quoted anchor text.
No format documentation is embedded — the skill already knows the inline
format, so per-thread sends stay tiny instead of re-shipping the same
instructions over and over.

`→ Claude` routes through the configured `markdownCollab.sendMode`
(terminal / channel / mcp-channel / clipboard), same as the existing
document-level button. `Copy` writes the prompt to the system clipboard.

## 0.29.3 — 2026-05-22 (trial)

### Fixed: clicking line-number links now actually jumps to the line

Three independent bugs were stacked on top of each other, all of them
quiet failures (no toast, no error log — the click just did nothing
useful).

**1. URL scheme detection was too greedy.** Per RFC 3986 a scheme is
ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ), so `foo.md:42` matched as
scheme `foo.md` and got refused as an unknown protocol — never
reaching the path-resolve code. New `detectUrlScheme()` requires
either `scheme://` (http, https, file, ftp) OR a known no-slash
scheme (`mailto`, `tel`). Plain `foo.md:42` / `src/foo.ts:42` are
correctly classified as relative paths now. The same regex was wrong
in the legacy sidecar preview's `onOpenLink`; fixed there too.

**2. GitHub-style `#L42` fragments weren't recognized.** Links like
`[code](src/foo.ts#L42)` put `L42` in the heading slot, which then
failed to slug-match any real heading and the line was lost.
`parseLinkHref` now extracts the line number from an `#L<digits>`
fragment (also `#L42-L50` ranges — first line wins, lowercase `#l42`,
all common variants). An explicit `:N` on the path still takes
priority since it's the more specific signal.

**3. Non-md target line jump raced the active editor.**
`vscode.commands.executeCommand("vscode.open", uri)` returns before
the newly opened editor becomes the active one, so the follow-up
`revealLineInActiveEditor(N)` targeted whatever editor *was* active.
Replaced with a single atomic `vscode.window.showTextDocument(uri,
{ selection })`. Binary files (images, PDFs) without a line argument
still go through `vscode.open` for the right viewer.

Resulting behavior — all three line-link patterns now work:

| Link | Result |
|---|---|
| `[x](src/foo.ts#L42)` | opens text editor, cursor on line 42 |
| `[x](src/foo.ts:42)` | same |
| `[x](other.md#L42)` | opens inline-comments view, scrolls preview to line 42 |

## 0.29.2 — 2026-05-22 (trial)

### Added: YAML / TOML frontmatter support in the inline-comments view

`.md` files that start with a `---\n…\n---\n` (YAML) or `+++\n…\n+++\n`
(TOML) frontmatter block now render correctly in the inline-comments
preview — the block is stripped from the rendered prose instead of
being parsed as a horizontal rule + setext heading. Anchor offsets
remain valid because frontmatter is added to the existing skip
machinery alongside `mc:*` markers and the threads region.

Detection is BOM-tolerant, CRLF-tolerant, and refuses partial blocks
(an opening fence with no matching close) and openers that aren't on
the first non-BOM line — so a setext heading like `Heading\n---` is
still a heading, not a malformed frontmatter.

The `addThread` API refuses selections that overlap the frontmatter
range, matching the existing guard for the threads region. Heading
slug resolution (used by `[link](other.md#heading)`) skips
frontmatter lines so YAML values that happen to contain `# foo` can't
be mistaken for ATX headings.

## 0.29.1 — 2026-05-21 (trial)

### Changed: inline-comments view scrolls to line / heading on open

`InlineCommentsPanel.reveal(...)` now accepts an optional
`{ line, heading }` to scroll the rendered preview to a specific spot
when the panel opens (or re-opens). The panel translates a 1-based
line or a heading slug into a prose-offset via the existing source ↔
prose mapping and posts a `scroll-to` message to the webview, which
finds the matching `[data-mc-src]` span and `scrollIntoView`s it.

This collapses the old workaround in the link-click path: clicking
`[link](other.md#heading)` previously opened both an inline-comments
panel *and* a text editor (because the inline view couldn't jump to
a heading on its own). It now opens just the inline view and scrolls
the preview, matching what users actually want.

## 0.29.0 — 2026-05-15 (trial)

### Added: "Ask Claude to Review This Doc" — Claude as reviewer

A new command and right-click action lets the human ask Claude to act as
a reviewer on a Markdown doc. Claude reads the file and opens one
inline-comment thread per substantive concern — the human triages from
the existing sidebar. Built on top of the v0.27+ inline-comment
substrate; no storage-format changes.

The command is **Markdown Collab: Ask Claude to Review This Doc**, also
available from the Explorer, Editor body, and Editor title right-click
menus on `.md` files. On invocation the extension prompts for an
optional **focus directive** — a free-form string like *"check API
examples for correctness"* or *"find marketing-y tone"* — and remembers
the last 5 focuses in `globalState` for quick reuse. Files larger than
50 KB prompt a soft confirm before sending.

The payload flows through the existing send-mode pipeline (terminal /
channel / mcp-channel / clipboard) — no new transport. The skill's new
**Review Mode** workflow governs what warrants a thread (factual
errors, unclear claims, contradictions, broken examples, anything
matching the focus directive) and what doesn't (pure typos, vague
"could be clearer" notes). There is **no upper bound on thread count**;
volume is solved in the UI, not by gagging Claude.

The inline-comments sidebar gained two MVP affordances to handle
potentially-large review passes:

- A **summary row** — *"N new from Claude · M reviewed"* — appears
  above the filter row whenever Claude-initiated threads exist.
- **Next** jumps the highlighted card to the next unread Claude
  thread; **Collapse all** / **Expand all** toggles a folded view of
  every unread Claude card so a 30-thread review is browseable.

Claude-initiated unread threads are detected from existing JSON (no
schema change): a thread's first non-deleted comment authored by
`claude` with no human reply yet, status open.

The `vs-markdown-collab` skill (re-installable via **Markdown Collab:
Install Claude Skill**) now includes a Review Mode section with the
rubric, focus-directive handling, anchor-sizing rules, and the
"don't edit prose in review mode" invariant. Phase 6 has been
updated accordingly.

### Fixed: clicking links in the inline-comments preview did nothing

Markdown links in the rendered preview were inert because the webview
sandbox swallows navigation. They now:

- jump to a same-doc `#heading` by slug-matching the rendered headings;
- open another `.md` in an inline-comments panel, and also reveal the
  target line in a text editor for `#heading` or `:lineNumber` suffixes;
- hand non-markdown files to VS Code's default opener (image viewer,
  JSON formatter, etc.);
- send `http(s)`, `mailto:`, and `tel:` to `openExternal`;
- refuse any other URL scheme and any path that resolves outside the
  workspace folder.

The `:lineNumber` suffix (e.g. `foo.md:42`) is recognized as a 1-based
line jump in either a `.md` (no fragment) or non-markdown target. The
heading slug rules mirror the common GitHub-flavored implementation
(lowercase, punctuation stripped, spaces → hyphens, diacritics
stripped via NFKD).

## 0.28.0 — 2026-05-14 (trial)

### Removed: legacy sidecar Preview from right-click menus

`Markdown Collab: Open Preview with Comments` (the sidecar-based view)
is no longer shown in the Explorer, Editor title, or Editor body
context menus. Right-clicking a `.md` file now offers only **Open
Inline Comments View** — the v0.27+ default.

The command itself is still registered, so users with existing
`.markdown-collab/*.md.json` history can launch the legacy preview
from the command palette (`Cmd-Shift-P` → `Markdown Collab: Open
Preview with Comments`). The underlying sidecar storage + native
VS Code Comments UI + `mdc.mjs` CLI are unchanged.

## 0.27.0 — 2026-05-13 (trial)

### Changed: Inline Comments View is now the default

The previously-experimental **Markdown Collab: Open Inline Comments View**
is now the primary right-click action on `.md` files (the `(experimental)`
suffix is dropped from the command title). All three context-menu surfaces
(Explorer, Editor title, Editor body) list the inline view first; the
legacy sidecar-based **Open Preview with Comments** stays as the secondary
entry for workspaces with existing `.markdown-collab/*.md.json` history.
Custom-editor priority for `.md` files is unchanged.

### Changed: `vs-markdown-collab` skill restructured around per-file mode detection

`SKILL.md` is reorganized around a per-file detection step: if the `.md`
file contains `<!--mc:threads:begin-->`, Claude follows the **inline-mode
workflow** (edit prose + append replies to the matching `<!--mc:t …-->`
line; never mutate `status` or existing comments); otherwise it falls back
to the sidecar workflow driven by `mdc.mjs`. Anchor maintenance, send-mode
setup, and the channel watch-loop instructions are now mode-agnostic where
they were previously sidecar-only.

### Changed: sidecar workflow extracted to an on-demand reference (`SIDECAR.md`)

`SKILL.md` is now inline-by-default and stays lean (~270 lines). The full
legacy sidecar workflow — format spec, `mdc.mjs` CLI (`list`/`reply`/
`add`/`delete`/`set-anchor`/`validate`), seven-phase workflow, sidecar
anchor maintenance, sidecar-specific anti-patterns — lives in a new
`~/.claude/skills/vs-markdown-collab/SIDECAR.md` reference that Claude
reads only when sidecar mode actually applies, saving tokens on the
default inline path. `installClaudeSkill` writes `SIDECAR.md` alongside
`SKILL.md` and the bundled `mdc*.mjs` scripts.

### Added: agent instructions for initiating new review threads

Both `SKILL.md` (inline mode) and `SIDECAR.md` (legacy) now document how
Claude should **create** a new review thread, gated on an explicit human
request ("leave a comment on X", "add a review note", "flag this section").
Inline mode: pick a unique 5-char base36 id, wrap the passage in
`<!--mc:a:ID-->…<!--mc:/a:ID-->`, append a `<!--mc:t {…}-->` line with a
single `c1` comment. Sidecar mode: a new `mdc.mjs add` subcommand
generates a unique `c_<8 hex>` id, defaults author to `"claude"`, and
creates the sidecar with `version: 1` if it doesn't exist yet (refuses
sub-8-char anchors, empty bodies, and `--file` mismatches with an
existing sidecar's `file` field).

The skill explicitly forbids spontaneous thread creation while addressing
existing comments or doing maintenance edits — initiation is opt-in. When
a file has neither inline markers nor a sidecar and the human asks to add
a thread, Claude defaults to inline mode; sidecars are never created from
scratch.

### Changed: `AGENTS.md` snippet documents both formats

The convention block written by **Markdown Collab: Initialize AGENTS.md**
(for non-Claude-Code agents that don't have the SKILL.md affordance) now
documents both inline and sidecar formats, with detection rules and a
per-format workflow. Inline is the default; sidecar appears as the legacy
path.

## 0.26.0 — 2026-05-12 (trial)

### Added: collapsible comments panel in the inline-comments view

A `›` button in the comments-pane header collapses the sidebar; a
small `‹ Comments` button pinned to the top-right of the preview pane
brings it back. Collapsed state persists across webview reloads via
`vscode.setState` so the preference survives a panel hide/show or
window restart.

When collapsed, the preview pane occupies the full webview width
(grid-template-columns: 1fr 0). Transition is animated at 180ms ease
to avoid a jarring snap.

## 0.25.2 — 2026-05-12 (trial)

### Fixed: inline-comments view now renders images

Markdown images (`![alt](path.png)`) and external image URLs were
showing as broken icons because (1) the webview's `localResourceRoots`
only granted access to the extension's own assets, not the workspace
folder; (2) the CSP `img-src` was scoped to `${cspSource} data:` only,
blocking `https://` image hosts; and (3) relative srcs in markdown
weren't rewritten to webview-loadable URIs, so they resolved against
the `vscode-webview://` origin and 404'd.

Fix:

- `localResourceRoots` now includes the workspace folder of the open
  document (falling back to the .md file's parent directory if the
  file is outside any workspace).
- CSP `img-src` widened to `${cspSource} https: http: data:` —
  matches VSCode's built-in markdown preview policy.
- The webview installs a markdown-it `image` renderer override that
  rewrites `src`: leading-slash paths resolve against the workspace
  folder URI; everything else resolves against the .md's directory.
  `http(s)://` and `data:` srcs pass through unchanged.

The panel sends both base URIs as part of the `init` message
(`imageBaseUris.docDir` and `imageBaseUris.workspaceFolder`), pre-
computed via `webview.asWebviewUri` so the webview doesn't need to
know how to convert filesystem paths itself.

## 0.25.1 — 2026-05-12 (trial)

### Fixed: Mermaid v11 "Syntax error in text" in the inline-comments view

0.25.0 wrapped every fenced code block's content (including mermaid
blocks) in `<span data-mc-src="START.END">…</span>` for source-offset
mapping. Mermaid v11.14.0 reads its diagram source via element
children rather than `textContent`, and the extra `<span>` wrapper
caused every diagram to render as "Syntax error in text" while the
existing preview panel (which emits a bare `<pre class="mermaid">`)
rendered the same source correctly.

The fence renderer now emits `<pre class="mermaid">…</pre>` with the
diagram source as a direct text child for mermaid blocks, exactly
matching the previewPanel's output. Source-offset annotation is
dropped for mermaid only — anchoring inside a rendered SVG isn't
supported anyway. Other fenced code blocks still carry their
`data-mc-src` span.

New renderer test pins the bare-pre output for mermaid blocks.

## 0.25.0 — 2026-05-12 (trial)

### Fixed: reply to a thread after the AI replies

Three latent bugs combined to make the reply textarea feel broken
once the AI had written a response into the file:

1. **In-progress typing wiped on re-render.** When the AI's reply
   landed on disk, the panel's `onDidChangeTextDocument` listener
   triggered a full `renderThreads` that rebuilt every card from
   scratch — discarding any text the user was typing in a reply
   textarea. The webview now captures every reply textarea's value
   (and which one held focus) before clearing the list and restores
   them on the freshly built cards.

2. **Click bubbling re-rendered the list.** Clicking inside the reply
   textarea bubbled up to the thread card's click handler, which
   called `renderThreads` to update the highlight state — wiping the
   textarea you just clicked into. The reply box now `stopPropagation`s
   on click/mousedown, and the card-click and mark-click handlers
   update the `.highlighted` class in place instead of rebuilding the
   list at all.

3. **AI bodies containing `-->` corrupted the thread JSON.** A reply
   whose body contained the literal sequence `-->` (very common in
   mermaid edge syntax: `A --> B`) terminated the surrounding
   `<!--mc:t {...}-->` HTML comment early, breaking the rest of the
   thread on parse. `renderThreadsRegion` now post-processes
   `JSON.stringify` output to escape `-->` → `-->` and `<!--` →
   `<!--`. `JSON.parse` reverses these losslessly on read, so
   bodies round-trip unchanged; the on-disk text just has no literal
   `-->` inside any thread's JSON.

Two new format tests pin the escape and round-trip.

### Added: Mermaid diagram rendering (v11.14.0)

The inline-comments preview now renders ` ```mermaid ` fenced blocks
as SVG diagrams. The renderer overrides markdown-it's `fence` rule to
emit `<pre class="mermaid">` for mermaid blocks; the panel ships
`node_modules/mermaid/dist/mermaid.min.js` as a webview resource and
the client calls `mermaid.run({ querySelector: "pre.mermaid" })`
after every preview render. Initialization picks `dark` or `default`
theme based on the host VSCode theme.

Mermaid blocks still carry a single `data-mc-src` span around their
text content so a thread anchored on the source code (not the
rendered SVG) parses correctly; the visual highlight inside the
rendered SVG isn't supported (the SVG nodes aren't text-selectable),
but the sidebar card still works.

CSP loosened to allow `'unsafe-eval'` (mermaid's bundled DOMPurify
uses `Function()` for config parsing) and `data:` images, matching
the existing previewPanel's CSP.

## 0.24.0 — 2026-05-12 (trial)

### Changed: inline-comments "Send to Claude" routes to a Claude terminal by default; separate "Copy" button for clipboard

Previously the inline view's Send-to-Claude button always copied the
prompt to the clipboard. Now it routes through the same dispatcher as
the sidecar-based `markdownCollab.sendAllToClaude` command, honoring
the user's `markdownCollab.sendMode` setting:

- `terminal` (the default behavior) — bracketed-pastes the prompt
  directly into a running Claude REPL via the existing terminal
  tracker. If no Claude terminal is running, offers to start one.
- `channel` / `mcp-channel` — appends to `.markdown-collab/.events.jsonl`
  and/or pushes to the bundled MCP channel server.
- `clipboard` — copies the prompt.
- `ask` — prompts the user once and remembers per workspace.

A new **Copy** button next to **Send to Claude** in the sidebar always
copies to clipboard regardless of `sendMode`, for the case where the
user wants the prompt text without firing the configured transport.

Implementation: extracted the existing per-transport dispatch loop
from `invokeSendAllToClaude` into a standalone
`dispatchReviewPayload(payload, …)` helper. The new inline-comments
command path builds an `InlineReviewPayload` (which `extends
ReviewPayload`) and feeds it through the same helper.

The panel takes its dispatcher as a constructor dep so the transport
machinery stays owned by `extension.ts` — the panel doesn't reach into
`TerminalTracker` or `EventLog` directly.

## 0.23.2 — 2026-05-12 (trial)

### Changed: Send-to-Claude prompt asks AI to *reply*, not resolve

In 0.23.0 the inline-comments Send-to-Claude prompt told Claude to
mark addressed threads `"status":"resolved"`. That's the human
reviewer's call, not the AI's — the reviewer needs to read Claude's
response and decide whether the fix actually addresses the concern.

The prompt now instructs Claude to *reply* to each thread instead:
append a new `{"id":"cN","parent":"<last-live-comment>","author":
"claude","ts":"<ISO-8601>","body":"<response>"}` object to the
thread's `comments` array on its `<!--mc:t ...-->` line, keeping
`"status":"open"`. The prompt now also tells Claude exactly which
`parent` id to use for each thread (the last live comment's id), so
the reply chain stays linear.

Two new tests pin the new contract — that the prompt does not contain
`"status":"resolved"` and that the `parent="..."` hint references the
correct last-comment id.

## 0.23.1 — 2026-05-12 (trial)

### Changed: inline-comments preview pane is full-width

Removed the `max-width: 760px` cap on `#preview` so the markdown
preview fills its column on wide displays. The threads sidebar still
has its own fixed width and the responsive media query at 900px is
unaffected. Mirrors the 0.21.2 change to the collab editor pane.

## 0.23.0 — 2026-05-12 (trial)

### Added: "Send to Claude" in the inline-comments view

The inline-comments threads sidebar gains a **Send to Claude** button.
On click, the panel parses the open threads, formats a structured
prompt — file path, the on-disk inline-comment format reminder (so
Claude knows the markup is HTML comments inside the .md file rather
than a sidecar JSON), instructions to mark addressed threads
`"status":"resolved"`, and a list of every open thread's anchor quote
+ body + replies — and copies it to the clipboard. The notification
reports how many threads were included.

V1 ships clipboard-only delivery. Routing through the user's
`markdownCollab.sendMode` setting (terminal / channel / mcp-channel)
would require splitting `invokeSendAllToClaude`'s payload-builder from
its dispatch logic; deferred to keep this change focused.

4 new unit tests cover the inline → `Comment` shim (including reply
threading and tombstone exclusion) and the prompt format.

### Fixed: Delete buttons in the inline-comments view

`window.confirm()` is silently blocked in VSCode webviews on some
hosts, so clicking **Delete** on a thread or single comment appeared
to do nothing. Replaced the modal with an inline two-click pattern:
the button first arms ("Confirm delete") and shows a Cancel button
alongside it; a second click within four seconds commits the
deletion. The button auto-disarms after four seconds.

## 0.22.1 — 2026-05-12 (trial)

### Fixed: inline-comments view persists mutations to disk

The 0.22.0 inline-comments view applied every CRUD action via
`WorkspaceEdit`, which mutates the in-memory `TextDocument` and marks
it dirty but does not save. A reviewer who added a comment, closed the
file without Cmd+S, and reopened it would lose the comment.

The panel now calls `document.save()` after every successful
`applyEdit`. If the save fails (read-only file, save participant
veto), the comment is still in the buffer and a warning surfaces; the
mutation is not silently dropped.

The sidecar-based system was unaffected — it writes JSON directly to
disk — so this only fixes the new inline-comments view.

## 0.22.0 — 2026-05-12 (trial)

### Added: experimental "inline comments" view — comments live inside the .md file

A new experimental webview (`Markdown Collab: Open Inline Comments View
(experimental)`) renders the markdown alongside a threads sidebar with
full CRUD (add / reply / edit / resolve / unresolve / delete), but
instead of writing to a sidecar JSON it persists everything **inside
the .md file itself** as HTML comments. The format is reviewable from a
plain text editor, diffs cleanly in git, and survives copy/paste of the
file across tools.

**Format.** Two pieces:

- Anchored span — paired invisible markers wrap the highlighted text:
  ```
  The quick <!--mc:a:k3p9-->brown fox<!--mc:/a:k3p9--> jumps.
  ```
  IDs are 5-char base36. Zero-width point anchors are allowed.
- Threads region — a single block at the end of the file:
  ```
  <!--mc:threads:begin-->
  <!--mc:t {"id":"k3p9","quote":"brown fox","status":"open","comments":[…]}-->
  <!--mc:threads:end-->
  ```
  One JSON object per `mc:t` line (avoids a YAML parser dep and keeps
  the serializer deterministic). Replies use a flat `comments[]` with
  optional `parent`. Deletions tombstone (`deleted:true`) when the
  comment has descendants so reply trees stay coherent.

**Parser robustness.** `<!--mc:...-->` markers inside fenced code
blocks, indented code blocks, and inline code spans are ignored so a
literal marker shown in a code example isn't interpreted as a real
anchor. Threads referenced in the threads region but with no matching
anchor markers in prose are surfaced in the sidebar with a "broken
anchor" badge instead of silently disappearing.

**Source-offset-aware renderer** (`renderWithOffsets.ts`). A custom
markdown-it core rule walks the token stream and wraps every text /
inline-code / fenced-code token in `<span data-mc-src="START.END">…`
spans carrying exact prose-byte offsets. Highlight wrapping and
selection-to-source mapping both read these attributes directly — no
whitespace-collapse fuzzy matching. Table cells, headings, list items,
inline code, and blockquotes all map exactly. Inline tokens inside
table cells inherit their parent block's `.map` (which markdown-it
leaves null on `td_open` / `inline` pairs) so cell text is annotated
correctly. Selections inside `<pre>` / `<code>` are refused at the
webview level with a tooltip — the parser would strip those markers
anyway, so refusing up front avoids creating orphan threads.

**Two-way sync.** The panel watches `onDidChangeTextDocument`, so edits
made in the normal VSCode text editor re-render the preview live; the
panel's mutations go through `WorkspaceEdit`, so VSCode undo/redo and
dirty state work as expected.

**Coverage.** New tests:
- `inlineCommentsFormat.test.ts` — 17 cases for parse / round-trip /
  addThread / replaceThread / appendReply / stripAnchorMarkers and the
  code-block / inline-code marker exclusion.
- `inlineCommentsPanel.test.ts` — 3 cases for prose-offset
  serialization, including nested anchors and unanchored threads.
- `inlineCommentsRenderer.test.ts` — 8 cases for the source-offset
  plugin including paragraphs, inline emphasis breaks, table cells,
  fenced code, inline code, headings, list items, and safe degradation
  on entity-decoded text.

The existing sidecar-based system (Reviews panel, CommentController,
Send-to-Claude pipeline, real-time collab editor) is unchanged and
unaffected. The inline-comments view is opt-in via the new command and
the markdown editor context menu.

523 unit tests passing.

## 0.21.3 — 2026-05-12 (trial)

### Fixed: collab editor anchors no longer fall back to the first occurrence

`locateAnchorInLiveText` in the collab webview previously had two
"loosening" fallbacks that diverged from the canonical
`src/anchor.ts:resolve` semantics:

1. A loose loop that accepted a hit when only **one** side of the
   stored context matched.
2. A final `hits[0]` fallback when no context side matched at all.

In documents with duplicate substrings — e.g. the same word under
multiple section headings — these would silently anchor a comment to
the wrong occurrence (typically the first one in the document).

The locator now mirrors `resolve()`'s contract: a unique exact match
wins; with duplicates, **all** non-empty stored context sides must
match strictly before a candidate is accepted; if 0 or >1 candidates
pass, the anchor is orphaned (surfaced via the existing orphan tree)
rather than guessed. A whitespace-normalised fallback is retained for
cases where the live `textContent` collapses whitespace differently
from the stored markdown source.

The function was extracted into `src/collab/liveAnchorLocator.ts` so
it could be covered by unit tests (`src/test/liveAnchorLocator.test.ts`,
9 new cases).

42 integration + 495 unit = 537 passing.

## 0.21.2 — 2026-05-07 (trial)

### Changed: editor pane is full-width

The Milkdown editor was previously capped at `max-width: 880px` with `margin: 0 auto`, which left empty gutters on either side on wide displays. Removed the cap so the editor fills the entire `.mdc-editor-pane` column. The comments sidebar still has its own fixed width and the responsive media queries are unaffected.

## 0.21.1 — 2026-05-06 (trial)

### Added: live-host integration test for the drawio round-trip

A new integration test (`Collab editor integration › inline drawio link triggers a successful drawio-read round-trip`) opens a fixture markdown with a paragraph-only `.drawio` link in a real VS Code Extension Host, waits for the webview to fire the `drawio-read` message, and asserts the extension's response carries the file's `<mxGraphModel>` content with no webview-error along the way. The test host can't see into the webview's iframe so the SVG rendering itself is still verified visually, but the wiring most likely to break — link detection, message protocol, file resolver, file reader — is now pinned by automation.

To support the test, `CollabEditorProvider` exposes `_getDrawioReadHistoryForTests` and records every `drawio-read-result` it sends, mirroring the existing `_getLastReadyForTests` test-observability hook.

42 integration + 486 unit = 528 passing.

## 0.21.0 — 2026-05-06 (trial)

### Added: inline drawio diagram viewer

The collaborative editor now renders `.drawio` files inline when they are linked from a markdown document. A paragraph whose only content is a link with a `.drawio`, `.drawio.xml`, or `.xml` href is promoted to a block widget that decodes the file and renders it as an SVG below the link. Links mixed with other text keep their normal click behaviour, so the feature only fires for the dedicated diagram-link convention.

Architecture:

- **Resolver** (`src/collab/drawioFileResolver.ts`): turns a webview-supplied href into an absolute filesystem path with three hard rejects — schemes (`http:`, `file:`, `javascript:`), absolute paths, and `..`-traversal that escapes the workspace root. The webview is never trusted to read arbitrary host files.
- **Decoder** (`src/collab/drawioDecoder.ts`): handles every shape drawio writes: bare `<mxGraphModel>`, uncompressed `<mxfile><diagram>...</diagram></mxfile>`, and the compressed form (base64 + raw deflate + URI encoding). The decoder is a pure module so its format handling can be unit-tested without the renderer.
- **Renderer** (`src/webview/drawioRenderer.ts`): lazy-loads `mxgraph`, decodes the model into an offscreen graph, then lifts the rendered SVG out, tightens its `viewBox` to the graph bounds, and returns a detached `SVGSVGElement` ready for re-attachment.
- **PM plugin** (`makeDrawioPlugin` in `src/webview/client.ts`): walks the doc, detects diagram-only paragraphs, and emits a widget decoration. The widget posts a `drawio-read` message via the existing extension bus, then paints when the matching `drawio-read-result` arrives. A per-href cache shares a single fetch + render across every PM transaction.
- **Extension handler** (`runDrawioRead` in `CollabEditorProvider`): resolves the href, reads the file via `vscode.workspace.fs`, returns the content (or a friendly error). Pulled out as a static helper so it can be unit-tested with an injected reader, no VS Code mocks required.

The viewer is fully self-contained — no network calls, no iframes — at the cost of ~800KB of additional minified JS in the webview bundle for `mxgraph` + `pako`.

Tests: 34 new unit tests covering resolver rejects, decoder formats, and handler error paths. 486 passing total.

## 0.20.5 — 2026-05-05 (trial)

### Fixed: floating Add-Comment button still required two clicks in some cases

0.20.1 added `lastNonEmptySelection` as a fallback for when the floating button's mousedown fired after PM had already lost its selection. The fallback was refreshed via `selectionchange` / `mouseup` / `keyup` listeners scheduled with `setTimeout(0)`. A fast click on the floating button — fired in the same tick as the user's text-selection mouseup — could beat the deferred refresh, leaving all three selection layers (live, pendingSelection, lastNonEmptySelection) empty on the first click.

Closed the race by snapshotting PM's selection synchronously on `pointerdown` capture-phase at the window level, before any focus shift can clear it. The floating button's own mousedown now also calls `updateLastNonEmptySelection()` directly as belt-and-suspenders.

### Added: collapse / expand the comments sidebar

The collapse-toggle button used to be hidden on wide screens (only revealed by a media query for narrow widths), so users had no way to hide the sidebar in the common editor layout. The toggle is now always visible — pinned just outside the sidebar's left edge. Clicking it slides the sidebar out and lets the editor reclaim the column; clicking it again brings the sidebar back. The button's icon flips direction (`›` when expanded, `‹` when collapsed) and `aria-expanded` / `aria-label` update accordingly.

## 0.20.4 — 2026-05-05 (trial)

### Fixed: selecting text inside a table cell snapped to the whole cell

Milkdown's GFM preset wires `prosemirror-tables`' `tableEditing` plugin, which promotes any drag that touches a cell boundary into a `CellSelection` covering the whole cell(s). For commenting that snap-to-cell behaviour is wrong: the user wants to highlight a substring of a cell, not the cell itself.

The promotion is hardcoded in the table-editing plugin's mousedown handler and can't be turned off via options. Added a tiny `appendTransaction` plugin that runs after every state update — whenever the resulting selection is a `CellSelection`, it is rewritten to a plain `TextSelection` covering only the visible text of the selected cell range. The user sees a normal text-range highlight; the comment anchor records the actual text they meant.

The flattener handles single-cell drags and multi-cell drags symmetrically, and is a no-op for any non-table selection.

## 0.20.3 — 2026-05-02 (trial)

### Changed: anchor updates must be SURGICAL via the Edit tool, not full sidecar rewrites

0.20.2 told Claude to maintain anchors after every `.md` edit, but it pointed at `mdc.mjs set-anchor` as the update mechanism. That CLI rewrites the entire sidecar JSON on every change, which:

- Races with concurrent writers — the collab webview and the standard editor's `CommentController` may also be holding the sidecar open and writing back. A full-file rewrite stomps their pending edits.
- Causes large, churn-y diffs even when only one anchor's three string fields changed.

Updated both the "Anchor maintenance applies on EVERY .md edit" section and the Phase 3 in-comment workflow to instruct surgical Edit-tool updates instead:

1. Read the sidecar.
2. Locate the offending comment's `"anchor": { ... }` object by `"id"`.
3. Issue separate Edit calls — one per field (`text`, `contextBefore`, `contextAfter`) — each replacing only the literal current line.
4. Preserve indentation, quoting, trailing commas, surrounding JSON structure exactly.

The CLI path (`mdc.mjs set-anchor`) is now framed as a churn-prone fallback, permitted only when the Edit-based approach is blocked (e.g. a one-shot batch script with no Edit tool available).

A new unit test in `skill.test.ts` locks the surgical-Edit phrasing in so a future content edit can't silently regress to the full-rewrite path.

### Test surface

- 41 integration + 452 unit = **493 passing** (+1 skill instruction guard).

## 0.20.2 — 2026-05-03 (trial)

### Added: Claude skill instruction for anchor maintenance on every `.md` edit

Existing skill content already covered "when addressing review comments, update anchors of rewritten passages." But the same rule applies when Claude edits a `.md` file for any other reason — refactoring a section, fixing a typo, rewording a sentence the user pointed at in chat — any of those can break a comment's anchor.

Added a new top-level section to `SKILL.md` (`Anchor maintenance applies on EVERY .md edit, not just comment-driven ones`) that tells Claude to:
1. Compute the sidecar path after any `.md` edit in a workspace with `.markdown-collab/`.
2. Run `mdc.mjs validate <sidecar>` to surface broken or ambiguous anchors.
3. For each flagged anchor: if the passage was rewritten, update via `mdc.mjs set-anchor` to a verbatim substring of the new wording; if deleted, leave it untouched (the comment orphans, the human resolves it).
4. Touch only `anchor` — never `body`, `replies`, `resolved`, or any other field during this maintenance pass.

The orphan-on-deletion rule is preserved alongside (re-anchoring to nearby unrelated text creates misleading links).

Two new unit tests in `skill.test.ts` lock the instruction text in so a future content edit can't accidentally drop it.

### Test surface

- 41 integration + 451 unit = **492 passing** (+2 skill instruction guards).

## 0.20.1 — 2026-05-03 (trial)

### Fixed: floating "+ Add comment" button still required two clicks

The mousedown-snapshot fix from 0.19.5 covered the sidebar-header button but not reliably the *floating* button. Floating button is `position: fixed` and lives outside the editor's DOM subtree; in some cases the editor blurs *before* the button's own `mousedown` fires, so even the snapshot came back empty.

Fix: track a `lastNonEmptySelection` continuously via the existing `selectionchange / mouseup / keyup` listeners. The composer now consults selection in this order:

1. PM's live selection at composer-open time
2. The mousedown-captured pendingSelection (close-to-live)
3. The continuously-tracked lastNonEmptySelection (the most recent meaningful selection — the new fallback that closes the floating-button race)

This makes the floating button's first click reliably open the composer with the user's selection, regardless of any focus/blur reordering between PM and the floating button.

### Test surface

- 41 integration + 449 unit = **490 still passing**.

## 0.20.0 — 2026-05-03 (trial)

### Removed: dependency on the hand-rolled markdown stripper for both anchor write and read

The hand-rolled `stripInlineMarkup` was the single source of every alignment bug we hit (table padding, fenced code, Setext, references, escapes, tasks, blockquoted tables, …). It was an ad-hoc reimplementation of a CommonMark + GFM parser via a state machine — every markdown feature it didn't know about produced wrong anchor positions. Approach: stop reimplementing the parser; use Milkdown's authoritative serializer + the live PM doc instead.

**Read side (highlight rendering):** `buildAnchorDecorations` now resolves anchors against the live `doc.textContent` (what the editor actually displays), not against the markdown source via the stripper. The new `locateAnchorInLiveText` helper:

1. Strips inline markup from the *short* anchor strings only (`anchor.text` + context) to bridge the markdown→rendered gap.
2. Searches `doc.textContent` for the cleaned anchor.
3. Disambiguates by stripped context.
4. Converts the rendered offset directly to PM positions via the existing `pmPositionMapper`.

The whole `mdRangeToRenderedRange` step is gone from the hot path. Highlights paint where the user expects regardless of what block-level markdown sits between paragraphs.

**Write side (anchor extraction):** `openComposerForCurrentSelection` now uses Milkdown's own serializer + ProseMirror's `doc.cut(from, to)` to compute the exact markdown for the selection — no mapping through the stripper at all:

```ts
const fullMd = serializer(view.state.doc);
const sliceMd = serializer(view.state.doc.cut(selFrom, selTo)).trim();
// anchor.text IS the markdown slice — guaranteed to be what's on disk
// (modulo Milkdown's normalisation, which is the same on every save).
```

The slice's position in `fullMd` is found by Nth-occurrence-near-the-known-pm-pos, which uses `doc.cut(0, selFrom)` to compute an approximate markdown offset for disambiguation when the selection's text appears multiple times.

**Backstop kept:** the existing tolerant `resolve()` in `anchor.ts` still handles whitespace + tolerant-separator matching for the `mdc.mjs` Claude side and the standard editor's `CommentController`. So even when Milkdown's serializer normalises the source slightly differently from what's on disk (e.g. `*italic*` → `_italic_`, table padding reflowed), Claude can still locate the passage.

### Things that may still drift in extreme cases (documented)

- Files authored externally with markdown conventions Milkdown's serializer rewrites — `anchor.text` from a partial slice will be Milkdown's normalised form, not the source's literal bytes. The standard editor's tolerant resolver bridges most of this; outright failure surfaces as an orphaned-comment indicator.
- Selections that cut mid-block in unusual schema may include surrounding markers via `doc.cut`. Still likely to resolve, but the stored anchor.text may be slightly larger than what the user selected.

### Test surface

- All 449 unit tests still passing — the read/write rewrite removed bug surface without breaking any existing assertion. The hand-rolled stripper module (`stripInlineMarkup`) is still exercised by 27 tests because it's now used only on small anchor strings, which is the case it handles best.
- 41 integration tests still passing.
- Total: **41 integration + 449 unit = 490 passing**.

## 0.19.5 — 2026-05-03 (trial)

(Stop-gap release before the 0.20.0 rewrite.) Strip table cell padding from the `|`-stripping path so PM's table-cell-trim behaviour matches; capture editor selection on `mousedown` so the Add-Comment button no longer requires two clicks (Milkdown plugin paths could blur the editor between mousedown and click). 8 new unit tests in `tableCellPadding.test.ts`.

## 0.19.4 — 2026-05-03 (trial)

### Fixed: highlight alignment for tables, blockquoted tables, fenced code, HR, Setext, references, escapes, task lists

User test with a real document containing a blockquote-wrapped GFM table (the TradeNet flow map fixture) showed highlights still drifting after v0.19.3. Brainstormed every other markdown shape that PM's `doc.textContent` strips but the inline-only stripper kept; tested each explicitly; fixed the mismatches.

Concretely the stripper now also strips / handles:

- **GFM table cells** — `|` cell separators dropped (PM concatenates cells without separator).
- **GFM table separator rows** — `|---|---|---|` drop entirely (PM consumes as schema).
- **Tables nested inside blockquotes** — the `|` strip and separator-row check re-fire after the line-start `> ` is consumed.
- **Fenced code blocks** — `\`\`\`lang … \`\`\`` and `~~~ … ~~~` opener/closer lines drop, body preserved.
- **Setext heading underlines** — `=====` and `-----` lines drop.
- **Horizontal rules** — `---`, `***`, `___` (with optional spaces between markers) drop.
- **Reference-style links** — `[label][ref]` strips to `label`.
- **Link reference definitions** — `[ref]: http://x.com` lines drop.
- **Escape sequences** — `\*`, `\[`, `\\` strip the backslash, keep the next char.
- **Task list checkboxes** — `- [ ]` and `- [x]` strip the `[ ]`/`[x]` after the bullet.
- **Empty-blockquote-line edge case** — `> \n` no longer falls through to push the newline as text.

Two new test files (~26 tests):
- `userFixtureAlignment.test.ts` reproduces the user's exact reported document with blockquoted tables; asserts every realistic anchor resolves cleanly and the stripped output contains zero `|`, `\n`, or `---` leftovers.
- `alignmentShapes.test.ts` enumerates every other markdown shape (HR / Setext / fenced / indented / reference link / reference def / escape / task list / nested blockquote / mixed) with an explicit "stripped output equals X" assertion. One test = one shape = one regression guard.

### Test surface

- Total: **41 integration + 441 unit = 482 passing** (+26 new alignment tests, no regressions).

## 0.19.3 — 2026-05-03 (trial)

### Fixed: anchor highlights landed on the wrong text in real documents

User reported (with screenshot) that comments anchored on the "Reliability caveat:" paragraph were highlighting text in the list items below it: a comment on "Deprecated/obsolete items referenced below" appeared on "eprecated (2026-04-02)", a comment on "DRS and DDS documents describe…" landed inside "ments describe intended behaviour…, not necessarily…".

Root cause: `stripInlineMarkup` only stripped *inline* markdown (links, emphasis, code). It left **block-level** markdown — newlines, list bullets `- `, heading hashes `# `, blockquote `>`, indentation — in the stripped string. PM's `doc.textContent` contains *none* of those. So the stripped string was longer than what the editor actually displays, and every position past the first list/heading drifted forward by however many block-markup characters preceded it. The downstream `mdRangeToRenderedRange → renderedRangeToPmRange` pipeline then produced PM positions further down the doc than intended.

Fix: extended `stripInlineMarkup` with a line-start state machine that swallows newlines, ATX heading hashes, blockquote prefixes, unordered/ordered list markers, and leading whitespace. The resulting stripped string now equals what `view.state.doc.textContent` produces.

New `highlightAlignment.test.ts` reproduces the user's exact scenario (heading + list + paragraph + list) and asserts both anchors resolve to the correct rendered ranges. The previous test that verified "block-level prefix is preserved" was reversed (it was documenting the bug, not the desired behaviour).

### Test surface

- 1 new test file (`highlightAlignment.test.ts`, 4 tests).
- 1 existing test updated to match the corrected behaviour.
- Total: **41 integration + 381 unit = 422 passing**.

## 0.19.2 — 2026-05-03 (trial)

### Fixed: unclosed `**` was silently eaten by the inline stripper

Found by exhaustive branch coverage: when a markdown source contains an unclosed bold marker like `a **b c`, the stripper's doubled-marker branch failed to find a matching `**` close → fell through to the single-marker branch → which happily matched the second `*` of the unclosed pair as a "close" → produced `a b c` instead of leaving the literal text alone. That misalignment cascaded into wrong anchor positions and wrong highlights for any selection in such a document.

Fix: when the doubled-marker branch can't find a matching close, push both literal `*` chars and bail — never fall through to the single-marker branch.

### Added: exhaustive branch coverage across the highlight chain

74 new unit tests:

- **`stripInlineMarkup.test.ts` (new, 27 tests)** — direct tests for plain text / link / image / autolink / each emphasis variant / nested markup / unclosed brackets / unclosed paren / unclosed `*` / unclosed `**` / unicode in plain + link labels / position-map invariants / escape characters in labels.
- **`pmPositionMapper.test.ts` (+7, now 16 total)** — early-exit branch verification, non-text node interleaving, inverted ranges, empty docs, full-doc highlight, range crossing non-text nodes.
- **`anchorLocator.test.ts` (+9, now 15 total)** — range starting at md 0, ending at md.length, zero-length, empty source, multiple back-to-back stripped runs, anchor at start of doc, anchor at end of doc, anchor inside heading, unresolvable anchor.
- **`anchorExtractor.test.ts` (+7, now 23 total)** — inverted/zero/negative selections, threshold boundary at exactly 7 vs 8 non-WS chars, leading/trailing whitespace, autolink selection, post-image selection.
- **`relativeTime.test.ts` (+8, now 15 total)** — exact boundary at every unit threshold (30s / 1m / 1h / 1d / 7d), numeric epoch input, default-now arg, December-spanning year boundary.
- **`urlAllowlist.test.ts` (+8, now 16 total)** — TAB / lone CR rejection, port+query+fragment, ftp/ssh/git+https rejected, scheme case-insensitivity for all allowed schemes, URLs with spaces.
- **`linkRouter.test.ts` (+8, now 23 total)** — multi-segment fragment, bare `#`, query string off workspace path, query+fragment combo, malformed percent-encoding, deep parent traversal staying inside workspace, Windows-style `C:/` rejected, data: URI rejected.

### Test surface

- Total: **41 integration + 377 unit = 418 passing** (+74 unit tests).

## 0.19.1 — 2026-05-03 (trial)

### Fixed: anchor highlights painted on the wrong text

User report after 0.19.0: highlights covered the wrong characters. Reproduced in 9 unit tests against synthetic ProseMirror docs.

Root cause: the rendered-offset → PM-position mapper used `<= nodeRenderedEnd` for **both** `from` and `to`. When the rendered start sat exactly at a text-node boundary (e.g. start of "world" inside `Hello <strong>world</strong>` at offset 6), `from` was set to the position right after the previous text node — which lives **inside** the inter-node markup token (`<strong>` open at PM pos 7), not at the start of the next text node (PM pos 8). PM rendered the decoration shifted left, covering the markup boundary instead of the intended text.

Fix: extracted the mapper into `pmPositionMapper.ts` and corrected the boundary rules — `from` uses **strict** upper bound (a renderedStart equal to a text node's right edge belongs to the NEXT text node), `to` uses **inclusive** upper bound (so end-of-doc anchors still match). 9 new unit tests cover single-node, two-node-straddling, mark-boundary, paragraph-spanning, and out-of-range cases — including the boundary case that produced the bug.

### Test surface

- 9 new unit tests (`pmPositionMapper.test.ts`).
- Total: **41 integration + 303 unit = 344 passing**.

## 0.19.0 — 2026-05-03 (trial)

### UX redesign of the collab editor

A senior-UX-designer review of v0.18.7 surfaced 10 prioritised issues plus the user's own request for **highlighted commented passages + bidirectional click navigation**. This release lands all of them.

#### P0 — correctness / data-integrity

- **Real author names on add + reply.** The webview now sends `author` from `markdownCollab.collab.userName` (or the OS user as fallback). The extension's `add-comment` / `reply-comment` paths use it instead of the hardcoded `"user"` literal — threads are now distinguishable in multi-user reviews. Two new integration tests guard the propagation + the fallback.
- **Per-reply timestamps.** New `relativeTime.ts` formatter (`just now` / `5m` / `3h` / `2d` / absolute `Aug 12`) is rendered next to every comment + reply author. 7 new unit tests.
- **Connection-status banner.** Replaced the 0.7-opacity 11px corner badge with a prominent header banner (yellow "Reconnecting…" / red "Offline — your edits aren't syncing"). The corner badge is gone — the banner is unmissable.

#### P1 — high-impact polish

- **"Add comment" promoted, Claude actions demoted.** "Add comment" is the labelled primary button; "Copy prompt" + "Send to Claude" moved into a "…" overflow menu. Importance now matches the user's mental model.
- **Filter resolved + collapsible sidebar.** The "X open · Y total" subtitle became a clickable chip — toggles "show only open". Sidebar can be collapsed via a toggle button (auto-shown at narrow widths).
- **Editor follows the VSCode theme.** Nord's hardcoded dark blues are now overridden by `--vscode-editor-*` / `--vscode-textCodeBlock-*` tokens. Works on Light / High Contrast themes.
- **Empty-state + rejection toast made actionable.** Empty state shows the keyboard shortcut prominently and explains the gutter-sync. Rejection toast says concrete cause (e.g. "Selection is too short. Pick at least 8 characters of contiguous text.") rather than the unhelpful "avoid markup".
- **Anchor highlights + bidirectional navigation (and the user-requested feature).** New `anchorLocator.ts` module + ProseMirror Decoration plugin paint a soft yellow highlight on every commented passage. Click a highlight → sidebar scrolls to that comment, the card flashes. Click a card's anchor preview → editor scrolls to the highlight, which pulses. The locator uses the existing tolerant resolver instead of `indexOf`, so anchors that appear multiple times in the doc resolve to the right occurrence. 6 new unit tests.
- **Responsive layout.** Below 720px: sidebar becomes a slide-in drawer with a toggle button. Below 480px: drawer takes the full width. The previous hardcoded `1fr 320px` collapsed the editor to ~30px in side-pane workflows.

#### P2 — polish

- **Social presence.** Avatar stack of named peers (colored initials, Yjs awareness `user.color`) in the sidebar header. Remote cursors get a name flag that uses the same color.

### Test surface

- 14 new unit tests (relativeTime: 7, anchorLocator: 6, anchorExtractor stripped export: 1).
- 2 new integration tests for the author propagation path.
- Total: **41 integration + 294 unit = 335 passing**.

## 0.18.7 — 2026-05-03 (trial)

### Fixed: comments added in the collab webview didn't show up in VSCode's gutter

You're right that the gutter UI is VSCode's own `CommentController` reading from the `.md.json` sidecar — same data the collab webview writes. The wiring was: collab webview → `addComment` → `saveSidecar` → file written. The gutter should refresh via the sidecar file watcher.

But `saveSidecar` always recorded the just-written content's hash in a `selfWriteHashes` set so the standard editor's `SidecarWatcher` could ignore echoes of *its own* writes. The collab editor uses the same `saveSidecar` path → its writes also got hash-tracked → the standard editor's watcher saw the file event, hashed the content, found a match in `selfWriteHashes`, decided "this is just an echo of something I wrote myself", and skipped the reload. The gutter never refreshed.

Fix: `saveSidecar` now takes an `{ trackSelfWrite?: boolean }` option (default `true` for backward compat). The collab editor's `add` / `reply` / `toggle-resolve` / `delete` handlers all pass `trackSelfWrite: false`, so writes from that subsystem are correctly seen as external by the standard-editor watcher and the gutter reloads. New regression test in `sidecar.test.ts` asserts `wasSelfWrite` returns `false` after a `saveSidecar(..., { trackSelfWrite: false })` call.

### Test surface

- 1 new unit test (`sidecar.test.ts`).
- Total: **39 integration + 281 unit = 320 passing**.

## 0.18.6 — 2026-05-03 (trial)

### Added: rendered-text fallback strategy + diagnostic logging when anchor extraction can't lock on

User report after 0.18.5: "I got the same issue." That suggests Milkdown's actual rendering of complex link / inline-code combinations differs from what the unit-test fixtures assume — the extractor's strip-and-map can fail to align in production for shapes I haven't seen. To make the editor *always* let you create a comment and to give us visibility into when alignment fails:

- `buildAnchorWithDebug` now tries two strategies in sequence: (1) the precise strip-and-map; (2) a rendered-text fallback that stores the selection's plain text plus rendered context. Strategy 2 always returns *something* for selections ≥ 8 non-whitespace chars, so the comment is created even when the precise strategy can't lock on. The existing `anchor.resolve` helper has whitespace + tolerant-separator fallbacks of its own, so a Strategy-2 anchor can still resolve later if the surrounding markdown is reasonably stable.
- When Strategy 1 falls through, the webview posts a `webview-error` with the rendered-text sample, markdown sample, and selection range. This shows up in the **Markdown Collab** output channel and lets us see exactly what Milkdown rendered vs what's in the source — without which I can't guess the failure mode from headless tests.

## 0.18.5 — 2026-05-03 (trial)

### Fixed: anchor extraction on inline-code link labels (the user's exact repro)

The user's exact reported markdown — `See [\`[CORRECTIONS.md](http://CORRECTIONS.md)\`](../../[CORRECTIONS.md](http://CORRECTIONS.md)) for confirmed corrections.` — has a link whose label is inline code containing more markdown. Selecting the surrounding sentence and clicking "Add comment" silently produced no anchor, so nothing happened.

Root cause: the inline-markup stripper preserved backticks **inside link labels** (it only stripped backticks at the top level). Milkdown's renderer drops them, so the rendered editor text and the stripped markdown text disagreed on every char from the first backtick onward — every selection that crossed the link's label failed alignment and returned `null`.

Fix: a new `emitLabelStripped` helper handles link-label content separately, dropping inline-code wrappers (` ` `, `*`, `_`, `~`) so the stripped string matches what the editor displays.

Reproduced the exact failing markdown in 4 new unit tests covering: full-sentence selection across the link, partial selection inside the inline-code label, selection straddling after the link, and a sentence-spanning case.

### Test surface

- 16 anchor-extractor tests (+4 for the user's exact repro).
- Total: **39 integration + 280 unit = 319 passing**.

## 0.18.4 — 2026-05-03 (trial)

### Fixed: reliable ways to add a comment when the floating button doesn't appear

User report: even after 0.18.3 lifted the rendered-length gate, selections that include a Milkdown link still don't surface the floating "+ Add comment" button reliably. Milkdown's link mark adjusts the ProseMirror selection asynchronously after a drag, and the floating button's position-tracking can lose the race — silently leaving the user with nothing to click.

Two new affordances that don't depend on tracking the floating button's position:

- **"+" icon in the sidebar header.** Pinned next to the Copy-prompt and Send-to-Claude buttons. Click it and the composer opens for the current editor selection. The `mousedown` handler `preventDefault`s so the editor doesn't blur and the selection survives the click.
- **Cmd/Ctrl+Shift+M shortcut.** Anywhere in the webview. Same effect.

Both paths feed into the same `openComposerForCurrentSelection` that the floating button uses, so the existing anchor-extraction tests already cover the data path. The composer toasts a clear reason if the selection can't produce an anchor (rather than silently dropping).

Reproduced the user's pathological markdown — `See [\`[CORRECTIONS.md](http://CORRECTIONS.md)\`](../../[CORRECTIONS.md](http://CORRECTIONS.md)) for confirmed corrections` — in two new unit tests. The extractor handled it without throwing in both cases, which confirmed the bug was the UI gate, not the data layer.

### Test surface

- 12 anchor-extractor tests (+2 for the pathological cases).
- Total: **39 integration + 276 unit = 315 passing**.

## 0.18.3 — 2026-05-03 (trial)

### Fixed: "Add comment" affordance silently disappeared when selection touched a link

Two webview UI gates conspired to make the "+ Add comment" button never appear (and the composer never open) for selections that crossed a markdown link:

1. **Floating button gated on rendered length.** The button only showed if `doc.textBetween(sel.from, sel.to)` had ≥8 non-whitespace chars. For a selection covering just a link's bracketed label like `[foo](url)`, the rendered text is "foo" — three chars — so the gate filtered the button out, even though the underlying anchor extractor was perfectly capable of building a valid anchor for it.
2. **Link click interceptor cancelled drag-select.** The global `click` handler on `a[href]` always called `preventDefault` + `stopPropagation` — so when a user finished a drag-select with the mouseup landing on a link, the editor blurred and the selection was cleared before the floating button could be positioned.

Fixes:
- The button now shows for *any* non-empty selection. The composer enforces the 8-char minimum and toasts a clear reason if it can't build an anchor.
- Added `mouseup` and `keyup` (Shift/arrow keys) as redundant triggers for the button-position update — `selectionchange` alone wasn't always firing after Milkdown's link-mark selection adjustments.
- The link-click interceptor now skips its open-link route when there's a non-empty DOM selection (`window.getSelection().toString().trim().length > 0`), so finishing a drag on a link no longer cancels the selection.

Also caught (and fixed) a related anchor-extractor edge case: `mdEnd` was using `map[selectedLen]` which, when the next stripped char sat past a stripped run, leaped over closing markup chars and pulled them into the anchor text. Switched to `map[selectedLen-1]+1` so the anchor stays exactly at the user's selection boundary.

5 new unit tests in `anchorExtractor.test.ts` cover: link-only selection, selection extending out of a link into surrounding text, paragraph-wrapping selection containing one link, selection across two separate links, selection across bold + link wrappers.

### Test surface

- Total: **39 integration + 274 unit = 313 passing**.

## 0.18.2 — 2026-05-03 (trial)

### Fixed: comment anchor was wrong when the selection contained a link

Reproduced under TDD: an earlier extractor used `markdownSource.indexOf(selectedText)` which always returns the first occurrence. Two failure modes followed:
1. **Bare-then-bracketed duplicates.** A doc like `I am here. Click [here](url) for more details.` rendered as `I am here. Click here for more details.`. Selecting the link label `here` selected `here` in rendered text — `indexOf` found the FIRST occurrence (the bare one earlier) and silently anchored the comment there.
2. **Selection straddling markup.** Selecting `here in the docs` across a link boundary in `[here](url) in the docs` produced an anchor whose `text` field never appeared verbatim in the markdown source — the resolver returned null and the comment showed as orphaned.

Fix: a new `anchorExtractor` module strips inline markdown (link `[label](url)` → `label`, image `![alt](url)` → `alt`, autolinks, `**`, `*`, `_`, `~~`, `` ` ``) while recording a position map back into the original source. The webview maps the ProseMirror selection to rendered offsets, finds the corresponding span in the stripped string (using an Nth-occurrence rule so duplicates within the doc are resolved by selection position rather than by document order), then translates back to markdown positions. Anchor `text` is the literal markdown slice between those positions — including any markup chars the selection crossed — so `anchor.resolve` round-trips cleanly to the same passage.

5 new unit tests in `anchorExtractor.test.ts` cover: too-short selection, plain selection, selection that crosses a link, link-vs-bare disambiguation, multi-occurrence Nth-pick.

### Test surface

- Total: **39 integration + 269 unit = 308 passing**.

## 0.18.1 — 2026-05-03 (trial)

### Fixed: deleting a comment did nothing

The delete button called `window.confirm()` and only posted the delete message if the user pressed OK. VSCode webviews run in a sandboxed iframe where the native `confirm()` dialog is silently blocked — it never displays UI and returns false — so the cancel branch always fired and the comment never went away. Replaced with an inline two-button confirmation panel that appears in the comment card itself.

Also strengthened the message handlers themselves: `runDeleteComment` now distinguishes "comment id not found" from "I/O failure" so the toast surfaces the actual reason. Eight new unit/integration tests directly call `runReplyComment` / `runToggleResolve` / `runDeleteComment` and assert both the sidecar mutation *and* the response payload — guarding against regressions where the webview UI silently masks a broken extension-side handler.

### Added: links to other documents in the repo work

A click on a relative-path link (`./other.md`, `../README.md`, `path/to/spec.md`) or a workspace-root-relative link (`/docs/api.md`) now opens the target file via `vscode.open`. URLs are routed through a new `linkRouter` module that classifies each href as `external` / `workspace` / `fragment` / `blocked`. Path traversal (`../../../etc/passwd`) is blocked by verifying the resolved path stays inside one of the workspace folders. Multi-folder workspaces pick the folder that contains the source document; loose docs (outside any workspace folder) refuse `/`-rooted links rather than guess.

15 new unit tests in `linkRouter.test.ts` cover relative / parent / bareword / root-relative / fragment-only / fragment-on-workspace-link / control-chars / percent-encoding / multi-root / escape-blocked / external-allowlist parity.

`#fragment`-only links are classified as `fragment` but currently no-op — within-document anchor scrolling is on the next-iteration list.

### Test surface

- Total: **39 integration + 264 unit = 303 passing**.
- New: 8 handler tests, 15 linkRouter tests.

## 0.18.0 — 2026-05-03 (trial)

### Added: Mermaid diagrams render inline in the WYSIWYG editor

Fenced \`\`\`mermaid blocks now render their SVG above the source. Implemented as a ProseMirror Decoration (widget side: -1) instead of a code-block node-view replacement — the original editable code block stays untouched, mermaid blocks just grow a sibling rendered SVG that updates whenever the source changes. Mermaid is bundled into the webview client (3.5 MB minified — the bulk of the ~3.5 MB total bundle is mermaid + d3 + dagre); it loads lazily on first use via dynamic import.

A Devil's Advocate iteration caught a regression: an early node-view-based attempt broke editing of *all* code blocks (no \`contentDOM\` exposed → ProseMirror treated every \`\`\`lang block as atomic). Switched to the decoration approach and re-ran the integration suite to confirm no regression.

### Added: clickable links

Links inside the editor (Milkdown rendered \`<a>\`) and inside the comments sidebar are now click-handled — the webview posts them to the extension which opens via \`vscode.env.openExternal\`. The extension validates the URL against an allowlist of \`http:\`, \`https:\`, and \`mailto:\` schemes (8 unit tests in \`urlAllowlist.test.ts\` cover \`javascript:\`, \`file:\`, \`data:\`, \`vscode-webview:\`, embedded control characters, and unhappy inputs). Anything outside the allowlist is rejected with a toast.

### Added: per-comment Reply / Resolve / Delete actions

Each comment card in the sidebar grew a top-right action row:

- **Reply** — toggles an inline composer scoped to that thread; submitting calls the existing \`addReply\` sidecar helper.
- **Resolve / Unresolve** — flips the comment's \`resolved\` flag via \`setResolved\`. The icon swaps between a checkmark (open → resolve) and a circle (resolved → unresolve).
- **Delete** — pops a \`window.confirm\` dialog; on accept calls \`deleteComment\`. The whole thread (including replies) goes away.

All three actions write through the *same* sidecar helpers the standard editor's CommentController uses, so changes flow back to gutter UI in other windows. The sidebar refreshes automatically via the existing sidecar file watcher.

### Added: top-right toolbar — Copy prompt + Send to Claude

A two-button toolbar on the sidebar header:

- **Copy prompt** (clipboard icon) — copies \`Use the markdown-collab skill to address the unresolved review comments on <file>.\` to the clipboard.
- **Send to Claude** (paper-plane icon) — invokes the existing \`markdownCollab.sendAllToClaude\` command, which honours the user's configured \`markdownCollab.sendMode\` (terminal / channel / mcp-channel / clipboard / ask). Disabled when there are no unresolved comments.

### Test surface

- 8 new unit tests for the URL allowlist (\`urlAllowlist.test.ts\`).
- 6 new integration tests in \`commentActions.test.ts\` covering reply / resolve / delete round-trip, the copy-prompt + send-to-claude paths, and a mermaid fixture smoke check.
- Total: 31 integration tests + 249 unit tests = **280 passing**.

## 0.17.0 — 2026-05-02 (trial)

### Added: GFM tables, task lists, strikethrough in the collab editor

The collab editor swapped `@milkdown/preset-commonmark` alone for `commonmark` + `@milkdown/preset-gfm`. Pipe-tables (`| col | col |`), task list checkboxes (`- [ ]` / `- [x]`), `~~strikethrough~~`, autolinks, and footnotes now render natively.

### Added: comments side panel + add-comment from selection inside the collab editor

Until now the collab editor had no way to see or create review threads — that was a documented gap, but a serious one. This release lands the missing UI:

- A **comments sidebar** to the right of the WYSIWYG editor lists every thread in the file's `.md.json` sidecar with its anchor snippet, author, body, and replies. Clicking a comment scrolls the editor to its anchor and pulse-highlights the matching DOM node so reviewers can find the passage being discussed even after surrounding text has shifted.
- An **"Add comment" affordance** appears next to the editor selection when a reviewer drags-selects 8+ non-whitespace characters. Pressing it opens an inline composer in the sidebar; saving builds an `Anchor` (selected text + 24 chars of surrounding markdown context on each side) and writes through the existing `addComment(...)` helper. The thread shows up immediately in this window's sidebar and in any other open editor's `CommentController` gutter (the file-system watcher picks the change up via the standard sidecar path).
- The sidebar reloads automatically when the sidecar changes — whether the change came from the standard editor's gutter UI, a Claude-driven reply, or another collaborator. The collab editor and the standard editor are now backed by the same data with the same write/observe pipeline; you can use whichever surface you prefer for review.

### Limitations / next steps

- Replies and resolve/un-resolve from inside the collab editor are not yet available — for those, reopen the file in the standard editor's gutter UI (the data is the same). The sidebar shows replies read-only.
- Anchor scroll uses a plain-text scan over the rendered ProseMirror doc; on documents with markup-heavy passages (long code blocks with raw HTML) the highlight may land on the surrounding block instead of the exact character range.
- Inline highlighting of all anchored passages (instead of only on click) would need a ProseMirror Decoration plugin keyed to anchor positions; punted for the trial.

## 0.16.0 — 2026-05-02 (trial)

### Known gap: review comments in the collab editor

The CommentController API used by the existing review feature attaches its UI (gutter icons, inline thread cards) to a Monaco text editor. The collab editor is a webview with Milkdown inside — there is no Monaco surface to attach to, so **review comments do not show up while a file is open in the collab editor**. Nothing on disk is harmed: the `.md.json` sidecar is untouched, anchors remain valid, and reopening the file with the standard Markdown editor brings the comment threads back. For now: edit collaboratively in the WYSIWYG editor, review/comment in the standard editor.

Verified by integration test (`comments.test.ts`) that opening a file with an existing sidecar in the collab editor does not mutate the on-disk markdown and does not invalidate the comment anchors.

### Changed: collab editor is now WYSIWYG (Milkdown), not raw markdown

The collaborative editor previously rendered the markdown source as a CodeMirror code editor — fine for engineers, but jarring for non-technical reviewers who expected to see *the rendered document* (headings actually look like headings, **bold** is bold, lists are lists). The editor is now Milkdown (ProseMirror under the hood) with the nord theme and the commonmark preset. Users type into a rendered document; markdown shortcuts auto-style as they type (e.g. typing `# ` becomes a heading). The on-disk file format is still plain commonmark — Milkdown's serializer round-trips the document on every save.

Real-time collaboration runs through `@milkdown/plugin-collab` (which wraps `y-prosemirror`). Awareness, remote cursors, and convergence still go through the same `y-websocket` relay we shipped in 0.15.

Trade-off: Milkdown's CRDT shape is `Y.XmlFragment("prosemirror")` — different from the old `Y.Text("doc")`. The server's pre-existing `?init=` text-seeding code path is now a no-op for the new editor; the first peer's Milkdown `applyTemplate` populates the room. There is a small race window if two peers connect within the same network round-trip (both could observe an empty doc and both apply the template), which would duplicate the seed. We accept this for the trial — opening the same file simultaneously on two machines is rare in practice; we'll add server-side ProseMirror seeding if it shows up.

### Added: webview error reporting

Failures inside the webview (Milkdown init errors, ProseMirror schema mismatches, missing CSS, etc.) now post a `webview-error` message back to the extension and surface in the **Markdown Collab** output channel. This made the bring-up of the new editor much faster to debug and is useful in production for triaging real-world issues.

## 0.15.1 — 2026-05-02 (trial)

### Fixed: collab editor sometimes rendered an empty document

The webview created the CodeMirror EditorView synchronously after instantiating the WebsocketProvider, but the provider hadn't completed sync at that point — `ytext.toString()` returned `""` and `y-codemirror.next` did not always backfill the seed once the relay's update arrived. The editor now waits for either the `provider.sync` event or a 1.5s grace period (whichever comes first) and only then constructs the EditorView with the actual seeded content. If the relay is unreachable, the webview falls back to seeding `Y.Text` locally so the user always sees the file's contents.

### Fixed: EADDRINUSE on the relay port crashed the extension host

`new WebSocketServer({ server })` re-emits the underlying HTTP server's `error` event on the `wss` instance. We listened on the HTTP server (good — that path correctly rejected our `startCollabServer` promise) but not on `wss`, so the same `EADDRINUSE` bubbled up as an `uncaughtException` and tore down the extension host on the next reload. A no-op `wss.on('error', …)` swallow paired with the existing HTTP-server error handler restores the original "log and reuse the existing relay" behaviour.

### Added: configurable relay port

New setting `markdownCollab.collab.port` (default `1234`). Useful when port 1234 is already taken by an unrelated tool, or when running the integration tests alongside a developer's normal VSCode session.

### Added: @vscode/test-electron integration test harness

`npm run test:integration` boots a real downloaded VSCode (Electron) into the Extension Test Host, loads the extension against a fixture workspace, and runs five end-to-end tests covering: command/customEditor registration, relay-port HTTP signature probe, relay-side seed pipeline (using a test-only server introspection hook so we don't race the webview), webview-side post-sync content length (the regression guard for this version's empty-doc bug), and a relay-side multi-peer broadcast.

## 0.15.0 — 2026-05-02 (trial)

### Added: experimental real-time collaborative editor (CodeMirror 6 + Yjs)

Opt-in `CustomTextEditor` for `.md` files (priority `option`, so the default Markdown editor and the existing comment / preview UI are unchanged). Open via **Reopen Editor With… → Markdown Collab (real-time, experimental)** or the new `markdownCollab.openCollabEditor` command.

- CodeMirror 6 + `y-codemirror.next` running inside a webview, bundled with esbuild (~592 KB minified).
- A minimal `y-websocket`-compatible relay (HTTP + WebSocket + `y-protocols`) is embedded in the extension and started on activation at `ws://127.0.0.1:1234`. Multi-window collisions are detected: if port 1234 is already serving our relay (HTTP probe matches our signature), the new window reuses it.
- Server-side seeding via `?init=<base64>` query param. The single-process relay accepts the first connection's seed text and ignores every later one — no first-peer race.
- Awareness propagates remote cursors and user-name/color between peers.
- New settings: `markdownCollab.collab.serverUrl`, `markdownCollab.collab.startLocalServer`, `markdownCollab.collab.userName`.

Known gaps in this trial: relay state lives in memory only (on-disk file is the persistent source of truth); review comments are not yet synced through Yjs (they still flow through the existing `.md.json` sidecar); opening the same file in *both* the Monaco editor and the collab editor at once will fight over edits — pick one.

13 new tests cover the relay sync, room isolation, seeding (incl. UTF-8), awareness, HTTP probe contract, and base64 round-trips.

## 0.14.3 — 2026-05-02

### Fixed: preview comments on selections that cross headings or blockquotes

`locateSelectionInSource`'s tolerant-separator fallback let the regex bridge runs of whitespace plus a small set of markdown punctuation (`|`, `*`, `_`, `~`, `` ` ``, `-`) between the words of a selection, so that a DOM `Selection.toString()` — which strips markdown syntax — could still match the source. The class missed `#` and `>`, so selections that crossed an ATX heading marker (`# Header 1\n\n## Header 2`) or a multi-line blockquote (`> quoted\n> more`) failed to resolve and the comment couldn't be created.

Separator class extended to `[\s|*_~`\-#>]+`. Both characters only carry block-syntax meaning at line start, so the broader class only bridges whitespace + leading-line markers between selected tokens — never inside a token. Three regression tests added: heading + paragraph, two consecutive headings + paragraph, multi-line blockquote into paragraph.

## 0.14.2 — 2026-04-29

### Fixed: preview panel sometimes auto-closed mid-typing

The preview panel listened to `onDidCloseTextDocument` on the source `.md` and disposed itself when fired. That event also fires for transient close/reopen cycles (preview-mode tab cycling, encoding switches, memory unloading) — not just user-initiated tab closes. The panel could vanish while the user was typing into the compose textarea inside the webview, since VS Code is free to recycle the underlying doc independently of the webview's focus.

Auto-dispose on doc-close removed. The panel now persists until the user closes it explicitly via the tab's `✕`. `render()` already falls back to reading from disk when the buffer is unloaded, so the preview keeps working in that state. The file watcher's `onDidDelete` still disposes the panel when the underlying file actually disappears from disk (rename or delete).

## 0.14.1 — 2026-04-29

### Preview content now fills the available width

The preview's main content area was capped at `max-width: 960px`, leaving large empty gutters on wide monitors (especially with the comments sidebar pinned at 360px on the right). The cap is removed; the main column now grows to fill whatever the viewport offers minus the sidebar. Mermaid diagrams, tables, and wide code blocks no longer scroll horizontally on screens that have plenty of room.

## 0.14.0 — 2026-04-29

### Comments and replies render as Markdown in the preview sidebar

Both the collapsed card snippets and the expanded message bodies now render Markdown via the same `markdown-it` instance the document body uses. Bold, italics, inline `code`, fenced blocks, links, lists, blockquotes, and tables all render in place.

- Server-side rendering: `bodyHtml` is computed in the host (TypeScript) and injected into the webview JSON. `markdown-it` runs with `html: false`, so any raw HTML in a comment body is escaped — same XSS posture as before.
- The collapsed two-line preview keeps the inline-paragraph treatment (no awkward block-level margin) and still clamps at two lines.
- The textarea editor for **Edit** keeps the raw markdown source — what the human typed is what they see.
- Falls back to escaped plain text if a comment was authored before this version (`c.bodyHtml || esc(c.body)`).

Bumps to 0.14.0.

## 0.13.3 — 2026-04-29

### Removed: terminal-mode "Send N to terminal …?" confirmation toast

The terminal transport's detection ladder used to show a *Send / Cancel* toast for medium- and low-reliability matches (name-based or active-terminal). That toast fires on every click against an already-spawned `Claude Review` terminal once VS Code restarts and the in-memory owned-set is empty, which is exactly the steady-state path. The friction outweighed the safety it bought; the click is the user's explicit intent already. Toast removed; injection is unconditional now.

## 0.13.2 — 2026-04-29

### README rewrite for users

The README is reorganized into a top-down "what is this → quick start → daily use → mode picker → troubleshooting" flow rather than a feature dump. Adds:

- **Quick start**: 5 numbered steps from `code --install-extension` to first review reply.
- **Choosing a send mode**: a decision matrix that explicitly recommends `terminal` when MCP and channel features aren't available in the user's environment, and explains *why* for each row.
- **Send mode details**: per-mode setup blocks with copy-pasteable commands.
- **Settings reference**: documents `markdownCollab.sendMode` and its values.
- **Troubleshooting**: covers the four most common stuck states from this iteration cycle (silent click on stale `ipc` value, channel-mode lines not arriving, `--channels ignored`, orphaned comments, gutter icon multiplication).
- **Storage layout**: now lists the runtime dotfiles (`.events.jsonl`, `.events.acked.jsonl`, `.channel.json`) with the recommended `.gitignore` snippet.

No code change.

## 0.13.1 — 2026-04-29

### Fixed: tailer + channel server may buffer their stdout

Both `mdc-tail.mjs` and `mdc-channel.mjs` were using `process.stdout.write`. Per [Node docs](https://nodejs.org/api/process.html#a-note-on-process-io), that call is **asynchronous on POSIX when stdout is a pipe** — and Claude Code captures both scripts' stdout via a pipe. Lines could sit in the libuv write queue until the event loop ticked, especially when the script was busy doing other work (reading, watching, JSON-parsing).

Both scripts now write through `fs.writeSync(1, …)`: a synchronous, immediate write to file descriptor 1. Each emitted line / JSON-RPC message arrives at Claude Code's reader the instant the underlying `appendFile` (or `notification`) fires, with no buffering window. This is the same fix the previous `tail -f` → `mdc-tail.mjs` switch was meant to guarantee — but only `tail`'s buffering was actually being addressed; Node's own pipe-write buffering was still in play.

## 0.13.0 — 2026-04-29

### New transport: `mcp-channel` — native Claude Code channel events

Adds a fifth `markdownCollab.sendMode`: **`mcp-channel`**. The skill installer now also drops `mdc-channel.mjs` next to `mdc.mjs` and `mdc-tail.mjs`. That script is a hand-rolled MCP server (no SDK dep) that:

- Speaks the minimum JSON-RPC handshake to declare `experimental.capabilities['claude/channel']`.
- Listens on a localhost HTTP port and writes the port + per-session bearer token to `<workspace>/.markdown-collab/.channel.json`.
- On `POST /push`, fires `notifications/claude/channel`, so the payload arrives in Claude's next turn as a native `<channel source="markdown-collab" file="…" count="N" id="evt_…">` tag — no streaming tool, no Bash 600s ceiling, no polling.

When the user clicks **Send to Claude** in `mcp-channel` mode, the extension looks up `.channel.json`, POSTs the same envelope it would have written to the events log (and still does — `mcp-channel` mode appends to both the events log and the channel, so ack-based suppression still works), and shows a success toast.

**One-time setup** for users who want this mode (added to the README):

1. Run **Markdown Collab: Install Claude Skill**.
2. Add to `~/.claude.json` or the workspace's `.mcp.json`:
   ```json
   { "mcpServers": { "markdown-collab": { "command": "node", "args": ["~/.claude/skills/vs-markdown-collab/mdc-channel.mjs"] } } }
   ```
3. Start Claude with `claude --dangerously-load-development-channels server:markdown-collab`.

### Caveats

- Channels are research preview as of Claude Code v2.1.80 — protocol may change.
- Requires claude.ai login (not API-key / Console).
- Doesn't help when MCP is fully disabled by enterprise policy — channels are MCP under the hood. Use `terminal` mode in that case.

### Tests

5 new tests cover the extension-side transport (not-running, 401, 500, ECONNREFUSED, success-with-bearer-auth-and-correct-body). The MCP server itself was end-to-end smoke-verified during development: spawn → handshake → POST → `notifications/claude/channel` line on stdout with correct meta.

## 0.12.3 — 2026-04-29

### SKILL.md: harness-capability fallbacks for the channel watch loop

Some Claude Code harnesses don't expose a per-line stdout-streaming tool (`Monitor` / `BashOutput`) — they only have `TaskOutput`, which waits for completion and is therefore the wrong fit for the long-running `mdc-tail.mjs`. The skill's "Channel watch loop" section now spells out three fallbacks for that case: switch the VS Code setting to `terminal` mode, poll with `TaskOutput block=false`, or `Read` the events file directly each turn. The terminal transport remains the recommended path for harnesses without streaming.

## 0.12.2 — 2026-04-29

### SKILL.md: tighten Monitor-vs-TaskOutput guidance

Claude sessions were hanging on `TaskOutput block=true` against the long-running `mdc-tail.mjs` background bash, because `TaskOutput` waits for *completion* — and the tailer never completes by design. The watch-loop section of the bundled SKILL.md now explicitly says "use **Monitor** (not TaskOutput)" and explains why, with a fallback hint for harnesses that expose the same capability under a different name (e.g. `BashOutput`).

## 0.12.1 — 2026-04-29

### Fixed: silent no-op when sendMode was an unknown value (e.g. "ipc")

Users upgrading from 0.10.x had `markdownCollab.sendMode: "ipc"` in their workspace settings.json. After the rename to "channel" in 0.11.0, that value is no longer in the schema enum but VS Code still serves it via `config.get`. The dispatcher's three `if (mode === ...)` branches all missed, so the **Send to Claude** button silently did nothing — the events log never grew.

Now the dispatcher normalizes any unrecognized value back to "ask" (so the user gets the quick-pick instead of a no-op), surfaces a one-line warning naming the offending value, and writes a longer note to the output channel telling them about the 0.11.0 rename.

## 0.12.0 — 2026-04-29

### Channel events auto-ack once Claude has addressed them

Each event written to `.markdown-collab/.events.jsonl` now carries a unique `evt_…` id. After every sidecar mutation the extension reconciles the event log: when every comment referenced by an unacked event is either resolved, deleted, or has an `ai`-authored last reply, the event id is appended to a sibling `.markdown-collab/.events.acked.jsonl`.

`mdc-tail.mjs` reads the ack file on startup, watches it for new ids, and silently suppresses any event whose id is acked. So:

- Restarting the watch (or running with `--from-start`) no longer re-bothers Claude with batches it has already addressed.
- The events file stays append-only — both files are race-free; no in-place rewrites, no torn reads.

### Removed

- The "torn appends" gap where a tailer restarted after a long session would re-emit every historical batch.

## 0.11.4 — 2026-04-29

### Marketplace publish prerequisites

- Added MIT `LICENSE` at repo root.
- Added `repository`, `homepage`, `bugs`, `license`, and `keywords` fields to `package.json`.

These were the two `vsce` warnings blocking marketplace publish; with these in place, set `VSCE_PAT` (and optionally `OVSX_PAT`) as repo secrets, push a `v*` tag, and the existing release workflow handles the publish step.

## 0.11.3 — 2026-04-29

### Remember the Send to Claude mode after first pick

When `markdownCollab.sendMode` is `ask` (default), the first quick-pick choice is now persisted to workspace state, so subsequent clicks send straight through without prompting again. The first-success toast names the new **Markdown Collab: Reset Send Mode** command for clearing the remembered choice. The settings UI now also exposes per-option `enumDescriptions` so each transport's behavior is visible at a glance.

## 0.11.2 — 2026-04-29

### Adaptive preview layout

The preview's comments panel now becomes a slide-in drawer at narrow widths (≤900px) instead of stacking below the document. A **Comments (N)** button appears in the toolbar at narrow widths; clicking opens the drawer over the document. Click the backdrop, the X, or press Escape to close. At wide widths the panel stays pinned as before.

This fixes a regression where users with the preview docked side-by-side with the editor couldn't see the comments at all without scrolling far below the document body.

## 0.11.1 — 2026-04-29

### Fixed: channel transport delivered nothing to Claude's Monitor

`tail -f` block-buffers its stdout when run as a background bash whose stdout is a pipe (which is how Claude Code captures it), so appended lines didn't surface to `Monitor` until ~4 KB accumulated. Reported by users who saw the JSONL file growing but Claude receiving no notifications.

The skill installer now also writes `~/.claude/skills/vs-markdown-collab/mdc-tail.mjs` — a small Node tailer that:

- Watches `.markdown-collab/.events.jsonl` via `fs.watch` plus a 500ms safety poll.
- Flushes each appended line via `process.stdout.write` (per-call flush when stdout is a pipe).
- Skips existing history by default (matches `tail -n 0`); `--from-start` replays.
- Survives truncate/rotate by re-seeking to 0.

The "Channel watch loop" section of SKILL.md now instructs Claude to invoke this tailer instead of `tail -f`.

## 0.11.0 — 2026-04-29

### Send to Claude — channel transport (replaces IPC long-poll)

A new **Send to Claude** button in the preview sidebar bundles every unresolved comment on the active file and delivers them to Claude Code via one of three MCP-free transports:

- **`terminal`** — bracketed-paste injection into a running `claude` REPL with a layered detection ladder (extension-owned terminals → shell-integration evidence → name match → active terminal w/ confirmation toast) and a "spawn a new Claude terminal" fallback.
- **`channel`** — append-only `<workspace>/.markdown-collab/.events.jsonl`. Claude Code reads it via a background `tail -f` paired with the `Monitor` tool, so each click surfaces as a model notification — no polling, no HTTP server, no token, no Bash-tool 600s ceiling.
- **`clipboard`** — copies the prompt for manual paste.

The mode is selected by `markdownCollab.sendMode` (default `ask`).

### Why this replaces 0.10.0's IPC server

0.10.0 shipped a localhost long-poll HTTP server paired with an `mdc-wait.mjs` CLI. It worked but Claude Code's Bash tool caps at 600s, forcing a re-invocation loop on every timeout. The channel transport sidesteps the ceiling entirely by leaning on Claude Code's native background-bash + `Monitor` notification stream.

### Removed

- `IpcServer` (`src/transports/ipcServer.ts`) and its tests.
- `mdc-wait.mjs` from the skill installer.
- `markdownCollab.sendMode: "ipc"` enum value.

### Added

- `EventLog` (`src/transports/eventLog.ts`) — atomic line appends via `fs.appendFile`.
- "Channel watch loop" section in the bundled SKILL.md teaching Claude the `tail -f` + `Monitor` pattern.
- 5 new event-log tests covering create-on-first-append, line-per-event, ISO `ts` stamping, append-not-truncate, and concurrent-append non-tearing.

## 0.10.0 — 2026-04-28

### Added (later replaced in 0.11.0)

- Initial **Send to Claude** button in the preview sidebar.
- Three transports: `terminal` (bracketed-paste injection), `ipc` (localhost long-poll HTTP server with token-authed `mdc-wait.mjs` CLI), `clipboard`.
- `markdownCollab.sendMode` setting (`ask` | `terminal` | `ipc` | `clipboard`).
- `Markdown Collab: Send Unresolved Comments to Claude` and `Markdown Collab: Start Claude Review Terminal` commands.
- `TerminalTracker` for shell-integration-aware detection of running `claude` REPLs.

> **Note:** the `ipc` transport from this release was removed in 0.11.0 in favour of the channel transport. Users on 0.10.0 should upgrade.
