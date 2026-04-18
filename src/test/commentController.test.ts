import { describe, it, expect } from "vitest";
import {
  MarkdownCollabController,
  extractAnchor,
  findCommentIdForThread,
  serializeByKey,
} from "../commentController";
import { Range, window } from "./vscode-stub";

describe("extractAnchor", () => {
  it("captures contextBefore = 40 chars preceding a mid-document selection", () => {
    // Build a document where the selection sits comfortably in the middle
    // with more than 40 chars on each side.
    const before = "0123456789".repeat(8); // 80 chars preceding
    const selection = "this is a selected passage"; // 26 chars, ≥8 non-ws
    const after = "abcdefghij".repeat(8); // 80 chars trailing
    const text = before + selection + after;
    const start = before.length;
    const end = start + selection.length;

    const { anchor, valid } = extractAnchor(text, start, end);
    expect(anchor.text).toBe(selection);
    // Exactly 40 chars of contextBefore, taken from immediately preceding text.
    expect(anchor.contextBefore).toBe(before.slice(before.length - 40));
    expect(anchor.contextBefore.length).toBe(40);
    expect(valid).toBe(true);
  });

  it("captures contextAfter = 40 chars following a mid-document selection", () => {
    const before = "0123456789".repeat(8);
    const selection = "another selected passage";
    const after = "abcdefghij".repeat(8);
    const text = before + selection + after;
    const start = before.length;
    const end = start + selection.length;

    const { anchor } = extractAnchor(text, start, end);
    expect(anchor.contextAfter).toBe(after.slice(0, 40));
    expect(anchor.contextAfter.length).toBe(40);
  });

  it("uses an empty contextBefore when the selection starts at position 0", () => {
    const selection = "starting selection text";
    const after = "abcdefghij".repeat(8);
    const text = selection + after;

    const { anchor, valid } = extractAnchor(text, 0, selection.length);
    expect(anchor.text).toBe(selection);
    expect(anchor.contextBefore).toBe("");
    expect(anchor.contextAfter).toBe(after.slice(0, 40));
    expect(valid).toBe(true);
  });

  it("uses an empty contextAfter when the selection ends at the file end", () => {
    const before = "0123456789".repeat(8);
    const selection = "tail end selection piece";
    const text = before + selection;

    const { anchor } = extractAnchor(text, before.length, text.length);
    expect(anchor.contextBefore).toBe(before.slice(before.length - 40));
    expect(anchor.contextAfter).toBe("");
  });

  it("truncates contextBefore when the selection is closer to the start than the window", () => {
    // Only 12 chars precede the selection, but window is 40.
    const before = "0123456789ab"; // 12 chars
    const selection = "midway selection text here"; // ≥8 non-ws
    const after = "trailing content on the end";
    const text = before + selection + after;

    const { anchor } = extractAnchor(text, before.length, before.length + selection.length);
    expect(anchor.contextBefore).toBe(before); // truncated to what's available
    expect(anchor.contextBefore.length).toBe(12);
  });

  it("truncates contextAfter when the selection is closer to the end than the window", () => {
    const before = "plenty of leading context abcd";
    const selection = "selection text choice";
    const after = "short"; // 5 chars, less than 40
    const text = before + selection + after;

    const { anchor } = extractAnchor(text, before.length, before.length + selection.length);
    expect(anchor.contextAfter).toBe(after);
    expect(anchor.contextAfter.length).toBe(5);
  });

  it("returns valid: true for a selection with at least 8 non-whitespace chars", () => {
    const text = "before the abcdefgh right after.";
    const idx = text.indexOf("abcdefgh");
    const { anchor, valid } = extractAnchor(text, idx, idx + 8);
    expect(anchor.text).toBe("abcdefgh");
    expect(valid).toBe(true);
  });

  it("returns valid: false for a whitespace-only selection", () => {
    const text = "before     trailing";
    const { anchor, valid } = extractAnchor(text, 6, 11); // five spaces
    expect(anchor.text).toBe("     ");
    expect(valid).toBe(false);
  });

  it("returns valid: false when fewer than 8 non-whitespace chars are selected", () => {
    const text = "before abc def trailing";
    // Select "abc def" (7 non-whitespace chars)
    const start = text.indexOf("abc");
    const end = start + "abc def".length;
    const { anchor, valid } = extractAnchor(text, start, end);
    expect(anchor.text).toBe("abc def");
    expect(valid).toBe(false);
  });

  it("honors a custom contextWindow when provided", () => {
    const before = "0123456789abcdef"; // 16 chars
    const selection = "some selected slice of text";
    const after = "abcdefghij".repeat(4); // 40 chars
    const text = before + selection + after;

    const { anchor } = extractAnchor(
      text,
      before.length,
      before.length + selection.length,
      10,
    );
    expect(anchor.contextBefore).toBe(before.slice(before.length - 10));
    expect(anchor.contextBefore.length).toBe(10);
    expect(anchor.contextAfter).toBe(after.slice(0, 10));
    expect(anchor.contextAfter.length).toBe(10);
  });
});

describe("serializeByKey", () => {
  // This helper underlies the reload() serialization in MarkdownCollabController:
  // two overlapping reloads for the same URI must run strictly in submission
  // order so that disposal and attachment don't interleave (which would leak
  // thread objects and double-render comments).
  it("runs two concurrent calls on the same key strictly in submission order", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const log: string[] = [];

    let release1: () => void = () => {};
    const work1 = (): Promise<string> => {
      log.push("enter1");
      return new Promise<string>((resolve) => {
        release1 = () => {
          log.push("exit1");
          resolve("one");
        };
      });
    };
    const work2 = (): Promise<string> => {
      log.push("enter2");
      return new Promise<string>((resolve) => {
        // Settle synchronously once it starts — the assertion is that it
        // doesn't start until work1 has exited.
        log.push("exit2");
        resolve("two");
      });
    };

    const p1 = serializeByKey(queues, "doc.md", work1);
    const p2 = serializeByKey(queues, "doc.md", work2);

    // After microtask flush, work1 has entered but work2 must not have yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["enter1"]);

    release1();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("one");
    expect(r2).toBe("two");
    // Strict ordering: work2 never enters before work1 exits.
    expect(log).toEqual(["enter1", "exit1", "enter2", "exit2"]);
  });

  it("does not serialize across different keys", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const log: string[] = [];

    let releaseA: () => void = () => {};
    const workA = (): Promise<void> =>
      new Promise<void>((resolve) => {
        log.push("enterA");
        releaseA = () => {
          log.push("exitA");
          resolve();
        };
      });
    const workB = async (): Promise<void> => {
      log.push("enterB");
      log.push("exitB");
    };

    const pA = serializeByKey(queues, "a.md", workA);
    const pB = serializeByKey(queues, "b.md", workB);

    // Without waiting for A to exit, B should have already run (different key).
    await pB;
    expect(log).toContain("enterA");
    expect(log).toContain("enterB");
    expect(log).toContain("exitB");
    expect(log).not.toContain("exitA");

    releaseA();
    await pA;
    expect(log[log.length - 1]).toBe("exitA");
  });

  it("cleans up map entry after settled, keyed by identity (later chain survives)", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const p1 = serializeByKey(queues, "k", async () => "first");
    await p1;
    // The cleanup .then() chained after the stored entry runs one microtask
    // after p1 settles; yield once so it fires before we assert.
    await Promise.resolve();
    expect(queues.has("k")).toBe(false);
    // A brand-new submission should establish a fresh chain.
    const p2 = serializeByKey(queues, "k", async () => "second");
    expect(queues.has("k")).toBe(true);
    await p2;
    await Promise.resolve();
    expect(queues.has("k")).toBe(false);
  });

  it("subsequent work runs even if the prior work rejected", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const p1 = serializeByKey(queues, "k", async () => {
      throw new Error("boom");
    });
    const p2 = serializeByKey(queues, "k", async () => "recovered");
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("recovered");
  });
});

describe("MarkdownCollabController watcher integration surface", () => {
  // These tests cover the small public surface F2 added for the sidecar
  // watcher: isReloading() tracking during a reload, and onExternalChange
  // fan-out via the event emitter. Full thread-object patch-in-place
  // behavior requires a much richer vscode stub (document / workspace
  // folder / anchor resolution); that gap is intentional and called out in
  // the F2 brief.
  const output = window.createOutputChannel() as unknown as any;

  it("isReloading returns false when no reload is queued for the path", () => {
    const controller = new MarkdownCollabController(output);
    try {
      expect(controller.isReloading("/not/a/real/path.md")).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it("isReloading returns true while a reload is in-flight, false after it settles", async () => {
    const controller = new MarkdownCollabController(output);
    try {
      // Reach into the private `reloading` map via a bracket accessor — the
      // goal is to prove the getter reflects map membership without
      // exercising the full reload pipeline (which needs a fake document).
      const reloading = (controller as unknown as {
        reloading: Map<string, Promise<unknown>>;
      }).reloading;
      let release: () => void = () => {};
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });
      reloading.set("/fake/doc.md", blocker);
      expect(controller.isReloading("/fake/doc.md")).toBe(true);
      expect(controller.isReloading("/other/doc.md")).toBe(false);
      release();
      await blocker;
      reloading.delete("/fake/doc.md");
      expect(controller.isReloading("/fake/doc.md")).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it("onExternalChange fires the onDidExternalSidecarChange event with the fsPath", () => {
    const controller = new MarkdownCollabController(output);
    try {
      const seen: string[] = [];
      controller.onDidExternalSidecarChange((p) => seen.push(p));
      controller.onExternalChange("/ws/docs/a.md");
      controller.onExternalChange("/ws/docs/b.md");
      expect(seen).toEqual(["/ws/docs/a.md", "/ws/docs/b.md"]);
    } finally {
      controller.dispose();
    }
  });
});

describe("findCommentIdForThread", () => {
  // Rebuild the minimal thread shape the helper uses. The production code
  // passes vscode.CommentThread objects; here we model them as { range }.
  function makeThread(r: Range): { range: Range } {
    return { range: r };
  }

  it("returns the comment id for a thread matched by object identity", () => {
    const tA = makeThread(new Range(0, 0, 0, 10));
    const tB = makeThread(new Range(5, 0, 5, 8));
    const entries = [
      { thread: tA, commentId: "c_aaaaaaaa" },
      { thread: tB, commentId: "c_bbbbbbbb" },
    ];
    expect(findCommentIdForThread(entries, tB)).toBe("c_bbbbbbbb");
  });

  it("falls back to range equality when identity misses (post-reload)", () => {
    // Original entry registered at reload time.
    const originalThread = makeThread(new Range(5, 0, 5, 8));
    // Simulate a reload: the map has been rebuilt with a brand-new thread
    // object at the same range. VS Code still dispatches against the
    // original thread reference.
    const rebuiltThread = makeThread(new Range(5, 0, 5, 8));
    const entries = [{ thread: rebuiltThread, commentId: "c_cccccccc" }];
    expect(findCommentIdForThread(entries, originalThread)).toBe("c_cccccccc");
  });

  it("returns undefined when neither identity nor range matches", () => {
    const tA = makeThread(new Range(0, 0, 0, 10));
    const entries = [{ thread: tA, commentId: "c_aaaaaaaa" }];
    const stranger = makeThread(new Range(100, 0, 100, 5));
    expect(findCommentIdForThread(entries, stranger)).toBeUndefined();
  });

  it("returns undefined on empty entries", () => {
    const stranger = makeThread(new Range(0, 0, 0, 1));
    expect(findCommentIdForThread([], stranger)).toBeUndefined();
  });
});
