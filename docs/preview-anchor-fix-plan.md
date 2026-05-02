# Comment-on-preview, fixed end-to-end

Two halves of the same problem:

1. **Creation (DOM → source).** Selecting rendered text that crosses
   block boundaries (heading + paragraph, multi-line blockquote,
   multi-heading) fails to map back to a source range, so the comment
   can't be created.
2. **Highlighting (source → rendered HTML).** Mapping a saved source
   range back into the freshly rendered HTML is fragile —
   `renderInline(slice)` loses env (reference links / footnotes
   unresolved), produces no block tags, and doesn't apply linkify on
   partial URLs, so `wrapFirstOutsideTags` finds nothing to wrap.

This plan fixes both with the simplest mechanism each half deserves.

---

## Half 1 — Creation: extend the tolerant separator

`locateSelectionInSource` (`src/previewPanel.ts:1194-1254`) has three
tiers; the third is a tolerant regex with separator class
`[\s|*_~`\-]+` between tokens. It covers tables (`|`), emphasis (`*` `_`
`~`), code (`` ` ``), and list bullets (`-`). It misses `#` and `>`.

| Selection (DOM)             | Source                              | Today | After fix |
|-----------------------------|-------------------------------------|-------|-----------|
| `Heading\nBody`             | `# Heading\n\nBody`                 | ✅    | ✅        |
| `Header 1\nHeader 2\nbody`  | `# Header 1\n\n## Header 2\n\nbody` | ❌    | ✅        |
| `quoted more\nplain`        | `> quoted\n> more\n\nplain`         | ❌    | ✅        |
| `Item 1\nItem 2`            | `- Item 1\n- Item 2`                | ✅    | ✅        |

**Change** (one line):

```ts
// previewPanel.ts:1242
const sep = /[\s|*_~`\-#>]+/.source;
```

Risk-free: `#` and `>` only carry block-syntax meaning at line start.
Including them in the separator class only allows the regex to bridge
runs of whitespace + these characters between selected tokens, never
inside a token.

If more cases surface later (multi-block selections that also include
ref-link syntax `[…](…)`, footnote markers `[^…]`, etc.) the follow-up
is a **visible-text projection of source**: walk `md.parse(source, env)`
tokens, emit only text content with an offset map back to source, then
match in that flat visible space. Same idea as the DOM side; same
algorithm, just over tokens.

---

## Half 2 — Highlighting: ride markdown-it's parser via source markers

Stop reverse-engineering the rendered HTML. Inject invisible markers
into the source markdown around each comment's range, render once, then
swap markers for span tags.

```
patched = injectMarkers(source, comments)   // local string
html    = md.render(patched, env)            // markdown-it does its thing
output  = replaceMarkers(html)               //  → <span...>,  → </span>
```

Markers ride through the parser as ordinary text characters, so every
markdown-it transformation (reference resolution, linkify, footnotes,
emphasis, lists, tables, blockquotes) is applied for free. No
`renderInline(slice)`, no needle search, no `wrapFirstOutsideTags`, no
skip count.

### Markers

Pick two characters per comment from the Unicode Private Use Area
(U+E000–U+F8FF). PUA is reserved for private use, never appears in
real markdown content, and we replace markers with span tags before the
HTML reaches the browser — so they're invisible end-to-end.

(HTML comments `<!-- … -->` are tempting but `html: false` escapes them
to `&lt;!-- … --&gt;`, which would render as visible junk. Switching to
`html: true` would also expose user-authored HTML, a behavior /
security change beyond this scope. PUA is the smaller change. If we
later want self-documenting markers, a 10-line custom inline rule can
let one specific HTML-comment pattern through without flipping the
global option.)

### Two boundary cases, both small

**a) Marker at column 0 changes block parsing.**
`- item` is a list; `- item` is a paragraph. Same for `# ` and
`> `. Fix: when a comment's `start` lands at column 0, advance it past
any leading whitespace, list markers (`- `, `* `, `+ `, `1. `),
blockquote `> `, and ATX `#` runs before injecting. The user's anchor
is over visible content anyway — pushing past block syntax doesn't
change what gets highlighted.

**b) Marker pair spans block boundaries.**
After render, the slice between an open and its close may contain
`</p>`, `</li>`, `</td>`, `</h1-6>`. Naive replacement yields a span
that crosses the block close — browsers either auto-fix
unpredictably or leave half the highlight broken. Fix: one regex pass
over the slice, inserting `</span>` before each block-close and a fresh
`<span class=mdc-anchor data-comment-id=…>` after the next block-open.
All resulting fragments share `data-comment-id`, and the existing
`.mdc-anchor` CSS already styles each fragment — visually one
highlight.

### Multiple comments, no offset shift

Sort comments by `start` descending; insert open/close markers in
reverse order. Earlier insertions never disturb later offsets.
Skip-count math (currently in `previewPanel.ts:912-924`) goes away —
markers are unique per comment, no disambiguation needed.

### Markers never leave the renderer

Marker injection mutates a **local string variable** inside
`renderBodyWithHighlights` that is passed to `md.render(...)` and then
discarded.

| Surface                            | What it sees             |
|------------------------------------|--------------------------|
| `Read` tool / filesystem           | File on disk, untouched  |
| `doc.getText()` / editor buffer    | Buffer, untouched        |
| Sidecar `Anchor.text` etc.         | Built from clean source  |
| `Send to Claude` payload           | Reads sidecar, clean     |
| Webview `payload.text` (selection) | `readDocText()`, clean   |
| Rendered HTML in webview           | Markers already replaced |

Nothing on disk, in memory beyond the function call, or in any payload
retains the markers.

---

## Files

- **`src/previewPanel.ts`**
  - `locateSelectionInSource:1242` — extend separator class to include
    `#` and `>`.
  - `renderBodyWithHighlights:893` — replace the body with the marker
    pipeline. Frontmatter handling stays. Pass a single `env` to
    `md.render` so reference rules populate it (free side-benefit).
  - New helpers (small, focused, exported for tests):
    - `pickMarkerPair(commentIndex) → [openChar, closeChar]`
    - `safeStart(text, offset) → adjustedOffset` (column-0 advance)
    - `injectMarkers(source, ranges) → patchedSource`
    - `splitSpansAtBlockBoundaries(html) → finalHtml` (the regex pass)
  - Delete `wrapFirstOutsideTags`, `isInsideTag`, `allIndexes`, the
    skip-count loop, the `renderInline(slice)` call. (Keep `collapseWs`
    if `locateSelectionInSource` still uses it for the WS-normalized
    tier — it does.)

- **`src/test/previewPanel.test.ts`**
  - Tolerant separator: regression cases for multi-heading and
    multi-line-blockquote selections.
  - Marker pipeline: round-trip on a flat paragraph; reference link
    resolves; block-spanning paragraphs split into multiple fragments;
    list items; table rows; markers at column 0 advance past `- `,
    `# `, `> `, `1. `; comment-id collision is impossible (asserts on
    distinct PUA pairs).
  - Drop `wrapFirstOutsideTags` / `isInsideTag` test blocks (helpers
    gone).

## What stays unchanged

- Sidecar schema. `Anchor` shape unchanged.
- Source-side anchor resolution (`src/anchor.ts:resolve`) — same code,
  used by the editor gutter and by the preview to compute the
  `[start, end]` ranges that the marker pipeline injects.
- Editor gutter behavior, orphan view, "Send to Claude" flow.

## Out of scope

- Frontmatter highlights (rendered separately; pre-existing limitation).
- Overlapping comment ranges that partially intersect (nested ranges
  are fine; partial overlap produces tag soup — same caveat as today).
- Visible-text projection of source for creation — listed above as a
  follow-up if Half 1's regex extension proves insufficient.

## Verification

1. `npm test` — new tests pass; existing tests still pass.
2. `npm run watch` + Extension Development Host:
   - **Creation across blocks**: select text spanning a heading +
     paragraph + another heading; comment is created with anchor
     resolving inside source. Same for a multi-line blockquote.
   - **Highlight across blocks**: comment whose anchor crosses a
     paragraph break; both halves highlighted.
   - **Highlight reference link**: comment on `[my doc][doc-ref]`;
     highlighted on the rendered `<a>`.
   - **Highlight footnote**: comment on `text[^1]`; highlighted.
   - **Highlight at line start**: anchor whose `start` is column 0 of a
     list item / heading / blockquote — highlight starts at the visible
     content, no broken block structure.
   - **Existing simple cases** (single paragraph, table cell, repeated
     phrase) continue to highlight in the right place.
   - **Inspect HTML** via the preview's developer tools — span
     structure is balanced, no rogue tag soup.
