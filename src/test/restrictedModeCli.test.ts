import { afterEach, describe, expect, it, vi } from "vitest";
import { getCliRunner, runCliOrThrow, setCliGate, setCliRunner } from "../pr/cli";
import { repoRootFor } from "../uncommitted/gitUncommitted";

describe("the git, gh and glab gate", () => {
  const stub = vi.fn(async () => ({ stdout: "/repo\n", stderr: "", code: 0 }));
  let allowed = false;

  const install = () => {
    stub.mockClear();
    setCliRunner(stub);
    setCliGate(() => allowed);
  };

  afterEach(() => {
    setCliGate(() => true);
  });

  it("rejects the shared runner without running it while the gate is closed", async () => {
    allowed = false;
    install();
    await expect(getCliRunner()("git", ["status"])).rejects.toThrow("disabled in Restricted Mode");
    expect(stub).not.toHaveBeenCalled();
  });

  it("rejects runCliOrThrow without running it while the gate is closed", async () => {
    allowed = false;
    install();
    await expect(runCliOrThrow("gh", ["pr", "view"])).rejects.toThrow("disabled in Restricted Mode");
    expect(stub).not.toHaveBeenCalled();
  });

  it("finds no repository while the gate is closed, so the tree shows no-repo", async () => {
    allowed = false;
    install();
    expect(await repoRootFor("/repo")).toBeNull();
    expect(stub).not.toHaveBeenCalled();
  });

  it("runs again as soon as the gate opens, without a new runner", async () => {
    allowed = false;
    install();
    const runner = getCliRunner();
    allowed = true;
    expect((await runner("git", ["status"])).code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(1);
  });
});
