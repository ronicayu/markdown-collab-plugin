# PR review view — same language as the Markdown Collab sidebar (0.35.21)

The PR review webview (`src/pr/webview/client.ts`, shell in
`src/pr/prReviewShell.ts`) kept its own chrome when the comment sidebar was
redesigned (`docs/sidebar-chrome-redesign.md`): two titled sections, pill
filter chips, an "↗ Open" link under every comment, Reply as a link at the
bottom of each thread, a four-row submit bar. This brings it to the same
structure and the same stylesheets.

Decided with Ronica on 2026-09-30, from mockups:

1. **Drafts are pinned on top** of the list, whatever tab is selected.
2. **The Open tab is the default.** Resolved threads are behind their tab.
3. **Submit area:** verdict always visible as a segmented control, one button
   that says what it does, summary behind "Add summary".
4. **No approving without drafts.** Submitting still needs at least one
   draft; the submit area is hidden until there is one. No host change.
5. **One open link per thread**, not one per comment.

## Principles carried over

Document controls with the document, comment controls with the comments.
One primary action per region. Nothing shown for zero. Three control kinds
(ghost icon button, segmented control, primary button) plus quiet text
buttons inside cards. No class-less `<button>` in the sidebar.

## Shared, not copied

The PR sidebar uses the **same class names and the same stylesheets** as the
Markdown Collab sidebar, so the two cannot drift again:

- `src/pr/webview/client.ts` imports `../../webviewShared/threadSidebar.css`
  and `../../webviewShared/controls.css` (check how the PR bundle's CSS is
  emitted and that both reach `out/pr/webview/client.css`).
- `#drafts-pane` gets the class `mc-thread-sidebar`. Its header is
  `<header id="threads-header">` and its scrolling list is
  `<div id="threads-list" role="feed">` — the ids `threadSidebar.css` is
  keyed on (a different webview document, so no clash).
- Cards are `section.thread-card` with `header.thread-head` >
  `.thread-head-row` + `.thread-actions`, built with `buildCollapseToggle`,
  `buildCommentCard`, `buildComposer`, `buildCommentBody` from
  `webviewShared/commentUi.ts`.
- The "…" menu logic (one open at a time, Escape returns focus to the
  trigger, outside click closes) moves out of `threadSidebar.ts` into
  `src/webviewShared/menu.ts` (`createMenuController()` exposing
  `toggleMenuAt`, `closeOpenMenu`, `buildMenuItem`), used by both sidebars.
  Behaviour in the live sidebar must not change; its menu e2e stays green
  untouched.
- `src/pr/webview/client.css` keeps the preview's rules and loses every
  sidebar rule the shared sheets replace (`#drafts-header`, `.filter-chip`,
  `.existing-card*`, `.existing-head*`, `.existing-gist`, `.existing-reply`,
  `#submit-bar …`, `button.btn-link` / `button.btn-ghost` once unused).
  Grep before removing each rule.

PR-only hooks are prefixed `pr-` (`pr-draft`, `pr-jump`, `pr-line`,
`pr-open`, `pr-resolve`, `pr-submit`). The old `existing-*` / `draft-line`
class names go; ids named below stay.

## Layout

```
┌ preview ───────────────────────────────────────┬ #drafts-pane.mc-thread-sidebar ┐
│ [↑] 4 changes [↓]                          [💬] │ Comments                 [+] [⋯]│
│  1  Rollout plan                               │ Open 2   All 3   Resolved 1     │
│  3 ▌We ship the new parser behind…          💬 │ (composer slot)                 │
│                                                │ ┌╌ draft card (pinned) ╌╌╌╌╌╌╌╌┐│
│                                                │ ┌ thread card ────────────────┐│
│                                                │ └─────────────────────────────┘│
│                                                │ ───────────────────────────────│
│                                                │ [Comment|Approve|Request chgs] │
│                                                │ Add summary  [Submit 1 comment]│
└────────────────────────────────────────────────┴────────────────────────────────┘
```

### Preview toolbar — `#preview-toolbar`

Looks like the live editor's `.mdc-doc-toolbar` (34 px, bottom border, editor
background). Keep its current sticky mechanics; restyle only.

- **Left:** `#diff-nav` — `#diff-prev` and `#diff-next` become
  `mc-icon-btn` with arrow SVGs (aria-labels and titles unchanged),
  `#diff-nav-count` between them. Hidden when there are no changes, as today.
- **Right:** `#comments-toggle` — `mc-icon-btn`, speech-bubble SVG,
  `aria-pressed` = sidebar visible, `aria-controls="drafts-pane"`,
  label/title "Hide comments" / "Show comments". Hiding sets
  `#app.sidebar-collapsed` (grid column 0, pane `display: none`). While
  hidden, a `.mc-badge.mc-badge--count` on the button shows the number of
  open threads. Persist the collapsed flag the same way the live editor
  does (or doesn't) — mirror it.

### Sidebar header — `#threads-header`, two rows

- **`.title-row`:** `<h2>Comments</h2>`; `.mc-title-actions` with
  - `#add-comment-btn` — `mc-icon-btn`, plus SVG, `aria-label="Comment on
    selection"`. Same action as `#floating-add`. `mousedown` must
    `preventDefault` so the click does not clear the preview selection. With
    no usable selection, do what the live editor's + does in the same
    situation (read `openComposerForCurrentSelection` in
    `src/webview/client.ts`) using this view's own mechanisms.
  - `#overflow-menu-btn` "⋯" + `#overflow-menu` holding `#collapse-all-btn`
    (`role="menuitem"`, `mc-menuitem`, label toggles "Collapse all" /
    "Expand all", disabled with no cards).
- **`#existing-filter.filter-row`:** `role="radiogroup"`, native radios
  `name="existing-filter"` in `label.segment` (the live sidebar's DOM), in
  the order **Open · All · Resolved**, each with `<span class="count">`.
  Counts are existing threads only. Hidden when there are no existing
  threads. Default `open`; a saved `existingFilter` is honoured. The old
  rule that forced "all" when nothing was resolved goes.
- `#draft-count`, the "Drafts" / "Existing comments" headings and the
  "Click a draft to jump to its line." hint are removed.

### Composer slot — `#composer`

Directly under the header, above the list (as in the live sidebar). Behaviour
unchanged.

### List — `#threads-list`

In order: `#drafts-list` (this file's drafts, by line), `#existing-status`
(`p.empty`), `#existing-list` (threads passing the tab filter, by line).
Drafts are never filtered.

**Card head (`.thread-head-row`), both kinds:**
`button.thread-quote.pr-jump` (title "Jump to this line in the preview",
scrolls the preview) whose text is the commented line as the reader sees it
— the rendered block's text without the marker button, falling back to the
raw source line, falling back to `Line N` when the line is gone · badge
(`mc-badge mc-badge--draft` "draft", or `mc-badge mc-badge--resolved`
"resolved") · `.thread-comment-count` ("2 comments", visible collapsed, as
in the live sidebar) · `span.pr-line` (`L3`, or `L3–5` for a range) · `buildCollapseToggle`
chevron (`.thread-collapse`, carries `aria-expanded`; last, at the right
edge, pointing left when collapsed).
Expanded, the quote clamps to two lines; collapsed, to one with an ellipsis.
Collapsed, a click anywhere on the head expands (live behaviour). The card's
`aria-label` is "author: gist", as the live sidebar does.

**Thread card — `section.thread-card[data-thread-id]`** (+ `.resolved`,
`.collapsed`):

- `.thread-actions`: `Reply` (`mc-btn mc-btn--quiet thread-reply-toggle`,
  `aria-expanded`) · `Resolve` / `Unresolve` (`mc-btn mc-btn--quiet
  pr-resolve`, only when `resolvable && resolveId`; busy labels and
  `resolve-thread` message unchanged; the platform's word "Unresolve" is
  kept on purpose) · at the row's end **`button.mc-icon-btn.pr-open`**,
  external-link SVG, `aria-label`/title "Open this thread in the browser",
  opening the head comment's `url` exactly as the per-comment link did.
- Comments as flat `buildCommentCard`s (no `reply` indent), **with no
  per-comment actions** — the per-comment "↗ Open" is gone.
- `.reply-box`: the composer opened by Reply, below the comments; Cancel
  (quiet) or the Reply toggle closes it. `reply` message, busy and error
  handling unchanged.

**Draft card — `section.thread-card.pr-draft[data-draft-id]`**, dashed
border: head as above with the `draft` badge; one comment card, author
"You", with `Edit` / `Delete`; editing swaps the body for the composer as
today. No `.thread-actions` row.

**Empty / status:**

- existing comments still loading and no drafts: `#existing-status` =
  "Loading comments…";
- no drafts and no threads: a `.mc-empty-state` with headline "No comments
  on this file yet." and hint "Select text in the preview, then click + to
  draft a comment." No button;
- threads exist but the tab hides them all: `#existing-status` = "No open
  comments on this file." / "No resolved comments on this file." (today's
  strings).

### Footer — `#submit-bar.mc-sidebar-footer.pr-submit`

`hidden` while `totalDraftCount === 0`.

- `.verdict-row.mc-segmented`, `role="radiogroup"`, `aria-label="Review
  verdict"`: the three existing `input[name="verdict"]` radios in
  `label.segment` (+ `.active` on the checked one), stretched to the row.
- `#review-body`: hidden until `#summary-toggle` ("Add summary",
  `mc-btn mc-btn--quiet`) is clicked, which shows and focuses it and hides
  the toggle. Emptied and blurred, it collapses again and the toggle
  returns — so a non-empty summary is never hidden.
- `#submit-review` (`mc-btn mc-btn--primary`, fills the row beside the
  toggle). Label, N = `totalDraftCount`:
  `Submit N comment(s)` · `Approve with N comment(s)` · `Request changes
  with N comment(s)`. `submit` message unchanged.
- `#submit-hint`: shown only when drafts exist on other files —
  "N on this file · M on other files". Hidden otherwise.

### Floating button — `#floating-add`

Same look as the live editor's selection button (`.mdc-add-comment-btn`):
compare the two and align this one. Behaviour unchanged.

## Unchanged on purpose

Preview rendering, line numbers, change stripes, `.pr-comment-marker`s and
what they jump to, `n`/`p`, every message the webview posts and receives,
collapse persistence (`collapsedCardIds`), resolved threads starting
collapsed, the host (`prReviewPanel.ts`, `prReviewController.ts`).

## Tests — migrate, then add

`prReview.spec.ts` and anything else that touches the PR shell or its class
names is migrated to the new DOM — never deleted to pass. New cases:

- a thread with three comments renders exactly one `.pr-open`, no button
  inside any comment card, and clicking it opens the head comment's URL;
- tabs: default Open with no saved state; counts; a saved filter is
  honoured; the row is hidden with no threads; radios move with arrow keys;
- a draft stays above the threads on every tab;
- footer: hidden at zero drafts; the three labels; singular/plural; the
  summary toggle (shows, focuses, collapses when emptied, never hides
  text); hint only with drafts on other files;
- comments toggle collapses the pane, shows the open-thread badge, restores;
- ⋯ → Collapse all / Expand all; Escape returns focus;
- the quote jumps to the line; the range label reads `L3–5`;
- `#add-comment-btn` opens the composer for the current selection;
- no class-less `<button>` inside `#drafts-pane` with a draft in edit mode,
  a thread with an open reply composer and a resolved thread on screen.

Gates: `npm run compile`, both `tsc` checks, `npx vitest run`,
`npx playwright test`.

## As built

- A draft being edited keeps its card frame, quote and `draft` badge; the
  composer replaces only the body. The author label is "You" in both states.
- `#add-comment-btn` with no selection shows a short toast ("No text is
  selected. Select some text in the preview first."), the counterpart of the
  live editor's notice.
- The collapsed-sidebar flag is not persisted, as in the live editor.
  Clicking a line marker while the sidebar is hidden brings it back, so the
  card it jumps to is never invisible.
- The shared sheet gives thread cards a pointer cursor and an accent border
  on hover because the live sidebar's cards are clickable. Here only the
  controls inside a card act, so the PR sheet neutralises both.
- For a range, the quote is the first line's text; the label carries the
  range (`L3–5`).
- The PR bundle's stylesheet is now emitted by esbuild from the client's
  CSS imports (`bundle:pr-review` no longer copies `client.css` by hand).
- Menu items in both sidebars get `cursor: pointer`, lost when the sidebar's
  generic `button` rule was removed in 0.35.20.

## Out of scope

Approving with no drafts (decision 4). The line markers' look. The classic
review view.
