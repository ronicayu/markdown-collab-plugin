import * as path from "path";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { isInsideRoot } from "../pathUtils";
import { currentAuthorName } from "../authorName";
import { repairIntegrity } from "../inlineComments/integrity";
import { parse as parseInline } from "../inlineComments/format";
import {
  DocOpError,
  opFinalize,
  opOpenAt,
  opPurgeResolved,
  opReopen,
  opReply,
  opResolve,
} from "../inlineComments/docOps";
import type { ReviewNode } from "../reviewView";
import { ConflictError, mutateDocument } from "../collab/documentWriteQueue";
import { activeMarkdownUri } from "../activeMarkdown";
import type { CommandDeps } from "./deps";
import { reviewViewOptsFrom } from "./reviewViewRouter";

/**
 * Confirmed with a modal that names the count, because it removes review
 * history from the file. It is one undo step, which the modal says.
 */
async function invokeRemoveResolvedComments(arg: vscode.Uri | undefined, log: Logger): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : activeMarkdownUri();
  if (!uri) {
    void vscode.window.showWarningMessage("Open a Markdown file first, then run this command.");
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    log.error(`could not open ${uri.fsPath}`, e);
    void vscode.window.showErrorMessage(`Could not open ${path.basename(uri.fsPath)}.`);
    return;
  }

  const source = doc.getText();
  const resolved = parseInline(source).threads.filter((t) => t.status === "resolved");
  if (resolved.length === 0) {
    void vscode.window.showInformationMessage("No resolved comments in this file.");
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Remove ${resolved.length} resolved comment${resolved.length === 1 ? "" : "s"} from ${path.basename(uri.fsPath)}?`,
    {
      modal: true,
      detail:
        "Their replies are deleted from the file along with them. Open comments and pending suggestions are left alone. This is a single undo step.",
    },
    "Remove",
  );
  if (choice !== "Remove") return;

  // Removes what is resolved now, not what the dialog counted.
  const result = await applyOp(doc, opPurgeResolved, log, "remove resolved", (err) =>
    err.code === "nothing_to_do"
      ? void vscode.window.showInformationMessage("No resolved comments left in this file — nothing to remove.")
      : void vscode.window.showWarningMessage(`Could not remove the resolved comments: ${err.message}`),
  );
  if (!result) return;
  const removed = result.removed;
  // A review action, like every mutation the panel applies — the user expects
  // it to persist immediately, not sit in an unsaved buffer they have to
  // remember to Cmd+S.
  await saveOrWarn(doc, log, "Removed resolved comments");
  log.info("removed resolved comments", { file: doc.uri.fsPath, count: removed.length });
  void vscode.window.showInformationMessage(
    `Removed ${removed.length} resolved comment${removed.length === 1 ? "" : "s"}. Undo with Cmd+Z.`,
  );
}

/**
 * Apply a comment op through the document's write queue, on the file as it is
 * when the write's turn comes — after the command's dialog, and after any
 * agent call or live-editor edit already in flight. Computing it from the
 * text read before the dialog and writing that over the file would erase
 * whatever landed while the dialog was open.
 *
 * A refusal (`DocOpError`) goes to `refused`; a document that kept changing,
 * or a failed edit, is reported here. Resolves to the op's result, or
 * undefined when nothing was written.
 */
async function applyOp<T>(
  doc: vscode.TextDocument,
  op: (source: string) => { next: string; result: T },
  log: Logger,
  what: string,
  refused: (err: DocOpError) => void,
): Promise<T | undefined> {
  try {
    const result = await mutateDocument(doc.uri, (source) => op(source));
    return result ?? undefined;
  } catch (e) {
    if (e instanceof DocOpError) {
      log.warn(`${what} refused`, { code: e.code, message: e.message });
      refused(e);
    } else if (e instanceof ConflictError) {
      log.warn(`${what}: the document kept changing`);
      void vscode.window.showErrorMessage("The file kept changing, so the change wasn't made. Try again.");
    } else {
      log.error(`${what} failed`, e);
      void vscode.window.showErrorMessage(`Could not write the change into the document: ${(e as Error).message}`);
    }
    return undefined;
  }
}

/** Save `doc` after a successful applyEdit, warning (not throwing) on failure. */
async function saveOrWarn(doc: vscode.TextDocument, log: Logger, action: string): Promise<void> {
  try {
    const saved = await doc.save();
    if (!saved) {
      void vscode.window.showWarningMessage(`${action}, but the file could not be saved.`);
    }
  } catch (e) {
    log.warn(`${action}: save failed`, e);
    void vscode.window.showWarningMessage(`${action}, but save failed: ${(e as Error).message}`);
  }
}

/**
 * The confirm is a modal that names exactly what goes, because unlike
 * remove-resolved this deletes open conversations too — the entire review
 * history leaves the file in one keystroke. A pending suggestion is discarded
 * with its original text kept (a rejection, not a silent apply), and the
 * modal says so when there are any. One undo step.
 */
async function invokeFinalizeDocument(arg: vscode.Uri | undefined, log: Logger): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : activeMarkdownUri();
  if (!uri) {
    void vscode.window.showWarningMessage("Open a Markdown file first, then run this command.");
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    log.error(`could not open ${uri.fsPath}`, e);
    void vscode.window.showErrorMessage(`Could not open ${path.basename(uri.fsPath)}.`);
    return;
  }

  const source = doc.getText();
  let counts: { removedOpen: number; removedResolved: number; discardedSuggestions: number };
  try {
    // Only to describe what will go; the write recomputes it after the dialog.
    counts = opFinalize(source).result;
  } catch (e) {
    const err = e as DocOpError;
    if (err.code === "nothing_to_do") {
      void vscode.window.showInformationMessage("No review data in this file — it's already clean markdown.");
    } else {
      log.warn("finalize refused", { code: err.code, message: err.message });
      void vscode.window.showWarningMessage(`Could not finalize the document: ${err.message}`);
    }
    return;
  }

  const removedTotal = counts.removedOpen + counts.removedResolved;
  const pieces: string[] = [];
  if (removedTotal > 0) {
    const breakdown =
      counts.removedOpen > 0 && counts.removedResolved > 0
        ? ` (${counts.removedOpen} open, ${counts.removedResolved} resolved)`
        : counts.removedOpen > 0
          ? " (all open)"
          : " (all resolved)";
    pieces.push(`${removedTotal} comment thread${removedTotal === 1 ? "" : "s"}${breakdown} will be deleted`);
  }
  if (counts.discardedSuggestions > 0) {
    pieces.push(
      `${counts.discardedSuggestions} pending suggestion${counts.discardedSuggestions === 1 ? "" : "s"} will be discarded — the original text is kept, the proposed edit is not applied`,
    );
  }
  if (pieces.length === 0) pieces.push("Leftover review markers will be removed");
  const choice = await vscode.window.showWarningMessage(
    `Remove all review data from ${path.basename(uri.fsPath)}?`,
    {
      modal: true,
      detail: `${pieces.join(". ")}. The review history is gone from the file, leaving clean markdown ready to commit. This is a single undo step.`,
    },
    "Remove all",
  );
  if (choice !== "Remove all") return;

  // The dialog described the file as it was; finalize the file as it is now.
  const done = await applyOp(doc, opFinalize, log, "finalize", (err) =>
    err.code === "nothing_to_do"
      ? void vscode.window.showInformationMessage("No review data left in this file — it's already clean markdown.")
      : void vscode.window.showWarningMessage(`Could not finalize the document: ${err.message}`),
  );
  if (!done) return;
  await saveOrWarn(doc, log, "Finalized the document");
  log.info("finalized document", { file: doc.uri.fsPath, ...done });
  void vscode.window.showInformationMessage(
    `Removed all review data from ${path.basename(uri.fsPath)}. Undo with Cmd+Z.`,
  );
}

/**
 * The write goes through the shared `opOpenAt` verb and a `WorkspaceEdit`, so
 * it is integrity-checked before it lands and undoable once it has.
 */
async function invokeCommentOnSelection(log: Logger): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") {
    void vscode.window.showWarningMessage(
      "Open a Markdown file and select the passage you want to comment on.",
    );
    return;
  }
  const doc = editor.document;
  const selection = editor.selection;
  if (selection.isEmpty) {
    void vscode.window.showWarningMessage("Select some text first — a comment needs a passage to anchor to.");
    return;
  }

  const start = doc.offsetAt(selection.start);
  const end = doc.offsetAt(selection.end);
  const quote = doc.getText(selection);

  const body = await vscode.window.showInputBox({
    prompt: `Comment on “${quote.length > 60 ? `${quote.slice(0, 59)}…` : quote}”`,
    placeHolder: "What should your agent know about this passage?",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A comment needs a body." : null),
  });
  if (body === undefined) return;

  const author = currentAuthorName();

  // The offsets are from before the input box. If text above the selection
  // moved meanwhile, they'd anchor the comment to whatever now sits there, so
  // the quote is checked in the write's turn and relocated when it's unique.
  const opened = await applyOp(
    doc,
    (source) => {
      const at = source.slice(start, end) === quote ? start : uniqueIndexOf(source, quote);
      return opOpenAt(source, at, at + quote.length, body.trim(), author);
    },
    log,
    "comment on selection",
    (err) =>
      void vscode.window.showWarningMessage(
        err.code === "not_anchorable"
          ? `That selection can't hold a comment: ${err.message}`
          : `Could not add the comment: ${err.message}`,
      ),
  );
  if (!opened) return;
  const threadId = opened.threadId;
  // Same reasoning as the panel's own mutations (inlineCommentsPanel.ts): the
  // .md file is the source of truth, and a comment sitting in an unsaved
  // buffer is invisible to an agent reading it from disk.
  await saveOrWarn(doc, log, "Comment added");
  log.info("thread opened from the editor selection", { file: doc.uri.fsPath, threadId });

  vscode.window.setStatusBarMessage("Comment added — Cmd+K Cmd+Alt+V opens it in Markdown Collab", 4000);
}

/**
 * Only ever touches markers and the threads region — `repairIntegrity`
 * abandons the whole batch if a repair would alter prose — and the edit goes
 * through a WorkspaceEdit so it lands in the undo stack like any other change.
 */
async function invokeRepairInlineComments(
  log: Logger,
  fsPathArg?: string,
): Promise<void> {
  const fsPath = fsPathArg ?? activeMarkdownUri()?.fsPath;
  if (!fsPath) {
    void vscode.window.showWarningMessage("Open a markdown file to repair its comment anchors.");
    return;
  }
  const uri = vscode.Uri.file(fsPath);
  let found: ReturnType<typeof repairIntegrity> | undefined;
  let result: ReturnType<typeof repairIntegrity> | null;
  try {
    result = await mutateDocument(uri, (source) => {
      found = repairIntegrity(source);
      return found.repairs.length === 0 ? null : { next: found.source, result: found };
    });
  } catch (e) {
    void vscode.window.showErrorMessage(
      e instanceof ConflictError
        ? "The file kept changing, so the comment-anchor repair wasn't applied. Try again."
        : `Could not apply the comment-anchor repair: ${(e as Error).message}`,
    );
    return;
  }
  if (!result) {
    const remaining = found?.remaining.length ?? 0;
    void vscode.window.showInformationMessage(
      remaining === 0
        ? "No comment-anchor problems found."
        : `Nothing could be repaired automatically; ${remaining} problem(s) need a manual fix.`,
    );
    return;
  }
  for (const r of result.repairs) log.info("repaired anchor", { file: path.basename(fsPath), repair: r.description });
  const remaining = result.remaining.length;
  void vscode.window.showInformationMessage(
    remaining === 0
      ? `Repaired ${result.repairs.length} comment-anchor problem(s).`
      : `Repaired ${result.repairs.length}; ${remaining} still need a manual fix.`,
  );
}

/**
 * Validate a `fileArg` the way every command a hover's `command:` link can
 * reach must: a `file:` URI naming a `.md`/`.markdown` file inside an
 * open workspace folder, or null when it's anything else. The hover's own
 * markdown is escaped so the extension's own links are the only ones
 * that can ever fire, but `resolveThread`/`replyToThread`/`revealThread` are
 * ordinary VS Code commands — anything on the machine can invoke them with
 * any argument — so the handlers refuse on their own rather than trust the
 * caller.
 *
 * `fileURLToPath` decodes the URI directly instead of going through
 * `vscode.Uri.parse`: it throws on anything that isn't a `file:` URL, which
 * is exactly the first refusal this needs, and its result doesn't vary
 * across hosts the way a Uri implementation's `.fsPath` can.
 */
export function safeHoverTargetUri(fileArg: string | vscode.Uri | undefined): vscode.Uri | null {
  if (!fileArg) return null;
  let fsPath: string;
  if (typeof fileArg === "string") {
    try {
      fsPath = fileURLToPath(fileArg);
    } catch {
      return null;
    }
  } else {
    if (fileArg.scheme !== "file") return null;
    fsPath = fileArg.fsPath;
  }
  const ext = path.extname(fsPath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") return null;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.some((f) => isInsideRoot(fsPath, f.uri.fsPath))) return null;
  return vscode.Uri.file(fsPath);
}

const NOT_A_SAFE_TARGET =
  "Markdown Collab: that link doesn't point at a Markdown file in this workspace.";

/**
 * Resolve a thread from outside the review view (the source editor's hover link).
 * Internal: not in package.json, invoked as
 * `(fileArg, threadId)` from a `command:` URI.
 *
 * A toggle: an open thread is resolved, a resolved one reopened — the hover
 * shows whichever label applies, and the same command serves both.
 */
async function invokeResolveThread(
  fileArg: string | vscode.Uri | undefined,
  threadId: string | undefined,
  log: Logger,
): Promise<void> {
  if (!fileArg || !threadId) return;
  const uri = safeHoverTargetUri(fileArg);
  if (!uri) {
    void vscode.window.showWarningMessage(NOT_A_SAFE_TARGET);
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    log.error(`could not open ${uri.fsPath}`, e);
    void vscode.window.showErrorMessage(`Could not open ${path.basename(uri.fsPath)}.`);
    return;
  }

  // The resolver's name is the human's, same as the review view records —
  // `opResolve` defaults to "claude" because the agent tools are its usual
  // caller.
  const author = currentAuthorName();

  // Which way the toggle goes is read in the write's turn, so a thread an
  // agent resolved a moment ago is reopened, not resolved twice.
  let reopening = false;
  const toggled = await applyOp(
    doc,
    (source) => {
      const thread = parseInline(source).threads.find((t) => t.id === threadId);
      if (!thread) throw new DocOpError("thread_not_found", "that thread no longer exists in this file");
      reopening = thread.status === "resolved";
      return reopening ? opReopen(source, threadId) : opResolve(source, threadId, () => new Date().toISOString(), author);
    },
    log,
    "resolve/reopen thread",
    (err) =>
      void vscode.window.showWarningMessage(
        err.code === "thread_not_found" ? "That thread no longer exists in this file." : `Could not update the thread: ${err.message}`,
      ),
  );
  if (!toggled) return;
  await saveOrWarn(doc, log, reopening ? "Reopened the thread" : "Resolved the thread");
}

/**
 * Reply to a thread from outside the review view — the source editor's
 * hover link. Internal: not in package.json, invoked as
 * `(fileArg, threadId)` from a `command:` URI.
 */
async function invokeReplyToThread(
  fileArg: string | vscode.Uri | undefined,
  threadId: string | undefined,
  log: Logger,
): Promise<void> {
  if (!fileArg || !threadId) return;
  const uri = safeHoverTargetUri(fileArg);
  if (!uri) {
    void vscode.window.showWarningMessage(NOT_A_SAFE_TARGET);
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    log.error(`could not open ${uri.fsPath}`, e);
    void vscode.window.showErrorMessage(`Could not open ${path.basename(uri.fsPath)}.`);
    return;
  }

  const source = doc.getText();
  const thread = parseInline(source).threads.find((t) => t.id === threadId);
  if (!thread) {
    void vscode.window.showWarningMessage("That thread no longer exists in this file.");
    return;
  }
  const quote = thread.quote;
  const body = await vscode.window.showInputBox({
    prompt: `Reply to "${quote.length > 60 ? `${quote.slice(0, 59)}…` : quote}"`,
    placeHolder: "Your reply",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? "A reply needs a body." : null),
  });
  if (body === undefined) return;

  const author = currentAuthorName();

  // `agent: false` — this is the human replying from the hover, not an
  // agent through mc_reply/mdc reply, so it neither stamps the comment as
  // an agent's nor reopens a resolved thread the way an agent's reply does
  // (`opReply`'s own doc comment). Appended to the thread as it is after the
  // input box, so a reply an agent added meanwhile is kept.
  const replied = await applyOp(
    doc,
    (current) => opReply(current, threadId, body.trim(), () => new Date().toISOString(), author, false),
    log,
    "reply to thread",
    (err) => void vscode.window.showWarningMessage(`Could not add the reply: ${err.message}`),
  );
  if (!replied) return;
  await saveOrWarn(doc, log, "Reply added");
}

/** The one place `quote` occurs in `source`; a refusal when it's gone or appears more than once. */
function uniqueIndexOf(source: string, quote: string): number {
  const first = source.indexOf(quote);
  if (first < 0) {
    throw new DocOpError("passage_not_found", "the selected text changed while you were writing the comment");
  }
  if (source.indexOf(quote, first + 1) >= 0) {
    throw new DocOpError(
      "passage_ambiguous",
      "the text around your selection changed while you were writing the comment, and the passage now appears more than once — select it again",
    );
  }
  return first;
}

export function registerCommentsCommands(deps: CommandDeps): void {
  const { context, log, reviewLog, formatLog, openReviewView } = deps;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "markdownCollab.removeResolvedComments",
      async (arg?: vscode.Uri) => {
        await invokeRemoveResolvedComments(arg, reviewLog);
      },
    ),
    vscode.commands.registerCommand(
      "markdownCollab.finalizeDocument",
      async (arg?: vscode.Uri) => {
        await invokeFinalizeDocument(arg, reviewLog);
      },
    ),
    vscode.commands.registerCommand("markdownCollab.commentOnSelection", async () => {
      await invokeCommentOnSelection(reviewLog);
    }),
    // Invoked from the source editor's hover. Internal: not in the palette.
    vscode.commands.registerCommand(
      "markdownCollab.resolveThread",
      async (fileArg?: string | vscode.Uri, threadId?: string) => {
        await invokeResolveThread(fileArg, threadId, reviewLog);
      },
    ),
    vscode.commands.registerCommand(
      "markdownCollab.replyToThread",
      async (fileArg?: string | vscode.Uri, threadId?: string) => {
        await invokeReplyToThread(fileArg, threadId, reviewLog);
      },
    ),
    vscode.commands.registerCommand(
      "markdownCollab.repairInlineComments",
      async (fsPathArg?: string) => {
        await invokeRepairInlineComments(formatLog, fsPathArg);
      },
    ),
    vscode.commands.registerCommand(
      "markdownCollab.revealComment",
      async (node: ReviewNode | undefined) => {
        if (!node || node.kind !== "comment") return;
        try {
          // Into the review view, scrolled to the thread.
          await openReviewView(vscode.Uri.file(node.docPath), { revealThreadId: node.thread.id });
        } catch (e) {
          log.error(`revealComment failed for ${node.docPath}`, e);
        }
      },
    ),
  );

  // The review view. `openCollabEditor` stays, hidden from the
  // palette, as an alias for anything that still calls it. A caller can pass
  // `ReviewViewOpts` as the second argument; a menu's own second argument
  // (the editor group, the explorer selection) is ignored.
  const openReviewViewCommand = async (arg?: vscode.Uri, opts?: unknown): Promise<void> => {
    const uri = arg instanceof vscode.Uri ? arg : activeMarkdownUri();
    if (!uri) {
      void vscode.window.showWarningMessage(
        "Open a Markdown file first, then run this command.",
      );
      return;
    }
    await openReviewView(uri, reviewViewOptsFrom(opts));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("markdownCollab.openCollabEditor", openReviewViewCommand),
    vscode.commands.registerCommand("markdownCollab.openInlineCommentsView", openReviewViewCommand),
    // Invoked from the source editor's hover. Internal: not in the palette.
    vscode.commands.registerCommand(
      "markdownCollab.revealThread",
      async (uriArg?: string | vscode.Uri, threadId?: string) => {
        if (!uriArg || !threadId) return;
        const uri = safeHoverTargetUri(uriArg);
        if (!uri) {
          void vscode.window.showWarningMessage(NOT_A_SAFE_TARGET);
          return;
        }
        try {
          await openReviewView(uri, { revealThreadId: threadId });
        } catch (e) {
          reviewLog.error(`revealThread failed for ${uri.fsPath}`, e);
        }
      },
    ),
  );
}
