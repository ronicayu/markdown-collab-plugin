import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ENV_TOKEN, ENV_URL } from "../mcpServer/registration";
import { startMcpServer } from "../mcpServer";

describe("startMcpServer in Restricted Mode", () => {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-restricted-"));
    ws.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: "ws", index: 0 }];
    ws.isTrusted = false;
  });

  afterEach(() => {
    ws.isTrusted = true;
    ws.workspaceFolders = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null and touches nothing", async () => {
    const replace = vi.fn();
    const context = { environmentVariableCollection: { replace }, extension: { packageJSON: {} } };
    const envBefore = { url: process.env[ENV_URL], token: process.env[ENV_TOKEN] };

    expect(await startMcpServer(context as never, { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never })).toBeNull();

    expect(replace).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    expect({ url: process.env[ENV_URL], token: process.env[ENV_TOKEN] }).toEqual(envBefore);
  });
});
