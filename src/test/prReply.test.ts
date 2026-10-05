import { afterEach, describe, expect, it } from "vitest";
import { getCliRunner, setCliRunner, type RunCliResult } from "../pr/cli";
import { githubPlatform } from "../pr/platforms/github";
import { gitlabPlatform } from "../pr/platforms/gitlab";
import type { PrContext } from "../pr/types";

const realRunner = getCliRunner();
afterEach(() => setCliRunner(realRunner));

function ctx(overrides: Partial<PrContext> = {}): PrContext {
  return {
    platform: "github",
    remoteUrl: "git@github.com:o/r.git",
    repoRoot: "/repo",
    baseSha: "b",
    headSha: "h",
    baseRef: "main",
    prNumber: 7,
    prUrl: "https://github.com/o/r/pull/7",
    owner: "o",
    repo: "r",
    host: "github.com",
    ...overrides,
  };
}

describe("githubPlatform.replyToComment", () => {
  it("POSTs to the comment's replies endpoint and returns the reply url", async () => {
    const calls: { bin: string; args: string[]; stdin?: string }[] = [];
    setCliRunner(async (bin, args, opts) => {
      calls.push({ bin, args, stdin: opts?.stdin });
      return {
        code: 0,
        stdout: JSON.stringify({ html_url: "https://github.com/o/r/pull/7#discussion_r99" }),
        stderr: "",
      } as RunCliResult;
    });
    const res = await githubPlatform.replyToComment(ctx(), "12345", "looks good");
    expect(res.url).toBe("https://github.com/o/r/pull/7#discussion_r99");
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("gh");
    expect(calls[0].args).toContain("repos/o/r/pulls/7/comments/12345/replies");
    expect(calls[0].args).toContain("POST");
    expect(JSON.parse(calls[0].stdin!)).toEqual({ body: "looks good" });
  });

  it("falls back to the PR url when the API response has no html_url", async () => {
    setCliRunner(async () => ({ code: 0, stdout: "{}", stderr: "" }) as RunCliResult);
    const res = await githubPlatform.replyToComment(ctx(), "1", "x");
    expect(res.url).toBe("https://github.com/o/r/pull/7");
  });

  it("throws when gh exits non-zero", async () => {
    setCliRunner(async () => ({ code: 1, stdout: "", stderr: "boom" }) as RunCliResult);
    await expect(githubPlatform.replyToComment(ctx(), "1", "x")).rejects.toThrow(/reply failed/);
  });

  it("refuses an @/etc/passwd-shaped id before any spawn", async () => {
    const calls: unknown[] = [];
    setCliRunner(async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "{}", stderr: "" } as RunCliResult;
    });
    // A REST comment id is always a positive integer; `gh api -F` also reads
    // a leading `@` as "read this path and send its contents" — either
    // reason is enough to refuse it before `gh` ever runs.
    await expect(githubPlatform.replyToComment(ctx(), "@/etc/passwd", "hi")).rejects.toThrow(
      /doesn't look like one/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("gitlabPlatform.replyToComment", () => {
  const glabCtx = (o: Partial<PrContext> = {}) =>
    ctx({
      platform: "gitlab",
      host: "gitlab.com",
      projectId: "o%2Fr",
      prUrl: "https://gitlab.com/o/r/-/merge_requests/7",
      ...o,
    });

  /** A realistic-shaped GitLab discussion id — 40 hex chars, like a SHA1. */
  const DISC_ID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  it("POSTs a note to the discussion and builds the note url", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    setCliRunner(async (_bin, args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      return { code: 0, stdout: JSON.stringify({ id: 555 }), stderr: "" } as RunCliResult;
    });
    const res = await gitlabPlatform.replyToComment(glabCtx(), DISC_ID, "thanks");
    expect(res.url).toBe("https://gitlab.com/o/r/-/merge_requests/7#note_555");
    expect(calls[0].args).toContain(
      `projects/o%2Fr/merge_requests/7/discussions/${DISC_ID}/notes`,
    );
    expect(calls[0].args).toContain("POST");
    expect(JSON.parse(calls[0].stdin!)).toEqual({ body: "thanks" });
  });

  it("throws when projectId is missing", async () => {
    await expect(
      gitlabPlatform.replyToComment(glabCtx({ projectId: undefined }), "d", "x"),
    ).rejects.toThrow(/projectId/);
  });

  it("throws when glab exits non-zero", async () => {
    setCliRunner(async () => ({ code: 1, stdout: "", stderr: "nope" }) as RunCliResult);
    await expect(gitlabPlatform.replyToComment(glabCtx(), DISC_ID, "x")).rejects.toThrow(
      /reply failed/,
    );
  });

  it("refuses a ../x id before any spawn", async () => {
    const calls: unknown[] = [];
    setCliRunner(async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "{}", stderr: "" } as RunCliResult;
    });
    await expect(gitlabPlatform.replyToComment(glabCtx(), "../x", "hi")).rejects.toThrow(
      /isn't a discussion id/,
    );
    expect(calls).toHaveLength(0);
  });
});
