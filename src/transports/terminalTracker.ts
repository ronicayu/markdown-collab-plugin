import * as vscode from "vscode";
import { terminalActivity, type Activity, type ShellEvent } from "./terminalTarget";

const CLAUDE_CMD_RE = /^claude(?:\s|$)/;

// Shell-integration events exist from VS Code 1.93; older hosts record nothing, so activity falls back to the terminal's name.
export class TerminalTracker implements vscode.Disposable {
  private readonly events = new Map<vscode.Terminal, ShellEvent>();
  private target: vscode.Terminal | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public activate(subs: vscode.Disposable[]): void {
    const startEvent = (
      vscode.window as unknown as {
        onDidStartTerminalShellExecution?: vscode.Event<{
          terminal: vscode.Terminal;
          execution: { commandLine: { value: string } };
        }>;
        onDidEndTerminalShellExecution?: vscode.Event<{
          terminal: vscode.Terminal;
          execution: { commandLine: { value: string } };
        }>;
      }
    );

    if (typeof startEvent.onDidStartTerminalShellExecution === "function") {
      this.disposables.push(
        startEvent.onDidStartTerminalShellExecution((e) => {
          const command = (e.execution.commandLine.value ?? "").trim();
          this.events.set(e.terminal, { kind: "start", command });
        }),
      );
    }
    if (typeof startEvent.onDidEndTerminalShellExecution === "function") {
      this.disposables.push(
        startEvent.onDidEndTerminalShellExecution((e) => {
          this.events.set(e.terminal, { kind: "end" });
        }),
      );
    }

    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        this.events.delete(t);
        if (this.target === t) this.target = undefined;
      }),
    );
    for (const d of this.disposables) subs.push(d);
  }

  public get lastTarget(): vscode.Terminal | undefined {
    return this.target;
  }

  public setLastTarget(t: vscode.Terminal): void {
    this.target = t;
  }

  public markClaudeStarted(t: vscode.Terminal): void {
    this.events.set(t, { kind: "start", command: "claude" });
    this.target = t;
  }

  public activity(t: vscode.Terminal): Activity {
    return terminalActivity(this.events.get(t), t.name);
  }

  public runningCommand(t: vscode.Terminal): string | undefined {
    const event = this.events.get(t);
    return event?.kind === "start" ? event.command : undefined;
  }

  // The running command, not the terminal's name: a terminal merely called "claude" must not count.
  public anyClaudeTerminal(): boolean {
    return vscode.window.terminals.some((t) => CLAUDE_CMD_RE.test(this.runningCommand(t) ?? ""));
  }

  public dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* swallow */
      }
    }
    this.events.clear();
    this.target = undefined;
  }
}
