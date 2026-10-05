import * as fs from "fs/promises";
import * as path from "path";
import { refuseSymlink } from "./agents";
import { skillNamed } from "./skill";
import { PLUGIN_NAME, renderSkill } from "./skillText";

export const AGENTS_SKILL_REL_PATH = path.join(".agents", "skills", PLUGIN_NAME, "SKILL.md");
export const AGENTS_SKILL_CONTENT = renderSkill("agents");

export type AgentsSkillResult =
  | { action: "installed" | "updated" | "already-present" | "exists-differs"; path: string }
  | { action: "refused"; path: string; reason: string };

async function readSkill(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function installAgentsSkill(homeDir: string): Promise<AgentsSkillResult> {
  const target = path.join(homeDir, AGENTS_SKILL_REL_PATH);
  const reason = (await refuseSymlink(path.dirname(path.dirname(target)))) ?? (await refuseSymlink(target));
  if (reason) return { action: "refused", path: target, reason };

  const existing = await readSkill(target);
  if (existing === AGENTS_SKILL_CONTENT) return { action: "already-present", path: target };
  if (existing !== null && !skillNamed(existing, PLUGIN_NAME)) return { action: "exists-differs", path: target };

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, AGENTS_SKILL_CONTENT, "utf8");
  return { action: existing === null ? "installed" : "updated", path: target };
}

/** Brings an installed copy up to date; never creates one. */
export async function refreshAgentsSkill(homeDir: string): Promise<AgentsSkillResult | null> {
  if ((await readSkill(path.join(homeDir, AGENTS_SKILL_REL_PATH))) === null) return null;
  return installAgentsSkill(homeDir);
}
