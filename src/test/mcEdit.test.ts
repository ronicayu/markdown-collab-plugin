// Tests for `opEdit` and its `mc_edit` MCP tool
// front end.
//
// `opEdit` is the marker-safe stand-in for the Edit tool in a headless run:
// exact old->new text substitution over the raw document, refused wherever
// it would touch a review marker or the threads region rather than risk
// corrupting either. The CLI side of the same op is covered in
// skillCli.test.ts ("mdc CLI: edit").

import { describe, expect, it } from "vitest";
import { DocOpError, opCheck, opEdit } from "../inlineComments/docOps";
import { addSuggestion, addThread, parse } from "../inlineComments/format";
import { checkIntegrity } from "../inlineComments/integrity";
import { callTool, type ToolDeps } from "../mcpServer/tools";

const T = "2026-07-01T00:00:00.000Z";

describe("opEdit", () => {
  it("replaces exact prose text and reports occurrence/occurrences/line", () => {
    const doc = "# Guide\n\nThe cache is refreshed every hour.\n";
    const { next, result } = opEdit(doc, "refreshed every hour", "refreshed every 15 minutes");
    expect(next).toContain("The cache is refreshed every 15 minutes.");
    expect(result).toEqual({ occurrence: 1, occurrences: 1, line: 3, unanchored: [] });
    expect(opCheck(next).ok).toBe(true);
  });

  it("accepts an empty replacement as a deletion", () => {
    const doc = "# Guide\n\nThe cache is refreshed every hour, always.\n";
    const { next } = opEdit(doc, "refreshed every hour, ", "");
    expect(next).toBe("# Guide\n\nThe cache is always.\n");
    expect(opCheck(next).ok).toBe(true);
  });

  it("refuses an ambiguous passage without an occurrence", () => {
    const doc = "# T\n\nsame words here. Second: same words here.\n";
    expect(() => opEdit(doc, "same words here", "different words")).toThrow(DocOpError);
    try {
      opEdit(doc, "same words here", "different words");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("passage_ambiguous");
      expect((e as DocOpError).details?.occurrences).toBe(2);
    }
  });

  it("disambiguates with occurrence", () => {
    const doc = "# T\n\nsame words here. Second: same words here.\n";
    const { next, result } = opEdit(doc, "same words here", "DIFFERENT", 2);
    expect(next).toBe("# T\n\nsame words here. Second: DIFFERENT.\n");
    expect(result).toEqual({ occurrence: 2, occurrences: 2, line: 3, unanchored: [] });
  });

  it("refuses an out-of-range occurrence", () => {
    const doc = "# T\n\nsame words here. Second: same words here.\n";
    try {
      opEdit(doc, "same words here", "x", 3);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("passage_not_found");
      expect((e as DocOpError).details?.occurrences).toBe(2);
    }
  });

  it("refuses text that isn't in the document", () => {
    const doc = "# T\n\nsome prose.\n";
    try {
      opEdit(doc, "nonexistent phrase", "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("passage_not_found");
    }
  });

  it("refuses identical old/new as nothing to do", () => {
    const doc = "# T\n\nsome prose.\n";
    try {
      opEdit(doc, "some prose", "some prose");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("nothing_to_do");
    }
  });

  it("refuses an empty selection", () => {
    const doc = "# T\n\nsome prose.\n";
    try {
      opEdit(doc, "", "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("empty_selection");
    }
  });

  it("refuses a match that contains only the open marker of a pair (not its close)", () => {
    const base = "# T\n\nAuth requires a bearer token here.\n";
    const seeded = addThread(base, base.indexOf("bearer token"), base.indexOf("bearer token") + 12, {
      author: "ronica",
      body: "?",
      ts: T,
    });
    const a = parse(seeded.source).anchors.get(seeded.thread.id)!;
    // The open marker plus the anchored text, stopping short of the close
    // marker — one whole marker of the pair, not both. A complete pair is
    // now allowed (that's the new deletion path); this isn't one.
    const old = seeded.source.slice(a.openStart, a.closeStart);
    try {
      opEdit(seeded.source, old, "replacement");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("not_editable");
    }
    // Untouched.
    expect(parse(seeded.source).anchors.has(seeded.thread.id)).toBe(true);
  });

  it("refuses a match that contains only the close marker of a pair", () => {
    const base = "# T\n\nAuth requires a bearer token here.\n";
    const seeded = addThread(base, base.indexOf("bearer token"), base.indexOf("bearer token") + 12, {
      author: "ronica",
      body: "?",
      ts: T,
    });
    const a = parse(seeded.source).anchors.get(seeded.thread.id)!;
    // Just the close marker, plus a trailing character — no open marker.
    const old = seeded.source.slice(a.closeStart, a.closeEnd + 1);
    try {
      opEdit(seeded.source, old, "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("not_editable");
    }
    // Untouched.
    expect(parse(seeded.source).anchors.has(seeded.thread.id)).toBe(true);
  });

  it("refuses a match that splits a marker", () => {
    const base = "# T\n\nAuth requires a bearer token here.\n";
    const seeded = addThread(base, base.indexOf("bearer token"), base.indexOf("bearer token") + 12, {
      author: "ronica",
      body: "?",
      ts: T,
    });
    const a = parse(seeded.source).anchors.get(seeded.thread.id)!;
    // Tail of the open marker (the "-->") plus the first word of the anchored
    // text — starts inside the marker, so it splits it rather than containing
    // it whole.
    const old = seeded.source.slice(a.openEnd - 3, a.openEnd) + "bearer";
    expect(old.startsWith("-->")).toBe(true);
    try {
      opEdit(seeded.source, old, "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("not_editable");
    }
  });

  it("refuses text found only inside the threads region", () => {
    const base = "# T\n\nAuth requires a bearer token here.\n";
    const seeded = addThread(base, base.indexOf("bearer token"), base.indexOf("bearer token") + 12, {
      author: "ronica",
      body: "a phrase found nowhere else in the prose",
      ts: T,
    });
    try {
      opEdit(seeded.source, "a phrase found nowhere else in the prose", "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("not_editable");
    }
  });

  it("refuses a candidate that starts in prose and runs into the threads region", () => {
    const base = "# T\n\nAuth requires a bearer token here.\n";
    const seeded = addThread(base, base.indexOf("bearer token"), base.indexOf("bearer token") + 12, {
      author: "ronica",
      body: "?",
      ts: T,
    });
    const region = parse(seeded.source).threadsRegion!;
    // A span that starts a few characters before the region (so it passes the
    // "starts before the region" candidacy filter) but runs into it.
    const spanning = seeded.source.slice(region.start - 3, region.start + 10);
    try {
      opEdit(seeded.source, spanning, "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("not_editable");
    }
  });

  it("ignores a thread-region match when the SAME text has exactly one prose occurrence", () => {
    // A thread's `quote` field duplicates the anchored prose text verbatim in
    // the threads-region JSON — a naive scan would call this "appears twice"
    // and demand an occurrence, but the region copy isn't a real candidate,
    // so the single prose occurrence edits without one.
    const base = "# T\n\nAuth requires a bearer token here.\n";
    const seeded = addThread(base, base.indexOf("bearer token"), base.indexOf("bearer token") + 12, {
      author: "ronica",
      body: "?",
      ts: T,
    });
    // Sanity: the phrase really does occur twice in the raw source (prose +
    // the `"quote":"..."` field) — this is what exercises the candidate filter.
    expect(seeded.source.split("bearer token")).toHaveLength(3);
    const { next, result } = opEdit(seeded.source, "bearer token", "bearer credential");
    expect(result).toEqual({ occurrence: 1, occurrences: 1, line: 3, unanchored: [] });
    // The prose occurrence changed…
    const a = parse(next).anchors.get(seeded.thread.id)!;
    expect(next.slice(a.openEnd, a.closeStart)).toBe("bearer credential");
    // …the region's `quote` field (the historical record) did not.
    expect(parse(next).threads[0]!.quote).toBe("bearer token");
  });

  it("edits strictly inside an anchored span without touching either marker", () => {
    const base = "# T\n\nThe full anchored sentence here is long.\n";
    const seeded = addThread(
      base,
      base.indexOf("full anchored sentence here"),
      base.indexOf("full anchored sentence here") + "full anchored sentence here".length,
      { author: "ronica", body: "?", ts: T },
    );
    const { next } = opEdit(seeded.source, "anchored", "highlighted");
    expect(next).toContain("full highlighted sentence here");
    expect(checkIntegrity(next).ok).toBe(true);
    expect(parse(next).anchors.has(seeded.thread.id)).toBe(true);
  });

  it("allows a frontmatter edit", () => {
    const doc = "---\ntitle: Old\n---\n\n# Body\n\ntext\n";
    const { next } = opEdit(doc, "title: Old", "title: New");
    expect(next).toBe("---\ntitle: New\n---\n\n# Body\n\ntext\n");
    expect(opCheck(next).ok).toBe(true);
  });

  it("edits a code span that literally contains a marker string", () => {
    // Markers inside code spans are inert to the parser — no AnchorRange, no
    // unpairedMarker — so editing the literal text is allowed.
    const doc = "# T\n\nUse `<!--mc:a:zzzzz-->` as the open marker string.\n";
    expect(parse(doc).anchors.size).toBe(0);
    const { next } = opEdit(doc, "<!--mc:a:zzzzz-->", "<!--mc:a:yyyyy-->");
    expect(next).toContain("`<!--mc:a:yyyyy-->`");
    expect(opCheck(next).ok).toBe(true);
  });

  it("still protects an unpaired marker in a hand-corrupted document", () => {
    const corrupt = "# T\n\n<!--mc:a:abcde-->stray marker text here.\n";
    expect(parse(corrupt).anchors.size).toBe(0);
    try {
      opEdit(corrupt, "<!--mc:a:abcde-->stray", "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("not_editable");
    }
  });

  it("removes one complete anchor pair (open + passage + close) as a deletion", () => {
    const base = "# T\n\nAuth requires a bearer token here.\n";
    const seeded = addThread(base, base.indexOf("bearer token"), base.indexOf("bearer token") + 12, {
      author: "ronica",
      body: "?",
      ts: T,
    });
    const a = parse(seeded.source).anchors.get(seeded.thread.id)!;
    const old = seeded.source.slice(a.openStart, a.closeEnd);
    const { next, result } = opEdit(seeded.source, old, "some credential");
    expect(next).toContain("Auth requires a some credential here.");
    expect(result.unanchored).toEqual([seeded.thread.id]);

    const reparsed = parse(next);
    expect(reparsed.unanchoredThreadIds).toEqual([seeded.thread.id]);
    // The thread record itself — status, quote, comments — is unchanged; only
    // its anchor markers are gone.
    expect(reparsed.threads.find((t) => t.id === seeded.thread.id)).toEqual(
      parse(seeded.source).threads.find((t) => t.id === seeded.thread.id),
    );

    const report = checkIntegrity(next);
    const unanchoredIssues = report.issues.filter((i) => i.kind === "unanchored-thread");
    expect(unanchoredIssues).toHaveLength(1);
    expect(unanchoredIssues[0]!.threadId).toBe(seeded.thread.id);
  });

  it("removes two complete pairs at once when one range covers both", () => {
    const base = "# T\n\nOne alpha phrase and another beta phrase in the same paragraph.\n";
    const afterA = addThread(
      base,
      base.indexOf("alpha phrase"),
      base.indexOf("alpha phrase") + "alpha phrase".length,
      { author: "ronica", body: "a", ts: T },
    );
    const afterB = addThread(
      afterA.source,
      afterA.source.indexOf("beta phrase"),
      afterA.source.indexOf("beta phrase") + "beta phrase".length,
      { author: "ronica", body: "b", ts: T },
    );
    const aAnchor = parse(afterB.source).anchors.get(afterA.thread.id)!;
    const bAnchor = parse(afterB.source).anchors.get(afterB.thread.id)!;
    // Covers both pairs completely, plus the plain prose between them.
    const old = afterB.source.slice(aAnchor.openStart, bAnchor.closeEnd);
    const { next, result } = opEdit(afterB.source, old, "REDACTED");
    expect(next).toContain("One REDACTED in the same paragraph.");
    expect(new Set(result.unanchored)).toEqual(new Set([afterA.thread.id, afterB.thread.id]));

    const reparsed = parse(next);
    expect(new Set(reparsed.unanchoredThreadIds)).toEqual(new Set([afterA.thread.id, afterB.thread.id]));
    expect(checkIntegrity(next).issues.filter((i) => i.kind === "unanchored-thread")).toHaveLength(2);
  });

  it("refuses a range that contains one complete pair and only one marker of another", () => {
    const base = "# T\n\nOne alpha phrase and another beta phrase in the same paragraph.\n";
    const afterA = addThread(
      base,
      base.indexOf("alpha phrase"),
      base.indexOf("alpha phrase") + "alpha phrase".length,
      { author: "ronica", body: "a", ts: T },
    );
    const afterB = addThread(
      afterA.source,
      afterA.source.indexOf("beta phrase"),
      afterA.source.indexOf("beta phrase") + "beta phrase".length,
      { author: "ronica", body: "b", ts: T },
    );
    const aAnchor = parse(afterB.source).anchors.get(afterA.thread.id)!;
    const bAnchor = parse(afterB.source).anchors.get(afterB.thread.id)!;
    // Whole pair A, plus only B's open marker (and a bit of its anchored
    // text) — B's close marker is outside the range.
    const old = afterB.source.slice(aAnchor.openStart, bAnchor.openEnd + 4);
    try {
      opEdit(afterB.source, old, "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("not_editable");
    }
    expect(parse(afterB.source).anchors.has(afterA.thread.id)).toBe(true);
    expect(parse(afterB.source).anchors.has(afterB.thread.id)).toBe(true);
  });

  it("allows a complete inner pair nested inside an outer pair's text, leaving the outer anchored", () => {
    const base = "# T\n\nThe reviewer flagged this risky sentence about tokens overall.\n";
    const outerText = "this risky sentence about tokens";
    const outer = addThread(base, base.indexOf(outerText), base.indexOf(outerText) + outerText.length, {
      author: "ronica",
      body: "outer",
      ts: T,
    });
    // Inner span sits strictly inside the outer anchored text — touching
    // neither of the outer's markers.
    const innerText = "risky sentence";
    const innerStart = outer.source.indexOf(innerText);
    const inner = addThread(outer.source, innerStart, innerStart + innerText.length, {
      author: "claude",
      body: "inner",
      ts: T,
    });
    const innerAnchor = parse(inner.source).anchors.get(inner.thread.id)!;
    const old = inner.source.slice(innerAnchor.openStart, innerAnchor.closeEnd);
    const { next, result } = opEdit(inner.source, old, "");

    expect(result.unanchored).toEqual([inner.thread.id]);
    const reparsed = parse(next);
    expect(reparsed.unanchoredThreadIds).toEqual([inner.thread.id]);
    // The outer thread is untouched — still anchored.
    expect(reparsed.anchors.has(outer.thread.id)).toBe(true);
  });

  it("refuses a range with an outer pair's open marker and a whole inner pair but not the outer close", () => {
    const base = "# T\n\nThe reviewer flagged this risky sentence about tokens overall.\n";
    const outerText = "this risky sentence about tokens";
    const outer = addThread(base, base.indexOf(outerText), base.indexOf(outerText) + outerText.length, {
      author: "ronica",
      body: "outer",
      ts: T,
    });
    const innerText = "risky sentence";
    const innerStart = outer.source.indexOf(innerText);
    const inner = addThread(outer.source, innerStart, innerStart + innerText.length, {
      author: "claude",
      body: "inner",
      ts: T,
    });
    const outerAnchor = parse(inner.source).anchors.get(outer.thread.id)!;
    const innerAnchor = parse(inner.source).anchors.get(inner.thread.id)!;
    const old = inner.source.slice(outerAnchor.openStart, innerAnchor.closeEnd);
    try {
      opEdit(inner.source, old, "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("not_editable");
    }
  });

  it("refuses to remove a complete suggestion pair — integrity, not not_editable", () => {
    const base = "# T\n\nThe legacy endpoint stays available for now.\n";
    const quote = "stays available";
    const seeded = addSuggestion(base, base.indexOf(quote), base.indexOf(quote) + quote.length, {
      author: "claude",
      proposed: "remains supported",
      ts: T,
    });
    const a = parse(seeded.source).anchors.get(seeded.suggestion.anchorId)!;
    const old = seeded.source.slice(a.openStart, a.closeEnd);
    try {
      opEdit(seeded.source, old, "x");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DocOpError);
      expect((e as DocOpError).code).toBe("integrity");
    }
    // Untouched — the suggestion still has its anchor.
    expect(parse(seeded.source).anchors.has(seeded.suggestion.anchorId)).toBe(true);
  });

  it("allows the complete-pair deletion even with unrelated pre-existing damage elsewhere", () => {
    const corrupt = "# T\n\nAuth requires a bearer token here. <!--mc:a:zzzzz-->A stray marker sits here.\n";
    expect(checkIntegrity(corrupt).issues).toHaveLength(1);
    const seeded = addThread(
      corrupt,
      corrupt.indexOf("bearer token"),
      corrupt.indexOf("bearer token") + "bearer token".length,
      { author: "ronica", body: "?", ts: T },
    );
    expect(checkIntegrity(seeded.source).issues).toHaveLength(1); // just the stray marker

    const a = parse(seeded.source).anchors.get(seeded.thread.id)!;
    const old = seeded.source.slice(a.openStart, a.closeEnd);
    const { next, result } = opEdit(seeded.source, old, "a credential");
    expect(result.unanchored).toEqual([seeded.thread.id]);

    const report = checkIntegrity(next);
    expect(report.issues.some((i) => i.kind === "unpaired-marker")).toBe(true);
    expect(report.issues.filter((i) => i.kind === "unanchored-thread")).toHaveLength(1);
  });
});

describe("mc_edit tool", () => {
  const DOC = "# Guide\n\nThe cache is refreshed every hour.\n";

  function harness(initial = DOC) {
    const files = new Map<string, string>([["/ws/guide.md", initial]]);
    const deps: ToolDeps = {
      resolveFile: async (file) => {
        const key = file.startsWith("/") ? file : `/ws/${file}`;
        if (!files.has(key)) throw new Error(`no such file inside the workspace: ${file}`);
        return key;
      },
      readDoc: async (key) => files.get(key)!,
      writeDoc: async (key, next) => {
        files.set(key, next);
      },
      now: () => T,
    };
    return {
      deps,
      read: (key = "/ws/guide.md") => files.get(key)!,
      call: (name: string, args: Record<string, unknown> = {}) => callTool(name, args, deps),
    };
  }

  function body(result: { content: Array<{ text: string }> }): any {
    return JSON.parse(result.content[0]!.text);
  }

  it("happy path: writes the document and reports action edit", async () => {
    const h = harness();
    const r = await h.call("mc_edit", {
      file: "guide.md",
      old: "refreshed every hour",
      new: "refreshed every 15 minutes",
    });
    expect(r.isError).toBeUndefined();
    expect(body(r).action).toBe("edit");
    expect(h.read()).toContain("refreshed every 15 minutes");
  });

  it("refuses an edit that touches only one marker of a pair, leaving the document untouched", async () => {
    const quote = "refreshed every hour";
    const seeded = addThread(DOC, DOC.indexOf(quote), DOC.indexOf(quote) + quote.length, {
      author: "ronica",
      body: "?",
      ts: T,
    });
    const h = harness(seeded.source);
    const a = parse(seeded.source).anchors.get(seeded.thread.id)!;
    // Open marker + anchored text, but not the close marker.
    const old = seeded.source.slice(a.openStart, a.closeStart);
    const before = h.read();
    const r = await h.call("mc_edit", { file: "guide.md", old, new: "x" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("not_editable");
    expect(h.read()).toBe(before);
  });

  it("deletes a complete anchor pair via mc_edit and reports the unanchored thread", async () => {
    const quote = "refreshed every hour";
    const seeded = addThread(DOC, DOC.indexOf(quote), DOC.indexOf(quote) + quote.length, {
      author: "ronica",
      body: "?",
      ts: T,
    });
    const h = harness(seeded.source);
    const a = parse(seeded.source).anchors.get(seeded.thread.id)!;
    const old = seeded.source.slice(a.openStart, a.closeEnd);
    const r = await h.call("mc_edit", { file: "guide.md", old, new: "updated hourly" });
    expect(r.isError).toBeUndefined();
    const parsed = body(r);
    expect(parsed.action).toBe("edit");
    expect(parsed.unanchored).toEqual([seeded.thread.id]);
    expect(h.read()).toContain("updated hourly");
    expect(parse(h.read()).unanchoredThreadIds).toEqual([seeded.thread.id]);
  });

  it("accepts an empty `new` as a deletion", async () => {
    const h = harness();
    const r = await h.call("mc_edit", { file: "guide.md", old: " every hour", new: "" });
    expect(r.isError).toBeUndefined();
    expect(body(r).action).toBe("edit");
    expect(h.read()).toBe("# Guide\n\nThe cache is refreshed.\n");
  });

  it("refuses a missing `new` as invalid_arguments", async () => {
    const h = harness();
    const r = await h.call("mc_edit", { file: "guide.md", old: "refreshed every hour" });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("invalid_arguments");
    // Nothing changed.
    expect(h.read()).toBe(DOC);
  });
});

describe("refusals are logged with their code", () => {
  it("onRefusal receives the machine-readable code, not 'unknown'", async () => {
    const refusals: Array<{ tool: string; code: string }> = [];
    const doc = "# T\n\nplain prose here\n";
    await callTool(
      "mc_edit",
      { file: "a.md", old: "not in the doc", new: "x" },
      {
        resolveFile: async () => "a.md",
        readDoc: async () => doc,
        writeDoc: async () => undefined,
        onRefusal: (e) => refusals.push(e),
      },
    );
    expect(refusals).toEqual([expect.objectContaining({ tool: "mc_edit", code: "passage_not_found" })]);
  });
});
