import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { existsSync, readFileSync } from "fs";
import { AGENTS_SENTINEL, AGENTS_SNIPPET, FORMAT_SPEC_URL, ensureAgentsSnippet, refuseSymlink, sectionHash } from "../agents";
import { AGENTS_SKILL_CONTENT } from "../agentsSkill";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-agents-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("AGENTS_SNIPPET constant", () => {
  it("contains the sentinel heading", () => {
    expect(AGENTS_SNIPPET).toContain(AGENTS_SENTINEL);
  });
});

// Read by every agent in the repository, including a colleague's that never
// ran Connect. One rule: change a reviewed file only with `mdc`; no recipe for
// editing the markers by hand.
describe("AGENTS_SNIPPET: mdc is the only way to change a reviewed file", () => {
  it("links docs/format.md, and the link points at a file in this repository", () => {
    expect(AGENTS_SNIPPET).toContain(`[\`docs/format.md\`](${FORMAT_SPEC_URL})`);
    const rel = FORMAT_SPEC_URL.split("/blob/main/")[1]!;
    expect(existsSync(path.resolve(__dirname, "../..", rel)), `${rel} is missing`).toBe(true);
  });

  it("says where mdc is for an agent Connect set up, and for Claude Code", () => {
    expect(AGENTS_SNIPPET).toContain("`node ~/.agents/skills/markdown-collab/mdc.mjs <command> <file> …`");
    expect(AGENTS_SNIPPET).toContain("plain `mdc` in Claude Code with the Markdown Collab plugin");
  });

  it("sends an agent without mdc to the human, by Connect's exact palette title", () => {
    const connect = pkg.contributes.commands.find((c: { command: string }) => c.command === "markdownCollab.connectAgent");
    expect(connect.title.replace(/…$/, "")).toBe("Markdown Collab: Connect an Agent");
    expect(AGENTS_SNIPPET).toContain("If `mdc` isn't there, don't edit the markers — ask the human to run **Markdown Collab: Connect an Agent**");
  });

  it("carries no recipe for editing markers or thread lines by hand", () => {
    for (const phrase of ["**Reply:**", "**New thread**", "<!--mc:s {", "Repair Comment Anchors", "by hand, carefully"]) {
      expect(AGENTS_SNIPPET, phrase).not.toContain(phrase);
    }
    expect(AGENTS_SNIPPET).toContain("never edit a marker or a thread line yourself");
  });

  it("matches the skill every agent reads on the one rule", () => {
    expect(AGENTS_SKILL_CONTENT).toContain("change a reviewed file only with `mdc`");
    expect(AGENTS_SKILL_CONTENT).toContain("node ~/.agents/skills/markdown-collab/mdc.mjs");
  });

  it("stays short", () => {
    expect(AGENTS_SNIPPET.length).toBeLessThanOrEqual(1600);
  });

  // The refresh path recognizes an untouched earlier snippet by its hash. If
  // this fails you changed the snippet: add the hash below to
  // PRIOR_SNIPPET_HASHES in agents.ts (so workspaces holding it get
  // refreshed), then update the pin to the new value this prints.
  it("is pinned, so a change to it can't skip PRIOR_SNIPPET_HASHES", () => {
    expect(sectionHash(AGENTS_SNIPPET)).toBe("3bbe4c72ad42baae");
  });
});

/** The 0.35.12 snippet, verbatim — what a workspace set up before this change holds. */
const SNIPPET_0_35_12 = `## Markdown review comments

Markdown Collab stores review feedback inline in the \`.md\` file itself — anchored spans wrapped in paired \`<!--mc:a:ID-->…<!--mc:/a:ID-->\` markers, threads recorded one \`<!--mc:t {JSON}-->\` line per thread between \`<!--mc:threads:begin-->\`/\`<!--mc:threads:end-->\`. Detect a reviewed file by the literal string \`<!--mc:threads:begin-->\`.

Never hand-edit a marker or a thread line directly — one dropped \`-->\` silently orphans a reviewer's comment. Three ways to change one, in order:

1. **The \`markdown-collab\` MCP tools**, if they're in your tool list (offer "Markdown Collab: Connect an Agent…" if not): \`mc_list\` reads open threads with their live anchored text; \`mc_reply\`/\`mc_open\`/\`mc_rewrite\` act on them; \`mc_edit\` changes prose outside anchored spans; \`mc_resolve\` only when the human asks; \`mc_suggest\` in suggest mode; \`mc_check\` on every file you touch, last.
2. **The \`mdc\` CLI**, if it's on PATH: \`mdc <verb> <file> [args]\` — list / reply / open / rewrite / edit / resolve / suggest / check, same rules as the tools above.
3. **Hand-editing, only when neither exists:**
   - Reply: find the thread's \`<!--mc:t {…}-->\` line and append \`{"id":"c<next>","parent":"<last-comment-id>","author":"<you>","ts":"<ISO-8601 UTC>","body":"<what you did>"}\` to its \`comments\` array. Never change \`status\`; never edit or remove an existing comment.
   - New thread, only on explicit request ("leave a comment on X"): pick a unique id, wrap the passage in \`<!--mc:a:ID-->…<!--mc:/a:ID-->\`, append a fresh \`<!--mc:t {…}-->\` line with a single \`c1\` comment.
   - Rewriting an anchored passage keeps both markers on the new wording; removing the passage deletes both markers and leaves the thread unanchored — the correct outcome, don't re-anchor to nearby text.

`;

/** The 0.35.41 snippet, verbatim — what a workspace set up before the suggestion and heading rules holds. */
const SNIPPET_0_35_41 = `## Markdown review comments

Markdown Collab stores review feedback inline in the \`.md\` file itself — anchored spans wrapped in paired \`<!--mc:a:ID-->…<!--mc:/a:ID-->\` markers, threads recorded one \`<!--mc:t {JSON}-->\` line per thread between \`<!--mc:threads:begin-->\`/\`<!--mc:threads:end-->\` at the end of the file. Detect a reviewed file by the literal string \`<!--mc:threads:begin-->\`.

**The file format is the contract:** [\`docs/format.md\`](${FORMAT_SPEC_URL}) in the Markdown Collab repository defines every marker and field. If the \`markdown-collab\` MCP tools are in your tool list, use them instead of editing by hand — \`mc_list\`, then \`mc_reply\`/\`mc_open\`/\`mc_rewrite\`/\`mc_edit\`/\`mc_suggest\`, and \`mc_check\` last — they keep the markers intact and the human can undo them. Otherwise edit the file by hand, carefully; one dropped \`-->\` silently orphans a reviewer's comment:

- **Reply:** append \`{"id":"c<next>","parent":"<last-comment-id>","author":"<you>","agent":true,"ts":"<ISO-8601 UTC>","body":"<what you did>"}\` to the \`comments\` array on the thread's \`<!--mc:t {…}-->\` line. Never change \`status\`; never edit or remove an existing comment.
- **New thread**, only on explicit request ("leave a comment on X"): pick an unused 5-character id from \`0-9a-z\`, wrap the passage in \`<!--mc:a:ID-->…<!--mc:/a:ID-->\`, and add a line \`<!--mc:t {"id":"ID","quote":"<the passage>","status":"open","comments":[<one c1 comment>]}-->\` just before \`<!--mc:threads:end-->\` (no block yet: add both fence lines at the very end of the file, after a blank line).
- **Rewriting an anchored passage** keeps both markers on the new wording; removing the passage deletes both markers and leaves the thread unanchored — the correct outcome, don't re-anchor to nearby text.
- Never type inside a marker or put one in a code block or the frontmatter. Inside JSON strings, write \`-->\` as \`--\\u003e\` and \`<!--\` as \`\\u003c!--\`.

**Then check the file.** The \`mdc\` CLI exists only inside Claude Code sessions: if \`mdc\` is on your PATH, run \`mdc check <file>\`; otherwise ask the human to run "Markdown Collab: Repair Comment Anchors" on the file.

`;

describe("ensureAgentsSnippet", () => {
  it("returns 'created' and writes the snippet when AGENTS.md is absent", async () => {
    const result = await ensureAgentsSnippet(tmpDir);
    expect(result).toBe("created");
    const written = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8");
    expect(written).toBe(AGENTS_SNIPPET);
    expect(written.endsWith("\n")).toBe(true);
  });

  it("returns 'appended' when AGENTS.md exists without the sentinel", async () => {
    const original = "# Project Agents\n\nSome prior content.\n";
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, original, "utf8");
    const result = await ensureAgentsSnippet(tmpDir);
    expect(result).toBe("appended");
    const written = await fs.readFile(target, "utf8");
    expect(written).toBe(original + "\n\n" + AGENTS_SNIPPET);
  });

  it("returns 'customized' and leaves content unchanged when the section was written by hand", async () => {
    const existing =
      "# Project Agents\n\n" +
      AGENTS_SENTINEL +
      "\n\nCustom notes about the review process live here.\n";
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, existing, "utf8");
    const result = await ensureAgentsSnippet(tmpDir);
    expect(result).toBe("customized");
    const after = await fs.readFile(target, "utf8");
    expect(after).toBe(existing);
  });

  it("returns 'customized' for the sentinel mentioned without its heading line, rather than appending a second", async () => {
    const existing = "# Agents\n\n### Markdown review comments\n\nOurs, one level down.\n";
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, existing, "utf8");
    expect(await ensureAgentsSnippet(tmpDir)).toBe("customized");
    expect(await fs.readFile(target, "utf8")).toBe(existing);
  });

  it("is idempotent: second call returns 'already-present' with no duplication", async () => {
    const first = await ensureAgentsSnippet(tmpDir);
    expect(first).toBe("created");
    const second = await ensureAgentsSnippet(tmpDir);
    expect(second).toBe("already-present");
    const written = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8");
    // Only one occurrence of the sentinel.
    const occurrences = written.split(AGENTS_SENTINEL).length - 1;
    expect(occurrences).toBe(1);
    expect(written).toBe(AGENTS_SNIPPET);
  });

  it("preserves prior unrelated sections when appending", async () => {
    const original =
      "# Project Agents\n\n## Existing Section\n\nImportant prior text that must survive.\n";
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, original, "utf8");
    await ensureAgentsSnippet(tmpDir);
    const after = await fs.readFile(target, "utf8");
    expect(after.startsWith(original)).toBe(true);
    expect(after).toContain("Existing Section");
    expect(after).toContain("Important prior text that must survive.");
    expect(after).toContain(AGENTS_SENTINEL);
  });

  // Connect an Agent writes AGENTS.md first for every agent
  // that isn't Claude Code, so a workspace set up under the old snippet — the
  // one that sent every agent looking for `mdc` — has to get the new one.
  it("refreshes an untouched earlier snippet in place", async () => {
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, SNIPPET_0_35_12, "utf8");
    expect(await ensureAgentsSnippet(tmpDir)).toBe("refreshed");
    expect(await fs.readFile(target, "utf8")).toBe(AGENTS_SNIPPET);
    expect(await ensureAgentsSnippet(tmpDir)).toBe("already-present");
  });

  it("refreshes the 0.35.41 snippet, the one without the suggestion and heading rules", async () => {
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, SNIPPET_0_35_41, "utf8");
    expect(await ensureAgentsSnippet(tmpDir)).toBe("refreshed");
    expect(await fs.readFile(target, "utf8")).toBe(AGENTS_SNIPPET);
  });

  it("refreshes only our section, keeping what comes before and after it", async () => {
    const before = "# Project Agents\n\n## Build\n\nRun npm test.\n\n";
    const after = "## Style\n\nTwo-space indent.\n";
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, before + SNIPPET_0_35_12 + after, "utf8");
    expect(await ensureAgentsSnippet(tmpDir)).toBe("refreshed");
    expect(await fs.readFile(target, "utf8")).toBe(before + AGENTS_SNIPPET + after);
  });

  it("recognizes an earlier snippet saved with CRLF line endings", async () => {
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, SNIPPET_0_35_12.replace(/\n/g, "\r\n"), "utf8");
    expect(await ensureAgentsSnippet(tmpDir)).toBe("refreshed");
    expect(await fs.readFile(target, "utf8")).toBe(AGENTS_SNIPPET);
  });

  it("leaves an earlier snippet alone once someone has edited it", async () => {
    const edited = SNIPPET_0_35_12.replace("Three ways", "Our three ways");
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, edited, "utf8");
    expect(await ensureAgentsSnippet(tmpDir)).toBe("customized");
    expect(await fs.readFile(target, "utf8")).toBe(edited);
  });

  // L5: a symlinked AGENTS.md, or a symlinked workspace folder, could
  // otherwise send this write somewhere the human never agreed to.
  describe("refuses to write through a symlink (L5)", () => {
    it("refuses when AGENTS.md itself is a symlink", async () => {
      const real = path.join(tmpDir, "real-agents.md");
      await fs.writeFile(real, "# elsewhere\n", "utf8");
      await fs.symlink(real, path.join(tmpDir, "AGENTS.md"));
      await expect(ensureAgentsSnippet(tmpDir)).rejects.toThrow(/symlink/);
      // Nothing was written through the link.
      expect(await fs.readFile(real, "utf8")).toBe("# elsewhere\n");
    });

    it("refuses when the workspace folder itself is a symlink", async () => {
      const real = path.join(tmpDir, "real-workspace");
      await fs.mkdir(real);
      const linked = path.join(tmpDir, "linked-workspace");
      await fs.symlink(real, linked);
      await expect(ensureAgentsSnippet(linked)).rejects.toThrow(/symlink/);
      await expect(fs.access(path.join(real, "AGENTS.md"))).rejects.toThrow();
    });

    it("still works normally when neither is a symlink", async () => {
      expect(await ensureAgentsSnippet(tmpDir)).toBe("created");
    });
  });
});

describe("refuseSymlink", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-refuse-symlink-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns null for a path that doesn't exist yet, and its parent isn't a symlink", async () => {
    expect(await refuseSymlink(path.join(tmp, "not-there.md"))).toBeNull();
  });

  it("returns a reason when the target itself is a symlink", async () => {
    const real = path.join(tmp, "real.md");
    await fs.writeFile(real, "hi", "utf8");
    const link = path.join(tmp, "link.md");
    await fs.symlink(real, link);
    expect(await refuseSymlink(link)).toMatch(/symlink/);
  });

  it("returns a reason when the parent directory is a symlink", async () => {
    const realDir = path.join(tmp, "real-dir");
    await fs.mkdir(realDir);
    const linkedDir = path.join(tmp, "linked-dir");
    await fs.symlink(realDir, linkedDir);
    expect(await refuseSymlink(path.join(linkedDir, "file.md"))).toMatch(/symlink/);
  });
});
