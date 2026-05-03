# Changelog

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
