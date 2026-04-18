import { describe, it, expect } from "vitest";
import { isAnchorTextValid, resolve } from "../anchor";
import type { Anchor } from "../types";

function anchor(
  text: string,
  contextBefore = "",
  contextAfter = "",
): Anchor {
  return { text, contextBefore, contextAfter };
}

describe("isAnchorTextValid", () => {
  it("returns false for a whitespace-only anchor text", () => {
    expect(isAnchorTextValid("   \t\n  ")).toBe(false);
  });

  it("returns false when there are only 7 non-whitespace chars buried in whitespace", () => {
    // "abc def1" = 7 non-ws chars spread across whitespace
    expect(isAnchorTextValid("  abc  def1  ")).toBe(false);
  });

  it("returns true when there are exactly 8 non-whitespace chars", () => {
    expect(isAnchorTextValid("  abcd efgh  ")).toBe(true);
  });
});

describe("resolve", () => {
  it("returns start/end for a single exact match", () => {
    const text = "Hello world, this is a test document.";
    const result = resolve(text, anchor("this is a test"));
    expect(result).toEqual({ start: 13, end: 27 });
    expect(text.slice(13, 27)).toBe("this is a test");
  });

  it("resolves an anchor at the very start of the document (empty contextBefore)", () => {
    const text = "Introduction paragraph leads the document.";
    const result = resolve(text, anchor("Introduction", "", " paragr"));
    expect(result).toEqual({ start: 0, end: "Introduction".length });
  });

  it("disambiguates two occurrences of the same text via contextBefore", () => {
    const text = "Alpha section: shared phrase here.\nBeta section: shared phrase here.";
    const result = resolve(
      text,
      anchor("shared phrase", "Beta section: ", ""),
    );
    const firstHit = text.indexOf("shared phrase");
    const expectedStart = text.indexOf("shared phrase", firstHit + 1);
    expect(result).toEqual({
      start: expectedStart,
      end: expectedStart + "shared phrase".length,
    });
  });

  it("disambiguates using contextAfter when contextBefore is empty", () => {
    const text = "repeatable here and repeatable there.";
    const result = resolve(text, anchor("repeatable", "", " there"));
    const firstHit = text.indexOf("repeatable");
    const expectedStart = text.indexOf("repeatable", firstHit + 1);
    expect(result).toEqual({
      start: expectedStart,
      end: expectedStart + "repeatable".length,
    });
  });

  it("resolves an anchor at the very end of the document (empty contextAfter)", () => {
    const text = "The quick brown fox jumps over";
    const result = resolve(text, anchor("jumps over", " fox ", ""));
    // only one occurrence, context is irrelevant but empty contextAfter shouldn't hurt.
    expect(result).toEqual({ start: text.length - "jumps over".length, end: text.length });
  });

  it("returns null when two occurrences have identical context on both sides (ambiguous)", () => {
    const line = "prefix foo bar baz suffix";
    const text = line + "\n" + line;
    // "foo bar baz" appears twice, surrounded by identical "prefix " and " suffix" on each line.
    const result = resolve(text, anchor("foo bar baz", "prefix ", " suffix"));
    expect(result).toBeNull();
  });

  it("returns null when the anchor text is not present at all", () => {
    const text = "only these words exist here";
    const result = resolve(text, anchor("nonexistent phrase"));
    expect(result).toBeNull();
  });

  it("returns null on empty text without crashing", () => {
    expect(resolve("", anchor("anything"))).toBeNull();
  });

  it("returns null when anchor text is longer than the entire text", () => {
    const result = resolve("short", anchor("this is way longer than the text"));
    expect(result).toBeNull();
  });

  it("falls back to whitespace-normalized match when text differs only by extra spaces", () => {
    // Document has extra whitespace between words compared to the anchor text.
    const text = "Here is   the    quick brown   fox jumping over logs.";
    const result = resolve(
      text,
      anchor("the quick brown fox jumping", "", ""),
    );
    expect(result).not.toBeNull();
    const slice = text.slice(result!.start, result!.end);
    // The resolved range should start at "the" and end right after "jumping"
    // in the original text.
    expect(slice.startsWith("the")).toBe(true);
    expect(slice.endsWith("jumping")).toBe(true);
    // And when the returned slice is whitespace-normalized it should match the anchor.
    expect(slice.replace(/\s+/g, " ")).toBe("the quick brown fox jumping");
  });

  it("falls back to whitespace-normalized match across Windows CRLF line endings", () => {
    // Anchor was authored against LF; document was saved with CRLF.
    const text = "line one line\r\ntwo line three";
    const result = resolve(text, anchor("line\ntwo line", "", ""));
    expect(result).not.toBeNull();
    const slice = text.slice(result!.start, result!.end);
    expect(slice.replace(/\s+/g, " ")).toBe("line two line");
  });

  it("tolerates contextBefore being a suffix of the actual preceding text (endsWith)", () => {
    // anchor.contextBefore is shorter than the full preceding text —
    // we accept if the actual preceding text endsWith the stored context.
    const text = "Alpha body: target phrase end.\nBeta body: target phrase end.";
    const result = resolve(
      text,
      // stored contextBefore is just the tail "Beta body: "
      anchor("target phrase", "Beta body: ", ""),
    );
    const firstHit = text.indexOf("target phrase");
    const expectedStart = text.indexOf("target phrase", firstHit + 1);
    expect(result).toEqual({
      start: expectedStart,
      end: expectedStart + "target phrase".length,
    });
  });

  it("returns null when multiple occurrences match but none satisfy context", () => {
    // Three identical occurrences, contextBefore doesn't match any of them.
    const text = "xx needle xx\nyy needle yy\nzz needle zz";
    const result = resolve(
      text,
      anchor("needle", "DOESNOTMATCH ", ""),
    );
    expect(result).toBeNull();
  });

  it("accepts a single exact hit when stored context matches the surrounding text", () => {
    // Doc A: "rename this" appears once, preceded by "// TODO: ".
    const docA = "some code\n// TODO: rename this foo\nmore code";
    const resultA = resolve(
      docA,
      anchor("rename this", "// TODO: ", ""),
    );
    const expectedStart = docA.indexOf("rename this");
    expect(resultA).toEqual({
      start: expectedStart,
      end: expectedStart + "rename this".length,
    });
  });

  it("does not blindly accept a single exact hit when stored context is present but does not match", () => {
    // Doc B: "rename this" appears exactly once in unrelated prose. The stored
    // contextBefore "// TODO: " does not match the actual preceding text, so the
    // single-hit fast path must NOT fire. Fall through to normalization, which
    // also can't find a better match, so result is null.
    const docB = "Please do not rename this method without review.";
    const resultB = resolve(
      docB,
      anchor("rename this", "// TODO: ", ""),
    );
    expect(resultB).toBeNull();
  });

  it("returns null (does not crash) for a whitespace-only anchor text", () => {
    const text = "Some ordinary document text.";
    const result = resolve(text, anchor("   ", "", ""));
    expect(result).toBeNull();
  });
});
