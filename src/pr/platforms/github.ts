/**
 * GitHub PR review via the `gh` CLI. We shell `gh api …` rather than
 * `gh pr review` because the high-level command doesn't expose
 * line-anchored comments — only an overall review body. The REST shape
 * lives in https://docs.github.com/en/rest/pulls/reviews .
 */

import { getCliRunner } from "../cli";
import { mergeBaseSha, parseRemoteUrl } from "../diff";
import type { ExistingPrComment, PrContext, PrPlatform } from "../types";

const GH = "gh";

function ghEnvForHost(host: string): Record<string, string | undefined> | undefined {
  // GitHub Enterprise hosts need GH_HOST so `gh api` routes to the right
  // endpoint. github.com is the default and shouldn't be set explicitly —
  // doing so can mask user-level token mis-routing.
  if (host === "github.com") return undefined;
  return { GH_HOST: host };
}

export const githubPlatform: PrPlatform = {
  name: "github",

  async ensureReady(host) {
    const runner = getCliRunner();
    const env = ghEnvForHost(host);
    const which = await runner("sh", ["-c", `command -v ${GH} >/dev/null && echo ok || echo missing`], {});
    if (which.code !== 0 || which.stdout.trim() !== "ok") {
      return {
        ok: false,
        reason: "GitHub CLI (`gh`) not found. Install it from https://cli.github.com.",
      };
    }
    const auth = await runner(GH, ["auth", "status", "--hostname", host], { env });
    if (auth.code !== 0) {
      return {
        ok: false,
        reason: `gh is not authenticated for ${host}. Run: gh auth login --hostname ${host}`,
      };
    }
    return { ok: true };
  },

  async loadContext(repoRoot, remoteUrl, host) {
    const runner = getCliRunner();
    const env = ghEnvForHost(host);
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed) throw new Error(`Could not parse remote URL: ${remoteUrl}`);
    const view = await runner(
      GH,
      ["pr", "view", "--json", "number,baseRefName,baseRefOid,headRefOid,url"],
      { cwd: repoRoot, env },
    );
    if (view.code !== 0) {
      throw new Error(
        view.stderr.includes("no pull requests")
          ? "No open pull request found for the current branch. Push the branch and open a PR, then re-run."
          : `gh pr view failed: ${view.stderr.trim()}`,
      );
    }
    const data = JSON.parse(view.stdout) as {
      number: number;
      baseRefName: string;
      baseRefOid: string;
      headRefOid: string;
      url: string;
    };
    const base = await mergeBaseSha(repoRoot, `origin/${data.baseRefName}`, runner);
    return {
      platform: "github",
      remoteUrl,
      repoRoot,
      baseSha: base,
      headSha: data.headRefOid,
      baseRef: data.baseRefName,
      prNumber: data.number,
      prUrl: data.url,
      owner: parsed.owner,
      repo: parsed.repo,
      host,
    };
  },

  async submitReview(ctx, input) {
    const runner = getCliRunner();
    const env = ghEnvForHost(ctx.host);
    const event = ({
      "comment": "COMMENT",
      "approve": "APPROVE",
      "request-changes": "REQUEST_CHANGES",
    } as const)[input.verdict];
    const payload = {
      event,
      body: input.body ?? "",
      commit_id: ctx.headSha,
      comments: input.comments.map((c) => {
        const out: Record<string, unknown> = {
          path: c.path,
          body: c.body,
          line: c.line,
          side: c.side,
        };
        if (c.startLine !== undefined) {
          out.start_line = c.startLine;
          out.start_side = c.side;
        }
        return out;
      }),
    };
    const res = await runner(
      GH,
      [
        "api",
        `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/reviews`,
        "--method",
        "POST",
        "--input",
        "-",
      ],
      { cwd: ctx.repoRoot, env, stdin: JSON.stringify(payload) },
    );
    if (res.code !== 0) {
      throw new Error(`gh api review submit failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const parsed = JSON.parse(res.stdout) as { html_url?: string };
    return { url: parsed.html_url ?? ctx.prUrl };
  },

  async replyToComment(ctx, threadId, body) {
    const runner = getCliRunner();
    const env = ghEnvForHost(ctx.host);
    // `…/comments/{comment_id}/replies` threads the new note under the
    // existing review comment. `threadId` is the root comment id (set in
    // listExistingComments), which is what this endpoint expects.
    const res = await runner(
      GH,
      [
        "api",
        `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/comments/${threadId}/replies`,
        "--method",
        "POST",
        "--input",
        "-",
      ],
      { cwd: ctx.repoRoot, env, stdin: JSON.stringify({ body }) },
    );
    if (res.code !== 0) {
      throw new Error(`gh api reply failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const parsed = JSON.parse(res.stdout) as { html_url?: string };
    return { url: parsed.html_url ?? ctx.prUrl };
  },

  async listExistingComments(ctx) {
    const runner = getCliRunner();
    const env = ghEnvForHost(ctx.host);
    // Paginate so PRs with hundreds of comments don't truncate.
    const res = await runner(
      GH,
      [
        "api",
        "--paginate",
        `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/comments`,
      ],
      { cwd: ctx.repoRoot, env },
    );
    if (res.code !== 0) {
      throw new Error(`gh api comments failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    // gh --paginate concatenates pages as JSON arrays separated by newlines.
    // Each page is a `[...]` array. Parse them all and flatten.
    const raw = res.stdout.trim();
    if (!raw) return [];
    type GhComment = {
      id: number;
      in_reply_to_id?: number;
      user?: { login?: string };
      body: string;
      path: string;
      line?: number;
      original_line?: number;
      side?: "RIGHT" | "LEFT";
      created_at: string;
      html_url: string;
    };
    const items: GhComment[] = [];
    // gh --paginate yields either one big array or a stream of arrays
    // concatenated. Handle both via incremental scanning.
    try {
      const parsed = JSON.parse(raw) as GhComment[];
      items.push(...parsed);
    } catch {
      // Multi-page: split on `][` boundaries and re-wrap.
      const pages = raw.split(/\]\s*\[/g).map((p, i, arr) => {
        if (arr.length === 1) return p;
        if (i === 0) return `${p}]`;
        if (i === arr.length - 1) return `[${p}`;
        return `[${p}]`;
      });
      for (const page of pages) {
        try {
          const parsed = JSON.parse(page) as GhComment[];
          items.push(...parsed);
        } catch {
          // Page didn't parse — skip rather than fail the whole load.
        }
      }
    }
    const out: ExistingPrComment[] = [];
    for (const c of items) {
      const line = c.line ?? c.original_line;
      if (line == null || !c.path) continue;
      out.push({
        id: String(c.id),
        threadId: c.in_reply_to_id ? String(c.in_reply_to_id) : String(c.id),
        author: c.user?.login ?? "unknown",
        body: c.body,
        path: c.path,
        line,
        side: c.side ?? "RIGHT",
        createdAt: c.created_at,
        url: c.html_url,
      });
    }
    try {
      const resolvedById = await fetchResolvedById(ctx);
      for (const c of out) {
        const r = resolvedById.get(c.id);
        if (r !== undefined) c.resolved = r;
      }
    } catch {
      // Resolved state is an enhancement — the review still works with
      // every thread treated as open, so a GraphQL failure (old gh, token
      // without GraphQL scope) must not fail the whole comment load.
    }
    return out;
  },
};

/** One page of the reviewThreads GraphQL response, reduced to what we use. */
export interface ReviewThreadsPage {
  nodes: { isResolved: boolean; commentIds: string[] }[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Parse a `reviewThreads` GraphQL page. Comment ids come back as REST
 * `databaseId`s, stringified to match `ExistingPrComment.id`.
 */
export function parseReviewThreadsPage(json: string): ReviewThreadsPage {
  const parsed = JSON.parse(json) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: { isResolved?: boolean; comments?: { nodes?: { databaseId?: number | null }[] } }[];
    } } } };
  };
  const rt = parsed.data?.repository?.pullRequest?.reviewThreads;
  const nodes = (rt?.nodes ?? []).map((n) => ({
    isResolved: n?.isResolved === true,
    commentIds: (n?.comments?.nodes ?? [])
      .map((c) => c?.databaseId)
      .filter((d): d is number => typeof d === "number")
      .map(String),
  }));
  return {
    nodes,
    hasNextPage: rt?.pageInfo?.hasNextPage === true,
    endCursor: rt?.pageInfo?.endCursor ?? null,
  };
}

/**
 * The REST comments endpoint carries no resolved state — that lives on
 * GraphQL review threads. Map every thread comment's databaseId to its
 * thread's `isResolved`.
 */
async function fetchResolvedById(ctx: PrContext): Promise<Map<string, boolean>> {
  const runner = getCliRunner();
  const env = ghEnvForHost(ctx.host);
  const query = `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 100) { nodes { databaseId } } }
      }
    }
  }
}`;
  const resolvedById = new Map<string, boolean>();
  let cursor: string | null = null;
  // Page cap so a misbehaving pageInfo can never loop forever (100 threads/page).
  for (let page = 0; page < 20; page++) {
    const args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${ctx.owner}`,
      "-F", `repo=${ctx.repo}`,
      "-F", `pr=${ctx.prNumber}`,
    ];
    if (cursor) args.push("-F", `endCursor=${cursor}`);
    const res = await runner(GH, args, { cwd: ctx.repoRoot, env });
    if (res.code !== 0) {
      throw new Error(`gh api graphql failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const threads = parseReviewThreadsPage(res.stdout);
    for (const t of threads.nodes) {
      for (const id of t.commentIds) resolvedById.set(id, t.isResolved);
    }
    if (!threads.hasNextPage || !threads.endCursor) break;
    cursor = threads.endCursor;
  }
  return resolvedById;
}
