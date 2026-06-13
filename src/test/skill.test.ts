import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  CHANNEL_SCRIPT_CONTENT,
  CHANNEL_SCRIPT_REL,
  SKILL_CONTENT,
  SKILL_REL_PATH,
  TAIL_SCRIPT_CONTENT,
  TAIL_SCRIPT_REL,
  installClaudeSkill,
} from "../skill";

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
    // The legacy sidecar workflow / CLI / reference doc are fully removed.
    expect(SKILL_CONTENT).not.toContain("Sidecar-mode workflow");
    expect(SKILL_CONTENT).not.toContain("SIDECAR.md");
    expect(SKILL_CONTENT).not.toContain("mdc.mjs");
  });

  it("preserves the orphan-on-deletion rule", () => {
    // A deleted passage's thread orphans; never re-anchor to nearby text.
    expect(SKILL_CONTENT).toContain("Deletions become orphans by design.");
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

  it("writes the tail + channel helper scripts on a fresh install", async () => {
    await installClaudeSkill(tmpHome);
    const tail = await fs.readFile(path.join(tmpHome, TAIL_SCRIPT_REL), "utf8");
    expect(tail).toBe(TAIL_SCRIPT_CONTENT);
    expect(tail.startsWith("#!/usr/bin/env node")).toBe(true);
    const channel = await fs.readFile(path.join(tmpHome, CHANNEL_SCRIPT_REL), "utf8");
    expect(channel).toBe(CHANNEL_SCRIPT_CONTENT);
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
