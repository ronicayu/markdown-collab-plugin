import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  CHANNEL_SCRIPT_CONTENT,
  CHANNEL_SCRIPT_REL,
  CLI_SCRIPT_CONTENT,
  CLI_SCRIPT_REL,
  SKILL_CONTENT,
  SKILL_REL_PATH,
  TAIL_SCRIPT_CONTENT,
  TAIL_SCRIPT_REL,
  checkClaudeSkill,
  installClaudeSkill,
  skillFingerprint,
} from "../skill";
import { createHash } from "crypto";

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
    expect(SKILL_CONTENT).toContain("Deletions become orphans by design.");
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

  it("writes the tail + channel + mdc helper scripts on a fresh install", async () => {
    await installClaudeSkill(tmpHome);
    const tail = await fs.readFile(path.join(tmpHome, TAIL_SCRIPT_REL), "utf8");
    expect(tail).toBe(TAIL_SCRIPT_CONTENT);
    expect(tail.startsWith("#!/usr/bin/env node")).toBe(true);
    const channel = await fs.readFile(path.join(tmpHome, CHANNEL_SCRIPT_REL), "utf8");
    expect(channel).toBe(CHANNEL_SCRIPT_CONTENT);
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

  it("syncs helper scripts even when SKILL.md is left untouched (already-present)", async () => {
    const skillTarget = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(skillTarget), { recursive: true });
    await fs.writeFile(skillTarget, SKILL_CONTENT, "utf8");
    const tailTarget = path.join(tmpHome, TAIL_SCRIPT_REL);
    await fs.writeFile(tailTarget, "#!/usr/bin/env node\n// stale\n", "utf8");
    const result = await installClaudeSkill(tmpHome);
    expect(result.action).toBe("already-present");
    const tail = await fs.readFile(tailTarget, "utf8");
    expect(tail).toBe(TAIL_SCRIPT_CONTENT);
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

  it("reports 'outdated' when a bundled helper script differs", async () => {
    await installClaudeSkill(tmpHome);
    await fs.writeFile(path.join(tmpHome, CHANNEL_SCRIPT_REL), "#!/usr/bin/env node\n// stale\n", "utf8");
    expect(await checkClaudeSkill(tmpHome)).toBe("outdated");
  });

  it("reports 'outdated' when a helper script is missing entirely", async () => {
    const skillTarget = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(skillTarget), { recursive: true });
    await fs.writeFile(skillTarget, SKILL_CONTENT, "utf8");
    // SKILL.md matches but the tail/channel scripts were never written.
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

  it("hashes the skill and all three helper scripts", () => {
    const expected = createHash("sha1")
      .update(SKILL_CONTENT)
      .update(TAIL_SCRIPT_CONTENT)
      .update(CHANNEL_SCRIPT_CONTENT)
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
    // SKILL.md + mdc.mjs + mdc-tail.mjs + mdc-channel.mjs. A new entry here
    // means skillFingerprint (and checkClaudeSkill) need it too.
    expect(files).toEqual([
      path.basename(CHANNEL_SCRIPT_REL),
      path.basename(CLI_SCRIPT_REL),
      path.basename(SKILL_REL_PATH),
      path.basename(TAIL_SCRIPT_REL),
    ].sort());
  });
});
