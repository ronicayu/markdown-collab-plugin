import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  findHeadingLine,
  resolveScrollProseOffset,
} from "../inlineComments/inlineCommentsPanel";

/**
 * Minimal TextDocument stub that backs offsetAt / lineAt / lineCount /
 * getText against an in-memory string. Sufficient for the scroll-target
 * resolver — we don't need URIs, language IDs, or any of the other
 * surface area.
 */
function stubDoc(text: string): vscode.TextDocument {
  const lines = text.split("\n");
  // Pre-compute byte offset of each line start.
  const lineStarts: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    lineStarts.push(lineStarts[i] + lines[i].length + 1);
  }
  return {
    getText: () => text,
    lineCount: lines.length,
    lineAt: (lineOrPos: number | { line: number }) => {
      const ln = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
      return { text: lines[ln] ?? "" } as unknown as vscode.TextLine;
    },
    offsetAt: (pos: { line: number; character: number }) => {
      const base = lineStarts[pos.line] ?? text.length;
      return base + pos.character;
    },
  } as unknown as vscode.TextDocument;
}

describe("resolveScrollProseOffset", () => {
  it("maps line 1 to prose offset 0 for a doc with no markers", () => {
    const doc = stubDoc("Hello\nWorld\n");
    expect(resolveScrollProseOffset(doc, { line: 1 })).toBe(0);
  });

  it("maps line 2 to the prose offset after the first line", () => {
    const doc = stubDoc("Hello\nWorld\n");
    expect(resolveScrollProseOffset(doc, { line: 2 })).toBe(6);
  });

  it("skips over anchor markers when mapping source → prose", () => {
    // A thread block + an inline anchor marker pair. The prose has the
    // markers stripped; the source offset for line 3 ("after anchor")
    // should land on the prose char that follows the stripped marker
    // region.
    const src = [
      "Intro line",
      "<!--mc:a:abcde-->anchored<!--mc:/a:abcde-->",
      "Next paragraph",
      "",
      "<!--mc:threads:begin-->",
      "<!--mc:t {\"id\":\"abcde\",\"quote\":\"anchored\",\"status\":\"open\",\"comments\":[{\"id\":\"c1\",\"author\":\"x\",\"ts\":\"2026-01-01T00:00:00Z\",\"body\":\"hi\"}]}-->",
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
    const doc = stubDoc(src);
    // Prose:  "Intro line\nanchored\nNext paragraph\n"
    // line 1 → "Intro line" → prose 0
    // line 2 → "anchored"   → prose 11 (after "Intro line\n")
    // line 3 → "Next paragraph" → prose 20
    expect(resolveScrollProseOffset(doc, { line: 1 })).toBe(0);
    expect(resolveScrollProseOffset(doc, { line: 2 })).toBe(11);
    expect(resolveScrollProseOffset(doc, { line: 3 })).toBe(20);
  });

  it("returns null when line is past EOF", () => {
    const doc = stubDoc("Only one line\n");
    expect(resolveScrollProseOffset(doc, { line: 999 })).toBe(null);
  });

  it("returns null when neither line nor heading is given", () => {
    const doc = stubDoc("Anything\n");
    expect(resolveScrollProseOffset(doc, {})).toBe(null);
  });

  it("resolves a heading to its line, then to a prose offset", () => {
    const doc = stubDoc("# Top\n\nIntro\n\n## API\n\nDetails\n");
    // Heading "API" is on line 5. Prose: "# Top\n\nIntro\n\n## API\n\nDetails\n"
    // Source offset of line 5 = 14 ("# Top\n\nIntro\n\n").
    expect(resolveScrollProseOffset(doc, { heading: "api" })).toBe(14);
  });

  it("prefers a heading match over a line argument when both are given", () => {
    const doc = stubDoc("# A\n\n## B\n\ncontent\n");
    // Heading B on line 3 → prose offset 5. Line=99 would otherwise be EOF.
    expect(
      resolveScrollProseOffset(doc, { heading: "b", line: 99 }),
    ).toBe(5);
  });

  it("falls back to the line argument when the heading isn't found", () => {
    const doc = stubDoc("# A\n\n## B\n\ncontent\n");
    // "nope" doesn't match; line=3 wins → line 3 = "## B" → source offset 5.
    expect(
      resolveScrollProseOffset(doc, { heading: "nope", line: 3 }),
    ).toBe(5);
  });
});

describe("findHeadingLine", () => {
  it("finds an ATX heading by slug", () => {
    const doc = stubDoc("# Welcome\n\n## Setup steps\n");
    expect(findHeadingLine(doc, "setup-steps")).toBe(3);
  });

  it("returns null when the slug doesn't match any heading", () => {
    const doc = stubDoc("# Welcome\n");
    expect(findHeadingLine(doc, "nope")).toBe(null);
  });

  it("strips mc:* markers before slugifying the heading text", () => {
    const doc = stubDoc("# <!--mc:a:abcde-->Intro<!--mc:/a:abcde-->\n");
    expect(findHeadingLine(doc, "intro")).toBe(1);
  });

  it("decodes URI-encoded fragments before slug matching", () => {
    const doc = stubDoc("## Q&A section\n");
    // "Q&A section" → slug "qa-section"
    expect(findHeadingLine(doc, "qa-section")).toBe(1);
  });

  it("matches the first heading when slugs collide", () => {
    const doc = stubDoc("# Intro\n\n## Body\n\n# Intro\n");
    expect(findHeadingLine(doc, "intro")).toBe(1);
  });
});
