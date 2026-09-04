/**
 * Git-query coverage for the uncommitted-changes view, with the CLI runner
 * stubbed — same pattern as the PR diff tests.
 */

import { describe, expect, it } from "vitest";
import type { CliRunner, RunCliResult } from "../pr/cli";
import {
  headFileContent,
  listUncommittedMarkdownFiles,
  repoRootFor,
  stageFile,
  stageStates,
  unstageFile,
} from "../uncommitted/gitUncommitted";

const ok = (stdout: string): RunCliResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string, code = 1): RunCliResult => ({ stdout: "", stderr, code });

function runnerFor(handlers: Record<string, RunCliResult>): CliRunner {
  return async (bin, args) => {
    const key = `${bin} ${args.join(" ")}`;
    const hit = Object.entries(handlers).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected CLI call: ${key}`);
    return hit[1];
  };
}

describe("listUncommittedMarkdownFiles", () => {
  it("merges tracked changes with untracked files, filtered to markdown", async () => {
    const runner = runnerFor({
      "git diff --name-status -M HEAD": ok(
        ["M\tdocs/spec.md", "A\tstaged-new.md", "M\tsrc/code.ts", "D\tgone.md"].join("\n"),
      ),
      "git ls-files --others --exclude-standard": ok(
        ["scratch.md", "notes.markdown", "image.png"].join("\n"),
      ),
    });
    const got = await listUncommittedMarkdownFiles("/repo", runner);
    expect(got).toEqual([
      { path: "docs/spec.md", status: "M" },
      { path: "notes.markdown", status: "A" },
      { path: "scratch.md", status: "A" },
      { path: "staged-new.md", status: "A" },
    ]);
  });

  it("throws when git diff fails", async () => {
    const runner = runnerFor({
      "git diff --name-status -M HEAD": fail("fatal: bad revision 'HEAD'", 128),
      "git ls-files --others --exclude-standard": ok(""),
    });
    await expect(listUncommittedMarkdownFiles("/repo", runner)).rejects.toThrow(
      /bad revision/,
    );
  });

  it("tolerates ls-files failing (tracked list still returned)", async () => {
    const runner = runnerFor({
      "git diff --name-status -M HEAD": ok("M\ta.md"),
      "git ls-files --others --exclude-standard": fail("boom"),
    });
    expect(await listUncommittedMarkdownFiles("/repo", runner)).toEqual([
      { path: "a.md", status: "M" },
    ]);
  });

  it("handles renames", async () => {
    const runner = runnerFor({
      "git diff --name-status -M HEAD": ok("R100\told.md\tnew.md"),
      "git ls-files --others --exclude-standard": ok(""),
    });
    expect(await listUncommittedMarkdownFiles("/repo", runner)).toEqual([
      { path: "new.md", status: "R", oldPath: "old.md" },
    ]);
  });
});

describe("headFileContent", () => {
  it("returns the blob content on success", async () => {
    const runner = runnerFor({ "git show HEAD:./docs/spec.md": ok("# Spec\n\nbody\n") });
    expect(await headFileContent("/repo", "docs/spec.md", runner)).toBe("# Spec\n\nbody\n");
  });

  it("returns null when the file has no HEAD version", async () => {
    const runner = runnerFor({
      "git show HEAD:./new.md": fail("fatal: path 'new.md' does not exist in 'HEAD'", 128),
    });
    expect(await headFileContent("/repo", "new.md", runner)).toBeNull();
  });
});

describe("repoRootFor", () => {
  it("returns the trimmed toplevel", async () => {
    const runner = runnerFor({ "git rev-parse --show-toplevel": ok("/repo/root\n") });
    expect(await repoRootFor("/repo/root/docs", runner)).toBe("/repo/root");
  });

  it("returns null outside a work tree", async () => {
    const runner = runnerFor({
      "git rev-parse --show-toplevel": fail("fatal: not a git repository", 128),
    });
    expect(await repoRootFor("/tmp", runner)).toBeNull();
  });

  it("returns null when git itself is missing", async () => {
    const runner: CliRunner = async () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await repoRootFor("/tmp", runner)).toBeNull();
  });
});

describe("stageStates", () => {
  it("classifies staged, unstaged, and partially staged paths", async () => {
    const runner = runnerFor({
      "git diff --name-only --cached -M": ok("staged.md\nboth.md"),
      "git diff --name-only -M": ok("unstaged.md\nboth.md"),
    });
    const got = await stageStates("/repo", runner);
    expect(got.get("staged.md")).toBe("staged");
    expect(got.get("unstaged.md")).toBe("unstaged");
    expect(got.get("both.md")).toBe("partial");
  });

  it("degrades to empty on failed queries rather than throwing", async () => {
    const runner = runnerFor({
      "git diff --name-only --cached -M": fail("boom"),
      "git diff --name-only -M": fail("boom"),
    });
    expect((await stageStates("/repo", runner)).size).toBe(0);
  });
});

describe("stageFile / unstageFile", () => {
  it("stages via git add and resolves on success", async () => {
    const calls: string[] = [];
    const runner: CliRunner = async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      return ok("");
    };
    await stageFile("/repo", "docs/spec.md", runner);
    expect(calls).toEqual(["git add -- docs/spec.md"]);
  });

  it("unstages via git restore --staged", async () => {
    const calls: string[] = [];
    const runner: CliRunner = async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      return ok("");
    };
    await unstageFile("/repo", "docs/spec.md", runner);
    expect(calls).toEqual(["git restore --staged -- docs/spec.md"]);
  });

  it("surfaces git's stderr when a stage is refused", async () => {
    const runner: CliRunner = async () => fail("fatal: pathspec did not match");
    await expect(stageFile("/repo", "gone.md", runner)).rejects.toThrow(/pathspec/);
    await expect(unstageFile("/repo", "gone.md", runner)).rejects.toThrow(/pathspec/);
  });
});
