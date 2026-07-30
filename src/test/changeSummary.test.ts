import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { nearestHeadingAbove, proseRefreshMessage, summarizeChange } from "../collab/changeSummary";
import { acceptSuggestion, addSuggestion } from "../inlineComments/format";
import { proseOf } from "../collab/inlineBridge";

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

// Accepting a suggestion rewrites the anchored prose from a host-side write,
// which the provider's echo guard deliberately hides from the doc-change
// handler — so the editor showed the old wording until the next external edit.
// proseRefreshMessage is the push the provider makes instead.
describe("proseRefreshMessage", () => {
  it("returns null when the editor already shows the new prose (reject path)", () => {
    expect(proseRefreshMessage("same prose", "same prose")).toBeNull();
  });

  it("carries the accepted prose and the changed span after a real accept", () => {
    const doc = "# Doc\n\nThis sandbox explains the loop.\n";
    const start = doc.indexOf("sandbox");
    const added = addSuggestion(doc, start, start + "sandbox".length, {
      author: "claude",
      proposed: "scratch document",
    });
    const shownProse = proseOf(added.source); // what the live editor renders
    const accepted = acceptSuggestion(added.source, added.suggestion.anchorId);
    const refresh = proseRefreshMessage(shownProse, proseOf(accepted))!;

    expect(refresh.type).toBe("externalChange");
    expect(refresh.text).toContain("scratch document");
    expect(refresh.text).not.toContain("sandbox");
    const changed = refresh.changed!;
    // "sandbox" → "scratch document" share the leading "s", so the minimal
    // span starts one char in.
    expect(refresh.text.slice(changed.start, changed.end)).toBe("cratch document");
    expect(changed.heading).toBe("Doc");
  });

  // The regression this helper exists for: the provider's accept/reject branch
  // must capture the shown prose BEFORE writeDocument (which re-baselines the
  // echo guard) and post the refresh after. Assert the wiring as text, the way
  // the release-pipeline tests do — no headless harness can click this path.
  it("is wired into the provider's accept/reject branch", () => {
    const provider = readFileSync(
      resolve(__dirname, "../collab/collabEditorProvider.ts"),
      "utf8",
    );
    const branch = provider.slice(provider.indexOf('msg.type === "accept-suggestion"'));
    const write = branch.indexOf("writeDocument(next");
    expect(write).toBeGreaterThan(-1);
    // Captured before the write…
    expect(branch.slice(0, write)).toContain("const shownProse = lastWebviewProse");
    // …and pushed after it, re-baselining the guard to what was pushed.
    const after = branch.slice(write);
    expect(after).toContain("proseRefreshMessage(shownProse");
    expect(after).toContain("lastWebviewProse = refresh.text");
    expect(after).toContain("postMessage(refresh)");
  });
});
