// The live editor's sidebar, host half (10x-plan-6 P4, sidebar parity).
//
// Handles every message the sidebar posts (`webviewShared/sidebarProtocol.ts`)
// the way the review view's panel does: document operations run through the
// same pure `applyClientMutation` on the file's own source, sends go through
// the same commands and dispatcher, and the few bits of logic that lived only
// inside inlineCommentsPanel.ts (copy-all, open-in-editor, author, the
// headless probe for the empty state) are here, so the live editor stops
// depending on a panel that is about to be removed. That panel keeps its own
// copies until then.
//
// Nothing here reads the editor's serialization: a mutation parses
// `document.getText()`, rewrites it, and hands the whole new source back to the
// provider to write — in read-only mode and in edit mode alike, where it takes
// its turn with the editor's queued block edits (`exclusive`).

import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parse } from "../inlineComments/format";
import { applyClientMutation } from "../inlineComments/mutations";
import { buildInlinePayload } from "../inlineComments/sendToClaude";
import { mcpToolsDirective } from "../sendToClaude";
import { checkClaudeSkill } from "../skill";
import { currentAuthorName } from "../authorName";
import { claudeBinaryFound } from "../transports/headlessHost";
import { skillBannerStatus } from "./sidebarState";
import type { DispatchOutcome, SidebarMessage, SidebarMutation } from "../webviewShared/sidebarProtocol";

export interface SidebarHostContext {
  document: vscode.TextDocument;
  /**
   * Write a whole new source for the document and save it, then bring the
   * editor up to date if the prose moved (an accepted suggestion). The
   * provider owns this because it owns the echo guard.
   */
  applySource(next: string): Promise<boolean>;
  /**
   * Flush the editor's unsaved edits, so an agent reads the latest text.
   * False when the file couldn't be saved: what's on disk is older than what
   * the editor shows.
   */
  flush(): Promise<boolean>;
  /**
   * Run `job` in turn with the editor's own writes — after every edit queued
   * before it, before any queued after — so the text it reads is the text it
   * writes over.
   */
  exclusive<T>(job: () => Promise<T>): Promise<T>;
  /** Re-push the sidebar's state (after a setting the webview shows changed). */
  refresh(): void;
  post(msg: unknown): void;
}

// `accept-suggestion` / `reject-suggestion` aren't admitted: the provider has
// always handled exactly these two messages, on the source, with the same
// result, so they stay on that path. `handleSidebarMessage` still takes them.
const MUTATIONS: ReadonlySet<string> = new Set<SidebarMutation["type"]>([
  "reply",
  "edit-comment",
  "toggle-resolve",
  "delete-thread",
  "delete-comment",
  "accept-all-suggestions",
]);

const REQUESTS: ReadonlySet<string> = new Set<SidebarMessage["type"]>([
  "send-to-claude",
  "copy-prompt",
  "toggle-suggest-mode",
  "remove-resolved",
  "finalize",
  "install-skill",
  "empty-state-review",
  "send-to-claude-comment",
  "copy-claude-comment",
  "open-in-editor",
]);

/**
 * Whether `raw` is a sidebar message this module handles. `set-read-only` is
 * the provider's (it decides how the editor is built), and the live editor's
 * older messages share one name with this set — `delete-comment` there carries
 * only a `commentId` and deletes the whole thread — so that one counts here
 * only with its `threadId`.
 */
export function isSidebarMessage(raw: unknown): raw is SidebarMessage {
  if (!raw || typeof raw !== "object") return false;
  const msg = raw as { type?: unknown; threadId?: unknown };
  if (typeof msg.type !== "string") return false;
  if (msg.type === "delete-comment") return typeof msg.threadId === "string";
  return MUTATIONS.has(msg.type) || REQUESTS.has(msg.type);
}

export async function handleSidebarMessage(msg: SidebarMessage, ctx: SidebarHostContext): Promise<void> {
  const uri = ctx.document.uri;
  switch (msg.type) {
    case "reply":
    case "edit-comment":
    case "toggle-resolve":
    case "delete-thread":
    case "delete-comment":
    case "accept-suggestion":
    case "reject-suggestion":
    case "accept-all-suggestions":
      // Read, rewritten and written with no edit of the editor's landing in
      // between: one would be overwritten by (or spliced into the middle of)
      // a source computed without it.
      return ctx.exclusive(() => applySidebarMutation(msg, ctx));
    case "send-to-claude":
      return send(ctx, "markdownCollab.sendAllToClaude", uri);
    case "send-to-claude-comment":
      return send(ctx, "markdownCollab.sendThreadToClaude", uri, msg.threadId);
    case "copy-prompt":
      await ctx.flush();
      return copyAllPrompt(ctx.document);
    case "copy-claude-comment":
      await ctx.flush();
      await vscode.commands.executeCommand("markdownCollab.copyThreadToClaude", uri, msg.threadId);
      return;
    case "toggle-suggest-mode":
      // The command flips the per-workspace setting and says so; re-push so
      // the switch shows what it landed on.
      await vscode.commands.executeCommand("markdownCollab.toggleSuggestMode");
      ctx.refresh();
      return;
    case "remove-resolved":
      // Straight to the command, so the modal confirm and the undoable write
      // are defined once. The document change re-pushes on its own.
      await ctx.flush();
      await vscode.commands.executeCommand("markdownCollab.removeResolvedComments", uri);
      return;
    case "finalize":
      await ctx.flush();
      await vscode.commands.executeCommand("markdownCollab.finalizeDocument", uri);
      return;
    case "open-in-editor":
      return openThreadInEditor(ctx.document, msg.threadId);
    case "empty-state-review":
      // The same ask-review flow as the title-bar entry point: the remembered
      // send mode, or the picker when there isn't one yet.
      if (!(await savedForAgent(ctx))) return;
      await vscode.commands.executeCommand("markdownCollab.askClaudeToReview", uri);
      return;
    case "install-skill":
      await vscode.commands.executeCommand("markdownCollab.installClaudeSkill");
      await postSkillStatus(ctx.post);
      return;
    case "set-read-only":
      // The provider's to handle; `isSidebarMessage` never admits it here.
      return;
  }
}

/**
 * Hand the document to the agent: only once the file on disk has the editor's
 * text, since the agent reads the file — a send after a failed save would
 * give it the old version. The webview's notice waits for the outcome.
 */
async function send(ctx: SidebarHostContext, command: string, ...args: unknown[]): Promise<void> {
  if (!(await savedForAgent(ctx))) {
    ctx.post({ type: "send-result", outcome: "cancelled", saved: false });
    return;
  }
  const outcome = await vscode.commands.executeCommand<DispatchOutcome>(command, ...args);
  ctx.post({ type: "send-result", outcome, saved: true });
}

/** Flush the editor to disk for an agent; false, having said so, when the save failed. */
async function savedForAgent(ctx: SidebarHostContext): Promise<boolean> {
  if (await ctx.flush()) return true;
  void vscode.window.showWarningMessage(
    `Not sent: ${path.basename(ctx.document.uri.fsPath)} couldn't be saved, so your agent would read the old version.`,
  );
  return false;
}

async function applySidebarMutation(msg: SidebarMutation, ctx: SidebarHostContext): Promise<void> {
  const parsed = parse(ctx.document.getText());
  const result = applyClientMutation(parsed, msg, {
    author: sidebarAuthor(),
    now: () => new Date().toISOString(),
  });
  if (result.source !== parsed.source) {
    const ok = await ctx.applySource(result.source);
    if (!ok) void vscode.window.showErrorMessage("Markdown Collab: the change couldn't be written to the file.");
  }
  if (result.warning) void vscode.window.showWarningMessage(result.warning);
}

/** Copy the prompt for every open thread, as the agent would receive it. */
async function copyAllPrompt(doc: vscode.TextDocument): Promise<void> {
  const payload = buildInlinePayload(doc, { suggestMode: readSuggestMode() });
  if (!payload) {
    void vscode.window.showInformationMessage("No open threads to copy.");
    return;
  }
  // A clipboard delivery like any other — the same directive every send carries.
  await vscode.env.clipboard.writeText(`${payload.prompt}\n\n${mcpToolsDirective()}`);
  void vscode.window.showInformationMessage(
    `Prompt for ${payload.unresolvedCount} open thread${payload.unresolvedCount === 1 ? "" : "s"} copied — paste into your agent.`,
  );
}

/**
 * Open one thread's anchored text in a text editor, selected: the raw markdown
 * between its markers, excluding the markers themselves.
 */
export async function openThreadInEditor(doc: vscode.TextDocument, threadId: string): Promise<void> {
  const anchor = parse(doc.getText()).anchors.get(threadId);
  if (!anchor) {
    void vscode.window.showInformationMessage("This comment's text was removed, so there's nothing to jump to.");
    return;
  }
  const range = new vscode.Range(doc.positionAt(anchor.openEnd), doc.positionAt(anchor.closeStart));
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false,
    selection: range,
  });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/** Who a reply, an edit, or a resolve is attributed to — the review view's rule. */
function sidebarAuthor(): string {
  return currentAuthorName();
}

/** Whether Send asks the agent for suggestions instead of edits. */
export function readSuggestMode(): boolean {
  return vscode.workspace.getConfiguration("markdownCollab").get<boolean>("proposeEditsAsSuggestions", false);
}

/**
 * The skill banner's state, posted after `init` so the first paint doesn't wait
 * on the disk or on a `claude --version` probe. The banner is about the Claude
 * skill, so it only matters once Claude Code is on this machine: the binary
 * lookup is the one headless availability already caches (a cold one starts
 * here and the post follows when it settles), and without Claude Code the
 * status goes out as "current" — nothing to show.
 */
export async function postSkillStatus(post: (msg: unknown) => void): Promise<void> {
  const [status, claudeCode] = await Promise.all([
    checkClaudeSkill(os.homedir()),
    claudeBinaryFound().catch(() => false),
  ]);
  post({ type: "skill-status", status: skillBannerStatus(status, claudeCode) });
}
