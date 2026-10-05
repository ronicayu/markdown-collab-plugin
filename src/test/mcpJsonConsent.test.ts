import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { ensureMcpJsonRegistration, mcpJsonConsentGranted } from "../mcpServer";

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const uri = vscode.Uri as unknown as Record<string, unknown>;

const handle = { url: "http://127.0.0.1:4321/mcp", token: "t", port: 4321 } as never;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never;
const ADD = "Add to .mcp.json";

describe("the .mcp.json consent prompt", () => {
  let dir: string;
  let store: Map<string, unknown>;
  let context: never;
  let prompt: Mock<any[], any>;

  const mcpJson = () => path.join(dir, ".mcp.json");
  const answers = () => [...store.values()];

  beforeEach(() => {
    dir = mkdtempSync(path.join(nodeOs.tmpdir(), "mc-consent-"));
    store = new Map();
    context = {
      workspaceState: {
        get: (k: string) => store.get(k),
        update: async (k: string, v: unknown) => void (v === undefined ? store.delete(k) : store.set(k, v)),
      },
    } as never;
    prompt = vi.fn(async () => undefined);
    win.showInformationMessage = prompt;
    win.showWarningMessage = vi.fn(async () => undefined);
    ws.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: "ws", index: 0 }];
    uri.joinPath = (base: { fsPath: string }, ...parts: string[]) => vscode.Uri.file(path.join(base.fsPath, ...parts));
    ws.fs = {
      readFile: async (u: { fsPath: string }) => readFileSync(u.fsPath),
      writeFile: async (u: { fsPath: string }, data: Uint8Array) => writeFileSync(u.fsPath, data),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    ws.workspaceFolders = undefined;
  });

  it("asks at activation when Claude Code is on this machine, without mentioning a send mode", async () => {
    await ensureMcpJsonRegistration(context, handle, log, async () => true);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toContain("Let Claude Code call Markdown Collab's review tools directly?");
    expect(prompt.mock.calls[0][0]).not.toMatch(/mode|MCP\./);
    expect(prompt.mock.calls[0].slice(1)).toEqual([ADD, "Not now"]);
  });

  it("neither asks nor stores an answer at activation when Claude Code is not on this machine", async () => {
    const outcome = await ensureMcpJsonRegistration(context, handle, log, async () => false);

    expect(outcome).toBe("declined");
    expect(prompt).not.toHaveBeenCalled();
    expect(answers()).toEqual([]);
  });

  it("asks once Claude Code shows up on a later activation", async () => {
    await ensureMcpJsonRegistration(context, handle, log, async () => false);
    await ensureMcpJsonRegistration(context, handle, log, async () => true);

    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("stores nothing when the prompt is dismissed, and asks again on the next activation", async () => {
    expect(await ensureMcpJsonRegistration(context, handle, log, async () => true)).toBe("declined");
    expect(answers()).toEqual([]);

    await ensureMcpJsonRegistration(context, handle, log, async () => true);

    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("stores no on Not now and does not ask again", async () => {
    prompt.mockResolvedValueOnce("Not now");

    expect(await ensureMcpJsonRegistration(context, handle, log, async () => true)).toBe("declined");
    expect(answers()).toEqual(["no"]);

    await ensureMcpJsonRegistration(context, handle, log, async () => true);

    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("writes the entry and stores yes when accepted", async () => {
    prompt.mockResolvedValueOnce(ADD);

    expect(await ensureMcpJsonRegistration(context, handle, log, async () => true)).toBe("written");

    expect(answers()).toEqual(["yes"]);
    expect(JSON.parse(readFileSync(mcpJson(), "utf8")).mcpServers["markdown-collab"].url).toContain(":4321");
    expect(mcpJsonConsentGranted(context)).toBe(true);
  });

  it("refreshes the port of a remembered yes without asking or checking for Claude Code", async () => {
    prompt.mockResolvedValueOnce(ADD);
    await ensureMcpJsonRegistration(context, handle, log, async () => true);
    prompt.mockClear();
    const gate = vi.fn(async () => false);

    const outcome = await ensureMcpJsonRegistration(context, { ...(handle as object), port: 5555 } as never, log, gate);

    expect(outcome).toBe("written");
    expect(gate).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(mcpJson(), "utf8")).mcpServers["markdown-collab"].url).toContain(":5555");
  });

  it("asks without any gate when called from an explicit command", async () => {
    await ensureMcpJsonRegistration(context, handle, log);

    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
