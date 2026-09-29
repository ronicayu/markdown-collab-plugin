# One view, phase A: source positions in the live editor's read-only mode

10x-plan-6 P4, migration step 3 of `docs/spike-one-view.md`. This covers read-only mode only.
Edit mode keeps today's locator (see the end).

## The flag

`markdownCollab.liveEditor.readOnly` is off by default until rendering parity lands. The host
reads it on the webview's `ready`, sends `readOnly` in `init`, and reloads the webview when it
changes. Read-only sets `editable: () => false` through `editorViewOptionsCtx` and installs the
source-position plugin below. The host ignores `edit` messages from a read-only panel.

## Positions into the ProseMirror document

Milkdown runs `remark.parse` (mdast, `position` on every node), then remark transformers, then a
schema runner per node. Hooks used: `remarkPluginsCtx`, the `$nodeSchema` slices (overridable in
`.config` before the schema is built) and `editorViewOptionsCtx`.

Per-text-node positions don't survive: `remarkLineBreak` replaces every text node holding a
newline with position-less pieces, GFM's autolink-literal transform does the same for bare URLs,
and ProseMirror text nodes have no attrs and merge across marks. So positions ride on the *text
container*, which lists its text runs:

1. **A remark plugin, prepended in `.config`**, so it registers first. It adds an mdast
   `transforms` hook, which runs inside `fromMarkdown` before GFM's while every leaf still has
   its position. On each paragraph, heading and table cell it stores
   `data.mcSrc = { start, end, runs }`. A run is one `text` or `inlineCode` leaf:
   `[srcStart, srcEnd, visibleLength, kind]`, in document order. `visibleLength` applies
   `remarkLineBreak`'s own rule (`[\t ]*\n` becomes a break node, not text). Images, HTML,
   footnote references and breaks produce no run.
2. **Schema extensions** for `paragraph`, `heading`, `table_cell` and `table_header` declare an
   `mcSrc` attr (default `null`). Each wraps the original runner: it calls it, then re-creates the
   node the runner pushed, with `mcSrc` added. None of Milkdown's logic is copied, and `toDOM`
   and the serializer ignore the attr.

Offsets index the string the webview parsed, `proseOf(source)`. The host maps prose to file
offsets with the table inlineBridge already builds.

## Inside a block: characters, not search

The webview indexes each document once. For every block with `mcSrc`, it concatenates the
block's text nodes, recording each character's ProseMirror position, splits the text by run
lengths, and aligns each run to its source slice:

- A literal character maps to `[j, j+1)`; a backslash escape to `[j, j+2)`, one unit, so a
  marker never splits `\*`.
- A character reference (`&amp;`, `&#169;`) maps each character it decodes to the whole
  reference; named ones decode via the browser's HTML parser, as micromark's browser build does.
- Line endings, trailing spaces and continuation prefixes (`>`, indentation) are skipped. A code
  span drops its fences and its one padding space; a line ending inside maps to its space.

Delimiters, link targets, image alt text and inline HTML are never inside a run, so nothing can
match them. That is the spike's wrong-occurrence class: `![not an image]` counted "image", but
the editor's text search didn't. Nothing is searched now.

**Verification:** the run lengths must sum to the block's text length, every character must
align, and only skippable source may follow the last one. Otherwise the block is *unmapped* and
nothing in it is guessed.

## Highlights (threads and suggestions)

`commentsOf` and `suggestionsOf` add `proseStart`/`proseEnd` (from `anchorsInProse`; -1 when
unanchored). The webview requires `markdown.slice(proseStart, proseEnd) === anchor.text` (a list
from another file version is skipped, not misplaced), then decorates, in each mapped block the
range touches, the characters whose span lies inside it: first to last, one decoration per block
under the same id. Suggestions share the function (`makeSuggestionHighlightPlugin` takes a placer
client.ts passes only when read-only). Anchors without markers get **no** highlight — the quote
search that would place them is what misplaced the spike's probes — and anchors inside an
unmapped block are missing, never misplaced.

## New comment: the same map in reverse

The selection's characters are trimmed of whitespace; the first one's span start and the last
one's span end give the prose range `[s, e)`. The webview refuses (a toast, before the composer
opens) a selection with no text, one touching code (the format can't anchor there), or one with a
boundary character in an unmapped block.

It posts `add-comment` with `proseStart`, `proseEnd` and `proseText` (the markdown slice). The
host's `addThreadAtProseRange` refuses if `proseOf(current).slice(s, e) !== proseText` ("the
document changed; select again"), else maps `s` → `proseToSrc[s]`, `e` → `proseToSrc[e-1] + 1`
(as `mutations.ts` does for the review view) and calls `opOpenAt` (`addThread` plus the
integrity gate). Nothing is re-serialized: the only new bytes are two markers and the thread's
record. A selection inside markup puts the markers inside the delimiters (`**<!--mc:a:x-->bold…`),
one across markup wraps it; both strip back to the same text, as in the review view.

## What can't be mapped, and how it degrades

| Case | Highlight | New comment |
|---|---|---|
| Code block, code span | none (markers in code are ignored) | refused: "inside code" |
| HTML block, image, footnote ref (no text) | nothing to decorate | only inside a wider selection |
| Block failing verification (pipeline change, U+0000) | missing | refused at a boundary in it |
| Anchor without markers | missing (listed in the sidebar) | n/a |
| Comment list from another file version | skipped until next push | host refuses a changed slice |

## Read-only drag selection

Mid-drag, the floating "+ Add comment" button appeared right of the selection end — under the
pointer. With no editing host to clamp it, Chrome extended the native selection to the button's
DOM position after the sidebar; ProseMirror ignores a selection leaving `view.dom` and kept "Su".
Fix (both modes): the button stays hidden while the primary button is held.

## Edit mode (unchanged this phase)

Edit mode keeps `locateNthOccurrence`/`locateAnchorInLiveText` for highlights and
`collectAnchors` + `placeAnchorsInProse`/`mergeProseEdit` for edits. It adds comments with
`addThreadAtOffsets`/`addThreadFromAnchor` against the serialized body. The schema extension
isn't installed there, because a split or join copies attrs, which would go stale on the first
keystroke. Step 7 (block-splice write-back) is where edit mode can adopt these positions.

## Gates (tests)

1. `readOnlyAlignment.spec.ts` (webview-e2e) runs 164 thread probes and 19 suggestion probes,
   frozen in `src/test/fixtures/alignment/probes.json` over the spike's 8 documents. Each
   highlight must match the review view's word and in-block context: 0 misplaced, 0 missing.
2. `readOnlyComment.spec.ts` (real selection, composer, host op) and `readOnlyComment.test.ts`
   (25+ host ranges per document) cover all 17 spike documents, README, CHANGELOG and two
   `docs/*.md` included. Outside the threads block the file differs by exactly the two markers;
   `stripAllInlineMarkup` is unchanged except for the blank line `withThreads` puts before a
   file's *first* threads block (the review view's add does the same).
