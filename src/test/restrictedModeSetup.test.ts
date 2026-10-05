import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { maybePromptSkillUpdate, registerSetupCommands } from "../commands/setup";
import { ensureAgentsSnippet } from "../agents";
import { installClaudeSkill } from "../skill";
import { setUpClaudePlugin } from "../claudePlugin";
import { ensureMcpJsonRegistration } from "../mcpServer";
import {
  removeClaudeMcpJson,
  removeCodexConfig,
  removeCursorCliConfig,
  writeCodexConfig,
  writeCursorCliConfig,
} from "../mcpServer/agentConnections";

vi.mock("../agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents")>()),
  ensureAgentsSnippet: vi.fn(),
}));
vi.mock("../skill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skill")>()),
  installClaudeSkill: vi.fn(),
  removeLegacySkill: vi.fn(),
}));
vi.mock("../claudePlugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claudePlugin")>()),
  setUpClaudePlugin: vi.fn(),
}));
vi.mock("../mcpServer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcpServer")>()),
  ensureMcpJsonRegistration: vi.fn(),
  currentMcpServer: () => ({ url: "http://127.0.0.1:1/mcp", token: "t", port: 1 }),
}));
vi.mock("../mcpServer/agentConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcpServer/agentConnections")>()),
  writeCursorCliConfig: vi.fn(),
  writeCodexConfig: vi.fn(),
  removeClaudeMcpJson: vi.fn(),
  removeCursorCliConfig: vi.fn(),
  removeCodexConfig: vi.fn(),
}));

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;

describe("setup commands in Restricted Mode", () => {
  const handlers = new Map<string, () => Promise<void>>();
  let warn: Mock<any[], any>;
  let quickPick: Mock<any[], any>;

  const writers = () => [
    ensureAgentsSnippet,
    installClaudeSkill,
    setUpClaudePlugin,
    ensureMcpJsonRegistration,
    writeCursorCliConfig,
    writeCodexConfig,
    removeClaudeMcpJson,
    removeCursorCliConfig,
    removeCodexConfig,
  ];

  beforeEach(() => {
    handlers.clear();
    for (const fn of writers()) vi.mocked(fn).mockReset();
    warn = vi.fn(async () => undefined);
    quickPick = vi.fn(async () => ({ id: "claude" }));
    ws.isTrusted = false;
    ws.workspaceFolders = [{ uri: vscode.Uri.file("/ws"), name: "ws", index: 0 }];
    win.showWarningMessage = warn;
    win.showQuickPick = quickPick;
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
    ws.isTrusted = true;
    ws.workspaceFolders = undefined;
  });

  it.each([
    ["markdownCollab.installClaudeSkill", "Setting up Claude Code"],
    ["markdownCollab.connectAgent", "Connecting an agent"],
    ["markdownCollab.disconnectAgent", "Connecting an agent"],
    ["markdownCollab.initializeAgents", "Writing AGENTS.md"],
    ["markdownCollab.registerMcpServer", "Registering the review tools"],
  ])("%s writes nothing and shows one warning", async (command, what) => {
    await handlers.get(command)!();

    for (const fn of writers()) expect(fn).not.toHaveBeenCalled();
    expect(quickPick).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      `Markdown Collab: ${what} is off in Restricted Mode — trust this workspace to use it.`,
    );
  });

  it("offers to open the Workspace Trust editor and runs it when asked", async () => {
    const execute = vi.fn(async () => undefined);
    cmds.executeCommand = execute;
    warn.mockResolvedValueOnce("Manage Workspace Trust");

    await handlers.get("markdownCollab.connectAgent")!();

    expect(warn.mock.calls[0][1]).toBe("Manage Workspace Trust");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith("workbench.trust.manage"));
  });

  it("leaves the startup skill check's remembered answer alone", async () => {
    const update = vi.fn(async () => undefined);
    const context = { extension: { packageJSON: { version: "1.0.0" } }, globalState: { get: () => undefined, update } };

    await maybePromptSkillUpdate(context as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never);

    expect(update).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("writes no playground document and shows one warning", async () => {
    const writeFile = vi.fn();
    ws.fs = { writeFile, stat: vi.fn(), createDirectory: vi.fn() };

    await handlers.get("markdownCollab.openTutorial")!();

    expect(writeFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "Markdown Collab: The playground is off in Restricted Mode — trust this workspace to use it.",
    );
  });
});
