// The inline-comments webview's DOM skeleton.
//
// The client bundle resolves every element it touches by id at module load
// (`document.getElementById("threads-list")` and friends), so this markup is
// part of the client's contract, not decoration. It lives here — outside both
// the panel (which imports `vscode`) and the client bundle (which never reads
// it) — so the webview e2e harness can boot the shipped bundle against the
// exact skeleton the panel serves. A harness with its own copy would keep
// passing after a rename here, which is the failure this split prevents.

/**
 * The `<body>` contents of the inline-comments webview: everything from
 * `#app` down, minus the `<script>` tags (whose URIs are webview-specific).
 */
export function inlineCommentsAppBody(): string {
  return `<div id="app">
  <aside id="outline-pane" hidden></aside>
  <div id="preview-pane">
    <header id="preview-toolbar">
      <button id="outline-toggle" class="btn-link" title="Show or hide the document outline" aria-pressed="false">☰ Outline</button>
      <span id="diff-mode-badge" hidden></span>
      <span id="diff-nav" hidden>
        <button id="diff-prev" class="btn-link" title="Previous change (p)" aria-label="Previous change">↑</button>
        <span id="diff-nav-count"></span>
        <button id="diff-next" class="btn-link" title="Next change (n)" aria-label="Next change">↓</button>
      </span>
    </header>
    <div id="find-bar" hidden role="search">
      <input id="find-input" type="search" placeholder="Find in preview…" aria-label="Find in preview" />
      <span id="find-count" class="find-count">0 / 0</span>
      <button id="find-prev" class="btn-link" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
      <button id="find-next" class="btn-link" title="Next match (Enter)" aria-label="Next match">↓</button>
      <button id="find-close" class="btn-link" title="Close (Esc)" aria-label="Close find">×</button>
    </div>
    <article id="preview"><p class="mc-loading">Loading…</p></article>
    <button id="floating-add" hidden>+ Comment on selection</button>
    <button id="expand-threads" class="collapsed-toggle" title="Show comments" hidden>‹ Comments</button>
  </div>
  <aside id="threads-pane">
    <header id="threads-header">
      <div class="title-row">
        <h2>Comments</h2>
        <span id="thread-count"></span>
        <button id="collapse-threads" class="btn-link" title="Hide comments panel" aria-label="Hide comments panel">›</button>
      </div>
      <div id="claude-summary" hidden>
        <span id="claude-summary-text" role="status" aria-live="polite"></span>
        <button id="claude-next" class="btn-link" title="Jump to the next unread thread from Claude. (Cmd/Ctrl+K, Cmd/Ctrl+Alt+N)">Next</button>
      </div>
      <div class="filter-row" role="radiogroup" aria-label="Filter comment threads">
        <label class="segment"><input type="radio" name="filter" value="open" checked><span>Open</span></label>
        <label class="segment"><input type="radio" name="filter" value="all"><span>All</span></label>
        <label class="segment"><input type="radio" name="filter" value="resolved"><span>Resolved</span></label>
        <label id="filter-claude-label" class="segment" hidden><input type="radio" name="filter" value="claude-unread"><span id="filter-claude-label-text">New from Claude</span></label>
      </div>
      <div class="actions-row">
        <button id="send-to-claude" class="mc-btn mc-btn--primary" title="Send the prompt to a running Claude terminal (or your configured send mode).">Send to Claude</button>
        <span class="switch-row">
          <label id="suggest-mode-label" for="suggest-mode-toggle">Suggest mode</label>
          <button id="suggest-mode-toggle" type="button" class="switch" role="switch" aria-checked="false" aria-labelledby="suggest-mode-label" title="When on, Send to Claude asks Claude to propose edits as suggestions you accept or reject."></button>
        </span>
        <span class="mc-menu-wrap">
          <button id="overflow-menu-btn" type="button" class="btn-ghost" aria-haspopup="menu" aria-expanded="false" aria-controls="overflow-menu" aria-label="More actions" title="More actions">…</button>
          <div id="overflow-menu" class="mc-menu" role="menu" aria-label="More actions" hidden>
            <button id="copy-prompt" type="button" role="menuitem" title="Copy the prompt to your clipboard.">Copy prompt</button>
            <button id="collapse-all" type="button" role="menuitem" title="Collapse / expand all comment threads">Collapse all</button>
            <button id="remove-resolved" type="button" role="menuitem" class="danger" hidden title="Delete every resolved comment from this file. Open comments and pending suggestions are kept.">Remove resolved</button>
            <button id="finalize-doc" type="button" role="menuitem" class="danger" hidden title="Remove ALL review data — every comment, marker, and pending suggestion — leaving clean markdown ready to commit.">Remove all review data</button>
          </div>
        </span>
        <button id="hint-toggle" class="btn-link" title="Show keyboard shortcuts" aria-pressed="false">?</button>
      </div>
      <div id="keys-hint">n / p to move between threads · r reply · e resolve</div>
      <div id="skill-warning" class="skill-warning" hidden>
        <span id="skill-warning-text"></span>
        <button id="skill-install" class="btn-link"></button>
      </div>
    </header>
    <div id="threads-list" role="feed"><p class="mc-loading">Loading…</p></div>
    <div id="composer" hidden></div>
  </aside>
</div>`;
}
