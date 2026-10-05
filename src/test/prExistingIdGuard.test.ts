/**
 * Security hardening around the reply/resolve targets a PR-review webview
 * can name: `PrReviewController.draftHostApi()` must only ever let a
 * `threadId`/`resolveId` through to a platform adapter (`gh`/`glab`) if it
 * is one the extension itself most recently handed the webview for that
 * exact file, via `getExistingCommentsFor`. This is independent of, and in
 * addition to, the id-*format* checks each platform adapter runs on its own
 * (see prResolveThread.test.ts / prReply.test.ts) — this one is about
 * provenance ("did we ever show this id to the user"), not shape.
 *
 * Also covers the one-time "some comments failed to load" notice
 * (`getExistingComments` in prReviewController.ts), which rides on the same
 * `listExistingComments` return path.
 *
 * `vscode` resolves to the repo's test stub (vitest.config.ts alias) — the
 * pieces the controller's constructor touches (`comments.createCommentController`)
 * are already there. `startPrReview` itself (git/gh bootstrap) is never
 * exercised here: these tests install an `ActiveSession` directly, the same
 * way the controller's own private state is shaped, so the test is about
 * `draftHostApi()`'s guard, not session bootstrap.
 */

import { describe, expect, it } from "vitest";
import { PrReviewController } from "../pr/prReviewController";
import { window } from "./vscode-stub";
import type { ExistingPrComment, PrContext, PrPlatform } from "../pr/types";
import type { Logger } from "../logging";
import type * as vscode from "vscode";

/** A Logger that records nothing — these tests assert behaviour, not logs. */
function makeLogger(): Logger {
  const noop = (): void => {};
  const log: Logger = {
    trace: noop,
    info: noop,
    warn: noop,
    error: noop,
    scope: () => log,
    time: (_l, fn) => fn(),
    show: noop,
  };
  return log;
}

/** Just enough of `vscode.ExtensionContext` for the controller's constructor
 * and `gcStaleDrafts()` — a `workspaceState` backed by an in-memory map. */
function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
      update: async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
      keys: () => Array.from(store.keys()),
    },
  } as unknown as vscode.ExtensionContext;
}

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

function comment(over: Partial<ExistingPrComment> = {}): ExistingPrComment {
  return {
    id: "1",
    threadId: "1",
    author: "alice",
    body: "hello",
    path: "docs/a.md",
    line: 3,
    side: "RIGHT",
    createdAt: "2026-07-01T00:00:00Z",
    url: "https://github.com/o/r/pull/7#discussion_r1",
    ...over,
  };
}

function fakePlatform(comments: ExistingPrComment[]): { platform: PrPlatform; calls: string[] } {
  const calls: string[] = [];
  const platform: PrPlatform = {
    name: "github",
    ensureReady: async () => ({ ok: true }),
    loadContext: async () => {
      throw new Error("not used in this test");
    },
    submitReview: async () => {
      throw new Error("not used in this test");
    },
    listExistingComments: async () => comments,
    replyToComment: async (_c, threadId) => {
      calls.push(`reply:${threadId}`);
      return { url: "https://example.invalid/reply" };
    },
    resolveThread: async (_c, resolveId, resolved) => {
      calls.push(`resolve:${resolveId}:${resolved}`);
    },
  };
  return { platform, calls };
}

interface DraftHostApi {
  getExistingCommentsFor: (rel: string) => Promise<ExistingPrComment[]>;
  replyToExisting: (rel: string, threadId: string, body: string) => Promise<{ url: string }>;
  resolveThread: (rel: string, resolveId: string, resolved: boolean) => Promise<void>;
}

/**
 * Wires a controller with a live-looking session, bypassing `startPrReview`
 * (which shells out to git/gh — not what these tests are about).
 * `draftHostApi()` and the `ActiveSession` shape are private, so this reaches
 * past TypeScript's visibility check the same way other controller tests in
 * this repo poke at private state (`as any`) — a real compile error there
 * would still fail `tsc`, this only bypasses the *access* check.
 */
function withSession(comments: ExistingPrComment[]): {
  api: DraftHostApi;
  calls: string[];
  controller: PrReviewController;
} {
  const controller = new PrReviewController(fakeContext(), makeLogger());
  const { platform, calls } = fakePlatform(comments);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (controller as any).session = {
    ctx: ctx(),
    platform,
    branch: "feature",
    rangesByPath: new Map(),
    threadsByDraft: new Map(),
    existingComments: null,
    existingCommentsLoading: null,
    warnedPartialLoad: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (controller as any).draftHostApi() as DraftHostApi;
  return { api, calls, controller };
}

describe("PrReviewController: reply/resolve targets must have come from the last fetch", () => {
  it("allows a reply to an id the last fetch actually returned for that file", async () => {
    const { api, calls } = withSession([comment({ id: "1", threadId: "1", path: "docs/a.md" })]);
    const res = await api.replyToExisting("docs/a.md", "1", "thanks");
    expect(res.url).toBe("https://example.invalid/reply");
    expect(calls).toEqual(["reply:1"]);
  });

  it("refuses a reply to an id never seen for that file, before the platform is ever called", async () => {
    const { api, calls } = withSession([comment({ id: "1", threadId: "1", path: "docs/a.md" })]);
    await expect(api.replyToExisting("docs/a.md", "@/etc/passwd", "hi")).rejects.toThrow(/wasn't among/);
    // The point: `session.platform.replyToComment` (the thing that would
    // shell out) is never reached.
    expect(calls).toEqual([]);
  });

  it("refuses a reply to a real id that belongs to a DIFFERENT file", async () => {
    const { api, calls } = withSession([comment({ id: "1", threadId: "1", path: "docs/other.md" })]);
    await expect(api.replyToExisting("docs/a.md", "1", "hi")).rejects.toThrow(/wasn't among/);
    expect(calls).toEqual([]);
  });

  it("allows a resolve for a resolvable id the last fetch returned for that file", async () => {
    const { api, calls } = withSession([
      comment({ id: "1", threadId: "1", path: "docs/a.md", resolvable: true, resolveId: "PRRT_1" }),
    ]);
    await api.resolveThread("docs/a.md", "PRRT_1", true);
    expect(calls).toEqual(["resolve:PRRT_1:true"]);
  });

  it("refuses to resolve an id never seen for that file, before the platform is ever called", async () => {
    const { api, calls } = withSession([
      comment({ id: "1", threadId: "1", path: "docs/a.md", resolvable: true, resolveId: "PRRT_1" }),
    ]);
    await expect(api.resolveThread("docs/a.md", "../x", true)).rejects.toThrow(/wasn't among/);
    expect(calls).toEqual([]);
  });

  it("refuses to resolve a comment that was never marked resolvable, even reusing its own real id", async () => {
    const { api, calls } = withSession([
      comment({ id: "1", threadId: "1", path: "docs/a.md", resolvable: false, resolveId: undefined }),
    ]);
    // "1" is a real comment id for this file, but it was never offered as a
    // resolveId (not resolvable) — must still be refused.
    await expect(api.resolveThread("docs/a.md", "1", true)).rejects.toThrow(/wasn't among/);
    expect(calls).toEqual([]);
  });
});

describe("PrReviewController: partial-load notice", () => {
  it("shows the 'couldn't be loaded' notice once per session, not on every fetch", async () => {
    const originalWarn = window.showWarningMessage;
    const warnings: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).showWarningMessage = async (msg: string) => {
      warnings.push(msg);
      return undefined;
    };
    try {
      const comments = [comment({ id: "1", threadId: "1", path: "docs/a.md" })];
      (comments as ExistingPrComment[] & { partialLoadWarning?: string }).partialLoadWarning =
        "1 page of PR comments failed to parse.";
      const { api, controller } = withSession(comments);
      await api.getExistingCommentsFor("docs/a.md");
      // Force a second real fetch (not just the in-memory cache) — still
      // reports the same partialLoadWarning — and confirm it does NOT warn
      // a second time.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (controller as any).session.existingComments = null;
      await api.getExistingCommentsFor("docs/a.md");
      expect(warnings).toEqual(["Some existing comments couldn't be loaded — see Show Logs."]);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).showWarningMessage = originalWarn;
    }
  });

  it("says nothing when the fetch has no partialLoadWarning", async () => {
    const originalWarn = window.showWarningMessage;
    const warnings: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).showWarningMessage = async (msg: string) => {
      warnings.push(msg);
      return undefined;
    };
    try {
      const { api } = withSession([comment({ id: "1", threadId: "1", path: "docs/a.md" })]);
      await api.getExistingCommentsFor("docs/a.md");
      expect(warnings).toEqual([]);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).showWarningMessage = originalWarn;
    }
  });
});
