# One view, phase A: source positions in the live editor's read-only mode

10x-plan-6 P4, migration step 3 of `docs/spike-one-view.md`. This covers read-only mode only.
Edit mode keeps today's locator (see the end).

## The flag

`markdownCollab.liveEditor.readOnly` is on by default since phase B (0.35.16); it only seeds the
mode a new panel opens in, and the sidebar's Edit switch flips a panel's mode through
`set-read-only` without touching the setting (see "Phase B: edit mode" below). The host sends
`readOnly` in every `init`. Read-only sets `editable: () => false` through `editorViewOptionsCtx`
and installs the source-position plugin below. The host ignores `edit` and `edit-blocks` messages
from a read-only panel.

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

## Edit mode (unchanged this phase; its edits are phase B's since)

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

## Phase B: edit mode

Step 7 of the spike. Principle: a keystroke may only change the bytes of the top-level block it
happened in. Nothing is ever written from a whole-document serialization.

**The table (host).** `markdownBlocks(prose)` (`sourcePositions.ts`) parses with milkdown's
parser (`mdast-util-from-markdown` + GFM) and lists the root's children as `{start, end, type}`,
`type` being the ProseMirror node milkdown makes of it; updated after every write (below).

**Correspondence with the top-level ProseMirror nodes** (milkdown 7.20's transformers, read):
1:1 for paragraph, heading (ATX or setext), code (fenced or indented), blockquote, list
(bullet/ordered), table, thematic break (`hr`), footnote definition, and root `html`, which
`remarkHtmlTransformer` wraps in a paragraph. What breaks it: `definition` (remark-inline-links
deletes it, so it has no entry); a `<br />` html block, which `remarkPreserveEmptyLine` turns into
an *empty* paragraph — milkdown's placeholder. `createAndFill` adds one to an empty document and
Enter at the end leaves one; the serializer writes a placeholder as `<br />` except the
document's last, which it writes as nothing. So neither side counts a trailing one. Frontmatter,
markers and the threads region never reach either side (`proseOf`). Plugins that rewrite nodes
nobody edited (heading ids, list labels, table-cell alignment) touch attrs the serializer
ignores. Detection of anything not listed: each edit carries the base document's type list,
which must equal the table's.

**Webview.** It keeps `editBaseDoc`, the document as last parsed or posted. ProseMirror rebuilds
exactly the top-level nodes a step touches and shares the rest by reference, so after the edit
debounce, identity against the base (longest increasing run of shared nodes) says which top-level
nodes the transactions touched — across several transactions, undo, or a node dragged elsewhere.
Each unmatched run is a change `{from, to, markdown, types}`: base indices, the new nodes
serialized together, their types. Runs of equal length are split pair by pair; a pair that
serializes identically is no change. A split (Enter mid-paragraph) or merge (Backspace at a block
start) is an unequal run, so one splice over the union. Posted as `edit-blocks` with an `epoch`.

**Host.** Stale epoch (a re-render crossed the edit): dropped. Each change's prose range
`[start(from), end(to-1))` becomes a source range widened over markers glued to its edges; a
deletion takes the separator before it, an insertion adds `\n\n`. Anchors with both markers in
the range are re-placed in the new text: first by a token diff of the block (words the edit and
the serializer's normalization left alone map exactly — `**a `b` c**` becoming
`**a** **`b`** **c**` moves them), then by `reanchorThreadByText` on block-local strings, else
dropped (unanchored). Nested anchors stay nested. An anchor crossing the edge keeps its outside
marker and maps the inside one; a marker-less thread whose quote is unique and lands in the
block is recovered (undo). A list replaced 1:1 keeps its marker (`-`, `+`, `1)`): the
serializer's `*` or `1.` would merge it with an adjacent list using that marker. Bytes outside
the ranges — frontmatter, threads region, other blocks — are untouched; the write is a range edit.

**After the splice** the host re-parses from the block before to the block after. Block parsing
runs left to right and the window starts fresh at an unchanged block, so if it reproduces both
neighbours and the sent types, the table is updated in place. Otherwise a full parse decides; if
the types still differ (the text merged with a neighbour, an unclosed fence swallowed the rest)
the write stands and the editor re-renders.

**Refusals** (no write; the editor re-reads the file, a toast says why): base types differ from
the table, a bad index, a range reaching frontmatter or threads, `<!--mc:` outside code.

**Mode toggle.** On `set-read-only` the host flips the panel's mode (the setting only seeds new
panels), waits for queued edits and re-sends `init`; the webview rebuilds just the editor,
read-only with the source-position schema or edit without it. A read-only panel's edits are ignored.

**Gate** (`blockSplice.spec.ts`, 17 documents, a thread in every block with a word): one character
typed at the end of each of 1,596 top-level blocks (a rule is selected and typed over) through the
bundle's diff and the host splice: every line outside the block, the threads region and
`stripAllInlineMarkup` outside it unchanged, no anchor lost. 0 failures, none excluded.
