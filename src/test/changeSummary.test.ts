import { describe, expect, it } from "vitest";
import { nearestHeadingAbove, summarizeChange } from "../collab/changeSummary";

describe("summarizeChange", () => {
  it("returns null for identical text", () => {
    expect(summarizeChange("same", "same")).toBeNull();
  });

  it("isolates a changed word in the middle", () => {
    const s = summarizeChange("The quick brown fox", "The quick red fox")!;
    expect(s.start).toBe("The quick ".length);
    expect("The quick red fox".slice(s.start, s.end)).toBe("red");
  });

  it("marks an insertion span and captures its text", () => {
    const s = summarizeChange("backoff", "backoff with jitter")!;
    expect("backoff with jitter".slice(s.start, s.end)).toBe(" with jitter");
    expect(s.text).toBe(" with jitter");
  });

  it("marks a deletion point with an empty span", () => {
    const s = summarizeChange("hello world", "hello")!;
    expect(s.start).toBe(s.end);
    expect(s.start).toBe("hello".length);
  });

  it("names the nearest heading above the change", () => {
    const doc = "# Intro\n\nfirst para\n\n## Details\n\nchange HERE please\n";
    const at = doc.indexOf("HERE");
    const s = summarizeChange(doc, doc.replace("HERE", "THERE"))!;
    expect(s.heading).toBe("Details");
    expect(s.start).toBeLessThanOrEqual(at);
  });

  it("returns null heading when the change is above any heading", () => {
    const doc = "preamble text\n\n# First\n\nbody\n";
    const s = summarizeChange(doc, "PREAMBLE text\n\n# First\n\nbody\n")!;
    expect(s.heading).toBeNull();
  });
});

describe("nearestHeadingAbove", () => {
  it("uses the heading on the change's own line", () => {
    const doc = "# Alpha\n\n## Beta\n\ntext\n";
    expect(nearestHeadingAbove(doc, doc.indexOf("Beta"))).toBe("Beta");
  });

  it("strips a trailing hash run (closed ATX)", () => {
    const doc = "## Title ##\n\nbody here\n";
    expect(nearestHeadingAbove(doc, doc.indexOf("body"))).toBe("Title");
  });

  it("picks the most recent of several headings", () => {
    const doc = "# One\n\na\n\n# Two\n\nb\n\n# Three\n\ntarget\n";
    expect(nearestHeadingAbove(doc, doc.indexOf("target"))).toBe("Three");
  });
});
