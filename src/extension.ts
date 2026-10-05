import * as vscode from "vscode";
import { createLogger } from "./logging";
import { setCliGate, setCliLogger } from "./pr/cli";
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
import { reconnectAgents } from "./mcpServer/agentConnections";
import { claudeBinaryFound, lookupClaude, sweepHeadlessTempDirs } from "./transports/headlessHost";
import { activateClaudeStatusBar } from "./claudeStatusBar";
import { TerminalTracker } from "./transports/terminalTracker";
import { dispatchReviewPayload, registerSendCommands } from "./commands/send";
import { registerReviewCommands } from "./commands/review";
import { registerCommentsCommands } from "./commands/comments";
import { registerSetupCommands, maybePromptSkillUpdate } from "./commands/setup";
import { registerDiagnosticsCommands } from "./commands/diagnostics";
import { createReviewViewRouter } from "./commands/reviewViewRouter";
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

  setCliGate(() => vscode.workspace.isTrusted);

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

  // Cross-file Markdown Review tree. It reads inline-comment threads straight
  // from each `.md` and refreshes single files via a `**/*.md` watcher. The
  // scan starts here, not awaited: the tree stays hidden until a scan finds
  // threads, and the broken-marker warning only runs on scanned files.
  const reviewView = new ReviewView(rootLog.scope("review"));
  void reviewView.ensureScanned();
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

  // The review view (10x-plan-6 P4): the rendered document with the threads
  // sidebar, read-only until its Edit switch is on, for a single human +
  // Claude on the same machine. There is no multi-human relay: the human
  // edits here, Claude edits the .md on disk, and the two converge through the
  // file (the provider pushes external file changes into the editor, and
  // writes the editor's edits back to disk).
  context.subscriptions.push(
    CollabEditorProvider.register(context, rootLog.scope("live-editor"), (fsPath, text) =>
      reviewView.onDocumentOpened(fsPath, text),
    ),
  );

  // The previous review view (the markdown-it panel), kept for one release
  // behind `markdownCollab.classicReviewView`. Only the router below opens it.
  // `opts` carries an optional scroll target (the line of a thread's anchor).
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
            context.workspaceState,
            folder,
          );
        },
      },
      opts,
    );
  };

  // The one way into the review view (10x-plan-6 P4): the live editor, or the
  // previous panel while `markdownCollab.classicReviewView` is on. The
  // commands, menus, key, hover link, tree rows, unread walk and status bar
  // all come through here — see src/commands/reviewViewRouter.ts.
  const openReviewView = createReviewViewRouter({
    classic: openInlineView,
    live: (uri, opts) => CollabEditorProvider.open(uri, opts),
    readSource: async (uri) => (await vscode.workspace.openTextDocument(uri)).getText(),
    classicEnabled: () =>
      vscode.workspace.getConfiguration("markdownCollab").get<boolean>("classicReviewView", false),
  });

  // Uncommitted-changes review: the tree of locally changed markdown files,
  // each opening in the review view with diff stripes. Wrapped like the PR
  // controller — a git failure here must not take down activation.
  try {
    context.subscriptions.push(
      new UncommittedChangesController(
        (uri, opts) => openReviewView(uri, { diff: opts.showDiff }),
        rootLog.scope("uncommitted"),
        (uri) => CollabEditorProvider.open(uri, { diff: true }),
      ),
    );
  } catch (e) {
    log.error("uncommitted-changes init failed", e as Error);
  }

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
    openReviewView,
  };

  registerDiagnosticsCommands(deps);
  registerCommentsCommands(deps);
  registerSetupCommands(deps);
  registerSendCommands(deps);
  registerReviewCommands(deps);

  const startTrustedFeatures = (): void => {
    // The MCP tool server (10x-plan-2 P0.1). Started in trusted workspaces so the
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
      // Re-establish every client whose connection can go stale across a
      // restart — Cursor's in-app agent and Copilot's provider are told the
      // token fresh every session, and Codex's config carries a literal port —
      // now that there's a handle to hand them (10x-plan-4 P1.1). Ahead of the
      // `.mcp.json` prompt, which can sit unanswered.
      await reconnectAgents(context, handle, rootLog.scope("mcp"));
      await ensureMcpJsonRegistration(context, handle, rootLog.scope("mcp"), () =>
        claudeBinaryFound(rootLog.scope("headless")),
      );
      // Warm the `claude` lookup in the background, so the first send-mode
      // picker and the review view's empty state don't wait on a
      // `claude --version` probe.
      void lookupClaude(rootLog.scope("headless"));
      sweepHeadlessTempDirs(rootLog.scope("headless"));
    });

    // On startup, nudge the user when the Claude side (plugin or standalone
    // skill) is missing or out of date — otherwise they only find out by opening
    // the comments panel. Gated so it prompts once per version, not every time.
    void maybePromptSkillUpdate(context, skillLog);
  };

  if (vscode.workspace.isTrusted) {
    startTrustedFeatures();
  } else {
    const granted = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      granted.dispose();
      startTrustedFeatures();
      void vscode.commands.executeCommand("markdownCollab.uncommittedRefresh");
    });
    context.subscriptions.push(granted);
  }
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
