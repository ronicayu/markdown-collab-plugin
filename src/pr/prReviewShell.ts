// The PR-review webview's DOM skeleton — see src/inlineComments/webviewShell.ts
// for the pattern this follows and why: the client bundle resolves every
// element it touches by id at module load, so this markup is part of the
// client's contract, not decoration. It lives here — outside both the panel
// (which imports `vscode`) and the client bundle (which never reads it) — so
// the webview e2e harness can boot the shipped bundle against the exact
// skeleton the panel serves, instead of a hand-copied stand-in that can drift
// out of sync with a rename here.

/**
 * The `<body>` contents of the PR-review webview: everything from `#app`
 * down, minus the `<script>` tags (whose URIs are webview-specific).
 */
export function prReviewAppBody(): string {
  return `<div id="app">
  <div id="preview-pane">
    <header id="preview-toolbar">
      <span id="diff-nav" hidden>
        <button id="diff-prev" class="btn-link" title="Previous change (p)" aria-label="Previous change">↑</button>
        <span id="diff-nav-count"></span>
        <button id="diff-next" class="btn-link" title="Next change (n)" aria-label="Next change">↓</button>
      </span>
    </header>
    <article id="preview"></article>
    <button id="floating-add" hidden>+ Comment on selection</button>
  </div>
  <aside id="drafts-pane">
    <header id="drafts-header">
      <div class="title-row">
        <h2>Drafts</h2>
        <span id="draft-count"></span>
        <button id="collapse-all-btn" class="btn-link" type="button" hidden>Collapse all</button>
      </div>
      <p class="hint">Click a draft to jump to its line.</p>
    </header>
    <div id="drafts-list"></div>
    <div id="composer" hidden></div>
    <section id="existing-section" hidden>
      <h3 class="section-title">Existing comments</h3>
      <div id="existing-filter" role="radiogroup" aria-label="Filter existing comments" hidden></div>
      <p id="existing-status" class="hint">Loading…</p>
      <div id="existing-list"></div>
    </section>
    <footer id="submit-bar">
      <div class="verdict-row" role="radiogroup" aria-label="Review verdict">
        <label><input type="radio" name="verdict" value="comment" checked> Comment</label>
        <label><input type="radio" name="verdict" value="approve"> Approve</label>
        <label><input type="radio" name="verdict" value="request-changes"> Request changes</label>
      </div>
      <textarea id="review-body" rows="2" placeholder="Optional review summary (posted alongside the inline comments)"></textarea>
      <button id="submit-review" type="button" disabled>Submit review</button>
      <p id="submit-hint" class="hint">No drafts yet.</p>
    </footer>
  </aside>
</div>`;
}
