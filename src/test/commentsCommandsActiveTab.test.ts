import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerCommentsCommands } from "../commands/comments";
import { commandDeps, commandHandler } from "./support/commandHarness";

vi.mock("vscode", async () => (await import("./support/commandHarness")).vscodeForCommands());

const window = vscode.window as unknown as Record<string, unknown>;
const workspace = vscode.workspace as unknown as Record<string, unknown>;

const uri = vscode.Uri.file("/w/notes.md");
const warnings: string[] = [];
const infos: string[] = [];
const opened: string[] = [];

describe("comment commands with the review view focused", () => {
  beforeEach(() => {
    warnings.length = infos.length = opened.length = 0;
    window.activeTextEditor = undefined;
    window.tabGroups = {
      all: [],
      activeTabGroup: {
        activeTab: { input: new vscode.TabInputCustom(uri, "markdownCollab.collabEditor") },
      },
    };
    window.showWarningMessage = async (m: string) => void warnings.push(m);
    window.showInformationMessage = async (m: string) => void infos.push(m);
    workspace.openTextDocument = async (u: vscode.Uri) => {
      opened.push(u.fsPath);
      return { uri: u, getText: () => "# No comments\n" };
    };
    registerCommentsCommands(commandDeps());
  });

  it("removes resolved comments from the review view's file when no text editor is active", async () => {
    await commandHandler(vscode.commands, "markdownCollab.removeResolvedComments")();

    expect(warnings).toEqual([]);
    expect(opened).toEqual(["/w/notes.md"]);
    expect(infos).toEqual(["No resolved comments in this file."]);
  });

  it("finalizes the review view's file when no text editor is active", async () => {
    await commandHandler(vscode.commands, "markdownCollab.finalizeDocument")();

    expect(warnings).toEqual([]);
    expect(opened).toEqual(["/w/notes.md"]);
  });

  it("repairs the anchors of the review view's file when no text editor is active", async () => {
    await commandHandler(vscode.commands, "markdownCollab.repairInlineComments")();

    expect(warnings).toEqual([]);
    expect(opened).toEqual(["/w/notes.md"]);
  });

  it("opens the review view for the review view's file when the palette runs it", async () => {
    const deps = commandDeps() as unknown as { openReviewView: unknown };
    const calls: string[] = [];
    deps.openReviewView = async (u: vscode.Uri) => void calls.push(u.fsPath);
    registerCommentsCommands(deps as never);

    await commandHandler(vscode.commands, "markdownCollab.openInlineCommentsView")();

    expect(warnings).toEqual([]);
    expect(calls).toEqual(["/w/notes.md"]);
  });

  it("still asks for a Markdown file when nothing Markdown is open", async () => {
    window.tabGroups = { all: [], activeTabGroup: { activeTab: undefined } };

    await commandHandler(vscode.commands, "markdownCollab.removeResolvedComments")();

    expect(warnings).toEqual(["Open a Markdown file first, then run this command."]);
  });
});
