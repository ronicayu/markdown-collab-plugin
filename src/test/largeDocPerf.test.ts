// Performance headroom on documents bigger than anything hand-written
// (10x-plan P3.2).
//
// The engine is O(n) in places that used to be O(n²) — `findProseIndex` was a
// linear scan called twice per thread, so building the preview for a doc with
// 200 threads scanned the file 400 times — and the write path used to rewrite
// the whole file for a one-line change. These tests pin both.
//
// The timing budgets are deliberately loose (seconds, for work that takes
// milliseconds). They exist to catch a return to quadratic behavior, not to
// measure the machine: a budget tight enough to be a benchmark would be a
// flaky test on shared CI runners.

import { describe, expect, it } from "vitest";
import { addThread, parse } from "../inlineComments/format";
import { minimalEdit } from "../inlineComments/minimalEdit";
import { applyClientMutation } from "../inlineComments/mutations";
import { mapProseToSource } from "../inlineComments/proseMapping";

const CTX = { author: "tester", now: () => "2026-07-28T12:00:00.000Z" };

/** ~500 KB of realistic prose: headings, paragraphs, code, tables, lists. */
function buildLargeDoc(): string {
  const parts: string[] = ["# Large document\n"];
  for (let section = 0; section < 560; section++) {
    parts.push(`\n## Section ${section}\n`);
    for (let p = 0; p < 4; p++) {
      parts.push(
        `\nParagraph ${p} of section ${section} describes the retry policy, ` +
          `which uses exponential backoff with a cap of ${section * 10 + p} seconds ` +
          `and surfaces its state through the metrics endpoint documented below.\n`,
      );
    }
    parts.push("\n```ts\nconst timeout = " + section + ";\n```\n");
    parts.push("\n| Flag | Default |\n|---|---|\n| `--retry` | 3 |\n| `--timeout` | 30 |\n");
    parts.push("\n- first item\n- second item\n- third item\n");
  }
  return parts.join("");
}

const LARGE = buildLargeDoc();

/** Anchor `count` threads spread through the document. */
function withThreads(source: string, count: number): string {
  let out = source;
  for (let i = 0; i < count; i++) {
    // Anchor on a phrase unique to each section so the anchors spread out.
    const needle = `cap of ${i * 10} seconds`;
    const at = out.indexOf(needle);
    if (at === -1) continue;
    out = addThread(out, at, at + needle.length, {
      author: "claude",
      body: `Thread ${i}: is this cap documented?`,
      ts: CTX.now(),
    }).source;
  }
  return out;
}

/** Run `fn` and return how long it took, in milliseconds. */
function timed<T>(fn: () => T): [T, number] {
  const start = performance.now();
  const value = fn();
  return [value, performance.now() - start];
}

describe("large document (~500 KB)", () => {
  it("is actually large enough to be worth measuring", () => {
    expect(LARGE.length).toBeGreaterThan(450_000);
  });

  it("parses in well under a second", () => {
    const [parsed, ms] = timed(() => parse(LARGE));
    expect(parsed.threads).toEqual([]);
    expect(ms).toBeLessThan(2000);
  });

  it("builds the prose mapping for a doc with 200 threads without going quadratic", () => {
    const doc = withThreads(LARGE, 200);
    const parsed = parse(doc);
    expect(parsed.threads.length).toBeGreaterThan(150);
    const [mapping, ms] = timed(() => mapProseToSource(parsed));
    // Every thread must come back anchored — a fast wrong answer is no good.
    expect(mapping.anchorsInProse.size).toBe(parsed.threads.length);
    expect(ms).toBeLessThan(2000);
  });

  it("anchor lookups stay correct at scale", () => {
    const doc = withThreads(LARGE, 50);
    const parsed = parse(doc);
    const { prose, anchorsInProse } = mapProseToSource(parsed);
    for (const t of parsed.threads) {
      const range = anchorsInProse.get(t.id)!;
      expect(prose.slice(range.proseStart, range.proseEnd)).toBe(t.quote);
    }
  });

  it("replies to a thread with a small edit, not a whole-file rewrite", () => {
    const doc = withThreads(LARGE, 100);
    const parsed = parse(doc);
    const threadId = parsed.threads[0]!.id;
    const { source } = applyClientMutation(parsed, { type: "reply", threadId, body: "60s." }, CTX);

    const change = minimalEdit(doc, source)!;
    expect(change).not.toBeNull();
    // The replacement is one thread line, not the 500 KB document.
    expect(change.replacement.length).toBeLessThan(2000);
    expect(change.end - change.start).toBeLessThan(2000);
    // And it lands in the threads region, not in the prose.
    expect(doc.slice(0, change.start)).toContain("<!--mc:threads:begin-->");
  });

  it("adding a comment leaves everything before the anchor untouched", () => {
    const doc = withThreads(LARGE, 20);
    const parsed = parse(doc);
    const { prose } = mapProseToSource(parsed);
    const needle = "metrics endpoint";
    const selStart = prose.indexOf(needle);
    const { source, warning } = applyClientMutation(
      parsed,
      { type: "add-comment", selStart, selEnd: selStart + needle.length, body: "which one?" },
      CTX,
    );
    expect(warning).toBeUndefined();

    const change = minimalEdit(doc, source)!;
    // A new comment writes markers at the anchor AND a thread line at the end
    // of the file. Those are far apart, so a single-span edit necessarily
    // covers the distance between them — collapsing two changes into one is
    // the documented trade in minimalEdit. What must hold is that the edit
    // STARTS at the anchor: every byte of prose above it is left alone.
    expect(change.start).toBeGreaterThan(0);
    expect(doc.slice(0, change.start)).not.toContain("metrics endpoint");
    expect(doc.slice(change.start, change.start + 40)).toContain("metrics endpoint");
    expect(source.length).toBeGreaterThan(doc.length);
  });

  it("resolves 100 threads in sequence without blowing up", () => {
    const doc = withThreads(LARGE, 100);
    const [result, ms] = timed(() => {
      let current = doc;
      for (const t of parse(doc).threads) {
        current = applyClientMutation(parse(current), { type: "toggle-resolve", threadId: t.id }, CTX)
          .source;
      }
      return current;
    });
    const parsed = parse(result);
    expect(parsed.threads.every((t) => t.status === "resolved")).toBe(true);
    expect(parsed.unanchoredThreadIds).toEqual([]);
    // 100 full parse+serialize round trips over 500 KB. Generous, but a
    // regression to quadratic anchoring blows straight through it.
    expect(ms).toBeLessThan(30_000);
  });
});
