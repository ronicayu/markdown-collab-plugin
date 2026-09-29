/**
 * GitHub PR review via the `gh` CLI. We shell `gh api …` rather than
 * `gh pr review` because the high-level command doesn't expose
 * line-anchored comments — only an overall review body. The REST shape
 * lives in https://docs.github.com/en/rest/pulls/reviews .
 */

import { getCliRunner, getLogger } from "../cli";
import { mergeBaseSha, parseRemoteUrl } from "../diff";
import type { ExistingPrComment, PrContext, PrPlatform } from "../types";

const GH = "gh";

/**
 * GitHub GraphQL node id (base64-ish, opaque) — what `resolveThread` takes as
 * `resolveId`. `gh api graphql -F` coerces a value into a number/boolean
 * before sending it, so a genuine node id (always a string) must go through
 * `-f`; this regex is the format check that runs before either flag is
 * chosen, so a value shaped like a file reference (`@~/.ssh/id_ed25519`) or
 * anything else `-f`/`-F` might misinterpret never reaches `gh` at all.
 */
const GRAPHQL_NODE_ID_RE = /^[A-Za-z0-9_=-]+$/;
/** GitHub REST resource id — always a positive integer, sent as a path segment. */
const REST_ID_RE = /^\d+$/;

function assertFormat(re: RegExp, value: string, what: string): void {
  if (!re.test(value)) {
    throw new Error(`Refusing to send ${what} to GitHub: "${value.slice(0, 40)}" doesn't look like one.`);
  }
}

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
    // `threadId` is the root comment id (set in listExistingComments), which
    // is what this endpoint expects — validate before it ever reaches a URL
    // or a `gh` argv.
    assertFormat(REST_ID_RE, threadId, "a comment id");
    const runner = getCliRunner();
    const env = ghEnvForHost(ctx.host);
    // `…/comments/{comment_id}/replies` threads the new note under the
    // existing review comment.
    const res = await runner(
      GH,
      [
        "api",
        `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/comments/${encodeURIComponent(threadId)}/replies`,
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
    let parseFailures = 0;
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
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        try {
          const parsed = JSON.parse(page) as GhComment[];
          items.push(...parsed);
        } catch {
          // Page didn't parse — skip rather than fail the whole load, but
          // say so. This used to be a bare `catch {}`: comments on that page
          // vanished with nothing in the log pointing at why.
          parseFailures++;
          getLogger()?.warn("gh api comments: page failed to parse, skipping it", {
            page: i + 1,
            of: pages.length,
            bytes: page.length,
            preview: page.slice(0, 80),
          });
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
        // Look up by the thread's ROOT id (`c.threadId`, computed above from
        // `in_reply_to_id`), not `c.id`. `fetchResolvedById` only asks
        // GraphQL for each thread's first comment (see its own comment for
        // why), so only the root's databaseId is ever a key in this map — a
        // reply past comment #100 of a big thread still resolves correctly
        // because every reply in the thread shares its root's id here.
        const info = resolvedById.get(c.threadId ?? c.id);
        if (info === undefined) continue;
        c.resolved = info.resolved;
        // Every REST review comment this fetch returns is part of some
        // PullRequestReviewThread — the thread node id above is that
        // thread's, so a comment we successfully mapped is always
        // resolvable. Leave both fields unset if the GraphQL page never
        // mentioned this comment (shouldn't happen, but no id means no
        // resolve target).
        if (info.threadId) {
          c.resolvable = true;
          c.resolveId = info.threadId;
        }
      }
    } catch {
      // Resolved state is an enhancement — the review still works with
      // every thread treated as open, so a GraphQL failure (old gh, token
      // without GraphQL scope) must not fail the whole comment load.
    }
    if (parseFailures > 0) {
      // Surfaced by the controller as a one-time notice ("Some existing
      // comments couldn't be loaded — see Show Logs"). Carried as a property
      // on the array rather than widening `PrPlatform.listExistingComments`'s
      // return type, so every existing caller (and gitlabPlatform's mirror of
      // this method) keeps working unchanged.
      (out as ExistingPrComment[] & { partialLoadWarning?: string }).partialLoadWarning =
        `${parseFailures} page${parseFailures === 1 ? "" : "s"} of PR comments failed to parse.`;
    }
    return out;
  },

  async resolveThread(ctx, resolveId, resolved) {
    assertFormat(GRAPHQL_NODE_ID_RE, resolveId, "a thread id");
    const runner = getCliRunner();
    const env = ghEnvForHost(ctx.host);
    const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const query = `mutation($threadId: ID!) {
  ${mutation}(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}`;
    // `-f` (raw string), not `-F`: `threadId` is a GraphQL `ID!`, and `-F`
    // sniffs its value into a number/boolean/`@file` before sending it.
    const res = await runner(
      GH,
      ["api", "graphql", "-f", `query=${query}`, "-f", `threadId=${resolveId}`],
      { cwd: ctx.repoRoot, env },
    );
    if (res.code !== 0) {
      throw new Error(`gh api graphql ${mutation} failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
  },
};

/** One page of the reviewThreads GraphQL response, reduced to what we use. */
export interface ReviewThreadsPage {
  nodes: { id: string; isResolved: boolean; commentIds: string[] }[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Parse a `reviewThreads` GraphQL page. Comment ids come back as REST
 * `databaseId`s, stringified to match `ExistingPrComment.id`. `id` is the
 * thread's own GraphQL node id — opaque, and the only thing
 * `resolveReviewThread`/`unresolveReviewThread` accept as `threadId`.
 */
export function parseReviewThreadsPage(json: string): ReviewThreadsPage {
  const parsed = JSON.parse(json) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: { id?: string | null; isResolved?: boolean; comments?: { nodes?: { databaseId?: number | null }[] } }[];
    } } } };
  };
  const rt = parsed.data?.repository?.pullRequest?.reviewThreads;
  const nodes = (rt?.nodes ?? []).map((n) => ({
    id: typeof n?.id === "string" ? n.id : "",
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

/** What `fetchResolvedById` knows about the thread a REST comment belongs to. */
interface ThreadInfo {
  resolved: boolean;
  /** GraphQL thread node id, or "" if the page didn't carry one. */
  threadId: string;
}

/**
 * The REST comments endpoint carries no resolved state — that lives on
 * GraphQL review threads. Map each thread's FIRST comment's databaseId (the
 * thread root — `comments(first: 1)`, ordered oldest-first, same as the REST
 * root a reply's `in_reply_to_id` points at) to the thread's `isResolved` and
 * node id (the latter is what a resolve/unresolve mutation needs — see
 * `resolveThread`).
 *
 * This used to fetch `comments(first: 100)` per thread and key the map by
 * every comment's own id — so a thread with more than 100 comments silently
 * lost `resolved`/`resolveId` on everything past #100. Keying by the root
 * alone fixes that for threads of any size: `listExistingComments` looks
 * this map up by each REST comment's `threadId` (its root's id, which every
 * reply already carries via `in_reply_to_id`), not by the comment's own id,
 * so one root lookup covers a reply no matter how deep in the thread it is.
 */
async function fetchResolvedById(ctx: PrContext): Promise<Map<string, ThreadInfo>> {
  const runner = getCliRunner();
  const env = ghEnvForHost(ctx.host);
  const query = `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;
  const resolvedById = new Map<string, ThreadInfo>();
  let cursor: string | null = null;
  // Page cap so a misbehaving pageInfo can never loop forever (100 threads/page).
  for (let page = 0; page < 20; page++) {
    // `-f` (raw string) for owner/repo/endCursor — all `String` in the query
    // above. `-F` would sniff a purely-numeric repo name (legal on GitHub)
    // into an integer, silently breaking this lookup for that repo; `pr` is
    // a genuine `Int!`, so it keeps `-F`.
    const args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${ctx.owner}`,
      "-f", `repo=${ctx.repo}`,
      "-F", `pr=${ctx.prNumber}`,
    ];
    if (cursor) args.push("-f", `endCursor=${cursor}`);
    const res = await runner(GH, args, { cwd: ctx.repoRoot, env });
    if (res.code !== 0) {
      throw new Error(`gh api graphql failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const threads = parseReviewThreadsPage(res.stdout);
    for (const t of threads.nodes) {
      for (const id of t.commentIds) resolvedById.set(id, { resolved: t.isResolved, threadId: t.id });
    }
    if (!threads.hasNextPage || !threads.endCursor) break;
    cursor = threads.endCursor;
  }
  return resolvedById;
}
