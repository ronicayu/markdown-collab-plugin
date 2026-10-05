import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { registerSetupCommands } from "../commands/setup";

const URL = "http://127.0.0.1:51234/mcp";
const TOKEN = "cafe".repeat(16);

vi.mock("../mcpServer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcpServer")>()),
  currentMcpServer: () => ({ url: URL, token: TOKEN, port: 51234 }),
}));

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;

describe("Connect an Agent → Windsurf (Cascade)", () => {
  const handlers = new Map<string, () => Promise<void>>();
  let workspaceDir: string;
  let homeDir: string;
  let previousHome: string | undefined;
  let ask: Mock<any[], any>;
  let openTextDocument: Mock<any[], any>;
  let toasts: string[];

  beforeEach(() => {
    handlers.clear();
    workspaceDir = mkdtempSync(path.join(tmpdir(), "mc-windsurf-ws-"));
    homeDir = mkdtempSync(path.join(tmpdir(), "mc-windsurf-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    toasts = [];
    ask = vi.fn(async (_message: string, ...actions: string[]) => actions[0]);
    openTextDocument = vi.fn(async () => ({}));
    ws.isTrusted = true;
    ws.workspaceFolders = [{ uri: vscode.Uri.file(workspaceDir), name: "ws", index: 0 }];
    ws.openTextDocument = openTextDocument;
    win.showQuickPick = vi.fn(async (items: Array<{ id: string }>) => items.find((i) => i.id === "windsurf"));
    win.showInformationMessage = (message: string, ...actions: string[]) => {
      toasts.push(message);
      return actions.length ? ask(message, ...actions) : Promise.resolve(undefined);
    };
    win.showTextDocument = vi.fn(async () => undefined);
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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes AGENTS.md, and on yes opens the Windsurf scratch document with the url, token and config path", async () => {
    await handlers.get("markdownCollab.connectAgent")!();

    expect(readdirSync(workspaceDir)).toEqual(["AGENTS.md"]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toMatch(/AGENTS\.md/);
    expect(ask.mock.calls[0]![0]).toMatch(/Windsurf/);

    expect(openTextDocument).toHaveBeenCalledTimes(1);
    const content = openTextDocument.mock.calls[0]![0].content as string;
    expect(content).toContain('"serverUrl"');
    expect(content).toContain(URL);
    expect(content).toContain(`Bearer ${TOKEN}`);
    expect(content).toContain("~/.codeium/windsurf/mcp_config.json");
    expect(content).toContain("have not been verified against a real Windsurf install");
  });

  it("writes nothing under the home directory", async () => {
    await handlers.get("markdownCollab.connectAgent")!();
    expect(readdirSync(homeDir)).toEqual([]);
  });

  it("does not open the scratch document when the question is declined", async () => {
    ask.mockImplementation(async () => "Not now");
    await handlers.get("markdownCollab.connectAgent")!();
    expect(readdirSync(workspaceDir)).toEqual(["AGENTS.md"]);
    expect(openTextDocument).not.toHaveBeenCalled();
  });

  it("tells the user the token lives only in this session", async () => {
    await handlers.get("markdownCollab.connectAgent")!();
    expect(toasts.at(-1)).toMatch(/Windsurf/);
    expect(toasts.at(-1)).toMatch(/don't save this document/);
  });
});
