// Every write to a document, one at a time — across every writer in this
// extension host, not just within one view.
//
// The live editor, the MCP tools an agent calls, the inline comments panel and
// the comment commands all change the same TextDocument. Ordering them is half
// the fix; the other half is *where* each write is computed. A write computed
// from text read before an earlier write landed, then applied over the newer
// text, reverts that earlier write — the bug every unordered path here had
// (an MCP call reading, awaiting, then diffing its stale result against the
// fresh buffer). So a writer hands the queue a function from the document's
// text to the text it wants, and the queue runs that function on the text as
// it is when the write's turn comes.
//
// The one writer the queue can't see is the human typing in an ordinary text
// editor. VS Code refuses a `WorkspaceEdit` built against a document version
// that has since moved (`applyEdit` resolves false), so a refused edit is
// recomputed on the new text and tried again, a few times, before the write
// gives up with a `ConflictError` and changes nothing.

import * as vscode from "vscode";
import { minimalEdit } from "../inlineComments/minimalEdit";

/** The document kept changing under a write; nothing was written. */
export class ConflictError extends Error {
  readonly code = "conflict";
  constructor(message = "the document changed while this write was being applied; nothing was written") {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * From the document's current text to the text the writer wants, plus what to
 * tell the caller. Null when there is nothing to do. Throwing aborts the write
 * with the document untouched.
 */
export type DocMutation<T> = (source: string) => { next: string; result: T } | null;

export interface MutateOptions {
  /** Save once the edit lands (review state is meant to be on disk at once). */
  save?: boolean;
  /** Tries before a refused edit becomes a ConflictError. Default 3. */
  maxAttempts?: number;
}

const tails = new Map<string, Promise<void>>();

/**
 * One key per file however its URI was made: the live editor has the
 * document's own URI, a tool call one built from a resolved path, and on
 * Windows those can disagree on the drive letter's case — which would give
 * one file two queues.
 */
function keyOf(uri: vscode.Uri): string {
  if (uri.scheme !== "file") return uri.toString();
  return process.platform === "win32" ? `file:${uri.fsPath.toLowerCase()}` : `file:${uri.fsPath}`;
}

/**
 * Run `job` after every job already queued for `uri`, and before any queued
 * after it. A job that throws doesn't stop the ones behind it.
 *
 * A job must never wait on another job for the same document (that one is
 * queued behind it), and must never wait on the person — a dialog inside a
 * job would hold every writer of the file. Ask first, then queue the write.
 */
export function exclusive<T>(uri: vscode.Uri, job: () => Promise<T>): Promise<T> {
  const key = keyOf(uri);
  const run = (tails.get(key) ?? Promise.resolve()).then(job);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  // Forget a document once its queue drains, so closed files don't pile up.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/**
 * Change a document through the queue: read its text when this write's turn
 * comes, run `fn` on it, apply the smallest replacement as a `WorkspaceEdit`
 * (undoable, ordered against unsaved edits), and optionally save. A refused
 * edit is recomputed on the newer text, up to `maxAttempts` times.
 *
 * Resolves to `fn`'s result, or null when `fn` had nothing to do.
 */
export function mutateDocument<T>(uri: vscode.Uri, fn: DocMutation<T>, opts: MutateOptions = {}): Promise<T | null> {
  const attempts = opts.maxAttempts ?? 3;
  return exclusive(uri, async () => {
    for (let attempt = 1; ; attempt++) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const source = doc.getText();
      const out = fn(source);
      if (!out) return null;
      const change = minimalEdit(source, out.next);
      if (!change) return out.result;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end)), change.replacement);
      if (!(await vscode.workspace.applyEdit(edit))) {
        if (attempt < attempts) continue;
        throw new ConflictError();
      }
      if (opts.save) {
        // `save()` also answers false when there was nothing to save (a reload
        // landed the same bytes first), so the dirty flag, not the return
        // value, is what says the write didn't reach the disk.
        const saved = await doc.save();
        if (!saved && doc.isDirty) throw new Error("the edit applied but the file could not be saved");
      }
      return out.result;
    }
  });
}
