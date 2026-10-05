import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerSendCommands } from "../commands/send";
import { commandDeps, commandHandler } from "./support/commandHarness";

vi.mock("vscode", async () => (await import("./support/commandHarness")).vscodeForCommands());

const workspace = vscode.workspace as unknown as Record<string, unknown>;
const window = vscode.window as unknown as Record<string, unknown>;

describe("toggling suggest mode", () => {
  let stored: Record<string, unknown>;
  const updates: Array<{ key: string; value: unknown; target: unknown }> = [];

  beforeEach(() => {
    stored = {};
    updates.length = 0;
    workspace.workspaceFolders = undefined;
    window.showInformationMessage = async () => undefined;
    workspace.getConfiguration = () => ({
      get: (key: string, fallback: unknown) => stored[key] ?? fallback,
      update: async (key: string, value: unknown, target: unknown) => {
        updates.push({ key, value, target });
        stored[key] = value;
      },
    });
    registerSendCommands(commandDeps());
  });

  const toggle = () => commandHandler(vscode.commands, "markdownCollab.toggleSuggestMode")();

  it("writes the workspace setting when a folder is open", async () => {
    workspace.workspaceFolders = [{ uri: vscode.Uri.file("/ws"), name: "ws", index: 0 }];
    await toggle();
    expect(updates).toEqual([
      { key: "proposeEditsAsSuggestions", value: true, target: vscode.ConfigurationTarget.Workspace },
    ]);
  });

  it("writes the user setting when no folder is open", async () => {
    await toggle();
    expect(updates).toEqual([
      { key: "proposeEditsAsSuggestions", value: true, target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("turns back off on the second toggle with no folder open", async () => {
    await toggle();
    await toggle();
    expect(updates.map((u) => u.value)).toEqual([true, false]);
  });
});
