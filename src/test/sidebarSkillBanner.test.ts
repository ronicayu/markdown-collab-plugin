// The sidebar's skill banner only means something to someone running Claude
// Code (it says Claude won't know how to act on the comments), so the host
// reports the skill's real status only when `claude` is on the machine — the
// same lookup (and cache) headless availability uses — and "current" (banner
// hidden) otherwise.

import { beforeEach, describe, expect, it, vi } from "vitest";

let skill: "missing" | "outdated" | "current" = "missing";
let claudeFound: Promise<boolean> = Promise.resolve(true);

vi.mock("vscode", () => ({ workspace: {}, window: {}, commands: {}, env: {}, Uri: {} }));
vi.mock("../skill", () => ({ checkClaudeSkill: async () => skill }));
vi.mock("../transports/headlessHost", () => ({ claudeBinaryFound: () => claudeFound }));
vi.mock("../inlineComments/sendToClaude", () => ({ buildInlinePayload: () => null }));
vi.mock("../sendToClaude", () => ({ mcpToolsDirective: () => "" }));

async function posted(): Promise<unknown[]> {
  const { postSkillStatus } = await import("../collab/sidebarHost");
  const out: unknown[] = [];
  await postSkillStatus((m) => out.push(m));
  return out;
}

describe("postSkillStatus", () => {
  beforeEach(() => {
    skill = "missing";
    claudeFound = Promise.resolve(true);
  });

  it("shows the banner when Claude Code is found and the skill is missing", async () => {
    expect(await posted()).toEqual([{ type: "skill-status", status: "missing" }]);
  });

  it("shows the banner when Claude Code is found and the skill is outdated", async () => {
    skill = "outdated";
    expect(await posted()).toEqual([{ type: "skill-status", status: "outdated" }]);
  });

  it("hides the banner when Claude Code is not found, even though the skill is missing", async () => {
    claudeFound = Promise.resolve(false);
    expect(await posted()).toEqual([{ type: "skill-status", status: "current" }]);
  });

  it("hides the banner when the binary lookup itself fails", async () => {
    claudeFound = Promise.reject(new Error("spawn blew up"));
    expect(await posted()).toEqual([{ type: "skill-status", status: "current" }]);
  });

  it("posts only once a cold lookup settles — it never holds anything else up", async () => {
    let release!: (found: boolean) => void;
    claudeFound = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const { postSkillStatus } = await import("../collab/sidebarHost");
    const out: unknown[] = [];
    const pending = postSkillStatus((m) => out.push(m));
    await Promise.resolve();
    expect(out).toEqual([]);
    release(true);
    await pending;
    expect(out).toEqual([{ type: "skill-status", status: "missing" }]);
  });
});
