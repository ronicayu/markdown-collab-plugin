import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { isAnchorTextValid, resolve as resolveAnchor } from "./anchor";
import {
  addComment,
  addReply,
  deleteComment,
  loadSidecar,
  saveSidecar,
  setResolved,
  sidecarPathFor,
} from "./sidecar";
import type { Anchor, Comment } from "./types";

// -----------------------------------------------------------------------------
// Pure helper: extractAnchor
// -----------------------------------------------------------------------------

/**
 * Build an `Anchor` from a document's text and a selection range.
 *
 * `contextBefore` captures up to `contextWindow` chars immediately preceding
 * the selection; `contextAfter` captures up to `contextWindow` chars
 * immediately following. Truncation at a file boundary yields an empty or
 * short context — callers must not treat context length as significant.
 */
export function extractAnchor(
  fullText: string,
  selStart: number,
  selEnd: number,
  contextWindow = 40,
): { anchor: Anchor; valid: boolean } {
  const start = Math.max(0, Math.min(selStart, fullText.length));
  const end = Math.max(start, Math.min(selEnd, fullText.length));
  const text = fullText.slice(start, end);
  const contextBefore = fullText.slice(Math.max(0, start - contextWindow), start);
  const contextAfter = fullText.slice(end, end + contextWindow);
  const anchor: Anchor = { text, contextBefore, contextAfter };
  return { anchor, valid: isAnchorTextValid(text) };
}

// -----------------------------------------------------------------------------
// Pure helper: serializeByKey
// -----------------------------------------------------------------------------

/**
 * Serialize asynchronous work by key. All callers with the same `key` run in
 * submission order; the map entry is cleaned up when the chain settles, with
 * an identity check so a later chain isn't clobbered by an earlier cleanup.
 *
 * This is extracted for testability: the `reload()` path in the controller
 * mirrors this exact pattern to prevent interleaved dispose/attach when
 * multiple focus-change events fire rapidly for the same URI.
 */
export function serializeByKey<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const tail = prev.catch(() => undefined).then(work);
  const entry: Promise<unknown> = tail.catch(() => undefined);
  queues.set(key, entry);
  entry.then(() => {
    if (queues.get(key) === entry) queues.delete(key);
  });
  return tail;
}

// -----------------------------------------------------------------------------
// Pure helper: findCommentIdForThread
// -----------------------------------------------------------------------------

/**
 * Look up the comment id associated with a given `CommentThread`, first by
 * object identity and then by range equality. The range fallback exists
 * because a concurrent `reload()` may dispose+rebuild the thread objects
 * between when VS Code captures the click target and when our handler runs;
 * identity fails but the range still points at the same comment.
 *
 * Returns `undefined` if neither match hits. Exported for unit testing.
 */
export function findCommentIdForThread<TThread extends { range?: { isEqual(o: any): boolean } }>(
  entries: Iterable<{ thread: TThread; commentId: string }>,
  target: TThread,
): string | undefined {
  const list = Array.from(entries);
  for (const entry of list) {
    if (entry.thread === target) return entry.commentId;
  }
  const targetRange = target.range;
  if (!targetRange) return undefined;
  for (const entry of list) {
    const r = entry.thread.range;
    if (r && r.isEqual(targetRange)) return entry.commentId;
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// VS Code adapter
// -----------------------------------------------------------------------------

// The `vscode.CommentReply` type is what VS Code hands back from the commenting
// editor; it is only available at runtime inside the host. We capture only the
// fields we need for our own dispatch.
interface ReplyLike {
  thread: vscode.CommentThread;
  text: string;
}

// Our own comment wrapper around a stored Comment + Reply — VS Code's
// `vscode.Comment` is an interface so we implement it directly.
class StoredThreadComment implements vscode.Comment {
  public contextValue?: string;
  constructor(
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public readonly commentId: string,
    public readonly isRoot: boolean,
    public timestamp?: Date,
  ) {}
}

interface ThreadEntry {
  thread: vscode.CommentThread;
  commentId: string;
}

export class MarkdownCollabController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly output: vscode.OutputChannel;

  /** Map<docUri.fsPath, Map<commentId, ThreadEntry>> */
  private readonly threads = new Map<string, Map<string, ThreadEntry>>();
  /** Map<docUri.fsPath, orphaned comments (deep-copied so later reloads don't mutate)> */
  private readonly orphans = new Map<string, Comment[]>();
  /** Track sidecar mtime per doc to decide whether to reload on focus change. */
  private readonly mtimes = new Map<string, number>();
  /** Track read-only-unknown-version docs so we disable new actions. */
  private readonly readOnlyDocs = new Set<string>();

  private readonly orphanChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeOrphans = this.orphanChangeEmitter.event;

  /**
   * Fires with the md doc's fsPath whenever the sidecar watcher sees an
   * external change for a file that isn't currently open. F3 (sidecar tree)
   * will subscribe to invalidate its cached summary row. Until then this is
   * effectively a no-op signal.
   */
  private readonly externalChangeEmitter = new vscode.EventEmitter<string>();
  public readonly onDidExternalSidecarChange = this.externalChangeEmitter.event;

  /**
   * Per-URI in-flight reload guard. Mirrors the per-path queue in sidecar.ts:
   * concurrent `reload(doc)` calls for the same URI must serialize to prevent
   * interleaved disposal/attachment which would leak thread objects or double
   * them on screen. The entry is removed when the chain settles (identity-
   * checked so a newer chain isn't clobbered).
   */
  private readonly reloading = new Map<string, Promise<unknown>>();

  /**
   * Comment ids that are currently mid-write (reply or initial create). A
   * reload that lands while an id is in this set must NOT dispose the live
   * thread object for that comment — doing so races the reply UI and the
   * native comment editor would reattach to a stale handle. Instead the
   * reload patches the existing thread in place.
   */
  private readonly activeEdits = new Set<string>();

  private readonly disposables: vscode.Disposable[] = [];

  constructor(output: vscode.OutputChannel) {
    this.output = output;
    this.controller = vscode.comments.createCommentController(
      "markdown-collab",
      "Markdown Collab",
    );
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        if (document.languageId !== "markdown") return [];
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) return [];
        // readOnlyDocs is populated async by reload(); on first load there is
        // a brief window where `+` may appear before readonly is detected.
        if (this.readOnlyDocs.has(document.uri.fsPath)) return [];
        return [
          new vscode.Range(0, 0, document.lineCount, 0),
        ];
      },
    };
    this.disposables.push(
      this.controller,
      this.orphanChangeEmitter,
      this.externalChangeEmitter,
    );
  }

  /**
   * Public passthrough for the live sidecar watcher. `reload` itself stays
   * private because the full attach/reload machinery is an internal concern;
   * the watcher just needs a one-shot "please re-resolve for this doc".
   */
  public reloadDoc(doc: vscode.TextDocument): Promise<void> {
    return this.reload(doc);
  }

  /**
   * True if a reload is currently queued or in-flight for the given md doc
   * fsPath. Consumed by the sidecar watcher to avoid stacking a redundant
   * reload behind an in-progress one (which typically means the user just
   * clicked reply / resolve and we're echoing our own write).
   */
  public isReloading(uriFsPath: string): boolean {
    return this.reloading.has(uriFsPath);
  }

  /**
   * Notify subscribers that a sidecar changed on disk for a doc that isn't
   * currently open in the editor. F3 will subscribe here to invalidate its
   * tree. Safe to call with an unknown path — the emitter is a fanout.
   */
  public onExternalChange(uriFsPath: string): void {
    this.externalChangeEmitter.fire(uriFsPath);
  }

  /** Wire workspace listeners and register the thread-edit commands. */
  public activate(subs: vscode.Disposable[]): void {
    // Register commands the plugin uses to drive reply / resolve from the
    // native comment menu. These are also listed in package.json contributes.
    subs.push(
      vscode.commands.registerCommand(
        "markdownCollab.createThread",
        (reply: ReplyLike) => this.handleCreateThread(reply),
      ),
      vscode.commands.registerCommand(
        "markdownCollab.addReply",
        (reply: ReplyLike) => this.handleReply(reply),
      ),
      vscode.commands.registerCommand(
        "markdownCollab.toggleResolve",
        (thread: vscode.CommentThread) => this.handleToggleResolve(thread),
      ),
      vscode.commands.registerCommand(
        "markdownCollab.deleteThread",
        (thread: vscode.CommentThread) => this.handleDeleteThread(thread),
      ),
    );

    subs.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.languageId === "markdown") {
          void this.loadAndAttach(doc);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const doc = editor.document;
        if (doc.languageId !== "markdown") return;
        void this.maybeReloadOnFocus(doc);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.disposeThreadsFor(doc.uri);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        // On save, re-resolve anchors against the now-canonical buffer — any
        // previous reload may have matched against the pre-save disk content.
        if (doc.languageId !== "markdown") return;
        void this.reload(doc);
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        void this.handleRenames(event);
      }),
      this,
    );
  }

  public async reloadActive(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (doc.languageId !== "markdown") return;
    await this.reload(doc);
  }

  /**
   * Handle docs already open when the extension activates — `onDidOpenTextDocument`
   * only fires for docs opened *after* registration, so the caller must feed
   * the existing set in manually.
   */
  public async handleInitialDocs(
    docs: readonly vscode.TextDocument[],
  ): Promise<void> {
    await Promise.all(
      docs
        .filter((d) => d.languageId === "markdown")
        .map((d) => this.loadAndAttach(d)),
    );
  }

  public getOrphans(): ReadonlyMap<string, readonly Comment[]> {
    return this.orphans;
  }

  /**
   * Update a comment's anchor in place (used by the re-attach flow). Returns
   * true when the update succeeded, false when the sidecar could not be loaded
   * or the comment id was not found.
   */
  public async updateCommentAnchor(
    doc: vscode.TextDocument,
    commentId: string,
    newAnchor: Anchor,
  ): Promise<boolean> {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return false;
    const sidecarPath = sidecarPathFor(doc.uri.fsPath, folder.uri.fsPath);
    if (!sidecarPath) return false;
    const loaded = await loadSidecar(sidecarPath, (msg) => this.output.appendLine(msg));
    if (!loaded) return false;
    if (loaded.mode === "read-only-unknown-version") {
      void vscode.window.showWarningMessage(
        "Sidecar is read-only (unknown schema version); cannot re-attach.",
      );
      return false;
    }
    const comment = loaded.sidecar.comments.find((c) => c.id === commentId);
    if (!comment) return false;
    comment.anchor = newAnchor;
    await saveSidecar(sidecarPath, loaded.sidecar);
    await this.reload(doc);
    return true;
  }

  public dispose(): void {
    for (const [, map] of this.threads) {
      for (const { thread } of map.values()) {
        thread.dispose();
      }
    }
    this.threads.clear();
    this.orphans.clear();
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* swallow */
      }
    }
  }

  // -----------------------------------------------------------
  // Internal: load / reload / attach
  // -----------------------------------------------------------

  private async loadAndAttach(doc: vscode.TextDocument): Promise<void> {
    await this.reload(doc);
  }

  private async maybeReloadOnFocus(doc: vscode.TextDocument): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const sidecarPath = sidecarPathFor(doc.uri.fsPath, folder.uri.fsPath);
    if (!sidecarPath) return;
    let currentMtime = 0;
    try {
      const stat = await fs.stat(sidecarPath);
      currentMtime = stat.mtimeMs;
    } catch {
      currentMtime = 0;
    }
    const lastMtime = this.mtimes.get(doc.uri.fsPath) ?? -1;
    if (currentMtime !== lastMtime) {
      await this.reload(doc);
    }
  }

  private async reload(doc: vscode.TextDocument): Promise<void> {
    // Serialize concurrent reload()s for the same URI. Without this, two
    // rapid focus-change events can interleave disposeThreadsFor()s and
    // createCommentThread()s, leaking thread objects and double-rendering.
    return serializeByKey(this.reloading, doc.uri.fsPath, () =>
      this.reloadInner(doc),
    );
  }

  private async reloadInner(doc: vscode.TextDocument): Promise<void> {
    // Protect threads currently being edited from the dispose-then-rebuild
    // cycle: if a watcher-triggered reload lands while the user is typing a
    // reply, we MUST keep the thread object alive (VS Code's reply editor
    // holds a reference to it). Capture the keep set now and reuse it for
    // both the dispose step and the rebuild step below.
    const keep = new Set(this.activeEdits);
    const existing = this.threads.get(doc.uri.fsPath) ?? new Map<string, ThreadEntry>();
    this.disposeThreadsFor(doc.uri, keep);
    this.orphans.delete(doc.uri.fsPath);
    this.readOnlyDocs.delete(doc.uri.fsPath);

    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) {
      this.orphanChangeEmitter.fire();
      return;
    }
    const sidecarPath = sidecarPathFor(doc.uri.fsPath, folder.uri.fsPath);
    if (!sidecarPath) {
      this.orphanChangeEmitter.fire();
      return;
    }

    const loaded = await loadSidecar(sidecarPath, (msg) => this.output.appendLine(msg));

    // Record mtime regardless of load outcome so focus-driven reload isn't
    // triggered every time for a missing sidecar.
    try {
      const stat = await fs.stat(sidecarPath);
      this.mtimes.set(doc.uri.fsPath, stat.mtimeMs);
    } catch {
      this.mtimes.set(doc.uri.fsPath, 0);
    }

    if (!loaded) {
      this.orphanChangeEmitter.fire();
      return;
    }

    if (loaded.mode === "read-only-unknown-version") {
      this.output.appendLine(
        `Sidecar for ${doc.uri.fsPath} has unknown version; rendering read-only.`,
      );
      this.readOnlyDocs.add(doc.uri.fsPath);
    }

    // When the buffer has unsaved edits, resolve anchors against the saved
    // disk content — the AI wrote anchors based on what was on disk, so
    // matching against dirty buffer text would silently orphan everything.
    // We still translate offsets through doc.positionAt (buffer-line-based);
    // in heavy-divergence cases threads appear slightly off. Acceptable for v1.
    let text: string;
    let resolvedAgainstDisk = false;
    if (!doc.isDirty) {
      text = doc.getText();
    } else {
      try {
        text = await fs.readFile(doc.uri.fsPath, "utf8");
        resolvedAgainstDisk = true;
      } catch (e) {
        this.output.appendLine(
          `Could not read saved content from disk for ${doc.uri.fsPath}; falling back to buffer text: ${(e as Error).message}`,
        );
        text = doc.getText();
      }
    }
    const docOrphans: Comment[] = [];
    const threadMap = new Map<string, ThreadEntry>();

    for (const comment of loaded.sidecar.comments) {
      const range = resolveAnchor(text, comment.anchor);
      if (range === null) {
        // Normally we'd demote to orphan; but if this comment is mid-edit and
        // we kept a thread alive for it, keep rendering the existing thread
        // rather than flashing it into orphan state mid-reply.
        if (keep.has(comment.id) && existing.has(comment.id)) {
          const entry = existing.get(comment.id)!;
          this.patchThreadInPlace(entry.thread, comment);
          threadMap.set(comment.id, entry);
          continue;
        }
        docOrphans.push(comment);
        continue;
      }
      // Collapse the thread range to a single point at the anchor start.
      // VS Code renders a gutter icon on every visual wrap segment a thread
      // range covers, so long anchors on word-wrapped lines produce multiple
      // icons for one comment. A point range yields exactly one icon while
      // still correctly placing the thread on the anchor's starting line.
      const anchorStart = doc.positionAt(range.start);
      const vsRange = new vscode.Range(anchorStart, anchorStart);
      if (keep.has(comment.id) && existing.has(comment.id)) {
        // Reuse the live thread object, just update its surface fields. Also
        // nudge the range — VS Code's CommentThread.range is writable and
        // the anchor may have drifted on a concurrent external edit.
        const entry = existing.get(comment.id)!;
        try {
          entry.thread.range = vsRange;
        } catch {
          /* some thread shapes may reject range reassignment; ignore */
        }
        this.patchThreadInPlace(entry.thread, comment);
        threadMap.set(comment.id, entry);
      } else {
        const thread = this.createThreadForComment(doc.uri, vsRange, comment);
        threadMap.set(comment.id, { thread, commentId: comment.id });
      }
    }

    if (threadMap.size > 0) this.threads.set(doc.uri.fsPath, threadMap);
    else this.threads.delete(doc.uri.fsPath);
    if (docOrphans.length > 0) this.orphans.set(doc.uri.fsPath, docOrphans);
    if (resolvedAgainstDisk) {
      this.output.appendLine(
        `Resolved ${threadMap.size} anchor(s) against saved disk content (buffer has unsaved edits).`,
      );
    }
    this.orphanChangeEmitter.fire();
  }

  /**
   * Mutate an existing CommentThread to reflect the latest stored Comment
   * without disposing/recreating it. Used by `reloadInner` when a reload
   * arrives during an active edit.
   */
  private patchThreadInPlace(
    thread: vscode.CommentThread,
    comment: Comment,
  ): void {
    thread.comments = this.buildThreadComments(comment);
    thread.label = this.labelForComment(comment);
    thread.state = comment.resolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    // Don't touch collapsibleState mid-reply — collapsing the editor the user
    // is typing in would eat their input. Keep whatever the user sees.
  }

  private createThreadForComment(
    docUri: vscode.Uri,
    range: vscode.Range,
    comment: Comment,
  ): vscode.CommentThread {
    const thread = this.controller.createCommentThread(docUri, range, []);
    thread.comments = this.buildThreadComments(comment);
    thread.label = this.labelForComment(comment);
    thread.collapsibleState = comment.resolved
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    thread.state = comment.resolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    // contextValue lets command-when clauses key off whether the doc is read-only.
    const readOnly = this.readOnlyDocs.has(docUri.fsPath);
    thread.contextValue = readOnly ? "markdown-collab-readonly" : "markdown-collab";
    thread.canReply = !readOnly;
    return thread;
  }

  private buildThreadComments(comment: Comment): vscode.Comment[] {
    const out: StoredThreadComment[] = [];
    out.push(
      new StoredThreadComment(
        new vscode.MarkdownString(comment.body),
        vscode.CommentMode.Preview,
        { name: comment.author },
        comment.id,
        true,
        this.safeDate(comment.createdAt),
      ),
    );
    for (const reply of comment.replies) {
      out.push(
        new StoredThreadComment(
          new vscode.MarkdownString(reply.body),
          vscode.CommentMode.Preview,
          { name: reply.author },
          comment.id,
          false,
          this.safeDate(reply.createdAt),
        ),
      );
    }
    return out;
  }

  private labelForComment(comment: Comment): string {
    return comment.resolved ? "Resolved" : "Open";
  }

  private safeDate(iso: string): Date | undefined {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  private disposeThreadsFor(uri: vscode.Uri, keep?: ReadonlySet<string>): void {
    const map = this.threads.get(uri.fsPath);
    if (!map) return;
    if (!keep || keep.size === 0) {
      for (const { thread } of map.values()) {
        thread.dispose();
      }
      this.threads.delete(uri.fsPath);
      return;
    }
    // Dispose only threads NOT listed in `keep`; leave the kept entries in
    // the map so that reloadInner can patch them in place. reloadInner will
    // overwrite this.threads[uri.fsPath] with a fresh map that either reuses
    // or drops the kept entries as appropriate.
    const survivors = new Map<string, ThreadEntry>();
    for (const [id, entry] of map) {
      if (keep.has(id)) {
        survivors.set(id, entry);
      } else {
        entry.thread.dispose();
      }
    }
    if (survivors.size > 0) {
      this.threads.set(uri.fsPath, survivors);
    } else {
      this.threads.delete(uri.fsPath);
    }
  }

  // -----------------------------------------------------------
  // Internal: user interactions
  // -----------------------------------------------------------

  private async handleCreateThread(reply: ReplyLike): Promise<void> {
    const { thread, text: body } = reply;
    const doc = this.findDocForUri(thread.uri);
    if (!doc) {
      thread.dispose();
      return;
    }
    if (this.readOnlyDocs.has(doc.uri.fsPath)) {
      void vscode.window.showWarningMessage(
        "This sidecar is from a newer plugin version. Open it in a newer Markdown Collab to edit.",
      );
      thread.dispose();
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) {
      void vscode.window.showWarningMessage(
        "Comments unavailable — open a folder to enable Markdown Collab.",
      );
      thread.dispose();
      return;
    }
    const sidecarPath = sidecarPathFor(doc.uri.fsPath, folder.uri.fsPath);
    if (!sidecarPath) {
      thread.dispose();
      return;
    }
    const fullText = doc.getText();
    const range = thread.range;
    if (!range) {
      thread.dispose();
      return;
    }
    const selStart = doc.offsetAt(range.start);
    const selEnd = doc.offsetAt(range.end);
    const { anchor, valid } = extractAnchor(fullText, selStart, selEnd);
    if (!valid) {
      void vscode.window.showWarningMessage(
        "Comment anchor too short — select at least 8 non-whitespace characters.",
      );
      thread.dispose();
      return;
    }
    let registeredId: string | undefined;
    try {
      const mdRelPath = path.relative(folder.uri.fsPath, doc.uri.fsPath);
      const stored = await addComment(sidecarPath, mdRelPath, {
        anchor,
        body,
        author: "user",
        createdAt: new Date().toISOString(),
      });
      // Flag as active before touching UI so any watcher-triggered reload
      // between here and the map insert can't dispose a thread we're about
      // to register. Cleared in the finally below.
      registeredId = stored.id;
      this.activeEdits.add(stored.id);
      thread.comments = this.buildThreadComments(stored);
      thread.label = this.labelForComment(stored);
      thread.state = vscode.CommentThreadState.Unresolved;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.contextValue = "markdown-collab";
      thread.canReply = true;
      const map = this.threads.get(doc.uri.fsPath) ?? new Map<string, ThreadEntry>();
      map.set(stored.id, { thread, commentId: stored.id });
      this.threads.set(doc.uri.fsPath, map);
      await this.refreshMtime(sidecarPath, doc.uri.fsPath);
    } catch (e) {
      this.output.appendLine(`Failed to create comment: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `Markdown Collab: failed to create comment: ${(e as Error).message}`,
      );
      thread.dispose();
    } finally {
      if (registeredId !== undefined) this.activeEdits.delete(registeredId);
    }
  }

  private async handleReply(reply: ReplyLike): Promise<void> {
    const { thread, text: body } = reply;
    const doc = this.findDocForUri(thread.uri);
    if (!doc) return;
    if (this.readOnlyDocs.has(doc.uri.fsPath)) {
      void vscode.window.showWarningMessage(
        "This sidecar is from a newer plugin version. Open it in a newer Markdown Collab to edit.",
      );
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const sidecarPath = sidecarPathFor(doc.uri.fsPath, folder.uri.fsPath);
    if (!sidecarPath) return;
    const commentId = this.commentIdForThread(doc.uri, thread);
    if (!commentId) {
      this.output.appendLine(
        "Reply arrived on a thread without a tracked comment id; ignoring.",
      );
      return;
    }
    // Flag as active so a concurrent watcher-triggered reload preserves the
    // thread object rather than disposing it out from under VS Code's native
    // reply editor. Must bracket the entire handler body, including the
    // optimistic-UI paint and the refresh-from-disk check.
    this.activeEdits.add(commentId);
    try {
      const updated = await addReply(sidecarPath, commentId, {
        author: "user",
        body,
        createdAt: new Date().toISOString(),
      });
      // Optimistic UI: rebuild thread.comments from the mutated Comment we
      // just wrote. If the subsequent correctness-check refresh fails (e.g.,
      // transient read error), we keep the optimistic UI and log a warning
      // rather than dropping the reply silently.
      thread.comments = this.buildThreadComments(updated);
      thread.label = this.labelForComment(updated);
      try {
        await this.refreshThreadFromDisk(doc, thread, sidecarPath, commentId);
      } catch (refreshErr) {
        this.output.appendLine(
          `Reply UI refresh failed (keeping optimistic state): ${(refreshErr as Error).message}`,
        );
      }
      await this.refreshMtime(sidecarPath, doc.uri.fsPath);
    } catch (e) {
      this.output.appendLine(`Failed to add reply: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `Markdown Collab: failed to add reply: ${(e as Error).message}`,
      );
    } finally {
      this.activeEdits.delete(commentId);
    }
  }

  private async handleToggleResolve(thread: vscode.CommentThread): Promise<void> {
    const doc = this.findDocForUri(thread.uri);
    if (!doc) return;
    if (this.readOnlyDocs.has(doc.uri.fsPath)) {
      void vscode.window.showWarningMessage(
        "This sidecar is from a newer plugin version. Open it in a newer Markdown Collab to edit.",
      );
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const sidecarPath = sidecarPathFor(doc.uri.fsPath, folder.uri.fsPath);
    if (!sidecarPath) return;
    const commentId = this.commentIdForThread(doc.uri, thread);
    if (!commentId) return;
    const newState = thread.state !== vscode.CommentThreadState.Resolved;
    try {
      await setResolved(sidecarPath, commentId, newState);
      thread.state = newState
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      thread.label = newState ? "Resolved" : "Open";
      thread.collapsibleState = newState
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
      await this.refreshMtime(sidecarPath, doc.uri.fsPath);
    } catch (e) {
      this.output.appendLine(`Failed to toggle resolve: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `Markdown Collab: failed to toggle resolve: ${(e as Error).message}`,
      );
    }
  }

  private async handleDeleteThread(thread: vscode.CommentThread): Promise<void> {
    const doc = this.findDocForUri(thread.uri);
    if (!doc) return;
    if (this.readOnlyDocs.has(doc.uri.fsPath)) {
      void vscode.window.showWarningMessage(
        "This sidecar is from a newer plugin version. Open it in a newer Markdown Collab to edit.",
      );
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const sidecarPath = sidecarPathFor(doc.uri.fsPath, folder.uri.fsPath);
    if (!sidecarPath) return;
    const commentId = this.commentIdForThread(doc.uri, thread);
    if (!commentId) return;
    const confirm = await vscode.window.showWarningMessage(
      "Delete this comment thread? Replies will be removed too.",
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") return;
    try {
      const removed = await deleteComment(sidecarPath, commentId);
      if (!removed) {
        void vscode.window.showWarningMessage(
          "Comment was already gone.",
        );
      }
      thread.dispose();
      const map = this.threads.get(doc.uri.fsPath);
      if (map) {
        map.delete(commentId);
        if (map.size === 0) this.threads.delete(doc.uri.fsPath);
      }
      await this.refreshMtime(sidecarPath, doc.uri.fsPath);
    } catch (e) {
      this.output.appendLine(`Failed to delete comment: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `Markdown Collab: failed to delete comment: ${(e as Error).message}`,
      );
    }
  }

  private commentIdForThread(
    uri: vscode.Uri,
    thread: vscode.CommentThread,
  ): string | undefined {
    const map = this.threads.get(uri.fsPath);
    if (!map) return undefined;
    const id = findCommentIdForThread(map.values(), thread);
    if (id === undefined) {
      this.output.appendLine(
        `commentIdForThread: no match for thread at ${uri.fsPath} (identity + range both missed).`,
      );
    }
    return id;
  }

  private async refreshThreadFromDisk(
    _doc: vscode.TextDocument,
    thread: vscode.CommentThread,
    sidecarPath: string,
    commentId: string,
  ): Promise<void> {
    const loaded = await loadSidecar(sidecarPath, (msg) => this.output.appendLine(msg));
    if (!loaded) return;
    const comment = loaded.sidecar.comments.find((c) => c.id === commentId);
    if (!comment) return;
    thread.comments = this.buildThreadComments(comment);
    thread.state = comment.resolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    thread.label = this.labelForComment(comment);
  }

  private findDocForUri(uri: vscode.Uri): vscode.TextDocument | undefined {
    // Only look at docs already open — do NOT call openTextDocument here.
    // Reply/resolve/create paths fire from thread UI, which means the doc
    // is currently open; opening it implicitly would load unrelated files
    // into memory as a side-effect of a comment action.
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.toString() === uri.toString()) return d;
    }
    return undefined;
  }

  private async refreshMtime(sidecarPath: string, docPath: string): Promise<void> {
    try {
      const stat = await fs.stat(sidecarPath);
      this.mtimes.set(docPath, stat.mtimeMs);
    } catch {
      this.mtimes.set(docPath, 0);
    }
  }

  // -----------------------------------------------------------
  // Internal: rename handling
  // -----------------------------------------------------------

  private async handleRenames(event: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of event.files) {
      if (!oldUri.fsPath.toLowerCase().endsWith(".md")) continue;
      const oldFolder = vscode.workspace.getWorkspaceFolder(oldUri);
      const newFolder = vscode.workspace.getWorkspaceFolder(newUri);
      const oldSidecar = oldFolder
        ? sidecarPathFor(oldUri.fsPath, oldFolder.uri.fsPath)
        : null;
      const newSidecar = newFolder
        ? sidecarPathFor(newUri.fsPath, newFolder.uri.fsPath)
        : null;
      if (!oldSidecar || !newSidecar) continue;
      let renamed = false;
      try {
        await fs.mkdir(path.dirname(newSidecar), { recursive: true });
        await fs.rename(oldSidecar, newSidecar);
        renamed = true;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          // No sidecar existed for this .md — nothing to do.
        } else {
          this.output.appendLine(
            `Failed to move sidecar ${oldSidecar} → ${newSidecar}: ${err.message}`,
          );
          void vscode.window.showWarningMessage(
            `Markdown Collab: could not move sidecar for ${path.basename(
              oldUri.fsPath,
            )} — ${err.message}`,
          );
        }
      }
      // CommentThread.uri is readonly, so we must dispose+rebuild, not re-key.
      // Threads attached to the old URI would never render on the renamed doc.
      const oldKey = oldUri.fsPath;
      const newKey = newUri.fsPath;
      this.disposeThreadsFor(oldUri);
      this.orphans.delete(oldKey);
      this.mtimes.delete(oldKey);
      this.readOnlyDocs.delete(oldKey);
      this.orphanChangeEmitter.fire();

      if (renamed && oldFolder) {
        // Best-effort cleanup of empty ancestor directories under the
        // workspace's .markdown-collab root. Swallow ENOTEMPTY silently —
        // any still-populated dir is expected and not an error.
        await this.cleanupEmptyAncestors(
          path.dirname(oldSidecar),
          path.join(oldFolder.uri.fsPath, ".markdown-collab"),
        );
      }

      if (renamed) {
        // Rebuild threads at the new URI if the doc is currently open. If it
        // isn't, drop — threads will rebuild on next open via the normal flow.
        const newDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === newKey,
        );
        if (newDoc) {
          await this.loadAndAttach(newDoc);
        }
      }
    }
  }

  private async cleanupEmptyAncestors(
    startDir: string,
    stopAt: string,
  ): Promise<void> {
    const stopResolved = path.resolve(stopAt);
    let dir = path.resolve(startDir);
    // Walk up from the file's parent to (but not including) `stopAt`.
    // rmdir is best-effort: ENOTEMPTY / ENOENT / EBUSY etc. are all fine.
    while (dir !== stopResolved && dir.startsWith(stopResolved + path.sep)) {
      try {
        await fs.rmdir(dir);
      } catch {
        return; // First non-empty (or missing) directory halts the walk.
      }
      const parent = path.dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
  }
}

// Re-export a convenience type so orphanView can import without circular typing.
export type { Comment, Sidecar } from "./types";
