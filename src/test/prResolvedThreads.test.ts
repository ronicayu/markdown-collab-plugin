import { afterEach, describe, expect, it } from "vitest";
import { getCliRunner, setCliRunner, type RunCliResult } from "../pr/cli";
import { githubPlatform, parseReviewThreadsPage } from "../pr/platforms/github";
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

function threadsPage(
  nodes: { id?: string; isResolved: boolean; ids: number[] }[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo,
            nodes: nodes.map((n, i) => ({
              id: n.id ?? `PRRT_${i}`,
              isResolved: n.isResolved,
              comments: { nodes: n.ids.map((databaseId) => ({ databaseId })) },
            })),
          },
        },
      },
    },
  });
}

function restComment(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user: { login: "alice" },
    body: `comment ${id}`,
    path: "docs/a.md",
    line: 3,
    side: "RIGHT",
    created_at: "2026-07-01T00:00:00Z",
    html_url: `https://github.com/o/r/pull/7#discussion_r${id}`,
    ...over,
  };
}

describe("parseReviewThreadsPage", () => {
  it("extracts the thread id, isResolved, and stringified comment ids", () => {
    const page = parseReviewThreadsPage(threadsPage([
      { id: "PRRT_kwABC", isResolved: true, ids: [11, 12] },
      { id: "PRRT_kwXYZ", isResolved: false, ids: [20] },
    ]));
    expect(page.nodes).toEqual([
      { id: "PRRT_kwABC", isResolved: true, commentIds: ["11", "12"] },
      { id: "PRRT_kwXYZ", isResolved: false, commentIds: ["20"] },
    ]);
    expect(page.hasNextPage).toBe(false);
    expect(page.endCursor).toBeNull();
  });

  it("carries pagination info", () => {
    const page = parseReviewThreadsPage(
      threadsPage([{ isResolved: false, ids: [1] }], { hasNextPage: true, endCursor: "abc" }),
    );
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("abc");
  });

  it("tolerates missing/null fields", () => {
    expect(parseReviewThreadsPage("{}")).toEqual({ nodes: [], hasNextPage: false, endCursor: null });
    const sparse = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ comments: { nodes: [{ databaseId: null }, {}] } }, {}],
      } } } },
    });
    expect(parseReviewThreadsPage(sparse).nodes).toEqual([
      { id: "", isResolved: false, commentIds: [] },
      { id: "", isResolved: false, commentIds: [] },
    ]);
  });
});

describe("githubPlatform.listExistingComments resolved enrichment", () => {
  it("marks comments resolved from their review thread", async () => {
    setCliRunner(async (_bin, args) => {
      if (args.includes("graphql")) {
        return {
          code: 0,
          stdout: threadsPage([
            { id: "PRRT_thread1", isResolved: true, ids: [11, 12] },
            { id: "PRRT_thread2", isResolved: false, ids: [20] },
          ]),
          stderr: "",
        } as RunCliResult;
      }
      return {
        code: 0,
        stdout: JSON.stringify([
          restComment(11),
          restComment(12, { in_reply_to_id: 11 }),
          restComment(20),
        ]),
        stderr: "",
      } as RunCliResult;
    });
    const out = await githubPlatform.listExistingComments(ctx());
    expect(out.map((c) => [c.id, c.resolved])).toEqual([
      ["11", true],
      ["12", true],
      ["20", false],
    ]);
    // Every comment in a thread carries that thread's own GraphQL node id —
    // the `resolveId` a resolve/unresolve mutation needs — not the REST
    // comment id already carried in `threadId`.
    expect(out.map((c) => [c.id, c.resolvable, c.resolveId])).toEqual([
      ["11", true, "PRRT_thread1"],
      ["12", true, "PRRT_thread1"],
      ["20", true, "PRRT_thread2"],
    ]);
  });

  it("follows pagination across thread pages", async () => {
    const cursors: (string | undefined)[] = [];
    setCliRunner(async (_bin, args) => {
      if (args.includes("graphql")) {
        const cursorArg = args.find((a) => a.startsWith("endCursor="));
        cursors.push(cursorArg?.slice("endCursor=".length));
        return {
          code: 0,
          stdout: cursorArg
            ? threadsPage([{ isResolved: false, ids: [20] }])
            : threadsPage([{ isResolved: true, ids: [11] }], { hasNextPage: true, endCursor: "c1" }),
          stderr: "",
        } as RunCliResult;
      }
      return {
        code: 0,
        stdout: JSON.stringify([restComment(11), restComment(20)]),
        stderr: "",
      } as RunCliResult;
    });
    const out = await githubPlatform.listExistingComments(ctx());
    expect(cursors).toEqual([undefined, "c1"]);
    expect(out.map((c) => [c.id, c.resolved])).toEqual([["11", true], ["20", false]]);
  });

  it("leaves resolved unset when the GraphQL call fails", async () => {
    setCliRunner(async (_bin, args) => {
      if (args.includes("graphql")) {
        return { code: 1, stdout: "", stderr: "GraphQL: FORBIDDEN" } as RunCliResult;
      }
      return { code: 0, stdout: JSON.stringify([restComment(11)]), stderr: "" } as RunCliResult;
    });
    const out = await githubPlatform.listExistingComments(ctx());
    expect(out).toHaveLength(1);
    expect(out[0].resolved).toBeUndefined();
    expect(out[0].resolvable).toBeUndefined();
    expect(out[0].resolveId).toBeUndefined();
  });
});
