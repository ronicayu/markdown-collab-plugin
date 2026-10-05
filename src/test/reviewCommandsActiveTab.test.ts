import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerReviewCommands } from "../commands/review";
import { commandDeps, commandHandler } from "./support/commandHarness";

vi.mock("vscode", async () => (await import("./support/commandHarness")).vscodeForCommands());

const window = vscode.window as unknown as Record<string, unknown>;
const workspace = vscode.workspace as unknown as Record<string, unknown>;

const uri = vscode.Uri.file("/w/notes.md");
const warnings: string[] = [];
const opened: string[] = [];
const shown: string[] = [];

describe("review commands with the review view focused", () => {
  beforeEach(() => {
    warnings.length = opened.length = shown.length = 0;
    window.activeTextEditor = undefined;
    window.tabGroups = {
      all: [],
      activeTabGroup: {
        activeTab: { input: new vscode.TabInputCustom(uri, "markdownCollab.collabEditor") },
      },
    };
    window.showWarningMessage = async (m: string) => void warnings.push(m);
    window.showTextDocument = async (doc: { content?: string }) => void shown.push(doc.content ?? "");
    workspace.fs = { stat: async () => ({ type: 1, size: 10 }) };
    workspace.asRelativePath = (u: vscode.Uri) => u.fsPath;
    workspace.openTextDocument = async (arg: vscode.Uri | { content: string }) => {
      if (arg instanceof vscode.Uri) {
        opened.push(arg.fsPath);
        return { uri: arg, getText: () => "# No comments\n" };
      }
      return arg;
    };
    registerReviewCommands(commandDeps());
  });

  it("summarizes the review view's file when no text editor is active", async () => {
    await commandHandler(vscode.commands, "markdownCollab.reviewSummary")();

    expect(warnings).toEqual([]);
    expect(opened).toEqual(["/w/notes.md"]);
    expect(shown).toHaveLength(1);
  });

  it("warns when nothing Markdown is open", async () => {
    window.tabGroups = { all: [], activeTabGroup: { activeTab: undefined } };

    await commandHandler(vscode.commands, "markdownCollab.reviewSummary")();

    expect(warnings).toEqual(["Open a Markdown file (or select some) first, then run this command."]);
  });
});
