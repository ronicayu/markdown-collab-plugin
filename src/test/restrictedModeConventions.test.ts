import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerReviewCommands } from "../commands/review";

const ws = vscode.workspace as unknown as Record<string, unknown>;
const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;

describe("editing review conventions in Restricted Mode", () => {
  const handlers = new Map<string, () => Promise<void>>();
  const writeFile = vi.fn();
  const createDirectory = vi.fn();
  const warn = vi.fn(async () => undefined);

  beforeEach(() => {
    handlers.clear();
    writeFile.mockReset();
    createDirectory.mockReset();
    warn.mockClear();
    ws.isTrusted = false;
    ws.workspaceFolders = [{ uri: vscode.Uri.file("/ws"), name: "ws", index: 0 }];
    ws.fs = { writeFile, createDirectory, stat: vi.fn(async () => Promise.reject(new Error("absent"))) };
    win.showWarningMessage = warn;
    cmds.registerCommand = (id: string, fn: () => Promise<void>) => {
      handlers.set(id, fn);
      return { dispose: () => undefined };
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), scope: () => log };
    registerReviewCommands({
      context: { subscriptions: [] },
      reviewLog: log,
      reviewView: {},
      terminalTracker: {},
      openReviewView: vi.fn(),
    } as never);
  });

  afterEach(() => {
    ws.isTrusted = true;
    ws.workspaceFolders = undefined;
  });

  it("writes no conventions file and shows one warning", async () => {
    await handlers.get("markdownCollab.editReviewConventions")!();

    expect(createDirectory).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      "Markdown Collab: Editing review conventions is off in Restricted Mode — trust this workspace to use it.",
      "Manage Workspace Trust",
    ]);
  });
});
