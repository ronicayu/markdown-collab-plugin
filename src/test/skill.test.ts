import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  CLI_SCRIPT_CONTENT,
  CLI_SCRIPT_REL,
  SKILL_CONTENT,
  SKILL_REL_PATH,
  checkClaudeSkill,
  installClaudeSkill,
  skillFingerprint,
} from "../skill";
import { createHash } from "crypto";

// Stale helpers from the channel transports deleted in 10x-plan-4 P0.3.
// installClaudeSkill must clean these up if they're left over from an older
// install of this extension — see the "deletes stale channel helpers" tests.
const STALE_TAIL_REL = ".claude/skills/vs-markdown-collab/mdc-tail.mjs";
const STALE_CHANNEL_REL = ".claude/skills/vs-markdown-collab/mdc-channel.mjs";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-skill-test-"));
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("SKILL_CONTENT instructions", () => {
  it("documents the inline format only — no sidecar references remain", () => {
    expect(SKILL_CONTENT).toContain("Comments are stored INLINE");
    expect(SKILL_CONTENT).toContain("<!--mc:threads:begin-->");
    // The legacy sidecar workflow / reference doc are fully removed. (The
    // `mdc.mjs` helper is unrelated to the old sidecar CLI of the same name —
    // it is the marker-safe mutation CLI added in 0.34.42, and the skill is
    // expected to reference it.)
    expect(SKILL_CONTENT).not.toContain("Sidecar-mode workflow");
    expect(SKILL_CONTENT).not.toContain("SIDECAR.md");
  });

  it("preserves the orphan-on-deletion rule", () => {
    // A deleted passage's thread orphans; never re-anchor to nearby text.
    expect(SKILL_CONTENT).toContain("Deletions become orphans by design");
  });

  // 10x-plan-4 P0.3: the channel transports (event log + MCP channel) were
  // deleted outright, not just hidden. Nothing in the shipped skill should
  // still send Claude looking for them.
  it("carries no channel-transport references", () => {
    for (const phrase of [
      "mdc-tail",
      "mdc-channel",
      "events.jsonl",
      "events.acked",
      ".channel.json",
      "Monitor",
      "BashOutput",
      "TaskOutput",
      "MCP channel",
      "Channel watch loop",
      "dangerously-load-development-channels",
    ]) {
      expect(SKILL_CONTENT, `SKILL_CONTENT should not mention "${phrase}"`).not.toContain(phrase);
    }
  });

  // Target set by 10x-plan-4 P0.3 (6,477 words before the shrink, 4,570
  // after). Every sentence is one an agent can misread, so the ceiling is a
  // real constraint, not a vanity number — keep cutting rather than raising
  // it. Counted in words, not lines: un-wrapping a paragraph shrinks the line
  // count without removing a single thing Claude has to read.
  it("fits within the word-count ceiling", () => {
    const words = SKILL_CONTENT.split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(5000);
  });
});

// 10x-plan-2 P0.3. The tools enforce what the prose used to warn about, so the
// happy path should read as orchestration — and the marker-surgery lore has to
// stay quarantined in the appendix, or Claude will reach for it while holding a
// tool that does the same thing safely.
describe("SKILL_CONTENT — tools-first structure", () => {
  const appendixStart = SKILL_CONTENT.indexOf("## Appendix: hand-editing markers");
  const body = SKILL_CONTENT.slice(0, appendixStart);
  const appendix = SKILL_CONTENT.slice(appendixStart);

  it("has a fallback appendix, at the end", () => {
    expect(appendixStart).toBeGreaterThan(0);
    expect(appendix).toContain("last resort");
    // The body is the thing Claude reads first; the appendix must not dominate.
    expect(appendix.length).toBeLessThan(body.length / 2);
  });

  it("names every tool the server exposes", () => {
    for (const tool of [
      "mc_list",
      "mc_reply",
      "mc_open",
      "mc_rewrite",
      "mc_resolve",
      "mc_suggest",
      "mc_check",
      "mc_status",
    ]) {
      expect(body, `body should mention ${tool}`).toContain(tool);
    }
  });

  it("keeps marker surgery out of the happy path", () => {
    // These are the instructions that told Claude to build an Edit around raw
    // markers. Anywhere but the appendix, they compete with a tool call that
    // does the same thing and can't drop a marker. (Describing the storage
    // format is fine and stays — knowing what the file looks like is not the
    // same as being told to hand-edit it.)
    for (const phrase of ["old_string", "new_string", "base36 id", "Edit the passage to"]) {
      expect(body, `body should not carry ${phrase}`).not.toContain(phrase);
      expect(appendix, `appendix should carry ${phrase}`).toContain(phrase);
    }
  });

  it("tells Claude that the closing check is what ends the human's wait", () => {
    expect(body).toMatch(/mc_check[\s\S]{0,400}Claude is\s+working/);
  });

  it("keeps the never-cap rule verbatim", () => {
    // Ronica's standing constraint on Review Mode: never ration findings.
    expect(SKILL_CONTENT).toContain("There is **no maximum number of threads**");
    expect(SKILL_CONTENT).toContain("If you find 30 issues, leave 30 threads.");
    expect(SKILL_CONTENT).toContain('Do not "leave the top N"');
  });

  it("keeps the focus directive as the primary filter", () => {
    expect(SKILL_CONTENT).toContain("It is the **primary filter**");
    expect(SKILL_CONTENT).toContain("Do not fabricate threads to feel productive.");
  });

  it("still documents the CLI as a first-class path, not a deprecation", () => {
    expect(body).toContain("mdc.mjs");
    expect(body).toMatch(/CLI[\s\S]{0,200}same verbs/i);
  });
});

describe("SKILL_REL_PATH", () => {
  it("points to the vs-markdown-collab skill under .claude/skills", () => {
    expect(SKILL_REL_PATH).toBe(".claude/skills/vs-markdown-collab/SKILL.md");
  });
});

describe("installClaudeSkill", () => {
  it("installs the skill when target is absent, creating parent dirs recursively", async () => {
    const result = await installClaudeSkill(tmpHome);
    const expectedPath = path.join(tmpHome, SKILL_REL_PATH);
    expect(result).toEqual({ action: "installed", path: expectedPath });
    const written = await fs.readFile(expectedPath, "utf8");
    expect(written).toBe(SKILL_CONTENT);
    const parentStat = await fs.stat(path.dirname(expectedPath));
    expect(parentStat.isDirectory()).toBe(true);
  });

  it("returns 'already-present' and does not modify the file when target is byte-identical", async () => {
    const target = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, SKILL_CONTENT, "utf8");
    const before = await fs.stat(target);
    await new Promise((r) => setTimeout(r, 20));
    const result = await installClaudeSkill(tmpHome);
    expect(result).toEqual({ action: "already-present", path: target });
    const after = await fs.stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const contents = await fs.readFile(target, "utf8");
    expect(contents).toBe(SKILL_CONTENT);
  });

  it("returns 'exists-differs' without overwriting when content differs and force is not set", async () => {
    const target = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const userContent = "# custom local skill\n\ndo not overwrite me\n";
    await fs.writeFile(target, userContent, "utf8");
    const result = await installClaudeSkill(tmpHome);
    expect(result).toEqual({ action: "exists-differs", path: target });
    const contents = await fs.readFile(target, "utf8");
    expect(contents).toBe(userContent);
  });

  it("overwrites differing content when force: true is passed", async () => {
    const target = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const userContent = "# custom local skill\n\ndo not overwrite me\n";
    await fs.writeFile(target, userContent, "utf8");
    const result = await installClaudeSkill(tmpHome, { force: true });
    expect(result).toEqual({ action: "installed", path: target });
    const contents = await fs.readFile(target, "utf8");
    expect(contents).toBe(SKILL_CONTENT);
  });

  it("writes the mdc helper script on a fresh install", async () => {
    await installClaudeSkill(tmpHome);
    const cli = await fs.readFile(path.join(tmpHome, CLI_SCRIPT_REL), "utf8");
    expect(cli).toBe(CLI_SCRIPT_CONTENT);
    expect(cli.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("re-syncs a stale mdc.mjs even when SKILL.md is untouched", async () => {
    const skillTarget = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(skillTarget), { recursive: true });
    await fs.writeFile(skillTarget, SKILL_CONTENT, "utf8");
    const cliTarget = path.join(tmpHome, CLI_SCRIPT_REL);
    await fs.writeFile(cliTarget, "#!/usr/bin/env node\n// stale\n", "utf8");
    const result = await installClaudeSkill(tmpHome);
    expect(result.action).toBe("already-present");
    expect(await fs.readFile(cliTarget, "utf8")).toBe(CLI_SCRIPT_CONTENT);
  });

  // 10x-plan-4 P0.3: the tail/channel scripts are gone, but a machine that ran
  // an older version of this extension may still have them on disk. They're
  // ours, so we clean up rather than leaving dead scripts behind.
  describe("deletes stale channel helpers", () => {
    it("removes mdc-tail.mjs and mdc-channel.mjs left over from an older install", async () => {
      const tailTarget = path.join(tmpHome, STALE_TAIL_REL);
      const channelTarget = path.join(tmpHome, STALE_CHANNEL_REL);
      await fs.mkdir(path.dirname(tailTarget), { recursive: true });
      await fs.writeFile(tailTarget, "#!/usr/bin/env node\n// old tailer\n", "utf8");
      await fs.writeFile(channelTarget, "#!/usr/bin/env node\n// old channel server\n", "utf8");

      await installClaudeSkill(tmpHome);

      await expect(fs.readFile(tailTarget, "utf8")).rejects.toThrow();
      await expect(fs.readFile(channelTarget, "utf8")).rejects.toThrow();
    });

    it("is a no-op when the stale helpers were never installed", async () => {
      // Must not throw just because there's nothing to delete.
      await expect(installClaudeSkill(tmpHome)).resolves.toMatchObject({ action: "installed" });
    });
  });
});

describe("checkClaudeSkill", () => {
  it("reports 'missing' when nothing is installed", async () => {
    expect(await checkClaudeSkill(tmpHome)).toBe("missing");
  });

  it("reports 'current' right after a fresh install", async () => {
    await installClaudeSkill(tmpHome);
    expect(await checkClaudeSkill(tmpHome)).toBe("current");
  });

  it("reports 'outdated' when the installed SKILL.md differs", async () => {
    await installClaudeSkill(tmpHome);
    await fs.writeFile(path.join(tmpHome, SKILL_REL_PATH), SKILL_CONTENT + "\nstale\n", "utf8");
    expect(await checkClaudeSkill(tmpHome)).toBe("outdated");
  });

  it("reports 'outdated' when the bundled helper script differs", async () => {
    await installClaudeSkill(tmpHome);
    await fs.writeFile(path.join(tmpHome, CLI_SCRIPT_REL), "#!/usr/bin/env node\n// stale\n", "utf8");
    expect(await checkClaudeSkill(tmpHome)).toBe("outdated");
  });

  it("reports 'outdated' when the helper script is missing entirely", async () => {
    const skillTarget = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(skillTarget), { recursive: true });
    await fs.writeFile(skillTarget, SKILL_CONTENT, "utf8");
    // SKILL.md matches but mdc.mjs was never written.
    expect(await checkClaudeSkill(tmpHome)).toBe("outdated");
  });
});

// The activation-time update nag (P3.4) fires when the installed fingerprint
// differs from the bundled one, so the fingerprint has to cover every artifact
// `installClaudeSkill` writes. If a future helper script is added to the
// install but not to the fingerprint, Claude silently keeps running against a
// stale helper and nothing ever prompts.
describe("skillFingerprint", () => {
  it("is a short, stable hex digest", () => {
    const fp = skillFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(skillFingerprint()).toBe(fp);
  });

  it("hashes the skill and the mdc helper script", () => {
    const expected = createHash("sha1")
      .update(SKILL_CONTENT)
      .update(CLI_SCRIPT_CONTENT)
      .digest("hex")
      .slice(0, 12);
    expect(skillFingerprint()).toBe(expected);
  });

  it("covers every file a fresh install writes", async () => {
    await installClaudeSkill(tmpHome);
    const skillDir = path.dirname(path.join(tmpHome, SKILL_REL_PATH));
    const installed = await fs.readdir(skillDir, { recursive: true, withFileTypes: true });
    const files = installed.filter((e) => e.isFile()).map((e) => e.name).sort();
    // SKILL.md + mdc.mjs only — the tail/channel helpers were deleted in
    // 10x-plan-4 P0.3. A new entry here means skillFingerprint (and
    // checkClaudeSkill) need it too.
    expect(files).toEqual([path.basename(CLI_SCRIPT_REL), path.basename(SKILL_REL_PATH)].sort());
  });
});
