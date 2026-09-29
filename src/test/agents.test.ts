import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { existsSync, readFileSync } from "fs";
import { AGENTS_SENTINEL, AGENTS_SNIPPET, FORMAT_SPEC_URL, ensureAgentsSnippet, refuseSymlink, sectionHash } from "../agents";

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

// 10x-plan-6 P1.3: the format is the API for every agent that isn't Claude
// Code. The snippet leads with the contract, doesn't pretend `mdc` is on every
// agent's PATH, and gives the human's Repair command as the check for everyone
// else.
describe("AGENTS_SNIPPET: the format is the contract", () => {
  it("links docs/format.md, and the link points at a file in this repository", () => {
    expect(AGENTS_SNIPPET).toContain(`[\`docs/format.md\`](${FORMAT_SPEC_URL})`);
    const rel = FORMAT_SPEC_URL.split("/blob/main/")[1]!;
    expect(existsSync(path.resolve(__dirname, "../..", rel)), `${rel} is missing`).toBe(true);
  });

  it("says mdc exists only inside Claude Code sessions", () => {
    expect(AGENTS_SNIPPET).toMatch(/`mdc` CLI exists only inside Claude Code sessions/);
  });

  it("falls back to the Repair command by its exact palette title", () => {
    const repair = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "markdownCollab.repairInlineComments",
    );
    expect(AGENTS_SNIPPET).toContain(`"${repair.title}"`);
  });

  it("no longer ranks hand-editing as the last resort after mdc", () => {
    expect(AGENTS_SNIPPET).not.toMatch(/only when neither exists/i);
    expect(AGENTS_SNIPPET).not.toContain("list / reply / open / rewrite / edit / resolve / suggest / check");
  });

  it("points at the MCP tools before the hand-editing steps, for an agent that has them", () => {
    const toolsAt = AGENTS_SNIPPET.indexOf("MCP tools");
    const replyAt = AGENTS_SNIPPET.indexOf("**Reply:**");
    expect(toolsAt).toBeGreaterThan(-1);
    expect(toolsAt).toBeLessThan(replyAt);
  });

  it("a hand-written reply is marked as an agent's", () => {
    expect(AGENTS_SNIPPET).toContain('"agent":true');
  });

  it("stays under ~35 lines", () => {
    expect(AGENTS_SNIPPET.split("\n").length).toBeLessThanOrEqual(35);
  });

  // The refresh path recognizes an untouched earlier snippet by its hash. If
  // this fails you changed the snippet: add the hash below to
  // PRIOR_SNIPPET_HASHES in agents.ts (so workspaces holding it get
  // refreshed), then update the pin to the new value this prints.
  it("is pinned, so a change to it can't skip PRIOR_SNIPPET_HASHES", () => {
    expect(sectionHash(AGENTS_SNIPPET)).toBe("bdb3734674cf348c");
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

  // 10x-plan-6 P1.1: Connect an Agent writes AGENTS.md first for every agent
  // that isn't Claude Code, so a workspace set up under the old snippet — the
  // one that sent every agent looking for `mdc` — has to get the new one.
  it("refreshes an untouched earlier snippet in place", async () => {
    const target = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(target, SNIPPET_0_35_12, "utf8");
    expect(await ensureAgentsSnippet(tmpDir)).toBe("refreshed");
    expect(await fs.readFile(target, "utf8")).toBe(AGENTS_SNIPPET);
    expect(await ensureAgentsSnippet(tmpDir)).toBe("already-present");
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
