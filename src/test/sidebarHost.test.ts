// The live editor sidebar's host half (10x-plan-6 P4): which messages it
// claims from the provider, and that each one runs the review view's operation
// on the file's own source — never on anything the editor serialized.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { addSuggestion, addThread, appendReply, parse, replaceThread } from "../inlineComments/format";
import { handleSidebarMessage, isSidebarMessage, type SidebarHostContext } from "../collab/sidebarHost";
import type { SidebarMessage } from "../webviewShared/sidebarProtocol";

const TS = "2026-01-01T00:00:00.000Z";
const DOC = "# Doc\n\nAlpha sentence.\n\nBeta sentence.\n";

/** A document with one answered thread on "Alpha" and a suggestion on "Beta". */
function reviewed(): { source: string; threadId: string } {
  const at = DOC.indexOf("Alpha");
  const first = addThread(DOC, at, at + 5, { author: "ronica", body: "Why?", ts: TS });
  const withReply = replaceThread(
    first.source,
    first.thread.id,
    appendReply(first.thread, { author: "claude", body: "Because.", ts: TS, agent: true }),
  );
  const b = withReply.indexOf("Beta");
  const source = addSuggestion(withReply, b, b + 4, { author: "claude", proposed: "Gamma", ts: TS }).source;
  return { source, threadId: first.thread.id };
}

interface FakeHost {
  ctx: SidebarHostContext;
  written: string[];
  calls: string[];
}

function fakeHost(source: string): FakeHost {
  const written: string[] = [];
  const calls: string[] = [];
  let text = source;
  const ctx: SidebarHostContext = {
    document: { uri: vscode.Uri.file("/w/doc.md"), getText: () => text } as unknown as vscode.TextDocument,
    applySource: async (next) => {
      written.push(next);
      text = next;
      return true;
    },
    flush: async () => {
      calls.push("flush");
    },
    refresh: () => calls.push("refresh"),
    post: (msg) => calls.push(`post:${(msg as { type: string }).type}`),
  };
  return { ctx, written, calls };
}

beforeEach(() => {
  (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key === "collab.userName" ? "ronica" : fallback),
  });
});

describe("isSidebarMessage", () => {
  it.each<[string, unknown, boolean]>([
    ["reply", { type: "reply", threadId: "t1", body: "x" }, true],
    ["edit-comment", { type: "edit-comment", threadId: "t1", commentId: "c1", body: "x" }, true],
    ["toggle-resolve", { type: "toggle-resolve", threadId: "t1" }, true],
    ["delete-thread", { type: "delete-thread", threadId: "t1" }, true],
    ["delete-comment with its thread", { type: "delete-comment", threadId: "t1", commentId: "c1" }, true],
    ["accept-all-suggestions", { type: "accept-all-suggestions" }, true],
    ["send-to-claude", { type: "send-to-claude" }, true],
    ["open-in-editor", { type: "open-in-editor", threadId: "t1" }, true],
    ["empty-state-review", { type: "empty-state-review" }, true],
    // The older live-editor message of the same name deletes a whole thread
    // by `commentId` — it stays with the provider.
    ["the older delete-comment", { type: "delete-comment", commentId: "t1" }, false],
    // The provider has always handled these two, with the same result.
    ["accept-suggestion", { type: "accept-suggestion", anchorId: "s1" }, false],
    ["reject-suggestion", { type: "reject-suggestion", anchorId: "s1" }, false],
    // The mode switch rebuilds the editor — the provider's call.
    ["set-read-only", { type: "set-read-only", readOnly: false }, false],
    ["the editor's own add-comment", { type: "add-comment", body: "x" }, false],
    ["an edit", { type: "edit", text: "x" }, false],
    ["nothing", undefined, false],
  ])("%s → %s", (_name, msg, expected) => {
    expect(isSidebarMessage(msg)).toBe(expected);
  });
});

describe("handleSidebarMessage: document operations", () => {
  it("reply appends to the thread in the file's own source, as the configured user", async () => {
    const { source, threadId } = reviewed();
    const host = fakeHost(source);
    await handleSidebarMessage({ type: "reply", threadId, body: "Thanks." }, host.ctx);
    expect(host.written).toHaveLength(1);
    const thread = parse(host.written[0]).threads.find((t) => t.id === threadId)!;
    expect(thread.comments.at(-1)).toMatchObject({ author: "ronica", body: "Thanks." });
    // Nothing outside the threads block moved.
    expect(parse(host.written[0]).anchors.get(threadId)).toEqual(parse(source).anchors.get(threadId));
  });

  it("toggle-resolve resolves an open thread", async () => {
    const { source, threadId } = reviewed();
    const host = fakeHost(source);
    await handleSidebarMessage({ type: "toggle-resolve", threadId }, host.ctx);
    expect(parse(host.written[0]).threads[0]).toMatchObject({ status: "resolved", resolvedBy: "ronica" });
  });

  it("delete-comment removes that one comment and keeps the thread", async () => {
    const { source, threadId } = reviewed();
    const host = fakeHost(source);
    const reply = parse(source).threads[0].comments[1];
    await handleSidebarMessage({ type: "delete-comment", threadId, commentId: reply.id }, host.ctx);
    const thread = parse(host.written[0]).threads.find((t) => t.id === threadId)!;
    expect(thread.comments.map((c) => c.body)).toEqual(["Why?"]);
  });

  it("delete-thread removes the thread and its markers", async () => {
    const { source, threadId } = reviewed();
    const host = fakeHost(source);
    await handleSidebarMessage({ type: "delete-thread", threadId }, host.ctx);
    expect(parse(host.written[0]).threads).toEqual([]);
    expect(host.written[0]).not.toContain(`mc:a:${threadId}`);
  });

  it("edit-comment rewrites the body and marks it edited", async () => {
    const { source, threadId } = reviewed();
    const host = fakeHost(source);
    const root = parse(source).threads[0].comments[0];
    await handleSidebarMessage({ type: "edit-comment", threadId, commentId: root.id, body: "Why, exactly?" }, host.ctx);
    const edited = parse(host.written[0]).threads[0].comments[0];
    expect(edited.body).toBe("Why, exactly?");
    expect(edited.editedTs).toBeTruthy();
  });

  it("accept-all-suggestions applies every anchored suggestion in one write", async () => {
    const { source } = reviewed();
    const host = fakeHost(source);
    await handleSidebarMessage({ type: "accept-all-suggestions" }, host.ctx);
    expect(host.written).toHaveLength(1);
    expect(host.written[0]).toContain("Gamma sentence.");
    expect(parse(host.written[0]).suggestions).toEqual([]);
  });

  it("a stale thread id writes nothing", async () => {
    const { source } = reviewed();
    const host = fakeHost(source);
    await handleSidebarMessage({ type: "reply", threadId: "zzzzz", body: "late" }, host.ctx);
    expect(host.written).toEqual([]);
  });
});

describe("handleSidebarMessage: sends and settings", () => {
  const cases: Array<[SidebarMessage, string, unknown[]]> = [
    [{ type: "send-to-claude" }, "markdownCollab.sendAllToClaude", []],
    [{ type: "send-to-claude-comment", threadId: "t1" }, "markdownCollab.sendThreadToClaude", ["t1"]],
    [{ type: "copy-claude-comment", threadId: "t1" }, "markdownCollab.copyThreadToClaude", ["t1"]],
    [{ type: "remove-resolved" }, "markdownCollab.removeResolvedComments", []],
    [{ type: "finalize" }, "markdownCollab.finalizeDocument", []],
    [{ type: "empty-state-review" }, "markdownCollab.askClaudeToReview", []],
  ];

  it.each(cases)("%o flushes the editor, then runs %s on the document", async (msg, command, extra) => {
    const host = fakeHost(DOC);
    const exec = vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async () => {
      host.calls.push(`exec:${command}`);
      return undefined;
    });
    await handleSidebarMessage(msg, host.ctx);
    expect(exec).toHaveBeenCalledWith(command, host.ctx.document.uri, ...extra);
    expect(host.calls).toEqual(["flush", `exec:${command}`]);
    exec.mockRestore();
  });

  it("toggle-suggest-mode flips the setting through the command, then re-pushes", async () => {
    const host = fakeHost(DOC);
    const exec = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    await handleSidebarMessage({ type: "toggle-suggest-mode" }, host.ctx);
    expect(exec).toHaveBeenCalledWith("markdownCollab.toggleSuggestMode");
    expect(host.calls).toEqual(["refresh"]);
    exec.mockRestore();
  });
});
