import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { isAnchorTextValid } from "../anchor";
import {
  addComment as addCommentToSidecar,
  addReply as addReplyToSidecar,
  deleteComment as deleteCommentFromSidecar,
  loadSidecar,
  setResolved as setResolvedInSidecar,
  sidecarPathFor,
} from "../sidecar";
import type { Anchor, Comment } from "../types";
import { classifyLink } from "./linkRouter";
import { isExternalLinkSafe } from "./urlAllowlist";

const VIEW_TYPE = "markdownCollab.collabEditor";

interface CommentSummary {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  anchor: { text: string; contextBefore: string; contextAfter: string };
  replies: Array<{ author: string; body: string; createdAt: string }>;
}

interface InitPayload {
  type: "init";
  text: string;
  room: string;
  serverUrl: string;
  user: { name: string; color: string };
  comments: CommentSummary[];
}

interface SidecarChangedPayload {
  type: "sidecar-changed";
  comments: CommentSummary[];
}

interface EditMessage {
  type: "edit";
  text: string;
}

interface ReadyMessage {
  type: "ready";
}

interface ReadyWithContentMessage {
  type: "ready-with-content";
  length: number;
  synced: boolean;
  error?: string;
}

interface WebviewErrorMessage {
  type: "webview-error";
  stage: string;
  message: string;
}

interface AddCommentMessage {
  type: "add-comment";
  anchor: { text: string; contextBefore: string; contextAfter: string };
  body: string;
}

interface ReplyCommentMessage {
  type: "reply-comment";
  commentId: string;
  body: string;
}

interface ToggleResolveCommentMessage {
  type: "toggle-resolve-comment";
  commentId: string;
}

interface DeleteCommentMessage {
  type: "delete-comment";
  commentId: string;
}

interface OpenLinkMessage {
  type: "open-link";
  href: string;
}

interface InvokeCommandMessage {
  type: "invoke-command";
  command: "send-to-claude" | "copy-prompt";
}

type ClientMessage =
  | EditMessage
  | ReadyMessage
  | ReadyWithContentMessage
  | WebviewErrorMessage
  | AddCommentMessage
  | ReplyCommentMessage
  | ToggleResolveCommentMessage
  | DeleteCommentMessage
  | OpenLinkMessage
  | InvokeCommandMessage;

// Test-only observability. The webview reports its post-init content
// length (and whether the relay sync succeeded) via the
// `ready-with-content` message. Tests can read this map to assert that
// the editor actually has non-empty content for a given document — which
// catches the user-facing "empty editor" bug that pure relay-side checks
// would miss.
const lastReadyByUri = new Map<string, ReadyWithContentMessage>();
export function _getLastReadyForTests(uri: vscode.Uri): ReadyWithContentMessage | undefined {
  return lastReadyByUri.get(uri.toString());
}

const lastWebviewErrorByUri = new Map<string, WebviewErrorMessage>();
export function _getLastWebviewErrorForTests(
  uri: vscode.Uri,
): WebviewErrorMessage | undefined {
  return lastWebviewErrorByUri.get(uri.toString());
}

export class CollabEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = VIEW_TYPE;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
  ): vscode.Disposable {
    const provider = new CollabEditorProvider(context.extensionUri, output);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "out", "webview");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };

    panel.webview.html = this.renderHtml(panel.webview);

    const config = vscode.workspace.getConfiguration("markdownCollab");
    const serverUrl = config.get<string>("collab.serverUrl", "ws://localhost:1234");
    const userName = config.get<string>("collab.userName", "") || os.userInfo().username;
    const room = computeRoom(document.uri);
    const user = { name: userName, color: pickColor(userName) };

    const sidecarPath = this.computeSidecarPath(document.uri);

    const readSidecarComments = async (): Promise<CommentSummary[]> => {
      if (!sidecarPath) return [];
      const loaded = await loadSidecar(sidecarPath);
      if (!loaded) return [];
      return loaded.sidecar.comments.map((c) => commentToSummary(c));
    };

    // Track our own writes so the workspace.onDidChangeTextDocument handler
    // doesn't bounce them back as "external" updates and overwrite the
    // webview's Y.Text mid-edit.
    let pendingApply = false;

    const applyEditFromWebview = async (text: string): Promise<void> => {
      if (document.getText() === text) return;
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(document.uri, fullRange, text);
      pendingApply = true;
      try {
        await vscode.workspace.applyEdit(edit);
      } catch (e) {
        this.output.appendLine(
          `CollabEditor applyEdit failed: ${(e as Error).message}`,
        );
      } finally {
        pendingApply = false;
      }
    };

    const messageSub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as ClientMessage | undefined;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        void (async () => {
          const comments = await readSidecarComments();
          const payload: InitPayload = {
            type: "init",
            text: document.getText(),
            room,
            serverUrl,
            user,
            comments,
          };
          void panel.webview.postMessage(payload);
        })();
      } else if (msg.type === "edit") {
        void applyEditFromWebview(msg.text);
      } else if (msg.type === "ready-with-content") {
        lastReadyByUri.set(document.uri.toString(), msg);
        this.output.appendLine(
          `CollabEditor: webview ready for ${document.uri.fsPath} — content length=${msg.length}, synced=${msg.synced}${msg.error ? `, error=${msg.error}` : ""}`,
        );
      } else if (msg.type === "webview-error") {
        // Surface webview-side failures (Milkdown init errors, ProseMirror
        // schema mismatches, etc.) into the extension's output channel so
        // they're visible without opening the webview devtools.
        lastWebviewErrorByUri.set(document.uri.toString(), msg);
        this.output.appendLine(
          `CollabEditor: webview error for ${document.uri.fsPath} (${msg.stage}): ${msg.message}`,
        );
      } else if (msg.type === "add-comment") {
        void (async () => {
          const result = await this.handleAddComment(document, msg, sidecarPath);
          void panel.webview.postMessage(result);
          if (result.ok) await pushSidecar();
        })();
      } else if (msg.type === "reply-comment") {
        void (async () => {
          const result = await this.handleReplyComment(msg, sidecarPath);
          void panel.webview.postMessage(result);
          if (result.ok) await pushSidecar();
        })();
      } else if (msg.type === "toggle-resolve-comment") {
        void (async () => {
          const result = await this.handleToggleResolve(msg, sidecarPath);
          void panel.webview.postMessage(result);
          if (result.ok) await pushSidecar();
        })();
      } else if (msg.type === "delete-comment") {
        void (async () => {
          const result = await this.handleDeleteComment(msg, sidecarPath);
          void panel.webview.postMessage(result);
          if (result.ok) await pushSidecar();
        })();
      } else if (msg.type === "open-link") {
        void this.handleOpenLink(msg, panel, document);
      } else if (msg.type === "invoke-command") {
        void this.handleInvokeCommand(msg, document);
      }
    });

    const pushSidecar = async (): Promise<void> => {
      const comments = await readSidecarComments();
      void panel.webview.postMessage({
        type: "sidecar-changed",
        comments,
      } satisfies SidecarChangedPayload);
    };

    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (pendingApply) return;
      void panel.webview.postMessage({
        type: "externalChange",
        text: e.document.getText(),
      });
    });

    // Watch the sidecar file so the comment side panel stays fresh as
    // reviewers add or resolve comments — including changes made via the
    // standard editor's CommentController in another window. We use a
    // plain workspace file watcher rather than tying into the existing
    // SidecarWatcher because that one is owned by the comment controller
    // and re-routing it would entangle two unrelated lifecycles.
    let sidecarWatcher: vscode.FileSystemWatcher | undefined;
    if (sidecarPath) {
      const pattern = new vscode.RelativePattern(
        path.dirname(sidecarPath),
        path.basename(sidecarPath),
      );
      sidecarWatcher = vscode.workspace.createFileSystemWatcher(pattern);
      const push = async (): Promise<void> => {
        const comments = await readSidecarComments();
        const payload: SidecarChangedPayload = {
          type: "sidecar-changed",
          comments,
        };
        void panel.webview.postMessage(payload);
      };
      sidecarWatcher.onDidChange(() => void push());
      sidecarWatcher.onDidCreate(() => void push());
      sidecarWatcher.onDidDelete(() => void push());
    }

    panel.onDidDispose(() => {
      messageSub.dispose();
      docSub.dispose();
      sidecarWatcher?.dispose();
    });
  }

  private computeSidecarPath(uri: vscode.Uri): string | null {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return null;
    return sidecarPathFor(uri.fsPath, folder.uri.fsPath);
  }

  private async handleReplyComment(
    msg: ReplyCommentMessage,
    sidecarPath: string | null,
  ): Promise<{ type: "reply-comment-result"; ok: boolean; commentId: string; error?: string }> {
    return CollabEditorProvider.runReplyComment(sidecarPath, msg.commentId, msg.body);
  }

  private async handleToggleResolve(
    msg: ToggleResolveCommentMessage,
    sidecarPath: string | null,
  ): Promise<{ type: "toggle-resolve-result"; ok: boolean; commentId: string; resolved?: boolean; error?: string }> {
    return CollabEditorProvider.runToggleResolve(sidecarPath, msg.commentId);
  }

  private async handleDeleteComment(
    msg: DeleteCommentMessage,
    sidecarPath: string | null,
  ): Promise<{ type: "delete-comment-result"; ok: boolean; commentId: string; error?: string }> {
    return CollabEditorProvider.runDeleteComment(sidecarPath, msg.commentId);
  }

  // Static helpers — same logic as the message handlers above, but with
  // no `vscode.WebviewPanel` / `vscode.TextDocument` dependency so tests
  // can drive them directly. Each returns the exact payload that gets
  // postMessage'd back to the webview, so tests can assert both the
  // sidecar mutation AND the response shape the webview will see.

  static async runReplyComment(
    sidecarPath: string | null,
    commentId: string,
    body: string,
  ): Promise<{ type: "reply-comment-result"; ok: boolean; commentId: string; error?: string }> {
    if (!sidecarPath) {
      return { type: "reply-comment-result", ok: false, commentId, error: "no sidecar path (file outside workspace?)" };
    }
    if (!body || !body.trim()) {
      return { type: "reply-comment-result", ok: false, commentId, error: "reply body is empty" };
    }
    try {
      await addReplyToSidecar(sidecarPath, commentId, {
        body,
        author: "user",
        createdAt: new Date().toISOString(),
      });
      return { type: "reply-comment-result", ok: true, commentId };
    } catch (e) {
      return { type: "reply-comment-result", ok: false, commentId, error: (e as Error).message };
    }
  }

  static async runToggleResolve(
    sidecarPath: string | null,
    commentId: string,
  ): Promise<{ type: "toggle-resolve-result"; ok: boolean; commentId: string; resolved?: boolean; error?: string }> {
    if (!sidecarPath) {
      return { type: "toggle-resolve-result", ok: false, commentId, error: "no sidecar path" };
    }
    try {
      const loaded = await loadSidecar(sidecarPath);
      if (!loaded) return { type: "toggle-resolve-result", ok: false, commentId, error: "sidecar not found" };
      const existing = loaded.sidecar.comments.find((c) => c.id === commentId);
      if (!existing) {
        return { type: "toggle-resolve-result", ok: false, commentId, error: "comment not found" };
      }
      const next = !existing.resolved;
      await setResolvedInSidecar(sidecarPath, commentId, next);
      return { type: "toggle-resolve-result", ok: true, commentId, resolved: next };
    } catch (e) {
      return { type: "toggle-resolve-result", ok: false, commentId, error: (e as Error).message };
    }
  }

  static async runDeleteComment(
    sidecarPath: string | null,
    commentId: string,
  ): Promise<{ type: "delete-comment-result"; ok: boolean; commentId: string; error?: string }> {
    if (!sidecarPath) {
      return { type: "delete-comment-result", ok: false, commentId, error: "no sidecar path" };
    }
    try {
      const removed = await deleteCommentFromSidecar(sidecarPath, commentId);
      if (!removed) {
        return { type: "delete-comment-result", ok: false, commentId, error: "comment id not found" };
      }
      return { type: "delete-comment-result", ok: true, commentId };
    } catch (e) {
      return { type: "delete-comment-result", ok: false, commentId, error: (e as Error).message };
    }
  }

  private async handleOpenLink(
    msg: OpenLinkMessage,
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
  ): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const decision = classifyLink(msg.href, document.uri.fsPath, roots);
    const post = (
      ok: boolean,
      reason?: string,
    ): void => {
      void panel.webview.postMessage({
        type: "open-link-result",
        ok,
        href: msg.href,
        reason,
      });
    };

    if (decision.kind === "blocked") {
      this.output.appendLine(
        `CollabEditor: refused to open link ${JSON.stringify(msg.href)} — ${decision.reason}`,
      );
      post(false, decision.reason);
      return;
    }
    if (decision.kind === "fragment") {
      // Anchor scrolling within the current doc isn't wired yet — log
      // and tell the webview so it can choose to no-op silently.
      post(false, `fragment '${decision.id}' navigation not implemented`);
      return;
    }
    if (decision.kind === "external") {
      // Defence-in-depth: the classifier already vetted the scheme but
      // re-validate with the dedicated allowlist before handing the URL
      // to vscode.env.openExternal.
      if (!isExternalLinkSafe(msg.href)) {
        this.output.appendLine(
          `CollabEditor: external link failed allowlist re-check ${JSON.stringify(msg.href)}`,
        );
        post(false, "external link rejected by allowlist");
        return;
      }
      try {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(msg.href));
        post(opened);
      } catch (e) {
        post(false, (e as Error).message);
      }
      return;
    }
    // workspace
    try {
      const targetUri = vscode.Uri.file(decision.targetFsPath);
      // vscode.open respects the user's editor associations, so a .md
      // target opens with whatever the user picked as their default
      // (the standard markdown editor unless they've made our collab
      // editor the default).
      await vscode.commands.executeCommand("vscode.open", targetUri);
      post(true);
    } catch (e) {
      post(false, (e as Error).message);
    }
  }

  private async handleInvokeCommand(
    msg: InvokeCommandMessage,
    document: vscode.TextDocument,
  ): Promise<void> {
    if (msg.command === "send-to-claude") {
      try {
        await vscode.commands.executeCommand("markdownCollab.sendAllToClaude", document.uri);
      } catch (e) {
        this.output.appendLine(
          `CollabEditor: sendAllToClaude failed: ${(e as Error).message}`,
        );
      }
    } else if (msg.command === "copy-prompt") {
      try {
        // The existing copyClaudePrompt command operates on the active
        // editor; ours isn't a TextEditor so we can't rely on that path.
        // Mimic its payload directly.
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
          void vscode.window.showWarningMessage(
            "Markdown file is outside any workspace folder.",
          );
          return;
        }
        const rel = path.relative(folder.uri.fsPath, document.uri.fsPath);
        const prompt = `Use the markdown-collab skill to address the unresolved review comments on ${rel}.`;
        await vscode.env.clipboard.writeText(prompt);
        void vscode.window.showInformationMessage(
          "Prompt copied — paste into Claude Code.",
        );
      } catch (e) {
        this.output.appendLine(
          `CollabEditor: copy-prompt failed: ${(e as Error).message}`,
        );
      }
    }
  }

  private async handleAddComment(
    document: vscode.TextDocument,
    msg: AddCommentMessage,
    sidecarPath: string | null,
  ): Promise<{ type: "add-comment-result"; ok: boolean; error?: string }> {
    if (!sidecarPath) {
      return {
        type: "add-comment-result",
        ok: false,
        error: "File is outside any workspace folder.",
      };
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return {
        type: "add-comment-result",
        ok: false,
        error: "File is outside any workspace folder.",
      };
    }
    const anchor: Anchor = {
      text: msg.anchor.text,
      contextBefore: msg.anchor.contextBefore,
      contextAfter: msg.anchor.contextAfter,
    };
    if (!isAnchorTextValid(anchor.text)) {
      return {
        type: "add-comment-result",
        ok: false,
        error: "Anchor text needs at least 8 non-whitespace characters.",
      };
    }
    const mdRel = path.relative(folder.uri.fsPath, document.uri.fsPath);
    try {
      await addCommentToSidecar(sidecarPath, mdRel, {
        anchor,
        body: msg.body,
        author: "user",
        createdAt: new Date().toISOString(),
      });
      this.output.appendLine(
        `CollabEditor: added comment on ${document.uri.fsPath} (anchor=${JSON.stringify(anchor.text.slice(0, 40))})`,
      );
      return { type: "add-comment-result", ok: true };
    } catch (e) {
      const message = (e as Error).message;
      this.output.appendLine(
        `CollabEditor: addComment failed for ${document.uri.fsPath}: ${message}`,
      );
      return { type: "add-comment-result", ok: false, error: message };
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "client.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "client.css"),
    );
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = [
      `default-src 'none'`,
      // Milkdown / ProseMirror inject some inline `style` attributes
      // (e.g. for cursors). Allow them via 'unsafe-inline' under
      // style-src; this is the same posture the existing preview panel
      // uses for markdown-it rendered HTML.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: https:`,
      // y-websocket needs ws:// to localhost or wherever the user pointed
      // markdownCollab.collab.serverUrl. Allow any ws/wss target — the user
      // controls the URL via settings.
      `connect-src ws: wss:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function commentToSummary(c: Comment): CommentSummary {
  return {
    id: c.id,
    body: c.body,
    author: typeof c.author === "string" ? c.author : "user",
    createdAt: c.createdAt,
    resolved: c.resolved,
    anchor: {
      text: c.anchor.text,
      contextBefore: c.anchor.contextBefore,
      contextAfter: c.anchor.contextAfter,
    },
    replies: c.replies.map((r) => ({
      author: typeof r.author === "string" ? r.author : "user",
      body: r.body,
      createdAt: r.createdAt,
    })),
  };
}

function computeRoom(uri: vscode.Uri): string {
  // Hash the absolute fsPath so the room name doesn't leak filesystem layout
  // to peers but still uniquely identifies the document. Anyone with the
  // same absolute path on the same y-websocket server joins the same room.
  return crypto.createHash("sha1").update(uri.fsPath).digest("hex").slice(0, 16);
}

function pickColor(name: string): string {
  const palette = [
    "#e06c75",
    "#98c379",
    "#e5c07b",
    "#61afef",
    "#c678dd",
    "#56b6c2",
    "#d19a66",
    "#abb2bf",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}
