import { describe, expect, it } from "vitest";
import { locateAnchorInLiveText } from "../collab/liveAnchorLocator";

describe("locateAnchorInLiveText", () => {
  it("returns the unique hit when text appears once", () => {
    const haystack = "alpha beta gamma";
    const r = locateAnchorInLiveText(haystack, {
      text: "beta",
      contextBefore: "alpha ",
      contextAfter: " gamma",
    });
    expect(r).toEqual({ start: 6, end: 10 });
  });

  it("disambiguates duplicates by stored context", () => {
    const haystack = "Section A\nfoo bar baz.\n\nSection B\nfoo qux quux.";
    const r = locateAnchorInLiveText(haystack, {
      text: "foo",
      contextBefore: "Section B\n",
      contextAfter: " qux",
    });
    // Should resolve to the SECOND "foo" (under Section B), not the first.
    expect(r).not.toBeNull();
    expect(r!.start).toBe(haystack.indexOf("foo qux"));
  });

  it("orphans (null) when duplicates and context disagrees with all hits", () => {
    // This is the regression: previously the loose loop + first-hit
    // fallback would silently pick the first occurrence.
    const haystack = "Section A\nfoo bar.\n\nSection B\nfoo qux.";
    const r = locateAnchorInLiveText(haystack, {
      text: "foo",
      contextBefore: "Section C\n", // matches neither
      contextAfter: " zzz",         // matches neither
    });
    expect(r).toBeNull();
  });

  it("orphans when duplicates and only one side of context matches", () => {
    // Old behaviour: loose loop accepted single-side overlap → first hit.
    // New behaviour: require BOTH non-empty sides to match.
    const haystack = "Section A\nfoo bar.\n\nSection B\nfoo qux.";
    const r = locateAnchorInLiveText(haystack, {
      text: "foo",
      contextBefore: "Section A\n", // matches hit #1 only
      contextAfter: " qux",          // matches hit #2 only
    });
    expect(r).toBeNull();
  });

  it("orphans when single hit is present but stored context disagrees AND no normalised match", () => {
    const haystack = "alpha beta gamma";
    const r = locateAnchorInLiveText(haystack, {
      text: "beta",
      contextBefore: "zzz",
      contextAfter: "yyy",
    });
    expect(r).toBeNull();
  });

  it("accepts unique hit when no context is stored", () => {
    const r = locateAnchorInLiveText("alpha beta gamma", {
      text: "beta",
      contextBefore: "",
      contextAfter: "",
    });
    expect(r).toEqual({ start: 6, end: 10 });
  });

  it("returns null when multiple hits and no context is stored", () => {
    const r = locateAnchorInLiveText("foo and foo", {
      text: "foo",
      contextBefore: "",
      contextAfter: "",
    });
    expect(r).toBeNull();
  });

  it("falls back to whitespace-normalised match when source had collapsed runs", () => {
    // Stored anchor used two spaces; live text has single space.
    const haystack = "alpha beta gamma";
    const r = locateAnchorInLiveText(haystack, {
      text: "beta",
      contextBefore: "alpha  ",
      contextAfter: "  gamma",
    });
    expect(r).not.toBeNull();
    expect(r!.start).toBe(6);
    expect(r!.end).toBe(10);
  });

  it("returns null when anchor text is empty / whitespace-only", () => {
    expect(
      locateAnchorInLiveText("anything", {
        text: "   ",
        contextBefore: "",
        contextAfter: "",
      }),
    ).toBeNull();
  });
});
