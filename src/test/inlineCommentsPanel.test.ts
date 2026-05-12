import { describe, expect, it } from "vitest";
import { addThread, parse } from "../inlineComments/format";
import { serialize } from "../inlineComments/inlineCommentsPanel";

describe("inlineComments/panel - serialize", () => {
  it("maps anchor positions into prose-offset space", () => {
    const src = "Hello world.";
    const start = 6;
    const end = 11;
    const after = addThread(src, start, end, { author: "r", body: "x", ts: "2026-05-12T00:00:00Z" }).source;
    const parsed = parse(after);
    const ser = serialize(parsed);
    // Prose should be the original "Hello world." text only.
    expect(ser.prose.startsWith("Hello world.")).toBe(true);
    expect(ser.threads).toHaveLength(1);
    const anchor = ser.threads[0].anchor!;
    expect(ser.prose.slice(anchor.proseStart, anchor.proseEnd)).toBe("world");
  });

  it("nested anchors map to non-overlapping prose ranges", () => {
    let src = "Foo bar baz quux.";
    src = addThread(src, 4, 11, { author: "r", body: "outer", ts: "2026-05-12T00:00:00Z" }).source;
    src = addThread(src, src.indexOf("baz"), src.indexOf("baz") + 3, { author: "r", body: "inner", ts: "2026-05-12T00:00:00Z" }).source;
    const ser = serialize(parse(src));
    const byBody = (b: string) => ser.threads.find((t) => t.comments[0].body === b)!;
    expect(ser.prose.slice(byBody("outer").anchor!.proseStart, byBody("outer").anchor!.proseEnd)).toBe("bar baz");
    expect(ser.prose.slice(byBody("inner").anchor!.proseStart, byBody("inner").anchor!.proseEnd)).toBe("baz");
  });

  it("threads with no markers come through unanchored", () => {
    // Manually craft a file with a thread block but no markers in prose.
    const md = [
      "Plain.",
      "",
      "<!--mc:threads:begin-->",
      `<!--mc:t {"id":"orph1","quote":"missing","status":"open","comments":[{"id":"c1","author":"r","ts":"2026-05-12T00:00:00Z","body":"x"}]}-->`,
      "<!--mc:threads:end-->",
    ].join("\n");
    const ser = serialize(parse(md));
    expect(ser.threads[0].anchor).toBeNull();
    expect(ser.prose.trim()).toBe("Plain.");
  });
});
