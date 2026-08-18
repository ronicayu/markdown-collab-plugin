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
// commentController or the sidecar.

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { imageResourceRootPaths } from "../webviewShared/resourceRoots";
import { isInsideRoot } from "../pathUtils";
import { checkClaudeSkill, type SkillStatus } from "../skill";
import { runDrawioRead } from "../collab/drawioService";
import { claudePending, onPendingChanged } from "../claudePendingService";
import { pendingLabel } from "./claudePending";
import { detectUrlScheme, parseLinkHref, slugifyHeading } from "./linkParse";
import { findFrontmatter, parse, type ParsedDocument } from "./format";
import { minimalEdit } from "./minimalEdit";
import { applyClientMutation, type MutationMessage } from "./mutations";
import { mapProseToSource } from "./proseMapping";
import { serialize, type SerializedState } from "./serializeState";
import { inlineCommentsAppBody } from "./webviewShell";
import { buildInlinePayload, buildSingleThreadPayload } from "./sendToClaude";
import type { ReviewPayload } from "../sendToClaude";

// Re-exported from here since v0.27: callers (and tests) import the serializer
// from the panel. The implementation moved to a vscode-free module so the
// webview e2e harness can build real init payloads outside the Extension Host.
export { serialize, type SerializedState } from "./serializeState";

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
  plantuml: { serverUrl: string; format: "svg" | "png" };
  /** Whether the installed Claude skill is missing / outdated / current. */
  skillStatus: SkillStatus;
  /** Whether "Send to Claude" proposes edits as suggestions (accept/reject). */
  suggestMode: boolean;
  /** Threads dispatched to Claude that haven't been answered yet (P1.2). */
  pendingThreadIds: string[];
  /** What to say under those threads — protocol evidence earns a specific phrase. */
  pendingLabel: string;
}

interface UpdateMessage {
  type: "update";
  state: SerializedState;
  suggestMode: boolean;
  pendingThreadIds: string[];
  pendingLabel: string;
}

interface SkillStatusMessage {
  type: "skill-status";
  status: SkillStatus;
}

interface ReviewPendingMessage {
  type: "review-pending";
  /** Thread IDs that already existed when the user fired Ask Claude to Review. */
  existingIds: string[];
}

interface ScrollToMessage {
  type: "scroll-to";
  /** Prose offset to scroll into view. */
  proseOffset: number;
}

export interface RevealOpts {
  /** 1-based line number to scroll to after opening. */
  line?: number;
  /** Heading slug (without leading `#`) to scroll to after opening. */
  heading?: string;
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

interface SendToClaudeCommentRequest {
  type: "send-to-claude-comment";
  threadId: string;
}

interface CopyClaudeCommentRequest {
  type: "copy-claude-comment";
  threadId: string;
}

interface OpenLinkRequest {
  type: "open-link";
  href: string;
}

interface DrawioReadRequest {
  type: "drawio-read";
  requestId: string;
  href: string;
}

interface InstallSkillRequest {
  type: "install-skill";
}

interface AcceptSuggestionRequest {
  type: "accept-suggestion";
  anchorId: string;
}

interface RejectSuggestionRequest {
  type: "reject-suggestion";
  anchorId: string;
}

interface ToggleSuggestModeRequest {
  type: "toggle-suggest-mode";
}

interface AcceptAllSuggestionsRequest {
  type: "accept-all-suggestions";
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
  | CopyPromptRequest
  | SendToClaudeCommentRequest
  | CopyClaudeCommentRequest
  | OpenLinkRequest
  | DrawioReadRequest
  | InstallSkillRequest
  | AcceptSuggestionRequest
  | RejectSuggestionRequest
  | AcceptAllSuggestionsRequest
  | ToggleSuggestModeRequest;

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
  return imageResourceRootPaths({
    docFsPath: doc.uri.fsPath,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    extensionDirs: [
      vscode.Uri.joinPath(context.extensionUri, "out", "inlineComments").fsPath,
      vscode.Uri.joinPath(context.extensionUri, "node_modules", "mermaid", "dist").fsPath,
    ],
  }).map((p) => vscode.Uri.file(p));
}

export class InlineCommentsPanel {
  /**
   * Notify any open InlineCommentsPanel for `docUri` that a review
   * request was just dispatched. The panel snapshots its current thread
   * IDs and, on the next update where new claude-initiated threads
   * appear, scrolls to the first one. No-op when no panel is open.
   */
  static notifyReviewPending(docUri: vscode.Uri): void {
    const panel = panels.get(docUri.toString());
    if (!panel) return;
    void panel.pushReviewPending();
  }

  static reveal(
    context: vscode.ExtensionContext,
    doc: vscode.TextDocument,
    deps: InlinePanelDeps,
    opts?: RevealOpts,
  ): void {
    const key = doc.uri.toString();
    const existing = panels.get(key);
    if (existing) {
      existing.panel.reveal();
      if (opts && (opts.line || opts.heading)) {
        void existing.scrollTo(opts);
      }
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
    panels.set(
      key,
      new InlineCommentsPanel(context, doc, panel, deps, () => panels.delete(key), opts),
    );
  }

  private readonly disposables: vscode.Disposable[] = [];
  private pendingApply = false;

  /** Set by reveal() when an open request includes a scroll target. Consumed once on the next `ready` after init. */
  private pendingScroll: RevealOpts | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly doc: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: InlinePanelDeps,
    private readonly onDispose: () => void,
    initialScroll?: RevealOpts,
  ) {
    if (initialScroll && (initialScroll.line || initialScroll.heading)) {
      this.pendingScroll = initialScroll;
    }
    panel.webview.html = this.renderHtml();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => void this.handleMessage(m as ClientMessage)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== this.doc.uri.toString()) return;
        if (this.pendingApply) return;
        void this.pushState();
      }),
      // The pending set changes when a payload goes out and when one expires
      // unanswered — neither has a file write to hang off, so re-render here.
      onPendingChanged((docKey) => {
        if (docKey === this.doc.uri.toString()) void this.pushState();
      }),
      // Keep the suggest-mode toggle in sync when the setting is changed
      // elsewhere (command palette, Settings UI).
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("markdownCollab.proposeEditsAsSuggestions") ||
          e.affectsConfiguration("markdownCollab.showLineNumbers")
        ) {
          void this.pushState();
        }
      }),
      panel,
    );
    panel.onDidDispose(() => this.dispose());
  }

  private async scrollTo(opts: RevealOpts): Promise<void> {
    const proseOffset = resolveScrollProseOffset(this.doc, {
      line: opts.line ?? null,
      heading: opts.heading ?? null,
    });
    if (proseOffset === null) return;
    const msg: ScrollToMessage = { type: "scroll-to", proseOffset };
    await this.panel.webview.postMessage(msg);
  }

  private renderHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "inlineComments", "client.js"),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "inlineComments", "client.css"),
    );
    const sharedStyleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "inlineComments", "comments-shared.css"),
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
<link rel="stylesheet" href="${sharedStyleUri}">
<link rel="stylesheet" href="${styleUri}">
<title>Inline Comments</title>
</head>
<body>
${inlineCommentsAppBody()}
<script src="${mermaidUri}"></script>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async handleMessage(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.pushInit();
        if (this.pendingScroll) {
          const opts = this.pendingScroll;
          this.pendingScroll = null;
          await this.scrollTo(opts);
        }
        return;
      // Document mutations all run through the same pure handler — see
      // `mutations.ts`. The panel's job is the side effects: applying the
      // edit and surfacing whatever warning the handler returns.
      case "add-comment":
      case "reply":
      case "edit-comment":
      case "toggle-resolve":
      case "delete-thread":
      case "delete-comment":
      case "accept-suggestion":
      case "reject-suggestion":
      case "accept-all-suggestions":
        return this.applyClientMutation(msg);
      case "send-to-claude":
        return this.handleSendToClaude();
      case "copy-prompt":
        return this.handleCopyPrompt();
      case "send-to-claude-comment":
        return this.handleSendToClaudeComment(msg.threadId);
      case "copy-claude-comment":
        return this.handleCopyClaudeComment(msg.threadId);
      case "open-link":
        return this.handleOpenLink(msg.href);
      case "drawio-read":
        return this.handleDrawioRead(msg.requestId, msg.href);
      case "install-skill":
        return this.handleInstallSkill();
      case "toggle-suggest-mode":
        // The command flips the per-workspace setting and shows the toast;
        // re-push so the toggle in the panel reflects the new state.
        await vscode.commands.executeCommand("markdownCollab.toggleSuggestMode");
        return this.pushState();
    }
  }

  private async handleSendToClaude(): Promise<void> {
    const payload = buildInlinePayload(this.doc, { suggestMode: readSuggestMode() });
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
    const payload = buildInlinePayload(this.doc, { suggestMode: readSuggestMode() });
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

  private async handleSendToClaudeComment(threadId: string): Promise<void> {
    const payload = buildSingleThreadPayload(this.doc, threadId, {
      suggestMode: readSuggestMode(),
    });
    if (!payload) {
      void vscode.window.showInformationMessage(
        "Inline comments: thread not found or already resolved.",
      );
      return;
    }
    await this.deps.dispatchToClaude(payload);
  }

  private async handleCopyClaudeComment(threadId: string): Promise<void> {
    const payload = buildSingleThreadPayload(this.doc, threadId, {
      suggestMode: readSuggestMode(),
    });
    if (!payload) {
      void vscode.window.showInformationMessage(
        "Inline comments: thread not found or already resolved.",
      );
      return;
    }
    await vscode.env.clipboard.writeText(payload.prompt);
    void vscode.window.showInformationMessage(
      "Inline comments: thread prompt copied to clipboard.",
    );
  }

  /**
   * Resolve a click on a rendered markdown link.
   *
   * Same-doc `#fragment` links are handled webview-side. By the time we
   * get here, `href` either has an explicit path or an external scheme.
   *
   * - `http(s)://`, `mailto:`, `tel:` → `openExternal`
   * - other schemes → refused
   * - `<path>[:N][#heading][?query]` → resolved against the doc's dir,
   *   must stay inside the workspace folder, opened in VS Code:
   *     - `.md` → open another inline-comments panel; jump to heading
   *       by re-using the existing setSelection-after-open trick.
   *     - everything else → `vscode.open` default opener.
   */
  private async handleOpenLink(rawHref: string): Promise<void> {
    const raw = (rawHref || "").trim();
    if (!raw) return;

    // External schemes: allow http(s)/mailto/tel; refuse the rest.
    // `detectUrlScheme` rejects bare-colon filenames like `foo.md:42`
    // so the path-resolve branch below sees them, instead of this
    // branch treating them as URLs with scheme "foo.md".
    const scheme = detectUrlScheme(raw);
    if (scheme) {
      const allowed = ["http", "https", "mailto", "tel"];
      if (!allowed.includes(scheme)) {
        void vscode.window.showWarningMessage(
          `Refusing to open link with scheme '${scheme}'.`,
        );
        return;
      }
      try {
        await vscode.env.openExternal(vscode.Uri.parse(raw));
      } catch (e) {
        void vscode.window.showWarningMessage(
          `Could not open ${raw}: ${(e as Error).message}`,
        );
      }
      return;
    }

    const parsed = parseLinkHref(raw);
    if (!parsed.path) return; // pure fragment — webview already handled

    // Resolve against the .md file's directory. Block paths outside the
    // workspace root (link-routing must stay inside the workspace).
    const folder = vscode.workspace.getWorkspaceFolder(this.doc.uri);
    const baseDir = path.dirname(this.doc.uri.fsPath);
    const resolved = path.resolve(baseDir, parsed.path);
    const root = folder ? folder.uri.fsPath : baseDir;
    if (!isInsideRoot(resolved, root)) {
      void vscode.window.showWarningMessage(
        `Link blocked: ${parsed.path} resolves outside the workspace.`,
      );
      return;
    }

    let stat: import("fs").Stats;
    try {
      stat = (await fs.stat(resolved)) as unknown as import("fs").Stats;
    } catch (e) {
      void vscode.window.showWarningMessage(
        `Linked file not found: ${resolved}`,
      );
      return;
    }
    if (stat.isDirectory()) {
      void vscode.window.showWarningMessage(
        `Cannot open directory: ${resolved}`,
      );
      return;
    }

    const targetUri = vscode.Uri.file(resolved);
    if (resolved.toLowerCase().endsWith(".md")) {
      try {
        const targetDoc = await vscode.workspace.openTextDocument(targetUri);
        // Reveal in another inline-comments panel for `.md` targets so
        // the user stays in the review workflow. The reveal opts carry
        // any heading/line suffix from the link; the panel scrolls the
        // preview to the matching span after init.
        InlineCommentsPanel.reveal(this.context, targetDoc, this.deps, {
          line: parsed.line ?? undefined,
          heading: parsed.heading ?? undefined,
        });
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Failed to open ${resolved}: ${(e as Error).message}`,
        );
      }
      return;
    }

    // Non-markdown:
    // - With `:N`, jump to line N in a text editor atomically via
    //   `showTextDocument({ selection })`. Doing the open + reveal in
    //   one call avoids a race where `vscode.open` resolves before the
    //   newly-opened editor is the active one.
    // - Without `:N`, fall through to `vscode.open` so binary types
    //   (images, PDFs) get the right viewer.
    try {
      if (parsed.line && parsed.line > 0) {
        const zeroBased = parsed.line - 1;
        const pos = new vscode.Position(zeroBased, 0);
        await vscode.window.showTextDocument(targetUri, {
          preview: false,
          preserveFocus: false,
          selection: new vscode.Range(pos, pos),
        });
      } else {
        await vscode.commands.executeCommand("vscode.open", targetUri);
      }
    } catch (e) {
      void vscode.window.showWarningMessage(
        `Could not open ${resolved}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Read a `.drawio` file the webview wants to render inline. Reuses the
   * collab editor's resolver (path confined to the workspace) so both
   * surfaces apply the same security checks, and posts the XML back for the
   * webview to render to SVG.
   */
  private async handleDrawioRead(requestId: string, href: string): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(this.doc.uri);
    const result = await runDrawioRead(
      {
        requestId,
        href,
        documentPath: this.doc.uri.fsPath,
        workspaceRoot: folder?.uri.fsPath ?? null,
      },
      async (absPath) => {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
        return Buffer.from(bytes).toString("utf8");
      },
    );
    await this.panel.webview.postMessage(result);
  }

  private resolveAuthor(): string {
    const cfg = vscode.workspace.getConfiguration("markdownCollab");
    return cfg.get<string>("collab.userName", "") || os.userInfo().username || "anonymous";
  }

  /** Threads still awaiting Claude, pruned against the document's current state. */
  private pendingThreadIds(): string[] {
    return claudePending.pending(this.doc.uri.toString(), parse(this.doc.getText()).threads);
  }

  /**
   * The line to show under a waiting thread. With MCP evidence this names the
   * phase Claude reported; otherwise it stays the vaguer inferred wording,
   * because that state IS a guess (10x-plan-2 P0.2).
   */
  private pendingLabelText(): string {
    return pendingLabel(claudePending.status(this.doc.uri.toString(), parse(this.doc.getText()).threads));
  }

  /**
   * Run one webview mutation through the pure handler and apply the result.
   * The handler decides what the document becomes; the panel owns the
   * `WorkspaceEdit`, the save, and the warning toast.
   */
  private async applyClientMutation(msg: MutationMessage): Promise<void> {
    let warning: string | undefined;
    await this.applyMutation((parsed) => {
      const result = applyClientMutation(parsed, msg, {
        author: this.resolveAuthor(),
        now: () => new Date().toISOString(),
      });
      warning = result.warning;
      return result.source;
    });
    if (warning) void vscode.window.showWarningMessage(warning);
  }

  private async applyMutation(fn: (parsed: ParsedDocument) => string): Promise<void> {
    const parsed = parse(this.doc.getText());
    const next = fn(parsed);
    if (next === parsed.source) return;
    // Replace only the span that changed, not the whole file: a reply touches
    // one line of the threads region, and rewriting the entire document to say
    // so re-tokenizes the buffer, disturbs folds and decorations, and tells
    // every watcher that everything changed.
    const change = minimalEdit(parsed.source, next);
    if (!change) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.doc.uri,
      new vscode.Range(this.doc.positionAt(change.start), this.doc.positionAt(change.end)),
      change.replacement,
    );
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
    const state = serialize(parse(this.doc.getText()), { lineNumbers: readLineNumbers() });
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
      plantuml: readPlantumlConfig(),
      skillStatus: await checkClaudeSkill(os.homedir()),
      suggestMode: readSuggestMode(),
      pendingThreadIds: this.pendingThreadIds(),
      pendingLabel: this.pendingLabelText(),
    };
    await this.panel.webview.postMessage(msg);
  }

  /** Install / update the bundled Claude skill, then refresh the panel's banner. */
  private async handleInstallSkill(): Promise<void> {
    // Route through the existing command so the "a customized SKILL.md exists"
    // overwrite confirmation + toasts are reused rather than duplicated.
    await vscode.commands.executeCommand("markdownCollab.installClaudeSkill");
    const msg: SkillStatusMessage = {
      type: "skill-status",
      status: await checkClaudeSkill(os.homedir()),
    };
    await this.panel.webview.postMessage(msg);
  }

  private async pushState(): Promise<void> {
    const state = serialize(parse(this.doc.getText()), { lineNumbers: readLineNumbers() });
    const msg: UpdateMessage = {
      type: "update",
      state,
      suggestMode: readSuggestMode(),
      pendingThreadIds: this.pendingThreadIds(),
      pendingLabel: this.pendingLabelText(),
    };
    await this.panel.webview.postMessage(msg);
  }

  private async pushReviewPending(): Promise<void> {
    const state = serialize(parse(this.doc.getText()));
    const msg: ReviewPendingMessage = {
      type: "review-pending",
      existingIds: state.threads.map((t) => t.id),
    };
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
 * Translate a `{ line, heading }` request into a prose-space offset
 * suitable for posting to the webview. Returns null when neither is
 * resolvable (heading not found, line past EOF, both absent).
 *
 * Heading resolution takes priority when both are provided since users
 * tend to write `foo.md:42#api` meaning the heading; line is the
 * fallback when the heading isn't present.
 */
export function resolveScrollProseOffset(
  doc: vscode.TextDocument,
  opts: { line?: number | null; heading?: string | null },
): number | null {
  let line: number | null = null;
  if (opts.heading) line = findHeadingLine(doc, opts.heading);
  if (line === null && opts.line && opts.line > 0) line = opts.line;
  if (line === null) return null;
  if (line > doc.lineCount) return null;
  const srcOffset = doc.offsetAt(new vscode.Position(line - 1, 0));
  const parsed = parse(doc.getText());
  const { sourceToProse } = mapProseToSource(parsed);
  return sourceToProse(srcOffset);
}

/**
 * Find the 1-based line number of the first ATX heading (`#`, `##`, …)
 * whose slug matches the requested fragment. Returns null if no heading
 * matches. Operates on the raw document text — markdown-collab markers
 * inside the heading text are stripped before slugifying so they don't
 * leak into the slug.
 */
export function findHeadingLine(
  doc: vscode.TextDocument,
  fragment: string,
): number | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(fragment);
    } catch {
      return fragment;
    }
  })();
  const target = slugifyHeading(decoded);
  if (!target) return null;
  // Skip frontmatter so YAML values like `subtitle: # something` can't
  // be mistaken for ATX headings.
  const fm = findFrontmatter(doc.getText());
  const skipUntilLine = fm ? doc.positionAt(fm.end).line : 0;
  for (let i = skipUntilLine; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (!m) continue;
    // Strip mc:* HTML-comment markers so heading text like
    // `# <!--mc:a:k7q3p-->Intro<!--mc:/a:k7q3p-->` slugifies as `intro`.
    const cleaned = m[2].replace(/<!--mc:[^>]*-->/g, "");
    if (slugifyHeading(cleaned) === target) return i + 1;
  }
  return null;
}

function readPlantumlConfig(): { serverUrl: string; format: "svg" | "png" } {
  const cfg = vscode.workspace.getConfiguration("markdownCollab");
  return {
    serverUrl: cfg.get<string>("plantuml.serverUrl") ?? "https://www.plantuml.com/plantuml",
    format: cfg.get<"svg" | "png">("plantuml.format") ?? "svg",
  };
}

/** Whether the preview should label blocks with their source line. */
function readLineNumbers(): boolean {
  return vscode.workspace
    .getConfiguration("markdownCollab")
    .get<boolean>("showLineNumbers", false);
}

function readSuggestMode(): boolean {
  return vscode.workspace.getConfiguration("markdownCollab").get<boolean>("proposeEditsAsSuggestions", false);
}
