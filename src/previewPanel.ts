import * as path from "path";
import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import { resolve as resolveAnchor } from "./anchor";
import {
  addComment,
  addReply,
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

  public static show(doc: vscode.TextDocument, output: vscode.OutputChannel): void {
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
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new PreviewPanel(panel, doc, output);
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
  ) {
    this.md = new MarkdownIt({ html: false, linkify: true, breaks: false });

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
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
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
</style>
</head><body>
<div class="mdc-toolbar">
  <button id="mdcNew" ${payload.readOnly ? "disabled" : ""}>Add Comment from Selection</button>
  <span class="mdc-status" id="mdcStatus">${payload.readOnly ? "Read-only: sidecar has a newer schema version." : ""}</span>
</div>
<div id="mdcContent">${body}</div>
${payload.orphans.length > 0 ? `<div class="mdc-orphans"><h4>Orphaned comments (${payload.orphans.length})</h4>${payload.orphans.map((o) => `<div class="mdc-msg"><span class="author">${escapeHtml(o.author)}</span>: ${escapeHtml(o.body)}</div>`).join("")}</div>` : ""}
<aside class="mdc-panel" id="mdcPanel">
  <header><h3 id="mdcPanelTitle"></h3><button id="mdcPanelClose">✕</button></header>
  <div id="mdcPanelBody"></div>
</aside>
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
    const msgs = [{author: c.author, body: c.body, createdAt: c.createdAt}].concat(c.replies || []);
    const msgsHtml = msgs.map(m => '<div class="mdc-msg"><span class="author">'+esc(m.author)+'</span><span class="ts">'+esc(fmt(m.createdAt))+'</span><div>'+esc(m.body)+'</div></div>').join("");
    const actions = readOnly ? "" :
      '<textarea class="mdc-reply" id="mdcReplyBox" placeholder="Reply..."></textarea>' +
      '<div class="mdc-actions">' +
        '<button id="mdcSendReply">Reply</button>' +
        '<button id="mdcToggleResolve">'+(c.resolved?"Reopen":"Resolve")+'</button>' +
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
    }
  }

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[ch])); }
  function fmt(iso){ if(!iso) return ""; const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleString(); }

  document.getElementById("mdcPanelClose").onclick = () => { panel.classList.remove("open"); currentId = null; };

  document.addEventListener("click", (e) => {
    const el = e.target.closest ? e.target.closest(".mdc-anchor") : null;
    if(el && el.dataset.commentId) openFor(el.dataset.commentId);
  });

  document.getElementById("mdcNew").onclick = () => {
    if(readOnly) return;
    const sel = window.getSelection();
    if(!sel || sel.isCollapsed){
      statusEl.textContent = "Select some rendered text first.";
      return;
    }
    const selected = sel.toString();
    if(selected.trim().length < 3){
      statusEl.textContent = "Selection too short.";
      return;
    }
    const body = prompt("Comment body:");
    if(!body) return;
    statusEl.textContent = "Creating comment...";
    vscode.postMessage({type: "create", selectedText: selected, body: body});
  };

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if(m && m.type === "status") statusEl.textContent = m.text || "";
  });
})();
</script>
</body></html>`;
  }

  private renderBodyWithHighlights(payload: PreviewPayload): string {
    // We tokenize the doc into non-overlapping pieces: comment anchors vs
    // surrounding prose, render each piece through markdown-it separately, and
    // stitch the results. This is intentionally simple — block-level tokens
    // that straddle comment boundaries will render twice as independent blocks.
    // For inline anchors (the common case) it produces correct output.
    const { text, comments } = payload;
    if (comments.length === 0) {
      return this.md.render(text);
    }

    // Drop overlapping comments on render: prefer the earliest-start/longest
    // one. Overlapping anchors can't be represented as nested spans without
    // broken HTML, and overlap is already a sidecar-edge-case.
    const nonOverlap: ResolvedComment[] = [];
    let cursor = 0;
    for (const c of comments) {
      if (c.start < cursor) continue;
      nonOverlap.push(c);
      cursor = c.end;
    }

    const parts: string[] = [];
    let pos = 0;
    for (const c of nonOverlap) {
      if (c.start > pos) {
        parts.push(this.md.render(text.slice(pos, c.start)));
      }
      const anchored = this.md.renderInline(text.slice(c.start, c.end));
      const cls = "mdc-anchor" + (c.resolved ? " resolved" : "");
      const badge = c.replies.length > 0 ? `<span class="mdc-badge">${c.replies.length + 1}</span>` : "";
      parts.push(
        `<span class="${cls}" data-comment-id="${escapeAttr(c.id)}" title="${escapeAttr(truncate(c.body, 120))}">${anchored}${badge}</span>`,
      );
      pos = c.end;
    }
    if (pos < text.length) {
      parts.push(this.md.render(text.slice(pos)));
    }
    return parts.join("");
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string };
    try {
      if (m.type === "reply") await this.onReply(msg as ReplyMsg);
      else if (m.type === "toggleResolve") await this.onToggleResolve(msg as ResolveMsg);
      else if (m.type === "create") await this.onCreate(msg as CreateMsg);
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
    const text = this.doc.getText();
    // Locate the selected rendered text back in the raw source. Exact match
    // preferred; fall back to whitespace-normalized search using the same
    // strategy the anchor resolver uses in reverse. Reject if ambiguous —
    // the user can switch to the source editor for finer control.
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
