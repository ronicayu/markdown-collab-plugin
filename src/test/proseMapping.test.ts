import { describe, expect, it } from "vitest";
import { addThread, parse } from "../inlineComments/format";
import { mapProseToSource } from "../inlineComments/proseMapping";

const TS = "2026-07-28T12:00:00.000Z";

/** Anchor `needle` in `source` (source-offset space, straight from the engine). */
function anchor(source: string, needle: string, body = "?"): string {
  const start = source.indexOf(needle);
  return addThread(source, start, start + needle.length, { author: "r", body, ts: TS }).source;
}

describe("mapProseToSource — prose view", () => {
  it("is the identity on a document with no markup", () => {
    const doc = "# Title\n\nJust prose.\n";
    expect(mapProseToSource(parse(doc)).prose).toBe(doc);
  });

  it("strips anchor markers", () => {
    const doc = "The retry uses backoff.\n";
    const withThread = anchor(doc, "backoff");
    expect(mapProseToSource(parse(withThread)).prose.trimEnd()).toBe(doc.trimEnd());
  });

  it("strips the threads region and the blank line before it", () => {
    const withThread = anchor("Body text here.\n", "text");
    const { prose } = mapProseToSource(parse(withThread));
    expect(prose).not.toContain("mc:threads");
    expect(prose).not.toContain("mc:t ");
    expect(prose.trimEnd()).toBe("Body text here.");
  });

  it("strips frontmatter — the preview doesn't render it", () => {
    const doc = "---\ntitle: X\n---\n\nBody.\n";
    const { prose } = mapProseToSource(parse(doc));
    expect(prose).not.toContain("title:");
    expect(prose.trim()).toBe("Body.");
  });
});

describe("mapProseToSource — offset round-trips", () => {
  const doc = "# Guide\n\nThe retry uses exponential backoff.\n";

  it("round-trips a start offset through both directions", () => {
    const withThread = anchor(doc, "exponential");
    const parsed = parse(withThread);
    const { prose, proseStartToSource, sourceToProse } = mapProseToSource(parsed);
    const proseOffset = prose.indexOf("backoff");
    const srcOffset = proseStartToSource(proseOffset)!;
    expect(withThread.slice(srcOffset, srcOffset + 7)).toBe("backoff");
    expect(sourceToProse(srcOffset)).toBe(proseOffset);
  });

  it("maps an end boundary to just past the last selected character", () => {
    const withThread = anchor(doc, "exponential");
    const { prose, proseStartToSource, proseEndToSource } = mapProseToSource(parse(withThread));
    // Select "retry": the end offset must not swallow the following marker.
    const start = prose.indexOf("retry");
    const end = start + "retry".length;
    const sStart = proseStartToSource(start)!;
    const sEnd = proseEndToSource(end)!;
    expect(withThread.slice(sStart, sEnd)).toBe("retry");
  });

  it("maps a selection that ends immediately before an anchor marker", () => {
    const withThread = anchor(doc, "exponential");
    const { prose, proseStartToSource, proseEndToSource } = mapProseToSource(parse(withThread));
    // "uses " ends exactly where the open marker begins in source space.
    const start = prose.indexOf("uses");
    const end = start + "uses".length;
    expect(withThread.slice(proseStartToSource(start)!, proseEndToSource(end)!)).toBe("uses");
  });

  it("maps a selection that starts immediately after a close marker", () => {
    const withThread = anchor("a bb ccc\n", "bb");
    const { prose, proseStartToSource, proseEndToSource } = mapProseToSource(parse(withThread));
    const start = prose.indexOf("ccc");
    const end = start + 3;
    expect(withThread.slice(proseStartToSource(start)!, proseEndToSource(end)!)).toBe("ccc");
  });

  it("maps offsets past frontmatter back into the body", () => {
    const doc2 = "---\ntitle: X\n---\n\nHello brave world.\n";
    const { prose, proseStartToSource, proseEndToSource } = mapProseToSource(parse(doc2));
    const start = prose.indexOf("brave");
    const end = start + "brave".length;
    expect(doc2.slice(proseStartToSource(start)!, proseEndToSource(end)!)).toBe("brave");
  });

  it("maps every prose offset back to a source offset", () => {
    const withThread = anchor(anchor(doc, "exponential"), "Guide");
    const { prose, proseStartToSource } = mapProseToSource(parse(withThread));
    for (let i = 0; i <= prose.length; i++) {
      expect(proseStartToSource(i)).not.toBeNull();
    }
  });

  it("rejects out-of-range offsets instead of guessing", () => {
    const { prose, proseStartToSource, proseEndToSource } = mapProseToSource(parse(doc));
    expect(proseStartToSource(-1)).toBeNull();
    expect(proseStartToSource(prose.length + 5)).toBeNull();
    expect(proseEndToSource(prose.length + 5)).toBeNull();
  });
});

describe("mapProseToSource — anchors in prose space", () => {
  it("reports each thread's anchored span", () => {
    const doc = "The retry uses exponential backoff.\n";
    const withThread = anchor(doc, "exponential backoff");
    const { prose, anchorsInProse } = mapProseToSource(parse(withThread));
    const [range] = [...anchorsInProse.values()];
    expect(prose.slice(range.proseStart, range.proseEnd)).toBe("exponential backoff");
  });

  it("keeps nested anchors non-overlapping in prose space", () => {
    let src = "Foo bar baz quux.\n";
    src = anchor(src, "bar baz", "outer");
    src = anchor(src, "baz", "inner");
    const parsed = parse(src);
    const { prose, anchorsInProse } = mapProseToSource(parsed);
    const spans = [...anchorsInProse.values()].map((r) => prose.slice(r.proseStart, r.proseEnd));
    expect(spans.sort()).toEqual(["bar baz", "baz"]);
  });

  it("omits threads that have no markers", () => {
    const md = [
      "Plain.",
      "",
      "<!--mc:threads:begin-->",
      `<!--mc:t {"id":"orph1","quote":"missing","status":"open","comments":[{"id":"c1","author":"r","ts":"${TS}","body":"x"}]}-->`,
      "<!--mc:threads:end-->",
    ].join("\n");
    expect(mapProseToSource(parse(md)).anchorsInProse.size).toBe(0);
  });
});
