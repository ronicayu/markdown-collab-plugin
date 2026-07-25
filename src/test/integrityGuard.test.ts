// Tests for the watch-time integrity guard (10x-plan P0.2).

import { describe, expect, it, vi } from "vitest";
import { addThread, parse } from "../inlineComments/format";
import { repairIntegrity } from "../inlineComments/integrity";
import { IntegrityGuard, evaluateDocument, summarize } from "../inlineComments/integrityGuard";

const TS = "2026-07-25T12:00:00.000Z";
const DOC = "# Guide\n\nThe retry policy uses exponential backoff.\n";

function withThread(): { source: string; id: string } {
  const at = DOC.indexOf("exponential backoff");
  const r = addThread(DOC, at, at + "exponential backoff".length, {
    author: "ronica",
    body: "configurable?",
    ts: TS,
  });
  return { source: r.source, id: r.thread.id };
}

describe("evaluateDocument", () => {
  it("ignores files with no inline-comment markup", () => {
    expect(evaluateDocument("/a.md", "# Just a doc\n\nNothing to see.\n")).toBeNull();
  });

  it("ignores healthy documents", () => {
    const { source } = withThread();
    expect(evaluateDocument("/a.md", source)).toBeNull();
  });

  it("reports a dropped closing marker", () => {
    const { source, id } = withThread();
    const broken = source.replace(`<!--mc:/a:${id}-->`, "");
    const d = evaluateDocument("/a.md", broken);
    expect(d).not.toBeNull();
    expect(d!.issues.map((i) => i.kind)).toContain("unpaired-marker");
    expect(d!.repairableCount).toBeGreaterThan(0);
  });

  it("reports damage in a file whose threads region was destroyed but anchors remain", () => {
    // This is why the guard must not reuse the tree view's threads-region
    // fast-path: there is no threads region left to find.
    const { source } = withThread();
    const begin = source.indexOf("<!--mc:threads:begin-->");
    const orphaned = source.slice(0, begin);
    const d = evaluateDocument("/a.md", orphaned);
    expect(d).not.toBeNull();
    expect(d!.issues.map((i) => i.kind)).toContain("orphan-anchor");
  });

  it("reports malformed thread JSON as unrepairable", () => {
    const { source, id } = withThread();
    const broken = source.replace(`"id":"${id}"`, `"id":"${id}",,`);
    const d = evaluateDocument("/a.md", broken)!;
    const issue = d.issues.find((i) => i.kind === "malformed-thread-json");
    expect(issue).toBeDefined();
    expect(issue!.repairable).toBe(false);
  });
});

describe("IntegrityGuard dedup", () => {
  it("reports a problem once, not on every change", () => {
    const guard = new IntegrityGuard();
    const { source, id } = withThread();
    const broken = source.replace(`<!--mc:/a:${id}-->`, "");

    expect(guard.consider("/a.md", broken)).not.toBeNull();
    expect(guard.consider("/a.md", broken)).toBeNull();
    expect(guard.consider("/a.md", broken)).toBeNull();
  });

  it("reports again when the damage changes", () => {
    const guard = new IntegrityGuard();
    const { source, id } = withThread();
    const dropClose = source.replace(`<!--mc:/a:${id}-->`, "");
    expect(guard.consider("/a.md", dropClose)).not.toBeNull();

    // A different problem set is new information.
    const alsoBadJson = dropClose.replace(`"id":"${id}"`, `"id":"${id}",,`);
    expect(guard.consider("/a.md", alsoBadJson)).not.toBeNull();
  });

  it("re-reports damage that reappears after the file was healthy", () => {
    const guard = new IntegrityGuard();
    const { source, id } = withThread();
    const broken = source.replace(`<!--mc:/a:${id}-->`, "");

    expect(guard.consider("/a.md", broken)).not.toBeNull();
    expect(guard.consider("/a.md", source)).toBeNull(); // healed
    expect(guard.consider("/a.md", broken)).not.toBeNull(); // broke again
  });

  it("tracks files independently", () => {
    const guard = new IntegrityGuard();
    const { source, id } = withThread();
    const broken = source.replace(`<!--mc:/a:${id}-->`, "");
    expect(guard.consider("/a.md", broken)).not.toBeNull();
    expect(guard.consider("/b.md", broken)).not.toBeNull();
  });

  it("forgets a deleted file", () => {
    const guard = new IntegrityGuard();
    const { source, id } = withThread();
    const broken = source.replace(`<!--mc:/a:${id}-->`, "");
    expect(guard.consider("/a.md", broken)).not.toBeNull();
    guard.forget("/a.md");
    expect(guard.consider("/a.md", broken)).not.toBeNull();
  });
});

describe("summarize", () => {
  it("leads with the count and says what can be repaired", () => {
    const { source, id } = withThread();
    const d = evaluateDocument("/x/a.md", source.replace(`<!--mc:/a:${id}-->`, ""))!;
    const text = summarize(d, "a.md");
    expect(text).toMatch(/^\d+ comment-anchor problems? in a\.md\./);
    expect(text).toMatch(/repaired automatically/);
  });

  it("says plainly when nothing can be repaired", () => {
    const { source, id } = withThread();
    // Delete the markers and the text, so the quote cannot be relocated.
    const gone = source.replace(
      `<!--mc:a:${id}-->exponential backoff<!--mc:/a:${id}-->`,
      "",
    );
    const d = evaluateDocument("/x/a.md", gone)!;
    expect(summarize(d, "a.md")).toContain("None can be repaired automatically.");
  });
});

describe("acceptance: corrupt a marker with a raw edit", () => {
  it("is repaired when the quote is unique, and never touches prose", () => {
    const { source, id } = withThread();
    const broken = source.replace(`<!--mc:/a:${id}-->`, "");

    const decision = evaluateDocument("/a.md", broken);
    expect(decision).not.toBeNull();

    const repaired = repairIntegrity(broken);
    expect(repaired.remaining).toEqual([]);
    expect(parse(repaired.source).unanchoredThreadIds).toEqual([]);
    // Repair restored the document exactly as it was before the corruption.
    expect(repaired.source).toBe(source);
  });

  it("is flagged, not guessed at, when the quote is ambiguous", () => {
    const doc = "# D\n\nThe token expires. The token refreshes.\n";
    const at = doc.indexOf("token");
    const { source: withT, thread } = addThread(doc, at, at + 5, {
      author: "ronica",
      body: "which?",
      ts: TS,
    });
    const gone = withT
      .split(`<!--mc:a:${thread.id}-->`)
      .join("")
      .split(`<!--mc:/a:${thread.id}-->`)
      .join("");

    const decision = evaluateDocument("/a.md", gone)!;
    expect(decision.issues.some((i) => i.kind === "unanchored-thread")).toBe(true);
    expect(decision.repairableCount).toBe(0);

    const repaired = repairIntegrity(gone);
    expect(repaired.repairs).toEqual([]);
    expect(repaired.source).toBe(gone);
  });
});

describe("ReviewView integration", () => {
  it("notifies once for a damaged file seen through the watcher", async () => {
    const { ReviewView } = await import("../reviewView");
    const { source, id } = withThread();
    const broken = source.replace(`<!--mc:/a:${id}-->`, "");
    const onIntegrityIssues = vi.fn();

    const output = { appendLine: vi.fn() } as unknown as import("vscode").OutputChannel;
    const view = new ReviewView(output, {
      findFiles: async () => [],
      readFile: async () => broken,
      watch: () => ({ dispose: () => {} }),
      onIntegrityIssues,
    });

    // readEntry is private; drive it the way the watcher does.
    await (view as unknown as { readEntry(p: string): Promise<unknown> }).readEntry("/w/a.md");
    expect(onIntegrityIssues).toHaveBeenCalledTimes(1);
    expect(onIntegrityIssues.mock.calls[0][0].fsPath).toBe("/w/a.md");

    await (view as unknown as { readEntry(p: string): Promise<unknown> }).readEntry("/w/a.md");
    expect(onIntegrityIssues).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("stays silent for healthy files", async () => {
    const { ReviewView } = await import("../reviewView");
    const { source } = withThread();
    const onIntegrityIssues = vi.fn();
    const output = { appendLine: vi.fn() } as unknown as import("vscode").OutputChannel;
    const view = new ReviewView(output, {
      findFiles: async () => [],
      readFile: async () => source,
      watch: () => ({ dispose: () => {} }),
      onIntegrityIssues,
    });
    await (view as unknown as { readEntry(p: string): Promise<unknown> }).readEntry("/w/a.md");
    expect(onIntegrityIssues).not.toHaveBeenCalled();
    view.dispose();
  });
});
