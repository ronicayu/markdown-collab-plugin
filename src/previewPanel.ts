import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import { resolve as resolveAnchor } from "./anchor";
import {
  addComment,
  addReply,
  deleteComment,
  editCommentBody,
  editReplyBody,
  loadSidecar,
  setResolved,
  sidecarPathFor,
} from "./sidecar";
import type { Anchor, Comment } from "./types";

/**
 * Self-contained preview webview for a markdown doc. Renders the doc via
 * markdown-it, overlays inline highlights for anchored comments, and exposes
 * reply / resolve / create actions directly against the sidecar.
 *
 * Writes go through the shared sidecar helpers — the existing SidecarWatcher
 * will observe those writes and refresh the editor-side comment threads
 * automatically, so we do not need to plumb through the controller.
 */
export class PreviewPanel {
  private static readonly panels = new Map<string, PreviewPanel>();

  public static show(
    doc: vscode.TextDocument,
    output: vscode.OutputChannel,
    extensionUri: vscode.Uri,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ): void {
    const key = doc.uri.fsPath;
    const existing = PreviewPanel.panels.get(key);
    if (existing) {
      // Re-reveal in the column it currently lives in — never relocate.
      existing.panel.reveal(existing.panel.viewColumn ?? viewColumn);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "markdownCollabPreview",
      `Preview: ${path.basename(doc.uri.fsPath)}`,
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Grant the webview read access to the extension's node_modules so
        // mermaid.min.js can be served as a local resource under CSP.
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "node_modules"),
        ],
      },
    );
    const instance = new PreviewPanel(panel, doc, output, extensionUri);
    PreviewPanel.panels.set(key, instance);
    panel.onDidDispose(() => {
      PreviewPanel.panels.delete(key);
      instance.dispose();
    });
  }

  /** Refresh any open preview for the given doc path. Used by sidecar watcher. */
  public static notifySidecarChange(mdFsPath: string): void {
    const p = PreviewPanel.panels.get(mdFsPath);
    if (p) void p.render();
  }

  private readonly md: MarkdownIt;
  private readonly disposables: vscode.Disposable[] = [];
  private renderSeq = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly doc: vscode.TextDocument,
    private readonly output: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.md = new MarkdownIt({ html: false, linkify: true, breaks: false });
    // Custom fence renderer: hand off ```mermaid blocks to the client-side
    // mermaid library as-is. All other fenced blocks fall back to the default.
    const defaultFence =
      this.md.renderer.rules.fence ??
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    this.md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const info = (token.info || "").trim().toLowerCase();
      if (info === "mermaid") {
        return `<pre class="mermaid">${escapeHtml(token.content)}</pre>`;
      }
      return defaultFence(tokens, idx, options, env, self);
    };

    // External-write watcher for the .md file. VS Code's onDidChangeTextDocument
    // only fires for buffer-level edits — when an external process (the AI
    // skill, a CLI editor) rewrites the file, the buffer may lag. The watcher
    // covers that gap so the preview re-renders even when VS Code hasn't yet
    // reloaded the buffer for the open .md.
    const docWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        path.dirname(doc.uri.fsPath),
        path.basename(doc.uri.fsPath),
      ),
    );
    this.disposables.push(
      docWatcher,
      docWatcher.onDidChange(() => void this.render()),
      docWatcher.onDidCreate(() => void this.render()),
      panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.fsPath === doc.uri.fsPath) void this.render();
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.fsPath === doc.uri.fsPath) void this.render();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.fsPath === doc.uri.fsPath) this.panel.dispose();
      }),
    );

    void this.render();
  }

  private dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* swallow */
      }
    }
  }

  private async render(): Promise<void> {
    // Serialize renders — rapid edits can fire faster than the async load.
    const seq = ++this.renderSeq;
    try {
      const payload = await this.buildPayload();
      if (seq !== this.renderSeq) return;
      this.panel.webview.html = this.renderHtml(payload);
    } catch (e) {
      // Don't let the preview look stale: replace the HTML with an error
      // banner pointing at the output channel. Stale-on-error was the
      // worst outcome — silent regressions hidden behind unchanged HTML.
      const msg = (e as Error).message;
      this.output.appendLine(`Preview render failed: ${msg}`);
      if (seq === this.renderSeq) {
        this.panel.webview.html = renderErrorHtml(msg);
      }
    }
  }

  private async readDocText(): Promise<string> {
    // Prefer disk content over the live buffer: an external writer (the AI
    // skill, a CLI tool) can update the file faster than VS Code reloads the
    // buffer, and the sidecar's anchors are written against disk content.
    // Fall back to the buffer when the user has unsaved local edits or the
    // disk read fails (with a logged reason — silently masking ENOENT here
    // would leave the user staring at stale content with no signal).
    if (this.doc.isDirty) return this.doc.getText();
    try {
      return await fs.readFile(this.doc.uri.fsPath, "utf8");
    } catch (e) {
      this.output.appendLine(
        `Disk read failed for ${this.doc.uri.fsPath}; using buffer: ${(e as Error).message}`,
      );
      return this.doc.getText();
    }
  }

  private async buildPayload(): Promise<PreviewPayload> {
    const text = await this.readDocText();
    const folder = vscode.workspace.getWorkspaceFolder(this.doc.uri);
    const resolvedComments: ResolvedComment[] = [];
    let orphaned: Comment[] = [];
    let readOnly = false;

    if (folder) {
      const sidecarPath = sidecarPathFor(this.doc.uri.fsPath, folder.uri.fsPath);
      if (sidecarPath) {
        const loaded = await loadSidecar(sidecarPath, (m) =>
          this.output.appendLine(m),
        );
        if (loaded) {
          readOnly = loaded.mode === "read-only-unknown-version";
          for (const c of loaded.sidecar.comments) {
            const range = resolveAnchor(text, c.anchor);
            if (range) {
              resolvedComments.push({ ...c, start: range.start, end: range.end });
            } else {
              orphaned.push(c);
            }
          }
        }
      }
    }
    resolvedComments.sort((a, b) => a.start - b.start);
    return { text, comments: resolvedComments, orphans: orphaned, readOnly };
  }

  private renderHtml(payload: PreviewPayload): string {
    const nonce = cryptoNonce();
    const body = this.renderBodyWithHighlights(payload);
    const commentsJson = JSON.stringify(payload.comments).replace(/</g, "\\u003c");
    const orphansJson = JSON.stringify(payload.orphans).replace(/</g, "\\u003c");
    const mermaidUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "mermaid",
        "dist",
        "mermaid.min.js",
      ),
    );
    const cspSource = this.panel.webview.cspSource;
    // mermaid renders SVG inline; it does not fetch external assets at
    // runtime so img-src and font-src remain locked to the webview origin.
    // 'unsafe-eval' is required because mermaid's dompurify build uses
    // Function() under the hood for configuration parsing.
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${cspSource} data:; font-src ${cspSource} data:; script-src 'nonce-${nonce}' 'unsafe-eval' ${cspSource};`;
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
html, body { margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family, -apple-system, sans-serif); color: var(--vscode-foreground); line-height: 1.6; display: flex; align-items: flex-start; }
.mdc-main { flex: 1 1 auto; min-width: 0; padding: 1rem 2rem; max-width: 960px; }
.mdc-sidebar { flex: 0 0 360px; position: sticky; top: 0; align-self: flex-start; max-height: 100vh; overflow-y: auto; border-left: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); padding: 0.75rem; box-sizing: border-box; }
@media (max-width: 900px) { body { flex-direction: column; } .mdc-sidebar { flex: 1 0 auto; width: 100%; border-left: none; border-top: 1px solid var(--vscode-panel-border); position: static; max-height: none; } }
code, pre { font-family: var(--vscode-editor-font-family, monospace); }
pre { background: var(--vscode-textCodeBlock-background, #1e1e1e); padding: 0.75rem; overflow-x: auto; border-radius: 4px; }
.mdc-anchor { background: rgba(255, 204, 0, 0.25); border-bottom: 2px solid rgba(255, 204, 0, 0.9); cursor: pointer; padding: 0 1px; transition: background 120ms ease; }
.mdc-anchor.resolved { background: rgba(100, 200, 100, 0.15); border-bottom-color: rgba(100, 200, 100, 0.6); }
.mdc-anchor.flash { background: rgba(255, 204, 0, 0.65); }
.mdc-badge { display: inline-block; font-size: 0.75em; padding: 0 4px; margin-left: 2px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); vertical-align: super; }
.mdc-toolbar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 0.5rem 0; z-index: 10; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 0.5rem; align-items: center; }
.mdc-toolbar .mdc-spacer { flex: 1; }
.mdc-toolbar button { padding: 0.25rem 0.75rem; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; }
.mdc-toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
.mdc-toolbar .mdc-icon-btn { background: transparent; color: var(--vscode-foreground); padding: 0.25rem 0.4rem; border: 1px solid transparent; border-radius: 4px; font-size: 1.05em; line-height: 1; }
.mdc-toolbar .mdc-icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); border-color: var(--vscode-panel-border); }
.mdc-toolbar .mdc-icon-btn.spinning { animation: mdc-spin 0.8s linear infinite; pointer-events: none; }
@keyframes mdc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.mdc-sidebar h3 { margin: 0 0 0.25rem; font-size: 0.95em; }
.mdc-sidebar .mdc-counts { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 0.5rem; }
.mdc-sidebar .mdc-empty { font-size: 0.85em; color: var(--vscode-descriptionForeground); padding: 0.5rem 0; }
.mdc-filter { display: flex; gap: 0.25rem; margin-bottom: 0.75rem; }
.mdc-filter button { flex: 1; padding: 0.2rem 0.4rem; font-size: 0.8em; cursor: pointer; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
.mdc-filter button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
.mdc-filter button:hover:not(.active) { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
.mdc-card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 0.5rem 0.6rem; margin-bottom: 0.5rem; cursor: pointer; background: var(--vscode-editorWidget-background); }
.mdc-card:hover { border-color: var(--vscode-focusBorder, var(--vscode-button-background)); }
.mdc-card.active { border-color: var(--vscode-focusBorder, var(--vscode-button-background)); box-shadow: 0 0 0 1px var(--vscode-focusBorder, var(--vscode-button-background)); }
.mdc-card-head { display: flex; gap: 0.4rem; align-items: baseline; flex-wrap: wrap; font-size: 0.85em; }
.mdc-card-head .author { font-weight: 600; }
.mdc-card-head .ts { color: var(--vscode-descriptionForeground); }
.mdc-pill { display: inline-block; font-size: 0.7em; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.mdc-pill.resolved { background: rgba(100, 200, 100, 0.35); color: var(--vscode-foreground); }
.mdc-pill.orphan { background: var(--vscode-errorForeground); color: #fff; }
.mdc-pill.replies { background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.mdc-card .preview { font-size: 0.85em; margin-top: 0.25rem; max-height: 3.4em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.mdc-card .anchor-snippet { font-size: 0.75em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 0.25rem; }
.mdc-card-body { display: none; margin-top: 0.5rem; }
.mdc-card.open .mdc-card-body { display: block; }
.mdc-card.open .preview { display: none; }
.mdc-msg { border-top: 1px solid var(--vscode-panel-border); padding: 0.4rem 0; font-size: 0.9em; }
.mdc-msg:first-child { border-top: none; }
.mdc-msg .author { font-weight: 600; }
.mdc-msg .ts { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 0.5rem; }
.mdc-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
.mdc-actions button { padding: 0.2rem 0.55rem; font-size: 0.8em; }
.mdc-reply { width: 100%; box-sizing: border-box; min-height: 3rem; font-family: inherit; padding: 0.25rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); margin-top: 0.5rem; }
.mdc-status { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
.mdc-floating { position: absolute; display: none; padding: 0.25rem 0.6rem; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; box-shadow: 0 2px 6px rgba(0,0,0,0.4); z-index: 30; white-space: nowrap; }
.mdc-floating:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
.mdc-floating::before { content: "💬 "; }
.mdc-inline-compose { position: absolute; display: none; width: 320px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 0.5rem; box-shadow: 0 4px 12px rgba(0,0,0,0.4); z-index: 40; }
.mdc-inline-compose textarea { width: 100%; box-sizing: border-box; min-height: 3rem; font-family: inherit; padding: 0.25rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); resize: vertical; }
.mdc-inline-compose .mdc-inline-hint { font-size: 0.75em; color: var(--vscode-descriptionForeground); margin: 0.25rem 0; }
.mdc-inline-compose .mdc-inline-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
.mdc-inline-compose button { padding: 0.25rem 0.75rem; cursor: pointer; border: none; border-radius: 2px; font-size: 0.85em; }
.mdc-inline-compose .mdc-inline-submit { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.mdc-inline-compose .mdc-inline-cancel { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
.mdc-danger { background: var(--vscode-errorForeground, #d73a49) !important; color: #fff; }
pre.mermaid { background: transparent; padding: 0.5rem 0; text-align: center; }
pre.mermaid svg { max-width: 100%; height: auto; }
.mermaid-error { color: var(--vscode-errorForeground); font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; padding: 0.5rem; border: 1px dashed var(--vscode-errorForeground); border-radius: 4px; }
.mdc-frontmatter { margin-bottom: 1rem; padding: 0.5rem 0.75rem; background: var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background)); border-left: 3px solid var(--vscode-textLink-foreground, var(--vscode-button-background)); border-radius: 2px; font-size: 0.9em; }
.mdc-frontmatter table { border-collapse: collapse; width: 100%; }
.mdc-frontmatter th, .mdc-frontmatter td { padding: 0.15rem 0.5rem 0.15rem 0; text-align: left; vertical-align: top; }
.mdc-frontmatter th { color: var(--vscode-descriptionForeground); font-weight: 600; white-space: nowrap; width: 1%; }
.mdc-frontmatter td { word-break: break-word; }
.mdc-frontmatter.raw pre { margin: 0; padding: 0; background: transparent; font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; overflow-x: auto; }
.mdc-msg .mdc-msg-actions { margin-top: 0.25rem; display: flex; gap: 0.5rem; }
.mdc-msg .mdc-msg-actions button { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 0.8em; }
.mdc-msg .mdc-msg-actions button:hover { text-decoration: underline; }
.mdc-msg textarea.mdc-msg-edit { width: 100%; box-sizing: border-box; min-height: 3rem; font-family: inherit; padding: 0.25rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); margin-top: 0.25rem; }
</style>
</head><body>
<main class="mdc-main">
  <div class="mdc-toolbar">
    <span class="mdc-status" id="mdcStatus">${payload.readOnly ? "Read-only: sidecar has a newer schema version." : "Select text to add a comment."}</span>
    <span class="mdc-spacer"></span>
    <button class="mdc-icon-btn" id="mdcRefresh" title="Refresh preview (re-read file and comments)" aria-label="Refresh">↻</button>
  </div>
  <div id="mdcContent">${body}</div>
  <button class="mdc-floating" id="mdcFloating">Comment</button>
  <div class="mdc-inline-compose" id="mdcCompose">
    <textarea id="mdcComposeBody" placeholder="Add a comment..."></textarea>
    <div class="mdc-inline-hint" id="mdcComposeHint"></div>
    <div class="mdc-inline-actions">
      <button class="mdc-inline-cancel" id="mdcComposeCancel">Cancel</button>
      <button class="mdc-inline-submit" id="mdcComposeSubmit">Comment</button>
    </div>
  </div>
</main>
<aside class="mdc-sidebar" id="mdcSidebar">
  <h3>Comments</h3>
  <div class="mdc-counts" id="mdcCounts"></div>
  <div class="mdc-filter" id="mdcFilter">
    <button data-filter="unresolved" class="active">Unresolved</button>
    <button data-filter="resolved">Resolved</button>
    <button data-filter="all">All</button>
  </div>
  <div id="mdcList"></div>
</aside>
<script nonce="${nonce}" src="${mermaidUri}"></script>
<script nonce="${nonce}">
(function(){
  try {
    const isDark = (document.body.classList && document.body.classList.contains("vscode-dark")) ||
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (window.mermaid && window.mermaid.initialize) {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        securityLevel: "strict",
      });
      window.mermaid.run({ querySelector: "pre.mermaid" }).catch((e) => {
        console.error("mermaid render failed", e);
      });
    }
  } catch (e) {
    console.error("mermaid init failed", e);
  }
})();
</script>
<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const comments = ${commentsJson};
  const orphans = ${orphansJson};
  const readOnly = ${payload.readOnly ? "true" : "false"};
  const byId = new Map();
  comments.forEach(c => byId.set(c.id, Object.assign({_orphan: false}, c)));
  orphans.forEach(o => byId.set(o.id, Object.assign({_orphan: true}, o)));
  const listEl = document.getElementById("mdcList");
  const countsEl = document.getElementById("mdcCounts");
  const filterEl = document.getElementById("mdcFilter");
  const statusEl = document.getElementById("mdcStatus");
  let currentId = null;
  // Restore filter from previous webview state if any; default unresolved.
  const prior = (vscode.getState && vscode.getState()) || {};
  let activeFilter = prior.filter || "unresolved";

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[ch])); }
  function fmt(iso){ if(!iso) return ""; const d = new Date(iso); if(isNaN(d.getTime())) return ""; const now = Date.now(); return (d.getTime() > now ? new Date(now) : d).toLocaleString(); }
  function truncate(s, n){ s = String(s == null ? "" : s); return s.length <= n ? s : s.slice(0, n - 1) + "…"; }

  function pillFor(c){
    if(c._orphan) return '<span class="mdc-pill orphan">Orphan</span>';
    if(c.resolved) return '<span class="mdc-pill resolved">Resolved</span>';
    return '<span class="mdc-pill">Open</span>';
  }
  function repliesPill(c){
    const n = (c.replies || []).length;
    return n > 0 ? '<span class="mdc-pill replies">'+(n+1)+' msgs</span>' : "";
  }

  function passesFilter(c){
    if(activeFilter === "all") return true;
    if(activeFilter === "resolved") return !!c.resolved;
    // "unresolved" — orphans count as unresolved unless explicitly resolved.
    return !c.resolved;
  }

  function renderList(){
    const all = Array.from(byId.values());
    // Sort: live first by anchor offset, then orphans by createdAt.
    all.sort((a, b) => {
      if(a._orphan !== b._orphan) return a._orphan ? 1 : -1;
      if(!a._orphan) return (a.start || 0) - (b.start || 0);
      return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
    const live = all.filter(c => !c._orphan);
    const resolvedTotal = all.filter(c => c.resolved).length;
    const orphTotal = all.length - live.length;
    const unresolvedTotal = all.length - resolvedTotal;
    countsEl.textContent = all.length === 0
      ? "No comments yet. Select text to add one."
      : (unresolvedTotal + " unresolved" + (resolvedTotal ? " · " + resolvedTotal + " resolved" : "") + (orphTotal ? " · " + orphTotal + " orphan" : ""));
    const filtered = all.filter(passesFilter);
    if(all.length === 0){
      listEl.innerHTML = '<div class="mdc-empty">Highlight some text in the preview to add the first comment.</div>';
      return;
    }
    if(filtered.length === 0){
      const what = activeFilter === "resolved" ? "resolved" : (activeFilter === "unresolved" ? "unresolved" : "");
      listEl.innerHTML = '<div class="mdc-empty">No '+what+' comments. Switch filter to see others.</div>';
      return;
    }
    listEl.innerHTML = filtered.map(c => {
      const snippet = c._orphan && c.anchor && c.anchor.text
        ? '<div class="anchor-snippet" title="Original anchor (no longer found in source)">' + esc(truncate(c.anchor.text, 80)) + '</div>'
        : "";
      return '<div class="mdc-card" data-id="'+esc(c.id)+'">'
        + '<div class="mdc-card-head">'
        +   '<span class="author">'+esc(c.author || "anon")+'</span>'
        +   '<span class="ts">'+esc(fmt(c.createdAt))+'</span>'
        +   pillFor(c)
        +   repliesPill(c)
        + '</div>'
        + '<div class="preview">'+esc(c.body)+'</div>'
        + snippet
        + '<div class="mdc-card-body" data-body-for="'+esc(c.id)+'"></div>'
        + '</div>';
    }).join("");
    // Wire card-level click to expand. Clicks on action buttons inside an
    // expanded card stop propagation so the card doesn't re-collapse.
    Array.prototype.forEach.call(listEl.querySelectorAll(".mdc-card"), function(card){
      card.addEventListener("click", function(e){
        if(e.target.closest && (e.target.closest("button") || e.target.closest("textarea") || e.target.closest(".mdc-card-body"))) return;
        const id = card.getAttribute("data-id");
        toggleExpand(id);
      });
    });
    // If a card was open before re-render, restore it.
    if(currentId && byId.has(currentId)) expandCard(currentId);
  }

  function flashAnchor(id){
    const el = document.querySelector('.mdc-anchor[data-comment-id="'+CSS.escape(id)+'"]');
    if(!el) return;
    el.scrollIntoView({behavior: "smooth", block: "center"});
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 800);
  }

  function toggleExpand(id){
    if(currentId === id){
      // Collapse
      const card = listEl.querySelector('.mdc-card[data-id="'+CSS.escape(id)+'"]');
      if(card){ card.classList.remove("open", "active"); }
      currentId = null;
      return;
    }
    expandCard(id);
  }

  function expandCard(id){
    const c = byId.get(id);
    if(!c) return;
    currentId = id;
    Array.prototype.forEach.call(listEl.querySelectorAll(".mdc-card"), function(card){
      card.classList.remove("open", "active");
    });
    const card = listEl.querySelector('.mdc-card[data-id="'+CSS.escape(id)+'"]');
    if(!card) return;
    card.classList.add("open", "active");
    const body = card.querySelector(".mdc-card-body");
    const msgs = [{author: c.author, body: c.body, createdAt: c.createdAt, _isRoot: true}]
      .concat((c.replies || []).map((r, i) => Object.assign({_replyIndex: i}, r)));
    const editable = !readOnly;
    const msgsHtml = msgs.map((m, i) => {
      const editBtn = editable
        ? '<div class="mdc-msg-actions"><button class="mdc-msg-edit" data-msg-idx="'+i+'">Edit</button></div>'
        : "";
      return '<div class="mdc-msg" data-msg-idx="'+i+'">'
        + '<span class="author">'+esc(m.author)+'</span>'
        + '<span class="ts">'+esc(fmt(m.createdAt))+'</span>'
        + '<div class="mdc-msg-body">'+esc(m.body)+'</div>'
        + editBtn
        + '</div>';
    }).join("");
    const orphanNote = c._orphan
      ? '<div class="mdc-empty">Anchor no longer matches the document. You can still reply, resolve, or delete; to re-attach to new text, use the editor (right-click the orphan in Explorer).</div>'
      : "";
    const actionsHtml = readOnly ? "" :
      '<textarea class="mdc-reply" placeholder="Reply..."></textarea>' +
      '<div class="mdc-actions">' +
        '<button class="mdc-send-reply">Reply</button>' +
        '<button class="mdc-toggle-resolve">'+(c.resolved?"Reopen":"Resolve")+'</button>' +
        '<button class="mdc-delete mdc-danger">Delete</button>' +
      '</div>';
    body.innerHTML = msgsHtml + orphanNote + actionsHtml;
    if(!c._orphan) flashAnchor(id);
    if(!readOnly){
      const replyBox = body.querySelector(".mdc-reply");
      body.querySelector(".mdc-send-reply").onclick = (e) => {
        e.stopPropagation();
        const txt = replyBox.value.trim();
        if(!txt) return;
        vscode.postMessage({type: "reply", commentId: id, body: txt});
      };
      body.querySelector(".mdc-toggle-resolve").onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({type: "toggleResolve", commentId: id, resolved: !c.resolved});
      };
      body.querySelector(".mdc-delete").onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({type: "delete", commentId: id});
      };
      Array.prototype.forEach.call(body.querySelectorAll(".mdc-msg-edit"), function(btn){
        btn.addEventListener("click", function(ev){
          ev.stopPropagation();
          const idx = Number(btn.getAttribute("data-msg-idx"));
          const m = msgs[idx];
          const row = body.querySelector('.mdc-msg[data-msg-idx="'+idx+'"]');
          if(!row) return;
          const bodyEl = row.querySelector(".mdc-msg-body");
          const actionsEl = row.querySelector(".mdc-msg-actions");
          const original = m.body || "";
          const ta = document.createElement("textarea");
          ta.className = "mdc-msg-edit";
          ta.value = original;
          bodyEl.replaceWith(ta);
          actionsEl.innerHTML = '<button class="mdc-msg-save">Save</button><button class="mdc-msg-cancel">Cancel</button>';
          setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
          const rerender = () => expandCard(id);
          actionsEl.querySelector(".mdc-msg-save").onclick = (sev) => {
            sev.stopPropagation();
            const next = ta.value;
            if(next === original){ rerender(); return; }
            const payload = m._isRoot
              ? { type: "edit", commentId: id, body: next }
              : { type: "editReply", commentId: id, replyIndex: m._replyIndex, body: next };
            vscode.postMessage(payload);
          };
          actionsEl.querySelector(".mdc-msg-cancel").onclick = (cev) => {
            cev.stopPropagation();
            rerender();
          };
          ta.addEventListener("keydown", (kev) => {
            if(kev.key === "Escape") rerender();
            else if(kev.key === "Enter" && (kev.metaKey || kev.ctrlKey)) actionsEl.querySelector(".mdc-msg-save").click();
          });
        });
      });
    }
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest ? e.target.closest(".mdc-anchor") : null;
    if(el && el.dataset.commentId){
      const c = byId.get(el.dataset.commentId);
      // Anchor click on a card that's hidden by the current filter widens the
      // filter to "All" so the user can find it in the sidebar.
      if(c && !passesFilter(c)) setFilter("all");
      expandCard(el.dataset.commentId);
      return;
    }
    // Hyperlink interception: route .md links to a new preview, other paths
    // to vscode.open, absolute URLs to the OS browser. Lets clicking
    // [foo.md](foo.md) inside the preview drill in to that doc.
    const a = e.target.closest ? e.target.closest("a") : null;
    if(a){
      const href = a.getAttribute("href");
      if(!href) return;
      // In-doc fragments stay local — let the webview's default scroll.
      if(href.charAt(0) === "#") return;
      e.preventDefault();
      vscode.postMessage({type: "openLink", href: href});
    }
  });

  function setFilter(name){
    if(activeFilter === name) return;
    activeFilter = name;
    if(vscode.setState) vscode.setState(Object.assign({}, prior, {filter: name}));
    Array.prototype.forEach.call(filterEl.querySelectorAll("button"), function(b){
      b.classList.toggle("active", b.getAttribute("data-filter") === name);
    });
    // If the currently expanded card no longer passes the filter, drop the
    // selection so it doesn't appear hidden-but-active.
    if(currentId){
      const c = byId.get(currentId);
      if(!c || !passesFilter(c)) currentId = null;
    }
    renderList();
  }
  Array.prototype.forEach.call(filterEl.querySelectorAll("button"), function(b){
    b.addEventListener("click", function(){ setFilter(b.getAttribute("data-filter")); });
    b.classList.toggle("active", b.getAttribute("data-filter") === activeFilter);
  });

  const refreshBtn = document.getElementById("mdcRefresh");
  if(refreshBtn){
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("spinning");
      vscode.postMessage({type: "refresh"});
      // Spinner clears on next render (the whole HTML is replaced) or after
      // a 1.5s safety timeout if nothing changed.
      setTimeout(() => refreshBtn.classList.remove("spinning"), 1500);
    });
  }
  renderList();

  const floating = document.getElementById("mdcFloating");
  const compose = document.getElementById("mdcCompose");
  const composeBody = document.getElementById("mdcComposeBody");
  const composeHint = document.getElementById("mdcComposeHint");
  const composeCancel = document.getElementById("mdcComposeCancel");
  const composeSubmit = document.getElementById("mdcComposeSubmit");
  let pendingSelection = { raw: "", inline: false };
  let composeOpen = false;

  function hideFloating(){ floating.style.display = "none"; }
  function anchorRectForSelection(sel){
    if(!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if(r.width === 0 && r.height === 0) return null;
    return r;
  }
  function positionBelow(el, rect, width){
    const pad = 8;
    const w = width || el.offsetWidth || 320;
    let left = window.scrollX + rect.left + (rect.width / 2) - (w / 2);
    const maxLeft = window.scrollX + document.documentElement.clientWidth - w - pad;
    if(left > maxLeft) left = maxLeft;
    if(left < window.scrollX + pad) left = window.scrollX + pad;
    el.style.left = left + "px";
    el.style.top = (window.scrollY + rect.bottom + pad) + "px";
  }
  function selectionContainerEl(sel){
    const n = sel && sel.anchorNode;
    if(!n) return null;
    return n.nodeType === 1 ? n : (n.parentElement || null);
  }
  function enclosingInlineCode(sel){
    const a = selectionContainerEl(sel);
    const f = sel && sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
    if(!a || !f) return null;
    const codeA = a.closest && a.closest("code");
    const codeF = f.closest && f.closest("code");
    if(!codeA || codeA !== codeF) return null;
    if(codeA.parentElement && codeA.parentElement.tagName === "PRE") return null;
    return codeA;
  }
  function captureSelection(sel){
    const raw = sel ? sel.toString() : "";
    const code = enclosingInlineCode(sel);
    // Only treat as "inline code selection" when the selection covers the
    // entire code text. A partial selection (e.g., a word inside a compound
    // identifier) must be searched as-is in the raw markdown, since the raw
    // partial string will match the substring inside the backticks.
    const inline = !!(code && raw === (code.textContent || ""));
    return { raw: raw, inline: inline };
  }
  function showFloatingFor(sel){
    if(readOnly) return;
    if(composeOpen) return;
    const r = anchorRectForSelection(sel);
    const cap = captureSelection(sel);
    if(!r || cap.raw.trim().length < 3) return hideFloating();
    const container = selectionContainerEl(sel);
    if(container && container.closest && container.closest(".mdc-panel, .mdc-inline-compose")) return hideFloating();
    positionBelow(floating, r, 90);
    floating.style.display = "block";
    pendingSelection = cap;
  }
  function openCompose(rect){
    if(readOnly) return;
    hideFloating();
    composeOpen = true;
    compose.style.display = "block";
    positionBelow(compose, rect, 320);
    composeBody.value = "";
    const preview = pendingSelection.raw.slice(0, 80) + (pendingSelection.raw.length > 80 ? "…" : "");
    composeHint.textContent = (pendingSelection.inline ? "On \`" + preview + "\`" : "On: " + preview);
    statusEl.textContent = "";
    setTimeout(() => composeBody.focus(), 0);
  }
  function closeCompose(){
    composeOpen = false;
    compose.style.display = "none";
    pendingSelection = { raw: "", inline: false };
    composeBody.value = "";
    statusEl.textContent = "";
  }
  document.addEventListener("selectionchange", () => {
    if(composeOpen) return;
    const sel = document.getSelection();
    if(!sel || sel.isCollapsed) return hideFloating();
    showFloatingFor(sel);
  });
  floating.addEventListener("mousedown", (e) => { e.preventDefault(); });
  floating.addEventListener("click", () => {
    const sel = document.getSelection();
    const r = anchorRectForSelection(sel) || floating.getBoundingClientRect();
    if(!pendingSelection.raw || pendingSelection.raw.trim().length < 3) return;
    openCompose(r);
  });
  composeCancel.addEventListener("click", closeCompose);
  composeSubmit.addEventListener("click", () => {
    const body = composeBody.value.trim();
    if(!body){ composeBody.focus(); return; }
    if(!pendingSelection.raw || pendingSelection.raw.trim().length < 3){
      statusEl.textContent = "Selection lost — re-select and try again.";
      closeCompose();
      return;
    }
    // Inline-code selection: DOM strips the delimiters, raw markdown keeps
    // them; wrap back before sending so the source lookup matches.
    const selectedText = pendingSelection.inline
      ? "\`" + pendingSelection.raw + "\`"
      : pendingSelection.raw;
    statusEl.textContent = "Creating comment...";
    vscode.postMessage({type: "create", selectedText: selectedText, body: body});
    closeCompose();
  });
  composeBody.addEventListener("keydown", (e) => {
    if(e.key === "Escape"){ closeCompose(); }
    else if(e.key === "Enter" && (e.metaKey || e.ctrlKey)){ composeSubmit.click(); }
  });
  window.addEventListener("scroll", () => {
    if(composeOpen){
      // Keep compose pinned to its last position; too jittery to follow scroll.
      return;
    }
    const sel = document.getSelection();
    if(sel && !sel.isCollapsed) showFloatingFor(sel); else hideFloating();
  });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if(m && m.type === "status") statusEl.textContent = m.text || "";
  });
})();
</script>
</body></html>`;
  }

  private renderBodyWithHighlights(payload: PreviewPayload): string {
    // Strip leading YAML frontmatter so markdown-it doesn't render it as a
    // thematic break + code block. We render it ourselves as a styled
    // metadata box prepended to the body.
    const fm = extractFrontmatter(payload.text);
    const fmHtml = fm.yaml !== null ? renderFrontmatterHtml(fm.yaml) : "";

    // Render the body without the frontmatter so paragraph structure is
    // preserved. Post-process the resulting HTML to wrap each anchor's
    // rendered inline form in a highlight span.
    let html = this.md.render(fm.rest);
    if (payload.comments.length === 0) return fmHtml + html;

    for (const c of payload.comments) {
      const needle = this.md.renderInline(payload.text.slice(c.start, c.end));
      if (!needle) continue;
      const wrapped = wrapFirstOutsideTags(html, needle, (inner) => {
        const cls = "mdc-anchor" + (c.resolved ? " resolved" : "");
        const badge =
          c.replies.length > 0
            ? `<span class="mdc-badge">${c.replies.length + 1}</span>`
            : "";
        return `<span class="${cls}" data-comment-id="${escapeAttr(c.id)}" title="${escapeAttr(truncate(c.body, 120))}">${inner}${badge}</span>`;
      });
      if (wrapped !== null) html = wrapped;
    }
    return fmHtml + html;
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string };
    try {
      if (m.type === "reply") await this.onReply(msg as ReplyMsg);
      else if (m.type === "toggleResolve") await this.onToggleResolve(msg as ResolveMsg);
      else if (m.type === "create") await this.onCreate(msg as CreateMsg);
      else if (m.type === "delete") await this.onDelete(msg as DeleteMsg);
      else if (m.type === "edit") await this.onEdit(msg as EditMsg);
      else if (m.type === "editReply") await this.onEditReply(msg as EditReplyMsg);
      else if (m.type === "refresh") await this.render();
      else if (m.type === "openLink") await this.onOpenLink(msg as OpenLinkMsg);
    } catch (e) {
      this.output.appendLine(`Preview action failed: ${(e as Error).message}`);
      this.panel.webview.postMessage({
        type: "status",
        text: `Error: ${(e as Error).message}`,
      });
    }
  }

  private sidecarPath(): string | null {
    const folder = vscode.workspace.getWorkspaceFolder(this.doc.uri);
    if (!folder) return null;
    return sidecarPathFor(this.doc.uri.fsPath, folder.uri.fsPath);
  }

  /**
   * Resolve the sidecar path or surface a status message in the webview.
   * Replaces the silent `if (!p) return` pattern that left the user
   * staring at a clicked button with no feedback when the .md is outside
   * any workspace folder.
   */
  private requireSidecarPath(action: string): string | null {
    const p = this.sidecarPath();
    if (p) return p;
    const reason = `Cannot ${action}: file is not in a workspace folder.`;
    this.output.appendLine(reason);
    this.panel.webview.postMessage({ type: "status", text: reason });
    return null;
  }

  private async onReply(msg: ReplyMsg): Promise<void> {
    const p = this.requireSidecarPath("reply");
    if (!p) return;
    await addReply(p, msg.commentId, {
      author: "user",
      body: msg.body,
      createdAt: new Date().toISOString(),
    });
    await this.render();
  }

  private async onOpenLink(msg: OpenLinkMsg): Promise<void> {
    const raw = (msg.href || "").trim();
    if (!raw) return;

    // Absolute URLs go to the OS handler. Allow only safe schemes — never
    // dispatch javascript: or data: through openExternal.
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      if (
        scheme === "http" ||
        scheme === "https" ||
        scheme === "mailto" ||
        scheme === "tel"
      ) {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(raw));
        } catch (e) {
          this.output.appendLine(
            `openExternal failed for ${raw}: ${(e as Error).message}`,
          );
          void vscode.window.showWarningMessage(
            `Could not open ${raw}: ${(e as Error).message}`,
          );
        }
      } else {
        this.output.appendLine(`Refusing to open link with scheme '${scheme}'.`);
        void vscode.window.showWarningMessage(
          `Refusing to open link with scheme '${scheme}'.`,
        );
      }
      return;
    }

    // Strip fragment and query — both are out of scope for now. Decode the
    // path so spaces/utf-8 in markdown links resolve to real filenames.
    const noFrag = raw.split("#")[0].split("?")[0];
    if (noFrag === "") return;
    let pathPart: string;
    try {
      pathPart = decodeURIComponent(noFrag);
    } catch (e) {
      this.output.appendLine(
        `decodeURIComponent failed for ${noFrag}: ${(e as Error).message}; using raw`,
      );
      pathPart = noFrag;
    }

    // Reject any link that resolves outside the document's workspace folder.
    // Without this, a malicious markdown file could slip in
    // [click](../../../etc/passwd) and a click would expose arbitrary
    // filesystem content via vscode.open.
    const folder = vscode.workspace.getWorkspaceFolder(this.doc.uri);
    const baseDir = path.dirname(this.doc.uri.fsPath);
    const resolved = path.resolve(baseDir, pathPart);
    const root = folder ? folder.uri.fsPath : baseDir;
    if (!isInsideRoot(resolved, root)) {
      this.output.appendLine(
        `Refusing link outside workspace root (${root}): ${resolved}`,
      );
      void vscode.window.showWarningMessage(
        `Link blocked: ${pathPart} resolves outside the workspace.`,
      );
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        void vscode.window.showWarningMessage(
          `Cannot open directory in preview: ${resolved}`,
        );
        return;
      }
    } catch (e) {
      this.output.appendLine(
        `Linked file stat failed for ${resolved}: ${(e as Error).message}`,
      );
      void vscode.window.showWarningMessage(
        `Linked file not found: ${resolved}`,
      );
      return;
    }

    const targetUri = vscode.Uri.file(resolved);
    if (resolved.toLowerCase().endsWith(".md")) {
      try {
        const targetDoc = await vscode.workspace.openTextDocument(targetUri);
        // Open the linked preview in the same column the current preview
        // lives in. Without this, ViewColumn.Beside creates a new side
        // group and the new preview shows up as a split rather than as a
        // tab in the same group.
        const sameColumn = this.panel.viewColumn ?? vscode.ViewColumn.Active;
        PreviewPanel.show(targetDoc, this.output, this.extensionUri, sameColumn);
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Failed to open ${resolved}: ${(e as Error).message}`,
        );
      }
      return;
    }

    // Non-markdown — hand off to VS Code's default opener so the user gets
    // the right editor (image viewer, JSON formatter, source editor, etc.).
    try {
      await vscode.commands.executeCommand("vscode.open", targetUri);
    } catch (e) {
      this.output.appendLine(
        `vscode.open failed for ${resolved}: ${(e as Error).message}`,
      );
      void vscode.window.showWarningMessage(
        `Could not open ${resolved}: ${(e as Error).message}`,
      );
    }
  }

  private async onEdit(msg: EditMsg): Promise<void> {
    const p = this.requireSidecarPath("edit");
    if (!p) return;
    if (!msg.body || !msg.body.trim()) return;
    await editCommentBody(p, msg.commentId, msg.body);
    await this.render();
  }

  private async onEditReply(msg: EditReplyMsg): Promise<void> {
    const p = this.requireSidecarPath("edit reply");
    if (!p) return;
    if (!msg.body || !msg.body.trim()) return;
    await editReplyBody(p, msg.commentId, msg.replyIndex, msg.body);
    await this.render();
  }

  private async onDelete(msg: DeleteMsg): Promise<void> {
    const p = this.requireSidecarPath("delete");
    if (!p) return;
    const confirm = await vscode.window.showWarningMessage(
      "Delete this comment thread? Replies will be removed too.",
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") return;
    await deleteComment(p, msg.commentId);
    await this.render();
  }

  private async onToggleResolve(msg: ResolveMsg): Promise<void> {
    const p = this.requireSidecarPath("resolve");
    if (!p) return;
    await setResolved(p, msg.commentId, msg.resolved);
    await this.render();
  }

  private async onCreate(msg: CreateMsg): Promise<void> {
    const p = this.requireSidecarPath("create comment");
    const folder = vscode.workspace.getWorkspaceFolder(this.doc.uri);
    if (!p || !folder) return;
    if (!msg.body || !msg.body.trim()) return;
    // Use the same text source the preview rendered from. Without this the
    // selection-to-source lookup races: render reads disk while onCreate
    // would read buffer, and on a divergence the anchor lands at the wrong
    // offset (or fails to locate).
    const text = await this.readDocText();
    const located = locateSelectionInSource(text, msg.selectedText);
    if (!located) {
      this.panel.webview.postMessage({
        type: "status",
        text: "Could not locate selection in source (ambiguous or not found).",
      });
      return;
    }
    const anchor: Anchor = {
      text: text.slice(located.start, located.end),
      contextBefore: text.slice(Math.max(0, located.start - 40), located.start),
      contextAfter: text.slice(located.end, located.end + 40),
    };
    const mdRel = path.relative(folder.uri.fsPath, this.doc.uri.fsPath);
    await addComment(p, mdRel, {
      anchor,
      body: msg.body,
      author: "user",
      createdAt: new Date().toISOString(),
    });
    await this.render();
  }
}

// -----------------------------------------------------------------------------
// Pure helpers (exported for tests)
// -----------------------------------------------------------------------------

/**
 * Find a selection from rendered preview back inside the raw markdown.
 * Returns the unique source range, or null if no / multiple matches.
 */
export function locateSelectionInSource(
  source: string,
  selected: string,
): { start: number; end: number } | null {
  const trimmed = selected.trim();
  if (trimmed.length === 0) return null;
  const exact = allIndexes(source, trimmed);
  if (exact.length === 1) {
    return { start: exact[0], end: exact[0] + trimmed.length };
  }
  if (exact.length > 1) return null;

  // Whitespace-normalized fallback: collapse runs in both source and needle,
  // find a unique match in normalized space, then map back.
  const { normalized, map } = collapseWs(source);
  const needle = trimmed.replace(/\s+/g, " ");
  const hits = allIndexes(normalized, needle);
  if (hits.length !== 1) return null;
  const s = map[hits[0]];
  const e = map[hits[0] + needle.length];
  return { start: s, end: e };
}

/**
 * Minimal HTML shown when buildPayload / renderHtml throws. Keeps the
 * webview frame alive (so the panel doesn't appear blank), surfaces the
 * error message, and points the user at the output channel for detail.
 */
function renderErrorHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><style>
body { font-family: var(--vscode-font-family, -apple-system, sans-serif); color: var(--vscode-foreground); padding: 2rem; }
.box { border: 1px solid var(--vscode-errorForeground); border-radius: 4px; padding: 1rem; max-width: 640px; }
h1 { margin-top: 0; font-size: 1.1em; color: var(--vscode-errorForeground); }
pre { background: var(--vscode-textCodeBlock-background, transparent); padding: 0.5rem; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
small { color: var(--vscode-descriptionForeground); }
</style></head><body><div class="box">
<h1>Preview render failed</h1>
<pre>${escapeHtml(message)}</pre>
<small>See <strong>Output → Markdown Collab</strong> for full context. Click the refresh button after fixing the file to retry.</small>
</div></body></html>`;
}

/**
 * True when `target` is the same path as `root` or any descendant. Used to
 * confine link-routing to the workspace folder of the previewed document.
 * Both arguments must be absolute filesystem paths. The comparison is
 * case-sensitive on POSIX and case-insensitive on win32 (matching how the
 * filesystem itself behaves), and uses `path.relative` so symlinks at the
 * boundary collapse correctly.
 */
export function isInsideRoot(target: string, root: string): boolean {
  const a = path.resolve(target);
  const b = path.resolve(root);
  if (a === b) return true;
  const rel = path.relative(b, a);
  if (rel === "" ) return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Locate the first occurrence of `needle` inside `html` that lies entirely
 * within text content (not inside a tag's attribute list) and does not
 * straddle a tag boundary unless the boundary matches byte-for-byte. Wrap the
 * matched slice with `wrap(inner)` and return the new HTML. Returns null if
 * the needle cannot be located.
 *
 * This is deliberately a string-level match rather than a DOM walk — the
 * rendered HTML is already known to have been produced by markdown-it with
 * `html: false`, so tag shapes are regular, and the needle itself is the
 * markdown-it output for the same source text, so embedded tags line up.
 */
export function wrapFirstOutsideTags(
  html: string,
  needle: string,
  wrap: (inner: string) => string,
): string | null {
  if (needle.length === 0) return null;
  let searchFrom = 0;
  while (searchFrom <= html.length - needle.length) {
    const idx = html.indexOf(needle, searchFrom);
    if (idx === -1) return null;
    if (!isInsideTag(html, idx)) {
      return html.slice(0, idx) + wrap(needle) + html.slice(idx + needle.length);
    }
    searchFrom = idx + 1;
  }
  return null;
}

/**
 * True if the offset sits inside `<... >` (tag open, attributes, or tag
 * close). Scans leftward to the nearest unquoted `<` or `>`; if `<` is
 * closer, we're inside a tag.
 */
export function isInsideTag(html: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0; i--) {
    const ch = html[i];
    if (ch === ">") return false;
    if (ch === "<") return true;
  }
  return false;
}

function allIndexes(hay: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  let from = 0;
  while (true) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

function collapseWs(text: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  const ws = /\s/;
  let i = 0;
  while (i < text.length) {
    if (ws.test(text[i])) {
      const runStart = i;
      while (i < text.length && ws.test(text[i])) i++;
      map.push(runStart);
      normalized += " ";
    } else {
      map.push(i);
      normalized += text[i];
      i++;
    }
  }
  map.push(text.length);
  return { normalized, map };
}

/**
 * Detect a leading YAML frontmatter block: `---\n...\n---\n` at offset 0.
 * Returns the inner YAML text, the rest of the markdown, and the byte
 * length consumed (0 when no frontmatter is present).
 */
export function extractFrontmatter(text: string): {
  yaml: string | null;
  rest: string;
  consumed: number;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { yaml: null, rest: text, consumed: 0 };
  return { yaml: m[1], rest: text.slice(m[0].length), consumed: m[0].length };
}

/**
 * Render a frontmatter block as a metadata table. Falls back to a `<pre>`
 * dump for anything more complex than top-level `key: value` pairs (nested
 * keys, arrays, anchors, etc.) so we never silently mangle complex YAML.
 */
export function renderFrontmatterHtml(yaml: string): string {
  const parsed = parseSimpleFrontmatter(yaml);
  if (parsed === null) {
    return `<div class="mdc-frontmatter raw"><pre>${escapeHtml(yaml)}</pre></div>`;
  }
  if (parsed.length === 0) return "";
  const rows = parsed
    .map(
      (kv) =>
        `<tr><th>${escapeHtml(kv.key)}</th><td>${escapeHtml(kv.value)}</td></tr>`,
    )
    .join("");
  return `<div class="mdc-frontmatter"><table>${rows}</table></div>`;
}

function parseSimpleFrontmatter(
  yaml: string,
): Array<{ key: string; value: string }> | null {
  const out: Array<{ key: string; value: string }> = [];
  const lines = yaml.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) return null; // indented = nested → fallback to pre
    if (line.trimStart().startsWith("#")) continue; // comment line
    const colon = line.indexOf(":");
    if (colon === -1) return null;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Inline JSON-style flow collections (`tags: [a, b]`, `meta: {x: 1}`)
    // need a real YAML parser to render meaningfully — fall back so the user
    // sees the raw block instead of the literal "[a, b]" string masquerading
    // as a value.
    if (
      (value.startsWith("[") && value.endsWith("]")) ||
      (value.startsWith("{") && value.endsWith("}"))
    ) {
      return null;
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function cryptoNonce(): string {
  let s = "";
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// -----------------------------------------------------------------------------
// Internal types
// -----------------------------------------------------------------------------

interface ResolvedComment extends Comment {
  start: number;
  end: number;
}

interface PreviewPayload {
  text: string;
  comments: ResolvedComment[];
  orphans: Comment[];
  readOnly: boolean;
}

interface ReplyMsg {
  type: "reply";
  commentId: string;
  body: string;
}

interface ResolveMsg {
  type: "toggleResolve";
  commentId: string;
  resolved: boolean;
}

interface CreateMsg {
  type: "create";
  selectedText: string;
  body: string;
}

interface DeleteMsg {
  type: "delete";
  commentId: string;
}

interface EditMsg {
  type: "edit";
  commentId: string;
  body: string;
}

interface EditReplyMsg {
  type: "editReply";
  commentId: string;
  replyIndex: number;
  body: string;
}

interface OpenLinkMsg {
  type: "openLink";
  href: string;
}
