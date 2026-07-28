import { describe, expect, it } from "vitest";
import { minimalEdit } from "../inlineComments/minimalEdit";

/** Apply an edit the way the WorkspaceEdit does, to prove it reconstructs `after`. */
function apply(before: string, edit: ReturnType<typeof minimalEdit>): string {
  if (!edit) return before;
  return before.slice(0, edit.start) + edit.replacement + before.slice(edit.end);
}

describe("minimalEdit", () => {
  it("returns null for identical text", () => {
    expect(minimalEdit("same", "same")).toBeNull();
  });

  it("narrows a mid-string replacement to the changed word", () => {
    const edit = minimalEdit("the quick brown fox", "the quick red fox")!;
    expect(edit.start).toBe(10);
    expect(edit.end).toBe(15);
    expect(edit.replacement).toBe("red");
  });

  it("describes a pure insertion as an empty range", () => {
    const edit = minimalEdit("backoff", "backoff with jitter")!;
    expect(edit.start).toBe(edit.end);
    expect(edit.replacement).toBe(" with jitter");
  });

  it("describes a pure deletion as an empty replacement", () => {
    const edit = minimalEdit("hello cruel world", "hello world")!;
    expect(edit.replacement).toBe("");
    expect("hello cruel world".slice(edit.start, edit.end)).toBe("cruel ");
  });

  it("handles a repeated-character insertion without overlapping bounds", () => {
    // "aa" → "aaa": prefix and suffix both want the same characters.
    const edit = minimalEdit("aa", "aaa")!;
    expect(edit.end).toBeGreaterThanOrEqual(edit.start);
    expect(apply("aa", edit)).toBe("aaa");
  });

  it("handles a repeated-character deletion", () => {
    const edit = minimalEdit("aaa", "aa")!;
    expect(edit.end).toBeGreaterThanOrEqual(edit.start);
    expect(apply("aaa", edit)).toBe("aa");
  });

  it("handles replacing the whole string", () => {
    const edit = minimalEdit("abc", "xyz")!;
    expect(edit.start).toBe(0);
    expect(edit.end).toBe(3);
    expect(edit.replacement).toBe("xyz");
  });

  it("handles emptying a string", () => {
    expect(apply("content", minimalEdit("content", ""))).toBe("");
  });

  it("handles filling an empty string", () => {
    expect(apply("", minimalEdit("", "content"))).toBe("content");
  });

  it("collapses two distant changes into one covering span", () => {
    // Documented trade: not a real diff. Correct, just wider than optimal.
    const before = "start MIDDLE end";
    const after = "START MIDDLE END";
    const edit = minimalEdit(before, after)!;
    expect(apply(before, edit)).toBe(after);
    expect(edit.start).toBe(0);
    expect(edit.end).toBe(before.length);
  });

  it("reconstructs the target for a spread of realistic document edits", () => {
    const doc = [
      "# Guide",
      "",
      "The retry uses exponential backoff.",
      "",
      "<!--mc:threads:begin-->",
      '<!--mc:t {"id":"aaa11","quote":"backoff","status":"open","comments":[]}-->',
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
    const cases = [
      doc.replace('"status":"open"', '"status":"resolved"'),
      doc.replace("exponential backoff", "<!--mc:a:bbb22-->exponential backoff<!--mc:/a:bbb22-->"),
      doc.replace(/<!--mc:t .*-->\n/, ""),
      doc + "trailing addition\n",
      "# Prepended\n\n" + doc,
      doc.replace("# Guide", "# Guide to retries"),
    ];
    for (const after of cases) {
      expect(apply(doc, minimalEdit(doc, after))).toBe(after);
    }
  });

  it("never produces an inverted range", () => {
    const pairs: Array<[string, string]> = [
      ["", ""],
      ["a", ""],
      ["", "a"],
      ["ab", "ba"],
      ["aaaa", "aa"],
      ["aa", "aaaa"],
      ["abcabc", "abc"],
    ];
    for (const [before, after] of pairs) {
      const edit = minimalEdit(before, after);
      if (!edit) continue;
      expect(edit.start).toBeGreaterThanOrEqual(0);
      expect(edit.end).toBeGreaterThanOrEqual(edit.start);
      expect(edit.end).toBeLessThanOrEqual(before.length);
      expect(apply(before, edit)).toBe(after);
    }
  });
});
