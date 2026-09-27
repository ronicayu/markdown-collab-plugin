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
import { CONVENTIONS_REL, withConventions } from "../reviewConventions";
import {
  mcpToolsDirective,
  type ReviewPayload,
  type SendMode,
} from "../sendToClaude";
import {
  CHANGE_HINT,
  detectSendMode,
  type SendModeDetection,
} from "../transports/detectSendMode";
import { buildSendModeItems } from "../transports/sendModePicker";
import { sendViaTerminal, startClaudeTerminal } from "../transports/terminal";
import type { TerminalTracker } from "../transports/terminalTracker";
import {
  cancelHeadlessRuns,
  headlessAvailability,
  headlessStatusSnapshot,
  resetHeadlessFailures,
  runHeadless,
} from "../transports/headlessHost";
import { unavailableReasonText } from "../transports/headless";
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
  return v === "headless" || v === "terminal" || v === "clipboard";
}

/**
 * `mcp`, `channel`, `mcp-channel` (and the ancient `ipc`, renamed to `channel`
 * back in 0.11.0) all delivered to a terminal already — the ceremony around
 * them is what 10x-plan-4 P0.3 deleted. A value in this set, whether it came
 * from the setting or from a remembered workspace choice, now behaves exactly
 * like `terminal`; anything else that isn't a real mode is unrecognized
 * garbage and keeps the older "fall back to ask" behavior.
 */
const LEGACY_SEND_MODES = new Set(["mcp", "channel", "mcp-channel", "ipc"]);

export type SendModeNormalization =
  | { kind: "ok"; mode: SendMode }
  /** A retired value that now behaves like `terminal`. */
  | { kind: "legacy"; mode: "terminal" }
  /** Never a valid value — falls back to `ask` with a warning. */
  | { kind: "unknown"; mode: "ask" };

/** Pure so the legacy-normalization rules are unit-testable without vscode. */
export function normalizeSendModeValue(v: unknown): SendModeNormalization {
  if (v === "ask" || isConcreteSendMode(v)) return { kind: "ok", mode: v };
  if (LEGACY_SEND_MODES.has(v as string)) return { kind: "legacy", mode: "terminal" };
  return { kind: "unknown", mode: "ask" };
}

const LEGACY_SEND_MODE_TOAST_KEY = "markdownCollab.legacySendModeToastShown";

/**
 * The retirement notice fires once per workspace, not once per send — nobody
 * needs to be told twice that the mode they had picked no longer exists.
 */
export async function maybeShowLegacySendModeToast(workspaceState: vscode.Memento): Promise<void> {
  if (workspaceState.get<boolean>(LEGACY_SEND_MODE_TOAST_KEY)) return;
  await workspaceState.update(LEGACY_SEND_MODE_TOAST_KEY, true);
  void vscode.window.showInformationMessage(
    "Markdown Collab: that send mode was retired — sends now go to the Claude terminal. " +
      "Claude still uses the review tools when it has them.",
  );
}

async function invokeSendAllToClaude(
  doc: vscode.TextDocument,
  log: Logger,
  tracker: TerminalTracker,
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
  await dispatchReviewPayload(inlinePayload, log, tracker, workspaceState, folder);
}

/**
 * Record that Claude owes a reply on the threads this payload carries, so
 * every open view can show "Claude is working…" on them (10x-plan P1.2).
 *
 * Called from the delivery branches of `dispatchReviewPayload` rather than
 * from each command, so a new send path cannot forget it. Review-mode payloads
 * carry no comments and therefore mark nothing — they create threads instead
 * of addressing existing ones, so there is no card to annotate.
 *
 * Always "inferred": since 10x-plan-4 P0.3 no send path can claim protocol
 * evidence up front — a tool call is what earns that (see
 * `inlineComments/claudePending.ts`'s `noteActivity`), not the mode picked.
 */
async function markPayloadPending(
  payload: ReviewPayload,
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const threadIds = payload.comments.map((c) => c.id);
  if (threadIds.length === 0) return;
  try {
    const uri = vscode.Uri.joinPath(folder.uri, payload.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    claudePending.mark(uri.toString(), parseInline(doc.getText()).threads, threadIds, "inferred");
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
  workspaceState: vscode.Memento,
  folder: vscode.WorkspaceFolder,
  intent: DispatchIntent = { kind: "address" },
  /**
   * Skip mode resolution (config / remembered / detect / ask) entirely and
   * deliver through this mode for this one dispatch (10x-plan-4 P2.4's
   * empty-state "Review with Claude" button). Never persisted — the next
   * ordinary send still resolves the mode the normal way.
   */
  opts?: { forceMode?: SendMode },
): Promise<void> {
  const headlessLog = log.scope("headless");
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
  payload = {
    ...payload,
    prompt: withConventions(payload.prompt, conventions),
    ...(payload.inlineSkillPrompt !== undefined
      ? { inlineSkillPrompt: withConventions(payload.inlineSkillPrompt, conventions) }
      : {}),
  };
  log.trace("payload built", {
    promptChars: payload.prompt.length,
    conventions: conventions ? `${conventions.length} chars` : "none",
  });

  let mode: SendMode;
  let justRemembered = false;
  /** Set when this send's mode was auto-detected rather than chosen. */
  let detected: SendModeDetection | null = null;
  if (opts?.forceMode) {
    // The caller already decided — e.g. the empty-state card's button, which
    // exists specifically so headless can run without a detour through the
    // picker. Config, remembered choice, and auto-detect are all skipped.
    mode = opts.forceMode;
    log.info("send mode forced for this dispatch", { mode });
  } else {
    const config = vscode.workspace.getConfiguration("markdownCollab");
    const rawMode = config.get<unknown>("sendMode", "ask");
    const normalizedMode = normalizeSendModeValue(rawMode);
    mode = normalizedMode.mode;
    if (normalizedMode.kind === "legacy") {
      log.info("legacy sendMode setting normalized to terminal", { rawMode: String(rawMode) });
      await maybeShowLegacySendModeToast(workspaceState);
    } else if (normalizedMode.kind === "unknown") {
      log.warn(
        `markdownCollab.sendMode "${String(rawMode)}" is not recognized; falling back to "ask". ` +
          `Valid values: ask, headless, terminal, clipboard.`,
      );
      void vscode.window.showWarningMessage(
        `markdownCollab.sendMode "${String(rawMode)}" is no longer supported — falling back to ask. Update your settings to one of: headless, terminal, clipboard.`,
      );
    }
    if (mode === "ask") {
      const remembered = workspaceState.get<unknown>(REMEMBERED_SEND_MODE_KEY);
      const rememberedNormalized = normalizeSendModeValue(remembered);
      if (rememberedNormalized.kind === "legacy") {
        mode = rememberedNormalized.mode;
        log.trace("remembered send mode was retired; using terminal", { remembered: String(remembered) });
        await maybeShowLegacySendModeToast(workspaceState);
        await workspaceState.update(REMEMBERED_SEND_MODE_KEY, mode);
      } else if (isConcreteSendMode(remembered)) {
        mode = remembered;
        log.trace("using the send mode remembered for this workspace", { mode });
      } else {
        // Before asking, look at what's actually running. A visible Claude REPL
        // answers the question the quick-pick was asking, and the user has no
        // way to make that call better than we can.
        detected = detectSendMode({ claudeTerminal: tracker.anyClaudeTerminal() });
        if (detected) {
          mode = detected.mode;
          log.info("send mode auto-detected", { mode: detected.mode, reason: detected.reason });
        } else {
          // Headless is offered only when it would actually run — never
          // auto-selected: nothing but the human's pick chooses it.
          const headless = await headlessAvailability(workspaceState, headlessLog);
          const picked = await pickSendMode(payload.unresolvedCount, intent, {
            terminalDetected: tracker.anyClaudeTerminal(),
            headlessAvailable: headless.ok,
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
  }

  const rememberedSuffix = detected
    ? ` Send mode auto-detected.${CHANGE_HINT}`
    : justRemembered
      ? ' Run "Markdown Collab: Reset Send Mode" to change later.'
      : "";

  log.info("delivering", { mode, file: payload.file });

  // Appended unconditionally: it's harmless when the tools aren't in Claude's
  // tool list (the skill's own CLI fallback covers that case), and folding
  // `mcp` into `terminal` only works because this line no longer needs a mode
  // of its own to gate it (10x-plan-4 P0.3). Not for headless: there the tools
  // are the only way to act, and the system prompt already says so.
  const delivered: ReviewPayload = {
    ...payload,
    prompt: `${payload.prompt}\n\n${mcpToolsDirective()}`,
  };

  /**
   * The terminal delivery. A closure rather than a sibling function because a
   * headless run can hand the same payload back here after it has started —
   * MCP turned out to be unavailable, or the human signed in and asked for it.
   */
  const deliverToTerminal = async (suffix: string): Promise<void> => {
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
      chars: delivered.prompt.length,
    });
    await markPayloadPending(payload, folder);
    const msg =
      intent.kind === "review-request"
        ? `Claude is reviewing — threads will appear when it's done. (Sent to "${sendResult.terminalName}".)`
        : `Sent to "${sendResult.terminalName}".`;
    void vscode.window.showInformationMessage(`${msg}${suffix}`);
  };

  if (mode === "headless") {
    // Checked at send time, not only when the picker offered it: a remembered
    // or configured `headless` outlives the conditions that made it work.
    const headless = await headlessAvailability(workspaceState, headlessLog);
    if (headless.ok) {
      await markPayloadPending(payload, folder);
      const outcome = await runHeadless({
        payload,
        prompt: payload.inlineSkillPrompt ?? payload.prompt,
        folder,
        log: headlessLog,
        workspaceState,
        ready: headless,
        fallbackToTerminal: () => deliverToTerminal(""),
        startTerminal: () => {
          startClaudeTerminal(tracker, log);
        },
      });
      // Progress is the status bar's job; a toast here would be a progress
      // toast. The one exception is the first send after picking the mode,
      // which is also the moment to say where the choice can be undone.
      if (outcome === "started" && (justRemembered || detected)) {
        void vscode.window.showInformationMessage(
          `Claude is working in the background — watch the status bar.${rememberedSuffix}`,
        );
      }
      return;
    }
    log.info("headless unavailable; sending to the terminal instead", {
      reason: headless.reason,
      detail: headless.detail,
    });
    void vscode.window.showWarningMessage(
      `Markdown Collab: couldn't run Claude for you — ${unavailableReasonText(headless.reason)}. ` +
        "Sending to your Claude terminal instead.",
    );
    mode = "terminal";
  }

  if (mode === "clipboard") {
    await vscode.env.clipboard.writeText(delivered.prompt);
    log.info("prompt copied to the clipboard", { chars: delivered.prompt.length });
    const msg =
      intent.kind === "review-request"
        ? `Review-request prompt for \`${payload.file}\` copied — paste into Claude Code.`
        : `Prompt for ${payload.unresolvedCount} comment${
            payload.unresolvedCount === 1 ? "" : "s"
          } copied — paste into Claude Code.`;
    void vscode.window.showInformationMessage(`${msg}${rememberedSuffix}`);
    return;
  }

  // mode === "terminal": the only delivery left.
  await deliverToTerminal(rememberedSuffix);
}

async function pickSendMode(
  unresolvedCount: number,
  intent: DispatchIntent = { kind: "address" },
  opts: { terminalDetected: boolean; headlessAvailable: boolean },
): Promise<SendMode | null> {
  const items: Array<vscode.QuickPickItem & { mode: SendMode }> = buildSendModeItems(opts);
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
  const { context, sendLog, terminalTracker } = deps;
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
        // A clipboard delivery like any other — same unconditional directive.
        await vscode.env.clipboard.writeText(`${payload.prompt}\n\n${mcpToolsDirective()}`);
        void vscode.window.showInformationMessage(
          "Thread prompt copied — paste into Claude Code.",
        );
      },
    ),
    vscode.commands.registerCommand("markdownCollab.resetSendMode", async () => {
      await context.workspaceState.update(REMEMBERED_SEND_MODE_KEY, undefined);
      // "Run Claude for me" failing here once shouldn't hide it forever: a
      // reset is the human saying the environment changed.
      await resetHeadlessFailures(context.workspaceState);
      void vscode.window.showInformationMessage(
        "Markdown Collab: Send mode reset. Next click will prompt again.",
      );
    }),
    // Internal (not in the palette): the status bar's "Cancel run", and a
    // plain-data view of headless state for diagnostics and the integration
    // suite, which runs in the same host but can't reach module state inside
    // the bundle any other way.
    vscode.commands.registerCommand("markdownCollab.cancelHeadlessRun", () => cancelHeadlessRuns()),
    // A window closing mid-run must not leave a Claude working, and billing,
    // against a tool server that no longer exists.
    { dispose: () => void cancelHeadlessRuns() },
    vscode.commands.registerCommand("markdownCollab.headlessStatus", () =>
      headlessStatusSnapshot(context.workspaceState, sendLog.scope("headless")),
    ),
  );
}
