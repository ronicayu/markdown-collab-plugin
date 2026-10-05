import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Logger } from "../logging";

const install = vi.hoisted(() => vi.fn());

vi.mock("../skill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skill")>()),
  installClaudeSkill: install,
}));

import { installLegacySkillSummary } from "../commands/setup";

const log = { error: vi.fn() } as unknown as Logger;
const SKILL_PATH = "/home/u/.claude/skills/vs-markdown-collab/SKILL.md";
const REASON = "no plugin commands";

const warn = vi.spyOn(vscode.window, "showWarningMessage");

beforeEach(() => {
  install.mockReset();
  warn.mockReset();
});

describe("installLegacySkillSummary", () => {
  it("says an earlier skill was updated, without a warning", async () => {
    install.mockResolvedValue({ action: "updated", path: SKILL_PATH });
    expect(await installLegacySkillSummary(log, REASON)).toBe(
      `Markdown Collab skill updated at ${SKILL_PATH} (the Claude Code plugin wasn't used: ${REASON}).`,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("says a fresh skill was installed", async () => {
    install.mockResolvedValue({ action: "installed", path: SKILL_PATH });
    expect(await installLegacySkillSummary(log, REASON)).toBe(
      `Markdown Collab skill installed at ${SKILL_PATH} (the Claude Code plugin wasn't used: ${REASON}).`,
    );
  });

  it("warns about a conflicting skill without mentioning the plugin", async () => {
    install.mockResolvedValue({ action: "exists-differs", path: SKILL_PATH });
    warn.mockResolvedValue("Cancel" as never);
    expect(await installLegacySkillSummary(log, REASON)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      `A different Markdown Collab skill already exists at ${SKILL_PATH}.`,
      "Overwrite",
      "Cancel",
    );
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("overwrites a conflicting skill when the user chooses Overwrite", async () => {
    install
      .mockResolvedValueOnce({ action: "exists-differs", path: SKILL_PATH })
      .mockResolvedValueOnce({ action: "installed", path: SKILL_PATH });
    warn.mockResolvedValue("Overwrite" as never);
    expect(await installLegacySkillSummary(log, REASON)).toBe(`Markdown Collab skill overwritten at ${SKILL_PATH}.`);
    expect(install).toHaveBeenLastCalledWith(expect.any(String), { force: true });
  });
});
