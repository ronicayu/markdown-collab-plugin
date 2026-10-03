import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  addThreadAtEditorRange,
  addThreadAtProseRange,
  applyBlockEdits,
  commentsOf,
  deleteThread,
  deleteComment as deleteCommentFromThread,
  frontmatterOf,
  mergeProseEdit,
  placeAnchorsInProse,
  proseOf,
  replyToThread,
  setThreadResolved,
  suggestionsOf,
  type CollabComment,
  type CollabCommentAnchor,
  type CollabSuggestion,
} from "./inlineBridge";
import { acceptSuggestion, rejectSuggestion, parse as parseInline } from "../inlineComments/format";
import { proseRefreshMessage, summarizeChange } from "./changeSummary";
import { sourceLineForProseLine } from "../inlineComments/proseMapping";
import { runDrawioRead, type DrawioReadResult } from "./drawioService";
import type { BlockEditsMessage } from "./blockEdits";
import { markdownBlocks, type EditorPoint, type MarkdownBlock } from "./sourcePositions";

export type { DrawioReadResult };
import { claudePending, onPendingChanged } from "../claudePendingService";
import { pendingLabel } from "../inlineComments/claudePending";
import type { DiffState } from "../inlineComments/inlineCommentsPanel";
import { diffProse } from "../uncommitted/proseDiff";
import { headFileContent, repoRootFor } from "../uncommitted/gitUncommitted";
import { classifyLink } from "./linkRouter";
import { isExternalLinkSafe } from "./urlAllowlist";
import { folderForDocument } from "../workspaceFolder";
import { workflowOpener } from "../skillDelivery";
import { imageResourceRootPaths } from "../webviewShared/resourceRoots";
import type { Logger } from "../logging";
import {
  handleSidebarMessage,
  isSidebarMessage,
  postSkillStatus,
  readSuggestMode,
  type SidebarHostContext,
} from "./sidebarHost";
import { sidebarDocumentFields, type SidebarDocumentFields } from "./sidebarState";
import { liveEditorShellBody } from "./liveEditorShell";

const VIEW_TYPE = "markdownCollab.collabEditor";

interface InitPayload extends SidebarFields {
  type: "init";
  text: string;
  user: { name: string; color: string };
  comments: CollabComment[];
  suggestions: CollabSuggestion[];
  /** Threads dispatched to Claude that haven't been answered yet (P1.2). */
  pendingThreadIds: string[];
  /** Wording for the waiting row — protocol evidence earns a specific phrase. */
  pendingLabel: string;
  /** Raw frontmatter block, shown in a dedicated read-only panel. "" when absent. */
  frontmatter: string;
  /** Webview URIs for resolving relative image src in the markdown. */
  imageBaseUris: { docDir: string; workspaceFolder: string | null };
  /** PlantUML server URL + image format — same source the review view reads. */
  plantuml: { serverUrl: string; format: "svg" | "png" };
  /** Source line per prose line; absent when line numbers are switched off. */
  lineMap?: number[];
  /**
   * Read-only mode: no editing, and comments anchor by source position
   * (docs/one-view-design.md). The panel's own mode — the setting
   * `markdownCollab.liveEditor.readOnly` only seeds it.
   */
  readOnly: boolean;
  /**
   * The document epoch: bumped by every push that replaces the editor's
   * document. Edit mode's `edit-blocks` carries the one it was made against.
   */
  epoch: number;
  /**
   * Uncommitted-vs-HEAD diff overlay (10x-plan-6 P4 phase B) — the exact
   * payload shape the inline panel computes and sends
   * (`DiffState`, src/inlineComments/inlineCommentsPanel.ts), reused as-is
   * rather than a second shape. Null when the panel wasn't opened in diff
   * mode, or the file isn't inside a git work tree.
   */
  diff: DiffState | null;
}

/**
 * The sidebar's half of `init` and of every `sidecar-changed` (10x-plan-6 P4,
 * sidebar parity): the same fields the review view's panel pushes, so the
 * sidebar can show everything that one does.
 */
interface SidebarFields extends SidebarDocumentFields {
  /** Whether Send asks the agent for suggestions instead of edits. */
  suggestMode: boolean;
}

/** Said when an edit threw instead of being written or refused. */
const EDIT_LOST = "Markdown Collab couldn't save your last edit — the view was reloaded from the file.";

/** Said when an edit arrives made on text the editor has since been sent something else in place of. */
const STALE_EDIT = "Your last edit wasn't saved: the file changed while you were typing. The editor now shows the file.";

/** Said when saving rewrote the prose (a format-on-save participant) and the editor was sent the result. */
const REWRITTEN_ON_SAVE = "Saving changed the file's text (a formatter?) — the editor now shows what was saved.";

/** Said when any other queued write or sidebar action threw. */
const ACTION_FAILED = "Markdown Collab: that action failed — see Show Logs.";

/** The webview failures that leave the panel blank or wrong, and what the person is told. */
const SHOWN_WEBVIEW_FAILURES = new Map<string, (file: string) => string>([
  ["init", (file) => `Markdown Collab couldn't display ${file}.`],
  ["reinit", (file) => `Markdown Collab couldn't switch ${file} between Reading and Editing.`],
  ["reveal-thread", (file) => `Markdown Collab couldn't show that comment in ${file}.`],
]);

/** Whether a newly opened live editor starts read-only. Never written: the in-view switch is per panel. */
function readOnlySetting(): boolean {
  return vscode.workspace.getConfiguration("markdownCollab").get<boolean>("liveEditor.readOnly", true);
}

function readPlantumlConfig(): { serverUrl: string; format: "svg" | "png" } {
  const cfg = vscode.workspace.getConfiguration("markdownCollab");
  return {
    serverUrl: cfg.get<string>("plantuml.serverUrl") ?? "https://www.plantuml.com/plantuml",
    format: cfg.get<"svg" | "png">("plantuml.format") ?? "svg",
  };
}

/** Pushed when the line-number setting changes, or the document did. */
interface LineMapPayload {
  type: "line-map";
  lineMap?: number[];
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
interface CommentsChangedPayload extends SidebarFields {
  type: "sidecar-changed";
  comments: CollabComment[];
  suggestions: CollabSuggestion[];
  pendingThreadIds: string[];
  /** Wording for the waiting row — protocol evidence earns a specific phrase. */
  pendingLabel: string;
  /** Same contract as `InitPayload.diff`. */
  diff: DiffState | null;
}

interface EditMessage {
  type: "edit";
  text: string;
  /**
   * Each tracked comment's live position, read off the editor's mapped anchor
   * decorations: the current text of its span and which occurrence that is.
   * When present, the host places markers at these exact occurrences instead of
   * re-deriving them from the stored quote. Absent for older webviews / fallback.
   */
  anchors?: Array<{ id: string; text: string; ordinal: number }>;
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

interface HighlightReportMessage {
  type: "highlight-report";
  ids: string[];
}

interface AddCommentMessage {
  type: "add-comment";
  anchor: { text: string; contextBefore: string; contextAfter: string };
  body: string;
  /** Author name from the webview (defaults to extension's userName setting). */
  author?: string;
  /**
   * Read-only mode: the selection as a prose span (`proseOf` offsets) and
   * the prose the editor saw there. Place exactly here or refuse.
   */
  proseStart?: number;
  proseEnd?: number;
  proseText?: string;
  /**
   * Edit mode: the selection's first and last characters, named by structure
   * (`EditorPoint`), and the epoch the editor named them in. Found in the
   * file's own bytes or refused — nothing the editor serialized is adopted.
   */
  editRange?: { first: EditorPoint; last: EditorPoint };
  epoch?: number;
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

interface DeleteSingleCommentMessage {
  type: "delete-single-comment";
  threadId: string;
  commentId: string;
}

interface OpenLinkMessage {
  type: "open-link";
  href: string;
}

interface InvokeCommandMessage {
  type: "invoke-command";
  command:
    | "send-to-claude"
    | "copy-prompt"
    | "send-thread-claude"
    | "copy-thread-claude"
    | "remove-resolved"
    | "finalize";
  /** Thread/comment id for the per-thread `*-thread-claude` commands. */
  commentId?: string;
}

interface AcceptSuggestionMessage {
  type: "accept-suggestion";
  anchorId: string;
}

interface RejectSuggestionMessage {
  type: "reject-suggestion";
  anchorId: string;
}

interface DrawioReadMessage {
  type: "drawio-read";
  /** Stable id minted by the webview so it can correlate the response. */
  requestId: string;
  href: string;
}

/** Mod-z / Mod-Shift-z / Mod-y in Editing mode (docs/editor-undo-and-keys.md) — the file's undo history is the only one. */
interface UndoMessage {
  type: "undo";
}

interface RedoMessage {
  type: "redo";
}

/**
 * Where the caret is, from the page's ProseMirror view: drives
 * `markdownCollab.liveEditorTyping`, the context key package.json's
 * keybinding table gates on so the workbench's own binding for a key the
 * editor handles doesn't also run.
 */
interface EditorFocusMessage {
  type: "editor-focus";
  focused: boolean;
}

type ClientMessage =
  | EditMessage
  | ReadyMessage
  | ReadyWithContentMessage
  | HighlightReportMessage
  | WebviewErrorMessage
  | AddCommentMessage
  | ReplyCommentMessage
  | ToggleResolveCommentMessage
  | DeleteCommentMessage
  | DeleteSingleCommentMessage
  | OpenLinkMessage
  | InvokeCommandMessage
  | AcceptSuggestionMessage
  | RejectSuggestionMessage
  | DrawioReadMessage
  | BlockEditsMessage
  | SetReadOnlyMessage
  | UndoMessage
  | RedoMessage
  | EditorFocusMessage;

/** The in-view read-only switch (posted by the sidebar's toggle). */
interface SetReadOnlyMessage {
  type: "set-read-only";
  readOnly: boolean;
}

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

const lastHighlightByUri = new Map<string, string[]>();
/** Comment ids the live editor most recently highlighted — for integration tests. */
export function _getHighlightedIdsForTests(uri: vscode.Uri): string[] | undefined {
  return lastHighlightByUri.get(uri.toString());
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

/** What an open panel can be asked from outside: where to land, and the diff overlay. */
interface LivePanel {
  panel: vscode.WebviewPanel;
  /** Make `threadId` the sidebar's current thread and scroll the document to it. */
  revealThread(threadId: string): void;
  /** Turn on the uncommitted-vs-HEAD diff overlay, if it isn't on already. */
  showDiff(): void;
  /** Re-read HEAD and re-push the overlay, when it's on (HEAD moved). */
  refreshDiff(): void;
}

/** Every open live-editor panel, by document — `open` and `notifyReviewPending` reach them here. */
const openPanels = new Map<string, Set<LivePanel>>();

/**
 * What `open` asked of a panel that doesn't exist yet, by document.
 * `vscode.openWith` carries no per-open options, so the request rides this
 * side channel and `resolveCustomTextEditor` takes it when it creates the
 * panel. An open panel is asked directly instead (`LivePanel`).
 */
const pendingOpens = new Map<string, { revealThreadId?: string; diff?: boolean }>();

/** The panel to reuse for `key`: the active one, else the most recently opened. */
function livePanelFor(key: string): LivePanel | undefined {
  const panels = Array.from(openPanels.get(key) ?? []);
  return panels.find((p) => p.panel.active) ?? panels[panels.length - 1];
}

/**
 * The live-editor panel whose caret last set `markdownCollab.liveEditorTyping`
 * true. The context key is global — package.json's keybinding table gates
 * every panel on the same one — so it's tracked here, across documents, and
 * every "false" site is guarded by it: one panel's dispose (which can land
 * well after it lost focus) must never clear a context key a different panel
 * now legitimately holds.
 */
let typingContextOwner: vscode.WebviewPanel | null = null;

function setLiveEditorTypingContext(panel: vscode.WebviewPanel, typing: boolean): void {
  if (typing) {
    typingContextOwner = panel;
  } else {
    if (typingContextOwner !== panel) return;
    typingContextOwner = null;
  }
  void vscode.commands.executeCommand("setContext", "markdownCollab.liveEditorTyping", typing);
}

/**
 * Bound by the keybindings table (package.json) while the caret is in the
 * live editor in Editing mode, so the workbench's own binding for that key
 * doesn't also run (docs/editor-undo-and-keys.md). Does nothing itself.
 */
const KEY_HANDLED_COMMAND = "markdownCollab.liveEditor.keyHandledInEditor";

export class CollabEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = VIEW_TYPE;

  /**
   * Open `uri` in this editor — the review view — landing on a thread and
   * with the uncommitted diff when asked. A panel already open on the file is
   * brought forward in its own group, as the previous review view's panel was,
   * rather than a second one opened beside it.
   */
  static async open(uri: vscode.Uri, opts: { revealThreadId?: string; diff?: boolean } = {}): Promise<void> {
    const key = uri.toString();
    const existing = livePanelFor(key);
    if (!existing && (opts.revealThreadId || opts.diff)) pendingOpens.set(key, opts);
    try {
      await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, existing?.panel.viewColumn);
    } catch (e) {
      // No panel is coming to take the request; the next open mustn't get it.
      pendingOpens.delete(key);
      throw e;
    }
    if (!existing) return;
    if (opts.diff) existing.showDiff();
    if (opts.revealThreadId) existing.revealThread(opts.revealThreadId);
  }

  /**
   * Refetch HEAD on every panel showing the diff — the Uncommitted Markdown
   * tree's refresh, so stripes clear after a commit without reopening, as
   * `InlineCommentsPanel.refreshDiffPanels` does for the previous view.
   */
  static refreshDiffPanels(): void {
    for (const panels of openPanels.values()) for (const p of panels) p.refreshDiff();
  }

  /**
   * An agent was just asked to review `docUri`: tell every live editor on it
   * which threads exist now, so the sidebar scrolls to the first new unread
   * one when the review lands — as the review view's panel does.
   */
  static notifyReviewPending(docUri: vscode.Uri): void {
    const key = docUri.toString();
    const panels = openPanels.get(key);
    // An open live editor holds its document open, so it's always found here.
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (!panels || !doc) return;
    const existingIds = parseInline(doc.getText()).threads.map((t) => t.id);
    for (const { panel } of panels) void panel.webview.postMessage({ type: "review-pending", existingIds });
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: Logger,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    log: Logger,
  ): vscode.Disposable {
    const provider = new CollabEditorProvider(context.extensionUri, log);
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand(KEY_HANDLED_COMMAND, () => {}),
    );
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    // Grant every workspace folder plus the document's directory and its
    // parent, so `![](../diagrams/x.png)` loads whether or not the file is in
    // a workspace. A path outside these roots is refused by the host with no
    // visible error — the picture is simply missing — so the roots are logged.
    const imageRoots = imageResourceRootPaths({
      docFsPath: document.uri.fsPath,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      extensionDirs: [vscode.Uri.joinPath(this.extensionUri, "out", "webview").fsPath],
    }).map((p) => vscode.Uri.file(p));
    this.log.trace("live editor image roots", {
      file: document.uri.fsPath,
      roots: imageRoots.map((u) => u.fsPath),
    });
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: imageRoots,
    };

    panel.webview.html = this.renderHtml(panel.webview);

    const config = vscode.workspace.getConfiguration("markdownCollab");
    const userName = config.get<string>("collab.userName", "") || os.userInfo().username;
    const user = { name: userName, color: pickColor(userName) };

    // What `open` asked of this panel before it existed, taken as it's created.
    const openRequest = pendingOpens.get(document.uri.toString());
    pendingOpens.delete(document.uri.toString());

    // This panel's mode. The setting seeds it when the panel opens; the in-view
    // switch (`set-read-only`) flips it for this panel only. A panel opened for
    // the uncommitted diff reads: its stripes are placed by source position,
    // which only Reading has.
    let readOnly = readOnlySetting() || openRequest?.diff === true;

    // Uncommitted-diff overlay (10x-plan-6 P4 phase B): on from the start when
    // the Uncommitted Markdown tree opened the panel, and turned on later by
    // `showDiff` when the tree reaches a panel that was already open.
    let diffMode = openRequest?.diff === true;
    // The HEAD version's prose. `undefined` = not fetched yet, `null` = no
    // HEAD version (untracked file). Reset to `undefined` to force a refetch
    // (below, when the panel regains focus — HEAD moves on commit, which
    // produces no document event).
    let headProse: string | null | undefined = undefined;

    /**
     * Diff overlay for `source`, or null when diff mode is off or the file
     * isn't inside a git work tree — same shape and the same degrade rule as
     * `InlineCommentsPanel.computeDiff`.
     */
    const computeDiff = async (source: string): Promise<DiffState | null> => {
      if (!diffMode) return null;
      if (headProse === undefined) {
        const root = await repoRootFor(path.dirname(document.uri.fsPath));
        if (!root) {
          diffMode = false;
          return null;
        }
        const rel = path.relative(root, document.uri.fsPath).split(path.sep).join("/");
        const headSrc = await headFileContent(root, rel);
        headProse = headSrc === null ? null : proseOf(headSrc);
      }
      const diff = diffProse(headProse, proseOf(source));
      return { isNew: headProse === null, addedRanges: diff.addedRanges, removed: diff.removed };
    };

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

    // Every push that replaces the editor's document starts a new epoch. Edit
    // mode's reports carry the epoch of the document they were made against,
    // so one that crossed a push in flight is dropped instead of being spliced
    // into a file the editor no longer shows (docs/one-view-design.md, "Phase B").
    let editEpoch = 0;
    // The oldest epoch whose edits still apply. A push of other text moves it
    // up; one that re-sends the same text (a mode switch) doesn't, so an edit
    // typed as the switch went out is written rather than lost.
    let validFrom = 0;
    const pushDocument = <T extends { type: "externalChange"; text: string }>(msg: T): void => {
      editEpoch++;
      validFrom = editEpoch;
      void panel.webview.postMessage({ ...msg, epoch: editEpoch });
    };

    /**
     * After a write or a save the echo guard hid from the change handler: if
     * the file's prose is no longer what the editor shows — a save participant
     * rewrote it, or another write landed meanwhile — send the editor the file,
     * under a new epoch so an edit made on the old text isn't spliced into the
     * new. `toast` says why; without one it's announced as an outside edit.
     */
    const catchUp = (toast?: string): void => {
      const source = document.getText();
      const prose = proseOf(source);
      // Line endings the document normalized (VS Code keeps one kind), or blank
      // lines at the end, change nothing the editor shows: no re-render for them.
      const shown = (text: string): string => text.replace(/\r\n?/g, "\n").trimEnd();
      if (prose !== lastWebviewProse && shown(prose) === shown(lastWebviewProse)) lastWebviewProse = prose;
      if (prose !== lastWebviewProse) {
        const changed = summarizeChange(lastWebviewProse, prose);
        lastWebviewProse = prose;
        pushDocument(toast ? { type: "externalChange", text: prose, toast } : { type: "externalChange", text: prose, changed });
      }
      const frontmatter = frontmatterOf(source);
      if (frontmatter !== lastFrontmatter) {
        lastFrontmatter = frontmatter;
        void panel.webview.postMessage({ type: "frontmatter", frontmatter } satisfies FrontmatterChangedPayload);
      }
    };

    // A failed save is said once per run of them — autosave retries after
    // every pause in typing — and logged every time.
    let saveFailureShown = false;
    /**
     * `document.save()`, which resolves false (a save participant or the user
     * vetoed it, the file changed on disk, a read-only file) as well as
     * throwing. Either way the file on disk is behind the editor.
     */
    const save = async (): Promise<boolean> => {
      let error: unknown;
      let saved = false;
      try {
        saved = await document.save();
      } catch (e) {
        error = e;
      }
      if (saved) {
        saveFailureShown = false;
        return true;
      }
      this.log.warn("save failed", { file: document.uri.fsPath, error: error instanceof Error ? error.message : error });
      if (!saveFailureShown) {
        saveFailureShown = true;
        const why = error instanceof Error ? ` (${error.message})` : "";
        void vscode.window.showWarningMessage(
          `Markdown Collab: ${path.basename(document.uri.fsPath)} couldn't be saved${why} — the latest changes aren't on disk.`,
        );
      }
      return false;
    };

    /** Persist the file. Guards against echo, then re-seeds the editor if a
     * save participant rewrote the prose. False when the save failed. */
    const saveDocument = async (): Promise<boolean> => {
      if (!document.isDirty) return true;
      if (!(await save())) return false;
      // A save participant (format-on-save, trim-trailing-whitespace,
      // insert-final-newline) may have rewritten the prose. The editor still
      // shows the pre-save text, so push the saved version back — otherwise a
      // just-added comment's anchor (which `commentsOf` derives from the saved
      // `.md`) won't locate in the editor and its highlight won't appear until
      // the next external change.
      catchUp(REWRITTEN_ON_SAVE);
      return true;
    };

    // Autosave-through. Claude reads the .md from disk, so the human's edits
    // have to reach disk for Claude to see them — and the longer the in-editor
    // buffer stays unsaved, the bigger the window where a Claude write and the
    // human's edits can collide. So we flush to disk shortly after the human
    // stops typing. The save is echo-guarded (pendingApply) so its own change
    // isn't announced as an external (Claude) edit; a format-on-save rewrite
    // still reaches the editor, under a new epoch (`catchUp`) — its later
    // edits would otherwise be spliced into text it doesn't show.
    let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
    /** False when the file couldn't be saved. */
    const performAutosave = async (): Promise<boolean> => {
      if (!document.isDirty) return true;
      pendingApply = true;
      try {
        return await save();
      } finally {
        pendingApply = false;
        catchUp(REWRITTEN_ON_SAVE);
      }
    };
    const scheduleAutosave = (): void => {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        // In turn with the writes, so the echo guard it raises covers only its own save.
        void exclusive(performAutosave);
      }, 800);
    };
    // Force the pending autosave now — used at hand-off so Claude reads the
    // human's latest the instant they ask for a review. False when it failed.
    const flushAutosave = async (): Promise<boolean> => {
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      return performAutosave();
    };

    // `opts.save` persists the file after writing. Comment ops (add / reply /
    // resolve / delete) are review actions the user expects to stick, so they
    // pass it; prose-edit reconciliation (which fires while typing) does not.
    const writeDocument = async (
      next: string,
      opts?: { save?: boolean },
    ): Promise<boolean> => {
      if (document.getText() === next) {
        if (opts?.save) await saveDocument();
        return true;
      }
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
        if (ok && opts?.save) await saveDocument();
        return ok;
      } catch (e) {
        this.log.error("applyEdit failed", e);
        return false;
      } finally {
        pendingApply = false;
        // Another write that landed while the guard was up reached the file, not the editor.
        catchUp();
      }
    };

    /** Apply a prose-only edit from the webview, preserving inline comment markers. */
    const applyProseEdit = async (
      newProse: string,
      anchors?: Array<{ id: string; text: string; ordinal: number }>,
    ): Promise<void> => {
      // The editor now holds `newProse` — record it so a later doc-change echo
      // (e.g. format-on-save) isn't mistaken for an external edit.
      lastWebviewProse = newProse;
      const current = document.getText();
      if (proseOf(current) === newProse) return; // prose unchanged — nothing to merge
      // Preferred path: the editor reported each anchor's live position (its
      // decorations map through edits losslessly), so place markers exactly
      // there. Fall back to text-based re-anchoring when no anchors were sent.
      const next = anchors
        ? placeAnchorsInProse(current, newProse, anchors)
        : mergeProseEdit(current, newProse);
      await writeDocument(next);
      scheduleAutosave(); // flush the edit to disk so Claude can see it
      // The onDidChangeTextDocument handler skips its own pushComments while our
      // write is in flight (pendingApply), so push the re-anchored comments here
      // — otherwise the webview keeps the pre-edit anchor text and its highlight
      // can't relocate the text the user just changed.
      pushComments();
    };

    // Every write to the document, one at a time (docs/one-view-design.md,
    // "Phase B"): each edit is spliced into the file the previous write
    // produced, a sidebar or comment write reads the text it writes over with
    // no edit landing in between, and a mode switch waits for all of them.
    let editQueue: Promise<void> = Promise.resolve();
    const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
      const run = editQueue.then(job);
      editQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    /** Queue a write whose own result the webview is told; one that throws is said, not just logged. */
    const queued = (what: string, job: () => Promise<void>): void => {
      void exclusive(job).catch((e) => {
        this.log.error(`${what} failed`, e);
        this.showErrorWithLogs(ACTION_FAILED);
      });
    };
    /** Queue one of edit mode's writes; one that throws re-renders the editor (`editFailed`). */
    const enqueueEdit = (job: () => Promise<void>): Promise<void> =>
      exclusive(async () => {
        try {
          await job();
        } catch (e) {
          editFailed(e);
        }
      });
    // The block table of the file's prose, kept from the last write while the prose is unchanged.
    let blockTable: { prose: string; blocks: MarkdownBlock[] } | null = null;

    /** Replace what the editor shows with the file as it is, and say why. */
    const rerender = (toast: string): void => {
      lastWebviewProse = proseOf(document.getText());
      pushDocument({ type: "externalChange", text: lastWebviewProse, toast });
      pushComments();
    };

    /**
     * An edit threw — in the splice here, or in the webview's diff. The webview
     * took its edit as the new base when it posted it, so the editor would go
     * on showing text the file doesn't have: re-render it from the file (a new
     * epoch, so nothing built on the lost edit lands after it) and say so.
     */
    const editFailed = (e: unknown): void => {
      this.log.error(`live edit failed in ${document.uri.fsPath}`, e);
      try {
        rerender(EDIT_LOST);
      } catch (again) {
        this.log.error("re-render after a failed edit failed", again);
      }
      this.showErrorWithLogs(EDIT_LOST);
    };

    /**
     * Splice the blocks an edit changed into the file's own bytes. Never
     * adopts a serialization of the whole document: when the editor's blocks
     * and the file's disagree, the edit is refused and the editor re-reads
     * the file.
     */
    const applyBlockEditMessage = async (msg: BlockEditsMessage): Promise<void> => {
      // Made against text the editor has since been sent something else in
      // place of: splicing it would put it in the wrong place. The editor
      // already shows the file, but the keystrokes are gone from it — say so.
      if (msg.epoch < validFrom || msg.epoch > editEpoch) {
        this.log.warn("live edit made on text the editor no longer shows", { file: document.uri.fsPath, epoch: msg.epoch });
        rerender(STALE_EDIT);
        return;
      }
      const current = msg.epoch === editEpoch;
      // A read-only editor makes no edits; one claiming its epoch is refused.
      // (An older epoch is edit mode's, typed as the switch went out.)
      if (readOnly && current) {
        this.log.warn("ignored an edit from a read-only editor", { file: document.uri.fsPath });
        return;
      }
      const source = document.getText();
      const prose = proseOf(source);
      const blocks = blockTable?.prose === prose ? blockTable.blocks : markdownBlocks(prose);
      const result = applyBlockEdits(source, msg, blocks);
      if (!result.ok) {
        this.log.warn("live edit refused", { file: document.uri.fsPath, error: result.error });
        rerender(`Your last edit wasn't saved: ${result.error}. The editor was reloaded from the file.`);
        return;
      }
      // Only the changed range is replaced, so nothing else in an open text
      // editor on this file moves.
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(result.range.start), document.positionAt(result.range.end)),
        result.range.text,
      );
      pendingApply = true;
      let wrote = false;
      try {
        wrote = await vscode.workspace.applyEdit(edit);
      } catch (e) {
        this.log.error("applyEdit failed", e);
      } finally {
        pendingApply = false;
      }
      if (!wrote || document.getText() !== result.source) {
        rerender("Your last edit couldn't be written to the file. The editor was reloaded from the file.");
        return;
      }
      blockTable = { prose: result.prose, blocks: result.blocks };
      lastWebviewProse = result.prose;
      // Typed as the editor was rebuilt on the same text (a mode switch): the
      // rebuilt editor doesn't have it. It does now, quietly — nothing to announce.
      if (!current) pushDocument({ type: "externalChange", text: result.prose, quiet: true });
      if (result.unanchored.length > 0) {
        this.log.info(`CollabEditor: an edit removed the text of ${result.unanchored.join(", ")} in ${document.uri.fsPath}`);
      }
      scheduleAutosave(); // flush the edit to disk, where the agent reads it
      pushComments();
      pushLineMap();
    };

    /** The prose→source line table, or undefined when the setting is off. */
    const lineMapFor = (source: string): number[] | undefined =>
      vscode.workspace.getConfiguration("markdownCollab").get<boolean>("showLineNumbers", false)
        ? sourceLineForProseLine(parseInline(source))
        : undefined;

    const pushLineMap = (): void => {
      void panel.webview.postMessage({
        type: "line-map",
        lineMap: lineMapFor(document.getText()),
      } satisfies LineMapPayload);
    };

    // A thread to land on waits for the webview's first `init`: before it
    // there is no list to find the thread in. After it, a reveal follows the
    // latest `init` posted (a mode switch re-sends one), and the webview runs
    // it once that editor is built.
    let revealAfterFirstInit: string | null = openRequest?.revealThreadId ?? null;
    let initPosted: Promise<void> | null = null;
    const revealThread = (threadId: string): void => {
      if (!initPosted) {
        revealAfterFirstInit = threadId;
        return;
      }
      void initPosted.then(() => panel.webview.postMessage({ type: "reveal-thread", threadId }));
    };
    const livePanel: LivePanel = {
      panel,
      revealThread,
      showDiff: () => {
        if (diffMode) return;
        diffMode = true;
        headProse = undefined;
        if (readOnly) {
          pushComments();
          return;
        }
        // Editing has no source positions to place the stripes by: switch to
        // Reading, after any edit still being written, and say why.
        queued("switch to Reading for the diff", async () => {
          readOnly = true;
          setLiveEditorTypingContext(panel, false);
          sendInit();
        });
        void vscode.window.showInformationMessage(
          "Markdown Collab switched to Reading to show the uncommitted changes. Switch back to Editing to edit.",
        );
      },
      refreshDiff: () => {
        if (!diffMode) return;
        headProse = undefined;
        pushComments();
      },
    };
    const panelsForDoc = openPanels.get(document.uri.toString()) ?? new Set<LivePanel>();
    panelsForDoc.add(livePanel);
    openPanels.set(document.uri.toString(), panelsForDoc);

    /** The sidebar's fields for `source` — the same ones the review view's panel sends. */
    const sidebarFields = (source: string): SidebarFields => ({
      ...sidebarDocumentFields(source),
      suggestMode: readSuggestMode(),
    });

    const pushComments = (): void => {
      const source = document.getText();
      const waiting = claudePending.status(document.uri.toString(), parseInline(source).threads);
      void (async () => {
        const msg: CommentsChangedPayload = {
          type: "sidecar-changed",
          comments: commentsOf(source),
          suggestions: suggestionsOf(source),
          pendingThreadIds: waiting.threadIds,
          pendingLabel: pendingLabel(waiting),
          diff: await computeDiff(source),
          ...sidebarFields(source),
        };
        void panel.webview.postMessage(msg);
      })();
    };

    // What the sidebar's handlers (sidebarHost.ts) need from this editor. Every
    // write goes through `writeDocument`, so the echo guard sees it.
    const sidebarHost: SidebarHostContext = {
      document,
      applySource: async (next) => {
        // An accepted suggestion rewrites prose, and `writeDocument` re-baselines
        // the echo guard to what it writes — so the doc-change handler will never
        // push the new text. Push the refresh here, as the accept handler does.
        const shownProse = lastWebviewProse;
        const ok = await writeDocument(next, { save: true });
        if (!ok) return false;
        const refresh = proseRefreshMessage(shownProse, proseOf(document.getText()));
        if (refresh) {
          lastWebviewProse = refresh.text;
          pushDocument(refresh);
        }
        pushComments();
        return true;
      },
      // Edit mode's queued writes land before the save the agent will read.
      flush: () => exclusive(flushAutosave),
      exclusive,
      refresh: () => pushComments(),
      post: (m) => void panel.webview.postMessage(m),
    };

    // The pending set changes when a payload goes out and when one expires
    // unanswered — neither has a file write to hang off, so re-push here.
    const pendingSub = onPendingChanged((docKey) => {
      if (docKey === document.uri.toString()) pushComments();
    });

    // HEAD moves on commit, which produces no document event. Refetch when
    // the panel regains visibility — the cheapest signal that the user was
    // just doing something else (like committing in a terminal) — same trick
    // InlineCommentsPanel uses for its diff-mode panels.
    const viewStateSub = panel.onDidChangeViewState((e) => {
      // The caret can't be in a panel that isn't the active editor.
      if (!e.webviewPanel.active) setLiveEditorTypingContext(panel, false);
      if (!e.webviewPanel.visible || !diffMode) return;
      headProse = undefined;
      pushComments();
    });

    /**
     * Seed the webview from the file: on its `ready`, and again when the panel
     * switches mode — the webview rebuilds its editor from this.
     */
    const sendInit = (): void => {
      const source = document.getText();
      const text = proseOf(source);
      // The same text re-sent (a mode switch, a reload): edits made on it still apply.
      const sameText = text === lastWebviewProse;
      lastWebviewProse = text;
      lastFrontmatter = frontmatterOf(source);
      const docDirUri = vscode.Uri.file(path.dirname(document.uri.fsPath));
      const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const waiting = claudePending.status(document.uri.toString(), parseInline(source).threads);
      // A new document in the editor: edits made against other text are stale.
      const epoch = ++editEpoch;
      if (!sameText) validFrom = epoch;
      initPosted = (async () => {
        const payload: InitPayload = {
          type: "init",
          text,
          user,
          comments: commentsOf(source),
          suggestions: suggestionsOf(source),
          pendingThreadIds: waiting.threadIds,
          pendingLabel: pendingLabel(waiting),
          frontmatter: lastFrontmatter,
          lineMap: lineMapFor(source),
          imageBaseUris: {
            docDir: panel.webview.asWebviewUri(docDirUri).toString(),
            workspaceFolder: wsFolder
              ? panel.webview.asWebviewUri(wsFolder.uri).toString()
              : null,
          },
          plantuml: readPlantumlConfig(),
          readOnly,
          epoch,
          diff: await computeDiff(source),
          ...sidebarFields(source),
        };
        void panel.webview.postMessage(payload);
      })();
    };

    const messageSub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as ClientMessage | undefined;
      if (!msg || typeof msg !== "object") return;
      // The sidebar's messages (10x-plan-6 P4) go to sidebarHost.ts, ahead of
      // the chain below: its older `delete-comment` means a whole thread.
      if (isSidebarMessage(raw)) {
        void handleSidebarMessage(raw, sidebarHost).catch((e) => {
          this.log.error(`sidebar ${raw.type} failed`, e);
          this.showErrorWithLogs(ACTION_FAILED);
        });
        return;
      }
      // The skill banner is read off the disk; it follows `init` rather than
      // holding it up.
      if (msg.type === "ready") void postSkillStatus(sidebarHost.post);
      if (msg.type === "ready") {
        sendInit();
        if (revealAfterFirstInit) revealThread(revealAfterFirstInit);
        revealAfterFirstInit = null;
      } else if (msg.type === "edit") {
        // A read-only editor never edits; anything claiming to be an edit from
        // one would rewrite the file from its serialization — refuse it.
        if (readOnly) return;
        queued("live edit", () => applyProseEdit(msg.text, msg.anchors));
      } else if (msg.type === "edit-blocks") {
        // In turn, and checked against the mode and epoch when its turn comes.
        void enqueueEdit(() => applyBlockEditMessage(msg));
      } else if (msg.type === "set-read-only") {
        // Per panel, never written to the setting. The editor is rebuilt from
        // the file in the new mode, after any edit still being written.
        const next = msg.readOnly === true;
        queued("mode switch", async () => {
          readOnly = next;
          if (next) setLiveEditorTypingContext(panel, false);
          sendInit();
        });
      } else if (msg.type === "undo" || msg.type === "redo") {
        // Through the same queue as a block edit, so it runs after any edit
        // still being written reaches the file first. With this custom
        // editor active, the workbench's undo/redo command undoes/redoes the
        // text document for it; skipped (and logged, not shown) when this
        // panel isn't the active editor — the command would act on whatever is.
        const kind = msg.type;
        void enqueueEdit(async () => {
          if (panel.active) {
            await vscode.commands.executeCommand(kind);
            // Like any edit: flush it to disk, where the agent reads the file.
            scheduleAutosave();
          } else {
            this.log.info(
              `CollabEditor: ${kind} skipped — ${path.basename(document.uri.fsPath)} isn't the active editor`,
            );
          }
        });
      } else if (msg.type === "editor-focus") {
        // Only the active panel's caret matters — a background panel's view
        // can't really have focus, but the message is trusted no further.
        if (msg.focused && !panel.active) return;
        setLiveEditorTypingContext(panel, msg.focused);
      } else if (msg.type === "ready-with-content") {
        lastReadyByUri.set(document.uri.toString(), msg);
        this.log.info(
          `CollabEditor: webview ready for ${document.uri.fsPath} — content length=${msg.length}, synced=${msg.synced}${msg.error ? `, error=${msg.error}` : ""}`,
        );
      } else if (msg.type === "highlight-report") {
        lastHighlightByUri.set(document.uri.toString(), msg.ids);
      } else if (msg.type === "webview-error") {
        // Surface webview-side failures (Milkdown init errors, ProseMirror
        // schema mismatches, etc.) into the extension's output channel so
        // they're visible without opening the webview devtools.
        lastWebviewErrorByUri.set(document.uri.toString(), msg);
        this.log.info(
          `CollabEditor: webview error for ${document.uri.fsPath} (${msg.stage}): ${msg.message}`,
        );
        if (msg.stage === "edit-blocks") {
          // The webview couldn't diff an edit it had already taken as its base.
          void exclusive(async () => editFailed(new Error(`the webview couldn't report an edit: ${msg.message}`)));
        } else {
          // The editor didn't come up, or didn't land where it was sent: the
          // panel is blank or wrong until it's rebuilt. Anything else (a
          // diagram that didn't render) stays in the log.
          const shown = SHOWN_WEBVIEW_FAILURES.get(msg.stage);
          if (shown) {
            void vscode.window.showErrorMessage(shown(path.basename(document.uri.fsPath)), "Reload").then((choice) => {
              if (choice === "Reload") queued("reload", async () => sendInit());
            });
          }
        }
      } else if (msg.type === "add-comment") {
        queued("add comment", async () => {
          // Named in text the editor has since been sent something else in place of.
          if (msg.editRange && typeof msg.epoch === "number" && msg.epoch < validFrom) {
            const error = "The document changed since you selected this text. Select it again.";
            void panel.webview.postMessage({ type: "add-comment-result", ok: false, error });
            return;
          }
          const result = await this.addComment(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        });
      } else if (msg.type === "reply-comment") {
        queued("reply", async () => {
          const result = await this.replyComment(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        });
      } else if (msg.type === "toggle-resolve-comment") {
        queued("resolve", async () => {
          const result = await this.toggleResolve(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        });
      } else if (msg.type === "delete-comment") {
        queued("delete", async () => {
          const result = await this.deleteComment(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        });
      } else if (msg.type === "delete-single-comment") {
        queued("delete", async () => {
          const result = await this.deleteSingleComment(document, msg, writeDocument);
          void panel.webview.postMessage(result);
          if (result.ok) pushComments();
        });
      } else if (msg.type === "accept-suggestion" || msg.type === "reject-suggestion") {
        const anchorId = msg.anchorId;
        const mode = msg.type === "accept-suggestion" ? "accept" : "reject";
        queued(`${mode} suggestion`, async () => {
          const source = document.getText();
          const parsed = parseInline(source);
          const found = parsed.suggestions.some((s) => s.anchorId === anchorId);
          // Accept needs a live anchor to place the change; reject only needs
          // the record. Silently ignore an unknown/unplaceable id (the webview
          // disables Accept when unanchored, so this is a stale-message guard).
          if (!found || (mode === "accept" && !parsed.anchors.has(anchorId))) return;
          const next =
            mode === "accept" ? acceptSuggestion(source, anchorId) : rejectSuggestion(source, anchorId);
          // Accept rewrites the anchored prose, and writeDocument re-baselines
          // the echo guard (`lastWebviewProse`) to what it writes — so the
          // doc-change handler will never push the new text to the editor.
          // Capture the prose the editor is showing now and push the refresh
          // ourselves after the write, or the editor keeps the old wording
          // until the next external edit.
          const shownProse = lastWebviewProse;
          const ok = await writeDocument(next, { save: true });
          if (!ok) return;
          const refresh = proseRefreshMessage(shownProse, proseOf(document.getText()));
          if (refresh) {
            lastWebviewProse = refresh.text;
            pushDocument(refresh);
          }
          pushComments();
        });
      } else if (msg.type === "open-link") {
        void this.handleOpenLink(msg, panel, document);
      } else if (msg.type === "invoke-command") {
        // Flush any unsaved edits before handing off so Claude reads the
        // human's latest, not a stale on-disk copy.
        void (async () => {
          const saved = await exclusive(flushAutosave);
          if (!saved && (msg.command === "send-to-claude" || msg.command === "send-thread-claude")) {
            void vscode.window.showWarningMessage(
              `Not sent: ${path.basename(document.uri.fsPath)} couldn't be saved, so your agent would read the old version.`,
            );
            return;
          }
          await this.handleInvokeCommand(msg, document);
        })();
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
        // The person's own undo/redo (Cmd+Z in Editing mode, or the text
        // editor's): no "Claude updated…" notice, no flash, and the view
        // goes to the change instead of leaving the scroll where it was.
        const isUndoRedo =
          e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
        const changed = isUndoRedo ? null : summarizeChange(lastWebviewProse, newProse);
        lastWebviewProse = newProse;
        pushDocument(
          isUndoRedo
            ? { type: "externalChange", text: newProse, quiet: true, reveal: true }
            : { type: "externalChange", text: newProse, changed },
        );
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
      // Every edit can move every line below it, so the map is re-sent with
      // the change rather than only when the setting is toggled.
      pushLineMap();
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("markdownCollab.showLineNumbers")) pushLineMap();
      // The sidebar's suggest-mode switch follows the setting wherever it changed.
      if (e.affectsConfiguration("markdownCollab.proposeEditsAsSuggestions")) pushComments();
      // `markdownCollab.liveEditor.readOnly` isn't followed here: it only seeds
      // a newly opened panel, and an open one keeps the mode its switch chose.
    });

    panel.onDidDispose(() => {
      // Guarded internally: a no-op unless this panel is the one that last
      // set the (global) context key true.
      setLiveEditorTypingContext(panel, false);
      panelsForDoc.delete(livePanel);
      if (panelsForDoc.size === 0) openPanels.delete(document.uri.toString());
      configSub.dispose();
      if (autosaveTimer) clearTimeout(autosaveTimer);
      messageSub.dispose();
      docSub.dispose();
      pendingSub.dispose();
      viewStateSub.dispose();
    });
  }

  /** An error notification whose one action opens the log. */
  private showErrorWithLogs(message: string): void {
    void vscode.window.showErrorMessage(message, "Show Logs").then((choice) => {
      if (choice === "Show Logs") this.log.show();
    });
  }

  // --- comment handlers ---------------------------------------------------
  // Each rewrites the .md source via the inline bridge and writes it back
  // through `writeDocument`. Returning the exact payload the webview expects
  // keeps the message plumbing in resolveCustomTextEditor trivial.

  private async addComment(
    document: vscode.TextDocument,
    msg: AddCommentMessage,
    writeDocument: (next: string, opts?: { save?: boolean }) => Promise<boolean>,
  ): Promise<{ type: "add-comment-result"; ok: boolean; error?: string }> {
    // No workspace-folder requirement. Comments live inside the .md itself —
    // there is no sidecar to place and no relative path to compute — and the
    // write goes out as a WorkspaceEdit against this document, which works for
    // any open file. The check here was left over from the sidecar era and
    // refused every comment on a file opened on its own.
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
    // The markers go exactly where the editor's selection is in the file's
    // own bytes, or the add is refused: nothing is searched for, and nothing
    // the editor serialized is adopted as the body.
    let result: { ok: true; source: string } | { ok: false; error: string };
    if (typeof msg.proseStart === "number" || typeof msg.proseEnd === "number") {
      // Read-only editor: the selection arrives as a span of the file's own prose.
      // In read-only mode the anchor's context is the prose around the selection.
      result = addThreadAtProseRange(
        document.getText(),
        {
          start: msg.proseStart ?? -1,
          end: msg.proseEnd ?? -1,
          text: msg.proseText ?? "",
          before: msg.anchor.contextBefore,
          after: msg.anchor.contextAfter,
        },
        newComment,
      );
    } else if (msg.editRange) {
      // Edit mode: named by structure, found by the same alignment.
      result = addThreadAtEditorRange(document.getText(), msg.editRange, newComment);
    } else {
      result = { ok: false, error: "The editor didn't say where the selection is. Select the text again." };
    }
    if (!result.ok) {
      this.log.warn("addComment refused", { file: document.uri.fsPath, error: result.error });
      return { type: "add-comment-result", ok: false, error: result.error };
    }
    const wrote = await writeDocument(result.source, { save: true });
    if (!wrote) {
      return { type: "add-comment-result", ok: false, error: "Could not write the comment into the document." };
    }
    this.log.info(
      `CollabEditor: added comment on ${document.uri.fsPath} (anchor=${JSON.stringify(anchor.text.slice(0, 40))})`,
    );
    return { type: "add-comment-result", ok: true };
  }

  private async replyComment(
    document: vscode.TextDocument,
    msg: ReplyCommentMessage,
    writeDocument: (next: string, opts?: { save?: boolean }) => Promise<boolean>,
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
    const wrote = await writeDocument(next, { save: true });
    return wrote
      ? { type: "reply-comment-result", ok: true, commentId }
      : { type: "reply-comment-result", ok: false, commentId, error: "could not write reply" };
  }

  private async toggleResolve(
    document: vscode.TextDocument,
    msg: ToggleResolveCommentMessage,
    writeDocument: (next: string, opts?: { save?: boolean }) => Promise<boolean>,
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
    const wrote = await writeDocument(next, { save: true });
    return wrote
      ? { type: "toggle-resolve-result", ok: true, commentId, resolved: nextResolved }
      : { type: "toggle-resolve-result", ok: false, commentId, error: "could not write resolve state" };
  }

  private async deleteComment(
    document: vscode.TextDocument,
    msg: DeleteCommentMessage,
    writeDocument: (next: string, opts?: { save?: boolean }) => Promise<boolean>,
  ): Promise<{ type: "delete-comment-result"; ok: boolean; commentId: string; error?: string }> {
    const commentId = msg.commentId;
    const next = deleteThread(document.getText(), commentId);
    if (next === null) {
      return { type: "delete-comment-result", ok: false, commentId, error: "comment id not found" };
    }
    const wrote = await writeDocument(next, { save: true });
    return wrote
      ? { type: "delete-comment-result", ok: true, commentId }
      : { type: "delete-comment-result", ok: false, commentId, error: "could not write deletion" };
  }

  private async deleteSingleComment(
    document: vscode.TextDocument,
    msg: DeleteSingleCommentMessage,
    writeDocument: (next: string, opts?: { save?: boolean }) => Promise<boolean>,
  ): Promise<{ type: "delete-comment-result"; ok: boolean; commentId: string; error?: string }> {
    const commentId = msg.commentId;
    const next = deleteCommentFromThread(document.getText(), msg.threadId, commentId);
    if (next === null) {
      return { type: "delete-comment-result", ok: false, commentId, error: "comment not found" };
    }
    const wrote = await writeDocument(next, { save: true });
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
      this.log.info(
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
        this.log.info(
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
      if (decision.targetFsPath.toLowerCase().endsWith(".md")) {
        // Another document stays in the review view, as the previous review
        // view's links did — through the command, which honours
        // `markdownCollab.classicReviewView`.
        await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", targetUri);
      } else {
        // vscode.open respects the user's editor associations.
        await vscode.commands.executeCommand("vscode.open", targetUri);
      }
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
        this.log.info(
          `CollabEditor: sendAllToClaude failed: ${(e as Error).message}`,
        );
      }
    } else if (msg.command === "remove-resolved") {
      // The command owns the confirm and the write, so the modal wording and
      // the undoable edit are defined once for every surface that offers this.
      await vscode.commands.executeCommand(
        "markdownCollab.removeResolvedComments",
        document.uri,
      );
    } else if (msg.command === "finalize") {
      await vscode.commands.executeCommand(
        "markdownCollab.finalizeDocument",
        document.uri,
      );
    } else if (msg.command === "copy-prompt") {
      try {
        // The existing copyClaudePrompt command operates on the active
        // editor; ours isn't a TextEditor so we can't rely on that path.
        // Mimic its payload directly.
        const folder = folderForDocument(document.uri);
        const rel = path.relative(folder.uri.fsPath, document.uri.fsPath);
        const prompt = `${workflowOpener()} to address the unresolved review comments on ${rel}.`;
        await vscode.env.clipboard.writeText(prompt);
        void vscode.window.showInformationMessage(
          "Prompt copied — paste it into your agent.",
        );
      } catch (e) {
        this.log.info(
          `CollabEditor: copy-prompt failed: ${(e as Error).message}`,
        );
      }
    } else if (msg.command === "send-thread-claude" && msg.commentId) {
      try {
        await vscode.commands.executeCommand(
          "markdownCollab.sendThreadToClaude",
          document.uri,
          msg.commentId,
        );
      } catch (e) {
        this.log.info(
          `CollabEditor: sendThreadToClaude failed: ${(e as Error).message}`,
        );
      }
    } else if (msg.command === "copy-thread-claude" && msg.commentId) {
      try {
        await vscode.commands.executeCommand(
          "markdownCollab.copyThreadToClaude",
          document.uri,
          msg.commentId,
        );
      } catch (e) {
        this.log.info(
          `CollabEditor: copyThreadToClaude failed: ${(e as Error).message}`,
        );
      }
    }
  }

  private async handleDrawioRead(
    msg: DrawioReadMessage,
    document: vscode.TextDocument,
  ): Promise<DrawioReadResult> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return runDrawioRead(
      {
        requestId: msg.requestId,
        href: msg.href,
        documentPath: document.uri.fsPath,
        workspaceRoot: folder?.uri.fsPath ?? null,
      },
      async (absPath) => {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
        return Buffer.from(bytes).toString("utf8");
      },
      (line) => this.log.trace(line),
    );
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "client.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "client.css"),
    );
    const sharedStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "comments-shared.css"),
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
      `img-src ${webview.cspSource} data: https: http:`,
      // No `connect-src`: the live editor is single-human + Claude with no
      // network relay, so the webview opens no sockets or fetches. It falls
      // back to default-src 'none', blocking all of them.
    ].join("; ");

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${sharedStyleUri}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
${liveEditorShellBody()}
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
