// The PR-review webview's DOM skeleton — see src/inlineComments/webviewShell.ts
// for the pattern this follows and why: the client bundle resolves every
// element it touches by id at module load, so this markup is part of the
// client's contract, not decoration. It lives here — outside both the panel
// (which imports `vscode`) and the client bundle (which never reads it) — so
// the webview e2e harness can boot the shipped bundle against the exact
// skeleton the panel serves, instead of a hand-copied stand-in that can drift
// out of sync with a rename here.
//
// Same chrome language as the live editor's comment sidebar
// (docs/sidebar-chrome-redesign.md, docs/pr-review-redesign.md): `#drafts-pane`
// carries `mc-thread-sidebar` and reuses threadSidebar.css / controls.css /
// comments.css's ids and class names verbatim, so the two sidebars share one
// stylesheet instead of two copies that can drift apart. PR-only hooks are
// prefixed `pr-`.

const ARROW_UP_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>';
const ARROW_DOWN_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
// Same glyph the live editor's comments toggle uses (src/webview/client.ts,
// buildCommentsToggle) — the two buttons should read as the same control.
const SPEECH_BUBBLE_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">' +
  '<path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v6A1.5 1.5 0 0 1 12.5 10H8l-3.2 2.8a.5.5 0 0 1-.8-.38V10h-.5A1.5 1.5 0 0 1 2 8.5v-6z"/></svg>';
// Same glyph the live editor's "+ Add comment" button uses (buildAddCommentButton).
const PLUS_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">' +
  '<path d="M8 1.5v5h5v1H8v5H7v-5H2v-1h5v-5h1z"/></svg>';

/**
 * The `<body>` contents of the PR-review webview: everything from `#app`
 * down, minus the `<script>` tags (whose URIs are webview-specific).
 */
export function prReviewAppBody(): string {
  return `<div id="app">
  <div id="preview-pane">
    <header id="preview-toolbar">
      <span id="diff-nav" hidden>
        <button id="diff-prev" type="button" class="mc-icon-btn" title="Previous change (p)" aria-label="Previous change">${ARROW_UP_SVG}</button>
        <span id="diff-nav-count"></span>
        <button id="diff-next" type="button" class="mc-icon-btn" title="Next change (n)" aria-label="Next change">${ARROW_DOWN_SVG}</button>
      </span>
      <button id="comments-toggle" type="button" class="mc-icon-btn" aria-pressed="true" aria-controls="drafts-pane" aria-label="Hide comments" title="Hide comments">${SPEECH_BUBBLE_SVG}<span class="mc-badge mc-badge--count" hidden></span></button>
    </header>
    <article id="preview"></article>
    <button id="floating-add" type="button" class="pr-floating-add" hidden>+ Comment on selection</button>
  </div>
  <aside id="drafts-pane" class="mc-thread-sidebar">
    <header id="threads-header">
      <div class="title-row">
        <h2>Comments</h2>
        <span class="mc-title-actions">
          <button id="add-comment-btn" type="button" class="mc-icon-btn" aria-label="Comment on selection" title="Comment on selection">${PLUS_SVG}</button>
          <span class="mc-menu-wrap">
            <button id="overflow-menu-btn" type="button" class="mc-icon-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="overflow-menu" aria-label="More actions" title="More actions">⋯</button>
            <div id="overflow-menu" class="mc-menu" role="menu" aria-label="More actions" hidden>
              <button id="collapse-all-btn" type="button" role="menuitem" class="mc-menuitem" disabled title="Collapse / expand every comment card">Collapse all</button>
            </div>
          </span>
        </span>
      </div>
      <div id="existing-filter" class="filter-row" role="radiogroup" aria-label="Filter existing comments" hidden>
        <label class="segment"><input type="radio" name="existing-filter" value="open" checked><span>Open <span id="existing-filter-count-open" class="count"></span></span></label>
        <label class="segment"><input type="radio" name="existing-filter" value="all"><span>All <span id="existing-filter-count-all" class="count"></span></span></label>
        <label class="segment"><input type="radio" name="existing-filter" value="resolved"><span>Resolved <span id="existing-filter-count-resolved" class="count"></span></span></label>
      </div>
    </header>
    <div id="composer" hidden></div>
    <div id="threads-list" role="feed">
      <div id="drafts-list"></div>
      <p id="existing-status" class="empty" hidden></p>
      <div id="existing-list"></div>
    </div>
    <footer id="submit-bar" class="mc-sidebar-footer pr-submit" hidden>
      <div class="verdict-row mc-segmented" role="radiogroup" aria-label="Review verdict">
        <label class="segment"><input type="radio" name="verdict" value="comment" checked><span>Comment</span></label>
        <label class="segment"><input type="radio" name="verdict" value="approve"><span>Approve</span></label>
        <label class="segment"><input type="radio" name="verdict" value="request-changes"><span>Request changes</span></label>
      </div>
      <textarea id="review-body" rows="2" placeholder="Optional review summary (posted alongside the inline comments)" hidden></textarea>
      <div class="pr-submit-row">
        <button id="summary-toggle" type="button" class="mc-btn mc-btn--quiet">Add summary</button>
        <button id="submit-review" type="button" class="mc-btn mc-btn--primary">Submit review</button>
      </div>
      <p id="submit-hint" class="hint" hidden></p>
    </footer>
  </aside>
</div>`;
}
