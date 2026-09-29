// Resolve/unresolve a PR review thread or MR discussion — the request each
// platform issues, and (for GitLab) the `resolvable`/`resolveId` fields
// `listExistingComments` attaches so the webview knows when to offer the
// action at all. GitHub's own enrichment (from the `reviewThreads` GraphQL
// query) is covered in prResolvedThreads.test.ts alongside the rest of that
// fetch; this file is the mutation/PUT side plus GitLab's parallel fetch.
//
// Also covers the id-format hardening added alongside this: `gh api -F`
// coerces its value into a number/boolean/`@file` before sending it, so a
// GraphQL node id has to go through `-f` instead, and GitLab's discussion id
// lands directly in a REST path segment, so it has to look like one before
// it ever gets there.

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

/** A realistic-shaped GitLab discussion id — 40 hex chars, like a SHA1. */
const DISC_ID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

/** A GitLab "resolve" response that confirms the discussion landed at `resolved`. */
function resolvedResponse(resolved: boolean): RunCliResult {
  return {
    code: 0,
    stdout: JSON.stringify({ id: DISC_ID, notes: [{ id: 1, resolved }] }),
    stderr: "",
  };
}

describe("githubPlatform.resolveThread", () => {
  it("issues the resolveReviewThread mutation with the thread node id, via -f (not -F)", async () => {
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
    // `-f`, not `-F`: threadId is a GraphQL `ID!` (a string), and `-F` would
    // sniff it into a number/boolean/`@file` before sending it.
    expect(calls[0].args).toEqual(["api", "graphql", "-f", expect.stringContaining("resolveReviewThread"), "-f", "threadId=PRRT_x"]);
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

  it("refuses an @/etc/passwd-shaped id before any spawn", async () => {
    const calls: unknown[] = [];
    setCliRunner(async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "{}", stderr: "" } as RunCliResult;
    });
    await expect(githubPlatform.resolveThread(ctx(), "@/etc/passwd", true)).rejects.toThrow(
      /doesn't look like one/,
    );
    // The whole point of validating up front: `gh api -F` reads a value
    // starting with `@` as a file path and would have sent its contents.
    expect(calls).toHaveLength(0);
  });

  it("refuses an id with shell/path metacharacters before any spawn", async () => {
    const calls: unknown[] = [];
    setCliRunner(async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "{}", stderr: "" } as RunCliResult;
    });
    await expect(githubPlatform.resolveThread(ctx(), "../x", true)).rejects.toThrow(/doesn't look like one/);
    expect(calls).toHaveLength(0);
  });
});

describe("gitlabPlatform.resolveThread", () => {
  it("PUTs the discussion with a JSON resolved:true body and ?resolved=true in the path", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    setCliRunner(async (_bin, args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      return resolvedResponse(true);
    });
    await gitlabPlatform.resolveThread(glabCtx(), DISC_ID, true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain(`projects/o%2Fr/merge_requests/7/discussions/${DISC_ID}?resolved=true`);
    expect(calls[0].args).toContain("PUT");
    expect(JSON.parse(calls[0].stdin!)).toEqual({ resolved: true });
  });

  it("PUTs resolved:false when unresolving", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    setCliRunner(async (_bin, args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      return resolvedResponse(false);
    });
    await gitlabPlatform.resolveThread(glabCtx(), DISC_ID, false);
    expect(calls[0].args).toContain(`projects/o%2Fr/merge_requests/7/discussions/${DISC_ID}?resolved=false`);
    expect(JSON.parse(calls[0].stdin!)).toEqual({ resolved: false });
  });

  it("throws when projectId is missing", async () => {
    await expect(
      gitlabPlatform.resolveThread(glabCtx({ projectId: undefined }), DISC_ID, true),
    ).rejects.toThrow(/projectId/);
  });

  it("throws when glab exits non-zero", async () => {
    setCliRunner(async () => ({ code: 1, stdout: "", stderr: "404 Not Found" }) as RunCliResult);
    await expect(gitlabPlatform.resolveThread(glabCtx(), DISC_ID, true)).rejects.toThrow(
      /discussion resolve failed/,
    );
  });

  it("refuses a ../x id before any spawn", async () => {
    const calls: unknown[] = [];
    setCliRunner(async (...args) => {
      calls.push(args);
      return resolvedResponse(true);
    });
    await expect(gitlabPlatform.resolveThread(glabCtx(), "../x", true)).rejects.toThrow(/isn't a discussion id/);
    // The whole point: a path-traversal-shaped id must never reach the URL
    // glab is told to PUT to.
    expect(calls).toHaveLength(0);
  });

  it("refuses a query-string-injection-shaped id (?resolved=false) before any spawn", async () => {
    const calls: unknown[] = [];
    setCliRunner(async (...args) => {
      calls.push(args);
      return resolvedResponse(true);
    });
    await expect(
      gitlabPlatform.resolveThread(glabCtx(), `${DISC_ID}?resolved=false`, true),
    ).rejects.toThrow(/isn't a discussion id/);
    expect(calls).toHaveLength(0);
  });

  it("treats exit 0 with a response that doesn't confirm the resolved state as a failure", async () => {
    // This is the bug: the old code only checked `res.code`, so a stub (or a
    // proxy, or a future glab bug) returning `{}` on success used to pass.
    setCliRunner(async () => ({ code: 0, stdout: "{}", stderr: "" }) as RunCliResult);
    await expect(gitlabPlatform.resolveThread(glabCtx(), DISC_ID, true)).rejects.toThrow(
      /did not confirm/,
    );
  });

  it("treats a response confirming the opposite state as a failure", async () => {
    setCliRunner(async () => resolvedResponse(false));
    await expect(gitlabPlatform.resolveThread(glabCtx(), DISC_ID, true)).rejects.toThrow(
      /did not confirm/,
    );
  });

  it("treats an unparseable response body as a failure with a clear message", async () => {
    setCliRunner(async () => ({ code: 0, stdout: "<html>gateway timeout</html>", stderr: "" }) as RunCliResult);
    await expect(gitlabPlatform.resolveThread(glabCtx(), DISC_ID, true)).rejects.toThrow(
      /unexpected response/,
    );
  });

  it("confirms via the discussion-level resolved field when notes is absent", async () => {
    setCliRunner(async () => ({
      code: 0,
      stdout: JSON.stringify({ id: DISC_ID, resolved: true }),
      stderr: "",
    }) as RunCliResult);
    await expect(gitlabPlatform.resolveThread(glabCtx(), DISC_ID, true)).resolves.toBeUndefined();
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
