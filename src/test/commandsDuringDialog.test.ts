// A comment command's confirmation dialog can stay open for as long as the
// person likes, and an agent can write the file meanwhile. The command used to
// compute its result from the text read before the dialog and write that over
// the whole document, erasing the agent's change. It now computes in the
// document's write queue, on the file as it is once the dialog closes.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerCommentsCommands } from "../commands/comments";
import { addThread, parse, replaceThread } from "../inlineComments/format";
import { commandDeps, commandHandler } from "./support/commandHarness";

vi.mock("vscode", async () => {
  const base = await (await import("./support/commandHarness")).vscodeForCommands();
  class WorkspaceEdit {
    readonly replacements: Array<{ range: vscode.Range; text: string }> = [];
    replace(_uri: unknown, range: vscode.Range, text: string): void {
      this.replacements.push({ range, text });
    }
  }
  return { ...base, WorkspaceEdit };
});

const TS = "2026-01-01T00:00:00.000Z";
const DOC = "# Guide\n\nAlpha sentence here.\n\nBeta sentence here.\n";

class FakeDocument {
  isDirty = false;
  constructor(
    readonly uri: vscode.Uri,
    public text: string,
  ) {}
  getText(): string {
    return this.text;
  }
  positionAt(offset: number): vscode.Position {
    const before = this.text.slice(0, offset);
    const line = before.split("\n").length - 1;
    return new vscode.Position(line, offset - (before.lastIndexOf("\n") + 1));
  }
  offsetAt(pos: vscode.Position): number {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += lines[i]!.length + 1;
    return offset + pos.character;
  }
  async save(): Promise<boolean> {
    this.isDirty = false;
    return true;
  }
}

const window = vscode.window as unknown as Record<string, unknown>;
const workspace = vscode.workspace as unknown as Record<string, unknown>;
const uri = vscode.Uri.file("/w/notes.md");
let doc: FakeDocument;
/** What the person answers, and what lands in the file while the dialog is up. */
let whileDialogOpen: () => void;
let answer: string;
const infos: string[] = [];

/** `DOC` with a resolved thread on "Alpha". */
function withResolvedThread(): string {
  const at = DOC.indexOf("Alpha");
  const r = addThread(DOC, at, at + 5, { author: "you", body: "done?", ts: TS });
  return replaceThread(r.source, r.thread.id, { ...r.thread, status: "resolved", resolvedBy: "you", resolvedTs: TS });
}

beforeEach(() => {
  infos.length = 0;
  window.activeTextEditor = undefined;
  window.tabGroups = {
    all: [],
    activeTabGroup: { activeTab: { input: new vscode.TabInputCustom(uri, "markdownCollab.collabEditor") } },
  };
  window.showInformationMessage = async (m: string) => void infos.push(m);
  window.showWarningMessage = async () => {
    whileDialogOpen();
    return answer;
  };
  workspace.openTextDocument = async () => doc;
  workspace.applyEdit = async (edit: { replacements: Array<{ range: vscode.Range; text: string }> }) => {
    for (const { range, text } of edit.replacements) {
      const start = doc.offsetAt(range.start);
      const end = doc.offsetAt(range.end);
      doc.text = doc.text.slice(0, start) + text + doc.text.slice(end);
    }
    doc.isDirty = true;
    return true;
  };
  registerCommentsCommands(commandDeps());
});

describe("a change that lands while a command's dialog is open", () => {
  it("survives Remove resolved comments", async () => {
    doc = new FakeDocument(uri, withResolvedThread());
    answer = "Remove";
    // An agent edits the prose and opens a thread of its own meanwhile.
    whileDialogOpen = () => {
      const edited = doc.text.replace("Beta sentence here.", "Beta sentence, revised.");
      const at = edited.indexOf("Beta");
      doc.text = addThread(edited, at, at + 4, { author: "claude", body: "Shorter?", ts: TS }).source;
    };

    await commandHandler(vscode.commands, "markdownCollab.removeResolvedComments")();

    // The agent's thread wraps "Beta" in anchor markers; read the prose without them.
    expect(doc.text.replace(/<!--mc:\/?a:[a-z0-9]+-->/g, "")).toContain("Beta sentence, revised.");
    const threads = parse(doc.text).threads;
    expect(threads.map((t) => t.comments[0]!.body)).toEqual(["Shorter?"]);
    expect(infos).toEqual(["Removed 1 resolved comment. Undo with Cmd+Z."]);
  });

  it("finalizes the file as it is once the dialog closes, keeping the prose edit made meanwhile", async () => {
    doc = new FakeDocument(uri, withResolvedThread());
    answer = "Remove all";
    whileDialogOpen = () => {
      const edited = doc.text.replace("Beta sentence here.", "Beta sentence, revised.");
      const at = edited.indexOf("Beta");
      doc.text = addThread(edited, at, at + 4, { author: "claude", body: "Shorter?", ts: TS }).source;
    };

    await commandHandler(vscode.commands, "markdownCollab.finalizeDocument")();

    // Both threads gone — including the one opened after the dialog described
    // the file — and the agent's prose edit kept.
    expect(doc.text).toBe(DOC.replace("Beta sentence here.", "Beta sentence, revised."));
  });

  it("says so, and writes nothing, when the resolved comments were already removed meanwhile", async () => {
    doc = new FakeDocument(uri, withResolvedThread());
    answer = "Remove";
    whileDialogOpen = () => {
      doc.text = DOC;
    };

    await commandHandler(vscode.commands, "markdownCollab.removeResolvedComments")();

    expect(doc.text).toBe(DOC);
    expect(infos).toEqual(["No resolved comments left in this file — nothing to remove."]);
  });
});
