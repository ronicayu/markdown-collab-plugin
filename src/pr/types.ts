/**
 * Types shared by the PR/MR review feature. Posted comments end up as
 * native GitHub PR review comments or GitLab MR discussion notes — the
 * `.md` file is never modified.
 */

export type Platform = "github" | "gitlab";

/** A single in-progress or about-to-submit review comment. */
export interface PrComment {
  /** Repo-relative path of the changed file (head side). */
  path: string;
  /** Markdown body of the comment. Posted verbatim. */
  body: string;
  /** 1-based line number in the head file. */
  line: number;
  /** v1 always anchors against the new side. */
  side: "RIGHT";
  /** For multi-line comments, the first line of the range. `line` is the last. */
  startLine?: number;
}

/** Local draft form — augments `PrComment` with bookkeeping fields. */
export interface PrDraft extends PrComment {
  id: string;
  createdAt: string;
}

/** Result of probing the local checkout and the platform CLI. */
export interface PrContext {
  platform: Platform;
  remoteUrl: string;
  repoRoot: string;
  /** Merge-base of the base ref and HEAD. */
  baseSha: string;
  /** HEAD SHA at the time the context was loaded. */
  headSha: string;
  /** Human-friendly base ref name, e.g. "main". */
  baseRef: string;
  /** Pull request number (GitHub) or merge request IID (GitLab). */
  prNumber: number;
  /** GitLab only: URL-encoded "owner/repo" project path. */
  projectId?: string;
  /** GitLab only: from MR `diff_refs.start_sha`. */
  startSha?: string;
  /** URL to the PR/MR page; used in success toasts. */
  prUrl: string;
  /** Owner / namespace from the remote URL. */
  owner: string;
  /** Repo name from the remote URL. */
  repo: string;
  /** Resolved host (e.g. "github.com", "gitlab.example.com"). */
  host: string;
}

export type ReviewVerdict = "comment" | "approve" | "request-changes";

export interface SubmitReviewInput {
  verdict: ReviewVerdict;
  body?: string;
  comments: PrComment[];
}

/**
 * A comment that already exists on the PR/MR — fetched from the platform
 * API. v1 surfaces these as read-only cards alongside the reviewer's own
 * drafts; reply support is deferred.
 */
export interface ExistingPrComment {
  /** Platform-side comment id (string for cross-platform safety). */
  id: string;
  /** Discussion / thread id when the platform groups replies. Used to nest. */
  threadId?: string;
  /** Display name of the comment author. */
  author: string;
  /** Markdown body, posted verbatim by the author. */
  body: string;
  /** Repo-relative path, head side. */
  path: string;
  /** 1-based line number this comment anchors to. */
  line: number;
  /** "RIGHT" for head-side, "LEFT" for base-side. */
  side: "RIGHT" | "LEFT";
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Permalink to the comment on the platform. */
  url: string;
  /** Resolved / outdated state when the platform tracks it. */
  resolved?: boolean;
}

export interface PrPlatform {
  readonly name: Platform;
  /** Quick stdout/stderr-safe check that the CLI is installed and authenticated for `host`. */
  ensureReady(host: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Resolve PR context from the local checkout. */
  loadContext(repoRoot: string, remoteUrl: string, host: string): Promise<PrContext>;
  /** Submit a batch review. Returns the URL of the resulting review. */
  submitReview(ctx: PrContext, input: SubmitReviewInput): Promise<{ url: string }>;
  /** Fetch every existing line-anchored review comment on the PR/MR. */
  listExistingComments(ctx: PrContext): Promise<ExistingPrComment[]>;
  /**
   * Post a reply to an existing comment thread, identified by the
   * `ExistingPrComment.threadId` (GitHub root review-comment id; GitLab
   * discussion id). Posts immediately — replies are not batched into a
   * review. Returns the URL of the new reply.
   */
  replyToComment(ctx: PrContext, threadId: string, body: string): Promise<{ url: string }>;
}
