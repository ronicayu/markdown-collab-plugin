import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { AGENTS_SKILL_CONTENT, AGENTS_SKILL_REL_PATH } from "../agentsSkill";
import { AGENTS_SNIPPET } from "../agents";
import { registerSetupCommands } from "../commands/setup";
import { lookupClaude } from "../transports/headlessHost";

const home = vi.hoisted(() => ({ dir: "" }));

vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  homedir: () => home.dir,
}));
vi.mock("../transports/headlessHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../transports/headlessHost")>()),
  lookupClaude: vi.fn(),
}));
vi.mock("../mcpServer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcpServer")>()),
  currentMcpServer: () => ({ url: "http://127.0.0.1:51234/mcp", token: "t", port: 51234 }),
}));
vi.mock("../mcpServer/agentConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcpServer/agentConnections")>()),
  hasCursorInAppApi: () => true,
}));

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;

describe("Connect an Agent installs the review skill for the agents that read ~/.agents/skills", () => {
  const handlers = new Map<string, () => Promise<void>>();
  let workspaceDir: string;
  let homeDir: string;
  let agent: string;
  let ask: Mock<any[], any>;
  let toasts: string[];
  let pickerItems: Array<{ id: string; description: string }>;

  const skillFile = () => path.join(homeDir, AGENTS_SKILL_REL_PATH);

  beforeEach(() => {
    handlers.clear();
    workspaceDir = mkdtempSync(path.join(tmpdir(), "mc-skill-ws-"));
    homeDir = mkdtempSync(path.join(tmpdir(), "mc-skill-home-"));
    home.dir = homeDir;
    mkdirSync(path.join(homeDir, ".claude"));
    vi.mocked(lookupClaude).mockReset().mockResolvedValue({ ok: false, error: "not on PATH" });
    toasts = [];
    agent = "codex";
    ask = vi.fn(async () => "Not now");
    (vscode.Uri as unknown as Record<string, unknown>).joinPath = (base: { fsPath: string }, ...parts: string[]) =>
      vscode.Uri.file(path.join(base.fsPath, ...parts));
    ws.isTrusted = true;
    ws.workspaceFolders = [{ uri: vscode.Uri.file(workspaceDir), name: "ws", index: 0 }];
    win.showQuickPick = vi.fn(async (items: Array<{ id: string; description: string }>) => {
      pickerItems = items;
      return items.find((i) => i.id === agent);
    });
    win.showInformationMessage = (message: string, ...actions: string[]) => {
      toasts.push(message);
      return actions.length ? ask(message, ...actions) : Promise.resolve(undefined);
    };
    win.showWarningMessage = vi.fn(async () => undefined);
    win.showErrorMessage = vi.fn(async () => undefined);
    cmds.registerCommand = (id: string, fn: () => Promise<void>) => {
      handlers.set(id, fn);
      return { dispose: () => undefined };
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), scope: () => log };
    registerSetupCommands({
      context: {
        subscriptions: [],
        extensionPath: "/x",
        globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
        workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
      },
      rootLog: log,
      log,
      skillLog: log,
      reviewLog: log,
    } as never);
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it.each(["codex", "cursor-inapp"])("%s: writes AGENTS.md and the skill, and says both in the one question", async (id) => {
    agent = id;

    await handlers.get("markdownCollab.connectAgent")!();

    expect(readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf8")).toBe(AGENTS_SNIPPET);
    expect(readFileSync(skillFile(), "utf8")).toBe(AGENTS_SKILL_CONTENT);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/Created AGENTS\.md in ws with the review-comment format\. Added the review skill to ~\/\.agents\/skills\. Also register/);
    expect(toasts[0]).not.toContain(homeDir);
  });

  it("says the skill is up to date when Connect runs a second time", async () => {
    await handlers.get("markdownCollab.connectAgent")!();
    toasts.length = 0;

    await handlers.get("markdownCollab.connectAgent")!();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("already has the review-comment format. The review skill in ~/.agents/skills is up to date.");
  });

  it("updates an earlier copy of the skill and says so", async () => {
    mkdirSync(path.dirname(skillFile()), { recursive: true });
    writeFileSync(skillFile(), "---\nname: markdown-collab\ndescription: older\n---\n", "utf8");

    await handlers.get("markdownCollab.connectAgent")!();

    expect(readFileSync(skillFile(), "utf8")).toBe(AGENTS_SKILL_CONTENT);
    expect(toasts[0]).toContain("Updated the review skill in ~/.agents/skills.");
  });

  it("leaves someone else's skill at that path alone, says so, and still carries on with Connect", async () => {
    const foreign = "---\nname: my-own-skill\ndescription: mine\n---\n";
    mkdirSync(path.dirname(skillFile()), { recursive: true });
    writeFileSync(skillFile(), foreign, "utf8");

    await handlers.get("markdownCollab.connectAgent")!();

    expect(readFileSync(skillFile(), "utf8")).toBe(foreign);
    expect(existsSync(path.join(workspaceDir, "AGENTS.md"))).toBe(true);
    expect(toasts[0]).toContain("~/.agents/skills/markdown-collab/SKILL.md is a different skill — left as is.");
    expect(toasts[0]).toContain("Also register");
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked skills directory, says so, and still carries on with Connect", async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "mc-skill-else-"));
    try {
      mkdirSync(path.join(homeDir, ".agents"));
      symlinkSync(elsewhere, path.join(homeDir, ".agents", "skills"));

      await handlers.get("markdownCollab.connectAgent")!();

      expect(readdirSync(elsewhere)).toEqual([]);
      expect(existsSync(path.join(workspaceDir, "AGENTS.md"))).toBe(true);
      expect(toasts[0]).toContain("The review skill wasn't written: ~/.agents/skills is a symlink — left as is.");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not install the skill when Claude Code is the agent", async () => {
    agent = "claude";

    await handlers.get("markdownCollab.connectAgent")!();

    expect(existsSync(path.join(homeDir, ".agents"))).toBe(false);
  });

  it("does not install the skill when Initialize AGENTS.md runs on its own", async () => {
    await handlers.get("markdownCollab.initializeAgents")!();

    expect(existsSync(path.join(workspaceDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(homeDir, ".agents"))).toBe(false);
  });

  it("names the review skill in every picker entry but Claude Code's", async () => {
    await handlers.get("markdownCollab.connectAgent")!();

    const others = pickerItems.filter((i) => i.id !== "claude");
    expect(others.map((i) => i.id)).toEqual(["cursor-inapp", "cursor-cli", "windsurf", "codex", "other"]);
    for (const item of others) expect(item.description, item.id).toContain("the review skill (~/.agents/skills)");
  });

  it("Disconnect leaves the skill in place and says so", async () => {
    await handlers.get("markdownCollab.connectAgent")!();
    agent = "windsurf";

    await handlers.get("markdownCollab.disconnectAgent")!();

    expect(existsSync(skillFile())).toBe(true);
    expect(toasts.at(-1)).toContain("AGENTS.md and the review skill in ~/.agents/skills are left as is.");
  });
});
