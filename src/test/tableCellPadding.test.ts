// User-reported: highlights still drift in docs with wide tables.
// Pattern from screenshot: anchor text appears earlier in the doc;
// the table rows in between have cell padding (` A | B `) that my
// stripper preserved as " A  B " — but PM trims cell padding, so
// textContent is "AB". Each table row adds 2N+ extra chars; the
// downstream renderedRangeToPmRange lands the highlight further down
// the doc by that drift.
//
// Fix surface: when stripping `|`, also remove the whitespace
// immediately before and after it (table cell padding), matching what
// PM's table parser does.

import { describe, expect, it } from "vitest";
import { stripInlineMarkup } from "../collab/anchorExtractor";
import { locateAnchorInRendered } from "../collab/anchorLocator";

function strip(md: string): string {
  return stripInlineMarkup(md).stripped;
}

describe("table cell padding (PM trims, stripper must too)", () => {
  it("simple row: `| A | B |` → 'AB' (cells concatenated, no padding)", () => {
    expect(strip("| A | B |")).toBe("AB");
  });

  it("row with longer cell text: `| Hello | World |` → 'HelloWorld'", () => {
    expect(strip("| Hello | World |")).toBe("HelloWorld");
  });

  it("row with no leading/trailing pipe: `A | B | C` → 'ABC' (still strips)", () => {
    expect(strip("A | B | C")).toBe("ABC");
  });

  it("multi-row table strips all padding cleanly", () => {
    const md = ["| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
    expect(strip(md)).toBe("AB1234");
  });

  it("table inside a blockquote: padding is stripped after the `> ` is consumed", () => {
    const md = ["> | A | B |", "> |---|---|", "> | 1 | 2 |"].join("\n");
    expect(strip(md)).toBe("AB12");
  });

  it("user's screenshot scenario: paragraph then wide table — anchor in paragraph aligns past the table rows", () => {
    const md = [
      "## Quick Reference",
      "",
      "Glossary entry text with TN4.1 system names in parentheses on first mention.",
      "",
      "| Component | Code | Number | Users | Notes |",
      "|---|---|---|---|---|",
      "| Officer portal | authority-portal-intranet | 3 | SC/CA officers | ADFS SAML SSO → ROL processing, code tables, reports |",
      "| System interfaces | tnbatch41 | 4 | System | Scheduled jobs |",
    ].join("\n");
    const positionMap = stripInlineMarkup(md);
    const located = locateAnchorInRendered(
      {
        text: "with TN4.1 system names in parentheses on first mention",
        contextBefore: "Glossary entry text ",
        contextAfter: ".",
      },
      md,
      positionMap,
    );
    expect(located).not.toBeNull();
    expect(positionMap.stripped.slice(located!.start, located!.end)).toBe(
      "with TN4.1 system names in parentheses on first mention",
    );
  });

  it("anchor inside a table cell ('Officer portal') resolves cleanly", () => {
    const md = [
      "Some intro text.",
      "",
      "| Component | Notes |",
      "|---|---|",
      "| Officer portal | uses ADFS SAML |",
      "| System | scheduled jobs |",
    ].join("\n");
    const positionMap = stripInlineMarkup(md);
    const located = locateAnchorInRendered(
      { text: "Officer portal", contextBefore: "", contextAfter: "" },
      md,
      positionMap,
    );
    expect(located).not.toBeNull();
    expect(positionMap.stripped.slice(located!.start, located!.end)).toBe(
      "Officer portal",
    );
  });

  it("a literal `|` inside an inline-code span IS preserved (code body bypasses the pipe strip)", () => {
    // Inline-code wrapper emits its body chars verbatim — they don't
    // re-enter the inline strippers, so a `|` inside `code` survives.
    // Pragmatic: a literal pipe in code is what the user typed, so
    // PM renders it. Test pins the behaviour so a future fix doesn't
    // silently regress.
    expect(strip("Use `a | b` syntax")).toBe("Use a | b syntax");
  });
});
