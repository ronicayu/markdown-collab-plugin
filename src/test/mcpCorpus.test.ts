// The corpus documents, driven entirely through the MCP tools (10x-plan-2 P0.3).
//
// The round-trip corpus proves the *engine* survives gnarly documents. This
// proves the same for the path Claude actually takes once the skill is
// tools-first: every mutation goes through `callTool`, against the same
// fixtures, and the document has to come out of a full review pass with its
// integrity intact and its prose untouched except where a tool was asked to
// change it.
//
// If this passes and the skill's happy path is only tool calls, then a review
// pass cannot corrupt a document by construction — which is the claim P0.3
// makes when it demotes the marker-surgery instructions to an appendix.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { callTool, type ToolDeps } from "../mcpServer/tools";
import { checkIntegrity } from "../inlineComments/integrity";
import { parse, stripAllInlineMarkup } from "../inlineComments/format";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "roundtrip");

function fixtures(): string[] {
  return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".md")).sort();
}

/** An in-memory workspace holding one fixture. */
function harness(initial: string) {
  let doc = initial;
  const deps: ToolDeps = {
    resolveFile: async (file) => file,
    readDoc: async () => doc,
    writeDoc: async (_key, next) => {
      doc = next;
    },
    now: () => "2026-07-30T00:00:00.000Z",
  };
  return {
    read: () => doc,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await callTool(name, { file: "doc.md", ...args }, deps);
      return { raw: r, body: JSON.parse(r.content[0]!.text) };
    },
  };
}

/** First prose sentence-ish span we can safely anchor: a heading's text. */
function firstHeadingText(source: string): string | null {
  for (const line of stripAllInlineMarkup(source).split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m && m[1] && m[1].trim().length > 3 && !m[1].includes("`")) return m[1].trim();
  }
  return null;
}

describe("corpus documents survive a tools-only review pass", () => {
  for (const name of fixtures()) {
    it(`${name}: open → reply → suggest → check leaves the document healthy`, async () => {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
      const quote = firstHeadingText(source);
      if (!quote) return; // fixture with no anchorable heading — nothing to drive
      const h = harness(source);
      const proseBefore = stripAllInlineMarkup(source);

      const opened = await h.call("mc_open", { quote, body: "Is this heading right?" });
      expect(opened.raw.isError, JSON.stringify(opened.body)).toBeUndefined();
      const threadId = opened.body.threadId as string;

      const replied = await h.call("mc_reply", { threadId, body: "Checked against the outline." });
      expect(replied.raw.isError).toBeUndefined();

      const suggested = await h.call("mc_suggest", {
        quote,
        with: `${quote} (revised)`,
        note: "Match the outline.",
      });
      expect(suggested.raw.isError, JSON.stringify(suggested.body)).toBeUndefined();

      const checked = await h.call("mc_check");
      expect(checked.body.ok, JSON.stringify(checked.body.issues)).toBe(true);

      // Nothing but the marker insertions: a suggestion leaves the original
      // text in place, and a reply lives in the threads region.
      expect(stripAllInlineMarkup(h.read()).trimEnd()).toBe(proseBefore.trimEnd());
      // The thread and the suggestion both round-trip through a fresh parse.
      const parsed = parse(h.read());
      expect(parsed.threads.some((t) => t.id === threadId)).toBe(true);
      expect(parsed.suggestions).toHaveLength(1);
    });
  }

  it("a rewrite through the tools keeps every fixture's integrity", async () => {
    for (const name of fixtures()) {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
      const quote = firstHeadingText(source);
      if (!quote) continue;
      const h = harness(source);
      const opened = await h.call("mc_open", { quote, body: "rewrite me" });
      if (opened.raw.isError) continue;
      const rewritten = await h.call("mc_rewrite", {
        threadId: opened.body.threadId,
        with: "A completely different heading",
      });
      expect(rewritten.raw.isError, `${name}: ${JSON.stringify(rewritten.body)}`).toBeUndefined();
      expect(checkIntegrity(h.read()).ok, `${name} integrity`).toBe(true);
      expect(h.read()).toContain("A completely different heading");
    }
  });

  it("accepting a suggestion through the tools applies it and stays healthy", async () => {
    const source = fs.readFileSync(path.join(FIXTURE_DIR, fixtures()[0]!), "utf8");
    const quote = firstHeadingText(source)!;
    const h = harness(source);
    const s = await h.call("mc_suggest", { quote, with: "Replaced heading", note: "why" });
    const accepted = await h.call("mc_accept", { anchorId: s.body.anchorId });
    expect(accepted.raw.isError).toBeUndefined();
    expect(h.read()).toContain("Replaced heading");
    expect(h.read()).not.toContain(quote);
    expect(checkIntegrity(h.read()).ok).toBe(true);
    expect(parse(h.read()).suggestions).toHaveLength(0);
  });
});
