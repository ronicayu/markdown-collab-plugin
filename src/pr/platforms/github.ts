/**
 * GitHub PR review via the `gh` CLI. We shell `gh api …` rather than
 * `gh pr review` because the high-level command doesn't expose
 * line-anchored comments — only an overall review body. The REST shape
 * lives in https://docs.github.com/en/rest/pulls/reviews .
 */

import { getCliRunner } from "../cli";
import { mergeBaseSha, parseRemoteUrl } from "../diff";
import type { ExistingPrComment, PrPlatform } from "../types";

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
    return out;
  },
};
