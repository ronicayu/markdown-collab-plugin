// Installing the Claude Code plugin from a marketplace the extension owns
// (10x-plan-4 P0.2).
//
// WHY A LOCAL MARKETPLACE. The extension ships `plugin/` inside the .vsix and
// installs it from a marketplace directory it writes under its own global
// storage, instead of pointing Claude Code at the GitHub marketplace. That way
// the Claude side is always exactly the extension's version: no fingerprint to
// compare, no window where the extension has moved on and the skill hasn't,
// and no network. (The GitHub marketplace — `.claude-plugin/marketplace.json`
// at the repo root — is for people who want the Claude side without the
// extension.)
//
// Every step is a `claude plugin …` command, run through an injected runner so
// the whole sequence is unit-testable without a Claude Code install; the real
// runner is `execFile` with an argument array (commands/setup.ts). Nothing
// here parses human-readable CLI output: success is the exit code, and state
// comes from the `--json` forms.
//
// vscode-free.

import { promises as fsp, realpathSync } from "node:fs";
import * as path from "node:path";
import { PLUGIN_NAME } from "./skillText";

/** The marketplace the extension writes and registers. */
export const LOCAL_MARKETPLACE_NAME = "markdown-collab-local";
/** What `claude plugin install` / `list` call our plugin. */
export const LOCAL_PLUGIN_ID = `${PLUGIN_NAME}@${LOCAL_MARKETPLACE_NAME}`;
/** The marketplace's directory under the extension's global storage. */
export const LOCAL_MARKETPLACE_DIRNAME = "claude-marketplace";

export interface RunResult {
  /** Exit status; null when the process didn't start, timed out, or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the process didn't produce an exit status, when it didn't. */
  error?: string;
}

/** Run `claude <args…>`. */
export type ClaudeRunner = (args: string[]) => Promise<RunResult>;

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
}

/** Read the manifest of the plugin the extension ships. */
export async function readPluginManifest(pluginDir: string): Promise<PluginManifest> {
  const raw = JSON.parse(
    await fsp.readFile(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
  ) as Partial<PluginManifest>;
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error(`${pluginDir} has no plugin name/version in .claude-plugin/plugin.json`);
  }
  return { name: raw.name, version: raw.version, description: raw.description };
}

/** The local marketplace's manifest, listing the one plugin. */
export function localMarketplaceJson(m: PluginManifest): string {
  return `${JSON.stringify(
    {
      name: LOCAL_MARKETPLACE_NAME,
      description: "Markdown Collab's Claude Code plugin, installed by the VS Code extension.",
      owner: { name: "Ronica" },
      plugins: [
        {
          name: m.name,
          source: `./plugins/${m.name}`,
          ...(m.description ? { description: m.description } : {}),
          version: m.version,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/**
 * (Re)write the local marketplace from the shipped plugin. The plugin copy is
 * replaced wholesale so a file dropped from a newer version doesn't linger.
 */
export async function writeLocalMarketplace(
  sourcePluginDir: string,
  marketplaceDir: string,
): Promise<PluginManifest> {
  const manifest = await readPluginManifest(sourcePluginDir);
  const dest = path.join(marketplaceDir, "plugins", manifest.name);
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(sourcePluginDir, dest, { recursive: true });
  // A .vsix is a zip, and extracting it drops the executable bit; without it
  // `mdc` is on PATH but won't run.
  try {
    await fsp.chmod(path.join(dest, "bin", "mdc"), 0o755);
  } catch {
    // Windows, or a filesystem without modes: the .cmd shim is what runs there.
  }
  const manifestPath = path.join(marketplaceDir, ".claude-plugin", "marketplace.json");
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(manifestPath, localMarketplaceJson(manifest), "utf8");
  return manifest;
}

/** A marketplace as `claude plugin marketplace list --json` reports it. */
export interface ListedMarketplace {
  name: string;
  path?: string;
}

export function parseMarketplaceList(stdout: string): ListedMarketplace[] | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (!Array.isArray(raw)) return null;
    return raw.flatMap((m: { name?: unknown; path?: unknown; installLocation?: unknown }) =>
      m && typeof m.name === "string"
        ? [
            {
              name: m.name,
              path:
                typeof m.path === "string"
                  ? m.path
                  : typeof m.installLocation === "string"
                    ? m.installLocation
                    : undefined,
            },
          ]
        : [],
    );
  } catch {
    return null;
  }
}

/** A plugin as `claude plugin list --json` reports it. */
export interface ListedPlugin {
  id: string;
  version: string;
  enabled: boolean;
  scope?: string;
}

export function parsePluginList(stdout: string): ListedPlugin[] | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (!Array.isArray(raw)) return null;
    return raw.flatMap((p: { id?: unknown; version?: unknown; enabled?: unknown; scope?: unknown }) =>
      p && typeof p.id === "string"
        ? [
            {
              id: p.id,
              version: typeof p.version === "string" ? p.version : "",
              // Absent means Claude Code didn't say; only an explicit false is off.
              enabled: p.enabled !== false,
              scope: typeof p.scope === "string" ? p.scope : undefined,
            },
          ]
        : [],
    );
  } catch {
    return null;
  }
}

/** Whether this Claude Code has plugin commands at all. */
export async function pluginsSupported(run: ClaudeRunner): Promise<boolean> {
  return (await run(["plugin", "--help"])).code === 0;
}

/** Our plugin, if `claude plugin list --json` shows it installed; null if not or unknown. */
export async function installedLocalPlugin(run: ClaudeRunner): Promise<ListedPlugin | null> {
  const r = await run(["plugin", "list", "--json"]);
  if (r.code !== 0) return null;
  return parsePluginList(r.stdout)?.find((p) => p.id === LOCAL_PLUGIN_ID) ?? null;
}

export type PluginSetupOutcome =
  | { ok: true; version: string }
  | {
      ok: false;
      /** Human-readable, for the fallback toast. */
      reason: string;
      /** True when the CLI has no plugin support — not a failure worth logging loudly. */
      unsupported?: boolean;
    };

/** Whether two paths name one directory — through symlinks (macOS's /tmp) too. */
function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function describeFailure(step: string, r: RunResult): string {
  const detail = (r.error ?? r.stderr.trim().split("\n").pop() ?? "").trim();
  const status = r.code === null ? "did not finish" : `exited ${r.code}`;
  return `\`claude ${step}\` ${status}${detail ? `: ${detail}` : ""}`;
}

/**
 * Install (or bring up to date) the plugin from the local marketplace:
 * refresh the marketplace files, make sure Claude Code knows the marketplace,
 * refresh its view of it, install, and update if what's installed is another
 * version. Safe to re-run: every step is idempotent on its own.
 *
 * Also the "Update" path of the out-of-date nudge — an update is the same
 * sequence with the install step already satisfied.
 */
export async function setUpClaudePlugin(opts: {
  run: ClaudeRunner;
  /** The plugin the extension ships (`<extension>/plugin`). */
  sourcePluginDir: string;
  /** `<globalStorage>/claude-marketplace`. */
  marketplaceDir: string;
}): Promise<PluginSetupOutcome> {
  const { run, sourcePluginDir, marketplaceDir } = opts;

  if (!(await pluginsSupported(run))) {
    return { ok: false, unsupported: true, reason: "this Claude Code version has no plugin support" };
  }

  let manifest: PluginManifest;
  try {
    manifest = await writeLocalMarketplace(sourcePluginDir, marketplaceDir);
  } catch (e) {
    return { ok: false, reason: `couldn't write the local marketplace: ${(e as Error).message}` };
  }

  // Already registered? Asked through `--json` rather than by reading "already
  // added" out of an error message, which is worded for people and may change.
  const listed = await run(["plugin", "marketplace", "list", "--json"]);
  const existing =
    listed.code === 0
      ? parseMarketplaceList(listed.stdout)?.find((m) => m.name === LOCAL_MARKETPLACE_NAME)
      : undefined;
  const repoint = existing?.path !== undefined && !samePath(existing.path, marketplaceDir);
  if (repoint) {
    // Registered from somewhere else — typically another VS Code flavor
    // (Insiders keeps its own global storage). Re-point it at ours: the name is
    // this extension's, and a marketplace whose directory can vanish with the
    // other editor's storage is worse than one that moves.
    const removed = await run(["plugin", "marketplace", "remove", LOCAL_MARKETPLACE_NAME]);
    if (removed.code !== 0) return { ok: false, reason: describeFailure("plugin marketplace remove", removed) };
  }
  if (!existing || repoint) {
    const added = await run(["plugin", "marketplace", "add", marketplaceDir]);
    if (added.code !== 0) return { ok: false, reason: describeFailure("plugin marketplace add", added) };
  }

  const refreshed = await run(["plugin", "marketplace", "update", LOCAL_MARKETPLACE_NAME]);
  if (refreshed.code !== 0) {
    return { ok: false, reason: describeFailure("plugin marketplace update", refreshed) };
  }

  const installed = await run(["plugin", "install", LOCAL_PLUGIN_ID, "--scope", "user"]);
  if (installed.code !== 0) return { ok: false, reason: describeFailure("plugin install", installed) };

  // `install` on an already-installed plugin is a no-op that exits 0, whatever
  // version is installed — so check, and update when it's another version.
  const current = await installedLocalPlugin(run);
  if (current && current.version !== manifest.version) {
    const updated = await run(["plugin", "update", LOCAL_PLUGIN_ID]);
    if (updated.code !== 0) return { ok: false, reason: describeFailure("plugin update", updated) };
  }
  // Someone who runs Set Up asked for it on; a plugin they switched off earlier
  // would otherwise sit installed and silent while the standalone skill it
  // replaces gets removed.
  if (current && !current.enabled) {
    const enabled = await run(["plugin", "enable", LOCAL_PLUGIN_ID]);
    if (enabled.code !== 0) return { ok: false, reason: describeFailure("plugin enable", enabled) };
  }
  return { ok: true, version: manifest.version };
}
