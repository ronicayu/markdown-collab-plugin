// "Ask Claude to Review" (v2 Review Mode entry point), the review-conventions
// editor, and the review-summary/unread-walk commands (10x-plan-4 P3.2 split
// of extension.ts).

import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { agentGroupLabel } from "../agentIdentity";
import { unreadAgentSlug } from "../inlineComments/claudeUnread";
import { folderForDocument, promptPathFor } from "../workspaceFolder";
import { buildReviewRequestPayload, type SendMode } from "../sendToClaude";
import {
  buildMultiFileReviewPayload,
  totalBytes,
  type ReviewFile,
} from "../multiFileReview";
import { parse as parseInline } from "../inlineComments/format";
import { InlineCommentsPanel } from "../inlineComments/inlineCommentsPanel";
import { CollabEditorProvider } from "../collab/collabEditorProvider";
import { CONVENTIONS_REL, CONVENTIONS_TEMPLATE } from "../reviewConventions";
import { buildReviewDigest, type DigestFile } from "../reviewDigest";
import type { ReviewView } from "../reviewView";
import type { TerminalTracker } from "../transports/terminalTracker";
import { activeMarkdownUri } from "../activeMarkdown";
import { requireTrust } from "../trust";
import { dispatchReviewPayload } from "./send";
import type { CommandDeps } from "./deps";
import type { OpenReviewView } from "./reviewViewRouter";

/**
 * Open the conventions file, creating it from the template first time. The
 * scaffold matters more than it looks: an empty file gives no clue what belongs
 * in it, and this is prose whose whole value is being specific.
 */
async function invokeEditReviewConventions(log: Logger): Promise<void> {
  if (!requireTrust("Editing review conventions")) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Markdown Collab: open a workspace folder first — conventions are per project.",
    );
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, ...CONVENTIONS_REL.split("/"));
  let existed = true;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    existed = false;
  }
  if (!existed) {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".markdown-collab"));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(CONVENTIONS_TEMPLATE, "utf8"));
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Markdown Collab: could not create ${CONVENTIONS_REL} — ${(e as Error).message}`,
      );
      return;
    }
    log.info("created review conventions file", { file: CONVENTIONS_REL });
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  if (!existed) {
    void vscode.window.showInformationMessage(
      "Write your standing review conventions here. They're sent with every review request.",
    );
  }
}

/**
 * Summarize the review state of the selection into a scratch document
 * (10x-plan-2 P3.2). Everything it says is already in the files, so this is a
 * pure read — no Claude round trip to restate facts it could read itself.
 */
async function invokeReviewSummary(
  selection: vscode.Uri[],
  log: Logger,
): Promise<void> {
  const uris = await expandMarkdownSelection(selection);
  if (uris.length === 0) {
    void vscode.window.showWarningMessage(
      "Open a Markdown file (or select some) first, then run this command.",
    );
    return;
  }
  const files: DigestFile[] = [];
  for (const uri of uris) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      files.push({ rel: vscode.workspace.asRelativePath(uri), parsed: parseInline(doc.getText()) });
    } catch (e) {
      log.warn("review summary: skipping unreadable file", { file: uri.fsPath, error: (e as Error).message });
    }
  }
  if (files.length === 0) {
    void vscode.window.showWarningMessage("Review summary: none of the selected files could be read.");
    return;
  }
  // An untitled document, not a file: this is something to read, copy, and
  // close — writing it to disk would leave litter in the workspace.
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: buildReviewDigest(files),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

const RECENT_FOCUS_KEY = "markdownCollab.recentFocusHistory";
const RECENT_FOCUS_MAX = 5;
const FOCUS_MAX_LEN = 500;
const LARGE_DOC_WARN_BYTES = 50 * 1024;

const MARKDOWN_GLOB = "**/*.{md,markdown}";

function isMarkdownFsPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * What the user actually pointed at. Explorer context menus invoke a command
 * as `(clickedUri, allSelectedUris)`; everything else (palette, editor title)
 * passes one uri or nothing, in which case the active editor is the subject.
 */
function resolveSelection(arg?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
  if (Array.isArray(selected)) {
    const uris = selected.filter((u): u is vscode.Uri => u instanceof vscode.Uri);
    if (uris.length > 0) return uris;
  }
  if (arg instanceof vscode.Uri) return [arg];
  const active = activeMarkdownUri();
  return active ? [active] : [];
}

/**
 * Expand a selection of files and folders to the `.md` files it contains,
 * deduped and in path order. Folders are walked with the same exclusion the
 * Markdown Review tree uses, so a folder review covers exactly the files that
 * tree would show.
 */
async function expandMarkdownSelection(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
  const found = new Map<string, vscode.Uri>();
  for (const uri of uris) {
    let isDirectory = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      continue; // vanished between the click and here
    }
    if (isDirectory) {
      const matches = await vscode.workspace.findFiles(
        new vscode.RelativePattern(uri, MARKDOWN_GLOB),
        "**/node_modules/**",
      );
      for (const m of matches) found.set(m.fsPath, m);
    } else if (isMarkdownFsPath(uri.fsPath)) {
      found.set(uri.fsPath, uri);
    }
  }
  return [...found.values()].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

/**
 * Entry point for "Ask Claude to Review", for any selection shape: one file
 * (the original flow), a folder, or a multi-select. A multi-file selection
 * becomes ONE review pass so Claude can compare the files against each other.
 */
async function invokeAskClaudeToReviewSelection(
  selection: vscode.Uri[],
  log: Logger,
  tracker: TerminalTracker,
  workspaceState: vscode.Memento,
  globalState: vscode.Memento,
  delta = false,
  /** A focus decided by the caller; skips the focus prompt. "" = general review. */
  presetFocus?: string,
  /** Force this dispatch's send mode, bypassing config/remembered/ask (10x-plan-4 P2.4). */
  forceMode?: SendMode,
): Promise<void> {
  if (selection.length === 0) {
    void vscode.window.showWarningMessage(
      "Open a Markdown file first, then run this command.",
    );
    return;
  }
  const files = await expandMarkdownSelection(selection);
  if (files.length === 0) {
    void vscode.window.showWarningMessage(
      selection.length === 1 && isMarkdownFsPath(selection[0].fsPath)
        ? `Could not read ${path.basename(selection[0].fsPath)}.`
        : "Ask Agent to Review only supports .md files — the selection contains none.",
    );
    return;
  }

  if (files.length === 1) {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(files[0]);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Failed to open ${files[0].fsPath}: ${(e as Error).message}`,
      );
      return;
    }
    await invokeAskClaudeToReview(doc, log, tracker, workspaceState, globalState, delta, presetFocus, forceMode);
    return;
  }

  if (delta) {
    // A delta pass is per-file by construction: the checkpoint, the changed
    // sections, and the existing threads are all per-document. Reviewing a
    // folder incrementally would mean N prompts, which is a different feature.
    void vscode.window.showWarningMessage(
      "Review changes since last pass works on one file at a time. Open the file and run it again.",
    );
    return;
  }

  await invokeAskClaudeToReviewMulti(
    files,
    log,
    tracker,
    workspaceState,
    globalState,
    presetFocus,
    forceMode,
  );
}

/**
 * One Review Mode pass over several files. Everything the single-file flow
 * does — soft size confirm, focus prompt, pending-review notification — but
 * the confirm is on the summed size and the payload lists every file.
 */
async function invokeAskClaudeToReviewMulti(
  uris: vscode.Uri[],
  log: Logger,
  tracker: TerminalTracker,
  workspaceState: vscode.Memento,
  globalState: vscode.Memento,
  presetFocus?: string,
  forceMode?: SendMode,
): Promise<void> {
  const folder = folderForDocument(uris[0]);
  // The payload's paths are relative to one folder, so a selection spanning
  // several is reviewed one folder at a time rather than silently mixing
  // incomparable relative paths.
  const inFolder = uris.filter(
    (u) => folderForDocument(u).uri.fsPath === folder.uri.fsPath,
  );
  const skipped = uris.length - inFolder.length;

  const files: ReviewFile[] = [];
  for (const uri of inFolder) {
    let bytes = 0;
    try {
      bytes = (await vscode.workspace.fs.stat(uri)).size;
    } catch {
      // Unreadable size is not a reason to drop the file from the review;
      // it only makes the soft confirm slightly optimistic.
    }
    files.push({ rel: workspaceRelPosix(folder, uri), promptPath: promptPathFor(uri), bytes });
  }

  const total = totalBytes(files);
  if (total > LARGE_DOC_WARN_BYTES) {
    const kb = Math.round(total / 1024);
    const pick = await vscode.window.showWarningMessage(
      `Reviewing ${files.length} files (${kb} KB total) — the agent's review may take a while and use significant context.`,
      { modal: false },
      "Continue",
      "Cancel",
    );
    if (pick !== "Continue") return;
  }

  const focus = presetFocus ?? (await promptForFocus(globalState));
  if (focus === undefined) return; // user cancelled
  const trimmedFocus = focus === "" ? undefined : focus;
  if (trimmedFocus) await pushRecentFocus(globalState, trimmedFocus);

  const payload = buildMultiFileReviewPayload(files, trimmedFocus);

  // Snapshot thread state in every open panel for the selection, so each one
  // scrolls to Claude's first new thread when the pass lands.
  for (const uri of inFolder) {
    InlineCommentsPanel.notifyReviewPending(uri);
    CollabEditorProvider.notifyReviewPending(uri);
  }

  if (skipped > 0) {
    log.warn("review: files outside the folder were skipped", { skipped, folder: folder.name });
    void vscode.window.showInformationMessage(
      `Reviewing ${files.length} file(s) in ${folder.name}; ${skipped} outside it were skipped — run the command again from that folder.`,
    );
  }

  await dispatchReviewPayload(
    payload,
    log,
    tracker,
    workspaceState,
    folder,
    { kind: "review-request", hasFocus: Boolean(trimmedFocus) },
    forceMode ? { forceMode } : undefined,
  );
}

/** Workspace-relative path with POSIX separators — it goes into a prompt. */
function workspaceRelPosix(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
}

/**
 * Walk every thread Claude opened and the human hasn't answered yet, across
 * all files in the Markdown Review tree. Each invocation advances one thread
 * and wraps at the end; the cursor is module state, so the walk survives
 * switching editors but not a window reload (by design — a reload should start
 * the pass over rather than resume mid-list from stale positions).
 */
let unreadWalkCursor: { docPath: string; threadId: string } | null = null;

async function invokeNextUnreadFromClaude(
  reviewView: ReviewView,
  log: Logger,
  openReviewView: OpenReviewView,
): Promise<void> {
  await reviewView.ensureScanned();
  const unread = reviewView.listClaudeUnread();
  if (unread.length === 0) {
    unreadWalkCursor = null;
    void vscode.window.showInformationMessage(
      "No unread threads from an agent. Run 'Ask Agent to Review This Doc' to start a pass.",
    );
    return;
  }
  const currentIdx = unreadWalkCursor
    ? unread.findIndex(
        (u) =>
          u.docPath === unreadWalkCursor?.docPath &&
          u.thread.id === unreadWalkCursor?.threadId,
      )
    : -1;
  const next = unread[(currentIdx + 1) % unread.length];
  unreadWalkCursor = { docPath: next.docPath, threadId: next.thread.id };

  try {
    // The review view, not the source file (10x-plan-3 P0.3). The thing being
    // walked is a thread, and a thread's home is the panel that can show its
    // replies and let you answer. This walk used to end on the raw text
    // editor, i.e. on the marker soup the thread is stored in.
    await openReviewView(vscode.Uri.file(next.docPath), { revealThreadId: next.thread.id });
  } catch (e) {
    log.error(`next-unread failed for ${next.docPath}`, e);
    void vscode.window.showErrorMessage(
      `Could not open ${path.basename(next.docPath)}.`,
    );
    return;
  }
  const position = ((currentIdx + 1) % unread.length) + 1;
  // Names the agent(s) the unread threads came from — the sidebar's "New from X" rule.
  const from = agentGroupLabel(unread.map((u) => unreadAgentSlug(u.thread) ?? "agent")).noun;
  void vscode.window.setStatusBarMessage(
    `Unread from ${from} ${position}/${unread.length} — ${path.basename(next.docPath)}`,
    5000,
  );
}

async function invokeAskClaudeToReview(
  doc: vscode.TextDocument,
  log: Logger,
  tracker: TerminalTracker,
  workspaceState: vscode.Memento,
  globalState: vscode.Memento,
  /** Review only what changed since the last recorded pass (10x-plan-2 P1.1). */
  delta = false,
  presetFocus?: string,
  /** Force this dispatch's send mode, bypassing config/remembered/ask (10x-plan-4 P2.4). */
  forceMode?: SendMode,
): Promise<void> {
  const folder = folderForDocument(doc.uri);

  // Soft size confirm — large docs may take a while; let the user back out.
  const byteSize = Buffer.byteLength(doc.getText(), "utf8");
  if (byteSize > LARGE_DOC_WARN_BYTES) {
    const kb = Math.round(byteSize / 1024);
    const pick = await vscode.window.showWarningMessage(
      `This file is ${kb} KB — the agent's review may take a while and use significant context.`,
      { modal: false },
      "Continue",
      "Cancel",
    );
    if (pick !== "Continue") return;
  }

  const focus = presetFocus ?? (await promptForFocus(globalState));
  if (focus === undefined) return; // user cancelled
  const trimmedFocus = focus === "" ? undefined : focus;

  const result = buildReviewRequestPayload(doc, trimmedFocus, { delta });
  if (result.kind === "unchanged") {
    // The whole point of a delta pass is not re-reading an unchanged file.
    void vscode.window.showInformationMessage(
      `Nothing has changed in ${path.basename(doc.uri.fsPath)} since the last review pass.`,
    );
    return;
  }
  if (delta && result.fullPass) {
    void vscode.window.showInformationMessage(
      "No previous review pass is recorded for this file — reviewing all of it. The next pass can be incremental.",
    );
  }

  if (trimmedFocus) await pushRecentFocus(globalState, trimmedFocus);

  // Snapshot current thread state in any open review view or live editor for
  // this doc BEFORE dispatching. The panel will auto-scroll to the first newly
  // arrived claude-initiated thread once Claude finishes its pass.
  InlineCommentsPanel.notifyReviewPending(doc.uri);
  CollabEditorProvider.notifyReviewPending(doc.uri);

  await dispatchReviewPayload(
    result.payload,
    log,
    tracker,
    workspaceState,
    folder,
    { kind: "review-request", hasFocus: Boolean(trimmedFocus) },
    forceMode ? { forceMode } : undefined,
  );
}

/**
 * Returns the focus string the user wants Claude to use, "" for an
 * explicit general review (no focus), or `undefined` if the user
 * cancelled. When there is recent-focus history, a quick-pick is shown
 * first with the option to reuse a prior focus or enter a new one.
 */
async function promptForFocus(
  globalState: vscode.Memento,
): Promise<string | undefined> {
  const history = readRecentFocus(globalState);
  if (history.length > 0) {
    interface FocusItem extends vscode.QuickPickItem {
      tag: "history" | "custom" | "general";
      value?: string;
    }
    const items: FocusItem[] = [
      {
        label: "$(edit) Enter a new focus…",
        description: "Tell the agent what to look for",
        tag: "custom",
      },
      {
        label: "$(eye) General review (no focus)",
        description: "Let the agent flag anything substantive",
        tag: "general",
      },
      ...history.map<FocusItem>((h) => ({
        label: `$(history) ${h}`,
        tag: "history",
        value: h,
      })),
    ];
    const pick = await vscode.window.showQuickPick<FocusItem>(items, {
      placeHolder: "What should the agent look for?",
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.tag === "general") return "";
    if (pick.tag === "history" && pick.value) return pick.value;
    // fall through to InputBox for "custom"
  }
  const entered = await vscode.window.showInputBox({
    prompt: "What should the agent look for? (leave blank for a general review)",
    placeHolder: "e.g. check API examples for correctness",
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (v.length > FOCUS_MAX_LEN) {
        return `Focus is too long (${v.length}/${FOCUS_MAX_LEN}). Shorten or split into multiple review passes.`;
      }
      if (/[\r\n]/.test(v)) {
        return "Focus must be a single line — newlines would inject extra instructions into the prompt.";
      }
      return null;
    },
  });
  if (entered === undefined) return undefined;
  return entered.trim();
}

function readRecentFocus(globalState: vscode.Memento): string[] {
  const raw = globalState.get<unknown>(RECENT_FOCUS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

async function pushRecentFocus(
  globalState: vscode.Memento,
  focus: string,
): Promise<void> {
  const prior = readRecentFocus(globalState).filter((f) => f !== focus);
  const next = [focus, ...prior].slice(0, RECENT_FOCUS_MAX);
  await globalState.update(RECENT_FOCUS_KEY, next);
}

/**
 * A focus passed by a programmatic caller (`{ focus: "" }` = general review),
 * held to the same rules the input box enforces — one line, bounded — since it
 * lands in the prompt verbatim. Anything else means "ask the human".
 */
function presetFocusFrom(opts: { focus?: unknown } | undefined): string | undefined {
  const focus = opts?.focus;
  if (typeof focus !== "string") return undefined;
  if (focus.length > FOCUS_MAX_LEN || /[\r\n]/.test(focus)) return undefined;
  return focus.trim();
}

/**
 * A send mode forced by a programmatic caller (10x-plan-4 P2.4's empty-state
 * button, via `handleEmptyStateReview`) — anything not one of the three
 * concrete modes means "don't force one", same as an absent value.
 */
function forceModeFrom(opts: { forceMode?: unknown } | undefined): SendMode | undefined {
  const mode = opts?.forceMode;
  return mode === "headless" || mode === "terminal" || mode === "clipboard" ? mode : undefined;
}

/** Register the review-mode family of commands: conventions, summary, "Ask
 * Claude to Review" (single/folder/changes), and the unread walk. */
export function registerReviewCommands(deps: CommandDeps): void {
  const { context, reviewLog, reviewView, terminalTracker, openReviewView } = deps;

  context.subscriptions.push(
    vscode.commands.registerCommand("markdownCollab.editReviewConventions", async () => {
      await invokeEditReviewConventions(reviewLog);
    }),
    vscode.commands.registerCommand(
      "markdownCollab.reviewSummary",
      async (arg?: vscode.Uri, selected?: vscode.Uri[]) => {
        await invokeReviewSummary(resolveSelection(arg, selected), reviewLog);
      },
    ),
  );

  // One handler, two command ids: the explorer needs a folder-appropriate
  // title ("These Docs") next to the file one, and a menu entry can't override
  // a command's title.
  const askClaudeToReview = async (
    arg?: vscode.Uri,
    selected?: vscode.Uri[],
    opts?: { focus?: unknown; forceMode?: unknown },
  ): Promise<void> => {
    await invokeAskClaudeToReviewSelection(
      resolveSelection(arg, selected),
      reviewLog,
      terminalTracker,
      context.workspaceState,
      context.globalState,
      false,
      presetFocusFrom(opts),
      forceModeFrom(opts),
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("markdownCollab.askClaudeToReview", askClaudeToReview),
    vscode.commands.registerCommand("markdownCollab.askClaudeToReviewFolder", askClaudeToReview),
    vscode.commands.registerCommand(
      "markdownCollab.askClaudeToReviewChanges",
      async (arg?: vscode.Uri, selected?: vscode.Uri[]) => {
        await invokeAskClaudeToReviewSelection(
          resolveSelection(arg, selected),
          reviewLog,
          terminalTracker,
          context.workspaceState,
          context.globalState,
          true,
        );
      },
    ),
    vscode.commands.registerCommand("markdownCollab.nextUnreadFromClaude", async () => {
      await invokeNextUnreadFromClaude(reviewView, reviewLog, openReviewView);
    }),
  );
}
