import { vi } from "vitest";
import * as vscode from "vscode";

export interface FakeTerminal {
  name: string;
  sendText: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
}

export const fakeTerminal = (name: string): FakeTerminal => ({ name, sendText: vi.fn(), show: vi.fn() });

type Listener = (e: unknown) => void;

function emitter(): { event: (l: Listener) => { dispose(): void }; fire: Listener } {
  const listeners: Listener[] = [];
  return {
    event: (l) => {
      listeners.push(l);
      return { dispose: () => undefined };
    },
    fire: (e) => listeners.forEach((l) => l(e)),
  };
}

export function installFakeTerminalHost(opts: { withShellIntegration?: boolean } = {}) {
  const win = vscode.window as unknown as Record<string, unknown>;
  const started = emitter();
  const ended = emitter();
  const closed = emitter();
  const host = {
    terminals: [] as FakeTerminal[],
    activeTerminal: undefined as FakeTerminal | undefined,
    start: (terminal: FakeTerminal, command: string) =>
      started.fire({ terminal, execution: { commandLine: { value: command } } }),
    end: (terminal: FakeTerminal, command: string) =>
      ended.fire({ terminal, execution: { commandLine: { value: command } } }),
    close: (terminal: FakeTerminal) => {
      host.terminals = host.terminals.filter((t) => t !== terminal);
      closed.fire(terminal);
    },
    quickPick: vi.fn(),
    info: vi.fn(),
    clipboard: vi.fn(async () => undefined),
  };
  Object.defineProperty(win, "terminals", { get: () => host.terminals, configurable: true });
  Object.defineProperty(win, "activeTerminal", { get: () => host.activeTerminal, configurable: true });
  win.onDidCloseTerminal = closed.event;
  if (opts.withShellIntegration !== false) {
    win.onDidStartTerminalShellExecution = started.event;
    win.onDidEndTerminalShellExecution = ended.event;
  } else {
    delete win.onDidStartTerminalShellExecution;
    delete win.onDidEndTerminalShellExecution;
  }
  win.showQuickPick = host.quickPick;
  win.showInformationMessage = host.info;
  (vscode.env as unknown as { clipboard: { writeText: unknown } }).clipboard.writeText = host.clipboard;
  return host;
}
