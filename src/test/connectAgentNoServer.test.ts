import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerSetupCommands } from "../commands/setup";

vi.mock("../mcpServer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcpServer")>()),
  currentMcpServer: () => null,
}));

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;

const OPEN_A_FOLDER = "Markdown Collab: open a folder first — the review tools need a workspace.";
const RELOAD =
  "Markdown Collab: the review tool server isn't running — reload the window and try again. See the Markdown Collab output channel.";

describe("Connect an Agent when the tool server is not running", () => {
  const handlers = new Map<string, () => Promise<void>>();
  const warnings: string[] = [];

  beforeEach(() => {
    handlers.clear();
    warnings.length = 0;
    ws.isTrusted = true;
    ws.workspaceFolders = undefined;
    win.showWarningMessage = async (m: string) => void warnings.push(m);
    win.showQuickPick = async () => ({ id: "claude" });
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

  it("asks for a folder when Claude Code is picked in a window with none", async () => {
    await handlers.get("markdownCollab.connectAgent")!();
    expect(warnings).toEqual([OPEN_A_FOLDER]);
  });

  it("asks for a folder when the tools are registered in a window with none", async () => {
    await handlers.get("markdownCollab.registerMcpServer")!();
    expect(warnings).toEqual([OPEN_A_FOLDER]);
  });

  it("still advises a reload when a folder is open", async () => {
    ws.workspaceFolders = [{ uri: vscode.Uri.file("/ws"), name: "ws", index: 0 }];
    await handlers.get("markdownCollab.connectAgent")!();
    expect(warnings).toEqual([RELOAD]);
  });

  it("still advises a reload when the tools are registered with a folder open", async () => {
    ws.workspaceFolders = [{ uri: vscode.Uri.file("/ws"), name: "ws", index: 0 }];
    await handlers.get("markdownCollab.registerMcpServer")!();
    expect(warnings).toEqual([RELOAD]);
  });
});
