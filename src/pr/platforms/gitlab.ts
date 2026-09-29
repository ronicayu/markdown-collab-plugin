/**
 * GitLab MR review via `glab`. There is no batch endpoint for inline
 * discussions — each comment is its own POST to /discussions with a
 * `position` payload. The verdict maps as:
 *   - "comment"           → just post the inline discussions
 *   - "approve"           → POST /approve after the inline notes
 *   - "request-changes"   → POST a body-only note (GitLab has no native
 *                           "request changes" outside approval rules)
 */

import { getCliRunner, getLogger } from "../cli";
import { mergeBaseSha, parseRemoteUrl } from "../diff";
import type { ExistingPrComment, PrContext, PrPlatform } from "../types";

const GLAB = "glab";

/**
 * GitLab discussion id — a SHA1 hex digest. What `replyToComment`'s
 * `threadId` and `resolveThread`'s `resolveId` accept, and what both splice
 * straight into a REST path segment. Checked before either does, so a value
 * like `../x` (path traversal) or `?resolved=false` (query-string injection)
 * never reaches a URL, and `encodeURIComponent` below is a second layer, not
 * the only one.
 */
const DISCUSSION_ID_RE = /^[0-9a-f]{40}$/;

function assertDiscussionId(id: string, what: string): void {
  if (!DISCUSSION_ID_RE.test(id)) {
    throw new Error(`Refusing to send ${what} to GitLab: "${id.slice(0, 40)}" isn't a discussion id.`);
  }
}

function glabEnvForHost(host: string): Record<string, string | undefined> | undefined {
  if (host === "gitlab.com") return undefined;
  return { GITLAB_HOST: host };
}

/**
 * GitLab rejects a `position` whose SHAs it doesn't recognize, and the raw
 * error ("400 Bad Request") says nothing a user can act on. By far the most
 * common cause is reviewing a branch with unpushed commits: the line being
 * commented on exists locally but not in the MR's diff. Say that.
 *
 * Exported for tests — the wording is the whole point of it.
 */
export function positionFailureMessage(
  ctx: PrContext,
  path: string,
  line: number,
  detail: string,
): string {
  const unpushed = ctx.localHeadSha !== undefined && ctx.localHeadSha !== ctx.headSha;
  const hint = unpushed
    ? ` This branch has commits that aren't pushed — ${path}:${line} may not exist in the MR diff yet. Push the branch and refresh the review, then submit again.`
    : ` Check that ${path}:${line} is part of the MR's diff against ${ctx.baseRef}.`;
  return `GitLab rejected the comment on ${path}:${line}.${hint} (glab: ${detail})`;
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
        throw new Error(positionFailureMessage(ctx, c.path, c.line, res.stderr.trim() || res.stdout.trim()));
      }
      // Verify the server actually anchored the note. GitLab returns the
      // discussion JSON; if `notes[0].position` is null the comment posted
      // as an unanchored MR note instead of a diff thread.
      //
      // The parse and the check are kept apart on purpose: they used to share
      // a try block, so the "not anchored" error was caught by its own catch
      // and rewritten into the generic parse failure unless its wording
      // happened to match a string test.
      let anchored: boolean;
      try {
        const body = JSON.parse(res.stdout) as { notes?: Array<{ position?: unknown }> };
        anchored = Boolean(body.notes?.[0]?.position);
      } catch {
        throw new Error(
          `glab api discussion: unexpected response for ${c.path}:${c.line}: ${res.stdout.slice(0, 400)}`,
        );
      }
      if (!anchored) {
        throw new Error(
          positionFailureMessage(
            ctx,
            c.path,
            c.line,
            `accepted the note but did not anchor it to the diff — ${res.stdout.slice(0, 200)}`,
          ),
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

  async replyToComment(ctx, threadId, body) {
    const runner = getCliRunner();
    const env = glabEnvForHost(ctx.host);
    if (!ctx.projectId) throw new Error("GitLab context missing projectId");
    // `threadId` is the discussion id; POST a note to add a reply to it.
    assertDiscussionId(threadId, "a discussion id");
    const res = await runner(
      GLAB,
      [
        "api",
        `projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/discussions/${encodeURIComponent(threadId)}/notes`,
        "--method",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
      ],
      { cwd: ctx.repoRoot, env, stdin: JSON.stringify({ body }) },
    );
    if (res.code !== 0) {
      throw new Error(`glab api reply failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const parsed = JSON.parse(res.stdout) as { id?: number };
    return { url: parsed.id ? `${ctx.prUrl}#note_${parsed.id}` : ctx.prUrl };
  },

  async resolveThread(ctx, resolveId, resolved) {
    const runner = getCliRunner();
    const env = glabEnvForHost(ctx.host);
    if (!ctx.projectId) throw new Error("GitLab context missing projectId");
    assertDiscussionId(resolveId, "a discussion id");
    // `resolved` goes two ways at once: the query-string form GitLab's docs
    // lead with, AND the JSON body (same idiom as the discussions/notes
    // POSTs above — Grape accepts `resolved` as a body field too). Belt and
    // suspenders: a `glab`/GitLab combination that only honors one of the two
    // still gets it.
    const path = `projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/discussions/${encodeURIComponent(resolveId)}`;
    const res = await runner(
      GLAB,
      [
        "api",
        `${path}?resolved=${resolved}`,
        "--method",
        "PUT",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
      ],
      { cwd: ctx.repoRoot, env, stdin: JSON.stringify({ resolved }) },
    );
    if (res.code !== 0) {
      throw new Error(`glab api discussion resolve failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    // Exit 0 isn't proof — GitLab returns the updated Discussion object
    // (`{ id, notes: [{ ..., resolved }, ...] }`), and a malformed or
    // unexpected body (e.g. `{}`) used to read as success just because the
    // process exited clean. Require the response to actually confirm the
    // state we asked for before calling this a success.
    let body: { notes?: Array<{ resolved?: boolean }>; resolved?: boolean };
    try {
      body = JSON.parse(res.stdout) as typeof body;
    } catch {
      throw new Error(
        `glab api discussion resolve: unexpected response — could not confirm the discussion is now ` +
          `${resolved ? "resolved" : "unresolved"}: ${res.stdout.slice(0, 200)}`,
      );
    }
    const confirmed = body.notes && body.notes.length > 0
      ? body.notes.every((n) => n.resolved === resolved)
      : body.resolved === resolved;
    if (!confirmed) {
      throw new Error(
        `glab api discussion resolve: GitLab did not confirm the discussion is now ` +
          `${resolved ? "resolved" : "unresolved"} (${res.stdout.slice(0, 200)})`,
      );
    }
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
      /** False (or absent) for a discussion GitLab won't let anyone resolve
       * — a plain, non-diff note landing here would be one, though today's
       * `position` filter below already excludes those. */
      resolvable?: boolean;
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
    let parseFailures = 0;
    try {
      discussions.push(...(JSON.parse(raw) as GlabDiscussion[]));
    } catch {
      const pages = raw.split(/\]\s*\[/g).map((p, i, arr) => {
        if (arr.length === 1) return p;
        if (i === 0) return `${p}]`;
        if (i === arr.length - 1) return `[${p}`;
        return `[${p}]`;
      });
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        try {
          discussions.push(...(JSON.parse(page) as GlabDiscussion[]));
        } catch {
          // Page didn't parse — skip rather than fail the whole load, but
          // say so (see the matching comment in github.ts's listExistingComments).
          parseFailures++;
          getLogger()?.warn("glab api discussions: page failed to parse, skipping it", {
            page: i + 1,
            of: pages.length,
            bytes: page.length,
            preview: page.slice(0, 80),
          });
        }
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
          resolvable: n.resolvable === true,
          resolveId: n.resolvable === true ? d.id : undefined,
        });
      }
    }
    if (parseFailures > 0) {
      // See the matching property in github.ts's listExistingComments —
      // same one-time-notice contract, carried the same way.
      (out as ExistingPrComment[] & { partialLoadWarning?: string }).partialLoadWarning =
        `${parseFailures} page${parseFailures === 1 ? "" : "s"} of MR discussions failed to parse.`;
    }
    return out;
  },
};
