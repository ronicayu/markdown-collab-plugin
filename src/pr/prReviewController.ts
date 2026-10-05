import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import {
  addedLineRanges,
  currentBranch,
  defaultBranch,
  headSha as readHeadSha,
  lineInRanges,
  listChangedMarkdownFiles,
  originRemoteUrl,
  parseRemoteUrl,
  type ChangedFile,
  type LineRange,
} from "./diff";
import { detectPlatform } from "./platform";
import { PrReviewPanel } from "./prReviewPanel";
import { PrReviewTreeProvider } from "./prReviewTreeProvider";
import type { Logger } from "../logging";
import { requireTrust } from "../trust";
import type {
  ExistingPrComment,
  PrComment,
  PrContext,
  PrDraft,
  PrPlatform,
  ReviewVerdict,
} from "./types";

const CONTROLLER_ID = "markdown-collab-pr";
const CONTROLLER_LABEL = "Markdown Collab (PR review)";
const STATE_KEY_PREFIX = "markdownCollab.prDrafts.";
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface DraftEnvelope {
  key: string;
  ctxSummary: {
    platform: PrContext["platform"];
    prNumber: number;
    baseRef: string;
    headSha: string;
  };
  drafts: PrDraft[];
  updatedAt: string;
}

interface ActiveSession {
  ctx: PrContext;
  platform: PrPlatform;
  /** Branch the review was started on, so a checkout elsewhere restarts it. */
  branch: string;
  rangesByPath: Map<string, LineRange[]>;
  threadsByDraft: Map<string, vscode.CommentThread>;
  /** Existing PR comments fetched from the platform, populated lazily. null until first fetch resolves. */
  existingComments: ExistingPrComment[] | null;
  /** In-flight fetch promise; subsequent callers await this instead of double-fetching. */
  existingCommentsLoading: Promise<ExistingPrComment[]> | null;
  /**
   * Whether the "some existing comments couldn't be loaded" notice has fired this
   * session; shown once even if later fetches still have stale pages.
   */
  warnedPartialLoad: boolean;
}

/**
 * Hash of `(remoteUrl, baseSha, headSha)`: scoped per PR and per head, so a
 * force-push moves the user onto a fresh draft slot. `headSha` must be the
 * platform's head, not the local checkout's — keying on local HEAD discarded
 * the draft slot on every local commit.
 */
function makeKey(ctx: PrContext): string {
  const h = crypto.createHash("sha1");
  h.update(ctx.remoteUrl);
  h.update("\0");
  h.update(ctx.baseSha);
  h.update("\0");
  h.update(ctx.headSha);
  return h.digest("hex").slice(0, 16);
}

function uuid(): string {
  return crypto.randomBytes(8).toString("hex");
}

interface PrReviewComment extends vscode.Comment {
  draftId: string;
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode;
  author: vscode.CommentAuthorInformation;
}

export class PrReviewController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly log: Logger;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly treeProvider: PrReviewTreeProvider;
  private treeView: vscode.TreeView<unknown> | null = null;
  private session: ActiveSession | null = null;

  constructor(context: vscode.ExtensionContext, log: Logger) {
    this.context = context;
    this.log = log;
    // Retained for the dormant native-gutter surface so existing menu
    // contributions resolve; drafts are managed through the webview panel.
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => this.commentingRangesFor(doc),
    };
    this.controller.options = {
      prompt: "Add a PR review comment…",
      placeHolder: "Markdown rendered in the PR comment.",
    };
    this.treeProvider = new PrReviewTreeProvider({
      onOpenFile: (file) => this.openFile(file.path),
      getDraftCount: (rel) => this.loadDrafts().filter((d) => d.path === rel).length,
    });
    this.disposables.push(this.controller);
    this.gcStaleDrafts();
  }

  activate(subs: vscode.Disposable[]): void {
    this.treeView = vscode.window.createTreeView("markdownCollab.prReviewFiles", {
      treeDataProvider: this.treeProvider,
      showCollapseAll: true,
    });
    this.updateEmptyMessage();
    subs.push(
      this.treeView,
      vscode.commands.registerCommand("markdownCollab.openPrReviewFile", (file: ChangedFile) => {
        this.openFile(file.path);
      }),
      vscode.commands.registerCommand("markdownCollab.startPrReview", () => this.startPrReview()),
      vscode.commands.registerCommand("markdownCollab.prReviewRefresh", () => this.refreshReview()),
      vscode.commands.registerCommand("markdownCollab.prReviewAddComment", (reply: vscode.CommentReply) =>
        this.addComment(reply),
      ),
      vscode.commands.registerCommand("markdownCollab.prReviewEditComment", (c: PrReviewComment) =>
        this.beginEdit(c),
      ),
      vscode.commands.registerCommand("markdownCollab.prReviewSaveEdit", (c: PrReviewComment) =>
        this.saveEdit(c),
      ),
      vscode.commands.registerCommand("markdownCollab.prReviewCancelEdit", (c: PrReviewComment) =>
        this.cancelEdit(c),
      ),
      vscode.commands.registerCommand(
        "markdownCollab.prReviewDeleteComment",
        (thread: vscode.CommentThread) => this.deleteDraft(thread),
      ),
      this,
    );
  }

  private async startPrReview(): Promise<void> {
    if (!requireTrust("PR review")) return;
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage("Open a workspace folder first.");
        this.updateEmptyMessage();
        return;
      }
      const repoRoot = folder.uri.fsPath;
      const branch = await currentBranch(repoRoot).catch(() => "");
      const remoteUrl = await originRemoteUrl(repoRoot).catch(() => null);
      if (!remoteUrl) {
        void vscode.window.showWarningMessage(
          "Could not read the `origin` remote. Is this folder a git repo with an `origin`?",
        );
        this.updateEmptyMessage();
        return;
      }
      const platform = detectPlatform(remoteUrl);
      const parsed = parseRemoteUrl(remoteUrl);
      if (!parsed) {
        void vscode.window.showWarningMessage(`Could not parse remote URL: ${remoteUrl}`);
        this.updateEmptyMessage();
        return;
      }
      const ready = await platform.ensureReady(parsed.host);
      if (!ready.ok) {
        void vscode.window.showWarningMessage(ready.reason);
        this.updateEmptyMessage();
        return;
      }
      const ctx = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Markdown Collab: loading PR…" },
        () => platform.loadContext(repoRoot, remoteUrl, parsed.host),
      );
      // The local checkout can sit ahead of the platform (unpushed commits). Record it
      // separately — it keys the draft store and drives the local diff — but leave
      // `ctx.headSha` as the platform's head: GitLab rejects, or fails to anchor, a
      // `position[head_sha]` it has never seen.
      const localHead = await readHeadSha(repoRoot).catch(() => ctx.headSha);
      ctx.localHeadSha = localHead;
      if (localHead !== ctx.headSha) {
        this.log.info(
          `PR review: local HEAD (${localHead.slice(0, 7)}) is ahead of the ${ctx.platform === "gitlab" ? "MR" : "PR"} head (${ctx.headSha.slice(0, 7)}). Comments post against the pushed head.`,
        );
        void vscode.window.showWarningMessage(
          `This branch has commits that aren't pushed yet. Comments will be posted against the pushed head (${ctx.headSha.slice(0, 7)}) — lines that exist only locally can't be commented on until you push.`,
        );
      }
      const changed = await listChangedMarkdownFiles(repoRoot, `origin/${ctx.baseRef}`);
      if (changed.length === 0) {
        void vscode.window.showInformationMessage(
          `No .md / .markdown changes in this PR vs origin/${ctx.baseRef}. Nothing to review.`,
        );
        this.updateEmptyMessage();
        return;
      }
      // Retire any review left over from a previously checked-out branch so
      // its draft threads and open panels don't linger over the new one.
      this.disposeSession();
      this.session = {
        ctx,
        platform,
        branch,
        rangesByPath: new Map(),
        threadsByDraft: new Map(),
        existingComments: null,
        existingCommentsLoading: null,
        warnedPartialLoad: false,
      };
      await this.rehydrateDrafts();
      this.treeProvider.setFiles(changed);
      this.updateEmptyMessage();
      try {
        await vscode.commands.executeCommand("markdownCollab.prReviewFiles.focus");
      } catch {
        /* view may not be ready yet on first activation; ignore */
      }
      if (changed.length === 1) this.openFile(changed[0].path);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      void vscode.window.showErrorMessage(`PR review failed: ${msg}`);
      this.log.error("startPrReview failed", e);
      this.updateEmptyMessage();
    }
  }

  private updateEmptyMessage(): void {
    if (!this.treeView) return;
    if (this.session) {
      this.treeView.message = undefined;
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.treeView.message = folder
      ? "Run Open PR Review to load a GitHub PR or GitLab MR."
      : "Open a folder to review a PR or MR.";
  }

  private openFile(relPath: string): void {
    if (!this.session) return;
    PrReviewPanel.reveal(this.context, this.draftHostApi(), relPath);
  }

  /**
   * Doubles as a start affordance: with no active review, or after a branch
   * switch, it starts a fresh one; on the base/default branch or a detached HEAD
   * it retires any stale session and hints instead.
   */
  private async refreshReview(): Promise<void> {
    if (!requireTrust("PR review")) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage("Open a workspace folder first.");
      this.updateEmptyMessage();
      return;
    }
    const repoRoot = folder.uri.fsPath;
    const branch = await currentBranch(repoRoot).catch(() => "");

    const onSessionBranch = !!this.session && branch !== "" && this.session.branch === branch;
    if (!onSessionBranch) {
      if (await this.onBaseBranch(repoRoot, branch)) {
        if (this.session) {
          this.disposeSession();
          this.treeProvider.clear();
        }
        this.updateEmptyMessage();
        const where = branch && branch !== "HEAD" ? `"${branch}"` : "a detached HEAD";
        void vscode.window.showInformationMessage(
          `You're on ${where}. Check out a PR/MR branch, then refresh to start a review.`,
        );
        return;
      }
      return this.startPrReview();
    }

    await this.refreshActiveSession(this.session!);
    this.updateEmptyMessage();
  }

  /** True for the session's base ref, the repo default branch (`origin/HEAD`, else main/master), and a detached HEAD. */
  private async onBaseBranch(repoRoot: string, branch: string): Promise<boolean> {
    if (branch === "" || branch === "HEAD") return true;
    if (this.session && branch === this.session.ctx.baseRef) return true;
    const def = await defaultBranch(repoRoot).catch(() => null);
    if (def) return branch === def;
    return branch === "main" || branch === "master";
  }

  private disposeSession(): void {
    if (!this.session) return;
    for (const t of this.session.threadsByDraft.values()) {
      try {
        t.dispose();
      } catch {
        /* ignore */
      }
    }
    PrReviewPanel.closeForContext(this.session.ctx);
    this.session = null;
  }

  private async refreshActiveSession(session: ActiveSession): Promise<void> {
    try {
      const changed = await vscode.window.withProgress(
        { location: { viewId: "markdownCollab.prReviewFiles" } },
        async () => {
          const files = await listChangedMarkdownFiles(
            session.ctx.repoRoot,
            `origin/${session.ctx.baseRef}`,
          );
          session.rangesByPath.clear();
          session.existingComments = null;
          session.existingCommentsLoading = null;
          for (const t of session.threadsByDraft.values()) t.dispose();
          session.threadsByDraft.clear();
          await this.rehydrateDrafts();
          return files;
        },
      );
      this.treeProvider.setFiles(changed);
      PrReviewPanel.refreshAll(session.ctx);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      void vscode.window.showErrorMessage(`PR review refresh failed: ${msg}`);
      this.log.error("refreshReview failed", e);
    }
  }

  private async getExistingComments(): Promise<ExistingPrComment[]> {
    if (!this.session) return [];
    const session = this.session;
    if (session.existingComments) return session.existingComments;
    if (session.existingCommentsLoading) return session.existingCommentsLoading;
    const promise = (async () => {
      try {
        const comments = await session.platform.listExistingComments(session.ctx);
        const warning = (comments as ExistingPrComment[] & { partialLoadWarning?: string }).partialLoadWarning;
        if (warning && !session.warnedPartialLoad) {
          session.warnedPartialLoad = true;
          void vscode.window
            .showWarningMessage("Some existing comments couldn't be loaded — see Show Logs.", "Show Logs")
            .then((action) => {
              if (action === "Show Logs") this.log.show();
            });
        }
        session.existingComments = comments;
        return comments;
      } catch (e) {
        this.log.info(
          `PR review: failed to fetch existing comments: ${(e as Error).message}`,
        );
        session.existingComments = [];
        return [];
      } finally {
        session.existingCommentsLoading = null;
      }
    })();
    session.existingCommentsLoading = promise;
    return promise;
  }

  private draftHostApi(): {
    ctx: PrContext;
    getDraftsFor: (rel: string) => PrDraft[];
    getAllDrafts: () => PrDraft[];
    addDraft: (d: Omit<PrDraft, "id" | "createdAt">) => Promise<PrDraft>;
    updateDraftBody: (id: string, body: string) => Promise<void>;
    deleteDraft: (id: string) => Promise<void>;
    submit: (verdict: ReviewVerdict, body: string | undefined) => Promise<void>;
    getExistingCommentsFor: (rel: string) => Promise<ExistingPrComment[]>;
    replyToExisting: (rel: string, threadId: string, body: string) => Promise<{ url: string }>;
    resolveThread: (rel: string, resolveId: string, resolved: boolean) => Promise<void>;
  } {
    if (!this.session) throw new Error("PR review session not active");
    const session = this.session;
    return {
      ctx: session.ctx,
      getDraftsFor: (rel) => this.loadDrafts().filter((d) => d.path === rel),
      getAllDrafts: () => this.loadDrafts(),
      addDraft: async (d) => {
        const draft: PrDraft = {
          ...d,
          id: uuid(),
          createdAt: new Date().toISOString(),
        };
        await this.persistDrafts((arr) => arr.concat(draft));
        PrReviewPanel.notifyDraftsChanged(session.ctx, this.draftHostApi());
        return draft;
      },
      updateDraftBody: async (id, body) => {
        await this.persistDrafts((arr) => arr.map((d) => (d.id === id ? { ...d, body } : d)));
        PrReviewPanel.notifyDraftsChanged(session.ctx, this.draftHostApi());
      },
      deleteDraft: async (id) => {
        await this.persistDrafts((arr) => arr.filter((d) => d.id !== id));
        PrReviewPanel.notifyDraftsChanged(session.ctx, this.draftHostApi());
      },
      submit: (verdict, body) => this.submitPrReview(verdict, body),
      getExistingCommentsFor: async (rel) => {
        const all = await this.getExistingComments();
        return all.filter((c) => c.path === rel);
      },
      replyToExisting: async (rel, threadId, body) => {
        // Only send back an id this session handed the webview for this exact file in
        // the latest existing-comments fetch, never an arbitrary string from a possibly
        // compromised webview. This is provenance, separate from the shape checks each
        // platform adapter runs.
        const existing = await this.getExistingComments();
        const known = existing.some((c) => c.path === rel && (c.threadId ?? c.id) === threadId);
        if (!known) {
          throw new Error(
            `Refusing to reply: that id wasn't among the comments last fetched for ${rel}.`,
          );
        }
        const result = await session.platform.replyToComment(session.ctx, threadId, body);
        // Drop the cache so the re-fetch right after includes the reply.
        session.existingComments = null;
        session.existingCommentsLoading = null;
        return result;
      },
      resolveThread: async (rel, resolveId, resolved) => {
        // Same provenance check as replyToExisting, also gated on `resolvable`.
        const existing = await this.getExistingComments();
        const known = existing.some((c) => c.path === rel && c.resolvable && c.resolveId === resolveId);
        if (!known) {
          throw new Error(
            `Refusing to ${resolved ? "resolve" : "unresolve"}: that id wasn't among the comments last fetched for ${rel}.`,
          );
        }
        await session.platform.resolveThread(session.ctx, resolveId, resolved);
        session.existingComments = null;
        session.existingCommentsLoading = null;
      },
    };
  }

  private async commentingRangesFor(doc: vscode.TextDocument): Promise<vscode.Range[]> {
    if (!this.session) return [];
    const rel = this.relPathFor(doc);
    if (!rel) return [];
    const ranges = await this.rangesFor(rel);
    if (ranges.length === 0) return [];
    return ranges.map((r) => new vscode.Range(r.start - 1, 0, r.end - 1, Number.MAX_SAFE_INTEGER));
  }

  private async rangesFor(relPath: string): Promise<LineRange[]> {
    if (!this.session) return [];
    const cached = this.session.rangesByPath.get(relPath);
    if (cached) return cached;
    const ranges = await addedLineRanges(
      this.session.ctx.repoRoot,
      `origin/${this.session.ctx.baseRef}`,
      relPath,
    );
    this.session.rangesByPath.set(relPath, ranges);
    return ranges;
  }

  private relPathFor(doc: vscode.TextDocument): string | null {
    if (!this.session) return null;
    const rel = path.relative(this.session.ctx.repoRoot, doc.uri.fsPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  private async addComment(reply: vscode.CommentReply): Promise<void> {
    if (!this.session) return;
    const doc = await vscode.workspace.openTextDocument(reply.thread.uri);
    const rel = this.relPathFor(doc);
    if (!rel) {
      void vscode.window.showWarningMessage("Comment must be on a file inside the workspace.");
      reply.thread.dispose();
      return;
    }
    const range = reply.thread.range;
    if (!range) {
      void vscode.window.showWarningMessage("Comment thread has no range; cannot anchor.");
      reply.thread.dispose();
      return;
    }
    const draft: PrDraft = {
      id: uuid(),
      path: rel,
      body: reply.text,
      line: range.end.line + 1,
      side: "RIGHT",
      startLine: range.start.line === range.end.line ? undefined : range.start.line + 1,
      createdAt: new Date().toISOString(),
    };
    const ranges = await this.rangesFor(rel);
    if (!lineInRanges(draft.line, ranges)) {
      void vscode.window.showWarningMessage(
        `Line ${draft.line} is not part of this PR's diff for ${rel}. Comment not saved.`,
      );
      reply.thread.dispose();
      return;
    }
    this.persistDrafts((arr) => arr.concat(draft));
    this.attachDraftToThread(reply.thread, draft);
  }

  private attachDraftToThread(thread: vscode.CommentThread, draft: PrDraft): void {
    if (!this.session) return;
    const c: PrReviewComment = {
      draftId: draft.id,
      body: new vscode.MarkdownString(draft.body),
      mode: vscode.CommentMode.Preview,
      author: { name: "(draft)" },
      label: "draft",
      contextValue: "prDraft",
    };
    thread.comments = [c];
    thread.label = "PR review draft";
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue = "prDraft";
    this.session.threadsByDraft.set(draft.id, thread);
  }

  private beginEdit(c: PrReviewComment): void {
    const thread = this.findThreadForComment(c);
    if (!thread) return;
    thread.comments = thread.comments.map((existing) => {
      if ((existing as PrReviewComment).draftId !== c.draftId) return existing;
      return { ...(existing as PrReviewComment), mode: vscode.CommentMode.Editing };
    });
  }

  private saveEdit(c: PrReviewComment): void {
    const thread = this.findThreadForComment(c);
    if (!thread) return;
    const body = typeof c.body === "string" ? c.body : c.body.value;
    this.persistDrafts((arr) => arr.map((d) => (d.id === c.draftId ? { ...d, body } : d)));
    thread.comments = thread.comments.map((existing) => {
      if ((existing as PrReviewComment).draftId !== c.draftId) return existing;
      return {
        ...(existing as PrReviewComment),
        body: new vscode.MarkdownString(body),
        mode: vscode.CommentMode.Preview,
      };
    });
  }

  private cancelEdit(c: PrReviewComment): void {
    const thread = this.findThreadForComment(c);
    if (!thread) return;
    const drafts = this.loadDrafts();
    const original = drafts.find((d) => d.id === c.draftId);
    if (!original) return;
    thread.comments = thread.comments.map((existing) => {
      if ((existing as PrReviewComment).draftId !== c.draftId) return existing;
      return {
        ...(existing as PrReviewComment),
        body: new vscode.MarkdownString(original.body),
        mode: vscode.CommentMode.Preview,
      };
    });
  }

  private deleteDraft(thread: vscode.CommentThread): void {
    if (!this.session) return;
    const first = thread.comments[0] as PrReviewComment | undefined;
    if (!first) {
      thread.dispose();
      return;
    }
    this.persistDrafts((arr) => arr.filter((d) => d.id !== first.draftId));
    this.session.threadsByDraft.delete(first.draftId);
    thread.dispose();
  }

  private findThreadForComment(c: PrReviewComment): vscode.CommentThread | undefined {
    return this.session?.threadsByDraft.get(c.draftId);
  }

  private loadDrafts(): PrDraft[] {
    if (!this.session) return [];
    const env = this.context.workspaceState.get<DraftEnvelope>(
      STATE_KEY_PREFIX + makeKey(this.session.ctx),
    );
    return env?.drafts ?? [];
  }

  private async persistDrafts(mutator: (drafts: PrDraft[]) => PrDraft[]): Promise<void> {
    if (!this.session) return;
    const key = STATE_KEY_PREFIX + makeKey(this.session.ctx);
    const current = this.context.workspaceState.get<DraftEnvelope>(key);
    const next: DraftEnvelope = {
      key,
      ctxSummary: {
        platform: this.session.ctx.platform,
        prNumber: this.session.ctx.prNumber,
        baseRef: this.session.ctx.baseRef,
        headSha: this.session.ctx.headSha,
      },
      drafts: mutator(current?.drafts ?? []),
      updatedAt: new Date().toISOString(),
    };
    await this.context.workspaceState.update(key, next);
    this.treeProvider.refresh();
  }

  private async rehydrateDrafts(): Promise<void> {
    if (!this.session) return;
    const drafts = this.loadDrafts();
    for (const d of drafts) {
      const ranges = await this.rangesFor(d.path);
      if (!lineInRanges(d.line, ranges)) {
        // Line no longer in diff (force-push, rebase). Surface but keep
        // the draft around so the user can copy/repaste manually.
        this.log.info(
          `PR review: draft on ${d.path}:${d.line} is no longer in the diff.`,
        );
        continue;
      }
      const fullPath = path.join(this.session.ctx.repoRoot, d.path);
      const uri = vscode.Uri.file(fullPath);
      const startLine = (d.startLine ?? d.line) - 1;
      const endLine = d.line - 1;
      const range = new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
      const thread = this.controller.createCommentThread(uri, range, []);
      this.attachDraftToThread(thread, d);
    }
  }

  private gcStaleDrafts(): void {
    const cutoff = Date.now() - DRAFT_TTL_MS;
    for (const key of this.context.workspaceState.keys()) {
      if (!key.startsWith(STATE_KEY_PREFIX)) continue;
      const env = this.context.workspaceState.get<DraftEnvelope>(key);
      const t = env?.updatedAt ? Date.parse(env.updatedAt) : 0;
      if (!t || t < cutoff) {
        void this.context.workspaceState.update(key, undefined);
      }
    }
  }

  private async submitPrReview(
    verdict: ReviewVerdict,
    reviewBody: string | undefined,
  ): Promise<void> {
    if (!this.session) {
      void vscode.window.showInformationMessage(
        "No active PR review. Run `Markdown Collab: Review PR` first.",
      );
      return;
    }
    const drafts = this.loadDrafts();
    if (drafts.length === 0) {
      void vscode.window.showInformationMessage("No drafts to submit.");
      return;
    }
    const stale: PrDraft[] = [];
    const live: PrDraft[] = [];
    for (const d of drafts) {
      const ranges = await this.rangesFor(d.path);
      if (lineInRanges(d.line, ranges)) live.push(d);
      else stale.push(d);
    }
    if (live.length === 0) {
      void vscode.window.showWarningMessage(
        "All drafts point to lines no longer in the PR diff. Nothing to submit.",
      );
      return;
    }
    // Stale drafts are left out of the submit; the post-submit toast reports how many were kept.
    const submitted: { url: string } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Markdown Collab: submitting review…" },
      async () => {
        return this.session!.platform.submitReview(this.session!.ctx, {
          verdict,
          body: reviewBody || undefined,
          comments: live.map<PrComment>((d) => ({
            path: d.path,
            body: d.body,
            line: d.line,
            side: d.side,
            startLine: d.startLine,
          })),
        });
      },
    );
    const submittedIds = new Set(live.map((d) => d.id));
    await this.persistDrafts((arr) => arr.filter((d) => !submittedIds.has(d.id)));
    for (const id of submittedIds) {
      const t = this.session.threadsByDraft.get(id);
      t?.dispose();
      this.session.threadsByDraft.delete(id);
    }
    PrReviewPanel.notifyDraftsChanged(this.session.ctx, this.draftHostApi());
    const skipped = stale.length > 0
      ? ` ${stale.length} stale draft${stale.length === 1 ? "" : "s"} kept for rework.`
      : "";
    const action = await vscode.window.showInformationMessage(
      `Submitted ${live.length} comment${live.length === 1 ? "" : "s"} (${verdict}).${skipped}`,
      "Open review",
    );
    if (action === "Open review") {
      void vscode.env.openExternal(vscode.Uri.parse(submitted.url));
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.length = 0;
  }
}
