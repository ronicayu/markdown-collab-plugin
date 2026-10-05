import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { addThread } from "../../../inlineComments/format";
import type { DispatchOutcome } from "../../../webviewShared/sidebarProtocol";

interface ShellExecutionEvent {
  terminal: vscode.Terminal;
}
const shellEvents = vscode.window as unknown as {
  onDidStartTerminalShellExecution?: vscode.Event<ShellExecutionEvent>;
  onDidEndTerminalShellExecution?: vscode.Event<ShellExecutionEvent>;
};
const stubbable = vscode.window as unknown as { showInformationMessage: unknown; showQuickPick: unknown };

export const FIXTURE = "terminal-send-target.md";
export const FIRST_QUOTE = "sentence the thread is anchored to";
export const SECOND_QUOTE = "second sentence for the other thread";
export const SENTINEL = "cleared-by-test";
export const IDLE_MESSAGE = "Nothing is running in your terminals. Start your agent in one, then Send again.";
export const NO_TERMINAL_MESSAGE = "No terminal open. Start your agent in a terminal, then Send again.";

export const posixSuite = process.platform === "win32" ? suite.skip : suite;

export type PickItem = vscode.QuickPickItem & { mode?: string };
export interface Dialogs {
  messages: string[];
  picks: PickItem[][];
}
interface DialogOptions {
  reply?: string;
  choose?: (items: PickItem[]) => PickItem | undefined;
}

export function pickMode(mode: string): (items: PickItem[]) => PickItem | undefined {
  return (items) => items.find((item) => item.mode === mode);
}

export function hasShellEvents(): boolean {
  return Boolean(shellEvents.onDidStartTerminalShellExecution && shellEvents.onDidEndTerminalShellExecution);
}

export async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.getExtension("markdown-collab.markdown-collab-plugin");
  assert.ok(ext, "extension not loaded");
  if (!ext.isActive) await ext.activate();
}

export async function waitFor(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function seen(event: vscode.Event<ShellExecutionEvent>, terminal: vscode.Terminal): { count: () => number; dispose: () => void } {
  let count = 0;
  const sub = event((e) => {
    if (e.terminal === terminal) count += 1;
  });
  return { count: () => count, dispose: () => sub.dispose() };
}

export function startsIn(terminal: vscode.Terminal): { count: () => number; dispose: () => void } {
  return seen(shellEvents.onDidStartTerminalShellExecution!, terminal);
}

export async function disposeAllTerminals(): Promise<void> {
  for (const t of vscode.window.terminals) t.dispose();
  await waitFor(() => vscode.window.terminals.length === 0, "terminals did not close");
}

export async function openTerminal(options?: vscode.TerminalOptions): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal(options ?? {});
  terminal.show();
  await waitFor(() => vscode.window.activeTerminal === terminal, "terminal never became active");
  await waitFor(
    () => (terminal as unknown as { shellIntegration?: unknown }).shellIntegration !== undefined,
    "shell integration never attached",
  );
  return terminal;
}

export async function runningCat(name: string, file: string): Promise<vscode.Terminal> {
  const terminal = await openTerminal({ name });
  const started = startsIn(terminal);
  try {
    terminal.sendText(`cat > '${file}'`);
    await waitFor(() => started.count() === 1, `cat never reported a start in ${name}`);
  } finally {
    started.dispose();
  }
  return terminal;
}

export async function idleTerminal(name: string): Promise<vscode.Terminal> {
  const terminal = await openTerminal({ name });
  const started = startsIn(terminal);
  const ended = seen(shellEvents.onDidEndTerminalShellExecution!, terminal);
  try {
    terminal.sendText("true");
    await waitFor(() => started.count() === 1 && ended.count() === 1, `true never reported a start and an end in ${name}`);
  } finally {
    started.dispose();
    ended.dispose();
  }
  return terminal;
}

export function received(file: string): Promise<string> {
  return fs.readFile(file, "utf-8").catch(() => "");
}

export function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

let barriers = 0;

// Input reaches cat in order, so everything sent before the marker is in the file once the marker is.
export async function settled(terminal: vscode.Terminal, file: string): Promise<string> {
  const marker = `barrier-${++barriers}-end`;
  terminal.sendText(marker);
  let text = "";
  await waitFor(async () => {
    text = await received(file);
    return text.includes(marker);
  }, `${marker} never reached ${file}`);
  return text.slice(0, text.indexOf(marker));
}

export function sendAll(uri: vscode.Uri): Thenable<DispatchOutcome> {
  return vscode.commands.executeCommand<DispatchOutcome>("markdownCollab.sendAllToClaude", uri);
}

export async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const current = stubbable.showInformationMessage;
  stubbable.showInformationMessage = () => Promise.resolve(undefined);
  try {
    return await run();
  } finally {
    stubbable.showInformationMessage = current;
  }
}

export function resetRememberedMode(): Promise<unknown> {
  return quietly(async () => vscode.commands.executeCommand("markdownCollab.resetSendMode"));
}

function fixtureSource(): string {
  const body = `# Send probe\n\nThe ${FIRST_QUOTE}.\n\nA ${SECOND_QUOTE}.\n`;
  const comment = { author: "user", body: "probe", ts: "2026-05-02T00:00:00.000Z" };
  const first = body.indexOf(FIRST_QUOTE);
  const withFirst = addThread(body, first, first + FIRST_QUOTE.length, comment).source;
  const second = withFirst.indexOf(SECOND_QUOTE);
  return addThread(withFirst, second, second + SECOND_QUOTE.length, comment).source;
}

// Registers setup/teardown in the calling suite: a two-thread fixture, a sentinel clipboard, stubbed dialogs, no remembered mode, no terminals.
export function sendFixture(sendMode: "terminal" | "ask"): {
  uri: () => vscode.Uri;
  file: (name: string) => string;
  setMode: (mode: string) => Thenable<void>;
  dialogs: (options?: DialogOptions) => Dialogs;
} {
  const fixture = path.resolve(__dirname, "..", "fixtures", FIXTURE);
  let dir = "";
  let previousMode: unknown;
  let previousClipboard = "";
  const originals = { info: stubbable.showInformationMessage, pick: stubbable.showQuickPick };

  const setMode = (mode: unknown): Thenable<void> =>
    vscode.workspace.getConfiguration("markdownCollab").update("sendMode", mode, vscode.ConfigurationTarget.Workspace);

  const dialogs = (options: DialogOptions = {}): Dialogs => {
    const record: Dialogs = { messages: [], picks: [] };
    stubbable.showInformationMessage = (message: string): Promise<string | undefined> => {
      record.messages.push(message);
      return Promise.resolve(options.reply);
    };
    stubbable.showQuickPick = (items: PickItem[]): Promise<PickItem | undefined> => {
      record.picks.push(items);
      return Promise.resolve(options.choose?.(items));
    };
    return record;
  };

  setup(async () => {
    await disposeAllTerminals();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-terminal-send-"));
    const source = fixtureSource();
    await fs.writeFile(fixture, source);
    previousMode = vscode.workspace.getConfiguration("markdownCollab").inspect("sendMode")?.workspaceValue;
    await setMode(sendMode);
    previousClipboard = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(SENTINEL);
    dialogs();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture));
    await waitFor(() => doc.getText() === source, "the editor never picked up the fixture");
    await vscode.window.showTextDocument(doc);
    await resetRememberedMode();
  });

  teardown(async () => {
    stubbable.showInformationMessage = originals.info;
    stubbable.showQuickPick = originals.pick;
    await setMode(previousMode);
    await vscode.env.clipboard.writeText(previousClipboard);
    await resetRememberedMode();
    await fs.rm(fixture, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
    await disposeAllTerminals();
  });

  return { uri: () => vscode.Uri.file(fixture), file: (name) => path.join(dir, name), setMode, dialogs };
}
