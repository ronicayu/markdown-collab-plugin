// Posted comments end up as native GitHub PR review comments or GitLab MR discussion
// notes — the `.md` file is never modified.

export type Platform = "github" | "gitlab";

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

export interface PrDraft extends PrComment {
  id: string;
  createdAt: string;
}

export interface PrContext {
  platform: Platform;
  remoteUrl: string;
  repoRoot: string;
  /** Merge-base of the base ref and HEAD. */
  baseSha: string;
  /**
   * The head SHA **the platform knows** for this PR/MR — GitHub's
   * `headRefOid`, GitLab's `diff_refs.head_sha`. Every value posted back to
   * the API (GitHub `commit_id`, GitLab `position[head_sha]`) must use this
   * one: a SHA the server has never seen is rejected, and on GitLab a
   * position whose SHAs disagree either 400s or posts unanchored.
   *
   * Never overwrite this with the local HEAD — that is `localHeadSha`.
   */
  headSha: string;
  /**
   * The local checkout's HEAD, which drifts ahead of `headSha` the moment
   * there are unpushed commits. Used only for local work: keying the draft
   * store and diffing the working tree. Absent means "same as `headSha`".
   */
  localHeadSha?: string;
  baseRef: string;
  /** Pull request number (GitHub) or merge request IID (GitLab). */
  prNumber: number;
  /** GitLab only: URL-encoded "owner/repo" project path. */
  projectId?: string;
  /** GitLab only: from MR `diff_refs.start_sha`. */
  startSha?: string;
  /** URL to the PR/MR page; used in success toasts. */
  prUrl: string;
  owner: string;
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
  /**
   * Can this thread be resolved/unresolved at all? GitHub: true for every
   * review-thread comment (the REST comments this feature fetches are
   * always part of a resolvable `PullRequestReviewThread`). GitLab: mirrors
   * the note's own `resolvable` flag — false for a non-resolvable
   * discussion or a plain MR note. Undefined means unknown (e.g. the
   * GitHub GraphQL enrichment failed) — treat the same as false.
   */
  resolvable?: boolean;
  /**
   * The id to pass to `PrPlatform.resolveThread`. GitHub: the GraphQL
   * `PullRequestReviewThread` node id — deliberately NOT the same value as
   * `threadId` above, which is the REST root-comment id `replyToComment`
   * expects; the two ids are different shapes and neither endpoint accepts
   * the other's. GitLab: the discussion id, same value as `threadId`.
   * Present only when `resolvable` is true.
   */
  resolveId?: string;
}

export interface PrPlatform {
  readonly name: Platform;
  ensureReady(host: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  loadContext(repoRoot: string, remoteUrl: string, host: string): Promise<PrContext>;
  submitReview(ctx: PrContext, input: SubmitReviewInput): Promise<{ url: string }>;
  listExistingComments(ctx: PrContext): Promise<ExistingPrComment[]>;
  /**
   * Post a reply to an existing comment thread, identified by the
   * `ExistingPrComment.threadId` (GitHub root review-comment id; GitLab
   * discussion id). Posts immediately — replies are not batched into a
   * review. Returns the URL of the new reply.
   */
  replyToComment(ctx: PrContext, threadId: string, body: string): Promise<{ url: string }>;
  /**
   * Resolve or unresolve a thread, identified by `ExistingPrComment.resolveId`.
   * Only ever called for a comment whose `resolvable` was true — callers
   * (the webview, and this platform's own tests) are responsible for that
   * gate; the adapter itself doesn't re-check it.
   */
  resolveThread(ctx: PrContext, resolveId: string, resolved: boolean): Promise<void>;
}
