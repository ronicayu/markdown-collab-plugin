/**
 * Preview-mode PR review surface. Renders the head-side markdown of a
 * changed file in a webview, paints a left stripe along any rendered
 * block whose source byte range overlaps an added-line range from the
 * PR diff, and lets the reviewer select prose to draft a PR comment.
 *
 * Storage stays with `PrReviewController` (workspaceState drafts). This
 * panel is a UI layer over the same draft store the legacy source-mode
 * CommentController used.
 *
 * One panel per (file, PR) pair, keyed by `${prKey}:${relPath}`.
 */

import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import {
  addedLineRanges,
  type LineRange,
} from "./diff";
import type {
  ExistingPrComment,
  PrContext,
  PrDraft,
  ReviewVerdict,
} from "./types";

interface DraftHost {
  ctx: PrContext;
  getDraftsFor(relPath: string): PrDraft[];
  getAllDrafts(): PrDraft[];
  addDraft(draft: Omit<PrDraft, "id" | "createdAt">): Promise<PrDraft>;
  updateDraftBody(id: string, body: string): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  submit(verdict: ReviewVerdict, body: string | undefined): Promise<void>;
  getExistingCommentsFor(relPath: string): Promise<ExistingPrComment[]>;
}

interface InitMessage {
  type: "init";
  fileName: string;
  source: string;
  addedRanges: LineRange[];
  drafts: PrDraft[];
  totalDraftCount: number;
  imageBaseUris: { docDir: string; workspaceFolder: string | null };
  plantuml: { serverUrl: string; format: "svg" | "png" };
}

interface UpdateDraftsMessage {
  type: "drafts";
  drafts: PrDraft[];
  totalDraftCount: number;
}

interface ExistingCommentsMessage {
  type: "existing-comments";
  comments: ExistingPrComment[];
}

interface SubmitRequest {
  type: "submit";
  verdict: ReviewVerdict;
  body?: string;
}


interface AddDraftRequest {
  type: "add-draft";
  startLine: number;
  endLine: number;
  body: string;
}

interface EditDraftRequest {
  type: "edit-draft";
  id: string;
  body: string;
}

interface DeleteDraftRequest {
  type: "delete-draft";
  id: string;
}

interface ReadyMessage {
  type: "ready";
}

type ClientToHost =
  | ReadyMessage
  | AddDraftRequest
  | EditDraftRequest
  | DeleteDraftRequest
  | SubmitRequest;

const VIEW_TYPE = "markdownCollab.prReviewView";
const panels = new Map<string, PrReviewPanel>();

export class PrReviewPanel {
  static reveal(
    context: vscode.ExtensionContext,
    host: DraftHost,
    relPath: string,
  ): void {
    const key = `${prKeyFor(host.ctx)}::${relPath}`;
    const existing = panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const fullPath = path.join(host.ctx.repoRoot, relPath);
    const fileUri = vscode.Uri.file(fullPath);
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `PR review — ${relPath}`,
      { viewColumn: column === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : column, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "out", "pr", "webview"),
          vscode.Uri.joinPath(context.extensionUri, "out", "inlineComments"),
          vscode.Uri.joinPath(context.extensionUri, "node_modules", "mermaid", "dist"),
          ...(folder ? [folder.uri] : [vscode.Uri.file(path.dirname(fullPath))]),
        ],
      },
    );
    const instance = new PrReviewPanel(context, panel, host, fileUri, relPath, key);
    panels.set(key, instance);
  }

  /** Notify any open panels that drafts changed (e.g. from a different surface). */
  static notifyDraftsChanged(prCtx: PrContext, host: DraftHost): void {
    const prefix = `${prKeyFor(prCtx)}::`;
    for (const [k, p] of panels) {
      if (k.startsWith(prefix)) void p.pushDrafts(host);
    }
  }

  /**
   * Fully re-render every open panel for this PR — re-reads the file from
   * disk, recomputes diff ranges, and re-fetches platform comments. Used by
   * the Changed Files refresh button. The caller is responsible for clearing
   * any cached comments on the shared host first.
   */
  static refreshAll(prCtx: PrContext): void {
    const prefix = `${prKeyFor(prCtx)}::`;
    for (const [k, p] of panels) {
      if (k.startsWith(prefix)) void p.pushInit();
    }
  }

  /** Close every open panel for a PR context — used when a review restarts on a new branch. */
  static closeForContext(prCtx: PrContext): void {
    const prefix = `${prKeyFor(prCtx)}::`;
    // Snapshot first: dispose() mutates `panels`.
    for (const [k, p] of [...panels]) {
      if (k.startsWith(prefix)) p.dispose();
    }
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    readonly panel: vscode.WebviewPanel,
    private readonly host: DraftHost,
    private readonly fileUri: vscode.Uri,
    private readonly relPath: string,
    private readonly key: string,
  ) {
    panel.webview.html = this.renderHtml();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: ClientToHost) => this.handle(msg)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private async pushInit(): Promise<void> {
    const sourceBytes = await vscode.workspace.fs.readFile(this.fileUri);
    const source = Buffer.from(sourceBytes).toString("utf8");
    const ranges = await addedLineRanges(
      this.host.ctx.repoRoot,
      `origin/${this.host.ctx.baseRef}`,
      this.relPath,
    );
    const folder = vscode.workspace.getWorkspaceFolder(this.fileUri);
    const docDir = vscode.Uri.file(path.dirname(this.fileUri.fsPath));
    const msg: InitMessage = {
      type: "init",
      fileName: this.relPath,
      source,
      addedRanges: ranges,
      drafts: this.host.getDraftsFor(this.relPath),
      totalDraftCount: this.host.getAllDrafts().length,
      imageBaseUris: {
        docDir: this.panel.webview.asWebviewUri(docDir).toString(),
        workspaceFolder: folder ? this.panel.webview.asWebviewUri(folder.uri).toString() : null,
      },
      plantuml: readPlantumlConfig(),
    };
    await this.panel.webview.postMessage(msg);
    // Existing comments arrive after init so the preview renders fast;
    // they show up in the sidebar once the API call settles.
    void this.host.getExistingCommentsFor(this.relPath).then(async (comments) => {
      const m: ExistingCommentsMessage = { type: "existing-comments", comments };
      await this.panel.webview.postMessage(m);
    });
  }

  private async pushDrafts(host: DraftHost): Promise<void> {
    const msg: UpdateDraftsMessage = {
      type: "drafts",
      drafts: host.getDraftsFor(this.relPath),
      totalDraftCount: host.getAllDrafts().length,
    };
    await this.panel.webview.postMessage(msg);
  }

  private async handle(msg: ClientToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        return this.pushInit();
      case "add-draft": {
        await this.host.addDraft({
          path: this.relPath,
          body: msg.body,
          line: msg.endLine,
          side: "RIGHT",
          startLine: msg.startLine === msg.endLine ? undefined : msg.startLine,
        });
        return this.pushDrafts(this.host);
      }
      case "edit-draft":
        await this.host.updateDraftBody(msg.id, msg.body);
        return this.pushDrafts(this.host);
      case "delete-draft":
        await this.host.deleteDraft(msg.id);
        return this.pushDrafts(this.host);
      case "submit":
        return this.host.submit(msg.verdict, msg.body);
    }
  }

  private renderHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "pr", "webview", "client.js"),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "pr", "webview", "client.css"),
    );
    const mermaidUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "mermaid", "dist", "mermaid.min.js"),
    );
    const cspSource = this.panel.webview.cspSource;
    const csp =
      `default-src 'none'; ` +
      `style-src ${cspSource} 'unsafe-inline'; ` +
      `script-src ${cspSource} 'unsafe-eval'; ` +
      `img-src ${cspSource} https: http: data:; ` +
      `font-src ${cspSource} data:;`;
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
<title>PR review</title>
</head>
<body>
<div id="app">
  <div id="preview-pane">
    <header id="preview-header">
      <h2 id="file-name"></h2>
      <p class="hint">Select prose to draft a review comment. Lines with a side stripe are part of this PR's diff.</p>
    </header>
    <article id="preview"></article>
    <button id="floating-add" hidden>+ Comment on selection</button>
  </div>
  <aside id="drafts-pane">
    <header id="drafts-header">
      <div class="title-row">
        <h2>Drafts</h2>
        <span id="draft-count"></span>
      </div>
      <p class="hint">Click a draft to jump to its line.</p>
    </header>
    <div id="drafts-list"></div>
    <div id="composer" hidden></div>
    <section id="existing-section" hidden>
      <h3 class="section-title">Existing comments</h3>
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
</div>
<script src="${mermaidUri}"></script>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this.disposables.length = 0;
    panels.delete(this.key);
    try { this.panel.dispose(); } catch { /* ignore */ }
  }
}

function readPlantumlConfig(): { serverUrl: string; format: "svg" | "png" } {
  const cfg = vscode.workspace.getConfiguration("markdownCollab");
  return {
    serverUrl: cfg.get<string>("plantuml.serverUrl") ?? "https://www.plantuml.com/plantuml",
    format: cfg.get<"svg" | "png">("plantuml.format") ?? "svg",
  };
}

function prKeyFor(ctx: PrContext): string {
  const h = crypto.createHash("sha1");
  h.update(ctx.remoteUrl);
  h.update("\0");
  h.update(ctx.baseSha);
  h.update("\0");
  h.update(ctx.headSha);
  return h.digest("hex").slice(0, 16);
}
