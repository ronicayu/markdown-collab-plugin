import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS_SKILL_CONTENT, AGENTS_SKILL_REL_PATH, installAgentsSkill, refreshAgentsSkill } from "../agentsSkill";

let home: string;
let elsewhere: string;
let skillPath: string;

const OLDER_OURS = "---\nname: markdown-collab\ndescription: an earlier version\n---\n\n# Older text\n";
const FOREIGN = "---\nname: my-own-review-skill\ndescription: mine\n---\n\n# Mine\n";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function put(content: string): Promise<void> {
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, content, "utf8");
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-agents-skill-home-"));
  elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-agents-skill-else-"));
  skillPath = path.join(home, AGENTS_SKILL_REL_PATH);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(elsewhere, { recursive: true, force: true });
});

describe("the skill's location", () => {
  it("is ~/.agents/skills/markdown-collab/SKILL.md, where Codex, Cursor, Copilot and Windsurf read user skills", () => {
    expect(path.relative(home, skillPath).split(path.sep)).toEqual([".agents", "skills", "markdown-collab", "SKILL.md"]);
  });
});

describe("installAgentsSkill", () => {
  it("writes the skill into a home that has no .agents directory", async () => {
    const result = await installAgentsSkill(home);

    expect(result).toEqual({ action: "installed", path: skillPath });
    expect(await fs.readFile(skillPath, "utf8")).toBe(AGENTS_SKILL_CONTENT);
  });

  it("reports an identical file as already present, and leaves it alone", async () => {
    await put(AGENTS_SKILL_CONTENT);
    const before = (await fs.stat(skillPath)).mtimeMs;

    expect((await installAgentsSkill(home)).action).toBe("already-present");
    expect((await fs.stat(skillPath)).mtimeMs).toBe(before);
  });

  it("overwrites an earlier version of ours", async () => {
    await put(OLDER_OURS);

    expect((await installAgentsSkill(home)).action).toBe("updated");
    expect(await fs.readFile(skillPath, "utf8")).toBe(AGENTS_SKILL_CONTENT);
  });

  it("leaves a skill someone else wrote at that path untouched", async () => {
    await put(FOREIGN);

    expect((await installAgentsSkill(home)).action).toBe("exists-differs");
    expect(await fs.readFile(skillPath, "utf8")).toBe(FOREIGN);
  });

  it("leaves a SKILL.md with no frontmatter untouched", async () => {
    await put("# just notes\n");

    expect((await installAgentsSkill(home)).action).toBe("exists-differs");
    expect(await fs.readFile(skillPath, "utf8")).toBe("# just notes\n");
  });
});

describe.skipIf(process.platform === "win32")("installAgentsSkill and symlinks", () => {
  it("refuses a symlinked markdown-collab directory and writes nothing at its target", async () => {
    await fs.mkdir(path.dirname(path.dirname(skillPath)), { recursive: true });
    await fs.symlink(elsewhere, path.dirname(skillPath));

    const result = await installAgentsSkill(home);

    expect(result.action).toBe("refused");
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it("refuses a symlinked skills directory and writes nothing at its target", async () => {
    await fs.mkdir(path.join(home, ".agents"));
    await fs.symlink(elsewhere, path.join(home, ".agents", "skills"));

    const result = await installAgentsSkill(home);

    expect(result.action).toBe("refused");
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it("refuses a symlinked .agents directory and writes nothing at its target", async () => {
    await fs.symlink(elsewhere, path.join(home, ".agents"));

    const result = await installAgentsSkill(home);

    expect(result.action).toBe("refused");
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it("refuses a symlinked SKILL.md and leaves what it points at alone", async () => {
    const real = path.join(elsewhere, "real.md");
    await fs.writeFile(real, OLDER_OURS, "utf8");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.symlink(real, skillPath);

    const result = await installAgentsSkill(home);

    expect(result.action).toBe("refused");
    expect(await fs.readFile(real, "utf8")).toBe(OLDER_OURS);
  });

  it("refuses a dangling symlink at SKILL.md without creating its target", async () => {
    const missing = path.join(elsewhere, "not-there.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.symlink(missing, skillPath);

    const result = await installAgentsSkill(home);

    expect(result.action).toBe("refused");
    expect(await exists(missing)).toBe(false);
  });

  it("says which link it refused", async () => {
    await fs.mkdir(path.join(home, ".agents"));
    await fs.symlink(elsewhere, path.join(home, ".agents", "skills"));

    const result = await installAgentsSkill(home);

    expect(result.action === "refused" && result.reason).toBe(`${path.join(home, ".agents", "skills")} is a symlink`);
  });
});

describe("refreshAgentsSkill", () => {
  it("does nothing when the skill was never installed, and creates no directory", async () => {
    expect(await refreshAgentsSkill(home)).toBeNull();
    expect(await exists(path.join(home, ".agents"))).toBe(false);
  });

  it("brings an earlier version of ours up to date", async () => {
    await put(OLDER_OURS);

    expect((await refreshAgentsSkill(home))?.action).toBe("updated");
    expect(await fs.readFile(skillPath, "utf8")).toBe(AGENTS_SKILL_CONTENT);
  });

  it("leaves a current copy as it is", async () => {
    await put(AGENTS_SKILL_CONTENT);

    expect((await refreshAgentsSkill(home))?.action).toBe("already-present");
  });

  it("leaves a skill someone else wrote untouched", async () => {
    await put(FOREIGN);

    expect((await refreshAgentsSkill(home))?.action).toBe("exists-differs");
    expect(await fs.readFile(skillPath, "utf8")).toBe(FOREIGN);
  });
});
