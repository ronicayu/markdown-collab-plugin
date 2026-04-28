import * as vscode from "vscode";

const CLAUDE_CMD_RE = /^claude(?:\s|$)/;

/**
 * Tracks which terminals were spawned by us and which appear to have a
 * `claude` REPL running based on shell-integration command-execution events.
 *
 * The shell-integration events (`onDidStartTerminalShellExecution` /
 * `onDidEndTerminalShellExecution`) are stable from VS Code 1.93+. Older
 * hosts simply skip that detection layer — terminal injection still works
 * via the name-match and active-terminal fallbacks.
 */
export class TerminalTracker implements vscode.Disposable {
  private readonly owned = new Set<vscode.Terminal>();
  private readonly claudeRunning = new Map<vscode.Terminal, boolean>();
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
          const cmd = (e.execution.commandLine.value ?? "").trim();
          this.claudeRunning.set(e.terminal, CLAUDE_CMD_RE.test(cmd));
        }),
      );
    }
    if (typeof startEvent.onDidEndTerminalShellExecution === "function") {
      this.disposables.push(
        startEvent.onDidEndTerminalShellExecution((e) => {
          const cmd = (e.execution.commandLine.value ?? "").trim();
          if (CLAUDE_CMD_RE.test(cmd)) this.claudeRunning.set(e.terminal, false);
        }),
      );
    }

    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        this.owned.delete(t);
        this.claudeRunning.delete(t);
      }),
    );
    for (const d of this.disposables) subs.push(d);
  }

  public markOwned(t: vscode.Terminal): void {
    this.owned.add(t);
    // Owned-and-just-spawned implies claude is starting up; we set true so
    // the detection ladder picks the owned terminal even before any shell-
    // integration start event fires.
    this.claudeRunning.set(t, true);
  }

  public isOwned(t: vscode.Terminal): boolean {
    return this.owned.has(t);
  }

  public hasClaudeEvidence(t: vscode.Terminal): boolean {
    return this.claudeRunning.get(t) === true;
  }

  public dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* swallow */
      }
    }
    this.owned.clear();
    this.claudeRunning.clear();
  }
}
