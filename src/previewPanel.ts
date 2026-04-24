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
  ): void {
    const key = doc.uri.fsPath;
    const existing = PreviewPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "markdownCollabPreview",
      `Preview: ${path.basename(doc.uri.fsPath)}`,
      vscode.ViewColumn.Beside,
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

    this.disposables.push(
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
      this.output.appendLine(
        `Preview render failed: ${(e as Error).message}`,
      );
    }
  }

  private async buildPayload(): Promise<PreviewPayload> {
    const text = this.doc.getText();
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
body { font-family: var(--vscode-font-family, -apple-system, sans-serif); color: var(--vscode-foreground); padding: 1rem 2rem; line-height: 1.6; max-width: 960px; margin: 0 auto; }
code, pre { font-family: var(--vscode-editor-font-family, monospace); }
pre { background: var(--vscode-textCodeBlock-background, #1e1e1e); padding: 0.75rem; overflow-x: auto; border-radius: 4px; }
.mdc-anchor { background: rgba(255, 204, 0, 0.25); border-bottom: 2px solid rgba(255, 204, 0, 0.9); cursor: pointer; padding: 0 1px; }
.mdc-anchor.resolved { background: rgba(100, 200, 100, 0.15); border-bottom-color: rgba(100, 200, 100, 0.6); }
.mdc-badge { display: inline-block; font-size: 0.75em; padding: 0 4px; margin-left: 2px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); vertical-align: super; }
.mdc-toolbar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 0.5rem 0; z-index: 10; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 0.5rem; align-items: center; }
.mdc-toolbar button { padding: 0.25rem 0.75rem; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; }
.mdc-toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
.mdc-panel { position: fixed; right: 1rem; bottom: 1rem; width: 360px; max-height: 60vh; overflow-y: auto; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 0.75rem; box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: none; z-index: 20; }
.mdc-panel.open { display: block; }
.mdc-panel header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
.mdc-panel header h3 { margin: 0; font-size: 0.95em; }
.mdc-panel header button { background: none; color: var(--vscode-foreground); border: none; cursor: pointer; font-size: 1.1em; }
.mdc-msg { border-top: 1px solid var(--vscode-panel-border); padding: 0.5rem 0; font-size: 0.9em; }
.mdc-msg .author { font-weight: 600; }
.mdc-msg .ts { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 0.5rem; }
.mdc-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
.mdc-reply { width: 100%; box-sizing: border-box; min-height: 3rem; font-family: inherit; padding: 0.25rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
.mdc-orphans { margin-top: 2rem; padding: 0.5rem 0.75rem; border: 1px dashed var(--vscode-descriptionForeground); border-radius: 4px; }
.mdc-orphans h4 { margin: 0 0 0.5rem; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
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
.mdc-msg .mdc-msg-actions { margin-top: 0.25rem; display: flex; gap: 0.5rem; }
.mdc-msg .mdc-msg-actions button { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 0.8em; }
.mdc-msg .mdc-msg-actions button:hover { text-decoration: underline; }
.mdc-msg textarea.mdc-msg-edit { width: 100%; box-sizing: border-box; min-height: 3rem; font-family: inherit; padding: 0.25rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); margin-top: 0.25rem; }
</style>
</head><body>
<div class="mdc-toolbar">
  <span class="mdc-status" id="mdcStatus">${payload.readOnly ? "Read-only: sidecar has a newer schema version." : "Select text to add a comment."}</span>
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
${payload.orphans.length > 0 ? `<div class="mdc-orphans"><h4>Orphaned comments (${payload.orphans.length})</h4>${payload.orphans.map((o) => `<div class="mdc-msg"><span class="author">${escapeHtml(o.author)}</span>: ${escapeHtml(o.body)}</div>`).join("")}</div>` : ""}
<aside class="mdc-panel" id="mdcPanel">
  <header><h3 id="mdcPanelTitle"></h3><button id="mdcPanelClose">✕</button></header>
  <div id="mdcPanelBody"></div>
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
  const readOnly = ${payload.readOnly ? "true" : "false"};
  const byId = new Map(comments.map(c => [c.id, c]));
  const panel = document.getElementById("mdcPanel");
  const panelTitle = document.getElementById("mdcPanelTitle");
  const panelBody = document.getElementById("mdcPanelBody");
  const statusEl = document.getElementById("mdcStatus");
  let currentId = null;

  function openFor(id){
    const c = byId.get(id);
    if(!c) return;
    currentId = id;
    panelTitle.textContent = (c.resolved ? "[Resolved] " : "") + (c.author || "anon");
    const msgs = [{author: c.author, body: c.body, createdAt: c.createdAt, _isRoot: true}].concat((c.replies || []).map((r, i) => Object.assign({_replyIndex: i}, r)));
    const msgsHtml = msgs.map((m, i) => {
      const editable = !readOnly;
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
    const actions = readOnly ? "" :
      '<textarea class="mdc-reply" id="mdcReplyBox" placeholder="Reply..."></textarea>' +
      '<div class="mdc-actions">' +
        '<button id="mdcSendReply">Reply</button>' +
        '<button id="mdcToggleResolve">'+(c.resolved?"Reopen":"Resolve")+'</button>' +
        '<button id="mdcDelete" class="mdc-danger">Delete</button>' +
      '</div>';
    panelBody.innerHTML = msgsHtml + actions;
    panel.classList.add("open");
    if(!readOnly){
      document.getElementById("mdcSendReply").onclick = () => {
        const body = document.getElementById("mdcReplyBox").value.trim();
        if(!body) return;
        vscode.postMessage({type: "reply", commentId: currentId, body: body});
      };
      document.getElementById("mdcToggleResolve").onclick = () => {
        vscode.postMessage({type: "toggleResolve", commentId: currentId, resolved: !c.resolved});
      };
      document.getElementById("mdcDelete").onclick = () => {
        // Confirmation lives in the extension (VS Code native modal) because
        // webview confirm() is not reliable across hosts.
        vscode.postMessage({type: "delete", commentId: currentId});
      };
      // Per-message edit buttons: swap body for textarea, post an edit
      // message on save. The msgs array carries _isRoot / _replyIndex hints
      // so each row knows whether to edit the root body or a reply.
      Array.prototype.forEach.call(panelBody.querySelectorAll(".mdc-msg-edit"), function(btn){
        btn.addEventListener("click", function(){
          const idx = Number(btn.getAttribute("data-msg-idx"));
          const m = msgs[idx];
          const row = panelBody.querySelector('.mdc-msg[data-msg-idx="'+idx+'"]');
          if(!row) return;
          const bodyEl = row.querySelector(".mdc-msg-body");
          const actionsEl = row.querySelector(".mdc-msg-actions");
          const original = m.body || "";
          const ta = document.createElement("textarea");
          ta.className = "mdc-msg-edit";
          ta.value = original;
          bodyEl.replaceWith(ta);
          actionsEl.innerHTML = '<button class="mdc-msg-save">Save</button><button class="mdc-msg-cancel">Cancel</button>';
          setTimeout(function(){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
          const rerender = function(){ openFor(currentId); };
          actionsEl.querySelector(".mdc-msg-save").onclick = function(){
            const next = ta.value;
            if(next === original){ rerender(); return; }
            const payload = m._isRoot
              ? { type: "edit", commentId: currentId, body: next }
              : { type: "editReply", commentId: currentId, replyIndex: m._replyIndex, body: next };
            vscode.postMessage(payload);
          };
          actionsEl.querySelector(".mdc-msg-cancel").onclick = rerender;
          ta.addEventListener("keydown", function(e){
            if(e.key === "Escape") rerender();
            else if(e.key === "Enter" && (e.metaKey || e.ctrlKey)) actionsEl.querySelector(".mdc-msg-save").click();
          });
        });
      });
    }
  }

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[ch])); }
  function fmt(iso){ if(!iso) return ""; const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleString(); }

  document.getElementById("mdcPanelClose").onclick = () => { panel.classList.remove("open"); currentId = null; };

  document.addEventListener("click", (e) => {
    const el = e.target.closest ? e.target.closest(".mdc-anchor") : null;
    if(el && el.dataset.commentId) openFor(el.dataset.commentId);
  });

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
    // Render the full document once so block structure (paragraphs, lists,
    // headings) is preserved. Post-process the resulting HTML to wrap each
    // anchor's rendered inline form in a highlight span. Splitting the source
    // at anchor offsets and re-rendering each slice would break paragraphs
    // into multiple <p> blocks around the anchor.
    let html = this.md.render(payload.text);
    if (payload.comments.length === 0) return html;

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
    return html;
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

  private async onReply(msg: ReplyMsg): Promise<void> {
    const p = this.sidecarPath();
    if (!p) return;
    await addReply(p, msg.commentId, {
      author: "user",
      body: msg.body,
      createdAt: new Date().toISOString(),
    });
    await this.render();
  }

  private async onEdit(msg: EditMsg): Promise<void> {
    const p = this.sidecarPath();
    if (!p) return;
    if (!msg.body || !msg.body.trim()) return;
    await editCommentBody(p, msg.commentId, msg.body);
    await this.render();
  }

  private async onEditReply(msg: EditReplyMsg): Promise<void> {
    const p = this.sidecarPath();
    if (!p) return;
    if (!msg.body || !msg.body.trim()) return;
    await editReplyBody(p, msg.commentId, msg.replyIndex, msg.body);
    await this.render();
  }

  private async onDelete(msg: DeleteMsg): Promise<void> {
    const p = this.sidecarPath();
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
    const p = this.sidecarPath();
    if (!p) return;
    await setResolved(p, msg.commentId, msg.resolved);
    await this.render();
  }

  private async onCreate(msg: CreateMsg): Promise<void> {
    const p = this.sidecarPath();
    const folder = vscode.workspace.getWorkspaceFolder(this.doc.uri);
    if (!p || !folder) return;
    if (!msg.body || !msg.body.trim()) return;
    const text = this.doc.getText();
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
function wrapFirstOutsideTags(
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
function isInsideTag(html: string, offset: number): boolean {
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
