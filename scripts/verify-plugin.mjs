#!/usr/bin/env node
// Structural check on the committed Claude Code plugin.
//
// The plugin is generated (scripts/build-plugin.mjs) but committed, because
// the GitHub marketplace serves it straight from the repository — so the
// committed tree IS what users install, and it can go stale in ways a green
// build never notices: a version bump that didn't regenerate, a skill edit
// that didn't land in the plugin, a hand-edit to hooks.json. CI also runs
// `git diff --exit-code plugin .claude-plugin` after compile; this names the
// specific promise that broke, and runs without git (`npm test` calls it too).
//
// Usage: node scripts/verify-plugin.mjs   (exit 1 and one line per problem)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { HOOKS, MARKETPLACE_REL, PLUGIN_DIR, loadSkillText, renderPluginFiles, root } from "./build-plugin.mjs";

function readJson(rel, problems) {
  try {
    return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
  } catch (e) {
    problems.push(`${rel}: unreadable or not JSON (${e.message})`);
    return null;
  }
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join("/"));
}

/** Every broken promise, as one line each. Empty when the plugin is sound. */
export async function verifyPlugin() {
  const problems = [];
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  // 1. Versions: the manifest and the marketplace entry say what the extension says.
  const manifest = readJson(`${PLUGIN_DIR}/.claude-plugin/plugin.json`, problems);
  if (manifest) {
    if (manifest.name !== "markdown-collab") problems.push(`plugin.json name is ${manifest.name}, not markdown-collab`);
    if (manifest.version !== pkg.version) {
      problems.push(`plugin.json version ${manifest.version} != package.json version ${pkg.version}`);
    }
    for (const field of ["description", "homepage", "repository", "license"]) {
      if (typeof manifest[field] !== "string" || manifest[field] === "") problems.push(`plugin.json has no ${field}`);
    }
    if (typeof manifest.author?.name !== "string") problems.push("plugin.json has no author.name");
  }
  const marketplace = readJson(MARKETPLACE_REL, problems);
  if (marketplace) {
    const entry = marketplace.plugins?.find?.((p) => p.name === "markdown-collab");
    if (!entry) problems.push(`${MARKETPLACE_REL} doesn't list markdown-collab`);
    else {
      if (entry.source !== `./${PLUGIN_DIR}`) problems.push(`${MARKETPLACE_REL} source is ${entry.source}`);
      if (entry.version !== pkg.version) {
        problems.push(`${MARKETPLACE_REL} version ${entry.version} != package.json version ${pkg.version}`);
      }
    }
  }

  // 2. The skill is the plugin rendering of src/skillText.ts, byte for byte.
  const { renderSkill } = await loadSkillText();
  const skillRel = `${PLUGIN_DIR}/skills/review/SKILL.md`;
  if (!existsSync(path.join(root, skillRel))) problems.push(`${skillRel} is missing`);
  else if (readFileSync(path.join(root, skillRel), "utf8") !== renderSkill("plugin")) {
    problems.push(`${skillRel} differs from renderSkill("plugin") — run npm run compile`);
  }

  // 3. The hook: shape, event, matcher, and the command it runs.
  const hooks = readJson(`${PLUGIN_DIR}/hooks/hooks.json`, problems);
  if (hooks && !isDeepStrictEqual(hooks, HOOKS)) {
    problems.push(`${PLUGIN_DIR}/hooks/hooks.json isn't the PostToolUse → mdc check --hook registration`);
  }
  const hook = hooks?.hooks?.PostToolUse?.[0]?.hooks?.[0] ?? {};
  const command = [hook.command ?? "", ...(Array.isArray(hook.args) ? hook.args : [])].join(" ");
  if (!command.includes("${CLAUDE_PLUGIN_ROOT}/lib/mdc.mjs") || !command.includes("check --hook")) {
    problems.push("the hook command doesn't run ${CLAUDE_PLUGIN_ROOT}/lib/mdc.mjs check --hook");
  }

  // 4. The shims and the CLI they run.
  const shimRel = `${PLUGIN_DIR}/bin/mdc`;
  if (!existsSync(path.join(root, shimRel))) problems.push(`${shimRel} is missing`);
  else {
    if (!readFileSync(path.join(root, shimRel), "utf8").startsWith("#!/bin/sh\n")) {
      problems.push(`${shimRel} has no #!/bin/sh shebang`);
    }
    if (process.platform !== "win32" && (statSync(path.join(root, shimRel)).mode & 0o111) === 0) {
      problems.push(`${shimRel} isn't executable`);
    }
  }
  if (!existsSync(path.join(root, `${PLUGIN_DIR}/bin/mdc.cmd`))) problems.push(`${PLUGIN_DIR}/bin/mdc.cmd is missing`);
  const cliRel = `${PLUGIN_DIR}/lib/mdc.mjs`;
  if (!existsSync(path.join(root, cliRel))) problems.push(`${cliRel} is missing`);
  else if (!readFileSync(path.join(root, cliRel), "utf8").startsWith("#!/usr/bin/env node\n")) {
    problems.push(`${cliRel} doesn't look like the bundled CLI`);
  }

  // 5. Nothing else: every committed file is one the generator writes, with the
  //    bytes it writes (needs out/skill/mdc.mjs, i.e. after bundle:skill-cli).
  if (existsSync(path.join(root, "out/skill/mdc.mjs"))) {
    const expected = await renderPluginFiles();
    const expectedRels = new Set(expected.map((f) => f.rel));
    for (const f of expected) {
      const abs = path.join(root, f.rel);
      if (!existsSync(abs)) problems.push(`${f.rel} is missing — run npm run compile`);
      else if (readFileSync(abs, "utf8") !== f.content) problems.push(`${f.rel} is stale — run npm run compile`);
    }
    for (const rel of listFiles(path.join(root, PLUGIN_DIR))) {
      if (!expectedRels.has(rel)) problems.push(`${rel} isn't generated by scripts/build-plugin.mjs`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = await verifyPlugin();
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length > 0) process.exit(1);
  console.log("verify-plugin: plugin/ and .claude-plugin/ match package.json and a fresh generation");
}
