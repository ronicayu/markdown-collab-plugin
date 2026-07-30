import { describe, expect, it } from "vitest";
import { buildReviewDigest, countsFor } from "../reviewDigest";
import { addSuggestion, addThread, appendReply, parse, replaceThread } from "../inlineComments/format";
import { withRefreshedAnchorHash } from "../inlineComments/staleness";

const TS = "2026-07-30T09:00:00.000Z";
const NOW = () => TS;

const DOC = `# Guide

The parser handles nested lists correctly.

Suggest mode ships behind a setting.
`;

function open(source: string, quote: string, body: string, author = "ronica") {
  const at = source.indexOf(quote);
  return addThread(source, at, at + quote.length, { author, body, ts: TS });
}

function reply(source: string, threadId: string, body: string, author = "claude"): string {
  const parsed = parse(source);
  const thread = parsed.threads.find((t) => t.id === threadId)!;
  return replaceThread(
    source,
    threadId,
    withRefreshedAnchorHash(parsed, appendReply(thread, { author, body, ts: TS })),
  );
}

/** A document mid-review: one answered thread, one waiting, one suggestion. */
function mixed() {
  const first = open(DOC, "nested lists", "Does this cover ordered lists?");
  let source = reply(first.source, first.thread.id, "Yes — same tokenizer.");
  const second = open(source, "behind a setting", "Which setting?");
  source = second.source;
  const sug = addSuggestion(source, source.indexOf("Guide"), source.indexOf("Guide") + 5, {
    author: "claude",
    proposed: "Handbook",
    note: "Matches the README.",
    ts: TS,
  });
  return { source: sug.source, answered: first.thread.id, waiting: second.thread.id };
}

describe("countsFor", () => {
  it("counts nothing for a document with no review state", () => {
    expect(countsFor(parse(DOC))).toMatchObject({ threads: 0, open: 0, resolved: 0, suggestions: 0 });
  });

  it("separates who owes the next move", () => {
    const { source } = mixed();
    const c = countsFor(parse(source));
    expect(c).toMatchObject({
      threads: 2,
      open: 2,
      resolved: 0,
      suggestions: 1,
      // One thread ends with Claude's reply (the human's move), one doesn't.
      awaitingHuman: 1,
      awaitingClaude: 1,
    });
  });

  it("counts threads Claude opened separately from the human's", () => {
    const claudeThread = open(DOC, "nested lists", "Ordered lists aren't mentioned.", "claude");
    expect(countsFor(parse(claudeThread.source)).fromClaude).toBe(1);
    expect(countsFor(parse(open(DOC, "nested lists", "?").source)).fromClaude).toBe(0);
  });

  it("counts resolved threads and stale ones", () => {
    const t = open(DOC, "nested lists", "?");
    const resolved = replaceThread(t.source, t.thread.id, {
      ...parse(t.source).threads[0]!,
      status: "resolved",
    });
    expect(countsFor(parse(resolved))).toMatchObject({ open: 0, resolved: 1 });

    const a = parse(t.source).anchors.get(t.thread.id)!;
    const edited = t.source.slice(0, a.openEnd) + "ordered lists" + t.source.slice(a.closeStart);
    expect(countsFor(parse(edited)).stale).toBe(1);
  });
});

describe("buildReviewDigest", () => {
  it("says so plainly when there is nothing to summarize", () => {
    const digest = buildReviewDigest([{ rel: "docs/guide.md", parsed: parse(DOC) }], NOW);
    expect(digest).toContain("no review threads");
    expect(digest).not.toContain("### Open");
  });

  it("leads with the headline counts", () => {
    const { source } = mixed();
    const digest = buildReviewDigest([{ rel: "docs/guide.md", parsed: parse(source) }], NOW);
    expect(digest).toContain("`docs/guide.md` — 2 threads, 2 open, 0 resolved, 1 pending suggestion.");
  });

  it("says what is still waiting on whom, before the detail", () => {
    const { source } = mixed();
    const digest = buildReviewDigest([{ rel: "docs/guide.md", parsed: parse(source) }], NOW);
    const stillOpen = digest.indexOf("**Still open:**");
    expect(stillOpen).toBeGreaterThan(0);
    expect(digest.slice(stillOpen)).toContain("waiting on you");
    expect(stillOpen).toBeLessThan(digest.indexOf("### Open"));
  });

  it("lists each thread by id, quote, and gist, with the latest reply", () => {
    const { source, answered } = mixed();
    const digest = buildReviewDigest([{ rel: "docs/guide.md", parsed: parse(source) }], NOW);
    expect(digest).toContain(`**\`${answered}\`** on "nested lists"`);
    expect(digest).toContain("Does this cover ordered lists?");
    expect(digest).toContain("claude: Yes — same tokenizer.");
  });

  it("lists pending suggestions as original → proposed", () => {
    const { source } = mixed();
    const digest = buildReviewDigest([{ rel: "docs/guide.md", parsed: parse(source) }], NOW);
    expect(digest).toContain("### Pending suggestions");
    expect(digest).toContain('"Guide" → "Handbook"');
    expect(digest).toContain("Matches the README.");
  });

  it("marks Claude's own findings and stale anchors", () => {
    const t = open(DOC, "nested lists", "Ordered lists aren't mentioned.", "claude");
    const a = parse(t.source).anchors.get(t.thread.id)!;
    const edited = t.source.slice(0, a.openEnd) + "ordered lists" + t.source.slice(a.closeStart);
    const digest = buildReviewDigest([{ rel: "docs/guide.md", parsed: parse(edited) }], NOW);
    expect(digest).toContain("from Claude");
    expect(digest).toContain("text changed since");
  });

  it("groups by file for a multi-file summary", () => {
    const { source } = mixed();
    const other = open(DOC, "behind a setting", "And here?");
    const digest = buildReviewDigest(
      [
        { rel: "docs/guide.md", parsed: parse(source) },
        { rel: "docs/other.md", parsed: parse(other.source) },
      ],
      NOW,
    );
    expect(digest).toContain("2 files — 3 threads");
    expect(digest).toContain("## `docs/guide.md`");
    expect(digest).toContain("## `docs/other.md`");
  });

  it("is markdown a human can paste elsewhere", () => {
    const { source } = mixed();
    const digest = buildReviewDigest([{ rel: "docs/guide.md", parsed: parse(source) }], NOW);
    expect(digest.startsWith("# Review summary")).toBe(true);
    expect(digest.endsWith("\n")).toBe(true);
    // No marker leakage — the digest quotes prose, and quotes must be clean.
    expect(digest).not.toContain("<!--mc:");
  });

  it("truncates a long quote rather than swallowing the summary", () => {
    const longDoc = `# T\n\n${"a very long anchored sentence ".repeat(20)}\n`;
    const quote = longDoc.slice(longDoc.indexOf("a very"), longDoc.indexOf("a very") + 400);
    const at = longDoc.indexOf(quote);
    const t = addThread(longDoc, at, at + quote.length, { author: "ronica", body: "?", ts: TS });
    const digest = buildReviewDigest([{ rel: "d.md", parsed: parse(t.source) }], NOW);
    expect(digest).toContain("…");
    for (const line of digest.split("\n")) expect(line.length).toBeLessThan(300);
  });
});
