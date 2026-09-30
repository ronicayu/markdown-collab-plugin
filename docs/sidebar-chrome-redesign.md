# Sidebar chrome redesign (0.35.19)

The live editor's comment sidebar header, as shipped in 0.35.18, at its
default 360 px width:

```
Comments                     0 open · 0 total   [☰] [+]
[ Open | All | Resolved ]
[Send to Claude]  Suggest mode (o)
[ Reading | Editing ]                        [ … ]  ?
n / p to move between threads · r reply · e resolve · o open in editor
──────────────────────────────────────────────────────
(list)
```

## What is wrong

1. **Five rows before the first comment.** ~190 px of chrome in a pane whose
   content is the list. The actions row is wider than the sidebar, so it
   wraps and the mode control lands on its own line.
2. **Document controls inside the comments panel.** Outline (☰) and
   Reading/Editing act on the document, not the comments. They also vanish
   when the sidebar is collapsed — there is then no way to switch mode.
3. **Two identical segmented controls with unrelated jobs.** The filter
   (changes the list) and the mode switch (reloads the editor) look the same.
4. **Four button styles in one header.** Bordered icon button (☰), blue icon
   button (+), blue text button (Send), borderless "…", bare "?" glyph.
5. **Suggest mode has permanent real estate** for a setting that is off by
   default and rarely flipped. Copy prompt, its sibling, is hidden in "…".
6. **A permanent shortcut line** competes with the content until a key is
   pressed.
7. **Zero shown as zero.** "0 open · 0 total" and a filter row with nothing
   to filter, above an empty-state card that repeats the same fact.

## Principles

- **Document controls live with the document. Comment controls live with the
  comments.**
- **One primary action per region.** The sidebar's is Send. Everything about
  *how* it sends hangs off Send.
- **Header is at most two rows.** Contextual rows (Claude summary, skill
  warning, first-run shortcut hint) appear only when they have something to
  say.
- **Nothing is shown for zero.** No counts, filters or Send when there are no
  threads to count, filter or send.
- **One visual language.** Three control kinds only: ghost icon button,
  segmented control, primary button. Same height (24 px), radius
  (`--mdc-radius`, 4 px), font size (12 px).

## Layout

```
┌ editor pane ─────────────────────────────────────┬ sidebar (360) ─────────────────┐
│ [☰]                    [ Reading | Editing ] [💬] │ Comments                 [+] [⋯]│
│ (change-nav, when a diff is showing)             │ Open 3   All 5   Resolved 2    │
│ (frontmatter)                                    │ ────────────────────────────── │
│ document…                                        │ (claude summary / skill warn)  │
│                                                  │ (shortcut hint, first run)     │
│                                                  │ thread cards…                  │
│                                                  │                                │
│                                                  │ ────────────────────────────── │
│                                                  │ [ Send 3 comments to Claude ][▾]│
└──────────────────────────────────────────────────┴────────────────────────────────┘
```

### Document toolbar — new, `.mdc-doc-toolbar`

In `.mdc-editor-pane`, above the change-nav, and it never scrolls with the
document (the pane's padding moves to an inner wrapper so the toolbar spans
the pane's full width). 34 px tall, bottom border
`--vscode-panel-border`, background `--vscode-editor-background`.

- **Left:** Outline toggle — ghost icon button, `data-action="toggle-outline"`,
  `aria-pressed`, `aria-label="Outline"`. Same behaviour as today's ☰, moved
  from the sidebar title row.
- **Right, in order:**
  - `#edit-mode-toggle` — the existing Reading/Editing radiogroup, DOM, ids
    and radio names unchanged, moved out of the sidebar's `SHELL` into the
    toolbar. Posts `set-read-only` as today. Its `title` stays.
  - Comments toggle — ghost icon button replacing the floating
    `.mdc-sidebar-toggle`. Speech-bubble SVG, `aria-pressed` = sidebar
    visible, `aria-label`/`title` "Hide comments" / "Show comments",
    `aria-controls` the sidebar. When the sidebar is hidden and there are
    open threads, a count pill (`.mc-badge.mc-badge--count`) sits beside the
    glyph and the button widens to fit, so the number is never lost.

The mode switch is therefore reachable with the sidebar collapsed.

### Sidebar header — `#threads-header`, two rows

**Row 1, `.title-row`:** `<h2>Comments</h2>`; right-aligned
`.mc-title-actions` holding, in order, the host's **+ Add comment** (ghost
icon button — no longer primary; the primary is Send) and the **"…" menu**
(`#overflow-menu-btn`, moved up from the actions row). `#thread-count` is
removed; the counts move into the tabs.

**Row 2, `.filter-row`:** tabs, not a bordered box. Same
`role="radiogroup"`, same `input[name="filter"]` radios and values, so arrow
keys keep working. Each segment reads `Open <span class="count">3</span>`.
Active: foreground colour and a 2 px accent underline. Inactive: muted, no
underline. `New from Claude` stays hidden unless it has a count, as today,
and carries no number of its own: appearing is its signal.
The whole row gets `hidden` when total threads = 0.

**Contextual rows, unchanged in behaviour:** `#claude-summary` and
`#skill-warning`.

**Shortcut hint, `#keys-hint`:** first-run only, dismissed on first use of
n/p/r/e/o as today. Gains an inline "×" (`#keys-hint-dismiss`,
`aria-label="Hide shortcuts"`) that sets `hintDismissed`. The "?" button
leaves the header: `#hint-toggle` becomes a `role="menuitemcheckbox"` item
"Keyboard shortcuts" in the "…" menu with `aria-checked` = hint visible.
With no threads at all the hint stays hidden and the item is disabled: the
keys act on threads, so there is nothing to explain yet.

### Sidebar footer — new, `.mc-sidebar-footer`

Pinned to the bottom of the sidebar (the list scrolls above it), top border.
`hidden` when open threads = 0 — nothing to send, and the empty-state card's
own CTA covers the no-threads case.

- `#send-to-claude` — primary, fills the row. Label
  `Send 3 comments to Claude` / `Send 1 comment to Claude`, with
  `agentName` substituted as today; with suggest mode on it reads
  `Send 3 comments to Claude as suggestions`, so the setting is never on
  silently. The count is open threads, which is what a send acts on.
  `title` unchanged.
- `#send-options-btn` — the other half of a split button: same primary
  colour and height as Send, a hairline divider, a chevron glyph.
  `aria-haspopup="menu"`, `aria-expanded`, `aria-controls="send-options-menu"`,
  `aria-label="Send options"`; title "Suggest mode is on" while it is.
- `#send-options-menu` — `role="menu"`, opens upward (bottom-anchored),
  reusing the `.mc-menu` styles and the existing one-menu-open-at-a-time
  logic:
  - `#suggest-mode-toggle` — `role="menuitemcheckbox"`, `aria-checked`,
    label "Ask for suggestions instead of edits". Posts
    `toggle-suggest-mode`; the host still owns the value. Title unchanged.
  - `#copy-prompt` — `role="menuitem"`, "Copy prompt instead". Posts
    `copy-prompt`. Moved from the "…" menu.

### "…" menu — `#overflow-menu`, in order

1. `#collapse-all` — Collapse all / Expand all (unchanged).
2. `#hint-toggle` — Keyboard shortcuts (menuitemcheckbox, see above).
3. separator (`<hr role="separator">`)
4. `#remove-resolved` — danger, hidden unless there are resolved threads.
5. `#finalize-doc` — danger, hidden unless there is review data.

### Empty state — `.mc-empty-state`, total = 0

Same copy. Drop the bordered card; centre the block with generous top
margin. The action button becomes `mc-btn mc-btn--primary` — it is the only
action in the region.

### Filtered-empty — `p.empty`, unchanged.

## Visual tokens

New unscoped stylesheet `src/webviewShared/controls.css`, loaded by the live
editor page alongside `threadSidebar.css` (the toolbar sits outside the
`.mc-thread-sidebar` scope, and the two must share one definition):

- `.mc-icon-btn` — 24×24, transparent, no border, muted foreground, radius
  `--mdc-radius`; hover `--vscode-toolbar-hoverBackground`; `[aria-pressed=
  "true"]` and `.active`: foreground colour + hover background;
  `:focus-visible` outline `--vscode-focusBorder`. Used by ☰, 💬, +, …, ▾, ×.
- `.mc-segmented` — 1 px border, radius 6 px, padding 2 px, segments 4 px
  10 px; active `--vscode-button-secondaryBackground`. Used by
  `#edit-mode-toggle` (the filter is no longer segmented). Keep the
  label>input+span DOM so radios keep native arrow-key behaviour.
- `.mc-btn--primary` — existing, unchanged.
- `.mc-badge--count` — a modifier on comments.css's existing `.mc-badge`
  (redefining the base class would restyle the card tags too): 10 px,
  `--vscode-badge-background`/`-foreground`, pill.

Remove from `threadSidebar.css` what the redesign makes dead (`.mode-toggle`
duplicate, `.switch`, `.switch-row`, `.actions-row`, `#thread-count`,
`#hint-toggle[aria-pressed]`). Remove from `host.css` the rules no TypeScript
references any more (`.mdc-sidebar-header*`, `.mdc-sidebar-toolbar`,
`.mdc-sidebar-actions`, `.mdc-sidebar-action*`, `.mdc-filter-chip*`,
`.mdc-sidebar-toggle`; check `.mdc-peer-*` before touching it). Grep first;
remove only what is provably unused.

Add a header-height budget so the clutter cannot creep back: with threads
present and no contextual rows, `#threads-header`'s bounding height ≤ 80 px.

## Unchanged on purpose

- Persisted state keys: `threadFilter`, `collapseOverrides`, `hintDismissed`.
- Sidebar → host messages: `set-read-only`, `toggle-suggest-mode`,
  `copy-prompt`, `send-to-claude`, `empty-state-review`, and the rest of
  `sidebarProtocol.ts`. No host changes.
- Element ids listed above, so the host tests and most e2e locators survive.
- The composer slot (`.mdc-composer-slot`) still mounts under the header;
  the banner slot still mounts above the sidebar.

## Tests — migrate, then add

Every e2e that locates a moved control must be migrated, not left to fail
and not deleted:

| spec | what moves |
| --- | --- |
| `liveSidebarToolbar.spec.ts` | filter tabs (still radiogroup); Send label; `#suggest-mode-toggle` and `#copy-prompt` now inside `#send-options-menu` (open it first); `#hint-toggle` inside `#overflow-menu`; `#edit-mode-toggle` inside `.mdc-doc-toolbar` |
| `modeToggle.spec.ts` | `#edit-mode-toggle` in the toolbar; **add**: still visible with the sidebar collapsed |
| `liveSidebar.spec.ts` | `#thread-count` → `.filter-row .count`; Send label |
| `liveEditor.spec.ts`, `uncommittedDiff.spec.ts`, `removeResolved.spec.ts`, `finalizeDocument.spec.ts`, `liveSidebarEmptyState.spec.ts`, `highlightFilter.spec.ts`, `outline.spec.ts` | check each locator against the new DOM |
| unit: `sidebarHost.test.ts`, `collabEditorProvider.test.ts`, `webviewShell.test.ts` | check string/selector assertions |

`toolbar.spec.ts`, `inlineView*.spec.ts` and `prReview.spec.ts` drive other
webviews (classic view, PR review) and are untouched.

New e2e, in `liveSidebarChrome.spec.ts`:

- footer hidden at 0 open threads (both "no threads" and "all resolved");
  visible with the count in the label otherwise;
- send options: opening the menu, toggling suggest posts
  `toggle-suggest-mode`, copy posts `copy-prompt`, Escape closes, one menu
  open at a time with "…";
- filter row hidden at 0 total; tab counts match the threads;
- comments toggle in the toolbar collapses the sidebar, shows the open-count
  badge, and the mode switch is still clickable while collapsed;
- "…" holds Keyboard shortcuts; toggling it shows/hides `#keys-hint`; the ×
  on the hint hides it and unchecks the item;
- header height budget (≤ 80 px with threads and no contextual rows).

## Out of scope

- The classic review view (`classicReviewView`) — removed next release.
- The PR review webview's own chrome — align in a later pass.
- A floating "+ comment" affordance at the selection (Google-Docs style) —
  worth doing, separate change.

## Gates

`npm run compile`, `tsc -p tsconfig.webview.json`, `tsc -p tsconfig.e2e.json`,
`npx vitest run`, `npm run test:webview` all green. Before/after screenshots
of the live editor at 1280×800 with the review fixture, and of the empty
state.
