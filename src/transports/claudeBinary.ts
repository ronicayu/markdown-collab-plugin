// Finding the `claude` executable, and asking it what it is (10x-plan-4 P0.1).
//
// Headless mode is only ever offered when this answers — the picker must never
// list an option that fails on click. Three places are searched, in order:
//
//   1. `markdownCollab.claudePath`, when set. An explicit path is the user
//      telling us where it is; if it's wrong we say so rather than quietly
//      running some other `claude` found on PATH.
//   2. PATH, the way a shell would.
//   3. The installers' well-known locations. VS Code launched from the Dock
//      (or a Windows shortcut) gets the login session's PATH, not the shell's,
//      and `~/.local/bin` — where the native installer puts `claude` — is
//      usually missing from it. Without this step "Claude Code isn't
//      installed" would be the most common wrong answer.
//
// Everything that touches the machine is injected (`ResolveEnv`), so the
// search order is unit-testable without a real install. vscode-free.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
  /** The probe's output, trimmed — what the log and diagnostics show. */
  raw: string;
}

/** Parse `claude --version` output, e.g. `2.1.283 (Claude Code)`. */
export function parseClaudeVersion(output: string): ClaudeVersion | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: output.trim() };
}

export function versionAtLeast(v: ClaudeVersion, min: readonly [number, number, number]): boolean {
  if (v.major !== min[0]) return v.major > min[0];
  if (v.minor !== min[1]) return v.minor > min[1];
  return v.patch >= min[2];
}

/**
 * `--permission-prompts none` arrived in 2.1.259. Older CLIs reject unknown
 * flags outright, so it is only passed to versions known to accept it —
 * `--permission-mode dontAsk` already denies anything that would prompt.
 */
export const PERMISSION_PROMPTS_MIN = [2, 1, 259] as const;

/** The machine, as far as the search is concerned. */
export interface ResolveEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
  /** A regular file we may execute (on Windows: a regular file). */
  isExecutable(p: string): boolean;
}

export type ClaudeBinarySource = "setting" | "path" | "well-known";

export type BinaryResolution =
  | { ok: true; path: string; source: ClaudeBinarySource }
  | { ok: false; error: string };

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** File names to try in each PATH directory. */
function executableNames(e: ResolveEnv): string[] {
  if (e.platform !== "win32") return ["claude"];
  // The native installer ships claude.exe; the npm install is a claude.cmd shim.
  const exts = (e.env.PATHEXT ?? ".EXE;.CMD;.BAT")
    .split(";")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x === ".exe" || x === ".cmd" || x === ".bat");
  return (exts.length > 0 ? exts : [".exe", ".cmd"]).map((x) => `claude${x}`);
}

/** Installer locations checked when PATH comes up empty. */
export function wellKnownClaudePaths(e: ResolveEnv): string[] {
  const p = pathApi(e.platform);
  if (e.platform === "win32") {
    const out: string[] = [];
    const profile = e.env.USERPROFILE ?? e.homedir;
    if (profile) out.push(p.join(profile, ".local", "bin", "claude.exe"));
    if (e.env.APPDATA) out.push(p.join(e.env.APPDATA, "npm", "claude.cmd"));
    return out;
  }
  return [
    p.join(e.homedir, ".local", "bin", "claude"),
    p.join(e.homedir, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

function expandHome(p: string, e: ResolveEnv): string {
  if (p === "~") return e.homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return pathApi(e.platform).join(e.homedir, p.slice(2));
  return p;
}

/** Find the binary. Pure over `e`. */
export function resolveClaudeBinary(configured: string, e: ResolveEnv): BinaryResolution {
  const setting = configured.trim();
  if (setting !== "") {
    const candidate = expandHome(setting, e);
    if (e.isExecutable(candidate)) return { ok: true, path: candidate, source: "setting" };
    return {
      ok: false,
      error: `markdownCollab.claudePath is set to ${candidate}, which isn't an executable file`,
    };
  }
  const p = pathApi(e.platform);
  const dirs = (e.env.PATH ?? e.env.Path ?? "")
    .split(e.platform === "win32" ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of executableNames(e)) {
      const candidate = p.join(dir, name);
      if (e.isExecutable(candidate)) return { ok: true, path: candidate, source: "path" };
    }
  }
  for (const candidate of wellKnownClaudePaths(e)) {
    if (e.isExecutable(candidate)) return { ok: true, path: candidate, source: "well-known" };
  }
  return { ok: false, error: "no `claude` executable on PATH or in the usual install locations" };
}

/** The real machine. */
export function defaultResolveEnv(): ResolveEnv {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    isExecutable: (p) => {
      try {
        if (!fs.statSync(p).isFile()) return false;
        if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * How to spawn `bin` with `args`. On Windows a `.cmd`/`.bat` shim can only be
 * started through the shell (Node refuses otherwise since the 2024 batch-file
 * fix), and the shell re-parses the command line — so every argument is
 * quoted. This is also why the prompt travels on stdin rather than argv: no
 * quoting rule survives arbitrary Markdown.
 */
export function spawnCommand(
  bin: string,
  args: string[],
  platform: NodeJS.Platform,
): { command: string; args: string[]; shell: boolean } {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return { command: quoteForCmd(bin), args: args.map(quoteForCmd), shell: true };
  }
  return { command: bin, args, shell: false };
}

/** Quote one argument for cmd.exe. Exported for tests. */
export function quoteForCmd(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export type VersionProbe =
  | { ok: true; version: ClaudeVersion }
  | { ok: false; error: string };

/**
 * Run `<bin> --version` once. A binary that can't answer this in five seconds
 * isn't one we should hand a review to — a hung probe usually means a broken
 * install or an interactive first-run prompt.
 */
export function probeClaudeVersion(
  bin: string,
  opts: { timeoutMs?: number; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<VersionProbe> {
  const platform = opts.platform ?? process.platform;
  const spec = spawnCommand(bin, ["--version"], platform);
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const settle = (r: VersionProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, {
        shell: spec.shell,
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, error: `\`${bin} --version\` did not answer within ${opts.timeoutMs ?? 5000}ms` });
    }, opts.timeoutMs ?? 5000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.on("error", (e) => settle({ ok: false, error: e.message }));
    child.on("close", (code) => {
      const version = parseClaudeVersion(out);
      if (code === 0 && version) settle({ ok: true, version });
      else settle({ ok: false, error: `\`${bin} --version\` exited ${code} with ${JSON.stringify(out.trim().slice(0, 80))}` });
    });
  });
}
