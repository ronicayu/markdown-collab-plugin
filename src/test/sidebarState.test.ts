import { describe, expect, it } from "vitest";
import { addThread, appendReply, parse, replaceThread } from "../inlineComments/format";
import { serialize } from "../inlineComments/serializeState";
import { mostRecentAgentName, sidebarDocumentFields, skillBannerStatus } from "../collab/sidebarState";

// The live editor's sidebar renders from the same thread list
// the review view's panel serializes, plus the agent name for its toolbar.
describe("sidebarDocumentFields", () => {
  const DOC = "# Doc\n\nAlpha sentence.\n\nBeta sentence.\n";
  const TS = "2026-01-01T00:00:00.000Z";

  it("is the review view's thread list, full comments included", () => {
    const at = DOC.indexOf("Alpha");
    const first = addThread(DOC, at, at + 5, { author: "ronica", body: "Why?", ts: TS });
    const source = replaceThread(
      first.source,
      first.thread.id,
      appendReply(first.thread, { author: "claude", body: "Because.", ts: TS, agent: true, via: "tools" }),
    );
    const fields = sidebarDocumentFields(source);
    expect(fields.threads).toEqual(serialize(parse(source)).threads);
    expect(fields.threads[0].comments[1]).toMatchObject({ author: "claude", agent: true, via: "tools" });
    expect(fields.agentName).toBe("Claude");
  });

  it("gives a thread whose markers are gone a null anchor — the card's 'broken anchor'", () => {
    const at = DOC.indexOf("Beta");
    const { source, thread } = addThread(DOC, at, at + 4, { author: "ronica", body: "x", ts: TS });
    const orphaned = source.replace(`<!--mc:a:${thread.id}-->`, "").replace(`<!--mc:/a:${thread.id}-->`, "");
    expect(sidebarDocumentFields(orphaned).threads[0].anchor).toBeNull();
    expect(sidebarDocumentFields(source).threads[0].anchor).not.toBeNull();
  });

  it("is empty for a document nobody has reviewed", () => {
    // No agent has written here, so there is no `agentName` at all — the
    // sidebar words Send and the waiting row generically instead of guessing.
    const fields = sidebarDocumentFields(DOC);
    expect(fields).toEqual({ threads: [] });
    expect("agentName" in fields).toBe(false);
  });

  it("omits agentName when only people have commented", () => {
    const at = DOC.indexOf("Alpha");
    const { source } = addThread(DOC, at, at + 5, { author: "ronica", body: "Why?", ts: TS });
    expect("agentName" in sidebarDocumentFields(source)).toBe(false);
  });
});

// The live editor's copy of the review view panel's helper — the same cases.
describe("mostRecentAgentName (sidebarState)", () => {
  const withThreadsBlock = (...lines: string[]) =>
    ["Plain.", "", "<!--mc:threads:begin-->", ...lines, "<!--mc:threads:end-->"].join("\n");

  it("is undefined when no agent has written to the file", () => {
    expect(mostRecentAgentName(parse("No threads at all."))).toBeUndefined();
  });

  it("picks the latest-timestamped agent write across threads", () => {
    const md = withThreadsBlock(
      `<!--mc:t {"id":"t1","quote":"a","status":"open","comments":[{"id":"c1","author":"claude","agent":true,"ts":"2026-01-01T00:00:00Z","body":"x"}]}-->`,
      `<!--mc:t {"id":"t2","quote":"b","status":"open","comments":[{"id":"c1","author":"codex","agent":true,"ts":"2026-01-02T00:00:00Z","body":"y"}]}-->`,
    );
    expect(mostRecentAgentName(parse(md))).toBe("Codex");
  });

  it("ignores a later human reply — only agent writes count", () => {
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
});

// The skill banner is about the Claude skill: it shows for people running
// Claude Code, and stays quiet on a Cursor- or Codex-only machine.
describe("skillBannerStatus", () => {
  it("shows missing / outdated when Claude Code is on the machine", () => {
    expect(skillBannerStatus("missing", true)).toBe("missing");
    expect(skillBannerStatus("outdated", true)).toBe("outdated");
    expect(skillBannerStatus("current", true)).toBe("current");
  });

  it("stays hidden without Claude Code, whatever the skill files say", () => {
    expect(skillBannerStatus("missing", false)).toBe("current");
    expect(skillBannerStatus("outdated", false)).toBe("current");
    expect(skillBannerStatus("current", false)).toBe("current");
  });
});
