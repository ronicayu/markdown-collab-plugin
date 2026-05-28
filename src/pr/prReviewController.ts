/**
 * Owns the PR-review `CommentController`, the in-progress draft store,
 * and the workflow commands (`startPrReview`, `submitPrReview`).
 *
 * Distinct from the legacy `markdown-collab` controller — different
 * controller id, different storage model (workspaceState, not sidecar
 * JSON), different commenting-range provider (only the head-side added
 * lines from the diff).
 */

import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import {
  addedLineRanges,
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
import type {
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
  /** Per-file added-line ranges, lazily populated as files open. */
  rangesByPath: Map<string, LineRange[]>;
  /** Live `CommentThread`s keyed by draft id so we can update on edit. */
  threadsByDraft: Map<string, vscode.CommentThread>;
}

/**
 * Hash of `(remoteUrl, baseSha, headSha)`. Keys are scoped per PR + per
 * head, so a force-push moves the user onto a fresh draft slot rather
 * than mixing old + new comments.
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
  private readonly output: vscode.OutputChannel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];
  private session: ActiveSession | null = null;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.context = context;
    this.output = output;
    // The controller is retained for the legacy native-gutter surface
    // (kept dormant in the preview-mode flow but still registered so
    // existing menu contributions resolve cleanly). Drafts are
    // managed entirely through the webview panel now.
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => this.commentingRangesFor(doc),
    };
    this.controller.options = {
      prompt: "Add a PR review comment…",
      placeHolder: "Markdown rendered in the PR comment.",
    };
    this.disposables.push(this.controller);
    this.gcStaleDrafts();
  }

  activate(subs: vscode.Disposable[]): void {
    subs.push(
      vscode.commands.registerCommand("markdownCollab.startPrReview", () => this.startPrReview()),
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

  // --- entry point --------------------------------------------------------

  private async startPrReview(): Promise<void> {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage("Open a workspace folder first.");
        return;
      }
      const repoRoot = folder.uri.fsPath;
      const remoteUrl = await originRemoteUrl(repoRoot).catch(() => null);
      if (!remoteUrl) {
        void vscode.window.showWarningMessage(
          "Could not read the `origin` remote. Is this folder a git repo with an `origin`?",
        );
        return;
      }
      const platform = detectPlatform(remoteUrl);
      const parsed = parseRemoteUrl(remoteUrl);
      if (!parsed) {
        void vscode.window.showWarningMessage(`Could not parse remote URL: ${remoteUrl}`);
        return;
      }
      const ready = await platform.ensureReady(parsed.host);
      if (!ready.ok) {
        void vscode.window.showWarningMessage(ready.reason);
        return;
      }
      const ctx = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Markdown Collab: loading PR…" },
        () => platform.loadContext(repoRoot, remoteUrl, parsed.host),
      );
      // Verify HEAD still matches what the platform reported (a `pull --rebase`
      // mid-load would otherwise leave us anchored to a stale SHA).
      const localHead = await readHeadSha(repoRoot).catch(() => ctx.headSha);
      if (localHead !== ctx.headSha) {
        this.output.appendLine(
          `PR review: local HEAD (${localHead.slice(0, 7)}) differs from PR head (${ctx.headSha.slice(0, 7)}); using local HEAD.`,
        );
        ctx.headSha = localHead;
      }
      const changed = await listChangedMarkdownFiles(repoRoot, `origin/${ctx.baseRef}`);
      if (changed.length === 0) {
        void vscode.window.showInformationMessage(
          `No .md / .markdown changes in this PR vs origin/${ctx.baseRef}. Nothing to review.`,
        );
        return;
      }
      this.session = {
        ctx,
        platform,
        rangesByPath: new Map(),
        threadsByDraft: new Map(),
      };
      await this.rehydrateDrafts();
      await this.pickAndOpenFile(changed);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      void vscode.window.showErrorMessage(`PR review failed: ${msg}`);
      this.output.appendLine(`startPrReview error: ${msg}`);
    }
  }

  private async pickAndOpenFile(changed: ChangedFile[]): Promise<void> {
    if (!this.session) return;
    const drafts = this.loadDrafts();
    const draftsByPath = new Map<string, number>();
    for (const d of drafts) {
      draftsByPath.set(d.path, (draftsByPath.get(d.path) ?? 0) + 1);
    }
    const items: (vscode.QuickPickItem & { file: ChangedFile })[] = changed.map((f) => {
      const draftCount = draftsByPath.get(f.path) ?? 0;
      const tag = f.status === "A" ? "added" : f.status === "R" ? "renamed" : "modified";
      return {
        label: f.path,
        description: tag + (draftCount > 0 ? ` · ${draftCount} draft${draftCount === 1 ? "" : "s"}` : ""),
        file: f,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${changed.length} markdown file${changed.length === 1 ? "" : "s"} changed in this PR — pick one to review`,
      matchOnDescription: true,
    });
    if (!picked) return;
    PrReviewPanel.reveal(this.context, this.draftHostApi(), picked.file.path);
  }

  /** API surface the preview panel uses to read + mutate drafts. */
  private draftHostApi(): {
    ctx: PrContext;
    getDraftsFor: (rel: string) => PrDraft[];
    getAllDrafts: () => PrDraft[];
    addDraft: (d: Omit<PrDraft, "id" | "createdAt">) => Promise<PrDraft>;
    updateDraftBody: (id: string, body: string) => Promise<void>;
    deleteDraft: (id: string) => Promise<void>;
    submit: () => Promise<void>;
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
      submit: () => this.submitPrReview(),
    };
  }

  // --- commenting-range provider -----------------------------------------

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

  // --- comment lifecycle --------------------------------------------------

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

  // --- draft persistence --------------------------------------------------

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
  }

  private async rehydrateDrafts(): Promise<void> {
    if (!this.session) return;
    const drafts = this.loadDrafts();
    for (const d of drafts) {
      const ranges = await this.rangesFor(d.path);
      if (!lineInRanges(d.line, ranges)) {
        // Line no longer in diff (force-push, rebase). Surface but keep
        // the draft around so the user can copy/repaste manually.
        this.output.appendLine(
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

  // --- submit -------------------------------------------------------------

  private async submitPrReview(): Promise<void> {
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
    // Re-validate every draft against the current diff. Drafts whose
    // lines have moved out of the head-side diff get dropped — the user
    // sees the count up front and can cancel.
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
    if (stale.length > 0) {
      const proceed = await vscode.window.showWarningMessage(
        `${stale.length} draft${stale.length === 1 ? "" : "s"} are anchored to lines no longer in the PR diff and will be skipped. Submit the remaining ${live.length}?`,
        { modal: true },
        "Submit",
      );
      if (proceed !== "Submit") return;
    }
    const verdict = await this.askVerdict();
    if (!verdict) return;
    const reviewBody = await vscode.window.showInputBox({
      prompt: "Optional review summary (markdown, posted alongside the inline comments)",
      placeHolder: "Leave empty for inline comments only",
    });
    if (reviewBody === undefined) return;

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
    // Clear only the live drafts that were submitted; keep stale ones
    // around so the user can rework them.
    const submittedIds = new Set(live.map((d) => d.id));
    await this.persistDrafts((arr) => arr.filter((d) => !submittedIds.has(d.id)));
    for (const id of submittedIds) {
      const t = this.session.threadsByDraft.get(id);
      t?.dispose();
      this.session.threadsByDraft.delete(id);
    }
    PrReviewPanel.notifyDraftsChanged(this.session.ctx, this.draftHostApi());
    const action = await vscode.window.showInformationMessage(
      `Submitted ${live.length} comment${live.length === 1 ? "" : "s"} (${verdict}).`,
      "Open review",
    );
    if (action === "Open review") {
      void vscode.env.openExternal(vscode.Uri.parse(submitted.url));
    }
  }

  private async askVerdict(): Promise<ReviewVerdict | null> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Comment", value: "comment" as const, description: "Inline comments only, no approval signal." },
        { label: "Approve", value: "approve" as const, description: "Approve the PR with these comments." },
        {
          label: "Request changes",
          value: "request-changes" as const,
          description: "Block the PR and leave these comments.",
        },
      ],
      { placeHolder: "Review verdict" },
    );
    return pick?.value ?? null;
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
