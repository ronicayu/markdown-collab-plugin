// Resolve/unresolve a PR review thread or MR discussion — the request each
// platform issues, and (for GitLab) the `resolvable`/`resolveId` fields
// `listExistingComments` attaches so the webview knows when to offer the
// action at all. GitHub's own enrichment (from the `reviewThreads` GraphQL
// query) is covered in prResolvedThreads.test.ts alongside the rest of that
// fetch; this file is the mutation/PUT side plus GitLab's parallel fetch.

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

const glabCtx = (o: Partial<PrContext> = {}) =>
  ctx({
    platform: "gitlab",
    host: "gitlab.com",
    projectId: "o%2Fr",
    prUrl: "https://gitlab.com/o/r/-/merge_requests/7",
    ...o,
  });

describe("githubPlatform.resolveThread", () => {
  it("issues the resolveReviewThread mutation with the thread node id", async () => {
    const calls: { args: string[] }[] = [];
    setCliRunner(async (_bin, args) => {
      calls.push({ args });
      return {
        code: 0,
        stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_x", isResolved: true } } } }),
        stderr: "",
      } as RunCliResult;
    });
    await githubPlatform.resolveThread(ctx(), "PRRT_x", true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["api", "graphql", "-f", expect.stringContaining("resolveReviewThread"), "-F", "threadId=PRRT_x"]);
    const query = calls[0].args.find((a) => a.startsWith("query="))!;
    // Exactly "resolveReviewThread", not "unresolveReviewThread" — the two
    // mutation names are substrings of each other, so this has to be a
    // boundary check rather than a plain `.not.toContain`.
    expect(/(?<!un)resolveReviewThread\(input/.test(query)).toBe(true);
  });

  it("issues the unresolveReviewThread mutation when un-resolving", async () => {
    const calls: { args: string[] }[] = [];
    setCliRunner(async (_bin, args) => {
      calls.push({ args });
      return {
        code: 0,
        stdout: JSON.stringify({ data: { unresolveReviewThread: { thread: { id: "PRRT_x", isResolved: false } } } }),
        stderr: "",
      } as RunCliResult;
    });
    await githubPlatform.resolveThread(ctx(), "PRRT_x", false);
    const query = calls[0].args.find((a) => a.startsWith("query="))!;
    expect(query).toContain("unresolveReviewThread(input");
  });

  it("routes through gh api graphql — the same runner every other GitHub call uses", async () => {
    const calls: { bin: string; args: string[] }[] = [];
    setCliRunner(async (bin, args) => {
      calls.push({ bin, args });
      return { code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" } as RunCliResult;
    });
    await githubPlatform.resolveThread(ctx(), "PRRT_x", true);
    expect(calls[0].bin).toBe("gh");
    expect(calls[0].args[0]).toBe("api");
    expect(calls[0].args[1]).toBe("graphql");
  });

  it("throws when gh exits non-zero", async () => {
    setCliRunner(async () => ({ code: 1, stdout: "", stderr: "GraphQL: FORBIDDEN" }) as RunCliResult);
    await expect(githubPlatform.resolveThread(ctx(), "PRRT_x", true)).rejects.toThrow(
      /resolveReviewThread failed/,
    );
  });

  it("names the right mutation in the error when unresolving fails", async () => {
    setCliRunner(async () => ({ code: 1, stdout: "", stderr: "boom" }) as RunCliResult);
    await expect(githubPlatform.resolveThread(ctx(), "PRRT_x", false)).rejects.toThrow(
      /unresolveReviewThread failed/,
    );
  });
});

describe("gitlabPlatform.resolveThread", () => {
  it("PUTs the discussion with a JSON resolved:true body", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    setCliRunner(async (_bin, args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      return { code: 0, stdout: "{}", stderr: "" } as RunCliResult;
    });
    await gitlabPlatform.resolveThread(glabCtx(), "disc99", true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("projects/o%2Fr/merge_requests/7/discussions/disc99");
    expect(calls[0].args).toContain("PUT");
    expect(JSON.parse(calls[0].stdin!)).toEqual({ resolved: true });
  });

  it("PUTs resolved:false when unresolving", async () => {
    const calls: { stdin?: string }[] = [];
    setCliRunner(async (_bin, _args, opts) => {
      calls.push({ stdin: opts?.stdin });
      return { code: 0, stdout: "{}", stderr: "" } as RunCliResult;
    });
    await gitlabPlatform.resolveThread(glabCtx(), "disc99", false);
    expect(JSON.parse(calls[0].stdin!)).toEqual({ resolved: false });
  });

  it("throws when projectId is missing", async () => {
    await expect(
      gitlabPlatform.resolveThread(glabCtx({ projectId: undefined }), "disc99", true),
    ).rejects.toThrow(/projectId/);
  });

  it("throws when glab exits non-zero", async () => {
    setCliRunner(async () => ({ code: 1, stdout: "", stderr: "404 Not Found" }) as RunCliResult);
    await expect(gitlabPlatform.resolveThread(glabCtx(), "disc99", true)).rejects.toThrow(
      /discussion resolve failed/,
    );
  });
});

describe("gitlabPlatform.listExistingComments resolvable/resolveId", () => {
  function discussion(id: string, notes: Record<string, unknown>[]): Record<string, unknown> {
    return { id, notes };
  }
  function note(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      author: { username: "bob" },
      body: `note ${id}`,
      created_at: "2026-07-01T00:00:00Z",
      position: { new_path: "docs/a.md", new_line: 5 },
      ...over,
    };
  }

  it("carries resolvable:true and the discussion id as resolveId", async () => {
    setCliRunner(async () => ({
      code: 0,
      stdout: JSON.stringify([discussion("disc1", [note(1, { resolvable: true, resolved: false })])]),
      stderr: "",
    }) as RunCliResult);
    const out = await gitlabPlatform.listExistingComments(glabCtx());
    expect(out).toEqual([
      expect.objectContaining({ id: "1", threadId: "disc1", resolvable: true, resolveId: "disc1" }),
    ]);
  });

  it("leaves resolvable false and resolveId unset for a non-resolvable discussion", async () => {
    setCliRunner(async () => ({
      code: 0,
      stdout: JSON.stringify([discussion("disc2", [note(2, { resolvable: false })])]),
      stderr: "",
    }) as RunCliResult);
    const out = await gitlabPlatform.listExistingComments(glabCtx());
    expect(out[0].resolvable).toBe(false);
    expect(out[0].resolveId).toBeUndefined();
  });

  it("treats a missing resolvable flag the same as false", async () => {
    setCliRunner(async () => ({
      code: 0,
      stdout: JSON.stringify([discussion("disc3", [note(3)])]),
      stderr: "",
    }) as RunCliResult);
    const out = await gitlabPlatform.listExistingComments(glabCtx());
    expect(out[0].resolvable).toBe(false);
    expect(out[0].resolveId).toBeUndefined();
  });
});
