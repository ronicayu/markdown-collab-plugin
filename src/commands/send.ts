// "Send to Claude" — mode picking, dispatch, and the commands that trigger it
// (10x-plan-4 P3.2 split of extension.ts).

import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { folderForDocument } from "../workspaceFolder";
import {
  buildInlinePayload,
  buildSingleThreadPayload,
} from "../inlineComments/sendToClaude";
import { parse as parseInline } from "../inlineComments/format";
import { claudePending } from "../claudePendingService";
import type { PendingEvidence } from "../inlineComments/claudePending";
import { CONVENTIONS_REL, withConventions } from "../reviewConventions";
import {
  mcpToolsDirective,
  type ReviewPayload,
  type SendMode,
} from "../sendToClaude";
import { currentMcpServer } from "../mcpServer";
import { EVENT_LOG_REL, EventLog } from "../transports/eventLog";
import { hasMcpChannelEndpoint, sendViaMcpChannel } from "../transports/mcpChannel";
import {
  CHANGE_HINT,
  detectSendMode,
  type SendModeDetection,
} from "../transports/detectSendMode";
import { sendViaTerminal, startClaudeTerminal } from "../transports/terminal";
import type { TerminalTracker } from "../transports/terminalTracker";
import type { CommandDeps } from "./deps";

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

async function invokeCopyClaudePrompt(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") {
    void vscode.window.showWarningMessage(
      "Open a Markdown file first, then run this command.",
    );
    return;
  }
  const doc = editor.document;
  const folder = folderForDocument(doc.uri);
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
  log: Logger,
  tracker: TerminalTracker,
  eventLogs: Map<string, EventLog>,
  workspaceState: vscode.Memento,
): Promise<void> {
  const folder = folderForDocument(doc.uri);
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
    log,
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
export async function dispatchReviewPayload(
  payload: ReviewPayload,
  log: Logger,
  tracker: TerminalTracker,
  eventLogs: Map<string, EventLog>,
  workspaceState: vscode.Memento,
  folder: vscode.WorkspaceFolder,
  intent: DispatchIntent = { kind: "address" },
): Promise<void> {
  // Every send starts here, so this is the line that tells a stuck dispatch
  // apart from one that never began.
  log.info("dispatch requested", {
    file: payload.file,
    intent: intent.kind,
    unresolved: payload.unresolvedCount,
    threads: payload.comments.length,
  });

  // Standing conventions ride along on every dispatch, whatever the mode
  // (10x-plan-2 P1.2). Done here rather than in each payload builder so no send
  // path can be the one that forgets them.
  const conventions = await readConventions(folder);
  payload = { ...payload, prompt: withConventions(payload.prompt, conventions) };
  log.trace("payload built", {
    promptChars: payload.prompt.length,
    conventions: conventions ? `${conventions.length} chars` : "none",
  });

  const config = vscode.workspace.getConfiguration("markdownCollab");
  const rawMode = config.get<unknown>("sendMode", "ask");
  let mode = normalizeSendMode(rawMode);
  if (mode !== rawMode) {
    log.warn(
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
      log.trace("using the send mode remembered for this workspace", { mode });
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
        log.info("send mode auto-detected", { mode: detected.mode, reason: detected.reason });
      } else {
        // MCP is offered, never auto-selected: it can be disabled entirely on
        // Claude's side (enterprise policy, --strict-mcp-config), so a default
        // that depends on it would silently break for those users.
        const picked = await pickSendMode(payload.unresolvedCount, intent, {
          mcpAvailable: currentMcpServer() !== null,
        });
        if (!picked) {
          log.info("send cancelled at the mode picker");
          return;
        }
        mode = picked;
        log.info("send mode picked by the user", { mode });
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

  log.info("delivering", { mode, file: payload.file });

  if (mode === "clipboard") {
    await vscode.env.clipboard.writeText(payload.prompt);
    log.info("prompt copied to the clipboard", { chars: payload.prompt.length });
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
    log.warn("send mode mcp requested but the tool server is not running; falling back to terminal");
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
      log,
      offerStartTerminal: async () => {
        const choice = await vscode.window.showInformationMessage(
          "No Claude terminal detected.",
          { modal: false },
          "Start Claude in new terminal",
          "Switch to clipboard",
          "Cancel",
        );
        log.info("no Claude terminal detected", { choice: choice ?? "dismissed" });
        if (choice === "Start Claude in new terminal") {
          const terminal = startClaudeTerminal(tracker, log);
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
      log.warn("send abandoned: no terminal to deliver to");
      return;
    }
    if (!sendResult.ok) {
      log.info("send cancelled", { reason: sendResult.reason });
      return;
    }
    log.info("delivered to terminal", {
      terminal: sendResult.terminalName,
      mode,
      chars: delivered.prompt.length,
    });
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
    let eventLog = eventLogs.get(folderKey);
    if (!eventLog) {
      eventLog = new EventLog(folderKey);
      eventLogs.set(folderKey, eventLog);
    }
    let envelope;
    try {
      envelope = await eventLog.append(payload);
    } catch (e) {
      log.error("event log append failed", e);
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
    log.info("mcp-channel push", { ok: result.ok, reason: result.ok ? undefined : result.reason });
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
      log.error("mcp-channel push failed", { reason: result.reason, detail: result.detail });
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

/** Register the "Send to Claude" family of commands. */
export function registerSendCommands(deps: CommandDeps): void {
  const { context, sendLog, terminalTracker, eventLogs } = deps;
  context.subscriptions.push(
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
    vscode.commands.registerCommand("markdownCollab.copyClaudePrompt", async () => {
      await invokeCopyClaudePrompt();
    }),
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
          sendLog,
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
        const folder = folderForDocument(doc.uri);
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
          sendLog,
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
}
