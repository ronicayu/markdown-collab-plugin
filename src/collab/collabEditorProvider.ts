import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  addThreadAtOffsets,
  addThreadFromAnchor,
  commentsOf,
  deleteThread,
  frontmatterOf,
  mergeProseEdit,
  proseOf,
  replyToThread,
  setThreadResolved,
  type CollabComment,
  type CollabCommentAnchor,
} from "./inlineBridge";
import { resolveDrawioHref } from "./drawioFileResolver";
import { classifyLink } from "./linkRouter";
import { isExternalLinkSafe } from "./urlAllowlist";

const VIEW_TYPE = "markdownCollab.collabEditor";

interface InitPayload {
  type: "init";
  text: string;
  room: string;
  serverUrl: string;
  user: { name: string; color: string };
  comments: CollabComment[];
  /** Raw frontmatter block, shown in a dedicated read-only panel. "" when absent. */
  frontmatter: string;
}

/** Pushed when the frontmatter changes on disk (external edit) without the body changing. */
interface FrontmatterChangedPayload {
  type: "frontmatter";
  frontmatter: string;
}

// Wire type kept as "sidecar-changed" for back-compat with the webview
// client; the comments now come from the inline markers in the .md, not a
// sidecar. Renaming would mean a coordinated webview change for no behavior
// gain, so the legacy name stays.
interface CommentsChangedPayload {
  type: "sidecar-changed";
  comments: CollabComment[];
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
  /** Author name from the webview (defaults to extension's userName setting). */
  author?: string;
  /** Editor's current body markdown — the offsets index into this exact string. */
  fullMd?: string;
  /** Exact selection offsets into `fullMd`; -1 when the webview couldn't resolve them. */
  selStart?: number;
  selEnd?: number;
}

interface ReplyCommentMessage {
  type: "reply-comment";
  commentId: string;
  body: string;
  author?: string;
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

interface DrawioReadMessage {
  type: "drawio-read";
  /** Stable id minted by the webview so it can correlate the response. */
  requestId: string;
  href: string;
}

export interface DrawioReadResult {
  type: "drawio-read-result";
  requestId: string;
  href: string;
  ok: boolean;
  content?: string;
  error?: string;
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
  | InvokeCommandMessage
  | DrawioReadMessage;

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

const drawioReadHistoryByUri = new Map<string, DrawioReadResult[]>();
export function _getDrawioReadHistoryForTests(uri: vscode.Uri): DrawioReadResult[] {
  return drawioReadHistoryByUri.get(uri.toString()) ?? [];
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

    // Track our own writes so the workspace.onDidChangeTextDocument handler
    // doesn't bounce them back as "external" updates and overwrite the
    // webview's Y.Text mid-edit.
    let pendingApply = false;

    // The prose the editor currently has. We only push an `externalChange`
    // (which replaces the whole Milkdown doc) when the document's prose
    // actually diverges from this — so the editor's own edits, our marker
    // re-writes, and no-op save formatting never bounce back and revert
    // what the user just typed.
    let lastWebviewProse = proseOf(document.getText());
    // Frontmatter the editor currently shows. Tracked separately because it
    // lives in its own panel, not the Milkdown body — an external edit can
    // change it while the body prose stays identical.
    let lastFrontmatter = frontmatterOf(document.getText());

    /** Replace the whole document with `next`. Guards against echo. */
    const writeDocument = async (next: string): Promise<boolean> => {
      if (document.getText() === next) return true;
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(document.uri, fullRange, next);
      pendingApply = true;
      try {
        const ok = await vscode.workspace.applyEdit(edit);
        // Keep the echo guard in sync with whatever we just wrote (a comment
        // op can adopt the editor's body), so a later doc-change echo isn't
        // mistaken for an external edit and doesn't revert the editor.
        if (ok) lastWebviewProse = proseOf(next);
        return ok;
      } catch (e) {
        this.output.appendLine(`CollabEditor applyEdit failed: ${(e as Error).message}`);
        return false;
      } finally {
        pendingApply = false;
      }
    };

    /** Apply a prose-only edit from the webview, preserving inline comment markers. */
    const applyProseEdit = async (newProse: string): Promise<void> => {
      // The editor now holds `newProse` — record it so a later doc-change echo
      // (e.g. format-on-save) isn't mistaken for an external edit.
      lastWebviewProse = newProse;
      const current = document.getText();
      if (proseOf(current) === newProse) return; // prose unchanged — nothing to merge
      await writeDocument(mergeProseEdit(current, newProse));
    };

    const pushComments = (): void => {
      void panel.webview.postMessage({
        type: "sidecar-changed",
        comments: commentsOf(document.getText()),
      } satisfies CommentsChangedPayload);
    };

    const messageSub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as ClientMessage | undefined;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        const source = document.getText();
        const text = proseOf(source);
        lastWebviewProse = text;
        lastFrontmatter = frontmatterOf(source);
        const payload: InitPayload = {
          type: "init",
          text,
          room,
          serverUrl,
          user,
          comments: commentsOf(source),
          frontmatter: lastFrontmatter,
        };
        void panel.webview.postMessage(payload);
      } else if (msg.type === "edit") {
        void applyProseEdit(msg.text);
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
          const result = await this.addComment(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        })();
      } else if (msg.type === "reply-comment") {
        void (async () => {
          const result = await this.replyComment(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        })();
      } else if (msg.type === "toggle-resolve-comment") {
        void (async () => {
          const result = await this.toggleResolve(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        })();
      } else if (msg.type === "delete-comment") {
        void (async () => {
          const result = await this.deleteComment(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        })();
      } else if (msg.type === "open-link") {
        void this.handleOpenLink(msg, panel, document);
      } else if (msg.type === "invoke-command") {
        void this.handleInvokeCommand(msg, document);
      } else if (msg.type === "drawio-read") {
        void (async () => {
          const result = await this.handleDrawioRead(msg, document);
          const history = drawioReadHistoryByUri.get(document.uri.toString()) ?? [];
          history.push(result);
          drawioReadHistoryByUri.set(document.uri.toString(), history);
          void panel.webview.postMessage(result);
        })();
      }
    });

    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (pendingApply) return;
      // A genuine external write (standard editor, git, another window) changes
      // the prose the editor doesn't yet have — only then replace its content.
      // Skip echoes whose prose the editor already shows (our own marker
      // re-writes, no-op format-on-save, a save racing the edit debounce), so
      // we never revert what the user just typed.
      const source = e.document.getText();
      const newProse = proseOf(source);
      if (newProse !== lastWebviewProse) {
        lastWebviewProse = newProse;
        void panel.webview.postMessage({ type: "externalChange", text: newProse });
      }
      // Frontmatter lives in its own panel — push it when it changes even if
      // the body prose didn't.
      const newFrontmatter = frontmatterOf(source);
      if (newFrontmatter !== lastFrontmatter) {
        lastFrontmatter = newFrontmatter;
        void panel.webview.postMessage({
          type: "frontmatter",
          frontmatter: newFrontmatter,
        } satisfies FrontmatterChangedPayload);
      }
      // Comments are cheap to re-derive and may have changed (markers moved,
      // a comment edited elsewhere) even when the prose didn't.
      pushComments();
    });

    panel.onDidDispose(() => {
      messageSub.dispose();
      docSub.dispose();
    });
  }

  // --- comment handlers ---------------------------------------------------
  // Each rewrites the .md source via the inline bridge and writes it back
  // through `writeDocument`. Returning the exact payload the webview expects
  // keeps the message plumbing in resolveCustomTextEditor trivial.

  private async addComment(
    document: vscode.TextDocument,
    msg: AddCommentMessage,
    writeDocument: (next: string) => Promise<boolean>,
  ): Promise<{ type: "add-comment-result"; ok: boolean; error?: string }> {
    if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
      return { type: "add-comment-result", ok: false, error: "File is outside any workspace folder." };
    }
    const anchor: CollabCommentAnchor = {
      text: msg.anchor.text,
      contextBefore: msg.anchor.contextBefore,
      contextAfter: msg.anchor.contextAfter,
    };
    if (!anchor.text || anchor.text.trim().length === 0) {
      return {
        type: "add-comment-result",
        ok: false,
        error: "Select some text to comment on.",
      };
    }
    const author = (msg.author && msg.author.trim()) || resolveAuthorFromConfig();
    const newComment = { author, body: msg.body, ts: new Date().toISOString() };
    // Preferred path: place the marker at the exact selection offsets the
    // editor reported, against the editor's own body markdown — no text search,
    // so a doc that's drifted from the editor's serialization can't cause a
    // "could not locate the text" failure. Fall back to text-anchoring only
    // when the editor couldn't resolve offsets (selStart/selEnd === -1).
    const useOffsets =
      typeof msg.fullMd === "string" &&
      Number.isInteger(msg.selStart) &&
      Number.isInteger(msg.selEnd) &&
      (msg.selStart as number) >= 0 &&
      (msg.selEnd as number) >= 0;
    let result = useOffsets
      ? addThreadAtOffsets(document.getText(), msg.fullMd!, msg.selStart!, msg.selEnd!, newComment)
      : addThreadFromAnchor(document.getText(), anchor, newComment);
    if (!result.ok && useOffsets) {
      // Offsets were rejected (out of range) — fall back to the text anchor.
      result = addThreadFromAnchor(document.getText(), anchor, newComment);
    }
    if (!result.ok) {
      this.output.appendLine(`CollabEditor: addComment failed for ${document.uri.fsPath}: ${result.error}`);
      return { type: "add-comment-result", ok: false, error: result.error };
    }
    const wrote = await writeDocument(result.source);
    if (!wrote) {
      return { type: "add-comment-result", ok: false, error: "Could not write the comment into the document." };
    }
    this.output.appendLine(
      `CollabEditor: added comment on ${document.uri.fsPath} (anchor=${JSON.stringify(anchor.text.slice(0, 40))})`,
    );
    return { type: "add-comment-result", ok: true };
  }

  private async replyComment(
    document: vscode.TextDocument,
    msg: ReplyCommentMessage,
    writeDocument: (next: string) => Promise<boolean>,
  ): Promise<{ type: "reply-comment-result"; ok: boolean; commentId: string; error?: string }> {
    const commentId = msg.commentId;
    if (!msg.body || !msg.body.trim()) {
      return { type: "reply-comment-result", ok: false, commentId, error: "reply body is empty" };
    }
    const next = replyToThread(document.getText(), commentId, {
      body: msg.body,
      author: (msg.author && msg.author.trim()) || resolveAuthorFromConfig(),
      ts: new Date().toISOString(),
    });
    if (next === null) {
      return { type: "reply-comment-result", ok: false, commentId, error: "comment not found" };
    }
    const wrote = await writeDocument(next);
    return wrote
      ? { type: "reply-comment-result", ok: true, commentId }
      : { type: "reply-comment-result", ok: false, commentId, error: "could not write reply" };
  }

  private async toggleResolve(
    document: vscode.TextDocument,
    msg: ToggleResolveCommentMessage,
    writeDocument: (next: string) => Promise<boolean>,
  ): Promise<{ type: "toggle-resolve-result"; ok: boolean; commentId: string; resolved?: boolean; error?: string }> {
    const commentId = msg.commentId;
    const current = commentsOf(document.getText()).find((c) => c.id === commentId);
    if (!current) {
      return { type: "toggle-resolve-result", ok: false, commentId, error: "comment not found" };
    }
    const nextResolved = !current.resolved;
    const next = setThreadResolved(
      document.getText(),
      commentId,
      nextResolved,
      resolveAuthorFromConfig(),
    );
    if (next === null) {
      return { type: "toggle-resolve-result", ok: false, commentId, error: "comment not found" };
    }
    const wrote = await writeDocument(next);
    return wrote
      ? { type: "toggle-resolve-result", ok: true, commentId, resolved: nextResolved }
      : { type: "toggle-resolve-result", ok: false, commentId, error: "could not write resolve state" };
  }

  private async deleteComment(
    document: vscode.TextDocument,
    msg: DeleteCommentMessage,
    writeDocument: (next: string) => Promise<boolean>,
  ): Promise<{ type: "delete-comment-result"; ok: boolean; commentId: string; error?: string }> {
    const commentId = msg.commentId;
    const next = deleteThread(document.getText(), commentId);
    if (next === null) {
      return { type: "delete-comment-result", ok: false, commentId, error: "comment id not found" };
    }
    const wrote = await writeDocument(next);
    return wrote
      ? { type: "delete-comment-result", ok: true, commentId }
      : { type: "delete-comment-result", ok: false, commentId, error: "could not write deletion" };
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

  private async handleDrawioRead(
    msg: DrawioReadMessage,
    document: vscode.TextDocument,
  ): Promise<DrawioReadResult> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return CollabEditorProvider.runDrawioRead(
      msg.requestId,
      msg.href,
      document.uri.fsPath,
      folder?.uri.fsPath ?? null,
      async (absPath) => {
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
        return Buffer.from(buf).toString("utf8");
      },
      (line) => this.output.appendLine(line),
    );
  }

  static async runDrawioRead(
    requestId: string,
    href: string,
    documentPath: string,
    workspaceRoot: string | null,
    readFile: (absPath: string) => Promise<string>,
    appendLog: (line: string) => void = () => {},
  ): Promise<DrawioReadResult> {
    if (!workspaceRoot) {
      return {
        type: "drawio-read-result",
        requestId,
        href,
        ok: false,
        error: "Markdown file is outside any workspace folder.",
      };
    }
    const resolved = resolveDrawioHref(href, documentPath, workspaceRoot);
    if (!resolved.ok) {
      return {
        type: "drawio-read-result",
        requestId,
        href,
        ok: false,
        error: drawioRejectReasonMessage(resolved.reason),
      };
    }
    try {
      const content = await readFile(resolved.absolutePath);
      return {
        type: "drawio-read-result",
        requestId,
        href,
        ok: true,
        content,
      };
    } catch (e) {
      const message = (e as Error).message ?? "Unknown read error";
      appendLog(`CollabEditor: drawio-read failed for ${resolved.absolutePath}: ${message}`);
      return {
        type: "drawio-read-result",
        requestId,
        href,
        ok: false,
        error: `Could not read ${href}: ${message}`,
      };
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

// Resolve the author name for new comments / replies when the webview
// didn't send one (back-compat / programmatic callers). Prefers the
// user's configured display name; falls back to the OS user.
function resolveAuthorFromConfig(): string {
  const config = vscode.workspace.getConfiguration("markdownCollab");
  const configured = (config.get<string>("collab.userName", "") || "").trim();
  if (configured) return configured;
  return os.userInfo().username || "user";
}

function computeRoom(uri: vscode.Uri): string {
  // Hash the absolute fsPath so the room name doesn't leak filesystem layout
  // to peers but still uniquely identifies the document. Anyone with the
  // same absolute path on the same y-websocket server joins the same room.
  return crypto.createHash("sha1").update(uri.fsPath).digest("hex").slice(0, 16);
}

function drawioRejectReasonMessage(
  reason: "empty-href" | "absolute-not-allowed" | "outside-workspace" | "wrong-extension",
): string {
  switch (reason) {
    case "empty-href":
      return "Drawio link is empty.";
    case "absolute-not-allowed":
      return "Drawio link must be a workspace-relative path (no http:, file:, or absolute paths).";
    case "outside-workspace":
      return "Drawio link points outside the workspace.";
    case "wrong-extension":
      return "Drawio link must end in .drawio, .drawio.xml, or .xml.";
  }
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
