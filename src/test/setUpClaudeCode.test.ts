import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { registerSetupCommands } from "../commands/setup";
import { setUpClaudePlugin } from "../claudePlugin";
import { ensureMcpJsonRegistration } from "../mcpServer";
import { lookupClaude } from "../transports/headlessHost";

const home = vi.hoisted(() => ({ dir: "" }));

vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  homedir: () => home.dir,
}));
vi.mock("../claudePlugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claudePlugin")>()),
  setUpClaudePlugin: vi.fn(),
}));
vi.mock("../transports/headlessHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../transports/headlessHost")>()),
  lookupClaude: vi.fn(),
}));
vi.mock("../mcpServer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcpServer")>()),
  ensureMcpJsonRegistration: vi.fn(),
  currentMcpServer: () => ({ url: "http://127.0.0.1:1/mcp", token: "t", port: 1 }),
}));

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;

const NOT_FOUND =
  "Markdown Collab: Claude Code wasn't found (not on PATH). Install Claude Code, or set markdownCollab.claudePath " +
  `if it's installed where your editor can't see it. Using another agent? Run "Markdown Collab: Connect an Agent".`;

describe("Set Up Claude Code and Connect an Agent when `claude` isn't found", () => {
  const handlers = new Map<string, () => Promise<void>>();
  let warn: Mock<any[], any>;
  let info: Mock<any[], any>;
  let execute: Mock<any[], any>;

  beforeEach(() => {
    home.dir = mkdtempSync(path.join(nodeOs.tmpdir(), "mc-home-"));
    handlers.clear();
    vi.mocked(lookupClaude).mockReset().mockResolvedValue({ ok: false, error: "not on PATH" });
    vi.mocked(setUpClaudePlugin).mockReset();
    vi.mocked(ensureMcpJsonRegistration).mockReset();
    warn = vi.fn(async () => undefined);
    info = vi.fn(async () => undefined);
    execute = vi.fn(async () => undefined);
    ws.isTrusted = true;
    ws.workspaceFolders = [{ uri: vscode.Uri.file("/ws"), name: "ws", index: 0 }];
    win.showWarningMessage = warn;
    win.showInformationMessage = info;
    win.showErrorMessage = vi.fn(async () => undefined);
    win.showQuickPick = vi.fn(async () => ({ id: "claude" }));
    cmds.executeCommand = execute;
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
    rmSync(home.dir, { recursive: true, force: true });
    ws.workspaceFolders = undefined;
  });

  it("writes nothing and warns when Claude Code has never run on this machine", async () => {
    await handlers.get("markdownCollab.installClaudeSkill")!();

    expect(readdirSync(home.dir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(NOT_FOUND, "Connect an Agent");
    expect(info).not.toHaveBeenCalled();
    expect(setUpClaudePlugin).not.toHaveBeenCalled();
  });

  it("runs Connect an Agent when the warning's button is clicked", async () => {
    warn.mockResolvedValueOnce("Connect an Agent");

    await handlers.get("markdownCollab.installClaudeSkill")!();

    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith("markdownCollab.connectAgent"));
  });

  it("installs the standalone skill when ~/.claude exists", async () => {
    mkdirSync(path.join(home.dir, ".claude"));

    await handlers.get("markdownCollab.installClaudeSkill")!();

    expect(existsSync(path.join(home.dir, ".claude", "skills", "vs-markdown-collab", "SKILL.md"))).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain("Markdown Collab skill installed at");
    expect(info.mock.calls[0][0]).toContain("Claude Code wasn't found (not on PATH)");
    expect(warn).not.toHaveBeenCalled();
  });

  it("registers no .mcp.json and warns when Connect an Agent picks Claude Code without it installed", async () => {
    await handlers.get("markdownCollab.connectAgent")!();

    expect(ensureMcpJsonRegistration).not.toHaveBeenCalled();
    expect(readdirSync(home.dir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(NOT_FOUND, "Connect an Agent");
    expect(info).not.toHaveBeenCalled();
  });

  it("still registers .mcp.json from Connect an Agent when ~/.claude exists", async () => {
    mkdirSync(path.join(home.dir, ".claude"));
    vi.mocked(ensureMcpJsonRegistration).mockResolvedValue("registered" as never);

    await handlers.get("markdownCollab.connectAgent")!();

    expect(ensureMcpJsonRegistration).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
