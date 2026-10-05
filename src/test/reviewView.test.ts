import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { ReviewView } from "../reviewView";
import { addThread } from "../inlineComments/format";
import { Uri, commands, workspace } from "./vscode-stub";

/**
 * Build a markdown doc carrying inline-comment threads. Each spec becomes one
 * anchored span + one `<!--mc:t ...-->` line in the threads region.
 */
function docWithThreads(
  specs: Array<{
    id: string;
    status?: "open" | "resolved";
    body?: string;
    /** Author of the root comment — "claude" makes the thread claude-initiated. */
    author?: string;
    /** Author of a second comment, e.g. a human reply that marks it read. */
    replyBy?: string;
  }>,
): string {
  const anchors = specs
    .map((s) => `<!--mc:a:${s.id}-->anchor ${s.id}<!--mc:/a:${s.id}-->`)
    .join("\n\n");
  const lines = ["<!--mc:threads:begin-->"];
  for (const s of specs) {
    const comments = [
      { id: "c1", author: s.author ?? "user", ts: "2025-01-01T00:00:00Z", body: s.body ?? "b" },
    ];
    if (s.replyBy) {
      comments.push({ id: "c2", author: s.replyBy, ts: "2025-01-02T00:00:00Z", body: "reply" });
    }
    const obj = {
      id: s.id,
      quote: `anchor ${s.id}`,
      status: s.status ?? "open",
      comments,
    };
    lines.push(`<!--mc:t ${JSON.stringify(obj)}-->`);
  }
  lines.push("<!--mc:threads:end-->");
  return anchors + "\n\n" + lines.join("\n") + "\n";
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

/** Fake `watch` dep that captures the handlers so a test can drive change/delete. */
function makeWatch() {
  const cap: {
    onChange?: (p: string) => void;
    onDelete?: (p: string) => void;
  } = {};
  const watch = (handlers: {
    onChange: (p: string) => void;
    onDelete: (p: string) => void;
  }) => {
    cap.onChange = handlers.onChange;
    cap.onDelete = handlers.onDelete;
    return { dispose: () => undefined };
  };
  return {
    watch,
    change: (p: string) => cap.onChange?.(p),
    del: (p: string) => cap.onDelete?.(p),
  };
}

const WS_ROOT = "/ws";

beforeEach(() => {
  (workspace as any).workspaceFolders = [{ uri: Uri.file(WS_ROOT), name: "ws", index: 0 }];
  (workspace as any).textDocuments = [];
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
  it("constructor does not scan; activation starts it with ensureScanned", async () => {
    const findFiles = vi.fn(async () => [] as any[]);
    const readFile = vi.fn(async () => null);
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: makeWatch().watch,
    });
    await Promise.resolve();
    expect(findFiles).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    view.dispose();
  });

  it("getChildren(undefined) before any scan starts one and returns [] synchronously", async () => {
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const findFiles = vi.fn(async () => [Uri.file(mdPath)] as any[]);
    const readFile = vi.fn(async () => docWithThreads([{ id: "abc12" }]));
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: makeWatch().watch,
    });

    const changed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });

    const first = view.getChildren(undefined);
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
    const uris = Array.from({ length: 20 }, (_, i) =>
      Uri.file(path.join(WS_ROOT, `docs/f${i}.md`)),
    );
    const findFiles = vi.fn(async () => uris as any[]);

    let inFlight = 0;
    let peak = 0;
    const readFile = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return docWithThreads([{ id: "abc12" }]);
    });

    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: makeWatch().watch,
    });
    const done = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await done;

    expect(readFile).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(8);
    view.dispose();
  });

  it("excludes files whose threads are all resolved", async () => {
    const mdA = path.join(WS_ROOT, "docs/a.md");
    const mdB = path.join(WS_ROOT, "docs/b.md");
    const findFiles = vi.fn(async () => [Uri.file(mdA), Uri.file(mdB)] as any[]);
    const readFile = vi.fn(async (p: string) =>
      p === mdA
        ? docWithThreads([{ id: "aaaaa", status: "resolved" }])
        : docWithThreads([{ id: "bbbbb", status: "open" }]),
    );
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: makeWatch().watch,
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

  it("leaf nodes carry a reveal command and the thread quote", async () => {
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const findFiles = vi.fn(async () => [Uri.file(mdPath)] as any[]);
    const readFile = vi.fn(async () => docWithThreads([{ id: "abc12", body: "needs work" }]));
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: makeWatch().watch,
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
    const leaves = view.getChildren(files[0]) as any[];
    expect(leaves).toHaveLength(1);
    expect(leaves[0].kind).toBe("comment");
    expect(leaves[0].thread.id).toBe("abc12");
    const leafItem = view.getTreeItem(leaves[0]) as any;
    expect(leafItem.command?.command).toBe("markdownCollab.revealComment");
    expect(String(leafItem.label)).toContain("anchor abc12");
    view.dispose();
  });

  it("invalidates a single cache entry on a file change", async () => {
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const findFiles = vi.fn(async () => [Uri.file(mdPath)] as any[]);
    let loadCount = 0;
    const readFile = vi.fn(async () => {
      loadCount++;
      return docWithThreads([{ id: "abc12" }]);
    });
    const w = makeWatch();
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: w.watch,
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

    const refreshed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    w.change(mdPath);
    await refreshed;

    // One extra read, no full rescan.
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(loadCount).toBe(2);
    view.dispose();
  });

  it("coalesces 3 rapid change fires for the same path into one re-read", async () => {
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const findFiles = vi.fn(async () => [Uri.file(mdPath)] as any[]);
    let loadCount = 0;
    const readFile = vi.fn(async () => {
      loadCount++;
      return docWithThreads([{ id: "abc12" }]);
    });
    const w = makeWatch();
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: w.watch,
    });

    const initialDone = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await initialDone;
    expect(loadCount).toBe(1);

    w.change(mdPath);
    w.change(mdPath);
    w.change(mdPath);

    const refreshed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    await refreshed;

    expect(loadCount).toBe(2);
    view.dispose();
  });

  it("removes a file from the tree on delete", async () => {
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const findFiles = vi.fn(async () => [Uri.file(mdPath)] as any[]);
    const readFile = vi.fn(async () => docWithThreads([{ id: "abc12" }]));
    const w = makeWatch();
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: w.watch,
    });
    const initialDone = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    view.getChildren(undefined);
    await initialDone;
    expect((view.getChildren(undefined) as any[]).length).toBe(1);

    const removed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    w.del(mdPath);
    await removed;
    expect((view.getChildren(undefined) as any[]).length).toBe(0);
    view.dispose();
  });

  it("flips markdownCollab.hasReview context: false → true → false", async () => {
    const mdPath = path.join(WS_ROOT, "docs/a.md");
    const findFiles = vi.fn(async () => [Uri.file(mdPath)] as any[]);
    let round = 0;
    const readFile = vi.fn(async () => {
      round++;
      return round === 1
        ? docWithThreads([{ id: "abc12", status: "open" }])
        : docWithThreads([{ id: "abc12", status: "resolved" }]);
    });
    const w = makeWatch();
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile,
      watch: w.watch,
    });

    const latest = (key: string) => {
      const calls = (commands as any).__calls as any[][];
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i][0] === "setContext" && calls[i][1] === key) return calls[i][2];
      }
      return undefined;
    };

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

    const secondDone = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    w.change(mdPath);
    await secondDone;
    expect(latest("markdownCollab.hasReview")).toBe(false);
    view.dispose();
  });
});

describe("ReviewView cross-file unread walk", () => {
  const A = path.join(WS_ROOT, "docs/a.md");
  const B = path.join(WS_ROOT, "docs/b.md");

  /** A view over two files, already scanned — the shape the walk command sees. */
  async function scannedView(contents: Record<string, string>) {
    const view = new ReviewView(makeOutputChannel(), {
      findFiles: async () => Object.keys(contents).map((p) => Uri.file(p)) as any[],
      readFile: async (p: string) => contents[p] ?? null,
      watch: makeWatch().watch,
    });
    await view.ensureScanned();
    return view;
  }

  it("ensureScanned populates the cache without expanding the tree", async () => {
    const view = await scannedView({ [A]: docWithThreads([{ id: "aaa11", author: "claude" }]) });
    expect((view.getChildren(undefined) as any[])).toHaveLength(1);
    view.dispose();
  });

  it("ensureScanned scans once, even when the tree was already expanded", async () => {
    const findFiles = vi.fn(async () => [Uri.file(A)] as any[]);
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile: async () => docWithThreads([{ id: "aaa11", author: "claude" }]),
      watch: makeWatch().watch,
    });
    view.getChildren(undefined); // the tree asks first and starts the scan
    await view.ensureScanned();
    expect(findFiles).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("getChildren during an activation scan does not scan again, and lists the files once it finishes", async () => {
    const findFiles = vi.fn(async () => [Uri.file(A)] as any[]);
    const view = new ReviewView(makeOutputChannel(), {
      findFiles,
      readFile: async () => docWithThreads([{ id: "aaa11", author: "claude" }]),
      watch: makeWatch().watch,
    });
    const refreshed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    void view.ensureScanned();
    expect(view.getChildren(undefined)).toEqual([]);
    await refreshed;
    expect((view.getChildren(undefined) as any[]).map((n) => n.docPath)).toEqual([A]);
    expect(findFiles).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("ensureScanned waits for a scan already in flight", async () => {
    const view = new ReviewView(makeOutputChannel(), {
      findFiles: async () => [Uri.file(A)] as any[],
      readFile: async () => docWithThreads([{ id: "aaa11", author: "claude" }]),
      watch: makeWatch().watch,
    });
    void view.ensureScanned();
    await view.ensureScanned();
    expect(view.listClaudeUnread().map((u) => u.docPath)).toEqual([A]);
    view.dispose();
  });

  it("a workspace folder change rescans without the tree being expanded", async () => {
    let onFolders = () => {};
    (workspace as any).onDidChangeWorkspaceFolders = (cb: () => void) => {
      onFolders = cb;
      return { dispose: () => undefined };
    };
    try {
      const findFiles = vi.fn(async () => [Uri.file(A)] as any[]);
      const view = new ReviewView(makeOutputChannel(), {
        findFiles,
        readFile: async () => docWithThreads([{ id: "aaa11", author: "claude" }]),
        watch: makeWatch().watch,
      });
      await view.ensureScanned();
      onFolders();
      await view.ensureScanned();
      expect(findFiles).toHaveBeenCalledTimes(2);
      view.dispose();
    } finally {
      (workspace as any).onDidChangeWorkspaceFolders = () => ({ dispose: () => undefined });
    }
  });

  it("walks claude-unread threads across files in path order", async () => {
    const view = await scannedView({
      [B]: docWithThreads([{ id: "bbb11", author: "claude" }]),
      [A]: docWithThreads([
        { id: "aaa11", author: "claude" },
        { id: "aaa22", author: "claude" },
      ]),
    });
    expect(view.listClaudeUnread().map((u) => [path.basename(u.docPath), u.thread.id])).toEqual([
      ["a.md", "aaa11"],
      ["a.md", "aaa22"],
      ["b.md", "bbb11"],
    ]);
    view.dispose();
  });

  it("excludes human-authored threads and ones the human already answered", async () => {
    const view = await scannedView({
      [A]: docWithThreads([
        { id: "hum11", author: "user" },
        { id: "ans11", author: "claude", replyBy: "user" },
        { id: "new11", author: "claude" },
      ]),
    });
    expect(view.listClaudeUnread().map((u) => u.thread.id)).toEqual(["new11"]);
    view.dispose();
  });

  it("drops a thread from the walk once the file changes on disk", async () => {
    const contents: Record<string, string> = {
      [A]: docWithThreads([{ id: "aaa11", author: "claude" }]),
    };
    const w = makeWatch();
    const view = new ReviewView(makeOutputChannel(), {
      findFiles: async () => [Uri.file(A)] as any[],
      readFile: async (p: string) => contents[p] ?? null,
      watch: w.watch,
    });
    await view.ensureScanned();
    expect(view.listClaudeUnread()).toHaveLength(1);

    // The human replies — the thread is no longer unread.
    contents[A] = docWithThreads([{ id: "aaa11", author: "claude", replyBy: "user" }]);
    const refreshed = new Promise<void>((resolve) => {
      const disp = view.onDidChangeTreeData(() => {
        disp.dispose();
        resolve();
      });
    });
    w.change(A);
    await refreshed;
    expect(view.listClaudeUnread()).toHaveLength(0);
    view.dispose();
  });

  it("is empty when nothing has been scanned", () => {
    const view = new ReviewView(makeOutputChannel(), {
      findFiles: async () => [] as any[],
      readFile: async () => null,
      watch: makeWatch().watch,
    });
    expect(view.listClaudeUnread()).toEqual([]);
    view.dispose();
  });
});

describe("ReviewView integrity notifications", () => {
  const MD = path.join(WS_ROOT, "docs/a.md");
  const PROSE = "# Guide\n\nThe retry policy uses exponential backoff.\n";
  const at = PROSE.indexOf("exponential backoff");
  const { source: healthy, thread } = addThread(PROSE, at, at + "exponential backoff".length, {
    author: "ronica",
    body: "configurable?",
    ts: "2026-07-25T12:00:00.000Z",
  });
  const brokenClose = healthy.replace(`<!--mc:/a:${thread.id}-->`, "");
  const brokenCloseNoThreads = brokenClose.slice(0, brokenClose.indexOf("<!--mc:threads:begin-->"));

  const noop = () => undefined;
  const silentLogger: any = { trace: noop, info: noop, warn: noop, error: noop, scope: () => silentLogger };

  function viewOver(getText: () => string) {
    const onIntegrityIssues = vi.fn();
    const w = makeWatch();
    const view = new ReviewView(silentLogger, {
      findFiles: async () => [Uri.file(MD)] as any[],
      readFile: async () => getText(),
      watch: w.watch,
      onIntegrityIssues,
    });
    return { view, w, onIntegrityIssues };
  }

  it("the startup scan does not warn about a file that was already damaged", async () => {
    const { view, onIntegrityIssues } = viewOver(() => brokenClose);
    await view.ensureScanned();
    expect(onIntegrityIssues).not.toHaveBeenCalled();
    view.dispose();
  });

  it("damage that appears after the scan is reported", async () => {
    let text = healthy;
    const { view, w, onIntegrityIssues } = viewOver(() => text);
    await view.ensureScanned();
    text = brokenClose;
    w.change(MD);
    await vi.waitFor(() => expect(onIntegrityIssues).toHaveBeenCalledTimes(1));
    view.dispose();
  });

  it("a file already damaged at startup is not reported again when it changes without a new problem", async () => {
    let text = brokenClose;
    const { view, w, onIntegrityIssues } = viewOver(() => text);
    await view.ensureScanned();
    text = brokenClose + "\nAn unrelated edit.\n";
    w.change(MD);
    await new Promise((r) => setTimeout(r, 300));
    expect(onIntegrityIssues).not.toHaveBeenCalled();
    view.dispose();
  });

  it("a file already damaged at startup is reported when it gets a new, different problem", async () => {
    let text = brokenClose;
    const { view, w, onIntegrityIssues } = viewOver(() => text);
    await view.ensureScanned();
    expect(onIntegrityIssues).not.toHaveBeenCalled();
    text = brokenCloseNoThreads;
    w.change(MD);
    await vi.waitFor(() => expect(onIntegrityIssues).toHaveBeenCalledTimes(1));
    view.dispose();
  });

  it("a file already damaged at startup is announced when it is opened", async () => {
    const { view, onIntegrityIssues } = viewOver(() => brokenClose);
    await view.ensureScanned();
    expect(onIntegrityIssues).not.toHaveBeenCalled();
    view.onDocumentOpened(MD, brokenClose);
    expect(onIntegrityIssues).toHaveBeenCalledTimes(1);
    expect(onIntegrityIssues.mock.calls[0]![0].fsPath).toBe(MD);
    view.dispose();
  });

  it("opening the same damaged file again does not announce again", async () => {
    const { view, onIntegrityIssues } = viewOver(() => brokenClose);
    await view.ensureScanned();
    view.onDocumentOpened(MD, brokenClose);
    view.onDocumentOpened(MD, brokenClose);
    expect(onIntegrityIssues).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("opening a healthy file announces nothing", async () => {
    const { view, onIntegrityIssues } = viewOver(() => healthy);
    await view.ensureScanned();
    view.onDocumentOpened(MD, healthy);
    view.onDocumentOpened(MD, PROSE);
    expect(onIntegrityIssues).not.toHaveBeenCalled();
    view.dispose();
  });

  it("damage the watcher already announced is not announced again on open", async () => {
    let text = healthy;
    const { view, w, onIntegrityIssues } = viewOver(() => text);
    await view.ensureScanned();
    text = brokenClose;
    w.change(MD);
    await vi.waitFor(() => expect(onIntegrityIssues).toHaveBeenCalledTimes(1));
    view.onDocumentOpened(MD, brokenClose);
    expect(onIntegrityIssues).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("a file that was repaired and is damaged again is announced when opened", async () => {
    const { view, onIntegrityIssues } = viewOver(() => brokenClose);
    await view.ensureScanned();
    view.onDocumentOpened(MD, brokenClose);
    view.onDocumentOpened(MD, healthy);
    view.onDocumentOpened(MD, brokenClose);
    expect(onIntegrityIssues).toHaveBeenCalledTimes(2);
    view.dispose();
  });

  it("a different problem in an already announced file is announced when opened", async () => {
    const { view, onIntegrityIssues } = viewOver(() => brokenClose);
    await view.ensureScanned();
    view.onDocumentOpened(MD, brokenClose);
    view.onDocumentOpened(MD, brokenCloseNoThreads);
    expect(onIntegrityIssues).toHaveBeenCalledTimes(2);
    view.dispose();
  });

  it("a deleted file that comes back damaged is announced when opened", async () => {
    const { view, w, onIntegrityIssues } = viewOver(() => brokenClose);
    await view.ensureScanned();
    view.onDocumentOpened(MD, brokenClose);
    w.del(MD);
    view.onDocumentOpened(MD, brokenClose);
    expect(onIntegrityIssues).toHaveBeenCalledTimes(2);
    view.dispose();
  });
});
