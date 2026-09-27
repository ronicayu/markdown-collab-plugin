import * as vscode from "vscode";
import { createLogger } from "./logging";
import { setCliLogger } from "./pr/cli";
import { folderForDocument } from "./workspaceFolder";
import { activateEditorPresence } from "./editorPresence";
import { CollabEditorProvider } from "./collab/collabEditorProvider";
import { InlineCommentsPanel } from "./inlineComments/inlineCommentsPanel";
import { PrReviewController } from "./pr/prReviewController";
import { UncommittedChangesController } from "./uncommitted/uncommittedController";
import { ReviewView } from "./reviewView";
import {
  pendingSignalsFromToolCalls,
  ensureMcpJsonRegistration,
  startMcpServer,
} from "./mcpServer";
import { parse as parseInline } from "./inlineComments/format";
import { activateClaudeStatusBar } from "./claudeStatusBar";
import { EventLog } from "./transports/eventLog";
import { TerminalTracker } from "./transports/terminalTracker";
import { dispatchReviewPayload, registerSendCommands } from "./commands/send";
import { registerReviewCommands } from "./commands/review";
import { registerCommentsCommands } from "./commands/comments";
import { registerSetupCommands, maybePromptSkillUpdate } from "./commands/setup";
import { registerDiagnosticsCommands } from "./commands/diagnostics";
import type { CommandDeps } from "./commands/deps";

export function activate(context: vscode.ExtensionContext): void {
  const rootLog = createLogger();
  context.subscriptions.push(rootLog);
  const log = rootLog.scope("activation");
  const skillLog = rootLog.scope("skill");
  const reviewLog = rootLog.scope("review");
  const sendLog = rootLog.scope("send");
  log.info("activating", {
    version: context.extension?.packageJSON?.version ?? "unknown",
    vscode: vscode.version,
    folders: vscode.workspace.workspaceFolders?.length ?? 0,
  });

  // Every `gh` / `glab` invocation lands in the log from here on.
  setCliLogger(rootLog.scope("pr"));
  context.subscriptions.push({ dispose: () => setCliLogger(null) });

  // PR review init is wrapped because it pulls in the comments API in a
  // configuration the legacy controller doesn't use; any failure here must
  // not take down the rest of the extension (terminal, send-to-claude,
  // inline view, etc. all live below).
  try {
    const prReviewController = new PrReviewController(context, rootLog.scope("pr"));
    prReviewController.activate(context.subscriptions);
    context.subscriptions.push(prReviewController);
  } catch (e) {
    const err = e as Error;
    log.error("PR review init failed", err);
    void vscode.window.showErrorMessage(
      `Markdown Collab: PR review feature failed to initialize — ${err.message}. Other commands still work. See the "Markdown Collab" output channel for the stack trace.`,
    );
  }

  // Per-workspace event logs, materialized lazily on first "channel" send
  // for each folder. The log is plain append-only newline-delimited JSON;
  // Claude reads it via `tail -f` + Monitor.
  const eventLogs = new Map<string, EventLog>();

  // Cross-file Markdown Review tree. Constructor does NOT walk the FS — the
  // scan fires on first root-level getChildren when the user expands the view,
  // keeping activation cheap. It reads inline-comment threads straight from
  // each `.md` and refreshes single files via a `**/*.md` watcher.
  const reviewView = new ReviewView(rootLog.scope("review"));
  const reviewTree = vscode.window.createTreeView("markdownCollab.review", {
    treeDataProvider: reviewView,
  });
  context.subscriptions.push(reviewTree, reviewView);

  // Track terminals for the "Send to Claude → terminal" path. The tracker
  // subscribes to shell-integration events when available; older VS Code
  // hosts fall back to name-match + active-terminal heuristics.
  const terminalTracker = new TerminalTracker();
  terminalTracker.activate(context.subscriptions);
  context.subscriptions.push(terminalTracker);

  // Decorations, folding, and hovers in the raw text editor (10x-plan-3 P0.1):
  // the markers stop reading as corruption and a thread can be read without
  // leaving the source view.
  context.subscriptions.push(activateEditorPresence(rootLog.scope("format")));

  // Visible from anywhere while Claude works through the tools — the panels
  // own the per-thread row, this is for when the human has gone back to the
  // editor (10x-plan-2 P0.2).
  context.subscriptions.push(activateClaudeStatusBar());

  // The MCP tool server (10x-plan-2 P0.1). Started for every workspace so the
  // tools are there when Claude reaches for them, but nothing depends on it:
  // it is never the default send mode, and a failure to bind is logged and
  // ignored. Registration in `.mcp.json` is a separate, asked-once step.
  void startMcpServer(context, {
    log: rootLog.scope("mcp"),
    // Tool calls are the lifecycle signal: they say Claude is working, which
    // file, and — via mc_check — when it's done (10x-plan-2 P0.2).
    onToolCall: pendingSignalsFromToolCalls,
  }).then(async (handle) => {
    if (!handle) return;
    context.subscriptions.push({ dispose: () => handle.dispose() });
    await ensureMcpJsonRegistration(context, handle, rootLog.scope("mcp"));
  });

  // Live WYSIWYG editor for a single human + Claude on the same machine. There
  // is no multi-human relay: the human edits here, Claude edits the .md on
  // disk, and the two converge through the file (the provider pushes external
  // file changes into the editor, and writes the editor's edits back to disk).
  context.subscriptions.push(CollabEditorProvider.register(context, rootLog.scope("live-editor")));

  // One way into the review view, used by the command, the explorer menus, and
  // the source-editor affordances (hover link, unread walk). `opts` carries an
  // optional scroll target so a caller can land on a specific thread.
  const openInlineView = async (
    uri: vscode.Uri,
    opts?: { line?: number; showDiff?: boolean },
  ): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument(uri);
    InlineCommentsPanel.reveal(
      context,
      doc,
      {
        dispatchToClaude: async (payload) => {
          const folder = folderForDocument(doc.uri);
          await dispatchReviewPayload(
            payload,
            sendLog,
            terminalTracker,
            eventLogs,
            context.workspaceState,
            folder,
          );
        },
      },
      opts,
    );
  };

  // Uncommitted-changes review: the tree of locally changed markdown files,
  // each opening in the inline view with diff stripes. Wrapped like the PR
  // controller — a git failure here must not take down activation.
  try {
    context.subscriptions.push(
      new UncommittedChangesController(
        (uri, opts) => openInlineView(uri, opts),
        rootLog.scope("uncommitted"),
      ),
    );
  } catch (e) {
    log.error("uncommitted-changes init failed", e as Error);
  }

  /**
   * Open the review view scrolled to one thread. The source line of the
   * thread's anchor is the scroll target, so this reuses the panel's existing
   * line-based reveal rather than adding a second addressing scheme.
   */
  const revealThread = async (uri: vscode.Uri, threadId: string): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const anchor = parseInline(doc.getText()).anchors.get(threadId);
    await openInlineView(uri, anchor ? { line: doc.positionAt(anchor.openEnd).line + 1 } : undefined);
  };

  // Every command family gets the same wiring rather than reaching back into
  // this function's locals — see src/commands/deps.ts.
  const deps: CommandDeps = {
    context,
    rootLog,
    log,
    reviewLog,
    sendLog,
    skillLog,
    formatLog: rootLog.scope("format"),
    diagnosticsLog: rootLog.scope("diagnostics"),
    terminalTracker,
    reviewView,
    eventLogs,
    openInlineView,
    revealThread,
  };

  registerDiagnosticsCommands(deps);
  registerCommentsCommands(deps);
  registerSetupCommands(deps);
  registerSendCommands(deps);
  registerReviewCommands(deps);

  // On startup, nudge the user to install/update the Claude skill if it's
  // missing or out of date — otherwise they only find out by opening the
  // comments panel. Gated per skill version so it prompts once, not every time.
  void maybePromptSkillUpdate(context, skillLog);
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
