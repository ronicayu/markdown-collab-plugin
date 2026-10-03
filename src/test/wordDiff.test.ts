import { describe, expect, it } from "vitest";
import {
  diffTokens,
  diffWords,
  exceedsTokenCap,
  isBulkRewrite,
  MAX_DIFF_TOKENS,
  suggestionGist,
  tokenize,
} from "../webviewShared/wordDiff";

describe("tokenize", () => {
  it("splits into words, whitespace, and single punctuation marks", () => {
    expect(tokenize("Release notes")).toEqual(["Release", " ", "notes"]);
    expect(tokenize("Wait, really?")).toEqual(["Wait", ",", " ", "really", "?"]);
  });

  it("joins back into the exact original string", () => {
    const s = "The parser handles nested lists correctly.\n";
    expect(tokenize(s).join("")).toBe(s);
  });

  it("handles an empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("diffWords", () => {
  it("is a single equal run for identical text", () => {
    const ops = diffWords("same text", "same text");
    expect(ops).toEqual([{ kind: "equal", text: "same text" }]);
  });

  it("finds a single-word swap inside a shared sentence", () => {
    const ops = diffWords("Release notes", "Release highlights");
    expect(ops).toEqual([
      { kind: "equal", text: "Release " },
      { kind: "del", text: "notes" },
      { kind: "ins", text: "highlights" },
    ]);
  });

  it("reproduces both sides by concatenating del/equal and ins/equal runs", () => {
    const original = "The quick brown fox";
    const proposed = "The slow brown fox jumps";
    const ops = diffWords(original, proposed);
    const oldSide = ops.filter((o) => o.kind !== "ins").map((o) => o.text).join("");
    const newSide = ops.filter((o) => o.kind !== "del").map((o) => o.text).join("");
    expect(oldSide).toBe(original);
    expect(newSide).toBe(proposed);
  });

  it("is a pure insertion when the original is empty", () => {
    expect(diffWords("", "new text")).toEqual([{ kind: "ins", text: "new text" }]);
  });

  it("is a pure deletion when the proposed is empty", () => {
    expect(diffWords("old text", "")).toEqual([{ kind: "del", text: "old text" }]);
  });
});

describe("isBulkRewrite", () => {
  it("is false for a single-word change in a short sentence", () => {
    expect(isBulkRewrite("Release notes", "Release highlights")).toBe(false);
  });

  it("is false for identical text", () => {
    expect(isBulkRewrite("no change here", "no change here")).toBe(false);
  });

  it("is true once more than 60% of the longer side's words differ", () => {
    const original = "The quick brown fox jumps over the lazy dog";
    const proposed = "A sleepy turtle crawls beneath a warm blanket softly";
    expect(isBulkRewrite(original, proposed)).toBe(true);
  });

  it("is true once either side is longer than the length guard, even for a small edit", () => {
    const long = "word ".repeat(150); // 750 chars, well past the 600-char guard
    expect(isBulkRewrite(long, long + "!")).toBe(true);
  });
});

describe("exceedsTokenCap", () => {
  it("is false under the cap", () => {
    expect(exceedsTokenCap("word ".repeat(100))).toBe(false);
  });

  it("is true once a side tokenizes to more than MAX_DIFF_TOKENS tokens", () => {
    const huge = "word ".repeat(MAX_DIFF_TOKENS + 1); // one "word" + one space token each
    expect(exceedsTokenCap(huge)).toBe(true);
  });
});

// Security review (round-9 P1.1): a suggestion with tens of thousands of
// words per side, or ~100KB per side, must never reach `diffTokens`' O(n·m)
// table — that's what froze the webview (seconds and hundreds of MB at 8k
// words/side; gigabytes at 100KB/side). `isBulkRewrite` is the one function
// on the hot path that every render calls unconditionally (`commentUi.ts`
// checks it before ever building an inline diff), so pinning its time here
// is what stands in for "never calls the LCS" — an O(n·m) table for 100,000
// tokens couldn't finish anywhere near this budget, let alone allocate.
describe("isBulkRewrite / exceedsTokenCap never run the O(n·m) diff on huge input", () => {
  it("resolves a 100KB-per-side suggestion in well under 200ms", () => {
    const original = "lorem ipsum dolor sit amet ".repeat(3800); // ~100KB
    const proposed = "consectetur adipiscing elit sed do ".repeat(2900); // ~100KB, different words
    expect(original.length).toBeGreaterThan(100_000);
    expect(proposed.length).toBeGreaterThan(100_000);

    const start = performance.now();
    const bulk = isBulkRewrite(original, proposed);
    const capped = exceedsTokenCap(original) || exceedsTokenCap(proposed);
    const elapsed = performance.now() - start;

    expect(bulk).toBe(true);
    expect(capped).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  it("resolves an 8k-word-per-side suggestion (the reviewer's freeze case) in well under 200ms", () => {
    const original = "alpha beta gamma delta epsilon ".repeat(1600); // 8k words
    const proposed = "zeta eta theta iota kappa ".repeat(1600); // 8k words, all different
    const start = performance.now();
    const bulk = isBulkRewrite(original, proposed);
    const elapsed = performance.now() - start;
    expect(bulk).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  // Control: shows the thing being guarded against is genuinely expensive
  // relative to the guarded path, so the fast times above are the guard
  // working rather than `diffTokens` secretly being cheap at this scale — a
  // fixed millisecond threshold here would be flaky across machines, so this
  // compares the guarded call against a real (smaller, to keep the suite's
  // own memory/CPU use sane) quadratic call on the same run's hardware.
  it("diffTokens grows quadratically — the guard's cost doesn't scale the same way", () => {
    const guardedStart = performance.now();
    isBulkRewrite("lorem ipsum dolor sit amet ".repeat(3800), "consectetur adipiscing elit sed do ".repeat(2900));
    const guardedElapsed = performance.now() - guardedStart;

    const a = tokenize("word ".repeat(3000));
    const b = tokenize("term ".repeat(3000));
    const unguardedStart = performance.now();
    diffTokens(a, b);
    const unguardedElapsed = performance.now() - unguardedStart;

    expect(unguardedElapsed).toBeGreaterThan(guardedElapsed * 5);
  });
});

describe("suggestionGist", () => {
  it("quotes the removed and added words for a swap", () => {
    expect(suggestionGist("Release notes", "Release highlights")).toBe('"notes" → "highlights"');
  });

  it("reads as a pure addition when nothing was removed", () => {
    expect(suggestionGist("Release", "Release notes")).toBe('adds "notes"');
  });

  it("reads as a pure removal when nothing was added", () => {
    expect(suggestionGist("Release notes", "Release")).toBe('removes "notes"');
  });

  it("falls back to a size description past the bulk-rewrite guard", () => {
    const original = "The quick brown fox jumps over the lazy dog";
    const proposed = "A sleepy turtle crawls beneath a warm blanket softly";
    expect(isBulkRewrite(original, proposed)).toBe(true);
    expect(suggestionGist(original, proposed)).toBe(
      `rewrites the passage (${original.length} → ${proposed.length} chars)`,
    );
  });

  it("truncates a long quoted span rather than dumping the whole thing", () => {
    const addition = "a".repeat(80);
    const gist = suggestionGist("start", `start ${addition}`);
    expect(gist).toContain("…");
    expect(gist.length).toBeLessThan(addition.length);
  });

  it("says so plainly for identical text", () => {
    expect(suggestionGist("same", "same")).toBe("no change");
  });
});
