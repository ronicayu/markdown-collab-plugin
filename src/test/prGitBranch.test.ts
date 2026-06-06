import { describe, it, expect } from "vitest";
import { currentBranch, defaultBranch } from "../pr/diff";
import type { CliRunner } from "../pr/cli";

/** A CliRunner stub that returns canned output and records the git args it saw. */
function stubRunner(
  result: { stdout?: string; stderr?: string; code?: number },
  sink?: string[][],
): CliRunner {
  return async (_bin, args) => {
    sink?.push(args);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
  };
}

describe("currentBranch", () => {
  it("returns the trimmed branch name and calls the right git command", async () => {
    const calls: string[][] = [];
    const branch = await currentBranch("/repo", stubRunner({ stdout: "feature/x\n" }, calls));
    expect(branch).toBe("feature/x");
    expect(calls[0]).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
  });

  it("returns HEAD for a detached checkout", async () => {
    expect(await currentBranch("/repo", stubRunner({ stdout: "HEAD\n" }))).toBe("HEAD");
  });

  it("throws when git fails", async () => {
    await expect(
      currentBranch("/repo", stubRunner({ code: 128, stderr: "not a git repo" })),
    ).rejects.toThrow(/abbrev-ref/);
  });
});

describe("defaultBranch", () => {
  it("parses origin/HEAD into the branch name", async () => {
    const calls: string[][] = [];
    const def = await defaultBranch(
      "/repo",
      stubRunner({ stdout: "refs/remotes/origin/main\n" }, calls),
    );
    expect(def).toBe("main");
    expect(calls[0]).toEqual(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  });

  it("preserves slashes in the default branch name", async () => {
    const def = await defaultBranch(
      "/repo",
      stubRunner({ stdout: "refs/remotes/origin/release/2.0\n" }),
    );
    expect(def).toBe("release/2.0");
  });

  it("returns null when origin/HEAD is unset (non-zero exit)", async () => {
    expect(await defaultBranch("/repo", stubRunner({ code: 1 }))).toBeNull();
  });
});
