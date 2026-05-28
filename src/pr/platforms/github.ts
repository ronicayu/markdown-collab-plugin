/**
 * GitHub PR review via the `gh` CLI. We shell `gh api …` rather than
 * `gh pr review` because the high-level command doesn't expose
 * line-anchored comments — only an overall review body. The REST shape
 * lives in https://docs.github.com/en/rest/pulls/reviews .
 */

import { getCliRunner } from "../cli";
import { mergeBaseSha, parseRemoteUrl } from "../diff";
import type { PrPlatform } from "../types";

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
};
