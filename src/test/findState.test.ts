import { describe, expect, it } from "vitest";
import { findCountLabel, findMatchesIn, stepIndex } from "../webviewShared/findState";

describe("findMatchesIn", () => {
  const spans = (text: string, q: string) =>
    findMatchesIn(text, q).map((m) => text.slice(m.start, m.end));

  it("finds every occurrence, in order", () => {
    expect(findMatchesIn("ab ab ab", "ab")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
  });

  it("is case-insensitive but reports the source casing", () => {
    expect(spans("Claude and CLAUDE and claude", "claude")).toEqual([
      "Claude",
      "CLAUDE",
      "claude",
    ]);
  });

  it("does not overlap matches", () => {
    // "aaaa" contains "aa" twice non-overlapping, not three times.
    expect(findMatchesIn("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("matches nothing for an empty query", () => {
    expect(findMatchesIn("anything", "")).toEqual([]);
  });

  it("returns nothing when the query is longer than the text", () => {
    expect(findMatchesIn("ab", "abc")).toEqual([]);
  });

  it("treats the query literally, not as a regex", () => {
    expect(spans("a.c and abc", "a.c")).toEqual(["a.c"]);
    expect(findMatchesIn("abc", "a.c")).toEqual([]);
  });

  it("finds a match at the very end of the text", () => {
    expect(findMatchesIn("xyz", "z")).toEqual([{ start: 2, end: 3 }]);
  });

  it("handles a query with regex-special characters", () => {
    expect(spans("cost is $5 (net)", "(net)")).toEqual(["(net)"]);
  });
});

describe("stepIndex", () => {
  it("advances forward", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
  });

  it("wraps forward past the end", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
  });

  it("wraps backward past the start", () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  it("moves from the pre-search sentinel to the first match", () => {
    expect(stepIndex(-1, 1, 3)).toBe(0);
  });

  it("stays at the sentinel with nothing to step through", () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
    expect(stepIndex(-1, -1, 0)).toBe(-1);
  });

  it("is a no-op on a single match", () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, -1, 1)).toBe(0);
  });
});

describe("findCountLabel", () => {
  it("is blank before anything is typed", () => {
    expect(findCountLabel("", -1, 0)).toEqual({ text: "", empty: false });
  });

  it("reports an empty result set", () => {
    expect(findCountLabel("nope", -1, 0)).toEqual({ text: "No results", empty: true });
  });

  it("counts from 1, not 0", () => {
    expect(findCountLabel("hit", 0, 12)).toEqual({ text: "1 / 12", empty: false });
    expect(findCountLabel("hit", 11, 12)).toEqual({ text: "12 / 12", empty: false });
  });
});
