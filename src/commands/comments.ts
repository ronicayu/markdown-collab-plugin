// Comment mutations on a document: remove-resolved, finalize, comment-on-
// selection, repair, and the review-view entry points
// (10x-plan-4 P3.2 split of extension.ts).

import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
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
import type { CommandDeps } from "./deps";
import { reviewViewOptsFrom } from "./reviewViewRouter";

/**
 * Delete every resolved thread in a document.
 *
 * Resolved threads accumulate: they are settled, nobody reads them again, and
 * they crowd the ones still waiting on someone. Removing them one at a time
 * through the per-thread confirm is the tedium this exists to end.
 *
 * Confirmed with a modal that names the count, because it removes review
 * history from the file. It is one undo step, which the modal says.
 */
async function invokeRemoveResolvedComments(arg: vscode.Uri | undefined, log: Logger): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
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

  let next: string;
  let removed: string[];
  try {
    const outcome = opPurgeResolved(source);
    next = outcome.next;
    removed = outcome.result.removed;
  } catch (e) {
    const err = e as DocOpError;
    log.warn("remove resolved refused", { code: err.code, message: err.message });
    void vscode.window.showWarningMessage(`Could not remove the resolved comments: ${err.message}`);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(source.length)), next);
  if (!(await vscode.workspace.applyEdit(edit))) {
    log.error("remove resolved: applyEdit was rejected");
    void vscode.window.showErrorMessage("Could not write the change into the document.");
    return;
  }
  // A review action, like every mutation the panel applies — the user expects
  // it to persist immediately, not sit in an unsaved buffer they have to
  // remember to Cmd+S.
  await saveOrWarn(doc, log, "Removed resolved comments");
  log.info("removed resolved comments", { file: doc.uri.fsPath, count: removed.length });
  void vscode.window.showInformationMessage(
    `Removed ${removed.length} resolved comment${removed.length === 1 ? "" : "s"}. Undo with Cmd+Z.`,
  );
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
 * Finalize a document: strip every comment, marker, suggestion, and the
 * threads region, leaving clean markdown ready to commit (issue #1).
 *
 * The confirm is a modal that names exactly what goes, because unlike
 * remove-resolved this deletes open conversations too — the entire review
 * history leaves the file in one keystroke. A pending suggestion is discarded
 * with its original text kept (a rejection, not a silent apply), and the
 * modal says so when there are any. One undo step.
 */
async function invokeFinalizeDocument(arg: vscode.Uri | undefined, log: Logger): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
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
  let next: string;
  let counts: { removedOpen: number; removedResolved: number; discardedSuggestions: number };
  try {
    const outcome = opFinalize(source);
    next = outcome.next;
    counts = outcome.result;
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

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(source.length)), next);
  if (!(await vscode.workspace.applyEdit(edit))) {
    log.error("finalize: applyEdit was rejected");
    void vscode.window.showErrorMessage("Could not write the change into the document.");
    return;
  }
  await saveOrWarn(doc, log, "Finalized the document");
  log.info("finalized document", { file: doc.uri.fsPath, ...counts });
  void vscode.window.showInformationMessage(
    `Removed all review data from ${path.basename(uri.fsPath)}. Undo with Cmd+Z.`,
  );
}

/**
 * Comment on the text editor's selection, with no webview and no mouse
 * (10x-plan-3 P0.2).
 *
 * The format engine could always anchor to any source range; what was missing
 * was a path to it that didn't start with "open the rendered view and drag".
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
  if (body === undefined) return; // cancelled

  const author = vscode.workspace
    .getConfiguration("markdownCollab")
    .get<string>("collab.userName", "") || os.userInfo().username || "anonymous";

  let next: string;
  let threadId: string;
  try {
    const outcome = opOpenAt(doc.getText(), start, end, body.trim(), author);
    next = outcome.next;
    threadId = outcome.result.threadId;
  } catch (e) {
    const err = e as DocOpError;
    log.warn("comment on selection refused", { code: err.code, message: err.message });
    void vscode.window.showWarningMessage(
      err.code === "not_anchorable"
        ? `That selection can't hold a comment: ${err.message}`
        : `Could not add the comment: ${err.message}`,
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    next,
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    log.error("comment on selection: applyEdit was rejected");
    void vscode.window.showErrorMessage("Could not write the comment into the document.");
    return;
  }
  // Same reasoning as the panel's own mutations (inlineCommentsPanel.ts): the
  // .md file is the source of truth, and a comment sitting in an unsaved
  // buffer is invisible to an agent reading it from disk.
  await saveOrWarn(doc, log, "Comment added");
  log.info("thread opened from the editor selection", { file: doc.uri.fsPath, threadId });

  vscode.window.setStatusBarMessage("Comment added — Cmd+K Cmd+Alt+V opens it in Markdown Collab", 4000);
}

/**
 * Repair damaged comment anchors in a markdown file.
 *
 * Only ever touches markers and the threads region — `repairIntegrity`
 * abandons the whole batch if a repair would alter prose — and the edit goes
 * through a WorkspaceEdit so it lands in the undo stack like any other change.
 */
async function invokeRepairInlineComments(
  log: Logger,
  fsPathArg?: string,
): Promise<void> {
  const fsPath = fsPathArg ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!fsPath) {
    void vscode.window.showWarningMessage("Open a markdown file to repair its comment anchors.");
    return;
  }
  const uri = vscode.Uri.file(fsPath);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not open ${path.basename(fsPath)}: ${(e as Error).message}`);
    return;
  }

  const before = doc.getText();
  const result = repairIntegrity(before);
  if (result.repairs.length === 0) {
    const remaining = result.remaining.length;
    void vscode.window.showInformationMessage(
      remaining === 0
        ? "No comment-anchor problems found."
        : `Nothing could be repaired automatically; ${remaining} problem(s) need a manual fix.`,
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), result.source);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage("Could not apply the comment-anchor repair.");
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

/** Resolve a `fileArg` command argument the way `revealThread` already does — a URI or its string form, whichever the caller has on hand. */
function uriFromArg(fileArg: string | vscode.Uri): vscode.Uri {
  return fileArg instanceof vscode.Uri ? fileArg : vscode.Uri.parse(fileArg);
}

/**
 * Resolve a thread from outside the review view (3.7) — today, the source
 * editor's hover link; the same command works from a future keybinding or the
 * palette. Internal: not in package.json, invoked as
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
  const uri = uriFromArg(fileArg);
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
  const reopening = thread.status === "resolved";
  const verb = reopening ? "reopen" : "resolve";
  // The resolver's name is the human's, same as the review view records —
  // `opResolve` defaults to "claude" because the agent tools are its usual
  // caller.
  const author = vscode.workspace
    .getConfiguration("markdownCollab")
    .get<string>("collab.userName", "") || os.userInfo().username || "anonymous";

  let next: string;
  try {
    const outcome = reopening
      ? opReopen(source, threadId)
      : opResolve(source, threadId, () => new Date().toISOString(), author);
    next = outcome.next;
  } catch (e) {
    const err = e as DocOpError;
    log.warn(`${verb} thread refused`, { code: err.code, message: err.message });
    void vscode.window.showWarningMessage(`Could not ${verb} the thread: ${err.message}`);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(source.length)), next);
  if (!(await vscode.workspace.applyEdit(edit))) {
    log.error(`${verb} thread: applyEdit was rejected`);
    void vscode.window.showErrorMessage("Could not write the change into the document.");
    return;
  }
  await saveOrWarn(doc, log, reopening ? "Reopened the thread" : "Resolved the thread");
}

/**
 * Reply to a thread from outside the review view (3.7) — the source editor's
 * hover link. Internal: not in package.json, invoked as
 * `(fileArg, threadId)` from a `command:` URI.
 */
async function invokeReplyToThread(
  fileArg: string | vscode.Uri | undefined,
  threadId: string | undefined,
  log: Logger,
): Promise<void> {
  if (!fileArg || !threadId) return;
  const uri = uriFromArg(fileArg);
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
  if (body === undefined) return; // cancelled

  const author = vscode.workspace
    .getConfiguration("markdownCollab")
    .get<string>("collab.userName", "") || os.userInfo().username || "anonymous";

  let next: string;
  try {
    // `agent: false` — this is the human replying from the hover, not an
    // agent through mc_reply/mdc reply, so it neither stamps the comment as
    // an agent's nor reopens a resolved thread the way an agent's reply does
    // (ux-review-2026-09 0.6's rule, `opReply`'s own doc comment).
    const outcome = opReply(source, threadId, body.trim(), () => new Date().toISOString(), author, false);
    next = outcome.next;
  } catch (e) {
    const err = e as DocOpError;
    log.warn("reply to thread refused", { code: err.code, message: err.message });
    void vscode.window.showWarningMessage(`Could not add the reply: ${err.message}`);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(source.length)), next);
  if (!(await vscode.workspace.applyEdit(edit))) {
    log.error("reply to thread: applyEdit was rejected");
    void vscode.window.showErrorMessage("Could not write the reply into the document.");
    return;
  }
  await saveOrWarn(doc, log, "Reply added");
}

/** Register the comment-mutation and review-view-entry family of commands. */
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
    // Invoked from the source editor's hover (3.7). Internal: not in the palette.
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
          // Into the review view, scrolled to the thread. This used to open
          // the raw source and not even scroll ("opening the doc is enough"),
          // which left the reader looking at markers.
          await openReviewView(vscode.Uri.file(node.docPath), { revealThreadId: node.thread.id });
        } catch (e) {
          log.error(`revealComment failed for ${node.docPath}`, e);
        }
      },
    ),
  );

  // The review view. `openCollabEditor` was the live editor's own command
  // before the live editor became the review view; it stays, hidden from the
  // palette, as an alias for anything that still calls it. A caller can pass
  // `ReviewViewOpts` as the second argument; a menu's own second argument
  // (the editor group, the explorer selection) is ignored.
  const openReviewViewCommand = async (arg?: vscode.Uri, opts?: unknown): Promise<void> => {
    const uri =
      arg instanceof vscode.Uri
        ? arg
        : vscode.window.activeTextEditor?.document.uri;
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
        const uri = uriArg instanceof vscode.Uri ? uriArg : vscode.Uri.parse(uriArg);
        try {
          await openReviewView(uri, { revealThreadId: threadId });
        } catch (e) {
          reviewLog.error(`revealThread failed for ${uri.fsPath}`, e);
        }
      },
    ),
  );
}
