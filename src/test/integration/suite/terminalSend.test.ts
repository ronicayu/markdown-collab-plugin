import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { addThread } from "../../../inlineComments/format";

interface ShellExecutionEvent {
  terminal: vscode.Terminal;
}
type ShellExecutionEvents = {
  onDidStartTerminalShellExecution?: vscode.Event<ShellExecutionEvent>;
  onDidEndTerminalShellExecution?: vscode.Event<ShellExecutionEvent>;
};

const events = vscode.window as unknown as ShellExecutionEvents;
const FIXTURE = "terminal-send-target.md";
const IDLE_MESSAGE = "Nothing is running in your terminals. Start your agent in one, then Send again.";

async function waitFor(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function seen(event: vscode.Event<ShellExecutionEvent>, terminal: vscode.Terminal): { count: () => number; dispose: () => void } {
  let count = 0;
  const sub = event((e) => {
    if (e.terminal === terminal) count += 1;
  });
  return { count: () => count, dispose: () => sub.dispose() };
}

async function disposeAllTerminals(): Promise<void> {
  for (const t of vscode.window.terminals) t.dispose();
  await waitFor(() => vscode.window.terminals.length === 0, "terminals did not close");
}

async function activeTerminalWithShellIntegration(): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal({ name: "send-probe" });
  terminal.show();
  await waitFor(() => vscode.window.activeTerminal === terminal, "terminal never became active");
  await waitFor(
    () => (terminal as unknown as { shellIntegration?: unknown }).shellIntegration !== undefined,
    "shell integration never attached",
  );
  return terminal;
}

async function withInformationMessageStub<T>(run: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const original = vscode.window.showInformationMessage;
  const stubbed = vscode.window as unknown as { showInformationMessage: unknown };
  stubbed.showInformationMessage = (message: string): Promise<undefined> => {
    calls.push(message);
    return Promise.resolve(undefined);
  };
  try {
    return await run(calls);
  } finally {
    stubbed.showInformationMessage = original;
  }
}

(process.platform === "win32" ? suite.skip : suite)("terminal Send into a real terminal", () => {
  const fixture = path.resolve(__dirname, "..", "fixtures", FIXTURE);
  let target: string;
  let previousMode: unknown;

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension("markdown-collab.markdown-collab-plugin");
    assert.ok(ext, "extension not loaded");
    if (!ext.isActive) await ext.activate();
    if (!events.onDidStartTerminalShellExecution || !events.onDidEndTerminalShellExecution) this.skip();
  });

  setup(async () => {
    await disposeAllTerminals();
    target = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "mc-terminal-send-")), "received.txt");
    const body = "# Send probe\n\nThe sentence the thread is anchored to.\n";
    const anchor = "sentence the thread is anchored to";
    const start = body.indexOf(anchor);
    await fs.writeFile(fixture, addThread(body, start, start + anchor.length, { author: "user", body: "probe", ts: "2026-05-02T00:00:00.000Z" }).source);
    const config = vscode.workspace.getConfiguration("markdownCollab");
    previousMode = config.inspect("sendMode")?.workspaceValue;
    await config.update("sendMode", "terminal", vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(fixture)));
  });

  teardown(async () => {
    await vscode.workspace
      .getConfiguration("markdownCollab")
      .update("sendMode", previousMode, vscode.ConfigurationTarget.Workspace);
    await disposeAllTerminals();
    await fs.rm(fixture, { force: true });
    await fs.rm(path.dirname(target), { recursive: true, force: true });
  });

  test("the prompt lands in the terminal where a program is running", async () => {
    const terminal = await activeTerminalWithShellIntegration();
    const started = seen(events.onDidStartTerminalShellExecution!, terminal);
    try {
      terminal.sendText(`cat > '${target}'`);
      await waitFor(() => started.count() === 1, "the cat command never reported a start");
    } finally {
      started.dispose();
    }

    await withInformationMessageStub(async () => {
      await vscode.commands.executeCommand("markdownCollab.sendAllToClaude", vscode.Uri.file(fixture));
    });

    await waitFor(
      async () => (await fs.readFile(target, "utf-8").catch(() => "")).includes(FIXTURE),
      "the prompt never reached the file cat was writing",
    );
  });

  test("an idle shell gets nothing", async () => {
    const terminal = await activeTerminalWithShellIntegration();
    const started = seen(events.onDidStartTerminalShellExecution!, terminal);
    const ended = seen(events.onDidEndTerminalShellExecution!, terminal);
    try {
      terminal.sendText("true");
      await waitFor(() => started.count() === 1 && ended.count() === 1, "true never reported a start and an end");

      await withInformationMessageStub(async (calls) => {
        await vscode.commands.executeCommand("markdownCollab.sendAllToClaude", vscode.Uri.file(fixture));
        assert.deepStrictEqual(calls, [IDLE_MESSAGE]);
      });

      await new Promise((r) => setTimeout(r, 2000));
      assert.strictEqual(started.count(), 1, "something was typed into the idle shell");
    } finally {
      started.dispose();
      ended.dispose();
    }
  });
});
