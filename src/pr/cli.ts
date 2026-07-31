/**
 * Single chokepoint for shelling out to external CLIs (`gh`, `glab`, `git`).
 * All PR/MR code routes through `runCli` so tests can stub one function and
 * cover both platforms without touching the real filesystem or network.
 */

import { spawn } from "child_process";
import type { Logger } from "../logging";

export interface RunCliOptions {
  cwd?: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
  /** Hard timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CliRunner = (
  bin: string,
  args: string[],
  opts?: RunCliOptions,
) => Promise<RunCliResult>;

/** Default runner — real subprocess. Tests inject a stub. */
export const runCli: CliRunner = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${bin} timed out after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });

/** Test seam — swap `runCli` in unit tests via this getter. */
let activeRunner: CliRunner = runCli;
export function setCliRunner(runner: CliRunner): void {
  activeRunner = runner;
}

/**
 * Where CLI invocations are logged, when a logger has been installed. PR/MR
 * work is entirely `gh`/`glab` subprocesses, so "the review didn't post" is
 * almost always a non-zero exit nobody saw. Set once at activation.
 */
let cliLog: Logger | null = null;
export function setCliLogger(log: Logger | null): void {
  cliLog = log;
}

/**
 * The runner every caller goes through: the active runner, wrapped so each
 * invocation is logged with its exit code and duration. Request bodies are
 * omitted (they carry comment text) and the output is truncated by the
 * logger; redaction strips anything token-shaped.
 */
export function getCliRunner(): CliRunner {
  const runner = activeRunner;
  if (!cliLog) return runner;
  const log = cliLog;
  return async (bin, args, opts) => {
    const started = Date.now();
    try {
      const res = await runner(bin, args, opts);
      const line = { bin, args: args.join(" "), code: res.code, ms: Date.now() - started };
      if (res.code === 0) log.trace("cli", line);
      else log.warn("cli exited non-zero", { ...line, stderr: res.stderr.trim().slice(0, 300) });
      return res;
    } catch (e) {
      log.error(`cli ${bin} ${args.join(" ")} threw after ${Date.now() - started}ms`, e);
      throw e;
    }
  };
}

/** Convenience: throws when the CLI exits non-zero. */
export async function runCliOrThrow(
  bin: string,
  args: string[],
  opts: RunCliOptions = {},
): Promise<RunCliResult> {
  const res = await activeRunner(bin, args, opts);
  if (res.code !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res;
}
