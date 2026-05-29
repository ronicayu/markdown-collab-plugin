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
import type { ExistingPrComment, PrPlatform } from "../types";

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

    // POST JSON with an explicit `Content-Type: application/json` header.
    // We tried form-encoding with `glab -f position[new_line]=...` in
    // 0.31.1 — that fixed the 415, but glab silently treats the bracket
    // keys as literal flat fields, so the `position` object never lands
    // and the comment posts as a general MR note with no anchor. JSON +
    // explicit Content-Type avoids both problems.
    for (const c of input.comments) {
      const position: Record<string, unknown> = {
        base_sha: ctx.baseSha,
        start_sha: ctx.startSha ?? ctx.baseSha,
        head_sha: ctx.headSha,
        position_type: "text",
        new_path: c.path,
        old_path: c.path,
        new_line: c.line,
      };
      const payload = { body: c.body, position };
      const res = await runner(
        GLAB,
        [
          "api",
          `${baseEndpoint}/discussions`,
          "--method",
          "POST",
          "--header",
          "Content-Type: application/json",
          "--input",
          "-",
        ],
        { cwd: ctx.repoRoot, env, stdin: JSON.stringify(payload) },
      );
      if (res.code !== 0) {
        throw new Error(
          `glab api discussion failed on ${c.path}:${c.line}: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
      // Verify the server actually anchored the note. GitLab returns the
      // discussion JSON; if `notes[0].position` is null the comment posted
      // as an unanchored MR note instead of a diff thread.
      try {
        const body = JSON.parse(res.stdout) as { notes?: Array<{ position?: unknown }> };
        if (!body.notes?.[0]?.position) {
          throw new Error(
            `GitLab accepted the comment on ${c.path}:${c.line} but did not anchor it to the diff (likely a SHA mismatch or out-of-diff line). Raw response: ${res.stdout.slice(0, 400)}`,
          );
        }
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith("GitLab accepted")) throw parseErr;
        // Couldn't parse JSON — bubble up the raw response for the user.
        throw new Error(
          `glab api discussion: unexpected response for ${c.path}:${c.line}: ${res.stdout.slice(0, 400)}`,
        );
      }
    }

    if (input.body && input.body.trim()) {
      const res = await runner(
        GLAB,
        [
          "api",
          `${baseEndpoint}/notes`,
          "--method",
          "POST",
          "--header",
          "Content-Type: application/json",
          "--input",
          "-",
        ],
        { cwd: ctx.repoRoot, env, stdin: JSON.stringify({ body: input.body }) },
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
          "--header",
          "Content-Type: application/json",
          "--input",
          "-",
        ],
        {
          cwd: ctx.repoRoot,
          env,
          stdin: JSON.stringify({ body: "Requesting changes (see inline comments)." }),
        },
      );
      if (res.code !== 0) {
        throw new Error(`glab api note (request-changes) failed: ${res.stderr.trim()}`);
      }
    }

    return { url: ctx.prUrl };
  },

  async listExistingComments(ctx) {
    const runner = getCliRunner();
    const env = glabEnvForHost(ctx.host);
    if (!ctx.projectId) throw new Error("GitLab context missing projectId");
    const res = await runner(
      GLAB,
      [
        "api",
        "--paginate",
        `projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/discussions`,
      ],
      { cwd: ctx.repoRoot, env },
    );
    if (res.code !== 0) {
      throw new Error(`glab api discussions failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    type GlabNote = {
      id: number;
      author?: { username?: string; name?: string };
      body: string;
      created_at: string;
      resolved?: boolean;
      position?: {
        new_path?: string;
        old_path?: string;
        new_line?: number;
        old_line?: number;
      };
    };
    type GlabDiscussion = { id: string; notes: GlabNote[] };
    const raw = res.stdout.trim();
    if (!raw) return [];
    const discussions: GlabDiscussion[] = [];
    try {
      discussions.push(...(JSON.parse(raw) as GlabDiscussion[]));
    } catch {
      const pages = raw.split(/\]\s*\[/g).map((p, i, arr) => {
        if (arr.length === 1) return p;
        if (i === 0) return `${p}]`;
        if (i === arr.length - 1) return `[${p}`;
        return `[${p}]`;
      });
      for (const page of pages) {
        try { discussions.push(...(JSON.parse(page) as GlabDiscussion[])); } catch { /* skip */ }
      }
    }
    const out: ExistingPrComment[] = [];
    for (const d of discussions) {
      for (const n of d.notes ?? []) {
        const pos = n.position;
        if (!pos) continue;
        const line = pos.new_line ?? pos.old_line;
        const path = pos.new_path ?? pos.old_path;
        if (line == null || !path) continue;
        out.push({
          id: String(n.id),
          threadId: d.id,
          author: n.author?.username ?? n.author?.name ?? "unknown",
          body: n.body,
          path,
          line,
          side: pos.new_line != null ? "RIGHT" : "LEFT",
          createdAt: n.created_at,
          url: `${ctx.prUrl}#note_${n.id}`,
          resolved: n.resolved,
        });
      }
    }
    return out;
  },
};
