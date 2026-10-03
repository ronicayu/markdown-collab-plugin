# Spike: one view (10x-plan-6 P4, step 1)

2026-09-29, branch `round-4`. Spike report only: no product code changed. The harness,
raw results and screenshots are in the session scratchpad; see "Reproduce".

## Verdict: go, with conditions

**Go with conditions.** In read-only mode (`editable: () => false`), Milkdown renders
the review view's fixtures with the same text, structure, tables (alignment included),
images, code and hard breaks. Most differences are small (S) fixes, and three of them
are improvements: footnotes, HTML `<img>`, and no bogus linkify. The live editor
already has the outline, line numbers, find and suggestion cards.

Two things block the switch:

1. **Comments and highlights have no source positions.** A read-only comment in the
   live editor rewrites the whole file into Milkdown's own Markdown style
   (`addThreadAtOffsets` keeps the editor's serialized body; 9–62 prose lines
   changed per comment in this spike). The text-plus-ordinal locator put 12 of 164
   probe highlights on the wrong occurrence. The review view places the same 164
   exactly.
2. **Parse → serialize is not lossless.** Only 2 of 8 fixtures round-trip with zero
   diff, and none of the 4 real docs does. The first keystroke rewrites 40–624 lines
   of a real doc, including two content losses. **Edit mode can never be the
   default** while it writes the whole serialization. As a toggle, it needs a
   write-back that splices only the edited blocks.

Separately, and first: today's live editor **deletes pending suggestions and the
review checkpoint** on any edit or comment (see "Found along the way").

## Method

- The shipped entry points (`src/webview/client.ts`, `src/inlineComments/webview/client.ts`)
  were bundled with the repo's esbuild flags into the scratch dir, not `out/`. An
  on-load patch changed the live client only to set `editable: () => !!window.__mcEditable`
  (`editorViewOptionsCtx`), allow overriding `remarkStringifyOptionsCtx`, and expose
  `serializer(doc)`.
- Both views were booted in Chromium the way `src/test/webview-e2e/harness.ts` does it,
  with init payloads from the host's own pure functions: `serialize(parse())` for the
  review view, `proseOf`/`commentsOf`/`suggestionsOf`/`frontmatterOf` for the live one.
  Drawio reads were answered from disk, and the review page loads `mermaid.min.js` as
  the panel does.
- **Fixtures (8):**
  - `src/test/fixtures/embeds.md`
  - `src/test/fixtures/roundtrip/{tables,code-and-markers,frontmatter-lists}.md`
  - `src/test/fixtures/skill/legacy-SKILL.pre-p02.md` (284 lines, the longest fixture)
  - `src/test/integration/fixtures/{sample,with-drawio}.md`
  - `reviewFixture()` from `src/test/webview-e2e/fixtures.ts` (threads plus a suggestion)
- **Assembled from spec strings (2):**
  - `html-img`, from the strings in `htmlImage.spec.ts`
  - `hard-breaks`: `docWithHardBreaks(6)` from `liveHighlightAlignment.spec.ts`
- **Missing from the repo:** no fixture has table alignment, footnotes, setext
  headings, reference links or `~~~` fences, and there is no long fixture beyond 284
  lines. Three labelled **probes** (`probe-align-footnote`, `probe-drawio`,
  `probe-syntax`) cover those. Four **real docs** stand in for long, real-world input:
  `README.md`, `CHANGELOG.md` (4,780 lines), `docs/10x-plan-6.md` and
  `docs/ux-review-2026-09.md`. These are snapshots; other agents are editing the tree.

## A. Rendering: Milkdown read-only vs the review view

| Feature | Evidence | Result |
|---|---|---|
| Headings, paragraphs, emphasis/strong (`*` and `_`), inline code | all | Same text. Spacing differs: the nord theme is tighter (S, CSS). |
| Setext headings | probe-syntax (no fixture) | Same |
| Nested ordered/bullet lists, emoji, CJK | frontmatter-lists, sample | Same structure; the marker styling differs |
| Task lists | sample | Different in both. The review view shows literal `[ ]`/`[x]` (no task plugin). The live view renders task items with **no visible checkbox**, a theme CSS gap (S). |
| Tables | tables, sample, embeds, README | Same cells. The live table is full-width (S, CSS). |
| Table alignment `:--:` | probe (no fixture) | Same; `text-align` is set on th/td in both |
| Fenced + indented code; `<!--mc:…-->` decoys in code | code-and-markers | Same; the decoys stay text in both |
| Markdown images (all 8 path forms) | embeds | Same resolved `src` (shared `imageSrc.ts`) |
| Raw HTML `<img>`, `<p align=center>` | html-img | Different. The review view shows the escaped source. **Live renders the image** (`parseHtmlImage`). `<script>` is escaped in both. |
| Other raw HTML (`<details>`, comments, `<kbd>`) | probe-syntax | Both show the source as text. Inline `<br>` **vanishes** in live. |
| Bare-domain linkify | README, plan-6, CHANGELOG | Different. The review view (`linkify: true`, `markdownPipeline.ts`) links `draw.io`, `AGENTS.md` and `guide.md` to `http://…` (14 vs 5 links in CHANGELOG). **Live is correct.** |
| Mermaid | embeds | Both draw the SVG. **Live also shows the fence source** under it (S: hide when read-only). |
| PlantUML (`plantuml`/`puml` fences) | embeds | **Not rendered in live** (plain code). The review view renders it via `src/plantumlPlugin.ts` (S: port as a widget like mermaid). |
| Draw.io, image syntax `![](x.drawio)` | embeds, probe-drawio | **Not rendered in live** (broken `<img>`). The review view takes its diagram path. |
| Draw.io, link syntax alone in a paragraph | with-drawio | Live takes its diagram path; the review view shows a plain link. S: accept both forms in both. |
| Draw.io, the actual SVG | probe-drawio, both views | **Renders in neither.** Shipped bundle too. See below. |
| Frontmatter | frontmatter-lists, legacy-skill | Different. Review hides it; live shows a read-only panel (`renderFrontmatter`). Pick one (S). |
| Footnotes `[^1]` | probe (no fixture) | Different. Review prints them literally; **live renders the reference and definition**. |
| Hard breaks | hard-breaks | Same, and the highlight below them is aligned in both |
| Long docs | legacy 284 lines, CHANGELOG 4,780 lines | Same content. First render: 43 vs 141 ms and 179 vs 756 ms (review vs live). |
| Comment highlights | 164 threads on 8 docs, placed by `addThread` at chosen source offsets (a rerun on the edited tree had 163, same result) | Review: all exact. **Live: 12 cover the right word at the wrong occurrence** (embeds 6/19, README 6/24). The ordinal counts source text (URLs like `images/…`, image alt), while the lookup counts rendered text (`locateNthOccurrence`, `src/collab/liveAnchorLocator.ts`). |
| Suggestion highlight in the text | reviewFixture | **Not shown in live** (card only). Review marks it `mc-hl--suggestion`. |
| Read-only behaviour | all | `contenteditable=false`; typing posts nothing. Selecting text shows "+ Add comment". But **a multi-step mouse drag registers a truncated selection** ("Su" for "Suggest"). This happens only when `editable` is false; a double-click or an editable view is correct. |

### Review-view-only features: porting onto a ProseMirror document

| Feature | Live editor today | Port | Size | Needs markdown-it positions (proseMapping)? |
|---|---|---|---|---|
| Outline | Present (shared `outlinePanel.ts`, `buildOutline(markdown)`) | Add active-heading sync on scroll (review: `syncOutlineActive`) | S | No; slugs from the markdown |
| Find | VS Code's native find widget (`enableFindWidget: true`, `collabEditorProvider.ts:254`) | Keep the native widget. Porting the review bar is not an option: it wraps text nodes in `<mark>` (`findRun`), which ProseMirror's DOM observer reverts. A lookalike bar would need to be rebuilt with decorations (M). | S | No |
| Line numbers | Present (`makeLineNumberPlugin`: widget decorations, top-level blocks, off on mismatch). Stayed on for 17/17 docs here. | None | S (done) | Uses `topLevelBlockLines` (markdown-it block maps), not proseMapping |
| Diff stripes, removed-text widgets, n/p nav | Absent | Node and widget decorations per top-level block via `topLevelBlockLines`, plus reuse of `diffNav.ts`. The host side must open the custom editor in diff mode (the Uncommitted tree opens `InlineCommentsPanel` today). | M | **Yes.** `paintDiffStripes` reads `data-mc-src` spans → prose lines. The top-level port stripes a whole list or table where review stripes one `li`/`tr`; matching that needs the L below. |
| Suggestion cards | Present (shared `buildSuggestionCard`, accept/reject wired) | Add the text highlight, card↔text jump and accept-all | S | Highlight placement, yes (review uses `anchorsInProse`) |
| Highlight alignment and new-comment placement | Text + ordinal locator; the comment path keeps the serialized body | Map ProseMirror positions ↔ prose offsets at parse time, then write comments through `mapProseToSource` as `mutations.ts` does. One way: align ProseMirror text nodes with the offset-annotated tokens that `renderWithOffsets.ts` already produces, the way the gutter aligns top-level blocks. Another: carry remark positions into node attrs. | **L** | **Yes; this is exactly proseMapping's job** |
| Sidebar parity | Built separately from the shared `commentUi.ts` pieces | Filters, suggest-mode toggle, n/p/r/e keys, collapse, edit comment, finalize, remove resolved, Claude summary/next-unread, skill warning | M | No |

## B. Round-trip fidelity (parse → serialize, no edits)

"Changed" counts added + removed lines from `diffLines(proseOf(src), serializer(doc))`.
"1 keystroke" is the production path: type one character in edit mode, take the
posted `edit`, run the host's `placeAnchorsInProse`, and diff the file.

| Doc | Kind | Zero diff? | Changed | File lines rewritten by 1 keystroke |
|---|---|---|---|---|
| with-drawio.md | fixture | **yes** | 0 | 1 (the edit) |
| reviewFixture() | fixture | **yes** | 0 | 2, **and the suggestion is deleted** |
| embeds.md | fixture | no | 10 | 6 |
| roundtrip/tables.md | fixture | no | 17 | 10 |
| roundtrip/code-and-markers.md | fixture | no | 4 | 4 |
| roundtrip/frontmatter-lists.md | fixture | no | 21 | 14 |
| sample.md | fixture | no | 14 | 9 |
| legacy-SKILL.pre-p02.md | fixture | no | 108 | 63 |
| html-img / hard-breaks | assembled | yes / no | 0 / 12 | 1 / 6 |
| align-footnote / drawio / syntax | probe | no / yes / no | 4 / 0 / 30 | 3 / 1 / 13 |
| README / 10x-plan-6 / ux-review / CHANGELOG | real doc | no ×4 | 153 / 66 / 109 / 1,001 | 81 / 40 / 63 / 624 |

**Zero-diff fixtures: 2 of 8** (1 of the 7 fixture files on disk); real docs: 0 of 4.

The differences, classified by peeling one normalization at a time (`peel.cjs`):

| Category | Where (changed lines) | Effect |
|---|---|---|
| List marker `-`/`+` → `*` | 9 docs; CHANGELOG 640, legacy 48, ux 34, plan-6 32 | Source churn only |
| Tight list → loose (blank line between items) | 9 docs; CHANGELOG 245, legacy 18 | **Visible**: loose lists render with paragraph spacing, on GitHub too |
| Table padding and delimiter row reflowed | 9 docs; README 118, legacy 24 | Source churn; alignment colons kept |
| Escapes added (`draw\.io`, `\~3×`, `mc\_help`, `\[verified]`); one `\'` removed | 5 docs; CHANGELOG 46, ux 24 | Renders the same |
| Strong/emphasis split around code: ``**a `b`**`` → ``**a** **`b`**`` | 5 docs; CHANGELOG 40, legacy 16 | Renders nearly the same |
| Emphasis `*` vs `_` | none | Kept: Milkdown stores the marker (probe `_em_`, `__strong__`) |
| Heading style, setext → ATX | probe only | Source churn |
| Hard break, two spaces → `\` | hard-breaks 12 | Renders the same |
| Code fences: `~~~` → backticks, indented → fenced | probe; code-and-markers 4 | Source churn |
| Ordered `1)` → `1.`, next list flips to `)` | probe 8 | Source churn |
| Thematic break `---` → `***`; bare URL → `<url>` | ux 4; sample 2 | Source churn |
| Reference links inlined, definitions deleted | probe | **Structure lost** |
| Inline `<br>` deleted; spaces around a multi-backtick code span dropped (CHANGELOG ~3251) | probe; CHANGELOG | **Content lost** |
| HTML blocks, comments, `<img>`, `<script>` | html-img, probe | Pass through unchanged |
| Frontmatter | all | Never enters Milkdown; re-prepended by `frontmatterOf`. Unchanged everywhere. |
| `<!--mc:…-->` markers | reviewFixture, hard-breaks | Never enter Milkdown (`proseOf`). Thread markers come back at the positions the editor reports (2/2, 1/1). **Suggestion anchors, `mc:s` records and the review checkpoint are dropped.** |

Tuning remark-stringify (`bullet: "-"`, `rule: "-"`) cut CHANGELOG from 1,001 to 365
changed lines. It made no additional fixture clean, and the probe's `+` bullets and
`***` rule now change instead. Global options can't match per-document conventions.

**Does the existing machinery make this harmless? For threads yes; for the document
no.** "Prose against prose" is the Uncommitted-diff code (`src/uncommitted/proseDiff.ts`),
not the live editor. The live editor protects itself in four ways:

- **`proseOf`/`frontmatterOf` keep markers, the threads region and frontmatter away
  from Milkdown** (`inlineBridge.ts`).
- **The `lastWebviewProse` echo guard** (`collabEditorProvider.ts:298`) stops
  normalize/push loops, so merely opening a file writes nothing. No `edit` was posted
  on open for 17 of 17 docs.
- **A no-op check**, `proseOf(current) === newProse` (`:417`).
- **`placeAnchorsInProse`** re-places thread markers at decoration positions.

None of this restores bytes the user didn't touch. `newProse` is the whole
serialization, and so is `msg.fullMd` in `addComment` (`:677` → `addThreadAtOffsets`).

That answers open question 4. **Yes: the live editor changes Markdown you didn't touch,
on the first keystroke and on every comment**, unless the file is already in Milkdown's
style. In a merged view, the Uncommitted tree's diff would also stripe every block the
normalization touched.

## Found along the way (independent of the merge; fix now)

1. **Data loss: live edits and live comments delete pending suggestions and the
   review checkpoint.** `assembleMarkedSource` (`inlineBridge.ts:732`) and
   `addThreadAtOffsets` call `withThreads(frontmatter + body, threads)` with no
   suggestions. `withThreads` then keeps whatever suggestions it parses from that new
   string, which has none, and likewise drops the checkpoint. Reproduced with the
   host functions: before {2 threads, 1 suggestion, checkpoint}; after a one-character
   edit {2, **0**, **none**}; after add-comment {3, **0**, **none**}. No test runs
   these write paths with a suggestion or checkpoint present. The fix is S–M:
   re-place suggestion anchors like thread anchors, and pass suggestions and the
   checkpoint through.
2. **Draw.io renders in neither view.** Both shipped bundles (`out/webview/client.js`,
   `out/inlineComments/client.js`) start with `"use strict"`. mxgraph's factory does `this[name] = opts[name]`, and `loadMx`
   (`src/webview/drawioRenderer.ts:60`) calls `fn({...})` with no receiver, so both
   views print "Failed to load drawio renderer: Cannot set properties of undefined
   (setting 'mxBasePath')". This was reproduced against the shipped bundle. Likely
   fix: `fn.call(globalThis, {...})`. The integration test only checks the
   `drawio-read` round-trip.
3. **Read-only selection lag.** See A. Commenting after a normal mouse drag in a
   non-editable view anchors a prefix of the selection.
4. **Bogus linkify in the review view** (`AGENTS.md` → `http://AGENTS.md`). If the
   review view survives, set `md.linkify.set({ fuzzyLink: false })`.

## If go: migration order

Each step ships behind the read-only default and has a gate drawn from this spike's
harness.

1. **Fix items 1–3 above.** Gate: a one-character edit and an add-comment keep
   suggestions and the checkpoint; the drawio SVG renders.
2. **Read-only toggle** in the live editor (`editorViewOptionsCtx`), on by default.
3. **Position-based anchoring (L).** ProseMirror ↔ prose-offset map; comments written
   through `mapProseToSource`; highlights placed by offset. Gates: 0 of 164 probe
   highlights misplaced; an add-comment changes 0 prose lines. This step is the go/no-go
   inside the go.
4. **Rendering parity (S each):**
   - PlantUML widget
   - both draw.io syntaxes
   - hide the mermaid source when read-only
   - suggestion highlight
   - task checkbox, table and spacing CSS
   - one frontmatter decision
5. **Sidebar parity (M):** bring the review view's sidebar behaviours to the live
   editor. Both are built from `commentUi.ts`.
6. **Diff overlay (M):** stripes, removed widgets and n/p as decorations; the
   Uncommitted tree opens the merged view.
7. **Edit toggle with block-splice write-back (M–L).** Top-level blocks whose node is
   unchanged keep their original source bytes. Only changed blocks are re-serialized
   and spliced in by `topLevelBlockLines` ranges, and markers inside them are re-placed.
   Gate: the round-trip corpus here shows zero changed lines outside the edited block.
   Normalization inside an edited block remains; for example, editing one cell
   re-pads the whole table.
8. **Retire the markdown-it review view for `.md`** and drop the "frozen" rule (P4.3).
   The PR review view (`src/pr/**`) and `markdownPipeline.ts` stay, since PR review
   still renders with markdown-it. Then answer open question 3 (default editor).

## The alternative: add editing to the markdown-it view

Rich-text editing on the markdown-it output means building an editor: selection and
IME handling, undo, list and table editing, and a serializer back to Markdown. That
serializer is where the same normalization would come back. That version is a no-go.

The version that *is* affordable is **block source editing**. Click a block, edit its
Markdown source (the unused `@codemirror/*` dev dependencies would do), then splice
exactly those bytes back and re-render. The review view already knows every block's
source range, so the result is byte-exact: no normalization, ever. Alignment stays on
proseMapping, and Milkdown, `liveAnchorLocator` and the live comment path can be
deleted. Cost is roughly M.

The price is that editing stops being WYSIWYG. It is cheaper and safer than steps 3
and 7 above combined, and it changes what "editing" means for someone who opens the
live editor by hand today. That trade is Ronica's to make. The spike data does not
decide it.

## Reproduce

In `/private/tmp/claude-501/-Users-ronica-projects/3f8a3a08-8890-5207-a466-ac84d3be4661/scratchpad/one-view/`:
`node build.mjs` bundles the entry points (live one patched as above), the driver and
`dropcheck`; `node out/driver.cjs render|roundtrip|interact|align|lines` runs one pass
(`STRINGIFY='{"bullet":"-"}' TAG=tuned` for a tuned round-trip); `node peel.cjs <tag>`
classifies the diffs; `node shipped-drawio-check.cjs` and `node out/dropcheck.cjs` rerun
the two bug checks. Screenshots: `shots/`, side by side in `sbs/`; raw diffs:
`results/rt/<tag>/`.
