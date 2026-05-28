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

export interface PrPlatform {
  readonly name: Platform;
  /** Quick stdout/stderr-safe check that the CLI is installed and authenticated for `host`. */
  ensureReady(host: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Resolve PR context from the local checkout. */
  loadContext(repoRoot: string, remoteUrl: string, host: string): Promise<PrContext>;
  /** Submit a batch review. Returns the URL of the resulting review. */
  submitReview(ctx: PrContext, input: SubmitReviewInput): Promise<{ url: string }>;
}
