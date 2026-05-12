import { describe, expect, it } from "vitest";
import {
  addThread,
  appendReply,
  parse,
  renderThreadsRegion,
  replaceThread,
  stripAllInlineMarkup,
  stripAnchorMarkers,
  withThreads,
} from "../inlineComments/format";

const TS = "2026-05-12T10:00:00.000Z";

describe("inlineComments/format - parse", () => {
  it("returns empty result for plain markdown", () => {
    const r = parse("# Title\n\nHello.");
    expect(r.threads).toEqual([]);
    expect(r.anchors.size).toBe(0);
    expect(r.threadsRegion).toBeNull();
  });

  it("pairs open/close markers and exposes their offsets", () => {
    const md = "Hello <!--mc:a:abc12-->world<!--mc:/a:abc12-->!";
    const r = parse(md);
    const a = r.anchors.get("abc12");
    expect(a).toBeDefined();
    expect(md.slice(a!.openEnd, a!.closeStart)).toBe("world");
  });

  it("supports zero-width point anchors", () => {
    const md = "Cursor here<!--mc:a:zzz99--><!--mc:/a:zzz99--> stop.";
    const r = parse(md);
    const a = r.anchors.get("zzz99")!;
    expect(a.openEnd).toBe(a.closeStart);
  });

  it("ignores markers inside fenced code blocks", () => {
    const md = "```\n<!--mc:a:abc12-->x<!--mc:/a:abc12-->\n```";
    const r = parse(md);
    expect(r.anchors.size).toBe(0);
  });

  it("ignores markers inside inline code spans", () => {
    const md = "Try `<!--mc:a:abc12-->x<!--mc:/a:abc12-->` here.";
    const r = parse(md);
    expect(r.anchors.size).toBe(0);
  });

  it("recognizes the threads region and parses one thread per line", () => {
    const md = [
      "Hello <!--mc:a:abc12-->world<!--mc:/a:abc12-->!",
      "",
      "<!--mc:threads:begin-->",
      `<!--mc:t {"id":"abc12","quote":"world","status":"open","comments":[{"id":"c1","author":"r","ts":"${TS}","body":"hi"}]}-->`,
      "<!--mc:threads:end-->",
    ].join("\n");
    const r = parse(md);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].id).toBe("abc12");
    expect(r.threads[0].comments[0].body).toBe("hi");
    expect(r.threadsRegion).not.toBeNull();
  });

  it("flags threads with no matching anchor as unanchored", () => {
    const md = [
      "Plain.",
      "",
      "<!--mc:threads:begin-->",
      `<!--mc:t {"id":"orph1","quote":"missing","status":"open","comments":[{"id":"c1","author":"r","ts":"${TS}","body":"x"}]}-->`,
      "<!--mc:threads:end-->",
    ].join("\n");
    const r = parse(md);
    expect(r.unanchoredThreadIds).toEqual(["orph1"]);
  });

  it("sorts threads by anchor position; unanchored last", () => {
    const md = [
      "<!--mc:a:bbb22-->b<!--mc:/a:bbb22--> <!--mc:a:aaa11-->a<!--mc:/a:aaa11-->",
      "",
      "<!--mc:threads:begin-->",
      `<!--mc:t {"id":"aaa11","quote":"a","status":"open","comments":[{"id":"c1","author":"r","ts":"${TS}","body":"x"}]}-->`,
      `<!--mc:t {"id":"orph1","quote":"missing","status":"open","comments":[{"id":"c1","author":"r","ts":"${TS}","body":"x"}]}-->`,
      `<!--mc:t {"id":"bbb22","quote":"b","status":"open","comments":[{"id":"c1","author":"r","ts":"${TS}","body":"x"}]}-->`,
      "<!--mc:threads:end-->",
    ].join("\n");
    const r = parse(md);
    expect(r.threads.map((t) => t.id)).toEqual(["bbb22", "aaa11", "orph1"]);
  });
});

describe("inlineComments/format - addThread", () => {
  it("wraps the selected text with markers and appends a thread", () => {
    const src = "The quick brown fox jumps.";
    const start = src.indexOf("brown fox");
    const end = start + "brown fox".length;
    const { source: next, thread } = addThread(src, start, end, {
      author: "ronica",
      body: "is it really brown?",
      ts: TS,
    });
    expect(next).toContain(`<!--mc:a:${thread.id}-->brown fox<!--mc:/a:${thread.id}-->`);
    expect(next).toContain("<!--mc:threads:begin-->");
    const r = parse(next);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].quote).toBe("brown fox");
    expect(r.threads[0].comments[0]).toMatchObject({ id: "c1", author: "ronica", body: "is it really brown?", ts: TS });
  });

  it("refuses to anchor inside the existing threads region", () => {
    const src = withThreads("body\n", [
      { id: "zzz00", quote: "", status: "open", comments: [{ id: "c1", author: "r", ts: TS, body: "x" }] },
    ]);
    const regionStart = src.indexOf("<!--mc:threads:begin-->");
    expect(() => addThread(src, regionStart + 5, regionStart + 10, { author: "r", body: "no" })).toThrow();
  });
});

describe("inlineComments/format - replaceThread / appendReply / stripAnchorMarkers", () => {
  const seed = (): string => {
    const { source } = addThread("Hello world.", 6, 11, { author: "ronica", body: "hi", ts: TS });
    return source;
  };

  it("appendReply produces a new thread with monotonically increasing ids", () => {
    const md = seed();
    const r = parse(md);
    const t = r.threads[0];
    const t2 = appendReply(t, { author: "alice", body: "reply", ts: TS, parent: "c1" });
    expect(t2.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(t2.comments[1].parent).toBe("c1");
  });

  it("replaceThread updates the JSON line in place", () => {
    const md = seed();
    const r = parse(md);
    const t = r.threads[0];
    const t2 = { ...t, status: "resolved" as const, resolvedBy: "ronica", resolvedTs: TS };
    const next = replaceThread(md, t.id, t2);
    const r2 = parse(next);
    expect(r2.threads[0].status).toBe("resolved");
    expect(r2.threads[0].resolvedBy).toBe("ronica");
  });

  it("replaceThread(_, _, null) removes the thread and strips its markers", () => {
    const md = seed();
    const r = parse(md);
    const id = r.threads[0].id;
    const next = replaceThread(md, id, null);
    expect(next).not.toContain(`mc:a:${id}`);
    expect(next).not.toContain("<!--mc:threads:");
    expect(parse(next).threads).toHaveLength(0);
  });

  it("stripAnchorMarkers is idempotent", () => {
    const md = seed();
    const id = parse(md).threads[0].id;
    const once = stripAnchorMarkers(md, id);
    const twice = stripAnchorMarkers(once, id);
    expect(twice).toBe(once);
  });

  it("stripAllInlineMarkup leaves the prose intact and removes all mc markup", () => {
    const md = seed();
    const cleaned = stripAllInlineMarkup(md);
    expect(cleaned.trim()).toBe("Hello world.");
  });
});

describe("inlineComments/format - HTML-comment safety", () => {
  it("escapes literal --> in comment bodies so the surrounding <!--mc:t ...--> doesn't terminate early", () => {
    const src = addThread("Hello world.", 6, 11, {
      author: "claude",
      body: "see -->\n```mermaid\ngraph LR; A --> B\n```",
      ts: TS,
    }).source;
    // The on-disk text must contain no `-->` sequence inside the JSON
    // body — every one must be the literal `>` escape.
    const region = src.slice(src.indexOf("<!--mc:threads:begin-->"));
    const threadLine = region.split("\n")[1];
    expect(threadLine.startsWith("<!--mc:t ")).toBe(true);
    // Exactly one `-->` per thread line (the terminator).
    expect(threadLine.match(/-->/g)!.length).toBe(1);
    // Body still round-trips.
    const parsed = parse(src);
    expect(parsed.threads[0].comments[0].body).toContain("see -->");
    expect(parsed.threads[0].comments[0].body).toContain("A --> B");
  });

  it("escapes literal <!-- in comment bodies", () => {
    const src = addThread("Hello world.", 6, 11, {
      author: "claude",
      body: "an example: <!-- example -->",
      ts: TS,
    }).source;
    const region = src.slice(src.indexOf("<!--mc:threads:begin-->"));
    const threadLine = region.split("\n")[1];
    // Only the thread-line opener should be a literal `<!--`.
    expect(threadLine.match(/<!--/g)!.length).toBe(1);
    expect(parse(src).threads[0].comments[0].body).toBe("an example: <!-- example -->");
  });
});

describe("inlineComments/format - round-trip", () => {
  it("parse → render → parse is stable", () => {
    let md = "Doc.\n\nThe quick brown fox.";
    md = addThread(md, md.indexOf("brown"), md.indexOf("brown") + 5, { author: "a", body: "b1", ts: TS }).source;
    md = addThread(md, md.indexOf("Doc"), md.indexOf("Doc") + 3, { author: "a", body: "b2", ts: TS }).source;
    const first = parse(md);
    const rendered = withThreads(md, first.threads);
    const second = parse(rendered);
    expect(second.threads).toEqual(first.threads);
    expect(second.anchors.size).toBe(first.anchors.size);
  });

  it("renderThreadsRegion returns empty string for no threads (so withThreads removes the region)", () => {
    expect(renderThreadsRegion([])).toBe("");
    const md = "body\n\n<!--mc:threads:begin-->\n<!--mc:threads:end-->\n";
    expect(withThreads(md, []).includes("mc:threads")).toBe(false);
  });
});
