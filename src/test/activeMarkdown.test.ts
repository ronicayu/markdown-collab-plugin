import { afterEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activeMarkdownUri } from "../activeMarkdown";

const REVIEW_VIEW = "markdownCollab.collabEditor";
const window = vscode.window as unknown as {
  activeTextEditor: unknown;
  tabGroups: { all: unknown[]; activeTabGroup: unknown };
};

const file = (p: string): vscode.Uri => vscode.Uri.file(p);
const editorOn = (p: string, languageId: string): unknown => ({ document: { uri: file(p), languageId } });
const group = (input?: unknown): unknown => ({ activeTab: input === undefined ? undefined : { input } });
const webview = { viewType: "mainThreadWebview-walkthrough" };

function layout(active: unknown, others: unknown[] = []): void {
  window.tabGroups = { all: [active, ...others], activeTabGroup: active };
}

describe("activeMarkdownUri", () => {
  afterEach(() => {
    window.activeTextEditor = undefined;
    layout(group());
  });

  it("returns the active text editor's document when it is Markdown", () => {
    window.activeTextEditor = editorOn("/w/a.md", "markdown");
    layout(group(new vscode.TabInputText(file("/w/b.md"))));

    expect(activeMarkdownUri()?.fsPath).toBe("/w/a.md");
  });

  it("returns the review view's file when no text editor is active", () => {
    layout(group(new vscode.TabInputCustom(file("/w/a.md"), REVIEW_VIEW)));

    expect(activeMarkdownUri()?.fsPath).toBe("/w/a.md");
  });

  it("returns the modified side of a diff tab", () => {
    layout(group(new vscode.TabInputTextDiff(file("/w/a.md"), file("/w/b.md"))));

    expect(activeMarkdownUri()?.fsPath).toBe("/w/b.md");
  });

  it("returns the review view's file when the active text editor is on a non-Markdown file", () => {
    window.activeTextEditor = editorOn("/w/notes.ts", "typescript");
    layout(group(new vscode.TabInputCustom(file("/w/a.md"), REVIEW_VIEW)));

    expect(activeMarkdownUri()?.fsPath).toBe("/w/a.md");
  });

  it("returns nothing when the active tab is a non-Markdown file, even if another group shows Markdown", () => {
    window.activeTextEditor = editorOn("/w/notes.ts", "typescript");
    layout(group(new vscode.TabInputText(file("/w/notes.ts"))), [
      group(new vscode.TabInputText(file("/w/a.md"))),
    ]);

    expect(activeMarkdownUri()).toBeUndefined();
  });

  it("returns the one Markdown file in the other groups when focus is on a non-document tab", () => {
    layout(group(webview), [
      group(new vscode.TabInputCustom(file("/w/a.md"), REVIEW_VIEW)),
      group(new vscode.TabInputText(file("/w/notes.ts"))),
    ]);

    expect(activeMarkdownUri()?.fsPath).toBe("/w/a.md");
  });

  it("counts a file shown in two other groups once", () => {
    layout(group(webview), [
      group(new vscode.TabInputCustom(file("/w/a.md"), REVIEW_VIEW)),
      group(new vscode.TabInputText(file("/w/a.md"))),
    ]);

    expect(activeMarkdownUri()?.fsPath).toBe("/w/a.md");
  });

  it("returns nothing when the other groups show two different Markdown files", () => {
    layout(group(webview), [
      group(new vscode.TabInputText(file("/w/a.md"))),
      group(new vscode.TabInputCustom(file("/w/b.md"), REVIEW_VIEW)),
    ]);

    expect(activeMarkdownUri()).toBeUndefined();
  });

  it("returns nothing when no tab shows Markdown", () => {
    layout(group(webview), [group(new vscode.TabInputText(file("/w/notes.ts"))), group()]);

    expect(activeMarkdownUri()).toBeUndefined();
  });

  it("returns nothing when there are no tabs at all", () => {
    layout(group());

    expect(activeMarkdownUri()).toBeUndefined();
  });
});
