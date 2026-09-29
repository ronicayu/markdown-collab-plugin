// One skill source, four renderings (10x-plan-4 P0.2 + P1.3).
//
// The legacy rendering is what every standalone install already has on disk,
// so the refactor into sections had to reproduce it byte for byte. The fixture
// is the text as it was BEFORE the refactor; the only differences allowed are
// the deliberate edits listed below (Part D: `mc_edit` can now delete a whole
// anchored passage, so the skill says to use it). The next deliberate change
// to the skill should regenerate the fixture and empty the list.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { SKILL_CONTENT } from "../skill";
import {
  HEADLESS_PREAMBLE,
  MCP_INSTRUCTIONS_MAX_CHARS,
  headlessSystemPrompt,
  renderMcpInstructions,
  renderSkill,
} from "../skillText";

const PRE_REFACTOR = fs.readFileSync(
  path.join(__dirname, "fixtures", "skill", "legacy-SKILL.pre-p02.md"),
  "utf8",
);

/** [before, after] — every deliberate edit to the legacy text in this change. */
const INTENTIONAL_CHANGES: Array<[string, string]> = [
  [
    "| Replaces exact text outside anchored spans (prose, frontmatter). Refuses anything that touches a marker or the threads region — use `mc_rewrite` inside an anchor. |",
    "| Replaces exact text outside anchored spans (prose, frontmatter), or deletes an anchored passage when `old` spans both of its markers. Refuses anything that splits a marker pair or touches the threads region — use `mc_rewrite` inside an anchor. |",
  ],
  [
    "which refuses anything that would touch a marker or the threads region; the Edit tool remains fine",
    "which refuses anything that would break a marker or touch the threads region; the Edit tool remains fine",
  ],
  [
    "Removing the anchored passage: delete both markers and the passage with the Edit tool — the thread orphans",
    "Removing the anchored passage: delete the open marker, the passage, and the close marker together with `mc_edit`/`mdc edit` (or the Edit tool interactively) — `old` spans both markers, so nothing is split; the thread orphans",
  ],
  // The CLI's failure envelope and exit-code meaning (ux-review 0.7).
  [
    "prints JSON to stdout with exit codes `0` ok, `1` usage error, `2` integrity violation",
    'prints JSON to stdout — a failure is `{"ok":false,"code":…,"message":…}` — with exit codes `0` ok, `1` usage error or refusal, `2` integrity violation',
  ],
  // Command titles went agent-neutral (ux-review 2.4).
  [
    '"Ask Claude to Review This Doc" / "Ask Claude to Review These Docs" commands',
    '"Ask Agent to Review This Doc" / "Ask Agent to Review These Docs" commands',
  ],
  [
    'the extension\'s "Ask Claude to Review These Docs" command builds',
    'the extension\'s "Ask Agent to Review These Docs" command builds',
  ],
  // Integrity gained the empty-quote issue (ux-review 0.1).
  [
    "malformed thread JSON, duplicate ids",
    "empty quotes, malformed thread JSON, duplicate ids",
  ],
  // Register Review Tools is a hidden alias of Connect an Agent (ux-review 1.1).
  [
    "add them with **Markdown Collab: Register Review Tools with Claude Code**, then restart.",
    "add them with **Markdown Collab: Connect an Agent…** → Claude Code, then restart.",
  ],
  // 10x-plan-6 P1.3: stop implying other agents have `mdc` — only a Claude
  // Code session (this plugin, or the standalone skill) ever does.
  [
    "or the server not running).\n\nHand-editing markers with the Edit tool is a distant third",
    "or the server not running).\n\n`mdc` itself is reachable only inside a Claude Code session — this plugin, " +
      "or the standalone skill; an agent that isn't Claude Code has neither and instead follows " +
      "`docs/format.md`, asking you to run **Markdown Collab: Repair Comment Anchors** when it can't run a " +
      "check itself.\n\nHand-editing markers with the Edit tool is a distant third",
  ],
  // 10x-plan-6 P2.3: one suggestion, one change — split a paragraph rewrite,
  // or leave a comment when it can't be; the tool refuses a `with` that reads
  // like a whole paragraph rather than accepting it as one "suggestion".
  [
    "The original text stays in the file; the proposal is recorded separately. `--note` is your rationale, " +
      "shown on the suggestion card — always include it. Same anchoring rules as opening a thread: ambiguous, " +
      "or in code/frontmatter/the threads region, gets refused — pass `occurrence` or pick a different span. " +
      "One suggestion per contiguous change, re-reading between several so offsets stay valid. **Do NOT accept " +
      "or reject your own suggestions** — that's the human's call in the review UI, only on explicit " +
      "instruction. Verify with `mc_check` and `mc_list` (reports each suggestion's `original` and `proposed`).",
    "The original text stays in the file; the proposal is recorded separately. `--note` is your rationale, " +
      "shown on the suggestion card — always include it. Same anchoring rules as opening a thread: ambiguous, " +
      "or in code/frontmatter/the threads region, gets refused — pass `occurrence` or pick a different span. " +
      "**One suggestion changes one sentence or one list item.** Re-read between several so offsets stay " +
      "valid. A paragraph-level rewrite is split into several suggestions, one per sentence; when it genuinely " +
      "can't be split (the change reworks the paragraph as a whole), open a comment carrying the proposed text " +
      "instead of forcing it into one giant suggestion. A `with` far longer than the quoted passage is refused " +
      "(`suggestion_too_large`) — that's the tool telling you to split it, not a limit to work around. **Do NOT " +
      "accept or reject your own suggestions** — that's the human's call in the review UI, only on explicit " +
      "instruction. Verify with `mc_check` and `mc_list` (reports each suggestion's `original` and `proposed`).",
  ],
  // 10x-plan-6 P3: rank by severity, cap the top five, summarize the rest —
  // "no upper bound" produced too many comments even though most were sound.
  [
    "#### No upper bound on thread count\n\nThere is **no maximum number of threads** per review pass. Leave a " +
      "thread for every substantive concern that fits the focus directive (or the general rubric, if no focus " +
      'was given). If you find 30 issues, leave 30 threads. The human triages with the sidebar UI; your job is ' +
      'signal, not curation.\n\nDo not "leave the top N" — dropping findings to hit a count target risks ' +
      "suppressing the one that matters most.",
    "#### Rank, cap at five, then summarize\n\nRank concerns by severity and open threads for the **five** " +
      "that matter most. Put everything else in one summary thread anchored to the document's title (its " +
      "first `#` heading, or the very first line when it has none): `Also noticed (N): …`, one line per item " +
      'naming its passage — so the human can read it and say "open 3 and 7" for exactly the ones they want ' +
      'promoted. The `Focus:` line can override the cap explicitly ("give me ten", "everything"); absent that, ' +
      "five is it, whether the pass turns up six issues or sixty.\n\nDon't drop a finding to make the cap — " +
      "every concern still reaches the human, in its own thread if it's top five, in the summary line " +
      "otherwise. The human triages with the sidebar UI; your job is signal, ranked.",
  ],
  [
    "3. **Focus and the no-upper-bound rule apply per pass, not per file.** Verify each file with `mc_check` " +
      "before moving to the next — cheaper to catch a broken marker in file 1 before editing files 2 and 3 — " +
      "and report per file, with cross-document findings called out separately.",
    "3. **Focus applies per pass; the five-thread cap applies per file.** Each file gets its own top five and " +
      "its own summary thread for the rest — not one shared cap or one shared summary across the whole pass. " +
      "Verify each file with `mc_check` before moving to the next — cheaper to catch a broken marker in file 1 " +
      "before editing files 2 and 3 — and report per file, with cross-document findings called out separately.",
  ],
];

const legacy = renderSkill("legacy");
const plugin = renderSkill("plugin");
const headless = renderSkill("headless");

function frontmatter(text: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  return Object.fromEntries(
    m[1]!.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
  );
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

describe("legacy rendering", () => {
  it("is the pre-refactor skill, apart from the listed deliberate edits", () => {
    let expected = PRE_REFACTOR;
    for (const [before, after] of INTENTIONAL_CHANGES) {
      expect(expected.split(before), `fixture should contain exactly one: ${before.slice(0, 60)}…`).toHaveLength(2);
      expected = expected.replace(before, after);
    }
    expect(legacy).toBe(expected);
  });

  it("is what the standalone installer writes", () => {
    expect(SKILL_CONTENT).toBe(legacy);
  });

  it("invokes the CLI by its file path under ~/.claude/skills", () => {
    expect(frontmatter(legacy)?.name).toBe("vs-markdown-collab");
    expect(legacy).toContain("`node ~/.claude/skills/vs-markdown-collab/mdc.mjs <command> <file> [args]`");
  });
});

describe("plugin rendering", () => {
  it("is the same skill under the plugin's name, with the same description", () => {
    const fm = frontmatter(plugin)!;
    expect(fm.name).toBe("review");
    expect(fm.description).toBe(frontmatter(legacy)!.description);
  });

  it("calls the CLI as plain `mdc` — bin/ is on PATH — and never by a home-directory path", () => {
    expect(plugin).not.toContain("node ~/.claude");
    expect(plugin).not.toContain("~/.claude/skills");
    expect(plugin).toContain("`mdc <command> <file> [args]`");
    expect(plugin).toContain("mdc ");
    expect(plugin).toMatch(/CLI[\s\S]{0,200}same verbs/);
  });

  it("mentions the post-edit hook, which only the plugin has", () => {
    expect(plugin).toContain("This plugin also runs that check after every Edit and Write");
    expect(legacy).not.toContain("This plugin");
  });

  it("keeps the structural guards the legacy skill has", () => {
    const appendixStart = plugin.indexOf("## Appendix: hand-editing markers");
    expect(appendixStart).toBeGreaterThan(0);
    const body = plugin.slice(0, appendixStart);
    for (const phrase of ["old_string", "new_string", "base36 id", "Edit the passage to"]) {
      expect(body, phrase).not.toContain(phrase);
    }
    expect(plugin).toContain("Rank concerns by severity and open threads for the **five** that matter most.");
    expect(plugin).toContain("It is the **primary filter**");
    expect(words(plugin)).toBeLessThanOrEqual(5000);
  });
});

describe("headless rendering (tools only)", () => {
  it("has no frontmatter", () => {
    expect(frontmatter(headless)).toBeNull();
    expect(headless.startsWith("# Markdown Collab — agentic review-address skill\n")).toBe(true);
  });

  it("never mentions the CLI, the Edit tool, or the hand-editing appendix", () => {
    expect(headless).not.toContain("mdc");
    expect(headless).not.toContain("(CLI:");
    expect(headless).not.toContain("node ~/.claude");
    expect(headless).not.toContain("Edit tool");
    expect(headless.toLowerCase()).not.toContain("appendix");
    expect(headless).not.toContain("old_string");
    expect(headless).not.toContain("--note");
  });

  it("still carries every tool and the rules that matter", () => {
    for (const tool of ["mc_list", "mc_reply", "mc_rewrite", "mc_edit", "mc_open", "mc_resolve", "mc_suggest", "mc_accept", "mc_check", "mc_status"]) {
      expect(headless, tool).toContain(tool);
    }
    expect(headless).toContain("Rank concerns by severity and open threads for the **five** that matter most.");
    expect(headless).toContain('Also noticed (N): …`, one line per item naming its passage');
    expect(headless).toContain("It is the **primary filter**");
    expect(headless).toContain("Do not fabricate threads to feel productive.");
    expect(headless).toContain("Deletions become orphans by design");
    expect(headless).toMatch(/mc_check[\s\S]{0,400}Claude is\s+working/);
  });

  it("is the headless system prompt, after the preamble", () => {
    expect(headlessSystemPrompt()).toBe(`${HEADLESS_PREAMBLE}\n\n${headless}`);
  });
});

// Part D: a headless run has no Edit tool, so deleting an anchored passage has
// to go through mc_edit — and every rendering has to say so without losing
// the don't-re-anchor rule.
describe("deleting an anchored passage, in every rendering", () => {
  it("names mc_edit, and the CLI and Edit tool only where they exist", () => {
    for (const text of [legacy, plugin]) {
      expect(text).toContain(
        "Removing the anchored passage: delete the open marker, the passage, and the close marker together with `mc_edit`/`mdc edit` (or the Edit tool interactively)",
      );
    }
    expect(headless).toContain(
      "Removing the anchored passage: delete the open marker, the passage, and the close marker together with `mc_edit` — `old` spans both markers",
    );
  });

  it("keeps the don't-re-anchor rule", () => {
    for (const text of [legacy, plugin, headless]) {
      expect(text).toContain("do NOT re-anchor to nearby unrelated text");
    }
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
