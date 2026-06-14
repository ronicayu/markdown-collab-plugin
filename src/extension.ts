import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ensureAgentsSnippet } from "./agents";
import { CollabEditorProvider } from "./collab/collabEditorProvider";
import { InlineCommentsPanel } from "./inlineComments/inlineCommentsPanel";
import { PrReviewController } from "./pr/prReviewController";
import { ReviewView, type ReviewNode } from "./reviewView";
import {
  buildReviewRequestPayload,
  type ReviewPayload,
  type SendMode,
} from "./sendToClaude";
import { buildInlinePayload, buildSingleThreadPayload } from "./inlineComments/sendToClaude";
import { checkClaudeSkill, installClaudeSkill, skillFingerprint } from "./skill";
import { EVENT_LOG_REL, EventLog } from "./transports/eventLog";
import { sendViaMcpChannel } from "./transports/mcpChannel";
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
        const payload = buildSingleThreadPayload(doc, threadId);
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
        const payload = buildSingleThreadPayload(doc, threadId);
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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "markdownCollab.askClaudeToReview",
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
        if (doc.languageId !== "markdown" && !uri.fsPath.toLowerCase().endsWith(".md")) {
          void vscode.window.showWarningMessage(
            "Ask Claude to Review only supports .md files.",
          );
          return;
        }
        await invokeAskClaudeToReview(
          doc,
          output,
          terminalTracker,
          eventLogs,
          context.workspaceState,
          context.globalState,
        );
      },
    ),
  );

  // On startup, nudge the user to install/update the Claude skill if it's
  // missing or out of date — otherwise they only find out by opening the
  // comments panel. Gated per skill version so it prompts once, not every time.
  void maybePromptSkillUpdate(context, output);
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
  const inlinePayload = buildInlinePayload(doc);
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
      const picked = await pickSendMode(payload.unresolvedCount, intent);
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
    const msg =
      intent.kind === "review-request"
        ? `Review-request prompt for \`${payload.file}\` copied — paste into Claude Code.`
        : `Prompt for ${payload.unresolvedCount} comment${
            payload.unresolvedCount === 1 ? "" : "s"
          } copied — paste into Claude Code.`;
    void vscode.window.showInformationMessage(`${msg}${rememberedSuffix}`);
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
  intent: DispatchIntent = { kind: "address" },
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

async function invokeAskClaudeToReview(
  doc: vscode.TextDocument,
  output: vscode.OutputChannel,
  tracker: TerminalTracker,
  eventLogs: Map<string, EventLog>,
  workspaceState: vscode.Memento,
  globalState: vscode.Memento,
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

  const result = buildReviewRequestPayload(doc, trimmedFocus);
  if (result.kind === "no-workspace") {
    void vscode.window.showWarningMessage(
      "Ask Claude to Review: the file must live inside a workspace folder.",
    );
    return;
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

