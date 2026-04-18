import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { ReviewView } from "../reviewView";
import type { LoadResult } from "../sidecar";
import { sidecarPathFor } from "../sidecar";
import type { Comment, Sidecar } from "../types";
import { EventEmitter, Uri, commands, workspace } from "./vscode-stub";

/**
 * Minimal fake of the subset of MarkdownCollabController that ReviewView
 * actually consumes. Real controller would be too heavy to instantiate in a
 * pure unit test and would couple F3 to F1/F2 internals.
 */
function makeFakeController() {
  const external = new EventEmitter<string>();
  const orphans = new EventEmitter<void>();
  return {
    onDidExternalSidecarChange: external.event,
    onDidChangeOrphans: orphans.event,
    fireExternal: (p: string) => external.fire(p),
    fireOrphans: () => orphans.fire(),
  } as any;
}

function makeOutputChannel() {
  const lines: string[] = [];
  return {
    appendLine: (m: string) => lines.push(m),
    append: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
    lines,
  } as any;
}

function comment(id: string, body = "b", resolved = false): Comment {
  return {
    id,
    anchor: { text: "anchor-" + id, contextBefore: "", contextAfter: "" },
    body,
    author: "user",
    createdAt: "2025-01-01T00:00:00Z",
    resolved,
    replies: [],
  };
}

function sidecarWith(comments: Comment[], version = 1): Sidecar {
  return { version: version as 1, file: "docs/a.md", comments };
}

/**
 * Fresh workspace folder setup for each test. Using `/ws` as an in-memory
 * workspace root keeps tests FS-free — sidecarPathFor only does string work.
 */
const WS_ROOT = "/ws";

beforeEach(() => {
  (workspace as any).workspaceFolders = [{ uri: Uri.file(WS_ROOT), name: "ws", index: 0 }];
  (workspace as any).textDocuments = [];
  // Context key recorder: reset before each test.
  (commands as any).__calls = [];
  commands.executeCommand = (async (...args: any[]) => {
    ((commands as any).__calls as any[]).push(args);
    return undefined;
  }) as any;
});

afterEach(() => {
  (workspace as any).workspaceFolders = undefined;
  (workspace as any).textDocuments = [];
  vi.useRealTimers();
});

describe("ReviewView", () => {
  it("constructor does not call findFiles (lazy scan)", async () => {
    const findFiles = vi.fn(async () => [] as any[]);
    const loadSidecar = vi.fn(async () => null as LoadResult);
    const view = new ReviewView(makeFakeController(), makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });
    // Give microtasks a chance; constructor must not have scheduled a scan.
    await Promise.resolve();
    expect(findFiles).not.toHaveBeenCalled();
    expect(loadSidecar).not.toHaveBeenCalled();
    view.dispose();
  });

  it("first getChildren(undefined) triggers the scan and returns [] synchronously", async () => {
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const sidecarPath = sidecarPathFor(mdPath, WS_ROOT)!;
    const findFiles = vi.fn(async () => [Uri.file(sidecarPath)] as any[]);
    const loadSidecar = vi.fn(async () => ({
      sidecar: sidecarWith([comment("c_00000001")]),
      mode: "ok" as const,
    }));
    const view = new ReviewView(makeFakeController(), makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });

    // Subscribe to data-change to await scan completion without polling.
    const changed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });

    const first = view.getChildren(undefined);
    // Lazy: the first synchronous call returns empty, *then* we wait for scan
    // completion before asserting children.
    expect(first).toEqual([]);
    expect(findFiles).toHaveBeenCalledTimes(1);

    await changed;

    const second = view.getChildren(undefined) as any[];
    expect(second).toHaveLength(1);
    expect(second[0].kind).toBe("file");
    expect(second[0].docPath).toBe(mdPath);
    expect(second[0].unresolvedCount).toBe(1);

    view.dispose();
  });

  it("respects CONCURRENCY cap of 8", async () => {
    // Build 20 fake sidecars under the workspace.
    const sidecarUris = Array.from({ length: 20 }, (_, i) => {
      const mdPath = path.join(WS_ROOT, `docs/f${i}.md`);
      return Uri.file(sidecarPathFor(mdPath, WS_ROOT)!);
    });
    const findFiles = vi.fn(async () => sidecarUris as any[]);

    let inFlight = 0;
    let peak = 0;
    const loadSidecar = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield for a tick so concurrent calls accumulate.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        sidecar: sidecarWith([comment("c_00000001")]),
        mode: "ok" as const,
      };
    });

    const view = new ReviewView(makeFakeController(), makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });
    const done = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await done;

    expect(loadSidecar).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(8);
    view.dispose();
  });

  it("excludes files whose comments are all resolved", async () => {
    const mdA = path.join(WS_ROOT, "docs/a.md");
    const mdB = path.join(WS_ROOT, "docs/b.md");
    const sA = sidecarPathFor(mdA, WS_ROOT)!;
    const sB = sidecarPathFor(mdB, WS_ROOT)!;
    const findFiles = vi.fn(async () => [Uri.file(sA), Uri.file(sB)] as any[]);
    const loadSidecar = vi.fn(async (p: string) => {
      if (p === sA) {
        return {
          sidecar: sidecarWith([comment("c_00000001", "x", true)]),
          mode: "ok" as const,
        };
      }
      return {
        sidecar: sidecarWith([comment("c_00000002", "y", false)]),
        mode: "ok" as const,
      };
    });
    const view = new ReviewView(makeFakeController(), makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });
    const done = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await done;

    const files = view.getChildren(undefined) as any[];
    expect(files).toHaveLength(1);
    expect(files[0].docPath).toBe(mdB);
    view.dispose();
  });

  it("renders read-only sidecar with no command on leaves", async () => {
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const sidecarPath = sidecarPathFor(mdPath, WS_ROOT)!;
    const findFiles = vi.fn(async () => [Uri.file(sidecarPath)] as any[]);
    const loadSidecar = vi.fn(async () => ({
      sidecar: { ...sidecarWith([comment("c_00000001")]), version: 999 as any },
      mode: "read-only-unknown-version" as const,
    }));
    const view = new ReviewView(makeFakeController(), makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });
    const done = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await done;

    const files = view.getChildren(undefined) as any[];
    expect(files).toHaveLength(1);
    expect(files[0].readOnly).toBe(true);
    const fileItem = view.getTreeItem(files[0]) as any;
    expect(fileItem.iconPath).toBeTruthy();
    const leaves = view.getChildren(files[0]) as any[];
    expect(leaves).toHaveLength(1);
    const leafItem = view.getTreeItem(leaves[0]) as any;
    expect(leafItem.command).toBeUndefined();
    view.dispose();
  });

  it("invalidates a single cache entry on onDidExternalSidecarChange", async () => {
    const controller = makeFakeController();
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const sidecarPath = sidecarPathFor(mdPath, WS_ROOT)!;
    const findFiles = vi.fn(async () => [Uri.file(sidecarPath)] as any[]);
    let loadCount = 0;
    const loadSidecar = vi.fn(async () => {
      loadCount++;
      return {
        sidecar: sidecarWith([comment("c_00000001")]),
        mode: "ok" as const,
      };
    });
    const view = new ReviewView(controller, makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });
    const initialDone = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await initialDone;
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(loadCount).toBe(1);

    // Fire the external-change event and wait for the resulting refresh.
    const refreshed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    controller.fireExternal(mdPath);
    await refreshed;

    // Exactly one extra sidecar read — no full rescan (findFiles unchanged).
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(loadCount).toBe(2);
    view.dispose();
  });

  it("coalesces 3 rapid onDidChangeOrphans fires into a single refresh", async () => {
    vi.useFakeTimers();
    const controller = makeFakeController();
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const sidecarPath = sidecarPathFor(mdPath, WS_ROOT)!;
    const findFiles = vi.fn(async () => [Uri.file(sidecarPath)] as any[]);
    let loadCount = 0;
    const loadSidecar = vi.fn(async () => {
      loadCount++;
      return {
        sidecar: sidecarWith([comment("c_00000001")]),
        mode: "ok" as const,
      };
    });
    // Simulate the doc being open so the orphan-debounce path picks it up.
    (workspace as any).textDocuments = [{ uri: Uri.file(mdPath) }];

    const view = new ReviewView(controller, makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });

    // Complete the initial scan synchronously with fake timers suspended for
    // the async microtasks.
    vi.useRealTimers();
    const initialDone = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await initialDone;
    expect(loadCount).toBe(1);

    // Switch to fake timers for the debounce window assertions.
    vi.useFakeTimers();

    // Three rapid fires within the 100ms debounce window.
    controller.fireOrphans();
    vi.advanceTimersByTime(30);
    controller.fireOrphans();
    vi.advanceTimersByTime(30);
    controller.fireOrphans();

    // None should have fired the trailing-edge handler yet.
    expect(loadCount).toBe(1);

    // Advance past the 100ms window since the LAST fire.
    vi.advanceTimersByTime(120);
    // Drain promises created by the now-fired setTimeout callback. Use real
    // timers so awaiting chained promises actually progresses.
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));

    expect(loadCount).toBe(2);
    view.dispose();
  });

  it("coalesces 3 rapid onDidExternalSidecarChange fires for the same path", async () => {
    const controller = makeFakeController();
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const sidecarPath = sidecarPathFor(mdPath, WS_ROOT)!;
    const findFiles = vi.fn(async () => [Uri.file(sidecarPath)] as any[]);
    let loadCount = 0;
    const loadSidecar = vi.fn(async () => {
      loadCount++;
      return {
        sidecar: sidecarWith([comment("c_00000001")]),
        mode: "ok" as const,
      };
    });
    const view = new ReviewView(controller, makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });

    // Complete initial scan.
    const initialDone = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await initialDone;
    expect(loadCount).toBe(1);

    // Three rapid fires for the same path should coalesce into one re-read.
    controller.fireExternal(mdPath);
    controller.fireExternal(mdPath);
    controller.fireExternal(mdPath);

    // Wait past the external-change debounce (100ms) + a small cushion.
    const refreshed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    await refreshed;

    // Exactly one extra sidecar read, not three.
    expect(loadCount).toBe(2);
    view.dispose();
  });

  it("flips markdownCollab.hasReview context: false → true → false", async () => {
    const controller = makeFakeController();
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const sidecarPath = sidecarPathFor(mdPath, WS_ROOT)!;
    const findFiles = vi.fn(async () => [Uri.file(sidecarPath)] as any[]);
    // First load: one unresolved comment.
    let round = 0;
    const loadSidecar = vi.fn(async () => {
      round++;
      if (round === 1) {
        return {
          sidecar: sidecarWith([comment("c_00000001", "x", false)]),
          mode: "ok" as const,
        };
      }
      // Subsequent loads: all resolved → entry should be evicted.
      return {
        sidecar: sidecarWith([comment("c_00000001", "x", true)]),
        mode: "ok" as const,
      };
    });
    const view = new ReviewView(controller, makeOutputChannel(), {
      findFiles,
      loadSidecar,
    });

    // Context key lookup helper
    const latest = (key: string) => {
      const calls = (commands as any).__calls as any[][];
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i][0] === "setContext" && calls[i][1] === key) {
          return calls[i][2];
        }
      }
      return undefined;
    };

    // Before scan: context either unset or false.
    // (The sync on construction only fires if hasAny flips; last-seen value
    // is `false` by default, so no fire happens. That's fine — VS Code treats
    // absent keys as false.)
    expect(latest("markdownCollab.hasReview")).toBeUndefined();

    const firstDone = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await firstDone;

    expect(latest("markdownCollab.hasReview")).toBe(true);

    // Now fire an external change; second load returns all resolved → evict.
    const secondDone = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    controller.fireExternal(mdPath);
    await secondDone;

    expect(latest("markdownCollab.hasReview")).toBe(false);
    view.dispose();
  });
});
