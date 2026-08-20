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
    <div id="find-bar" hidden role="search">
      <input id="find-input" type="search" placeholder="Find in preview…" aria-label="Find in preview" />
      <span id="find-count" class="find-count">0 / 0</span>
      <button id="find-prev" class="btn-link" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
      <button id="find-next" class="btn-link" title="Next match (Enter)" aria-label="Next match">↓</button>
      <button id="find-close" class="btn-link" title="Close (Esc)" aria-label="Close find">×</button>
    </div>
    <header id="preview-header">
      <h2 id="file-name"></h2>
      <p class="hint">Select text in the preview to add a comment. <kbd>⌘F</kbd> to find.</p>
      <button id="outline-toggle" class="btn-link" title="Show or hide the document outline" aria-pressed="false">☰ Outline</button>
    </header>
    <article id="preview"></article>
    <button id="floating-add" hidden>+ Comment on selection</button>
    <button id="expand-threads" class="collapsed-toggle" title="Show comments" hidden>‹ Comments</button>
  </div>
  <aside id="threads-pane">
    <header id="threads-header">
      <div class="title-row">
        <h2>Comments</h2>
        <span id="thread-count"></span>
        <button id="collapse-all" class="btn-link" title="Collapse / expand all comment threads">Collapse all</button>
        <button id="collapse-threads" class="btn-link" title="Hide comments panel" aria-label="Hide comments panel">›</button>
      </div>
      <div id="claude-summary" hidden>
        <span id="claude-summary-text"></span>
        <button id="claude-next" class="btn-link" title="Jump to the next unread thread from Claude.">Next</button>
      </div>
      <div class="filter-row">
        <label><input type="radio" name="filter" value="open" checked> Open</label>
        <label><input type="radio" name="filter" value="all"> All</label>
        <label><input type="radio" name="filter" value="resolved"> Resolved</label>
        <label id="filter-claude-label" hidden><input type="radio" name="filter" value="claude-unread"> New from Claude</label>
        <button id="send-to-claude" title="Send the prompt to a running Claude terminal (or your configured send mode).">Send to Claude</button>
        <button id="copy-prompt" class="btn-ghost" title="Copy the prompt to your clipboard.">Copy</button>
        <button id="suggest-mode-toggle" class="btn-ghost" role="switch" aria-checked="false" title="When on, Send to Claude asks Claude to propose edits as suggestions you accept or reject.">Suggest: off</button>
      </div>
      <div id="skill-warning" class="skill-warning" hidden>
        <span id="skill-warning-text"></span>
        <button id="skill-install" class="btn-link"></button>
      </div>
    </header>
    <div id="threads-list"></div>
    <div id="composer" hidden></div>
  </aside>
</div>`;
}
