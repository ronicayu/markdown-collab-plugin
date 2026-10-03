// The live editor's page body before its first `init` (10x-plan-6 P4, sidebar
// parity): a muted "Loading…" where the document and the thread list will be,
// as the review view's shell has. `init` rebuilds the body, which clears it.
//
// Lives outside the provider (which imports `vscode`) so the webview e2e
// harness boots the shipped bundle against the same markup the provider
// serves, the way `inlineCommentsAppBody` does for the review view.

export function liveEditorShellBody(): string {
  return `<div class="mdc-layout">
  <div class="mdc-editor-pane"><p class="mc-loading">Loading…</p></div>
  <aside class="mdc-sidebar"><div class="mc-thread-sidebar"><div id="threads-list" role="feed"><p class="mc-loading">Loading…</p></div></div></aside>
</div>`;
}
