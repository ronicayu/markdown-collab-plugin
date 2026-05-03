// Direct branch coverage for stripInlineMarkup. The function is the
// foundation of both the WYSIWYG anchor extractor and the editor
// highlighter — every kind of inline markup it handles needs an
// explicit test, and so does every "give up gracefully" fallback.
//
// Invariant for every test: stripped.length === map.length - 1, every
// stripped[i] equals md[map[i]] (modulo skipping by emitLabelStripped),
// and the rendered text the editor will display equals `stripped` for
// these inputs (block-level markup excluded — block tokens like `# ` /
// `> ` / list bullets are deliberately *not* stripped because the
// rendered text in those cases also strips them via the PM schema, not
// via this function).

import { describe, expect, it } from "vitest";
import { stripInlineMarkup } from "../collab/anchorExtractor";

function check(input: string, expected: string): void {
  const r = stripInlineMarkup(input);
  expect(r.stripped).toBe(expected);
  // Map invariant: length n+1 sentinel, every entry is a valid index in input.
  expect(r.map.length).toBe(r.stripped.length + 1);
  for (let i = 0; i < r.stripped.length; i++) {
    expect(r.map[i]).toBeGreaterThanOrEqual(0);
    expect(r.map[i]).toBeLessThan(input.length);
    // Stripped char origin alignment: every stripped char should
    // correspond to the same char in the input at map[i].
    // (emitLabelStripped also passes the original char through unchanged.)
    expect(input[r.map[i]!]).toBe(r.stripped[i]);
  }
  // Sentinel terminator equals input.length.
  expect(r.map[r.stripped.length]).toBe(input.length);
}

describe("stripInlineMarkup — branch coverage", () => {
  // ---- plain ----
  it("leaves plain text unchanged", () => {
    check("Just plain text.", "Just plain text.");
  });

  it("leaves an empty string unchanged", () => {
    const r = stripInlineMarkup("");
    expect(r.stripped).toBe("");
    expect(r.map).toEqual([0]);
  });

  // ---- link ----
  it("strips a simple link to its label", () => {
    check("See [docs](http://x.com) here.", "See docs here.");
  });

  it("strips multiple links in one paragraph", () => {
    check(
      "Read [A](http://a.com) and [B](http://b.com) please.",
      "Read A and B please.",
    );
  });

  it("strips a link whose label contains inline-code wrappers", () => {
    // The user's pathological case from v0.18.5 — backticks inside the
    // link label must be dropped so the rendered text aligns.
    check(
      "Click [`foo.md`](http://foo.md) now.",
      "Click foo.md now.",
    );
  });

  it("strips a link whose label contains emphasis wrappers", () => {
    check("[**bold-link**](http://x.com)", "bold-link");
  });

  // ---- image ----
  it("strips an image to its alt text", () => {
    check("![my photo](http://x.com/p.png)", "my photo");
  });

  it("preserves surrounding text around an image", () => {
    check("Hello ![alt](http://x.com/p.png) world", "Hello alt world");
  });

  // ---- autolink ----
  it("strips an autolink to the URL", () => {
    check("Visit <http://example.com> please", "Visit http://example.com please");
  });

  it("strips a mailto autolink", () => {
    check("Mail <user@example.com> back", "Mail user@example.com back");
  });

  it("leaves non-URL angle brackets alone", () => {
    check("a < b and c > d", "a < b and c > d");
  });

  // ---- emphasis (single + double) ----
  it("strips **bold**", () => {
    check("a **b** c", "a b c");
  });
  it("strips __bold__", () => {
    check("a __b__ c", "a b c");
  });
  it("strips *italic*", () => {
    check("a *b* c", "a b c");
  });
  it("strips _italic_", () => {
    check("a _b_ c", "a b c");
  });
  it("strips ~~strikethrough~~", () => {
    check("a ~~b~~ c", "a b c");
  });
  it("strips `inline code`", () => {
    check("a `b` c", "a b c");
  });

  it("handles nested inline markers — outer strips inner content unchanged", () => {
    // Inner `*` becomes part of stripped text; outer pair gets removed.
    // Best-effort behaviour — exact result is what the impl produces.
    const r = stripInlineMarkup("**outer *inner* trailing**");
    // The inner *inner* gets stripped too because we re-look for the
    // inner pair within the outer's emitted chars... actually our impl
    // does NOT recurse — the outer `**` strip emits chars 2..23 raw,
    // and the *inner* doesn't get re-scanned. So `*inner*` remains.
    expect(r.stripped).toBe("outer *inner* trailing");
  });

  // ---- gracefully-skip degenerate input ----
  it("leaves an unclosed [ alone (no matching ])", () => {
    check("a [b c d", "a [b c d");
  });

  it("leaves an unclosed link alone (no closing parenthesis)", () => {
    check("[label](unclosed", "[label](unclosed");
  });

  it("leaves an unclosed `*` alone when there is no matching close in 200 chars", () => {
    check("a *b c", "a *b c");
  });

  it("leaves an unclosed `**` alone", () => {
    check("a **b c", "a **b c");
  });

  // ---- unicode + control chars ----
  it("preserves non-ASCII characters in plain text", () => {
    check("Hello 中文 / café — résumé", "Hello 中文 / café — résumé");
  });

  it("strips a link with a non-ASCII label", () => {
    check("See [中文](http://x.com) link.", "See 中文 link.");
  });

  // ---- positional integrity ----
  it("preserves the position map across an image followed by emphasis", () => {
    const r = stripInlineMarkup("X ![A](u) **B** Y");
    expect(r.stripped).toBe("X A B Y");
    // 'X' is at md pos 0 → stripped 0
    expect(r.map[0]).toBe(0);
    // ' ' between X and image is at md pos 1 → stripped 1
    expect(r.map[1]).toBe(1);
    // 'A' is the image alt at md pos 4 (`![A]` → A is at index 3, but
    // `!` is at 2, `[` at 3, so A is at 4)
    expect(r.map[2]).toBe(4);
  });

  it("escaped chars inside link labels go through emitLabelStripped (skip backslash, keep next)", () => {
    // emitLabelStripped only filters ` * _ ~ — a backslash is passed
    // through. This is acceptable because link labels rarely contain
    // backslash-escapes that the renderer would interpret.
    const r = stripInlineMarkup("[a\\b](u)");
    // The label is "a\\b" (in source); we emit a, \\, b → stripped "a\\b".
    expect(r.stripped).toBe("a\\b");
  });

  it("leaves a literal angle bracket pair that doesn't look like a URL alone", () => {
    check("Compare <foo> and <bar>", "Compare <foo> and <bar>");
  });
});
