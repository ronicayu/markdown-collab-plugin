/**
 * GitLab MR review via `glab`. There is no batch endpoint for inline
 * discussions — each comment is its own POST to /discussions with a
 * `position` payload. The verdict maps as:
 *   - "comment"           → just post the inline discussions
 *   - "approve"           → POST /approve after the inline notes
 *   - "request-changes"   → POST a body-only note (GitLab has no native
 *                           "request changes" outside approval rules)
 */

import { getCliRunner } from "../cli";
import { mergeBaseSha, parseRemoteUrl } from "../diff";
import type { PrPlatform } from "../types";

const GLAB = "glab";

function glabEnvForHost(host: string): Record<string, string | undefined> | undefined {
  if (host === "gitlab.com") return undefined;
  return { GITLAB_HOST: host };
}

export const gitlabPlatform: PrPlatform = {
  name: "gitlab",

  async ensureReady(host) {
    const runner = getCliRunner();
    const env = glabEnvForHost(host);
    const which = await runner("sh", ["-c", `command -v ${GLAB} >/dev/null && echo ok || echo missing`], {});
    if (which.code !== 0 || which.stdout.trim() !== "ok") {
      return {
        ok: false,
        reason: "GitLab CLI (`glab`) not found. Install it from https://gitlab.com/gitlab-org/cli.",
      };
    }
    const auth = await runner(GLAB, ["auth", "status", "--hostname", host], { env });
    if (auth.code !== 0) {
      return {
        ok: false,
        reason: `glab is not authenticated for ${host}. Run: glab auth login --hostname ${host}`,
      };
    }
    return { ok: true };
  },

  async loadContext(repoRoot, remoteUrl, host) {
    const runner = getCliRunner();
    const env = glabEnvForHost(host);
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed) throw new Error(`Could not parse remote URL: ${remoteUrl}`);
    const view = await runner(GLAB, ["mr", "view", "-F", "json"], { cwd: repoRoot, env });
    if (view.code !== 0) {
      throw new Error(
        view.stderr.includes("no open merge request")
          ? "No open merge request found for the current branch. Push the branch and open an MR, then re-run."
          : `glab mr view failed: ${view.stderr.trim()}`,
      );
    }
    const data = JSON.parse(view.stdout) as {
      iid: number;
      target_branch: string;
      sha: string;
      web_url: string;
      diff_refs?: { base_sha: string; head_sha: string; start_sha: string };
    };
    const baseRef = data.target_branch;
    const baseSha = data.diff_refs?.base_sha ?? (await mergeBaseSha(repoRoot, `origin/${baseRef}`, runner));
    const headSha = data.diff_refs?.head_sha ?? data.sha;
    const startSha = data.diff_refs?.start_sha ?? baseSha;
    return {
      platform: "gitlab",
      remoteUrl,
      repoRoot,
      baseSha,
      headSha,
      baseRef,
      prNumber: data.iid,
      projectId: encodeURIComponent(`${parsed.owner}/${parsed.repo}`),
      startSha,
      prUrl: data.web_url,
      owner: parsed.owner,
      repo: parsed.repo,
      host,
    };
  },

  async submitReview(ctx, input) {
    const runner = getCliRunner();
    const env = glabEnvForHost(ctx.host);
    if (!ctx.projectId) throw new Error("GitLab context missing projectId");
    const baseEndpoint = `projects/${ctx.projectId}/merge_requests/${ctx.prNumber}`;

    // GitLab's /discussions endpoint expects form-encoded data, NOT JSON.
    // Send each field via glab's `-f key=value` so glab generates the
    // right Content-Type. Nested `position` uses bracket notation per
    // GitLab's standard for form-encoded objects.
    for (const c of input.comments) {
      const fields = [
        `body=${c.body}`,
        `position[base_sha]=${ctx.baseSha}`,
        `position[start_sha]=${ctx.startSha ?? ctx.baseSha}`,
        `position[head_sha]=${ctx.headSha}`,
        `position[position_type]=text`,
        `position[new_path]=${c.path}`,
        `position[old_path]=${c.path}`,
        `position[new_line]=${c.line}`,
      ];
      const args = ["api", `${baseEndpoint}/discussions`, "--method", "POST"];
      for (const f of fields) args.push("-f", f);
      const res = await runner(GLAB, args, { cwd: ctx.repoRoot, env });
      if (res.code !== 0) {
        throw new Error(
          `glab api discussion failed on ${c.path}:${c.line}: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
    }

    if (input.body && input.body.trim()) {
      const res = await runner(
        GLAB,
        ["api", `${baseEndpoint}/notes`, "--method", "POST", "-f", `body=${input.body}`],
        { cwd: ctx.repoRoot, env },
      );
      if (res.code !== 0) {
        throw new Error(`glab api note failed: ${res.stderr.trim()}`);
      }
    }

    if (input.verdict === "approve") {
      const res = await runner(
        GLAB,
        ["api", `${baseEndpoint}/approve`, "--method", "POST"],
        { cwd: ctx.repoRoot, env },
      );
      if (res.code !== 0) {
        throw new Error(`glab api approve failed: ${res.stderr.trim()}`);
      }
    } else if (input.verdict === "request-changes" && !(input.body && input.body.trim())) {
      // Make sure a "request-changes" verdict leaves a visible signal even
      // if the user didn't supply a top-level body.
      const res = await runner(
        GLAB,
        [
          "api",
          `${baseEndpoint}/notes`,
          "--method",
          "POST",
          "-f",
          "body=Requesting changes (see inline comments).",
        ],
        { cwd: ctx.repoRoot, env },
      );
      if (res.code !== 0) {
        throw new Error(`glab api note (request-changes) failed: ${res.stderr.trim()}`);
      }
    }

    return { url: ctx.prUrl };
  },
};
