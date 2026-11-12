// One skill source, four renderings.
//
// Every agent that can run a command — Claude Code (plugin or standalone
// skill) and the agents Connect gives `~/.agents/skills` — reads the same short
// skill: change a reviewed file only with `mdc`, and how to run it. A headless
// run has no shell, so it keeps the tools-only workflow, pinned below against
// a fixture: a deliberate change to it regenerates
// `fixtures/skill/headless-SKILL.md`.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { SKILL_CONTENT } from "../skill";
import {
  HEADLESS_PREAMBLE,
  MCP_INSTRUCTIONS_MAX_CHARS,
  headlessSystemPrompt,
  renderMcpInstructions,
  renderReviewGuide,
  renderSkill,
} from "../skillText";

const legacy = renderSkill("legacy");
const plugin = renderSkill("plugin");
const headless = renderSkill("headless");
const agents = renderSkill("agents");

function frontmatter(text: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  return Object.fromEntries(
    m[1]!.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
  );
}

describe("the mdc skill — plugin, standalone and agents alike", () => {
  it("is one text under three names, with the same description, within the 1024-character limit", () => {
    expect(frontmatter(plugin)!.name).toBe("review");
    expect(frontmatter(legacy)!.name).toBe("vs-markdown-collab");
    expect(frontmatter(agents)!.name).toBe("markdown-collab");
    const d = frontmatter(plugin)!.description;
    expect(frontmatter(legacy)!.description).toBe(d);
    expect(frontmatter(agents)!.description).toBe(d);
    expect(d.length).toBeLessThanOrEqual(1024);
  });

  it("tells each reader how to run mdc", () => {
    expect(plugin).toContain("`mdc <command> <file> …`");
    expect(plugin).not.toContain("~/.claude/skills");
    expect(legacy).toContain("`node ~/.claude/skills/vs-markdown-collab/mdc.mjs <command> <file> …`");
    expect(agents).toContain("`node ~/.agents/skills/markdown-collab/mdc.mjs <command> <file> …`");
  });

  it("is what the standalone installer writes", () => {
    expect(SKILL_CONTENT).toBe(legacy);
  });

  it("says nothing about editing markers by hand, in any of them", () => {
    for (const text of [plugin, legacy, agents]) {
      expect(text).toContain("## The one rule: change a reviewed file only with `mdc`");
      for (const phrase of ["old_string", "Appendix", "Path 2", "Repair Comment Anchors"]) expect(text).not.toContain(phrase);
    }
  });

  it("mentions the guard hook only in the plugin, which has it", () => {
    expect(plugin).toContain("This plugin also refuses an Edit or Write that would change a marker or thread line");
    for (const text of [legacy, agents]) expect(text).not.toContain("This plugin");
  });

  it("asks agents other than Claude to sign their comments, and doesn't say Claude to them", () => {
    expect(agents).toContain("Pass `--author <your name>`");
    expect(agents).not.toContain("Claude");
    expect(plugin).not.toContain("--author");
  });

  it("redirects a non-Claude reader of the standalone skill, and only there", () => {
    const redirect = "If you are not Claude Code and have a `markdown-collab` skill, use that one instead of this.";
    expect(legacy).toContain(redirect);
    for (const text of [plugin, headless, agents]) expect(text).not.toContain("use that one instead of this");
  });

  it("keeps the rules that matter, and leaves the rubric to mdc help review", () => {
    for (const text of [plugin, legacy, agents]) {
      expect(text).toContain("never re-anchor it to nearby text");
      expect(text).toContain("Only the human resolves, accepts or rejects.");
      expect(text).toContain("make every change with `suggest` — no direct edits at all");
      expect(text).toContain("help review` first and follow it.");
      expect(text).not.toContain("Rank concerns by severity");
    }
  });
});

describe("the review guide (mdc help review)", () => {
  const guide = renderReviewGuide();

  it("carries the rubric the skills point at", () => {
    expect(guide).toContain("Rank concerns by severity and open threads for the **five** that matter most.");
    expect(guide).toContain("It is the **primary filter**");
    expect(guide).toContain("## Multi-file review passes");
    expect(guide).toContain("## Delta passes");
  });

  it("is the same rubric the headless workflow carries, apart from how it names the verbs", () => {
    const rubricAt = headless.indexOf("#### Focus directive");
    const rubricEnd = headless.indexOf("#### Workflow — Review Mode pass, in short");
    const fromHeadless = headless
      .slice(rubricAt, rubricEnd)
      .replace(/^#### /gm, "## ")
      .replace(/`mc_check`/g, "`mdc check`")
      .replace("Phase 5 constraints", "the anchoring rules `open` enforces")
      .replace("same Phase 5 mechanics", "same `open` mechanics");
    expect(guide).toContain(fromHeadless.trimEnd());
  });
});

describe("headless rendering (tools only)", () => {
  it("is unchanged — the fixture is the text a headless run reads", () => {
    const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "skill", "headless-SKILL.md"), "utf8");
    expect(headless).toBe(fixture);
  });

  it("has no frontmatter", () => {
    expect(frontmatter(headless)).toBeNull();
    expect(headless.startsWith("# Markdown Collab — agentic review-address skill\n")).toBe(true);
  });

  it("never mentions the CLI, the Edit tool, or the hand-editing appendix", () => {
    expect(headless).not.toContain("mdc");
    expect(headless).not.toContain("(CLI:");
    expect(headless).not.toContain("Edit tool");
    expect(headless.toLowerCase()).not.toContain("appendix");
    expect(headless).not.toContain("old_string");
  });

  it("still carries every tool and the rules that matter", () => {
    for (const tool of ["mc_list", "mc_reply", "mc_rewrite", "mc_edit", "mc_open", "mc_resolve", "mc_suggest", "mc_accept", "mc_check", "mc_status"]) {
      expect(headless, tool).toContain(tool);
    }
    expect(headless).toContain("Rank concerns by severity and open threads for the **five** that matter most.");
    expect(headless).toContain("Deletions become orphans by design");
    expect(headless).toContain("do NOT re-anchor to nearby unrelated text");
    expect(headless).toMatch(/mc_check[\s\S]{0,400}Waiting\s+for\s+the\s+agent/);
  });

  it("is the headless system prompt, after the preamble", () => {
    expect(headlessSystemPrompt()).toBe(`${HEADLESS_PREAMBLE}\n\n${headless}`);
  });
});

describe("MCP instructions", () => {
  const instructions = renderMcpInstructions();

  it(`fits in ${MCP_INSTRUCTIONS_MAX_CHARS} characters`, () => {
    expect(MCP_INSTRUCTIONS_MAX_CHARS).toBe(2000);
    expect(instructions.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_MAX_CHARS);
  });

  it("gives the list → act → check order, with mc_check last on every file", () => {
    const list = instructions.indexOf("1. Discover — `mc_list");
    const act = instructions.indexOf("2. Act —");
    const check = instructions.indexOf("3. Verify — `mc_check(file)` LAST on every file you touched");
    expect(list).toBeGreaterThan(0);
    expect(act).toBeGreaterThan(list);
    expect(check).toBeGreaterThan(act);
  });

  it("carries the rules a client with no skill must still follow", () => {
    for (const rule of [
      "Only the human resolves",
      "append-only history",
      "open a thread with `mc_open` for the five most severe concerns, then one summary thread for the rest",
      "Suggest mode: route every change through `mc_suggest`",
      "`mc_rewrite` changes text inside a thread's anchor; `mc_edit` changes prose outside anchors",
      "never hand-edit a marker",
      "Call `mc_help` for the full workflow",
    ]) {
      expect(instructions, rule).toContain(rule);
    }
  });

  it("never mentions the CLI — an MCP client has the tools, not mdc", () => {
    expect(instructions).not.toContain("mdc");
  });
});
