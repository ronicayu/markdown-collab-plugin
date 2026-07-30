import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  CONVENTIONS_REL,
  CONVENTIONS_TEMPLATE,
  MAX_CONVENTIONS_BYTES,
  conventionsBlock,
  withConventions,
} from "../reviewConventions";

const REAL = `## Terminology

The product is "Markdown Collab", never "the plugin".

## Known and accepted

The setup steps are deliberately repeated in the README.
`;

describe("conventionsBlock", () => {
  it("is empty when there is no file", () => {
    expect(conventionsBlock(null)).toEqual({ text: "", truncated: false });
  });

  it("is empty for a blank file", () => {
    expect(conventionsBlock("   \n\n  ").text).toBe("");
  });

  // The scaffold is all headings and HTML comments. A file the human opened and
  // never filled in must weigh nothing — otherwise every payload carries a
  // block that says nothing and Claude treats it as if it did.
  it("is empty for a file that is still only the template", () => {
    expect(conventionsBlock(CONVENTIONS_TEMPLATE).text).toBe("");
  });

  it("becomes non-empty as soon as a real line is added", () => {
    const filled = CONVENTIONS_TEMPLATE.replace(
      "## Terminology",
      '## Terminology\n\nThe product is "Markdown Collab".',
    );
    expect(conventionsBlock(filled).text).toContain("Markdown Collab");
  });

  it("labels the block and carries the file verbatim", () => {
    const block = conventionsBlock(REAL);
    expect(block.text).toContain("Conventions:");
    expect(block.text).toContain(CONVENTIONS_REL);
    expect(block.text).toContain('The product is "Markdown Collab", never "the plugin".');
    expect(block.truncated).toBe(false);
  });

  it("says how conventions and a per-run focus interact", () => {
    // Without this the two instructions compete silently and the model picks.
    expect(conventionsBlock(REAL).text).toMatch(/focus wins for scope/i);
  });
});

describe("the size cap", () => {
  const huge = `## Terminology\n\n${"a line of standing convention prose\n".repeat(500)}`;

  it("truncates a runaway file rather than crowding out the document", () => {
    const block = conventionsBlock(huge);
    expect(block.truncated).toBe(true);
    expect(Buffer.byteLength(block.text, "utf8")).toBeLessThan(MAX_CONVENTIONS_BYTES + 600);
  });

  it("says it truncated, so the human can shorten the file", () => {
    // Silent truncation would look like Claude ignoring a rule that was in fact
    // never sent.
    expect(conventionsBlock(huge).text).toContain("truncated");
  });

  it("cuts on a line boundary", () => {
    const block = conventionsBlock(huge);
    const body = block.text.split("\n").filter((l) => l.startsWith("a line of"));
    for (const line of body) expect(line).toBe("a line of standing convention prose");
  });

  it("still returns something for one enormous line", () => {
    const oneLine = `x`.repeat(MAX_CONVENTIONS_BYTES * 2);
    const block = conventionsBlock(oneLine);
    expect(block.truncated).toBe(true);
    expect(block.text.length).toBeGreaterThan(100);
  });
});

describe("withConventions", () => {
  it("leaves the prompt alone when there is nothing to add", () => {
    expect(withConventions("review this", null)).toBe("review this");
    expect(withConventions("review this", CONVENTIONS_TEMPLATE)).toBe("review this");
  });

  it("appends after the prompt, so the request still reads first", () => {
    const out = withConventions("review this", REAL);
    expect(out.startsWith("review this")).toBe(true);
    expect(out.indexOf("Conventions:")).toBeGreaterThan(out.indexOf("review this"));
  });
});

describe("the template", () => {
  it("scaffolds the four things worth writing down", () => {
    for (const heading of ["Terminology", "Tone", "Standing focuses", "Known and accepted"]) {
      expect(CONVENTIONS_TEMPLATE).toContain(heading);
    }
  });

  it("keeps its instructions in HTML comments so they never ship to Claude", () => {
    expect(conventionsBlock(CONVENTIONS_TEMPLATE).text).toBe("");
  });
});

// Source-level guard: conventions must be appended where every send path passes
// through, not in each payload builder. Five builders each remembering would be
// four chances to forget — the exact bug class 0.34.59 fixed for suggest mode.
describe("every send path carries the conventions", () => {
  const extension = readFileSync(resolve(__dirname, "../extension.ts"), "utf8");

  it("appends them inside dispatchReviewPayload, before the mode branches", () => {
    const dispatch = extension.slice(extension.indexOf("async function dispatchReviewPayload"));
    const appendAt = dispatch.indexOf("withConventions(");
    const firstBranch = dispatch.indexOf('if (mode === "clipboard")');
    expect(appendAt).toBeGreaterThan(0);
    expect(appendAt).toBeLessThan(firstBranch);
  });

  it("does not append them in any individual payload builder", () => {
    for (const file of ["sendToClaude.ts", "multiFileReview.ts", "inlineComments/sendToClaude.ts"]) {
      const source = readFileSync(resolve(__dirname, "..", file), "utf8");
      expect(source, `${file} should not build the conventions block itself`).not.toContain(
        "withConventions",
      );
    }
  });
});
