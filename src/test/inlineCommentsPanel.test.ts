import { describe, expect, it } from "vitest";
import { addThread, parse } from "../inlineComments/format";
import { mostRecentAgentName, serialize } from "../inlineComments/inlineCommentsPanel";

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

  it("strips YAML frontmatter from the rendered prose", () => {
    const src = "---\ntitle: My Doc\nauthor: me\n---\n\n# Heading\n\nBody.";
    const ser = serialize(parse(src));
    expect(ser.prose).not.toContain("title:");
    expect(ser.prose).not.toContain("author:");
    expect(ser.prose).not.toMatch(/^---/);
    expect(ser.prose.trimStart().startsWith("# Heading")).toBe(true);
  });

  it("anchor offsets remain valid in prose space when frontmatter is stripped", () => {
    const src = "---\ntitle: hi\n---\n\nHello brave world.";
    // Anchor "brave" in the body — its source offset is past the frontmatter.
    const start = src.indexOf("brave");
    const end = start + "brave".length;
    const after = addThread(src, start, end, { author: "r", body: "x", ts: "2026-05-12T00:00:00Z" }).source;
    const ser = serialize(parse(after));
    const anchor = ser.threads[0].anchor!;
    expect(ser.prose.slice(anchor.proseStart, anchor.proseEnd)).toBe("brave");
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

// 10x-plan-6 P5.2: the host tells the webview who to name instead of it
// hardcoding "Claude" — the agent behind whichever comment or suggestion in
// the file has the latest timestamp, among agent-authored ones only.
describe("mostRecentAgentName", () => {
  const withThreadsBlock = (...lines: string[]) =>
    ["Plain.", "", "<!--mc:threads:begin-->", ...lines, "<!--mc:threads:end-->"].join("\n");

  it("defaults to Claude when no agent has written to the file", () => {
    expect(mostRecentAgentName(parse("No threads at all."))).toBe("Claude");
  });

  it("defaults to Claude when every comment is a human's", () => {
    const md = withThreadsBlock(
      `<!--mc:t {"id":"t1","quote":"a","status":"open","comments":[{"id":"c1","author":"ronica","ts":"2026-01-01T00:00:00Z","body":"note"}]}-->`,
    );
    expect(mostRecentAgentName(parse(md))).toBe("Claude");
  });

  it("names the agent behind the single agent-authored comment", () => {
    const md = withThreadsBlock(
      `<!--mc:t {"id":"t1","quote":"a","status":"open","comments":[{"id":"c1","author":"codex","agent":true,"ts":"2026-01-01T00:00:00Z","body":"fixed"}]}-->`,
    );
    expect(mostRecentAgentName(parse(md))).toBe("Codex");
  });

  it("picks the latest-timestamped agent write across threads", () => {
    const md = withThreadsBlock(
      `<!--mc:t {"id":"t1","quote":"a","status":"open","comments":[{"id":"c1","author":"claude","agent":true,"ts":"2026-01-01T00:00:00Z","body":"x"}]}-->`,
      `<!--mc:t {"id":"t2","quote":"b","status":"open","comments":[{"id":"c1","author":"codex","agent":true,"ts":"2026-01-02T00:00:00Z","body":"y"}]}-->`,
    );
    expect(mostRecentAgentName(parse(md))).toBe("Codex");
  });

  it("ignores a later human reply — only agent writes count for the timestamp", () => {
    const md = withThreadsBlock(
      `<!--mc:t {"id":"t1","quote":"a","status":"open","comments":[` +
        `{"id":"c1","author":"claude","agent":true,"ts":"2026-01-01T00:00:00Z","body":"x"},` +
        `{"id":"c2","author":"ronica","ts":"2026-01-05T00:00:00Z","body":"thanks"}]}-->`,
    );
    expect(mostRecentAgentName(parse(md))).toBe("Claude");
  });

  it("counts a pending suggestion, not just comments", () => {
    const md = withThreadsBlock(
      `<!--mc:t {"id":"t1","quote":"a","status":"open","comments":[{"id":"c1","author":"claude","agent":true,"ts":"2026-01-01T00:00:00Z","body":"x"}]}-->`,
      `<!--mc:s {"anchorId":"s1","author":"cursor","agent":true,"ts":"2026-02-01T00:00:00Z","original":"foo","proposed":"bar"}-->`,
    );
    expect(mostRecentAgentName(parse(md))).toBe("Cursor");
  });

  it("recognizes a known agent slug written before the explicit `agent` flag existed", () => {
    const md = withThreadsBlock(
      `<!--mc:t {"id":"t1","quote":"a","status":"open","comments":[{"id":"c1","author":"codex","ts":"2026-01-01T00:00:00Z","body":"legacy"}]}-->`,
    );
    expect(mostRecentAgentName(parse(md))).toBe("Codex");
  });
});
