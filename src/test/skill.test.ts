import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  CLI_SCRIPT_CONTENT,
  CLI_SCRIPT_REL,
  SIDECAR_CONTENT,
  SIDECAR_REF_REL,
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
  it("keeps inline mode as the default and points to SIDECAR.md for the legacy path on demand", () => {
    // After the v0.27+ split: SKILL.md is inline-by-default and the
    // sidecar workflow lives in a separate SIDECAR.md reference loaded
    // on demand. The skill body must clearly point at the reference
    // rather than inlining the legacy details (so the model only pays
    // for legacy tokens when sidecar mode actually applies).
    expect(SKILL_CONTENT).toContain("Sidecar-mode workflow (legacy path) — load on demand");
    expect(SKILL_CONTENT).toContain("~/.claude/skills/vs-markdown-collab/SIDECAR.md");
    expect(SKILL_CONTENT).toContain("Inline mode (default)");
    // Sidecar-specific CLI / workflow details MUST NOT be inlined in
    // SKILL.md anymore.
    expect(SKILL_CONTENT).not.toContain("mdc.mjs set-anchor");
    expect(SKILL_CONTENT).not.toContain("churn-prone fallback");
  });

  it("preserves the orphan-on-deletion rule for inline mode", () => {
    // For the inline mode (which is now what SKILL.md primarily covers),
    // the rule still stands: a deleted passage's thread orphans; never
    // re-anchor to nearby unrelated text.
    expect(SKILL_CONTENT).toContain("Re-anchor an orphaned thread to nearby unrelated text. Let it orphan.");
  });
});

describe("SIDECAR_CONTENT instructions", () => {
  it("retains the sidecar anchor-maintenance instructions in the reference file", () => {
    // Same regression guard as before the split, but now against
    // SIDECAR.md since that's where the sidecar workflow lives.
    expect(SIDECAR_CONTENT).toContain("Anchor maintenance applies on EVERY");
    expect(SIDECAR_CONTENT).toContain("for any reason, not only when addressing review comments");
    expect(SIDECAR_CONTENT).toContain("mdc.mjs validate <sidecar>");
    expect(SIDECAR_CONTENT).toContain("mdc.mjs set-anchor");
  });

  it("retains the orphan-on-deletion rule for sidecar mode", () => {
    expect(SIDECAR_CONTENT).toContain("leave the anchor untouched");
    expect(SIDECAR_CONTENT).toContain("misleading link to content the comment was never about");
  });

  it("retains the surgical Edit-tool anchor-update instructions", () => {
    // Concurrent writers (webview, standard editor's CommentController)
    // hold the sidecar open and a full rewrite races with them. The
    // skill must keep telling Claude to do surgical Edits and frame the
    // CLI set-anchor path as a churn-prone fallback only.
    expect(SIDECAR_CONTENT).toContain("update the anchor SURGICALLY with the **Edit** tool");
    expect(SIDECAR_CONTENT).toContain("Do NOT use `mdc.mjs set-anchor` and do NOT rewrite the whole sidecar JSON");
    expect(SIDECAR_CONTENT).toContain("Preserve indentation, quoting, trailing commas");
    expect(SIDECAR_CONTENT).toContain("churn-prone fallback");
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

  it("writes SIDECAR.md (the on-demand legacy reference) alongside SKILL.md on a fresh install", async () => {
    await installClaudeSkill(tmpHome);
    const sidecarRef = path.join(tmpHome, SIDECAR_REF_REL);
    const contents = await fs.readFile(sidecarRef, "utf8");
    expect(contents).toBe(SIDECAR_CONTENT);
  });

  it("syncs SIDECAR.md even when SKILL.md is left untouched", async () => {
    const skillTarget = path.join(tmpHome, SKILL_REL_PATH);
    await fs.mkdir(path.dirname(skillTarget), { recursive: true });
    await fs.writeFile(skillTarget, SKILL_CONTENT, "utf8");
    const refTarget = path.join(tmpHome, SIDECAR_REF_REL);
    await fs.writeFile(refTarget, "stale legacy reference\n", "utf8");
    const result = await installClaudeSkill(tmpHome);
    expect(result.action).toBe("already-present");
    const ref = await fs.readFile(refTarget, "utf8");
    expect(ref).toBe(SIDECAR_CONTENT);
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
