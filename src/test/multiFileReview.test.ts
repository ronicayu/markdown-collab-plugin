import { describe, expect, it } from "vitest";
import {
  CROSS_DOCUMENT_DIMENSION,
  buildMultiFileReviewPayload,
  selectionLabel,
  totalBytes,
  type ReviewFile,
} from "../multiFileReview";

const files = (...rels: string[]): ReviewFile[] =>
  rels.map((rel) => ({ rel, bytes: 100 }));

describe("buildMultiFileReviewPayload", () => {
  it("lists every file, in the order given", () => {
    const p = buildMultiFileReviewPayload(files("docs/a.md", "docs/b.md", "docs/c.md"));
    expect(p.files).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);
    const order = ["docs/a.md", "docs/b.md", "docs/c.md"].map((f) => p.prompt.indexOf(f));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
  });

  it("invokes the skill in Review Mode", () => {
    const p = buildMultiFileReviewPayload(files("a.md", "b.md"));
    expect(p.prompt).toContain("vs-markdown-collab");
    expect(p.prompt).toContain("Review Mode");
  });

  it("makes cross-document consistency part of the pass", () => {
    const p = buildMultiFileReviewPayload(files("docs/a.md", "docs/b.md"));
    expect(p.prompt).toContain(CROSS_DOCUMENT_DIMENSION);
    expect(p.prompt).toMatch(/terminology that drifts/i);
    expect(p.prompt).toMatch(/contradicted by another/i);
  });

  it("embeds a focus directive on its own line when given", () => {
    const p = buildMultiFileReviewPayload(files("a.md", "b.md"), "check API examples");
    expect(p.prompt).toContain("\nFocus: check API examples\n");
  });

  it("omits the focus line for a general review", () => {
    expect(buildMultiFileReviewPayload(files("a.md", "b.md")).prompt).not.toContain("Focus:");
    expect(buildMultiFileReviewPayload(files("a.md", "b.md"), "   ").prompt).not.toContain(
      "Focus:",
    );
  });

  it("keeps the no-upper-bound and no-prose-edits terms", () => {
    const p = buildMultiFileReviewPayload(files("a.md", "b.md"));
    expect(p.prompt).toMatch(/no upper bound/i);
    expect(p.prompt).toMatch(/do not edit prose/i);
  });

  it("carries no existing comments — the pass creates threads from scratch", () => {
    const p = buildMultiFileReviewPayload(files("a.md", "b.md"));
    expect(p.comments).toEqual([]);
    expect(p.unresolvedCount).toBe(0);
  });

  it("labels the payload by the shared directory", () => {
    const p = buildMultiFileReviewPayload(files("docs/a.md", "docs/b.md", "docs/c.md"));
    expect(p.file).toBe("3 files under docs/");
  });
});

describe("selectionLabel", () => {
  it("names a single file by its path", () => {
    expect(selectionLabel(["docs/a.md"])).toBe("docs/a.md");
  });

  it("uses the deepest shared directory", () => {
    expect(selectionLabel(["docs/api/a.md", "docs/api/b.md"])).toBe("2 files under docs/api/");
  });

  it("falls back to a bare count when the files share no directory", () => {
    expect(selectionLabel(["docs/a.md", "spec/b.md"])).toBe("2 files");
  });

  it("compares path segments, not string prefixes", () => {
    // "docs" and "docs-old" share the prefix "docs" but not the directory.
    expect(selectionLabel(["docs/a.md", "docs-old/a.md"])).toBe("2 files");
  });

  it("returns a bare count for files at the workspace root", () => {
    expect(selectionLabel(["README.md", "CHANGELOG.md"])).toBe("2 files");
  });
});

describe("totalBytes", () => {
  it("sums the selection for the soft confirm", () => {
    expect(
      totalBytes([
        { rel: "a.md", bytes: 30 * 1024 },
        { rel: "b.md", bytes: 25 * 1024 },
      ]),
    ).toBe(55 * 1024);
  });

  it("is zero for an empty selection", () => {
    expect(totalBytes([])).toBe(0);
  });
});
