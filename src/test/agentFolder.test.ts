import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { maybePromptSkillUpdate, registerSetupCommands } from "../commands/setup";
import { ensureMcpJsonRegistration, mcpJsonConsentGranted } from "../mcpServer";
import { isAgentConnected, markAgentConnected, reconnectAgents } from "../mcpServer/agentConnections";
import { lookupClaude } from "../transports/headlessHost";
import { agentFolder } from "../workspaceFolder";

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

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;
const uriApi = vscode.Uri as unknown as Record<string, unknown>;

const handle = { url: "http://127.0.0.1:51234/mcp", token: "t", port: 51234 } as never;
const ADD = "Add to .mcp.json";

describe("agent config in a multi-root window", () => {
  const handlers = new Map<string, () => Promise<void>>();
  let first: string;
  let second: string;
  let store: Map<string, unknown>;
  let context: vscode.ExtensionContext;
  let folderPicks: Mock<any[], any>;
  let chooseFolder: number | undefined;
  let agent: string;
  let consent: string;
  let log: Record<string, unknown>;

  const folderOf = (dir: string) => ({ uri: vscode.Uri.file(dir), name: path.basename(dir), index: 0 });
  const setFolders = (...dirs: string[]) => {
    ws.workspaceFolders = dirs.map((d, index) => ({ ...folderOf(d), index }));
  };
  const activeFileIn = (dir: string | undefined) => {
    (win as { activeTextEditor: unknown }).activeTextEditor = dir
      ? { document: { uri: vscode.Uri.file(path.join(dir, "notes.md")) } }
      : undefined;
  };
  const run = (id: string) => handlers.get(id)!();

  beforeEach(() => {
    handlers.clear();
    home.dir = mkdtempSync(path.join(nodeOs.tmpdir(), "mc-af-home-"));
    first = mkdtempSync(path.join(nodeOs.tmpdir(), "mc-af-one-"));
    second = mkdtempSync(path.join(nodeOs.tmpdir(), "mc-af-two-"));
    store = new Map();
    agent = "codex";
    consent = ADD;
    folderPicks = vi.fn();
    chooseFolder = undefined;
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
    log.scope = () => log;
    context = {
      subscriptions: [],
      extensionPath: "/x",
      globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
      workspaceState: {
        get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
        update: async (k: string, v: unknown) => void (v === undefined ? store.delete(k) : store.set(k, v)),
        keys: () => [...store.keys()],
      },
    } as never;

    ws.isTrusted = true;
    ws.getWorkspaceFolder = (u: { fsPath: string }) =>
      (ws.workspaceFolders as Array<{ uri: { fsPath: string } }> | undefined)?.find((f) =>
        u.fsPath.startsWith(f.uri.fsPath + path.sep),
      );
    ws.openTextDocument = async () => ({});
    ws.fs = {
      readFile: async (u: { fsPath: string }) => readFileSync(u.fsPath),
      writeFile: async (u: { fsPath: string }, data: Uint8Array) => writeFileSync(u.fsPath, data),
      createDirectory: async (u: { fsPath: string }) => void mkdirSync(u.fsPath, { recursive: true }),
    };
    uriApi.joinPath = (base: { fsPath: string }, ...parts: string[]) => vscode.Uri.file(path.join(base.fsPath, ...parts));
    mkdirSync(path.join(home.dir, ".claude"));
    vi.mocked(lookupClaude).mockReset().mockResolvedValue({ ok: false, error: "not on PATH" });
    win.showQuickPick = vi.fn(async (items: Array<{ id?: string; folder?: unknown; label: string }>) => {
      if (items.some((i) => i.folder)) {
        folderPicks(items.map((i) => i.label));
        return chooseFolder === undefined ? undefined : items[chooseFolder];
      }
      return items.find((i) => i.id === agent);
    });
    win.showInformationMessage = vi.fn(async (message: string, ...actions: string[]) => {
      if (message.includes("Let Claude Code call")) return consent;
      return actions[0];
    });
    win.showWarningMessage = vi.fn(async () => undefined);
    win.showErrorMessage = vi.fn(async () => undefined);
    cmds.registerCommand = (id: string, fn: () => Promise<void>) => {
      handlers.set(id, fn);
      return { dispose: () => undefined };
    };
    activeFileIn(undefined);
    registerSetupCommands({ context, rootLog: log, log, skillLog: log, reviewLog: log } as never);
  });

  afterEach(() => {
    for (const d of [home.dir, first, second]) rmSync(d, { recursive: true, force: true });
    ws.workspaceFolders = undefined;
    activeFileIn(undefined);
  });

  const codexToml = (dir: string) => path.join(dir, ".codex", "config.toml");
  const agentsMd = (dir: string) => path.join(dir, "AGENTS.md");

  it("connects in the only folder without asking which one and stores no folder key", async () => {
    setFolders(first);

    await run("markdownCollab.connectAgent");

    expect(folderPicks).not.toHaveBeenCalled();
    expect(existsSync(agentsMd(first))).toBe(true);
    expect(existsSync(codexToml(first))).toBe(true);
    expect([...store.keys()]).toEqual([]);
  });

  it("keeps the connected-agents and consent keys of a single-root window exactly as before", async () => {
    setFolders(first);
    const uri = `file://${first}`;

    await markAgentConnected(context, "copilot");
    agent = "claude";
    await run("markdownCollab.connectAgent");

    expect([...store.keys()].sort()).toEqual(
      [`markdownCollab.connectedAgents:${uri}`, `markdownCollab.mcpJsonConsent:${uri}`].sort(),
    );
    expect(store.get(`markdownCollab.connectedAgents:${uri}`)).toEqual(["copilot"]);
    expect(store.get(`markdownCollab.mcpJsonConsent:${uri}`)).toBe("yes");
  });

  it("writes AGENTS.md and the Codex config in the folder of the active file, and nothing in the other", async () => {
    setFolders(first, second);
    activeFileIn(second);

    await run("markdownCollab.connectAgent");

    expect(folderPicks).not.toHaveBeenCalled();
    expect(existsSync(agentsMd(second))).toBe(true);
    expect(existsSync(codexToml(second))).toBe(true);
    expect(existsSync(agentsMd(first))).toBe(false);
    expect(existsSync(path.join(first, ".codex"))).toBe(false);
  });

  it("asks which folder when no file is active, and writes in the one chosen", async () => {
    setFolders(first, second);
    chooseFolder = 1;

    await run("markdownCollab.connectAgent");

    expect(folderPicks).toHaveBeenCalledTimes(1);
    expect(existsSync(codexToml(second))).toBe(true);
    expect(existsSync(agentsMd(first))).toBe(false);
  });

  it("writes nothing when the folder question is cancelled", async () => {
    setFolders(first, second);

    await run("markdownCollab.connectAgent");

    expect(folderPicks).toHaveBeenCalledTimes(1);
    expect(existsSync(agentsMd(first))).toBe(false);
    expect(existsSync(agentsMd(second))).toBe(false);
    expect([...store.keys()]).toEqual([]);
    expect(win.showQuickPick).toHaveBeenCalledTimes(1);
  });

  describe("after connecting Codex in the second folder", () => {
    beforeEach(async () => {
      setFolders(first, second);
      activeFileIn(second);
      await run("markdownCollab.connectAgent");
      activeFileIn(undefined);
    });

    it("answers the second folder as the agent folder", () => {
      expect(agentFolder(context)!.uri.fsPath).toBe(second);
    });

    it("removes the Codex table from the second folder on Disconnect", async () => {
      expect(readFileSync(codexToml(second), "utf8")).toContain("markdown-collab");
      mkdirSync(path.join(first, ".codex"));
      const untouched = "[mcp_servers.markdown-collab]\nurl = \"http://127.0.0.1:1/mcp\"\n";
      writeFileSync(codexToml(first), untouched);

      await run("markdownCollab.disconnectAgent");

      expect(readFileSync(codexToml(second), "utf8")).not.toContain("markdown-collab");
      expect(readFileSync(codexToml(first), "utf8")).toBe(untouched);
    });

    it("refreshes the port in the second folder at activation", async () => {
      await reconnectAgents(context, { ...(handle as object), port: 60001 } as never, log as never);

      expect(readFileSync(codexToml(second), "utf8")).toContain(":60001");
    });

    it("registers .mcp.json and keeps the consent in the second folder when Claude Code is connected", async () => {
      agent = "claude";
      activeFileIn(second);

      await run("markdownCollab.connectAgent");

      expect(existsSync(path.join(second, ".mcp.json"))).toBe(true);
      expect(existsSync(path.join(first, ".mcp.json"))).toBe(false);
      expect(store.get(`markdownCollab.mcpJsonConsent:file://${second}`)).toBe("yes");
      expect(mcpJsonConsentGranted(context)).toBe(true);
    });

    it("refreshes .mcp.json in the second folder at activation", async () => {
      agent = "claude";
      activeFileIn(second);
      await run("markdownCollab.connectAgent");

      await ensureMcpJsonRegistration(context, { ...(handle as object), port: 60002 } as never, log as never);

      expect(readFileSync(path.join(second, ".mcp.json"), "utf8")).toContain(":60002");
      expect(existsSync(path.join(first, ".mcp.json"))).toBe(false);
    });

    it("keeps the Copilot connected flag under the second folder", async () => {
      await markAgentConnected(context, "copilot");

      expect(store.get(`markdownCollab.connectedAgents:file://${second}`)).toEqual(["copilot"]);
      expect(store.has(`markdownCollab.connectedAgents:file://${first}`)).toBe(false);
      expect(isAgentConnected(context, "copilot")).toBe(true);
    });

    it("counts as connected for the first-run nudge, because AGENTS.md is in the second folder", async () => {
      const prompt = win.showInformationMessage as Mock<any[], any>;
      const ctx = {
        ...context,
        extension: { packageJSON: { version: "1.0.0" } },
        globalState: { get: (k: string) => (k === "markdownCollab.pluginPromptedVersion" ? "1.0.0" : undefined), update: async () => undefined },
      } as never;
      prompt.mockClear();

      await maybePromptSkillUpdate(ctx, log as never);

      expect(prompt).not.toHaveBeenCalled();
    });
  });

  it("falls back to the first folder when the stored folder is no longer open", async () => {
    setFolders(first, second);
    activeFileIn(second);
    await run("markdownCollab.connectAgent");
    expect(agentFolder(context)!.uri.fsPath).toBe(second);

    setFolders(first);

    expect(agentFolder(context)!.uri.fsPath).toBe(first);
  });

  it("answers the first folder before anything was stored, and nothing without a folder", () => {
    setFolders(first, second);
    expect(agentFolder(context)!.uri.fsPath).toBe(first);

    ws.workspaceFolders = undefined;
    expect(agentFolder(context)).toBeUndefined();
  });
});
