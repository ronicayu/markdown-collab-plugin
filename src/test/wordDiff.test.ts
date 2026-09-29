import { describe, expect, it } from "vitest";
import { diffWords, isBulkRewrite, suggestionGist, tokenize } from "../webviewShared/wordDiff";

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
