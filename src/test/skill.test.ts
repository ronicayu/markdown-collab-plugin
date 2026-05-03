import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  CLI_SCRIPT_CONTENT,
  CLI_SCRIPT_REL,
  SKILL_CONTENT,
  SKILL_REL_PATH,
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
  it("instructs the agent to maintain anchors after ANY .md edit, not just comment-driven ones", () => {
    // Regression guard for the user-requested instruction added so the
    // skill explicitly tells Claude: when you edit any .md file in a
    // workspace that has a .markdown-collab/ sidecar dir, after the
    // edit reconcile the sidecar's anchors to match the new content.
    expect(SKILL_CONTENT).toContain("Anchor maintenance applies on EVERY");
    expect(SKILL_CONTENT).toContain("for any reason, not only when addressing review comments");
    expect(SKILL_CONTENT).toContain("mdc.mjs validate <sidecar>");
    expect(SKILL_CONTENT).toContain("mdc.mjs set-anchor");
  });

  it("preserves the orphan-on-deletion rule alongside the new instruction", () => {
    // The new section must NOT override the existing rule that a
    // deleted passage's comment is left to orphan, never re-anchored
    // to nearby unrelated text.
    expect(SKILL_CONTENT).toContain("leave the anchor untouched");
    expect(SKILL_CONTENT).toContain("misleading link to content the comment was never about");
  });

  it("instructs surgical Edit-tool anchor updates rather than full sidecar rewrite", () => {
    // Regression guard: the user explicitly asked that anchor updates
    // be surgical via the Edit tool, NOT full-file rewrites via
    // `mdc.mjs set-anchor`. The CLI path remains documented as a
    // last-resort fallback only — concurrent writers (webview,
    // standard editor's CommentController) hold the sidecar open and
    // a full rewrite races with them.
    expect(SKILL_CONTENT).toContain("update the anchor SURGICALLY with the **Edit** tool");
    expect(SKILL_CONTENT).toContain("Do NOT use `mdc.mjs set-anchor` and do NOT rewrite the whole sidecar JSON");
    expect(SKILL_CONTENT).toContain("Preserve indentation, quoting, trailing commas");
    // CLI path must still be MENTIONED (as a fallback) so the legacy
    // assertion above keeps passing, but the wording must frame it as
    // a fallback, not the primary path.
    expect(SKILL_CONTENT).toContain("churn-prone fallback");
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
    // Parent dir tree created.
    const parentStat = await fs.stat(path.dirname(expectedPath));
    expect(parentStat.isDirectory()).toBe(true);
  });

  it("returns 'already-present' and does not modify the file when target is byte-identical", async () => {
    const target = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, SKILL_CONTENT, "utf8");
    const before = await fs.stat(target);
    // Wait long enough that a rewrite would bump mtime.
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

  it("writes mdc.mjs alongside SKILL.md on a fresh install", async () => {
    await installClaudeSkill(tmpHome);
    const cliPath = path.join(tmpHome, CLI_SCRIPT_REL);
    const contents = await fs.readFile(cliPath, "utf8");
    expect(contents).toBe(CLI_SCRIPT_CONTENT);
    expect(contents.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("syncs mdc.mjs even when SKILL.md is left untouched (already-present)", async () => {
    const skillTarget = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(skillTarget), { recursive: true });
    await fs.writeFile(skillTarget, SKILL_CONTENT, "utf8");
    // Pre-write a stale CLI script. Install should overwrite it without
    // touching the byte-identical SKILL.md.
    const cliTarget = path.join(tmpHome, CLI_SCRIPT_REL);
    await fs.writeFile(cliTarget, "#!/usr/bin/env node\n// stale\n", "utf8");
    const result = await installClaudeSkill(tmpHome);
    expect(result.action).toBe("already-present");
    const cli = await fs.readFile(cliTarget, "utf8");
    expect(cli).toBe(CLI_SCRIPT_CONTENT);
  });

  it("syncs mdc.mjs even when SKILL.md exists-differs (no force)", async () => {
    const skillTarget = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(skillTarget), { recursive: true });
    await fs.writeFile(skillTarget, "# custom skill\n", "utf8");
    const result = await installClaudeSkill(tmpHome);
    expect(result.action).toBe("exists-differs");
    const cli = await fs.readFile(path.join(tmpHome, CLI_SCRIPT_REL), "utf8");
    expect(cli).toBe(CLI_SCRIPT_CONTENT);
  });

});
