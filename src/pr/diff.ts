/**
 * `git diff` parsing — the only piece of code in the PR feature that the
 * unit tests really need to cover, because the file-by-file flow stops
 * working hard if these parsers miss an edge case.
 *
 * Two queries:
 *   - `listChangedMarkdownFiles` — added / modified / renamed `.md` files
 *     between the merge-base of `baseRef..HEAD` and HEAD. Three-dot range
 *     so we get exactly what GitHub / GitLab show in the PR diff.
 *   - `addedLineRanges` — head-side line numbers that contain `+` lines
 *     for a given file. Drives gutter decoration AND pre-submit
 *     validation that a comment's line is actually part of the diff.
 */

import { getCliRunner, type CliRunner } from "./cli";

export type ChangeStatus = "A" | "M" | "R";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
}

export interface LineRange {
  /** 1-based, inclusive. */
  start: number;
  /** 1-based, inclusive. */
  end: number;
}

const MARKDOWN_EXTENSIONS = [".md", ".markdown"];

function looksLikeMarkdown(p: string): boolean {
  const lower = p.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * `git diff --name-status -M` against the merge-base of `<baseRef>...HEAD`.
 * Filters to added / modified / renamed markdown files.
 */
export async function listChangedMarkdownFiles(
  repoRoot: string,
  baseRef: string,
  runner: CliRunner = getCliRunner(),
): Promise<ChangedFile[]> {
  const res = await runner(
    "git",
    ["diff", "--name-status", "-M", `${baseRef}...HEAD`],
    { cwd: repoRoot },
  );
  if (res.code !== 0) {
    throw new Error(`git diff failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return parseNameStatus(res.stdout).filter((f) => looksLikeMarkdown(f.path));
}

export function parseNameStatus(stdout: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");
    const tag = parts[0] ?? "";
    if (!tag) continue;
    const code = tag[0];
    if (code === "A" && parts.length >= 2) {
      out.push({ path: parts[1], status: "A" });
    } else if (code === "M" && parts.length >= 2) {
      out.push({ path: parts[1], status: "M" });
    } else if (code === "R" && parts.length >= 3) {
      out.push({ path: parts[2], status: "R", oldPath: parts[1] });
    }
    // D (deleted), T (type change), U (unmerged), C (copy) are skipped:
    // - D has no head-side line to anchor to
    // - T/U/C are edge cases we don't need in v1
  }
  return out;
}

/**
 * Added-line ranges for one file. Parses `git diff --unified=0` hunks of
 * the form `@@ -A,B +C,D @@` and emits the head-side ranges that contain
 * at least one `+` line.
 */
export async function addedLineRanges(
  repoRoot: string,
  baseRef: string,
  filePath: string,
  runner: CliRunner = getCliRunner(),
): Promise<LineRange[]> {
  const res = await runner(
    "git",
    ["diff", "--unified=0", `${baseRef}...HEAD`, "--", filePath],
    { cwd: repoRoot },
  );
  if (res.code !== 0) return [];
  return parseUnifiedHunkRanges(res.stdout);
}

/**
 * Parse the head-side line ranges from a `git diff --unified=0` output.
 *
 * Header form: `@@ -A[,B] +C[,D] @@ [section]`. When D is absent it
 * defaults to 1 (per the diff spec). D==0 means "no added lines" (pure
 * deletion at line C); we skip those entirely.
 */
export function parseUnifiedHunkRanges(stdout: string): LineRange[] {
  const out: LineRange[] = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of stdout.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] !== undefined ? Number(m[2]) : 1;
    if (count === 0) continue; // deletion-only hunk
    out.push({ start, end: start + count - 1 });
  }
  return out;
}

/** True when `line` is inside any of `ranges`. */
export function lineInRanges(line: number, ranges: readonly LineRange[]): boolean {
  for (const r of ranges) {
    if (line >= r.start && line <= r.end) return true;
  }
  return false;
}

/**
 * Resolve the merge-base of `<baseRef>` and HEAD. Used both for the
 * three-dot diff and (on GitLab) for the `base_sha` of inline notes.
 */
export async function mergeBaseSha(
  repoRoot: string,
  baseRef: string,
  runner: CliRunner = getCliRunner(),
): Promise<string> {
  const res = await runner("git", ["merge-base", baseRef, "HEAD"], { cwd: repoRoot });
  if (res.code !== 0) {
    throw new Error(`git merge-base failed: ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

/** Resolve the current HEAD SHA. */
export async function headSha(
  repoRoot: string,
  runner: CliRunner = getCliRunner(),
): Promise<string> {
  const res = await runner("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (res.code !== 0) throw new Error(`git rev-parse HEAD failed: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/** Read the `origin` remote URL. */
export async function originRemoteUrl(
  repoRoot: string,
  runner: CliRunner = getCliRunner(),
): Promise<string> {
  const res = await runner("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
  if (res.code !== 0) throw new Error(`git remote get-url origin failed: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/**
 * Parse a git remote URL into `{ host, owner, repo }`. Accepts both
 * `git@host:owner/repo.git` and `https://host/owner/repo[.git]`.
 */
export function parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  // Match `scheme://` URLs first — they're the more specific form. The
  // SSH `git@host:path` shorthand is tried only when no scheme is present
  // (otherwise `ssh://git@host:port/path` would be misread as SSH).
  const urlForm = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)\/([^/]+)$/.exec(trimmed);
  if (urlForm) return { host: urlForm[1], owner: urlForm[2], repo: urlForm[3] };
  const ssh = /^[^@]+@([^:]+):(.+?)\/([^/]+)$/.exec(trimmed);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };
  return null;
}
