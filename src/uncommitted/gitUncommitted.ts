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
