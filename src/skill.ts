import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "node:crypto";

export const SKILL_REL_PATH = ".claude/skills/vs-markdown-collab/SKILL.md";
export const CLI_SCRIPT_REL = ".claude/skills/vs-markdown-collab/mdc.mjs";

// Stale helpers from the deleted channel transports — no
// longer installed, but `installClaudeSkill` still deletes them if it finds
// them left over from an older install of this extension.
const STALE_HELPER_RELS = [
  ".claude/skills/vs-markdown-collab/mdc-tail.mjs",
  ".claude/skills/vs-markdown-collab/mdc-channel.mjs",
];

// This one is generated: it is src/skillCli/mdc.ts bundled with the real
// format engine. See scripts/build-skill-cli.mjs.
export { CLI_SCRIPT_CONTENT } from "./skillCli/generated";
import { CLI_SCRIPT_CONTENT } from "./skillCli/generated";
import { LEGACY_SKILL_NAME, PLUGIN_NAME, renderSkill } from "./skillText";

/**
 * The standalone skill — what `~/.claude/skills/vs-markdown-collab/SKILL.md`
 * holds. The text itself lives in `skillText.ts`, one source for this, the
 * Claude Code plugin's skill, the headless system prompt, and the MCP server's
 * instructions.
 */
export const SKILL_CONTENT = renderSkill("legacy");

/**
 * Every version of this extension wrote a SKILL.md whose frontmatter carries
 * the same name, and nothing marks which version — so that name is how an
 * earlier shipped skill is told apart from a file someone wrote.
 */
export function skillNamed(content: string, skillName: string): boolean {
  const frontmatter = /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const name = frontmatter && /^name:[ \t]*["']?([^"'\r\n]*?)["']?[ \t\r]*$/m.exec(frontmatter[1]);
  return name?.[1] === skillName;
}

export async function installClaudeSkill(
  homeDir: string,
  options?: { force?: boolean },
): Promise<{ action: "installed" | "updated" | "already-present" | "exists-differs"; path: string }> {
  const target = path.join(homeDir, SKILL_REL_PATH);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }

  // The CLI helper is auto-generated and silently kept in sync — never a
  // user-edited file, so we always overwrite it (when content differs).
  // Don't gate this on the SKILL.md path so a user with a customized SKILL.md
  // can still pick up CLI fixes.
  await syncCliScript(homeDir);

  // Helpers for the deleted channel transports. An install
  // from before that release may still have them on disk; they're ours, so we
  // clean them up rather than leaving dead scripts behind.
  await deleteStaleHelpers(homeDir);

  const shipped = existing !== null && skillNamed(existing, LEGACY_SKILL_NAME);
  if (existing !== null) {
    if (existing === SKILL_CONTENT) {
      return { action: "already-present", path: target };
    }
    if (!shipped && !options?.force) {
      return { action: "exists-differs", path: target };
    }
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, SKILL_CONTENT, "utf8");
  return { action: shipped ? "updated" : "installed", path: target };
}

export type SkillStatus = "missing" | "outdated" | "current";

export const PLUGIN_REGISTRY_REL = ".claude/plugins/installed_plugins.json";

export interface InstalledPlugin {
  /** `<plugin>@<marketplace>`, e.g. `markdown-collab@markdown-collab-local`. */
  id: string;
  version: string;
}

/**
 * The Markdown Collab plugin as Claude Code's own registry records it, from
 * any marketplace — the extension's local one or the GitHub one — or null.
 *
 * Read from the file rather than by spawning `claude plugin list`: this runs
 * every time the inline view opens, and a process per panel open is a price
 * the "is Claude set up?" banner doesn't justify. The file is Claude Code's
 * internal format (`{version, plugins: {id: [{scope, version, …}]}}`), so it
 * is read defensively — anything unexpected reads as "not installed", and the
 * legacy check decides. Project- and local-scope entries
 * don't count: they belong to one project, and this can't tell which.
 */
export async function installedClaudePlugin(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstalledPlugin | null> {
  // Claude Code moves its whole config directory when CLAUDE_CONFIG_DIR is
  // set, registry included; honor it the same way or a relocated install
  // reads as "not set up".
  const registry = env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json")
    : path.join(homeDir, PLUGIN_REGISTRY_REL);
  try {
    const raw = JSON.parse(await fs.readFile(registry, "utf8")) as {
      plugins?: Record<string, unknown>;
    };
    for (const [id, entries] of Object.entries(raw.plugins ?? {})) {
      if (id.split("@")[0] !== PLUGIN_NAME || !Array.isArray(entries)) continue;
      for (const e of entries as Array<{ scope?: unknown; version?: unknown }>) {
        if (e && (e.scope === undefined || e.scope === "user" || e.scope === "managed")) {
          return { id, version: typeof e.version === "string" ? e.version : "unknown" };
        }
      }
    }
  } catch {
    // No registry (Claude Code never ran, or has no plugins yet) or a shape we
    // don't know — either way, not evidence of an install.
  }
  return null;
}

/**
 * Compare the installed Claude skill against what this extension bundles:
 *   - "missing"  — neither the plugin nor SKILL.md is installed.
 *   - "outdated" — SKILL.md or a bundled helper script differs from this build.
 *   - "current"  — the plugin is installed, or the standalone skill matches.
 * Read errors other than "not found" report "current" so a transient or
 * permission issue never nags the user.
 *
 * An installed plugin wins outright: it carries its own copy of the skill, and
 * the standalone files are removed when it's installed — reporting those as
 * "missing" would nag exactly the users who did the recommended thing. (The
 * plugin's own version drift is `maybePromptSkillUpdate`'s job, once per
 * extension version, through `claude plugin list`.)
 */
export async function checkClaudeSkill(homeDir: string): Promise<SkillStatus> {
  if (await installedClaudePlugin(homeDir)) return "current";
  let skill: string | null = null;
  try {
    skill = await fs.readFile(path.join(homeDir, SKILL_REL_PATH), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "current";
  }
  if (skill !== SKILL_CONTENT) return "outdated";
  try {
    if ((await fs.readFile(path.join(homeDir, CLI_SCRIPT_REL), "utf8")) !== CLI_SCRIPT_CONTENT) {
      return "outdated";
    }
  } catch (e) {
    // A missing helper script means the install is incomplete → outdated.
    // Other read errors (permission, transient) shouldn't nag — same posture
    // as the SKILL.md read above.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "outdated";
  }
  return "current";
}

/**
 * Short, stable fingerprint of the bundled skill (SKILL.md + helper scripts).
 * Changes whenever the bundled skill content changes, so callers can prompt the
 * user to update exactly once per skill version instead of every activation.
 *
 * Covers exactly the files a fresh install writes — see `installClaudeSkill`.
 */
export function skillFingerprint(): string {
  return createHash("sha1")
    .update(SKILL_CONTENT)
    .update(CLI_SCRIPT_CONTENT)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Remove the standalone skill once the plugin is installed. Both at once would
 * register the workflow twice — as `vs-markdown-collab` and as
 * `markdown-collab:review` — and the two can disagree whenever one is older.
 * Only files this extension wrote are touched; the directory goes only if that
 * leaves it empty, so anything a user added beside them survives.
 */
export async function removeLegacySkill(homeDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const rel of [SKILL_REL_PATH, CLI_SCRIPT_REL, ...STALE_HELPER_RELS]) {
    const target = path.join(homeDir, rel);
    try {
      await fs.unlink(target);
      removed.push(target);
    } catch {
      // Not there — the goal state.
    }
  }
  try {
    await fs.rmdir(path.dirname(path.join(homeDir, SKILL_REL_PATH)));
  } catch {
    // Missing, or not empty because the user keeps something there: leave it.
  }
  return removed;
}

async function syncCliScript(homeDir: string): Promise<void> {
  await syncScript(path.join(homeDir, CLI_SCRIPT_REL), CLI_SCRIPT_CONTENT);
}

async function deleteStaleHelpers(homeDir: string): Promise<void> {
  for (const rel of STALE_HELPER_RELS) {
    try {
      await fs.unlink(path.join(homeDir, rel));
    } catch {
      // Already gone, or never installed — both are the goal state.
    }
  }
}

async function syncScript(target: string, content: string): Promise<void> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }
  if (existing === content) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  try {
    await fs.chmod(target, 0o755);
  } catch {
    /* Windows / restricted FS — irrelevant, we invoke via `node` */
  }
}
