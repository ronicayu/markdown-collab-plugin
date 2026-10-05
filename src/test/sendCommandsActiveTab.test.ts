import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerSendCommands } from "../commands/send";
import { commandDeps, commandHandler } from "./support/commandHarness";

vi.mock("vscode", async () => (await import("./support/commandHarness")).vscodeForCommands());

const window = vscode.window as unknown as Record<string, unknown>;
const workspace = vscode.workspace as unknown as Record<string, unknown>;
const clipboard = vscode.env.clipboard as unknown as { writeText: unknown };

const uri = vscode.Uri.file("/w/notes.md");
const warnings: string[] = [];
const infos: string[] = [];
const copied: string[] = [];
const opened: string[] = [];

describe("send commands with the review view focused", () => {
  beforeEach(() => {
    warnings.length = infos.length = copied.length = opened.length = 0;
    window.activeTextEditor = undefined;
    window.tabGroups = {
      all: [],
      activeTabGroup: {
        activeTab: { input: new vscode.TabInputCustom(uri, "markdownCollab.collabEditor") },
      },
    };
    window.showWarningMessage = async (m: string) => void warnings.push(m);
    window.showInformationMessage = async (m: string) => void infos.push(m);
    clipboard.writeText = async (t: string) => void copied.push(t);
    workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
    workspace.openTextDocument =async (u: vscode.Uri) => {
      opened.push(u.fsPath);
      return { uri: u, getText: () => "# No comments\n" };
    };
    registerSendCommands(commandDeps());
  });

  afterEach(() => {
    window.tabGroups = { all: [], activeTabGroup: { activeTab: undefined } };
  });

  it("copies the prompt for the review view's file when no text editor is active", async () => {
    await commandHandler(vscode.commands, "markdownCollab.copyClaudePrompt")();

    expect(warnings).toEqual([]);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("notes.md");
  });

  it("sends the review view's file when no text editor is active", async () => {
    await commandHandler(vscode.commands, "markdownCollab.sendAllToClaude")();

    expect(warnings).toEqual([]);
    expect(opened).toEqual(["/w/notes.md"]);
    expect(infos).toEqual(["No unresolved comments on this file."]);
  });

  it("prefers the file it is given over the active tab", async () => {
    await commandHandler(vscode.commands, "markdownCollab.sendAllToClaude")(vscode.Uri.file("/w/other.md"));

    expect(opened).toEqual(["/w/other.md"]);
  });

  it("still asks for a Markdown file when nothing Markdown is open", async () => {
    window.tabGroups = { all: [], activeTabGroup: { activeTab: undefined } };

    await commandHandler(vscode.commands, "markdownCollab.sendAllToClaude")();

    expect(warnings).toEqual(["Open a Markdown file first, then run this command."]);
    expect(opened).toEqual([]);
  });
});
