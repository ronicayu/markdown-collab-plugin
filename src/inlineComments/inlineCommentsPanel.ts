// Webview panel for the "inline comments stored in the markdown itself"
// view — the default storage layout in v0.27+. One panel per file. The
// panel:
//
//   - reads the .md file (via the open TextDocument), parses it for
//     `<!--mc:...-->` markers and the threads region
//   - posts the parsed state to the webview client
//   - listens for CRUD messages from the client and applies them via a
//     WorkspaceEdit so the user's normal undo/redo + dirty state work
//   - re-parses + re-pushes when the document changes (whether from this
//     panel, the text editor, or an external write)
//
// Intentionally separate from the existing sidecar-based system: this is
// a standalone experiment, not an integration. No coupling to
// commentController, sidecar, or the y-websocket relay.

import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  addThread,
  appendReply,
  parse,
  replaceThread,
  type InlineComment,
  type InlineThread,
  type ParsedDocument,
} from "./format";
import { buildInlinePayload } from "./sendToClaude";
import type { ReviewPayload } from "../sendToClaude";

interface InitMessage {
  type: "init";
  fileName: string;
  state: SerializedState;
  user: { name: string };
  /**
   * Webview-loadable URIs the client uses to rewrite relative image
   * src attributes. Without this every `![alt](foo.png)` would resolve
   * against the webview's own origin and 404.
   */
  imageBaseUris: {
    /** Directory containing the .md file, as a `vscode-webview://…` URI. */
    docDir: string;
    /** Workspace folder root, as a `vscode-webview://…` URI. Used for `/abs.png` style refs. */
    workspaceFolder: string | null;
  };
}

interface UpdateMessage {
  type: "update";
  state: SerializedState;
}

interface AddCommentRequest {
  type: "add-comment";
  selStart: number;
  selEnd: number;
  body: string;
}

interface ReplyRequest {
  type: "reply";
  threadId: string;
  body: string;
  parentCommentId?: string;
}

interface EditRequest {
  type: "edit-comment";
  threadId: string;
  commentId: string;
  body: string;
}

interface ToggleResolveRequest {
  type: "toggle-resolve";
  threadId: string;
}

interface DeleteThreadRequest {
  type: "delete-thread";
  threadId: string;
}

interface DeleteCommentRequest {
  type: "delete-comment";
  threadId: string;
  commentId: string;
}

interface ReadyMessage {
  type: "ready";
}

interface SendToClaudeRequest {
  type: "send-to-claude";
}

interface CopyPromptRequest {
  type: "copy-prompt";
}

type ClientMessage =
  | ReadyMessage
  | AddCommentRequest
  | ReplyRequest
  | EditRequest
  | ToggleResolveRequest
  | DeleteThreadRequest
  | DeleteCommentRequest
  | SendToClaudeRequest
  | CopyPromptRequest;

/** Dependencies the panel needs from the extension host (kept narrow so tests can stub them). */
export interface InlinePanelDeps {
  /**
   * Route an inline-comments payload through the user's configured send
   * mode (terminal / channel / mcp-channel / clipboard, with the same
   * ask-once-and-remember UX as the sidecar path). Wired in
   * extension.ts so the panel doesn't need to know about transports.
   */
  dispatchToClaude: (payload: ReviewPayload) => Promise<void>;
}

/** Serializable view of `ParsedDocument` for the webview. */
export interface SerializedState {
  /** Markdown source with anchor markers AND threads region stripped — what the preview renders. */
  prose: string;
  /**
   * Per-thread anchor mapped into prose-offset space. `null` if the thread
   * has no paired markers (unanchored — show with a "broken anchor" badge).
   */
  threads: Array<{
    id: string;
    quote: string;
    status: "open" | "resolved";
    resolvedBy?: string;
    resolvedTs?: string;
    comments: InlineComment[];
    /** Position in `prose` (offset-into-stripped-source). Null when unanchored. */
    anchor: { proseStart: number; proseEnd: number } | null;
  }>;
}

const VIEW_TYPE = "markdownCollab.inlineCommentsView";

const panels = new Map<string, InlineCommentsPanel>();

/**
 * Build the localResourceRoots that let the webview load mermaid +
 * inline-comments assets AND any images sitting next to (or anywhere
 * under) the markdown file.
 */
function imageResourceRoots(
  context: vscode.ExtensionContext,
  doc: vscode.TextDocument,
): vscode.Uri[] {
  const roots: vscode.Uri[] = [
    vscode.Uri.joinPath(context.extensionUri, "out", "inlineComments"),
    vscode.Uri.joinPath(context.extensionUri, "node_modules", "mermaid", "dist"),
  ];
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (folder) {
    roots.push(folder.uri);
  } else {
    // No workspace folder — at least grant access to the file's own
    // directory so sibling images resolve.
    const dir = vscode.Uri.file(path.dirname(doc.uri.fsPath));
    roots.push(dir);
  }
  return roots;
}

export class InlineCommentsPanel {
  static reveal(context: vscode.ExtensionContext, doc: vscode.TextDocument, deps: InlinePanelDeps): void {
    const key = doc.uri.toString();
    const existing = panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Inline Comments — ${vscode.workspace.asRelativePath(doc.uri)}`,
      { viewColumn: column === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : column, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: imageResourceRoots(context, doc),
      },
    );
    panels.set(key, new InlineCommentsPanel(context, doc, panel, deps, () => panels.delete(key)));
  }

  private readonly disposables: vscode.Disposable[] = [];
  private pendingApply = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly doc: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: InlinePanelDeps,
    private readonly onDispose: () => void,
  ) {
    panel.webview.html = this.renderHtml();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => void this.handleMessage(m as ClientMessage)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== this.doc.uri.toString()) return;
        if (this.pendingApply) return;
        void this.pushState();
      }),
      panel,
    );
    panel.onDidDispose(() => this.dispose());
  }

  private renderHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "inlineComments", "client.js"),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "inlineComments", "client.css"),
    );
    const mermaidUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "mermaid", "dist", "mermaid.min.js"),
    );
    const cspSource = this.panel.webview.cspSource;
    // `unsafe-eval` is required because mermaid's bundled DOMPurify uses
    // `Function()` under the hood for its config parsing. img-src allows
    // data: URIs because mermaid emits foreignObject contents that can
    // reference inline images.
    // img-src widened so the rendered preview can show:
    //   - workspace-relative images via asWebviewUri (the `${cspSource}` slot)
    //   - external http(s) images (e.g. badges, hosted screenshots)
    //   - inline data: URIs
    // matches VSCode's built-in markdown preview behavior.
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
<title>Inline Comments</title>
</head>
<body>
<div id="app">
  <div id="preview-pane">
    <header id="preview-header">
      <h2 id="file-name"></h2>
      <p class="hint">Select text in the preview, then press <kbd>C</kbd> or use the floating button to add a comment.</p>
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
        <button id="collapse-threads" class="btn-link" title="Hide comments panel" aria-label="Hide comments panel">›</button>
      </div>
      <div class="filter-row">
        <label><input type="radio" name="filter" value="open" checked> Open</label>
        <label><input type="radio" name="filter" value="all"> All</label>
        <label><input type="radio" name="filter" value="resolved"> Resolved</label>
        <button id="send-to-claude" title="Send the prompt to a running Claude terminal (or your configured send mode).">Send to Claude</button>
        <button id="copy-prompt" class="btn-ghost" title="Copy the prompt to your clipboard.">Copy</button>
      </div>
    </header>
    <div id="threads-list"></div>
    <div id="composer" hidden></div>
  </aside>
</div>
<script src="${mermaidUri}"></script>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async handleMessage(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.pushInit();
        return;
      case "add-comment":
        return this.applyMutation((parsed) => {
          // Selection arrives in *prose* (stripped) offset space. Map it
          // back to source-offset space before inserting markers.
          const { proseStartToSource, proseEndToSource } = mapProseToSource(parsed);
          const sStart = proseStartToSource(msg.selStart);
          const sEnd = proseEndToSource(msg.selEnd);
          if (sStart === null || sEnd === null) {
            void vscode.window.showWarningMessage("Could not map selection back to source — try selecting again.");
            return parsed.source;
          }
          if (sStart === sEnd) {
            void vscode.window.showWarningMessage("Select some text to anchor the comment to.");
            return parsed.source;
          }
          const author = this.resolveAuthor();
          const { source } = addThread(parsed.source, sStart, sEnd, { author, body: msg.body });
          return source;
        });
      case "reply":
        return this.applyMutation((parsed) => {
          const t = parsed.threads.find((x) => x.id === msg.threadId);
          if (!t) return parsed.source;
          const author = this.resolveAuthor();
          const next = appendReply(t, { author, body: msg.body, parent: msg.parentCommentId });
          return replaceThread(parsed.source, t.id, next);
        });
      case "edit-comment":
        return this.applyMutation((parsed) => {
          const t = parsed.threads.find((x) => x.id === msg.threadId);
          if (!t) return parsed.source;
          const ts = new Date().toISOString();
          const next: InlineThread = {
            ...t,
            comments: t.comments.map((c) =>
              c.id === msg.commentId ? { ...c, body: msg.body, editedTs: ts } : c,
            ),
          };
          return replaceThread(parsed.source, t.id, next);
        });
      case "toggle-resolve":
        return this.applyMutation((parsed) => {
          const t = parsed.threads.find((x) => x.id === msg.threadId);
          if (!t) return parsed.source;
          const next: InlineThread =
            t.status === "open"
              ? { ...t, status: "resolved", resolvedBy: this.resolveAuthor(), resolvedTs: new Date().toISOString() }
              : { ...t, status: "open", resolvedBy: undefined, resolvedTs: undefined };
          return replaceThread(parsed.source, t.id, next);
        });
      case "send-to-claude":
        return this.handleSendToClaude();
      case "copy-prompt":
        return this.handleCopyPrompt();
      case "delete-thread":
        return this.applyMutation((parsed) => replaceThread(parsed.source, msg.threadId, null));
      case "delete-comment":
        return this.applyMutation((parsed) => {
          const t = parsed.threads.find((x) => x.id === msg.threadId);
          if (!t) return parsed.source;
          // If the comment has descendants (replies), tombstone to keep the
          // tree shape. If it's a leaf, drop it entirely. If removing it
          // leaves the thread empty, delete the whole thread.
          const hasChildren = t.comments.some((c) => c.parent === msg.commentId && !c.deleted);
          let nextComments: InlineComment[];
          if (hasChildren) {
            nextComments = t.comments.map((c) =>
              c.id === msg.commentId ? { ...c, deleted: true, body: "" } : c,
            );
          } else {
            nextComments = t.comments.filter((c) => c.id !== msg.commentId);
          }
          const liveCount = nextComments.filter((c) => !c.deleted).length;
          if (liveCount === 0) {
            return replaceThread(parsed.source, t.id, null);
          }
          return replaceThread(parsed.source, t.id, { ...t, comments: nextComments });
        });
    }
  }

  private async handleSendToClaude(): Promise<void> {
    const payload = buildInlinePayload(this.doc);
    if (!payload) {
      void vscode.window.showInformationMessage(
        "Inline comments: no open threads to send.",
      );
      return;
    }
    // Route through the shared dispatcher so the inline view honors the
    // user's `markdownCollab.sendMode` setting (terminal / channel /
    // mcp-channel / clipboard) the same way the sidecar-based command
    // does. Terminal is the natural default — drops the prompt straight
    // into a running Claude REPL via bracketed paste.
    await this.deps.dispatchToClaude(payload);
  }

  private async handleCopyPrompt(): Promise<void> {
    const payload = buildInlinePayload(this.doc);
    if (!payload) {
      void vscode.window.showInformationMessage(
        "Inline comments: no open threads to copy.",
      );
      return;
    }
    await vscode.env.clipboard.writeText(payload.prompt);
    void vscode.window.showInformationMessage(
      `Inline comments: prompt for ${payload.unresolvedCount} open thread${payload.unresolvedCount === 1 ? "" : "s"} copied to clipboard.`,
    );
  }

  private resolveAuthor(): string {
    const cfg = vscode.workspace.getConfiguration("markdownCollab");
    return cfg.get<string>("collab.userName", "") || os.userInfo().username || "anonymous";
  }

  private async applyMutation(fn: (parsed: ParsedDocument) => string): Promise<void> {
    const parsed = parse(this.doc.getText());
    const next = fn(parsed);
    if (next === parsed.source) return;
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      this.doc.positionAt(0),
      this.doc.positionAt(this.doc.getText().length),
    );
    edit.replace(this.doc.uri, fullRange, next);
    this.pendingApply = true;
    try {
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        void vscode.window.showErrorMessage("Inline comments: edit failed to apply.");
        return;
      }
      // The inline-comments format treats the .md file as the source of
      // truth. Mutations from this panel are review actions (add / reply /
      // resolve / delete) — the user expects them to persist immediately,
      // not sit in an unsaved buffer. Save right after every successful
      // apply. If the user has other pending edits in the text editor,
      // those flush with this save too — same as a manual Cmd+S would do.
      try {
        const saved = await this.doc.save();
        if (!saved) {
          void vscode.window.showWarningMessage(
            "Inline comments: comment applied but the file could not be saved.",
          );
        }
      } catch (e) {
        void vscode.window.showWarningMessage(
          `Inline comments: comment applied but save failed: ${(e as Error).message}`,
        );
      }
    } finally {
      this.pendingApply = false;
    }
    await this.pushState();
  }

  private async pushInit(): Promise<void> {
    const state = serialize(parse(this.doc.getText()));
    const docDirUri = vscode.Uri.file(path.dirname(this.doc.uri.fsPath));
    const folder = vscode.workspace.getWorkspaceFolder(this.doc.uri);
    const msg: InitMessage = {
      type: "init",
      fileName: vscode.workspace.asRelativePath(this.doc.uri),
      state,
      user: { name: this.resolveAuthor() },
      imageBaseUris: {
        docDir: this.panel.webview.asWebviewUri(docDirUri).toString(),
        workspaceFolder: folder ? this.panel.webview.asWebviewUri(folder.uri).toString() : null,
      },
    };
    await this.panel.webview.postMessage(msg);
  }

  private async pushState(): Promise<void> {
    const state = serialize(parse(this.doc.getText()));
    const msg: UpdateMessage = { type: "update", state };
    await this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.length = 0;
    this.onDispose();
  }
}

/**
 * Build a map from prose offsets (the source with all `mc:` markup
 * stripped) back to source offsets. Plus the serialized state with
 * per-thread anchor positions in prose space.
 */
function mapProseToSource(parsed: ParsedDocument): {
  prose: string;
  /** Map a *start* prose offset (inclusive boundary) to a source offset. */
  proseStartToSource: (proseOffset: number) => number | null;
  /** Map an *end* prose offset (exclusive boundary) to a source offset. */
  proseEndToSource: (proseOffset: number) => number | null;
  anchorsInProse: Map<string, { proseStart: number; proseEnd: number }>;
} {
  const src = parsed.source;
  // Build a list of "skip" intervals (every mc marker + the entire
  // threads region). We then walk src and emit a position map.
  const skips: Array<[number, number]> = [];
  for (const a of parsed.anchors.values()) {
    skips.push([a.openStart, a.openEnd]);
    skips.push([a.closeStart, a.closeEnd]);
  }
  if (parsed.threadsRegion) {
    // Also eat one trailing newline before the region so we don't leave a
    // stray blank line floating in the preview.
    const start = parsed.threadsRegion.start > 0 && src[parsed.threadsRegion.start - 1] === "\n"
      ? parsed.threadsRegion.start - 1
      : parsed.threadsRegion.start;
    skips.push([start, parsed.threadsRegion.end]);
  }
  skips.sort((a, b) => a[0] - b[0]);

  // proseIndexToSourceIndex[i] = source offset corresponding to prose offset i.
  // Length = prose.length + 1 so end-of-string maps too.
  const proseChars: string[] = [];
  const proseToSrc: number[] = [];
  let skipIdx = 0;
  for (let i = 0; i < src.length; i++) {
    while (skipIdx < skips.length && i >= skips[skipIdx][1]) skipIdx++;
    if (skipIdx < skips.length && i >= skips[skipIdx][0] && i < skips[skipIdx][1]) {
      continue;
    }
    proseToSrc.push(i);
    proseChars.push(src[i]);
  }
  proseToSrc.push(src.length);
  const prose = proseChars.join("");

  // Per-thread anchor in prose space: openEnd maps to the prose offset
  // of the first character after the open marker.
  const anchorsInProse = new Map<string, { proseStart: number; proseEnd: number }>();
  for (const [id, range] of parsed.anchors) {
    // Find prose indices for the source positions just after open marker
    // and just before close marker. Since markers were skipped, the prose
    // index for source offset openEnd is the first proseToSrc[p] === openEnd.
    const ps = findProseIndex(proseToSrc, range.openEnd);
    const pe = findProseIndex(proseToSrc, range.closeStart);
    if (ps !== null && pe !== null) {
      anchorsInProse.set(id, { proseStart: ps, proseEnd: pe });
    }
  }

  return {
    prose,
    anchorsInProse,
    proseStartToSource: (proseOffset: number) => {
      if (proseOffset < 0 || proseOffset > proseToSrc.length - 1) return null;
      return proseToSrc[proseOffset];
    },
    proseEndToSource: (proseOffset: number) => {
      if (proseOffset < 0 || proseOffset > proseToSrc.length - 1) return null;
      // End boundary: anchor "just past the last selected char". If the
      // next prose char lives across a skipped region we still want to
      // anchor immediately after the last *selected* source char rather
      // than swallowing the markers.
      if (proseOffset === 0) return proseToSrc[0];
      return proseToSrc[proseOffset - 1] + 1;
    },
  };
}

function findProseIndex(proseToSrc: number[], srcOffset: number): number | null {
  // Linear scan is fine for review-sized docs. Switch to binary search if
  // anyone complains.
  for (let i = 0; i < proseToSrc.length; i++) {
    if (proseToSrc[i] === srcOffset) return i;
    if (proseToSrc[i] > srcOffset) return i; // Marker boundary collapse — closest prose index.
  }
  return null;
}

export function serialize(parsed: ParsedDocument): SerializedState {
  const { prose, anchorsInProse } = mapProseToSource(parsed);
  return {
    prose,
    threads: parsed.threads.map((t) => {
      const a = anchorsInProse.get(t.id);
      return {
        id: t.id,
        quote: t.quote,
        status: t.status,
        resolvedBy: t.resolvedBy,
        resolvedTs: t.resolvedTs,
        comments: t.comments,
        anchor: a ? { proseStart: a.proseStart, proseEnd: a.proseEnd } : null,
      };
    }),
  };
}
