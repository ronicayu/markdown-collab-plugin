import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ensureAgentsSnippet } from "./agents";
import { resolve as resolveAnchor } from "./anchor";
import { MarkdownCollabController, extractAnchor } from "./commentController";
import { OrphanView } from "./orphanView";
import { PreviewPanel } from "./previewPanel";
import { ReviewView, type ReviewNode } from "./reviewView";
import { buildReviewPayload, type SendMode } from "./sendToClaude";
import { SidecarWatcher } from "./sidecarWatcher";
import { installClaudeSkill } from "./skill";
import { EVENT_LOG_REL, EventLog } from "./transports/eventLog";
import { sendViaMcpChannel } from "./transports/mcpChannel";
import { sendViaTerminal, startClaudeTerminal } from "./transports/terminal";
import { TerminalTracker } from "./transports/terminalTracker";
import { runValidate } from "./validate";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Markdown Collab");
  context.subscriptions.push(output);

  const controller = new MarkdownCollabController(output);
  controller.activate(context.subscriptions);
  context.subscriptions.push(controller);

  // Per-workspace event logs, materialized lazily on first "channel" send
  // for each folder. The log is plain append-only newline-delimited JSON;
  // Claude reads it via `tail -f` + Monitor.
  const eventLogs = new Map<string, EventLog>();

  function reconcileAllEventLogs(): void {
    for (const log of eventLogs.values()) {
      log.reconcile().catch((e) => {
        output.appendLine(
          `EventLog.reconcile failed: ${(e as Error).message}`,
        );
      });
    }
  }

  // Live sidecar watcher — routes external .markdown-collab/*.md.json edits
  // back into the controller. The watcher is decoupled from the controller's
  // internals via a minimal host interface so it can be unit-tested against
  // a fake; hence the bespoke passthrough rather than passing `controller`
  // directly.
  const sidecarWatcher = new SidecarWatcher(
    {
      reload: async (d) => {
        await controller.reloadDoc(d);
        PreviewPanel.notifySidecarChange(d.uri.fsPath);
        reconcileAllEventLogs();
      },
      isReloading: (p) => controller.isReloading(p),
      onExternalChange: (p) => {
        controller.onExternalChange(p);
        PreviewPanel.notifySidecarChange(p);
        reconcileAllEventLogs();
      },
    },
    output,
  );
  context.subscriptions.push(sidecarWatcher);

  const orphanView = new OrphanView(controller);
  const tree = vscode.window.createTreeView("markdownCollab.orphanedComments", {
    treeDataProvider: orphanView,
  });
  context.subscriptions.push(tree, orphanView);

  // F3: cross-file Markdown Review tree. Constructor does NOT walk the FS —
  // the scan fires on first root-level getChildren when the user expands the
  // view, keeping activation cheap.
  const reviewView = new ReviewView(controller, output);
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

  context.subscriptions.push(
    vscode.commands.registerCommand("markdownCollab.installClaudeSkill", async () => {
      await invokeInstallClaudeSkill(output);
    }),
    vscode.commands.registerCommand("markdownCollab.initializeAgents", async () => {
      await invokeInitializeAgents(output);
    }),
    vscode.commands.registerCommand("markdownCollab.copyClaudePrompt", async () => {
      await invokeCopyClaudePrompt();
    }),
    vscode.commands.registerCommand("markdownCollab.reloadComments", async () => {
      await controller.reloadActive();
    }),
    vscode.commands.registerCommand(
      "markdownCollab.openPreview",
      async (arg?: vscode.Uri) => {
        // Right-click invocations from explorer/context, editor/title/context,
        // and editor/context all pass the resource as the first argument.
        // The command palette path passes nothing — fall back to the active
        // editor in that case.
        const uri =
          arg instanceof vscode.Uri
            ? arg
            : vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
          void vscode.window.showWarningMessage(
            "Open a Markdown file first, then run this command.",
          );
          return;
        }
        let doc: vscode.TextDocument;
        try {
          doc = await vscode.workspace.openTextDocument(uri);
        } catch (e) {
          void vscode.window.showErrorMessage(
            `Failed to open ${uri.fsPath}: ${(e as Error).message}`,
          );
          return;
        }
        if (doc.languageId !== "markdown" && !uri.fsPath.toLowerCase().endsWith(".md")) {
          void vscode.window.showWarningMessage(
            "Markdown Collab preview only supports .md files.",
          );
          return;
        }
        PreviewPanel.show(doc, output, context.extensionUri);
      },
    ),
    vscode.commands.registerCommand("markdownCollab.validate", async () => {
      await runValidate(output);
    }),
    vscode.commands.registerCommand(
      "markdownCollab.revealComment",
      async (node: ReviewNode | undefined) => {
        if (!node || node.kind !== "comment") return;
        try {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(node.docPath),
          );
          await vscode.window.showTextDocument(doc);
          // No scroll — opening the doc triggers the controller's
          // loadAndAttach, which renders threads. A robust reveal would need
          // to await thread registration; the spec explicitly says that's
          // non-critical, so we skip it.
        } catch (e) {
          output.appendLine(
            `revealComment failed for ${node.docPath}: ${(e as Error).message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "markdownCollab.startClaudeTerminal",
      async () => {
        startClaudeTerminal(terminalTracker);
      },
    ),
    vscode.commands.registerCommand(
      "markdownCollab.sendAllToClaude",
      async (arg?: vscode.Uri) => {
        const uri =
          arg instanceof vscode.Uri
            ? arg
            : vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
          void vscode.window.showWarningMessage(
            "Open a Markdown file first, then run this command.",
          );
          return;
        }
        let doc: vscode.TextDocument;
        try {
          doc = await vscode.workspace.openTextDocument(uri);
        } catch (e) {
          void vscode.window.showErrorMessage(
            `Failed to open ${uri.fsPath}: ${(e as Error).message}`,
          );
          return;
        }
        await invokeSendAllToClaude(
          doc,
          output,
          terminalTracker,
          eventLogs,
          context.workspaceState,
        );
      },
    ),
    vscode.commands.registerCommand("markdownCollab.resetSendMode", async () => {
      await context.workspaceState.update(REMEMBERED_SEND_MODE_KEY, undefined);
      void vscode.window.showInformationMessage(
        "Markdown Collab: Send mode reset. Next click will prompt again.",
      );
    }),
    vscode.commands.registerCommand(
      "markdownCollab.reattachOrphan",
      async (arg1: unknown, arg2?: vscode.Uri) => {
        // Two invocation paths feed this command:
        //   1. Right-click on an orphan tree item (view/item/context) — VS Code
        //      passes the tree Node as the single argument.
        //   2. Programmatic / legacy (commentId, fileUri) positional args.
        let commentId: string | undefined;
        let fileUri: vscode.Uri | undefined;
        if (typeof arg1 === "string") {
          commentId = arg1;
          fileUri = arg2;
        } else if (arg1 && typeof arg1 === "object") {
          const node = arg1 as {
            kind?: string;
            comment?: { id?: string };
            docPath?: string;
          };
          if (
            node.kind === "orphan" &&
            node.comment?.id &&
            typeof node.docPath === "string"
          ) {
            commentId = node.comment.id;
            fileUri = vscode.Uri.file(node.docPath);
          }
        }
        if (!commentId || !fileUri) {
          void vscode.window.showWarningMessage(
            "Re-attach requires an orphan selection.",
          );
          return;
        }
        await invokeReattachOrphan(controller, output, commentId, fileUri);
      },
    ),
  );

  // Any docs already open at activation must be dispatched explicitly —
  // `onDidOpenTextDocument` only fires for opens *after* registration.
  void controller.handleInitialDocs(vscode.workspace.textDocuments);
}

export function deactivate(): void {
  /* disposables handle cleanup */
}

// -----------------------------------------------------------
// Command implementations
// -----------------------------------------------------------

async function invokeInstallClaudeSkill(
  output: vscode.OutputChannel,
): Promise<void> {
  try {
    const result = await installClaudeSkill(os.homedir());
    if (result.action === "installed") {
      void vscode.window.showInformationMessage(
        `Markdown Collab skill installed at ${result.path}.`,
      );
    } else if (result.action === "already-present") {
      void vscode.window.showInformationMessage(
        `Markdown Collab skill is already up to date at ${result.path}.`,
      );
    } else {
      const pick = await vscode.window.showWarningMessage(
        `A different Markdown Collab skill already exists at ${result.path}.`,
        "Overwrite",
        "Cancel",
      );
      if (pick === "Overwrite") {
        const forced = await installClaudeSkill(os.homedir(), { force: true });
        void vscode.window.showInformationMessage(
          `Markdown Collab skill overwritten at ${forced.path}.`,
        );
      }
    }
  } catch (e) {
    output.appendLine(`installClaudeSkill failed: ${(e as Error).message}`);
    void vscode.window.showErrorMessage(
      `Failed to install Claude skill: ${(e as Error).message}`,
    );
  }
}

async function invokeInitializeAgents(output: vscode.OutputChannel): Promise<void> {
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Open a workspace folder first to initialize AGENTS.md.",
    );
    return;
  }
  try {
    const action = await ensureAgentsSnippet(folder.uri.fsPath);
    const verb =
      action === "created"
        ? "created"
        : action === "appended"
          ? "updated"
          : "already up to date";
    void vscode.window.showInformationMessage(
      `AGENTS.md ${verb} in ${folder.name}.`,
    );
  } catch (e) {
    output.appendLine(`initializeAgents failed: ${(e as Error).message}`);
    void vscode.window.showErrorMessage(
      `Failed to initialize AGENTS.md: ${(e as Error).message}`,
    );
  }
}

async function invokeCopyClaudePrompt(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") {
    void vscode.window.showWarningMessage(
      "Open a Markdown file first, then run this command.",
    );
    return;
  }
  const doc = editor.document;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Markdown file is outside any workspace folder.",
    );
    return;
  }
  const rel = path.relative(folder.uri.fsPath, doc.uri.fsPath);
  const prompt = `Use the markdown-collab skill to address the unresolved review comments on ${rel}.`;
  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage(
    "Prompt copied — paste into Claude Code.",
  );
}

async function invokeReattachOrphan(
  controller: MarkdownCollabController,
  output: vscode.OutputChannel,
  commentId: string,
  fileUri: vscode.Uri,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(doc);
  const pick = await vscode.window.showInformationMessage(
    "Select the text in the editor to re-attach this comment to, then click the button.",
    { modal: false },
    "I've selected the new text",
    "Cancel",
  );
  if (pick !== "I've selected the new text") return;

  const latestEditor = vscode.window.activeTextEditor ?? editor;
  // If the user has switched to a different file between clicking the button
  // and responding to the dialog, do not write against that other file.
  if (latestEditor.document.uri.fsPath !== fileUri.fsPath) {
    void vscode.window.showWarningMessage(
      "Switch back to the file with the orphaned comment and select there.",
    );
    return;
  }
  const sel = latestEditor.selection;
  if (sel.isEmpty) {
    void vscode.window.showWarningMessage(
      "No text selected — re-attach cancelled.",
    );
    return;
  }
  const fullText = latestEditor.document.getText();
  const selStart = latestEditor.document.offsetAt(sel.start);
  const selEnd = latestEditor.document.offsetAt(sel.end);
  const { anchor, valid } = extractAnchor(fullText, selStart, selEnd);
  if (!valid) {
    void vscode.window.showWarningMessage(
      "Selection too short — need at least 8 non-whitespace characters.",
    );
    return;
  }
  // Guard against edits between selection and write. Re-resolve the anchor
  // against the current document text and require it to point back at the
  // exact selected range. If the text shifted or the anchor is ambiguous,
  // cancel rather than persist a subtly-wrong anchor.
  const resolved = resolveAnchor(fullText, anchor);
  if (!resolved || resolved.start !== selStart || resolved.end !== selEnd) {
    void vscode.window.showWarningMessage(
      "Re-attach cancelled — selection changed or is ambiguous.",
    );
    return;
  }
  try {
    const ok = await controller.updateCommentAnchor(
      latestEditor.document,
      commentId,
      anchor,
    );
    if (!ok) {
      void vscode.window.showWarningMessage(
        "Could not re-attach: sidecar unavailable or comment id not found.",
      );
    } else {
      void vscode.window.showInformationMessage("Comment re-attached.");
    }
  } catch (e) {
    output.appendLine(`reattachOrphan failed: ${(e as Error).message}`);
    void vscode.window.showErrorMessage(
      `Failed to re-attach: ${(e as Error).message}`,
    );
  }
}

const REMEMBERED_SEND_MODE_KEY = "markdownCollab.rememberedSendMode";

function isConcreteSendMode(v: unknown): v is Exclude<SendMode, "ask"> {
  return (
    v === "terminal" ||
    v === "channel" ||
    v === "mcp-channel" ||
    v === "clipboard"
  );
}

function normalizeSendMode(v: unknown): SendMode {
  if (v === "ask" || isConcreteSendMode(v)) return v;
  return "ask";
}

async function invokeSendAllToClaude(
  doc: vscode.TextDocument,
  output: vscode.OutputChannel,
  tracker: TerminalTracker,
  eventLogs: Map<string, EventLog>,
  workspaceState: vscode.Memento,
): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Markdown file is outside any workspace folder.",
    );
    return;
  }
  const result = await buildReviewPayload(doc, output);
  if (result.kind === "no-workspace") {
    void vscode.window.showWarningMessage(
      "Markdown file is outside any workspace folder.",
    );
    return;
  }
  if (result.kind === "no-sidecar") {
    void vscode.window.showWarningMessage(
      "No comments to send — this file has no sidecar yet.",
    );
    return;
  }
  if (result.kind === "empty") {
    void vscode.window.showInformationMessage(
      "No unresolved comments on this file.",
    );
    return;
  }
  const payload = result.payload;

  const config = vscode.workspace.getConfiguration("markdownCollab");
  const rawMode = config.get<unknown>("sendMode", "ask");
  let mode = normalizeSendMode(rawMode);
  if (mode !== rawMode) {
    output.appendLine(
      `markdownCollab.sendMode "${String(rawMode)}" is not recognized; falling back to "ask". ` +
        `Valid values: ask, terminal, channel, clipboard. (The "ipc" mode was renamed to "channel" in 0.11.0.)`,
    );
    void vscode.window.showWarningMessage(
      `markdownCollab.sendMode "${String(rawMode)}" is no longer supported — falling back to ask. Update your settings to one of: terminal, channel, clipboard.`,
    );
  }
  let justRemembered = false;
  if (mode === "ask") {
    const remembered = workspaceState.get<unknown>(REMEMBERED_SEND_MODE_KEY);
    if (isConcreteSendMode(remembered)) {
      mode = remembered;
    } else {
      const picked = await pickSendMode(payload.unresolvedCount);
      if (!picked) return;
      mode = picked;
      await workspaceState.update(REMEMBERED_SEND_MODE_KEY, picked);
      justRemembered = true;
    }
  }

  const rememberedSuffix = justRemembered
    ? ' Run "Markdown Collab: Reset Send Mode" to change later.'
    : "";

  if (mode === "clipboard") {
    await vscode.env.clipboard.writeText(payload.prompt);
    void vscode.window.showInformationMessage(
      `Prompt for ${payload.unresolvedCount} comment${
        payload.unresolvedCount === 1 ? "" : "s"
      } copied — paste into Claude Code.${rememberedSuffix}`,
    );
    return;
  }

  if (mode === "terminal") {
    const sendResult = await sendViaTerminal(payload, tracker, {
      offerStartTerminal: async () => {
        const choice = await vscode.window.showInformationMessage(
          "No Claude terminal detected.",
          { modal: false },
          "Start Claude in new terminal",
          "Switch to clipboard",
          "Cancel",
        );
        if (choice === "Start Claude in new terminal") {
          const terminal = startClaudeTerminal(tracker);
          // Give the REPL a beat to initialize before we paste into it.
          await new Promise((r) => setTimeout(r, 1500));
          return terminal;
        }
        if (choice === "Switch to clipboard") {
          await vscode.env.clipboard.writeText(payload.prompt);
          void vscode.window.showInformationMessage(
            "Prompt copied — paste into Claude Code.",
          );
        }
        return null;
      },
    });
    if (!sendResult.ok && sendResult.reason === "no-target") {
      // The clipboard fallback toast above already fired; nothing more to do.
      return;
    }
    if (!sendResult.ok) return;
    void vscode.window.showInformationMessage(
      `Sent to "${sendResult.terminalName}".${rememberedSuffix}`,
    );
    return;
  }

  if (mode === "channel" || mode === "mcp-channel") {
    const folderKey = folder.uri.fsPath;
    let log = eventLogs.get(folderKey);
    if (!log) {
      log = new EventLog(folderKey);
      eventLogs.set(folderKey, log);
    }
    let envelope;
    try {
      envelope = await log.append(payload);
    } catch (e) {
      output.appendLine(`Event log append failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `Could not write to event log: ${(e as Error).message}`,
      );
      return;
    }
    if (mode === "channel") {
      void vscode.window.showInformationMessage(
        `Appended to ${EVENT_LOG_REL}. In Claude, run \`mdc-tail.mjs\` in background and Monitor it.${rememberedSuffix}`,
      );
      return;
    }
    // mcp-channel: also push directly to the running MCP channel server so
    // the event arrives as a <channel> tag on Claude's next turn.
    const result = await sendViaMcpChannel(folderKey, envelope);
    if (result.ok) {
      void vscode.window.showInformationMessage(
        `Sent via MCP channel.${rememberedSuffix}`,
      );
    } else if (result.reason === "not-running") {
      void vscode.window.showWarningMessage(
        "MCP channel server isn't running. Start Claude with `--dangerously-load-development-channels server:markdown-collab` or run 'Markdown Collab: Install Claude Skill' if mdc-channel.mjs is missing. The payload was still appended to the events log.",
      );
    } else {
      output.appendLine(
        `mcp-channel push failed (${result.reason}): ${result.detail ?? "no detail"}`,
      );
      void vscode.window.showErrorMessage(
        `MCP channel push failed: ${result.reason}${
          result.detail ? ` (${result.detail})` : ""
        }`,
      );
    }
    return;
  }
}

async function pickSendMode(
  unresolvedCount: number,
): Promise<SendMode | null> {
  const items: Array<vscode.QuickPickItem & { mode: SendMode }> = [
    {
      label: "Send to active terminal",
      description: "Type the prompt into a running Claude REPL",
      mode: "terminal",
    },
    {
      label: "Append to event log",
      description: "For a Claude `tail -f` + Monitor watch loop",
      mode: "channel",
    },
    {
      label: "Push to MCP channel",
      description:
        "Native <channel> event in Claude (requires Claude Code v2.1.80+ + .mcp.json setup)",
      mode: "mcp-channel",
    },
    {
      label: "Copy to clipboard",
      description: "Paste manually into Claude",
      mode: "clipboard",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `How to send ${unresolvedCount} unresolved comment${
      unresolvedCount === 1 ? "" : "s"
    } to Claude? (Set markdownCollab.sendMode to skip this prompt.)`,
  });
  return pick?.mode ?? null;
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const active = vscode.window.activeTextEditor;
  if (active) {
    const f = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (f) return f;
  }
  if (folders.length === 1) return folders[0];
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: "Choose a workspace folder" },
  );
  return pick?.folder;
}

