/**
 * Git queries for the uncommitted-changes review view. Everything diffs the
 * working tree against HEAD — no remote, no platform CLI, no PR context.
 *
 * vscode-free; the runner is injectable so tests stub the one chokepoint,
 * same pattern as `../pr/diff`.
 */

import {
  looksLikeMarkdown,
  parseNameStatus,
  type ChangedFile,
} from "../pr/diff";
import { getCliRunner, type CliRunner } from "../pr/cli";

/**
 * Repo root containing `startDir`, or null when it isn't inside a git work
 * tree (including "git isn't installed").
 */
export async function repoRootFor(
  startDir: string,
  runner: CliRunner = getCliRunner(),
): Promise<string | null> {
  try {
    const res = await runner("git", ["rev-parse", "--show-toplevel"], { cwd: startDir });
    if (res.code !== 0) return null;
    const root = res.stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Markdown files with uncommitted changes, relative to `repoRoot`:
 *
 *   - tracked files that differ from HEAD (staged and/or unstaged) via
 *     `git diff --name-status -M HEAD` — one query covers both, because it
 *     compares HEAD directly against the working tree
 *   - untracked (never-committed) files via `git ls-files --others
 *     --exclude-standard`, reported with status "A"
 *
 * Deleted files are skipped upstream by `parseNameStatus` — there is no
 * working-tree content to review.
 */
export async function listUncommittedMarkdownFiles(
  repoRoot: string,
  runner: CliRunner = getCliRunner(),
): Promise<ChangedFile[]> {
  const [tracked, untracked] = await Promise.all([
    runner("git", ["diff", "--name-status", "-M", "HEAD"], { cwd: repoRoot }),
    runner("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoRoot }),
  ]);
  if (tracked.code !== 0) {
    throw new Error(`git diff failed: ${tracked.stderr.trim() || tracked.stdout.trim()}`);
  }
  const out = parseNameStatus(tracked.stdout).filter((f) => looksLikeMarkdown(f.path));
  if (untracked.code === 0) {
    for (const raw of untracked.stdout.split("\n")) {
      const p = raw.trim();
      if (p && looksLikeMarkdown(p)) out.push({ path: p, status: "A" });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Where each changed file's content currently sits relative to the index:
 * `staged` (all of it is in the index), `unstaged` (none of it is), or
 * `partial` (some hunks staged, some not). Untracked files are `unstaged`.
 */
export type StageState = "staged" | "unstaged" | "partial";

/**
 * Stage state per repo-relative path, for every path that differs from HEAD
 * or the index. Two queries: index-vs-HEAD says what is staged, worktree-vs-
 * index says what isn't; a path in both is partially staged.
 */
export async function stageStates(
  repoRoot: string,
  runner: CliRunner = getCliRunner(),
): Promise<Map<string, StageState>> {
  const [cached, unstaged] = await Promise.all([
    runner("git", ["diff", "--name-only", "--cached", "-M"], { cwd: repoRoot }),
    runner("git", ["diff", "--name-only", "-M"], { cwd: repoRoot }),
  ]);
  const paths = (res: { code: number; stdout: string }): Set<string> =>
    res.code === 0
      ? new Set(res.stdout.split("\n").map((l) => l.trim()).filter(Boolean))
      : new Set();
  const stagedSet = paths(cached);
  const unstagedSet = paths(unstaged);
  const out = new Map<string, StageState>();
  for (const p of stagedSet) out.set(p, unstagedSet.has(p) ? "partial" : "staged");
  for (const p of unstagedSet) if (!out.has(p)) out.set(p, "unstaged");
  return out;
}

/** `git add` one file. Throws with git's stderr when the add is refused. */
export async function stageFile(
  repoRoot: string,
  relPath: string,
  runner: CliRunner = getCliRunner(),
): Promise<void> {
  const res = await runner("git", ["add", "--", relPath], { cwd: repoRoot });
  if (res.code !== 0) {
    throw new Error(`git add failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/** Take one file back out of the index; the working tree is untouched. */
export async function unstageFile(
  repoRoot: string,
  relPath: string,
  runner: CliRunner = getCliRunner(),
): Promise<void> {
  const res = await runner("git", ["restore", "--staged", "--", relPath], { cwd: repoRoot });
  if (res.code !== 0) {
    throw new Error(`git restore --staged failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/**
 * Content of `relPath` at HEAD, or null when the file doesn't exist there
 * (untracked / newly added). `relPath` is repo-relative with `/` separators.
 */
export async function headFileContent(
  repoRoot: string,
  relPath: string,
  runner: CliRunner = getCliRunner(),
): Promise<string | null> {
  // `./` pins the path to the repo root even if it contains a colon.
  const res = await runner("git", ["show", `HEAD:./${relPath}`], { cwd: repoRoot });
  if (res.code !== 0) return null;
  return res.stdout;
}
