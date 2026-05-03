// Reproduces the user's v0.19.3 follow-up bug report: even after the
// block-markup-stripping fix, anchors still misalign in their
// document. The fixture they provided contains shapes my earlier tests
// didn't cover:
//   - Blockquote wrapping a multi-paragraph + list + GFM TABLE block
//   - GFM table separator rows (|---|---|---|) — PM strips these
//     entirely; the stripper must too
//   - GFM table data rows (| a | b | c |) — PM concatenates cells with
//     no separators; the stripper currently keeps every `|`
//   - A link whose label is itself a bracketed expression in a table
//     cell

import { describe, expect, it } from "vitest";
import { stripInlineMarkup } from "../collab/anchorExtractor";
import { locateAnchorInRendered } from "../collab/anchorLocator";

const FIXTURE = `# TradeNet — End-to-End Flow Map

> **Purpose:** Traces every major flow in TN4.1 from trigger to final downstream effect.
>
> **Structure:** This document uses an upstream/downstream model centred on the permit declaration lifecycle:
>
> - **Part 1** = The permit declaration lifecycle (the main stream and its variants)
> - **Part 2** = Upstream prerequisites (what must exist before declarations can flow)
>
> **Reliability caveat:** DRS and DDS documents describe intended behaviour at time of writing, not necessarily what was implemented. **Source code is the primary source of truth.** Deprecated/obsolete items referenced below:
>
> - ASW / ASEAN Single Window — deprecated (2026-04-02)
> - EDI message format — deprecated, TN5.0 is XML-only (2026-04-02)
>
> | Evidence source | Confidence | Notes |
> |---|---|---|
> | Source code (\`legendary4/\`) | High | What actually runs in production |
> | DRS/DDS documents | Medium | May describe intended behaviour that was never implemented |

## Quick Reference — Key Terms

| Term | Meaning |
|------|---------|
| **SC** | Singapore Customs |
| **CA** | Controlling Agency |
`;

describe("user-fixture alignment", () => {
  it("stripped text contains no `|` chars (table cell separators)", () => {
    const r = stripInlineMarkup(FIXTURE);
    expect(r.stripped, `stripped:\n${r.stripped}`).not.toContain("|");
  });

  it("stripped text contains no table separator-row sequences (|---|)", () => {
    const r = stripInlineMarkup(FIXTURE);
    expect(r.stripped).not.toMatch(/-{3,}/);
  });

  it("anchor 'Deprecated/obsolete items referenced below' resolves cleanly", () => {
    const r = stripInlineMarkup(FIXTURE);
    const located = locateAnchorInRendered(
      {
        text: "Deprecated/obsolete items referenced below",
        contextBefore: "truth.** ",
        contextAfter: ":",
      },
      FIXTURE,
      r,
    );
    expect(located).not.toBeNull();
    expect(r.stripped.slice(located!.start, located!.end)).toBe(
      "Deprecated/obsolete items referenced below",
    );
  });

  it("anchor 'DRS and DDS documents describe intended behaviour at time of writing' resolves cleanly", () => {
    const r = stripInlineMarkup(FIXTURE);
    const located = locateAnchorInRendered(
      {
        text: "DRS and DDS documents describe intended behaviour at time of writing",
        contextBefore: "caveat:** ",
        contextAfter: ", not",
      },
      FIXTURE,
      r,
    );
    expect(located).not.toBeNull();
    expect(r.stripped.slice(located!.start, located!.end)).toBe(
      "DRS and DDS documents describe intended behaviour at time of writing",
    );
  });

  it("anchor inside a table cell ('Singapore Customs') resolves cleanly", () => {
    const r = stripInlineMarkup(FIXTURE);
    const located = locateAnchorInRendered(
      { text: "Singapore Customs", contextBefore: "", contextAfter: "" },
      FIXTURE,
      r,
    );
    expect(located).not.toBeNull();
    expect(r.stripped.slice(located!.start, located!.end)).toBe("Singapore Customs");
  });
});
