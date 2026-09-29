import { describe, expect, it } from "vitest";
import {
  addThread,
  appendReply,
  parse,
  renderThreadsRegion,
  replaceThread,
  startPastHeadingPrefix,
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

  it("stripAllInlineMarkup unwraps nested markers around a heading (PR-preview regression)", () => {
    // The PR review preview rendered raw markers, so a heading wrapped by two
    // overlapping anchors showed as literal `<!--mc:a:...-->` text and lost its
    // `## ` heading parse. Stripping must restore the bare heading.
    const md =
      "<!--mc:a:199b4--><!--mc:a:9b11a-->## How to use this template" +
      "<!--mc:/a:9b11a--><!--mc:/a:199b4-->\n\n" +
      "Body with an <!--mc:a:abc12-->inline note<!--mc:/a:abc12--> here.\n\n" +
      "<!--mc:threads:begin-->\n" +
      '<!--mc:t {"id":"199b4","quote":"## How to use this template","status":"open","comments":[]}-->\n' +
      "<!--mc:threads:end-->\n";
    const cleaned = stripAllInlineMarkup(md);
    expect(cleaned).toContain("## How to use this template");
    expect(cleaned).not.toContain("mc:a:");
    expect(cleaned).not.toContain("mc:threads");
    // Inline markers carry no newline and the threads region is trailing, so
    // the heading stays on line 1 — the property the diff stripes rely on.
    expect(cleaned.split("\n")[0]).toBe("## How to use this template");
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

describe("startPastHeadingPrefix", () => {
  it("bumps a start on the `#` prefix to just after `## `", () => {
    expect(startPastHeadingPrefix("## Heading 2", 0, 12)).toBe(3);
  });

  it("is a no-op when start is already past the prefix", () => {
    expect(startPastHeadingPrefix("## Heading 2", 3, 12)).toBe(3);
    expect(startPastHeadingPrefix("## Heading 2", 7, 12)).toBe(7);
  });

  it("handles all heading depths and up to 3 leading spaces", () => {
    expect(startPastHeadingPrefix("###### Deep", 0, 11)).toBe(7);
    expect(startPastHeadingPrefix("   ## Indented", 0, 14)).toBe(6);
  });

  it("is a no-op on non-heading lines", () => {
    expect(startPastHeadingPrefix("plain text", 0, 5)).toBe(0);
    expect(startPastHeadingPrefix("    ## indented 4 = code block", 0, 10)).toBe(0);
    expect(startPastHeadingPrefix("#nospace", 0, 5)).toBe(0);
  });

  it("operates on the start's own line in a multi-line doc", () => {
    const md = "intro\n\n## Section\n\nbody";
    const lineStart = md.indexOf("## Section");
    expect(startPastHeadingPrefix(md, lineStart, lineStart + 10)).toBe(lineStart + 3);
  });

  it("never moves past the selection end", () => {
    // Selection covers only the prefix — bumping would invert, so clamp to limit.
    expect(startPastHeadingPrefix("## Heading", 0, 2)).toBe(2);
  });
});

describe("addThread — heading anchors", () => {
  it("places the open marker after the heading hashes, keeping the line a heading", () => {
    const md = "## Heading 2\n\nbody";
    const { source, thread } = addThread(md, 0, 12, { author: "ron", body: "fix", ts: TS });
    expect(source).toContain(`## <!--mc:a:${thread.id}-->Heading 2<!--mc:/a:${thread.id}-->`);
    // The quote is the heading text without the `## ` prefix or markers.
    expect(thread.quote).toBe("Heading 2");
    // It still parses as one open thread anchored on the heading text.
    const parsed = parse(source);
    expect(parsed.threads).toHaveLength(1);
    const a = parsed.anchors.get(thread.id)!;
    expect(source.slice(a.openEnd, a.closeStart)).toBe("Heading 2");
  });
});

describe("inlineComments/format - threads region inside code", () => {
  const FENCED_SAMPLE = [
    "# Format",
    "",
    "The storage looks like this:",
    "",
    "```markdown",
    "The <!--mc:a:k7q3p-->quick fox<!--mc:/a:k7q3p--> jumps.",
    "",
    "<!--mc:threads:begin-->",
    '<!--mc:t {"id":"k7q3p","quote":"quick fox","status":"open","comments":[{"id":"c1","author":"r","ts":"2026-05-13T12:00:00Z","body":"x"}]}-->',
    "<!--mc:threads:end-->",
    "```",
    "",
    "A real sentence to comment on.",
    "",
  ].join("\n");

  it("does not treat a fenced sample region as the live one", () => {
    const r = parse(FENCED_SAMPLE);
    expect(r.threads).toEqual([]);
  });

  it("writes the first real thread after the fence, leaving the sample intact", () => {
    const at = FENCED_SAMPLE.indexOf("A real sentence");
    const { source } = addThread(FENCED_SAMPLE, at, at + "A real sentence".length, {
      author: "r",
      body: "note",
      ts: TS,
    });
    // Everything up to the commented sentence — the fenced sample included —
    // is byte-for-byte what it was.
    const beforeSentence = FENCED_SAMPLE.slice(0, FENCED_SAMPLE.indexOf("A real sentence"));
    expect(source.startsWith(beforeSentence)).toBe(true);
    const r = parse(source);
    expect(r.threads.map((t) => t.quote)).toEqual(["A real sentence"]);
    expect(source.lastIndexOf("<!--mc:threads:begin-->")).toBeGreaterThan(beforeSentence.length);
  });

  it("uses the real tail region when a fenced sample precedes it", () => {
    const at = FENCED_SAMPLE.indexOf("A real sentence");
    const { source } = addThread(FENCED_SAMPLE, at, at + "A real sentence".length, {
      author: "r",
      body: "note",
      ts: TS,
    });
    const r = parse(source);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].comments[0].body).toBe("note");
  });

  it("still finds a tail region after an unterminated fence", () => {
    const doc = "Intro.\n\n```js\nconst x = 1;\n\n" + [
      "<!--mc:threads:begin-->",
      '<!--mc:t {"id":"aa1","quote":"Intro.","status":"open","comments":[{"id":"c1","author":"r","ts":"2026-05-13T12:00:00Z","body":"x"}]}-->',
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
    expect(parse(doc).threads.map((t) => t.id)).toEqual(["aa1"]);
  });

  it("ignores a begin marker mentioned in inline code", () => {
    expect(parse("Look for `<!--mc:threads:begin-->` and `<!--mc:threads:end-->` in the file.\n").threads).toEqual([]);
  });

  it("keeps accepting a real region that has prose after it", () => {
    const doc = [
      "Hello.",
      "",
      "<!--mc:threads:begin-->",
      '<!--mc:t {"id":"bb2","quote":"Hello.","status":"open","comments":[{"id":"c1","author":"r","ts":"2026-05-13T12:00:00Z","body":"x"}]}-->',
      "<!--mc:threads:end-->",
      "",
      "Someone appended this later.",
      "",
    ].join("\n");
    expect(parse(doc).threads.map((t) => t.id)).toEqual(["bb2"]);
  });
});

// 10x-plan-6 P1.4: `via` is optional and additive. A file written before it
// existed must re-serialize to the same bytes, a value this version doesn't
// know reads as absent, and the two known values survive every rewrite.
describe("inlineComments/format - the via field", () => {
  const region = (thread: string, suggestion?: string) =>
    [
      "Doc with <!--mc:a:aa111-->a passage<!--mc:/a:aa111--> and <!--mc:a:bb222-->another<!--mc:/a:bb222-->.",
      "",
      "<!--mc:threads:begin-->",
      thread,
      ...(suggestion ? [suggestion] : []),
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
  const LEGACY_THREAD =
    '<!--mc:t {"id":"aa111","quote":"a passage","status":"open","anchorHash":"0badf00d","comments":[' +
    '{"id":"c1","author":"ronica","ts":"2026-05-12T10:00:00.000Z","body":"why?"},' +
    '{"id":"c2","author":"claude","agent":true,"ts":"2026-05-12T10:01:00.000Z","body":"because","parent":"c1"}]}-->';
  const LEGACY_SUGGESTION =
    '<!--mc:s {"anchorId":"bb222","author":"claude","agent":true,"ts":"2026-05-12T10:02:00.000Z","original":"another","proposed":"one more"}-->';

  it("a file without it re-serializes byte for byte", () => {
    const md = region(LEGACY_THREAD, LEGACY_SUGGESTION);
    const parsed = parse(md);
    expect(withThreads(md, parsed.threads, parsed.suggestions)).toBe(md);
    expect(parsed.threads[0]!.comments.every((c) => !("via" in c))).toBe(true);
    expect(parsed.suggestions[0]!.via).toBeUndefined();
  });

  it("tools and cli survive parse → serialize → parse on comments and suggestions", () => {
    const md = region(
      LEGACY_THREAD.replace('"agent":true,', '"agent":true,"via":"cli",'),
      LEGACY_SUGGESTION.replace('"agent":true,', '"agent":true,"via":"tools",'),
    );
    const parsed = parse(md);
    expect(parsed.threads[0]!.comments.map((c) => c.via)).toEqual([undefined, "cli"]);
    expect(parsed.suggestions[0]!.via).toBe("tools");
    expect(withThreads(md, parsed.threads, parsed.suggestions)).toBe(md);
  });

  it("an unknown value reads as absent and is not written back", () => {
    const md = region(
      LEGACY_THREAD.replace('"agent":true,', '"agent":true,"via":"file",'),
      LEGACY_SUGGESTION.replace('"agent":true,', '"agent":true,"via":{"x":1},'),
    );
    const parsed = parse(md);
    expect(parsed.threads[0]!.comments.map((c) => c.via)).toEqual([undefined, undefined]);
    expect(parsed.suggestions[0]!.via).toBeUndefined();
    expect(withThreads(md, parsed.threads, parsed.suggestions)).toBe(region(LEGACY_THREAD, LEGACY_SUGGESTION));
  });

  it("appendReply and addThread write it only when given", () => {
    const md = "The quick brown fox.";
    const plain = addThread(md, 4, 9, { author: "a", body: "b", ts: TS });
    expect(plain.source).not.toContain('"via"');
    const stamped = addThread(md, 4, 9, { author: "codex", agent: true, via: "tools", body: "b", ts: TS });
    expect(stamped.thread.comments[0]).toMatchObject({ via: "tools" });
    expect(appendReply(plain.thread, { author: "r", body: "x", ts: TS }).comments[1]).not.toHaveProperty("via");
    expect(appendReply(plain.thread, { author: "c", body: "x", ts: TS, via: "cli" }).comments[1]!.via).toBe("cli");
  });
});
