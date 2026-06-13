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

  it("POSTs a note to the discussion and builds the note url", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    setCliRunner(async (_bin, args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      return { code: 0, stdout: JSON.stringify({ id: 555 }), stderr: "" } as RunCliResult;
    });
    const res = await gitlabPlatform.replyToComment(glabCtx(), "disc99", "thanks");
    expect(res.url).toBe("https://gitlab.com/o/r/-/merge_requests/7#note_555");
    expect(calls[0].args).toContain(
      "projects/o%2Fr/merge_requests/7/discussions/disc99/notes",
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
    await expect(gitlabPlatform.replyToComment(glabCtx(), "d", "x")).rejects.toThrow(
      /reply failed/,
    );
  });
});
