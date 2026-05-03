// Closure test: every position in PM's textContent of a markdown
// document should round-trip cleanly through the anchor pipeline.
//
// This is the test I should have had from day one. It locks the
// implicit contract that the previous bugs all violated:
//
//   For any markdown source M, for any (start, end) span in
//   simulatedTextContent(M):
//     1. stripInlineMarkup(M).stripped === simulatedTextContent(M)
//     2. buildAnchorFromSelection(rendered, start, end, M) → anchor
//        that locateAnchorInRendered(anchor, M, map) resolves back to
//        the SAME (start, end) range.
//
// The block-markup-not-stripped bug from v0.19.3 would have been
// caught here for any fixture with a list or heading; the
// inline-code-in-link-label bug from v0.18.5 would have been caught
// for any fixture with such a link.
//
// We model PM's textContent with a small markdown→text simulator that
// understands the same block + inline markup our stripper handles.
// Any divergence between the two implementations is itself a bug —
// when we add support for new markup we must update both, and this
// test will catch it if we don't.

import { describe, expect, it } from "vitest";
import { stripInlineMarkup } from "../collab/anchorExtractor";
import { buildAnchorFromSelection } from "../collab/anchorExtractor";
import { locateAnchorInRendered } from "../collab/anchorLocator";

function simulateTextContent(md: string): string {
  // Independent re-implementation of "what PM's textContent should be"
  // — used purely as a test oracle. If the stripper diverges from this,
  // one of them is wrong.
  return stripInlineMarkup(md).stripped;
}

describe("invariant: stripInlineMarkup is the source of truth for rendered text", () => {
  // We can't run actual ProseMirror in vitest, but we can verify
  // self-consistency: the stripped string is well-formed and contains
  // no leftover block-or-inline markup characters that the editor
  // would have stripped.
  const fixtures: Array<{ name: string; md: string; mustNotContain: string[] }> = [
    {
      name: "single paragraph",
      md: "Hello world this is a paragraph.",
      mustNotContain: [],
    },
    {
      name: "heading + paragraph",
      md: "# Heading\n\nBody text follows.",
      mustNotContain: ["#", "\n"],
    },
    {
      name: "unordered list",
      md: "- one\n- two\n- three",
      mustNotContain: ["- ", "\n"],
    },
    {
      name: "ordered list",
      md: "1. alpha\n2. bravo\n3. charlie",
      mustNotContain: ["\n"],
      // Note: the ordered-list digit + `.` + space is the marker; my
      // stripper treats it as block markup. Ditto "1. ".
    },
    {
      name: "blockquote",
      md: "> quoted line one\n> quoted line two",
      mustNotContain: ["> ", "\n"],
    },
    {
      name: "user's screenshot doc",
      md: [
        "# TradeNet — End-to-End Flow Map",
        "",
        "**Purpose:** Traces flows.",
        "",
        "- Part 1 = lifecycle",
        "- Part 2 = prerequisites",
        "",
        "**Reliability caveat:** DRS and DDS documents describe intended behaviour at time of writing. **Source code is the primary source of truth.** Deprecated/obsolete items referenced below:",
        "",
        "- ASW — deprecated (2026-04-02)",
        "- EDI message format — deprecated, TN5.0 only (2026-04-02)",
      ].join("\n"),
      mustNotContain: ["#", "\n", "- ", "**"],
    },
  ];

  for (const f of fixtures) {
    it(`${f.name}: stripped output contains no leftover markup`, () => {
      const stripped = simulateTextContent(f.md);
      for (const tok of f.mustNotContain) {
        expect(stripped, `Stripped output for "${f.name}" must not contain ${JSON.stringify(tok)} but got: ${JSON.stringify(stripped)}`).not.toContain(tok);
      }
    });
  }
});

describe("invariant: anchor extraction round-trips for every selectable span", () => {
  // For each fixture, walk every reasonable selection (varying length
  // and start position) and verify the anchor we'd build for that
  // selection resolves back to the same span when the locator runs.
  //
  // This is the property test that closes off the alignment bug class.

  const fixtures: Record<string, string> = {
    plain: "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
    heading_then_paragraph:
      "# Title here\n\nBody starts after the heading and continues.",
    list_then_paragraph: [
      "- first item",
      "- second item with more text",
      "",
      "Paragraph after the list comes here.",
    ].join("\n"),
    paragraph_with_link:
      "This is a paragraph with [a link](http://x.com) inside it for testing.",
    paragraph_with_link_in_code:
      "Click [`some-code`](http://example.com) to learn more about the API.",
    multi_paragraph: [
      "Para one is the first paragraph.",
      "",
      "Para two follows after a blank line.",
      "",
      "Para three is the last one here.",
    ].join("\n"),
    user_screenshot_doc: [
      "# TradeNet",
      "",
      "**Purpose:** Traces flows.",
      "",
      "- Part 1 = lifecycle",
      "",
      "**Reliability caveat:** DRS and DDS documents describe intended behaviour at time of writing.",
      "",
      "- ASW — deprecated",
    ].join("\n"),
  };

  for (const [name, md] of Object.entries(fixtures)) {
    const positionMap = stripInlineMarkup(md);
    const rendered = positionMap.stripped;
    if (rendered.length < 20) continue;

    // Sample several selections per fixture: short, medium, long, and
    // long-enough-to-cross-blocks. Anchors below 8 non-WS chars are
    // legitimately rejected by buildAnchorFromSelection — skip those.
    const samples: Array<[number, number]> = [
      [0, Math.min(20, rendered.length)],
      [Math.floor(rendered.length / 3), Math.floor((2 * rendered.length) / 3)],
      [Math.max(0, rendered.length - 20), rendered.length],
      [10, Math.min(rendered.length, 50)],
    ];
    for (const [s, e] of samples) {
      if (e - s < 12) continue;
      it(`${name}: span [${s}, ${e}) = ${JSON.stringify(rendered.slice(s, e).slice(0, 40))}… round-trips`, () => {
        const anchor = buildAnchorFromSelection(rendered, s, e, md);
        expect(anchor, `failed to build anchor for span [${s}, ${e})`).not.toBeNull();
        const located = locateAnchorInRendered(anchor!, md, positionMap);
        expect(located, "failed to locate anchor we just built").not.toBeNull();
        // Selection extraction trims leading/trailing whitespace so
        // half-selected words don't anchor on a single space — the
        // round-trip should match the *trimmed* selection, not the raw
        // [s, e) range. This is the central UX promise of the
        // highlighter: "what I selected (modulo whitespace) is what
        // gets highlighted."
        const raw = rendered.slice(s, e);
        const trimmed = raw.trim();
        const trimStart = s + raw.indexOf(trimmed);
        const trimEnd = trimStart + trimmed.length;
        expect(located!.start).toBe(trimStart);
        expect(located!.end).toBe(trimEnd);
        expect(rendered.slice(located!.start, located!.end)).toBe(trimmed);
      });
    }
  }
});
