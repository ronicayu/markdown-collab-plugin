import * as fs from "fs/promises";
import * as path from "path";
import { refuseSymlink } from "./agents";
import { CLI_SCRIPT_CONTENT, skillNamed, syncScript } from "./skill";
import { PLUGIN_NAME, renderSkill } from "./skillText";

export const AGENTS_SKILL_REL_PATH = path.join(".agents", "skills", PLUGIN_NAME, "SKILL.md");
export const AGENTS_SKILL_CONTENT = renderSkill("agents");
/**
 * The `mdc` CLI, beside the skill: the one way the skill tells these agents to
 * change a reviewed file. Every agent that reads `~/.agents/skills` can run a
 * command, so it gets the same safe engine Claude Code has — instead of rules
 * for editing the markers by hand. Ours, generated, and kept in sync silently.
 */
export const AGENTS_CLI_REL_PATH = path.join(".agents", "skills", PLUGIN_NAME, "mdc.mjs");

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
  if (existing !== null && !skillNamed(existing, PLUGIN_NAME)) return { action: "exists-differs", path: target };
  // Synced even when the skill text is unchanged: a CLI fix ships on its own.
  await syncScript(path.join(homeDir, AGENTS_CLI_REL_PATH), CLI_SCRIPT_CONTENT);
  if (existing === AGENTS_SKILL_CONTENT) return { action: "already-present", path: target };

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, AGENTS_SKILL_CONTENT, "utf8");
  return { action: existing === null ? "installed" : "updated", path: target };
}

/** Brings an installed copy up to date; never creates one. */
export async function refreshAgentsSkill(homeDir: string): Promise<AgentsSkillResult | null> {
  if ((await readSkill(path.join(homeDir, AGENTS_SKILL_REL_PATH))) === null) return null;
  return installAgentsSkill(homeDir);
}
