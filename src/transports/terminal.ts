import * as vscode from "vscode";
import type { Logger } from "../logging";
import type { ReviewPayload } from "../sendToClaude";
import { chooseTarget, type TerminalCandidate } from "./terminalTarget";
import type { TerminalTracker } from "./terminalTracker";

const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";

export type SendResult =
  | { ok: true; terminalName: string }
  | { ok: false; reason: "cancelled" | "no-target" | "copied" };

async function copyInstead(payload: ReviewPayload): Promise<SendResult> {
  await vscode.env.clipboard.writeText(payload.prompt);
  void vscode.window.showInformationMessage("Prompt copied — paste into your agent.");
  return { ok: false, reason: "copied" };
}

async function declineOrCopy(
  payload: ReviewPayload,
  message: string,
  dismissed: SendResult,
): Promise<SendResult> {
  const choice = await vscode.window.showInformationMessage(message, "Copy instead");
  return choice === "Copy instead" ? copyInstead(payload) : dismissed;
}

export async function sendViaTerminal(
  payload: ReviewPayload,
  tracker: TerminalTracker,
  options?: { log?: Logger },
): Promise<SendResult> {
  const log = options?.log;
  const terminals: TerminalCandidate<vscode.Terminal>[] = vscode.window.terminals.map((t) => ({
    terminal: t,
    name: t.name,
    activity: tracker.activity(t),
    command: tracker.runningCommand(t),
  }));
  const decision = chooseTarget(terminals, vscode.window.activeTerminal, tracker.lastTarget);

  const write = (terminal: vscode.Terminal): SendResult => {
    // Bracketed paste, so a multi-line prompt lands as one input.
    terminal.sendText(BP_START + payload.prompt + BP_END, false);
    terminal.sendText("", true);
    terminal.show(true);
    tracker.setLastTarget(terminal);
    log?.trace("bracketed paste written", {
      terminal: terminal.name,
      chars: payload.prompt.length,
    });
    return { ok: true, terminalName: terminal.name };
  };

  let picked: vscode.Terminal | undefined;
  let result: SendResult;

  switch (decision.kind) {
    case "send":
      picked = decision.terminal;
      result = write(picked);
      break;
    case "pick": {
      const choice = await vscode.window.showQuickPick(
        decision.terminals.map((c) => ({ label: c.name, description: c.command, terminal: c.terminal })),
        { placeHolder: "Which terminal should get the prompt?" },
      );
      picked = choice?.terminal;
      result = picked ? write(picked) : { ok: false, reason: "cancelled" };
      break;
    }
    case "confirm": {
      const choice = await vscode.window.showInformationMessage(
        `Send to terminal "${decision.terminal.name}"? Markdown Collab can't tell what's running there.`,
        "Send",
        "Copy instead",
      );
      if (choice === "Send") {
        picked = decision.terminal;
        result = write(picked);
      } else {
        result = choice === "Copy instead" ? await copyInstead(payload) : { ok: false, reason: "cancelled" };
      }
      break;
    }
    case "idle":
      result = await declineOrCopy(
        payload,
        "Nothing is running in your terminals. Start your agent in one, then Send again.",
        { ok: false, reason: "no-target" },
      );
      break;
    case "none":
      result = await declineOrCopy(
        payload,
        "No terminal open. Start your agent in a terminal, then Send again.",
        { ok: false, reason: "no-target" },
      );
      break;
  }

  log?.trace("terminal resolution", {
    decision: decision.kind,
    picked: picked?.name ?? null,
    terminals: terminals.map((c) => ({ name: c.name, activity: c.activity })),
  });
  return result;
}

export function startClaudeTerminal(tracker: TerminalTracker, log?: Logger): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name: "Claude Review" });
  log?.info("spawned a Claude terminal");
  tracker.markClaudeStarted(terminal);
  terminal.sendText("claude", true);
  terminal.show(true);
  return terminal;
}
