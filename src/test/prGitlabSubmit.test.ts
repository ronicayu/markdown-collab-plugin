// GitLab MR submit — the payload that goes over the wire.
//
// Submitting drafts to GitLab failed because `position[head_sha]` carried the
// *local* HEAD: the PR controller overwrote `ctx.headSha` with `git rev-parse
// HEAD` at session start, and GitLab rejects (or silently fails to anchor) a
// position whose SHAs it has never seen. GitHub's payload has the same field
// (`commit_id`), so both platforms are asserted here against a context where
// the local checkout is ahead of the pushed head.

import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getCliRunner, setCliRunner, type RunCliResult } from "../pr/cli";
import { githubPlatform } from "../pr/platforms/github";
import { gitlabPlatform, positionFailureMessage } from "../pr/platforms/gitlab";
import type { PrComment, PrContext } from "../pr/types";

const realRunner = getCliRunner();
afterEach(() => setCliRunner(realRunner));

/** An MR context whose working copy sits two commits ahead of the pushed head. */
function mrCtx(o: Partial<PrContext> = {}): PrContext {
  return {
    platform: "gitlab",
    remoteUrl: "git@gitlab.com:o/r.git",
    repoRoot: "/repo",
    baseSha: "base111",
    headSha: "pushedhead222",
    localHeadSha: "localonly333",
    startSha: "start444",
    baseRef: "main",
    prNumber: 7,
    projectId: "o%2Fr",
    prUrl: "https://gitlab.com/o/r/-/merge_requests/7",
    owner: "o",
    repo: "r",
    host: "gitlab.com",
    ...o,
  };
}

const comment: PrComment = { path: "docs/a.md", body: "nit: wording", line: 12, side: "RIGHT" };

/** A GitLab discussion response that reports the note as anchored. */
const anchoredOk: RunCliResult = {
  code: 0,
  stdout: JSON.stringify({ notes: [{ id: 1, position: { new_line: 12 } }] }),
  stderr: "",
};

function captureRunner(result: RunCliResult = anchoredOk): {
  calls: Array<{ bin: string; args: string[]; stdin?: string }>;
} {
  const calls: Array<{ bin: string; args: string[]; stdin?: string }> = [];
  setCliRunner(async (bin, args, opts) => {
    calls.push({ bin, args, stdin: opts?.stdin });
    return result;
  });
  return { calls };
}

describe("gitlabPlatform.submitReview position payload", () => {
  it("posts the SHAs GitLab knows, never the local-only HEAD", async () => {
    const { calls } = captureRunner();
    await gitlabPlatform.submitReview(mrCtx(), { verdict: "comment", comments: [comment] });

    const body = JSON.parse(calls[0].stdin!) as { position: Record<string, unknown> };
    expect(body.position.head_sha).toBe("pushedhead222");
    expect(body.position.base_sha).toBe("base111");
    expect(body.position.start_sha).toBe("start444");
    // The regression itself: the local HEAD must appear nowhere in the payload.
    expect(calls[0].stdin).not.toContain("localonly333");
  });

  it("sends one anchored discussion per draft", async () => {
    const { calls } = captureRunner();
    await gitlabPlatform.submitReview(mrCtx(), {
      verdict: "comment",
      comments: [comment, { ...comment, line: 30, body: "second" }],
    });
    const discussions = calls.filter((c) =>
      c.args.includes("projects/o%2Fr/merge_requests/7/discussions"),
    );
    expect(discussions).toHaveLength(2);
    for (const d of discussions) {
      const payload = JSON.parse(d.stdin!) as { position: { position_type: string; new_line: number } };
      expect(payload.position.position_type).toBe("text");
      // Added lines anchor on new_line only — GitLab requires old_line be absent.
      expect(payload.position).not.toHaveProperty("old_line");
      expect(d.args).toContain("--input");
      expect(d.args).toContain("-");
    }
  });

  it("falls back to base_sha when the MR reported no start_sha", async () => {
    const { calls } = captureRunner();
    await gitlabPlatform.submitReview(mrCtx({ startSha: undefined }), {
      verdict: "comment",
      comments: [comment],
    });
    const body = JSON.parse(calls[0].stdin!) as { position: { start_sha: string } };
    expect(body.position.start_sha).toBe("base111");
  });

  it("reports an unanchored note as a failure instead of a silent success", async () => {
    // GitLab answering 200 with `position: null` means the note landed as a
    // general MR comment — the draft did not become a diff thread.
    captureRunner({ code: 0, stdout: JSON.stringify({ notes: [{ id: 1 }] }), stderr: "" });
    await expect(
      gitlabPlatform.submitReview(mrCtx(), { verdict: "comment", comments: [comment] }),
    ).rejects.toThrow(/did not anchor it to the diff/);
  });

  it("keeps the unanchored error rather than rewriting it as a parse failure", async () => {
    // The two used to share a try block, so the anchoring error was caught by
    // its own catch and replaced with "unexpected response".
    captureRunner({ code: 0, stdout: JSON.stringify({ notes: [{ id: 1 }] }), stderr: "" });
    await expect(
      gitlabPlatform.submitReview(mrCtx(), { verdict: "comment", comments: [comment] }),
    ).rejects.toThrow(/aren't pushed|part of the MR's diff/);
  });

  it("still reports genuinely unparseable output as such", async () => {
    captureRunner({ code: 0, stdout: "<html>gateway timeout</html>", stderr: "" });
    await expect(
      gitlabPlatform.submitReview(mrCtx(), { verdict: "comment", comments: [comment] }),
    ).rejects.toThrow(/unexpected response/);
  });
});

describe("positionFailureMessage", () => {
  it("blames the unpushed branch when the local head has drifted", () => {
    const msg = positionFailureMessage(mrCtx(), "docs/a.md", 12, "400 Bad Request");
    expect(msg).toContain("aren't pushed");
    expect(msg).toContain("docs/a.md:12");
    expect(msg).toContain("400 Bad Request");
  });

  it("points at the diff when local and pushed heads agree", () => {
    const msg = positionFailureMessage(
      mrCtx({ localHeadSha: "pushedhead222" }),
      "docs/a.md",
      12,
      "400",
    );
    expect(msg).not.toContain("aren't pushed");
    expect(msg).toContain("main");
  });

  it("says nothing about pushing when the local head is unknown", () => {
    const msg = positionFailureMessage(mrCtx({ localHeadSha: undefined }), "a.md", 1, "400");
    expect(msg).not.toContain("aren't pushed");
  });
});

// The platform adapters above are given a correct context. The bug was one
// layer up: the controller reassigned `ctx.headSha = localHead` at session
// start, so by submit time the "platform head" WAS the local head and no
// adapter test could see it. The controller needs a live extension host, so
// the invariant is asserted against its source — the same approach the release
// pipeline tests use for the YAML nobody can run locally.
describe("the PR controller never overwrites the platform's head SHA", () => {
  const controller = readFileSync(
    resolve(__dirname, "../pr/prReviewController.ts"),
    "utf8",
  );

  it("assigns the local HEAD to localHeadSha, not headSha", () => {
    expect(controller).toContain("ctx.localHeadSha = localHead");
    expect(controller).not.toMatch(/ctx\.headSha\s*=/);
  });

  it("still reads the local HEAD, so the divergence is known", () => {
    expect(controller).toContain("readHeadSha(repoRoot)");
  });
});

describe("githubPlatform.submitReview commit_id", () => {
  it("uses the PR head the platform reported, not the local checkout", async () => {
    const { calls } = captureRunner({
      code: 0,
      stdout: JSON.stringify({ html_url: "https://github.com/o/r/pull/7#r1" }),
      stderr: "",
    });
    await githubPlatform.submitReview(
      mrCtx({ platform: "github", host: "github.com", remoteUrl: "git@github.com:o/r.git" }),
      { verdict: "comment", comments: [comment] },
    );
    const body = JSON.parse(calls[0].stdin!) as { commit_id: string };
    expect(body.commit_id).toBe("pushedhead222");
    expect(calls[0].stdin).not.toContain("localonly333");
  });
});
