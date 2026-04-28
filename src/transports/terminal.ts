import * as vscode from "vscode";
import type { ReviewPayload } from "../sendToClaude";
import type { TerminalTracker } from "./terminalTracker";

const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";

export type SendResult =
  | { ok: true; terminalName: string }
  | { ok: false; reason: "cancelled" | "no-target" };

interface Resolution {
  terminal: vscode.Terminal;
  reliability: "high" | "medium" | "low";
  source: string;
}

/**
 * Locate the best terminal to inject the prompt into.
 * Higher-reliability matches short-circuit lower ones.
 */
function resolveTerminal(tracker: TerminalTracker): Resolution | null {
  const terminals = vscode.window.terminals;

  for (const t of terminals) {
    if (tracker.isOwned(t)) {
      return { terminal: t, reliability: "high", source: "owned" };
    }
  }
  for (const t of terminals) {
    if (tracker.hasClaudeEvidence(t)) {
      return { terminal: t, reliability: "high", source: "shell-integration" };
    }
  }
  for (const t of terminals) {
    if (/claude/i.test(t.name)) {
      return { terminal: t, reliability: "medium", source: "name-match" };
    }
  }
  const active = vscode.window.activeTerminal;
  if (active) {
    return { terminal: active, reliability: "low", source: "active" };
  }
  return null;
}

/**
 * Inject the prompt into the resolved terminal using bracketed paste so
 * multi-line content lands as one TUI input rather than being split on
 * newlines. Returns whether the send actually happened (a confirmation
 * dialog can return false when reliability is medium/low).
 */
export async function sendViaTerminal(
  payload: ReviewPayload,
  tracker: TerminalTracker,
  options?: { offerStartTerminal?: () => Promise<vscode.Terminal | null> },
): Promise<SendResult> {
  let resolution = resolveTerminal(tracker);

  if (!resolution) {
    if (options?.offerStartTerminal) {
      const started = await options.offerStartTerminal();
      if (!started) return { ok: false, reason: "no-target" };
      resolution = { terminal: started, reliability: "high", source: "owned-just-spawned" };
    } else {
      return { ok: false, reason: "no-target" };
    }
  }

  if (resolution.reliability !== "high") {
    const choice = await vscode.window.showInformationMessage(
      `Send ${payload.unresolvedCount} unresolved comment${
        payload.unresolvedCount === 1 ? "" : "s"
      } to terminal "${resolution.terminal.name}"?`,
      { modal: false },
      "Send",
      "Cancel",
    );
    if (choice !== "Send") return { ok: false, reason: "cancelled" };
  }

  const { terminal } = resolution;
  terminal.sendText(BP_START + payload.prompt + BP_END, false);
  terminal.sendText("", true);
  terminal.show(true);
  return { ok: true, terminalName: terminal.name };
}

/**
 * Spawn a new terminal, run `claude`, and register it as ours so the
 * detection ladder picks it up on subsequent sends. Caller is responsible
 * for the post-spawn delay if it wants to inject immediately.
 */
export function startClaudeTerminal(tracker: TerminalTracker): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name: "Claude Review" });
  tracker.markOwned(terminal);
  terminal.sendText("claude", true);
  terminal.show(true);
  return terminal;
}
