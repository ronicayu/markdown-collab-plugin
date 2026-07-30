import * as os from "os";
import * as path from "path";
import { repairIntegrity } from "./inlineComments/integrity";
import * as vscode from "vscode";
import { ensureAgentsSnippet } from "./agents";
import { CollabEditorProvider } from "./collab/collabEditorProvider";
import { InlineCommentsPanel } from "./inlineComments/inlineCommentsPanel";
import { PrReviewController } from "./pr/prReviewController";
import { ReviewView, type ReviewNode } from "./reviewView";
import {
  buildReviewRequestPayload,
  mcpToolsDirective,
  type ReviewPayload,
  type SendMode,
} from "./sendToClaude";
import {
  currentMcpServer,
  ensureMcpJsonRegistration,
  pendingSignalsFromToolCalls,
  resetMcpJsonConsent,
  startMcpServer,
} from "./mcpServer";
import {
  buildMultiFileReviewPayload,
  totalBytes,
  type ReviewFile,
} from "./multiFileReview";
import { parse as parseInline } from "./inlineComments/format";
import { claudePending } from "./claudePendingService";
import { activateClaudeStatusBar } from "./claudeStatusBar";
import { CONVENTIONS_REL, CONVENTIONS_TEMPLATE, withConventions } from "./reviewConventions";
import type { PendingEvidence } from "./inlineComments/claudePending";
import { buildInlinePayload, buildSingleThreadPayload } from "./inlineComments/sendToClaude";
import { checkClaudeSkill, installClaudeSkill, skillFingerprint } from "./skill";
import { EVENT_LOG_REL, EventLog } from "./transports/eventLog";
import { hasMcpChannelEndpoint, sendViaMcpChannel } from "./transports/mcpChannel";
import {
  CHANGE_HINT,
  detectSendMode,
  type SendModeDetection,
} from "./transports/detectSendMode";
import { sendViaTerminal, startClaudeTerminal } from "./transports/terminal";
import { TerminalTracker } from "./transports/terminalTracker";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Markdown Collab");
  context.subscriptions.push(output);

  // PR review init is wrapped because it pulls in the comments API in a
  // configuration the legacy controller doesn't use; any failure here must
  // not take down the rest of the extension (terminal, send-to-claude,
  // inline view, etc. all live below).
  try {
    const prReviewController = new PrReviewController(context, output);
    prReviewController.activate(context.subscriptions);
    context.subscriptions.push(prReviewController);
  } catch (e) {
    const err = e as Error;
    output.appendLine(`[fatal] PR review init failed: ${err.message}`);
    if (err.stack) output.appendLine(err.stack);
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
  const reviewView = new ReviewView(output);
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

  // Visible from anywhere while Claude works through the tools — the panels
  // own the per-thread row, this is for when the human has gone back to the
  // editor (10x-plan-2 P0.2).
  context.subscriptions.push(activateClaudeStatusBar());

  // The MCP tool server (10x-plan-2 P0.1). Started for every workspace so the
  // tools are there when Claude reaches for them, but nothing depends on it:
  // it is never the default send mode, and a failure to bind is logged and
  // ignored. Registration in `.mcp.json` is a separate, asked-once step.
  void startMcpServer(context, {
    output,
    // Tool calls are the lifecycle signal: they say Claude is working, which
    // file, and — via mc_check — when it's done (10x-plan-2 P0.2).
    onToolCall: pendingSignalsFromToolCalls,
  }).then(async (handle) => {
    if (!handle) return;
    context.subscriptions.push({ dispose: () => handle.dispose() });
    await ensureMcpJsonRegistration(context, handle, output);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("markdownCollab.installClaudeSkill", async () => {
      await invokeInstallClaudeSkill(output);
    }),
    vscode.commands.registerCommand("markdownCollab.editReviewConventions", async () => {
      await invokeEditReviewConventions(output);
    }),
    vscode.commands.registerCommand("markdownCollab.registerMcpServer", async () => {
      const handle = currentMcpServer();
      if (!handle) {
        void vscode.window.showWarningMessage(
          "Markdown Collab: the review tool server isn't running — reload the window and try again. See the Markdown Collab output channel.",
        );
        return;
      }
      // Clear the remembered answer so a previous "Not now" doesn't silently
      // swallow an explicit request.
      await resetMcpJsonConsent(context);
      await ensureMcpJsonRegistration(context, handle, output);
    }),
    vscode.commands.registerCommand("markdownCollab.toggleSuggestMode", async () => {
      const next = !isSuggestMode();
      // Workspace target so the choice is remembered per workspace, like sendMode.
      await vscode.workspace
        .getConfiguration("markdownCollab")
        .update("proposeEditsAsSuggestions", next, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage(
        next
          ? "Suggest mode ON — Send to Claude will propose edits for you to accept/reject."
          : "Suggest mode OFF — Claude applies edits directly.",
      );
    }),
    vscode.commands.registerCommand(
      "markdownCollab.repairInlineComments",
      async (fsPathArg?: string) => {
        await invokeRepairInlineComments(output, fsPathArg);
      },
    ),
    vscode.commands.registerCommand("markdownCollab.initializeAgents", async () => {
      await invokeInitializeAgents(output);
    }),
    vscode.commands.registerCommand("markdownCollab.copyClaudePrompt", async () => {
      await invokeCopyClaudePrompt();
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
          // Opening the doc is enough — the inline markers travel with the
          // file. Scrolling to the exact thread is non-critical, so skip it.
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
    // Per-thread send/copy — invoked by the live editor's "→ Claude" / "Copy"
    // thread actions (and reusable elsewhere). Internal commands: not in the
    // command palette.
    vscode.commands.registerCommand(
      "markdownCollab.sendThreadToClaude",
      async (uri?: vscode.Uri, threadId?: string) => {
        if (!(uri instanceof vscode.Uri) || !threadId) return;
        let doc: vscode.TextDocument;
        try {
          doc = await vscode.workspace.openTextDocument(uri);
        } catch (e) {
          void vscode.window.showErrorMessage(
            `Failed to open ${uri.fsPath}: ${(e as Error).message}`,
          );
          return;
        }
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (!folder) {
          void vscode.window.showWarningMessage(
            "Markdown file is outside any workspace folder.",
          );
          return;
        }
        const payload = buildSingleThreadPayload(doc, threadId, {
          suggestMode: isSuggestMode(),
        });
        if (!payload) {
          void vscode.window.showInformationMessage(
            "Thread not found or already resolved.",
          );
          return;
        }
        await dispatchReviewPayload(
          payload,
          output,
          terminalTracker,
          eventLogs,
          context.workspaceState,
          folder,
        );
      },
    ),
    vscode.commands.registerCommand(
      "markdownCollab.copyThreadToClaude",
      async (uri?: vscode.Uri, threadId?: string) => {
        if (!(uri instanceof vscode.Uri) || !threadId) return;
        let doc: vscode.TextDocument;
        try {
          doc = await vscode.workspace.openTextDocument(uri);
        } catch (e) {
          void vscode.window.showErrorMessage(
            `Failed to open ${uri.fsPath}: ${(e as Error).message}`,
          );
          return;
        }
        const payload = buildSingleThreadPayload(doc, threadId, {
          suggestMode: isSuggestMode(),
        });
        if (!payload) {
          void vscode.window.showInformationMessage(
            "Thread not found or already resolved.",
          );
          return;
        }
        await vscode.env.clipboard.writeText(payload.prompt);
        void vscode.window.showInformationMessage(
          "Thread prompt copied — paste into Claude Code.",
        );
      },
    ),
    vscode.commands.registerCommand("markdownCollab.resetSendMode", async () => {
      await context.workspaceState.update(REMEMBERED_SEND_MODE_KEY, undefined);
      void vscode.window.showInformationMessage(
        "Markdown Collab: Send mode reset. Next click will prompt again.",
      );
    }),
  );

  // Live WYSIWYG editor for a single human + Claude on the same machine. There
  // is no multi-human relay: the human edits here, Claude edits the .md on
  // disk, and the two converge through the file (the provider pushes external
  // file changes into the editor, and writes the editor's edits back to disk).
  context.subscriptions.push(CollabEditorProvider.register(context, output));

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "markdownCollab.openCollabEditor",
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
        await vscode.commands.executeCommand(
          "vscode.openWith",
          uri,
          CollabEditorProvider.viewType,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "markdownCollab.openInlineCommentsView",
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
        const doc = await vscode.workspace.openTextDocument(uri);
        InlineCommentsPanel.reveal(context, doc, {
          dispatchToClaude: async (payload) => {
            const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
            if (!folder) {
              void vscode.window.showWarningMessage(
                "Inline comments: send-to-claude needs the file to live inside a workspace folder.",
              );
              return;
            }
            await dispatchReviewPayload(
              payload,
              output,
              terminalTracker,
              eventLogs,
              context.workspaceState,
              folder,
            );
          },
        });
      },
    ),
  );

  // One handler, two command ids: the explorer needs a folder-appropriate
  // title ("These Docs") next to the file one, and a menu entry can't override
  // a command's title.
  const askClaudeToReview = async (
    arg?: vscode.Uri,
    selected?: vscode.Uri[],
  ): Promise<void> => {
    await invokeAskClaudeToReviewSelection(
      resolveSelection(arg, selected),
      output,
      terminalTracker,
      eventLogs,
      context.workspaceState,
      context.globalState,
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("markdownCollab.askClaudeToReview", askClaudeToReview),
    vscode.commands.registerCommand("markdownCollab.askClaudeToReviewFolder", askClaudeToReview),
    vscode.commands.registerCommand(
      "markdownCollab.askClaudeToReviewChanges",
      async (arg?: vscode.Uri, selected?: vscode.Uri[]) => {
        await invokeAskClaudeToReviewSelection(
          resolveSelection(arg, selected),
          output,
          terminalTracker,
          eventLogs,
          context.workspaceState,
          context.globalState,
          true,
        );
      },
    ),
    vscode.commands.registerCommand("markdownCollab.nextUnreadFromClaude", async () => {
      await invokeNextUnreadFromClaude(reviewView, output);
    }),
  );

  // On startup, nudge the user to install/update the Claude skill if it's
  // missing or out of date — otherwise they only find out by opening the
  // comments panel. Gated per skill version so it prompts once, not every time.
  void maybePromptSkillUpdate(context, output);
}

/** The workspace's standing review conventions, or null when there are none. */
async function readConventions(folder: vscode.WorkspaceFolder): Promise<string | null> {
  const uri = vscode.Uri.joinPath(folder.uri, ...CONVENTIONS_REL.split("/"));
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    // Absent is the normal case, not an error: most workspaces never write one.
    return null;
  }
}

/**
 * Open the conventions file, creating it from the template first time. The
 * scaffold matters more than it looks: an empty file gives no clue what belongs
 * in it, and this is prose whose whole value is being specific.
 */
async function invokeEditReviewConventions(output: vscode.OutputChannel): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Markdown Collab: open a workspace folder first — conventions are per project.",
    );
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, ...CONVENTIONS_REL.split("/"));
  let existed = true;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    existed = false;
  }
  if (!existed) {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".markdown-collab"));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(CONVENTIONS_TEMPLATE, "utf8"));
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Markdown Collab: could not create ${CONVENTIONS_REL} — ${(e as Error).message}`,
      );
      return;
    }
    output.appendLine(`Created ${CONVENTIONS_REL}`);
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  if (!existed) {
    void vscode.window.showInformationMessage(
      "Write your standing review conventions here. They're sent with every review request.",
    );
  }
}

const SKILL_PROMPT_KEY = "markdownCollab.skillPromptedFingerprint";

async function maybePromptSkillUpdate(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  let status: Awaited<ReturnType<typeof checkClaudeSkill>>;
  try {
    status = await checkClaudeSkill(os.homedir());
  } catch (e) {
    output.appendLine(`Skill check failed: ${(e as Error).message}`);
    return;
  }
  if (status === "current") return;

  // Prompt at most once per bundled-skill version, so we don't nag on every
  // window the user opens.
  const fingerprint = skillFingerprint();
  if (context.globalState.get<string>(SKILL_PROMPT_KEY) === fingerprint) return;
  await context.globalState.update(SKILL_PROMPT_KEY, fingerprint);

  const action = status === "missing" ? "Install skill" : "Update skill";
  const message =
    status === "missing"
      ? "Markdown Collab: the Claude skill isn't installed. Claude needs it to read and act on your comments."
      : "Markdown Collab: the Claude skill is out of date. Update it so Claude follows the latest comment-handling behavior.";
  const choice = await vscode.window.showInformationMessage(message, action, "Not now");
  if (choice === action) {
    await vscode.commands.executeCommand("markdownCollab.installClaudeSkill");
  }
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
  const prompt = `Use the vs-markdown-collab skill to address the unresolved review comments on ${rel}.`;
  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage(
    "Prompt copied — paste into Claude Code.",
  );
}

const REMEMBERED_SEND_MODE_KEY = "markdownCollab.rememberedSendMode";

function isConcreteSendMode(v: unknown): v is Exclude<SendMode, "ask"> {
  return (
    v === "terminal" ||
    v === "mcp" ||
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
  // Comments live inline in the `.md` itself (in the `<!--mc:threads:begin-->`
  // block). Build the payload from the open inline threads.
  const inlinePayload = buildInlinePayload(doc, { suggestMode: isSuggestMode() });
  if (!inlinePayload) {
    void vscode.window.showInformationMessage(
      "No unresolved comments on this file.",
    );
    return;
  }
  await dispatchReviewPayload(
    inlinePayload,
    output,
    tracker,
    eventLogs,
    workspaceState,
    folder,
  );

}

/**
 * Record that Claude owes a reply on the threads this payload carries, so
 * every open view can show "Claude is working…" on them (10x-plan P1.2).
 *
 * Called from the delivery branches of `dispatchReviewPayload` rather than
 * from each command, so a new send path cannot forget it. Review-mode payloads
 * carry no comments and therefore mark nothing — they create threads instead
 * of addressing existing ones, so there is no card to annotate.
 */
async function markPayloadPending(
  payload: ReviewPayload,
  folder: vscode.WorkspaceFolder,
  /**
   * "protocol" only when the dispatch asked Claude to work through the MCP
   * tools — then the tool calls, not a timer, decide when the wait ends
   * (10x-plan-2 P0.2). Every other transport is fire-and-forget, and the
   * indicator says so.
   */
  evidence: PendingEvidence = "inferred",
): Promise<void> {
  const threadIds = payload.comments.map((c) => c.id);
  if (threadIds.length === 0) return;
  try {
    const uri = vscode.Uri.joinPath(folder.uri, payload.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    claudePending.mark(uri.toString(), parseInline(doc.getText()).threads, threadIds, evidence);
  } catch {
    // The indicator is a nicety; never fail a successful send over it.
  }
}

/** Whether "Send to Claude" should ask Claude to propose edits as suggestions. */
function isSuggestMode(): boolean {
  return vscode.workspace
    .getConfiguration("markdownCollab")
    .get<boolean>("proposeEditsAsSuggestions", false);
}

type DispatchIntent =
  | { kind: "address" }
  | { kind: "review-request"; hasFocus: boolean };

/**
 * Route a ReviewPayload through the user-configured sendMode (or prompt
 * if unset). Shared by the "send unresolved comments" and "ask Claude to
 * review" commands so both use the same delivery logic.
 *
 * `intent` shapes the UI strings (placeholder, toast) without forking the
 * transport logic — review-request payloads carry `unresolvedCount: 0`
 * and so the default "send N unresolved comments" wording would read
 * wrong.
 */
async function dispatchReviewPayload(
  payload: ReviewPayload,
  output: vscode.OutputChannel,
  tracker: TerminalTracker,
  eventLogs: Map<string, EventLog>,
  workspaceState: vscode.Memento,
  folder: vscode.WorkspaceFolder,
  intent: DispatchIntent = { kind: "address" },
): Promise<void> {
  // Standing conventions ride along on every dispatch, whatever the mode
  // (10x-plan-2 P1.2). Done here rather than in each payload builder so no send
  // path can be the one that forgets them.
  payload = { ...payload, prompt: withConventions(payload.prompt, await readConventions(folder)) };

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
  /** Set when this send's mode was auto-detected rather than chosen. */
  let detected: SendModeDetection | null = null;
  if (mode === "ask") {
    const remembered = workspaceState.get<unknown>(REMEMBERED_SEND_MODE_KEY);
    if (isConcreteSendMode(remembered)) {
      mode = remembered;
    } else {
      // Before asking, look at what's actually running. A visible Claude REPL
      // or a live MCP channel answers the question the quick-pick was asking,
      // and the user has no way to make that call better than we can.
      detected = detectSendMode({
        claudeTerminal: tracker.anyClaudeTerminal(),
        mcpChannelEndpoint: await hasMcpChannelEndpoint(folder.uri.fsPath),
      });
      if (detected) {
        mode = detected.mode;
        output.appendLine(`Send mode auto-detected: ${detected.mode} (${detected.reason})`);
      } else {
        // MCP is offered, never auto-selected: it can be disabled entirely on
        // Claude's side (enterprise policy, --strict-mcp-config), so a default
        // that depends on it would silently break for those users.
        const picked = await pickSendMode(payload.unresolvedCount, intent, {
          mcpAvailable: currentMcpServer() !== null,
        });
        if (!picked) return;
        mode = picked;
      }
      await workspaceState.update(REMEMBERED_SEND_MODE_KEY, mode);
      justRemembered = true;
    }
  }

  const rememberedSuffix = detected
    ? ` Send mode auto-detected.${CHANGE_HINT}`
    : justRemembered
      ? ' Run "Markdown Collab: Reset Send Mode" to change later.'
      : "";

  if (mode === "clipboard") {
    await vscode.env.clipboard.writeText(payload.prompt);
    const msg =
      intent.kind === "review-request"
        ? `Review-request prompt for \`${payload.file}\` copied — paste into Claude Code.`
        : `Prompt for ${payload.unresolvedCount} comment${
            payload.unresolvedCount === 1 ? "" : "s"
          } copied — paste into Claude Code.`;
    void vscode.window.showInformationMessage(`${msg}${rememberedSuffix}`);
    return;
  }

  if (mode === "mcp" && currentMcpServer() === null) {
    // The chosen mode's server isn't up (window reloaded, port lost). Degrade
    // rather than fail: the prompt still gets delivered, Claude just edits the
    // old way. Said out loud, because the human picked MCP on purpose.
    output.appendLine("Send mode mcp requested but the tool server isn't running; falling back to terminal.");
    void vscode.window.showWarningMessage(
      "Markdown Collab: the review tool server isn't running — sending to the terminal without it.",
    );
    mode = "terminal";
  }

  if (mode === "terminal" || mode === "mcp") {
    const delivered: ReviewPayload =
      mode === "mcp"
        ? { ...payload, prompt: `${payload.prompt}\n\n${mcpToolsDirective()}` }
        : payload;
    const sendResult = await sendViaTerminal(delivered, tracker, {
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
          // `delivered`, not `payload`: in mcp mode the tools directive is part
          // of the prompt, and a hand-paste needs it too.
          await vscode.env.clipboard.writeText(delivered.prompt);
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
    await markPayloadPending(payload, folder, mode === "mcp" ? "protocol" : "inferred");
    const msg =
      intent.kind === "review-request"
        ? `Claude is reviewing — threads will appear when it's done. (Sent to "${sendResult.terminalName}".)`
        : `Sent to "${sendResult.terminalName}".`;
    void vscode.window.showInformationMessage(`${msg}${rememberedSuffix}`);
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
    await markPayloadPending(payload, folder);
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
      // An endpoint file can outlive the server that wrote it. If we picked
      // this mode ourselves off that file, un-remember it so the next send
      // asks properly instead of failing the same way forever.
      if (detected?.mode === "mcp-channel") {
        await workspaceState.update(REMEMBERED_SEND_MODE_KEY, undefined);
      }
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
  intent: DispatchIntent = { kind: "address" },
  opts: { mcpAvailable?: boolean } = {},
): Promise<SendMode | null> {
  const items: Array<vscode.QuickPickItem & { mode: SendMode }> = [
    {
      label: "Send to active terminal",
      description: "Type the prompt into a running Claude REPL",
      mode: "terminal",
    },
    // Only offered when the tool server is actually up. Listing a mode that
    // can't work is worse than not listing it.
    ...(opts.mcpAvailable
      ? [
          {
            label: "Send to terminal + use the review tools",
            description: "Claude edits through the editor (undoable, checked before it writes)",
            mode: "mcp" as SendMode,
          },
        ]
      : []),
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
  const placeHolder =
    intent.kind === "review-request"
      ? `How to ask Claude to review${intent.hasFocus ? " (with focus)" : ""}? (Set markdownCollab.sendMode to skip this prompt.)`
      : `How to send ${unresolvedCount} unresolved comment${
          unresolvedCount === 1 ? "" : "s"
        } to Claude? (Set markdownCollab.sendMode to skip this prompt.)`;
  const pick = await vscode.window.showQuickPick(items, { placeHolder });
  return pick?.mode ?? null;
}

// -----------------------------------------------------------
// "Ask Claude to Review This Doc" (v2 Review Mode entry point)
// -----------------------------------------------------------

const RECENT_FOCUS_KEY = "markdownCollab.recentFocusHistory";
const RECENT_FOCUS_MAX = 5;
const FOCUS_MAX_LEN = 500;
const LARGE_DOC_WARN_BYTES = 50 * 1024;

const MARKDOWN_GLOB = "**/*.{md,markdown}";

function isMarkdownFsPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * What the user actually pointed at. Explorer context menus invoke a command
 * as `(clickedUri, allSelectedUris)`; everything else (palette, editor title)
 * passes one uri or nothing, in which case the active editor is the subject.
 */
function resolveSelection(arg?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
  if (Array.isArray(selected)) {
    const uris = selected.filter((u): u is vscode.Uri => u instanceof vscode.Uri);
    if (uris.length > 0) return uris;
  }
  if (arg instanceof vscode.Uri) return [arg];
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? [active] : [];
}

/**
 * Expand a selection of files and folders to the `.md` files it contains,
 * deduped and in path order. Folders are walked with the same exclusion the
 * Markdown Review tree uses, so a folder review covers exactly the files that
 * tree would show.
 */
async function expandMarkdownSelection(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
  const found = new Map<string, vscode.Uri>();
  for (const uri of uris) {
    let isDirectory = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      continue; // vanished between the click and here
    }
    if (isDirectory) {
      const matches = await vscode.workspace.findFiles(
        new vscode.RelativePattern(uri, MARKDOWN_GLOB),
        "**/node_modules/**",
      );
      for (const m of matches) found.set(m.fsPath, m);
    } else if (isMarkdownFsPath(uri.fsPath)) {
      found.set(uri.fsPath, uri);
    }
  }
  return [...found.values()].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

/**
 * Entry point for "Ask Claude to Review", for any selection shape: one file
 * (the original flow), a folder, or a multi-select. A multi-file selection
 * becomes ONE review pass so Claude can compare the files against each other.
 */
async function invokeAskClaudeToReviewSelection(
  selection: vscode.Uri[],
  output: vscode.OutputChannel,
  tracker: TerminalTracker,
  eventLogs: Map<string, EventLog>,
  workspaceState: vscode.Memento,
  globalState: vscode.Memento,
  delta = false,
): Promise<void> {
  if (selection.length === 0) {
    void vscode.window.showWarningMessage(
      "Open a Markdown file first, then run this command.",
    );
    return;
  }
  const files = await expandMarkdownSelection(selection);
  if (files.length === 0) {
    void vscode.window.showWarningMessage(
      selection.length === 1 && isMarkdownFsPath(selection[0].fsPath)
        ? `Could not read ${path.basename(selection[0].fsPath)}.`
        : "Ask Claude to Review only supports .md files — the selection contains none.",
    );
    return;
  }

  if (files.length === 1) {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(files[0]);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Failed to open ${files[0].fsPath}: ${(e as Error).message}`,
      );
      return;
    }
    await invokeAskClaudeToReview(doc, output, tracker, eventLogs, workspaceState, globalState, delta);
    return;
  }

  if (delta) {
    // A delta pass is per-file by construction: the checkpoint, the changed
    // sections, and the existing threads are all per-document. Reviewing a
    // folder incrementally would mean N prompts, which is a different feature.
    void vscode.window.showWarningMessage(
      "Review changes since last pass works on one file at a time. Open the file and run it again.",
    );
    return;
  }

  await invokeAskClaudeToReviewMulti(
    files,
    output,
    tracker,
    eventLogs,
    workspaceState,
    globalState,
  );
}

/**
 * One Review Mode pass over several files. Everything the single-file flow
 * does — soft size confirm, focus prompt, pending-review notification — but
 * the confirm is on the summed size and the payload lists every file.
 */
async function invokeAskClaudeToReviewMulti(
  uris: vscode.Uri[],
  output: vscode.OutputChannel,
  tracker: TerminalTracker,
  eventLogs: Map<string, EventLog>,
  workspaceState: vscode.Memento,
  globalState: vscode.Memento,
): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(uris[0]);
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Ask Claude to Review: the files must live inside a workspace folder.",
    );
    return;
  }
  // The payload's paths are relative to one folder and the event log lives in
  // one folder, so a selection spanning several is reviewed one folder at a
  // time rather than silently mixing incomparable relative paths.
  const inFolder = uris.filter(
    (u) => vscode.workspace.getWorkspaceFolder(u)?.uri.fsPath === folder.uri.fsPath,
  );
  const skipped = uris.length - inFolder.length;

  const files: ReviewFile[] = [];
  for (const uri of inFolder) {
    let bytes = 0;
    try {
      bytes = (await vscode.workspace.fs.stat(uri)).size;
    } catch {
      // Unreadable size is not a reason to drop the file from the review;
      // it only makes the soft confirm slightly optimistic.
    }
    files.push({ rel: workspaceRelPosix(folder, uri), bytes });
  }

  const total = totalBytes(files);
  if (total > LARGE_DOC_WARN_BYTES) {
    const kb = Math.round(total / 1024);
    const pick = await vscode.window.showWarningMessage(
      `Reviewing ${files.length} files (${kb} KB total) — Claude's review may take a while and use significant context.`,
      { modal: false },
      "Continue",
      "Cancel",
    );
    if (pick !== "Continue") return;
  }

  const focus = await promptForFocus(globalState);
  if (focus === undefined) return; // user cancelled
  const trimmedFocus = focus === "" ? undefined : focus;
  if (trimmedFocus) await pushRecentFocus(globalState, trimmedFocus);

  const payload = buildMultiFileReviewPayload(files, trimmedFocus);

  // Snapshot thread state in every open panel for the selection, so each one
  // scrolls to Claude's first new thread when the pass lands.
  for (const uri of inFolder) InlineCommentsPanel.notifyReviewPending(uri);

  if (skipped > 0) {
    output.appendLine(
      `Ask Claude to Review: skipped ${skipped} file(s) outside ${folder.name}.`,
    );
    void vscode.window.showInformationMessage(
      `Reviewing ${files.length} file(s) in ${folder.name}; ${skipped} outside it were skipped — run the command again from that folder.`,
    );
  }

  await dispatchReviewPayload(
    payload,
    output,
    tracker,
    eventLogs,
    workspaceState,
    folder,
    { kind: "review-request", hasFocus: Boolean(trimmedFocus) },
  );
}

/** Workspace-relative path with POSIX separators — it goes into a prompt. */
function workspaceRelPosix(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
}

/**
 * Walk every thread Claude opened and the human hasn't answered yet, across
 * all files in the Markdown Review tree. Each invocation advances one thread
 * and wraps at the end; the cursor is module state, so the walk survives
 * switching editors but not a window reload (by design — a reload should start
 * the pass over rather than resume mid-list from stale positions).
 */
let unreadWalkCursor: { docPath: string; threadId: string } | null = null;

async function invokeNextUnreadFromClaude(
  reviewView: ReviewView,
  output: vscode.OutputChannel,
): Promise<void> {
  await reviewView.ensureScanned();
  const unread = reviewView.listClaudeUnread();
  if (unread.length === 0) {
    unreadWalkCursor = null;
    void vscode.window.showInformationMessage(
      "No unread threads from Claude. Run 'Ask Claude to Review' to start a pass.",
    );
    return;
  }
  const currentIdx = unreadWalkCursor
    ? unread.findIndex(
        (u) =>
          u.docPath === unreadWalkCursor?.docPath &&
          u.thread.id === unreadWalkCursor?.threadId,
      )
    : -1;
  const next = unread[(currentIdx + 1) % unread.length];
  unreadWalkCursor = { docPath: next.docPath, threadId: next.thread.id };

  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(next.docPath));
    const anchor = parseInline(doc.getText()).anchors.get(next.thread.id);
    // Select the anchored passage itself (between the markers) so the thread's
    // subject is highlighted, not the marker comment around it.
    const selection = anchor
      ? new vscode.Range(
          doc.positionAt(anchor.openEnd),
          doc.positionAt(anchor.closeStart),
        )
      : undefined;
    await vscode.window.showTextDocument(doc, {
      selection,
      preview: false,
    });
  } catch (e) {
    output.appendLine(
      `Next unread failed for ${next.docPath}: ${(e as Error).message}`,
    );
    void vscode.window.showErrorMessage(
      `Could not open ${path.basename(next.docPath)}.`,
    );
    return;
  }
  const position = ((currentIdx + 1) % unread.length) + 1;
  void vscode.window.setStatusBarMessage(
    `Unread from Claude ${position}/${unread.length} — ${path.basename(next.docPath)}`,
    5000,
  );
}

async function invokeAskClaudeToReview(
  doc: vscode.TextDocument,
  output: vscode.OutputChannel,
  tracker: TerminalTracker,
  eventLogs: Map<string, EventLog>,
  workspaceState: vscode.Memento,
  globalState: vscode.Memento,
  /** Review only what changed since the last recorded pass (10x-plan-2 P1.1). */
  delta = false,
): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Ask Claude to Review: the file must live inside a workspace folder.",
    );
    return;
  }

  // Soft size confirm — large docs may take a while; let the user back out.
  const byteSize = Buffer.byteLength(doc.getText(), "utf8");
  if (byteSize > LARGE_DOC_WARN_BYTES) {
    const kb = Math.round(byteSize / 1024);
    const pick = await vscode.window.showWarningMessage(
      `This file is ${kb} KB — Claude's review may take a while and use significant context.`,
      { modal: false },
      "Continue",
      "Cancel",
    );
    if (pick !== "Continue") return;
  }

  const focus = await promptForFocus(globalState);
  if (focus === undefined) return; // user cancelled
  const trimmedFocus = focus === "" ? undefined : focus;

  const result = buildReviewRequestPayload(doc, trimmedFocus, { delta });
  if (result.kind === "no-workspace") {
    void vscode.window.showWarningMessage(
      "Ask Claude to Review: the file must live inside a workspace folder.",
    );
    return;
  }
  if (result.kind === "unchanged") {
    // The whole point of a delta pass is not re-reading an unchanged file.
    void vscode.window.showInformationMessage(
      `Nothing has changed in ${path.basename(doc.uri.fsPath)} since Claude's last review pass.`,
    );
    return;
  }
  if (delta && result.fullPass) {
    void vscode.window.showInformationMessage(
      "No previous review pass is recorded for this file — reviewing all of it. The next pass can be incremental.",
    );
  }

  if (trimmedFocus) await pushRecentFocus(globalState, trimmedFocus);

  // Snapshot current thread state in any open InlineCommentsPanel for this
  // doc BEFORE dispatching. The panel will auto-scroll to the first newly
  // arrived claude-initiated thread once Claude finishes its pass.
  InlineCommentsPanel.notifyReviewPending(doc.uri);

  await dispatchReviewPayload(
    result.payload,
    output,
    tracker,
    eventLogs,
    workspaceState,
    folder,
    { kind: "review-request", hasFocus: Boolean(trimmedFocus) },
  );
}

/**
 * Returns the focus string the user wants Claude to use, "" for an
 * explicit general review (no focus), or `undefined` if the user
 * cancelled. When there is recent-focus history, a quick-pick is shown
 * first with the option to reuse a prior focus or enter a new one.
 */
async function promptForFocus(
  globalState: vscode.Memento,
): Promise<string | undefined> {
  const history = readRecentFocus(globalState);
  if (history.length > 0) {
    interface FocusItem extends vscode.QuickPickItem {
      tag: "history" | "custom" | "general";
      value?: string;
    }
    const items: FocusItem[] = [
      {
        label: "$(edit) Enter a new focus…",
        description: "Tell Claude what to look for",
        tag: "custom",
      },
      {
        label: "$(eye) General review (no focus)",
        description: "Let Claude flag anything substantive",
        tag: "general",
      },
      ...history.map<FocusItem>((h) => ({
        label: `$(history) ${h}`,
        tag: "history",
        value: h,
      })),
    ];
    const pick = await vscode.window.showQuickPick<FocusItem>(items, {
      placeHolder: "What should Claude look for?",
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.tag === "general") return "";
    if (pick.tag === "history" && pick.value) return pick.value;
    // fall through to InputBox for "custom"
  }
  const entered = await vscode.window.showInputBox({
    prompt: "What should Claude look for? (leave blank for a general review)",
    placeHolder: "e.g. check API examples for correctness",
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (v.length > FOCUS_MAX_LEN) {
        return `Focus is too long (${v.length}/${FOCUS_MAX_LEN}). Shorten or split into multiple review passes.`;
      }
      if (/[\r\n]/.test(v)) {
        return "Focus must be a single line — newlines would inject extra instructions into the prompt.";
      }
      return null;
    },
  });
  if (entered === undefined) return undefined;
  return entered.trim();
}

function readRecentFocus(globalState: vscode.Memento): string[] {
  const raw = globalState.get<unknown>(RECENT_FOCUS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

async function pushRecentFocus(
  globalState: vscode.Memento,
  focus: string,
): Promise<void> {
  const prior = readRecentFocus(globalState).filter((f) => f !== focus);
  const next = [focus, ...prior].slice(0, RECENT_FOCUS_MAX);
  await globalState.update(RECENT_FOCUS_KEY, next);
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


/**
 * Repair damaged comment anchors in a markdown file.
 *
 * Only ever touches markers and the threads region — `repairIntegrity`
 * abandons the whole batch if a repair would alter prose — and the edit goes
 * through a WorkspaceEdit so it lands in the undo stack like any other change.
 */
async function invokeRepairInlineComments(
  output: vscode.OutputChannel,
  fsPathArg?: string,
): Promise<void> {
  const fsPath = fsPathArg ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!fsPath) {
    void vscode.window.showWarningMessage("Open a markdown file to repair its comment anchors.");
    return;
  }
  const uri = vscode.Uri.file(fsPath);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not open ${path.basename(fsPath)}: ${(e as Error).message}`);
    return;
  }

  const before = doc.getText();
  const result = repairIntegrity(before);
  if (result.repairs.length === 0) {
    const remaining = result.remaining.length;
    void vscode.window.showInformationMessage(
      remaining === 0
        ? "No comment-anchor problems found."
        : `Nothing could be repaired automatically; ${remaining} problem(s) need a manual fix.`,
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), result.source);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage("Could not apply the comment-anchor repair.");
    return;
  }
  for (const r of result.repairs) output.appendLine(`Repair [${path.basename(fsPath)}] ${r.description}`);
  const remaining = result.remaining.length;
  void vscode.window.showInformationMessage(
    remaining === 0
      ? `Repaired ${result.repairs.length} comment-anchor problem(s).`
      : `Repaired ${result.repairs.length}; ${remaining} still need a manual fix.`,
  );
}
