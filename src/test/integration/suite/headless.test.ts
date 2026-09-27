// "Run Claude for me" against a real Extension Host (10x-plan-4 P0.1).
//
// The unit suite runs HeadlessRun against a stub `claude` and a bare tool
// server. What only the host can show is the whole path a click takes: the
// dispatcher picking headless from the setting, the run finding the
// extension's OWN tool server through the temp config, the stub's tool call
// landing in the open document as a WorkspaceEdit (so Cmd+Z takes it back), the
// fallback when Claude Code can't load the server, and a cancel that leaves no
// process behind.
//
// The stub (fixtures/fake-claude.mjs) is started through a small shell wrapper
// per scenario, so this suite is POSIX-only; the unit suite covers Windows'
// argument quoting.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parse } from "../../../inlineComments/format";

const EXT_ID = "markdown-collab.markdown-collab-plugin";
const STUB = path.resolve(__dirname, "..", "fixtures", "fake-claude.mjs");

interface RunSnapshot {
  folder: string;
  file: string;
  state: { kind: string; reason?: string; toolCount: number; costUsd?: number; text?: string };
  tempDir: string | null;
  pid?: number;
}
interface HeadlessStatus {
  available: boolean;
  unavailableReason: string | null;
  binary: { path: string; version: string } | null;
  serverRunning: boolean;
  mcpUnavailable: boolean;
  active: RunSnapshot[];
  last: RunSnapshot | null;
  lastFallback: { reason: string } | null;
}

function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "fixtures", name);
}

async function status(): Promise<HeadlessStatus> {
  return (await vscode.commands.executeCommand("markdownCollab.headlessStatus")) as HeadlessStatus;
}

async function waitFor<T>(probe: () => Promise<T | undefined | false>, message: string, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of `node`, so the wrappers don't depend on the host's PATH lookup. */
function findNode(): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "node");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

(process.platform === "win32" ? suite.skip : suite)("headless: Run Claude for me", () => {
  let scratch: string;
  const created: string[] = [];
  let previousMode: unknown;

  /** A wrapper that runs the stub in one scenario, tracing what it was given. */
  function wrapper(mode: string): { bin: string; trace: string } {
    const node = findNode();
    assert.ok(node, "node is not on PATH");
    const bin = path.join(scratch, `claude-${mode}`);
    const trace = path.join(scratch, `trace-${mode}.json`);
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nFAKE_CLAUDE_MODE=${mode} FAKE_CLAUDE_TRACE="${trace}" exec "${node}" "${STUB}" "$@"\n`,
      { mode: 0o755 },
    );
    return { bin, trace };
  }

  async function useClaude(bin: string): Promise<void> {
    // claudePath is machine-scoped, so it can only live in user settings.
    await vscode.workspace
      .getConfiguration("markdownCollab")
      .update("claudePath", bin, vscode.ConfigurationTarget.Global);
  }

  async function openDoc(name: string, body: string): Promise<vscode.TextDocument> {
    const p = fixturePath(name);
    fs.writeFileSync(p, body, "utf-8");
    created.push(p);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  }

  async function review(doc: vscode.TextDocument): Promise<void> {
    // `{ focus: "" }` is a general review with no focus prompt — the prompt
    // would wait forever for a human in this host.
    await vscode.commands.executeCommand("markdownCollab.askClaudeToReview", doc.uri, undefined, { focus: "" });
  }

  async function finishedRun(file: string): Promise<RunSnapshot> {
    return waitFor(async () => {
      const s = await status();
      const last = s.last;
      return last && last.file === file && s.active.every((r) => r.file !== file) ? last : undefined;
    }, `the headless run on ${file} never finished`);
  }

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, "extension not loaded");
    if (!ext.isActive) await ext.activate();
    if (!findNode()) {
      console.log("skipping the headless suite: no node on PATH to run the stub");
      this.skip();
    }
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mc-headless-it-"));
    // The tool server starts asynchronously during activation.
    await waitFor(async () => (await status()).serverRunning, "the tool server never started");
    const config = vscode.workspace.getConfiguration("markdownCollab");
    previousMode = config.inspect("sendMode")?.workspaceValue;
    await config.update("sendMode", "headless", vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("markdownCollab.resetSendMode");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("markdownCollab.cancelHeadlessRun");
    const config = vscode.workspace.getConfiguration("markdownCollab");
    await config.update("sendMode", previousMode, vscode.ConfigurationTarget.Workspace);
    await config.update("claudePath", undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("markdownCollab.resetSendMode");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const p of created) fs.rmSync(p, { force: true });
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("a review request runs headless: a thread lands through the tool server, and can be undone", async () => {
    const { bin, trace } = wrapper("ok");
    await useClaude(bin);
    const s0 = await status();
    assert.strictEqual(s0.available, true, `headless should be available: ${s0.unavailableReason}`);
    assert.strictEqual(s0.binary?.version, "2.1.283 (Claude Code)");

    const doc = await openDoc(
      "headless-target.md",
      "# Headless target\n\nThe cache keeps entries for ten minutes.\n\nEviction is least-recently-used.\n",
    );
    // An unsaved line the human typed. A tool write that went around the
    // editor (straight to disk) would clobber it; a WorkspaceEdit keeps it.
    const typing = await vscode.window.showTextDocument(doc, { preview: false });
    await typing.edit((b) => b.insert(doc.positionAt(doc.getText().length), "\nA line typed by the human.\n"));
    assert.ok(doc.isDirty, "expected an unsaved buffer");
    const before = doc.getText();
    await review(doc);
    const run = await finishedRun("headless-target.md");

    assert.strictEqual(run.state.kind, "done", JSON.stringify(run.state));
    assert.strictEqual(run.state.costUsd, 0.0123);
    assert.strictEqual(run.state.toolCount, 3);

    // The thread is in the open buffer (not just on disk), authored by claude.
    const threads = parse(doc.getText()).threads;
    assert.strictEqual(threads.length, 1, doc.getText());
    assert.strictEqual(threads[0]!.comments[0]!.author, "claude");
    assert.ok(doc.getText().includes("A line typed by the human."), "the human's unsaved line was lost");
    assert.strictEqual(doc.isDirty, false, "the tool write should have been saved");
    assert.strictEqual(fs.readFileSync(doc.uri.fsPath, "utf8"), doc.getText(), "disk and buffer disagree");

    // What the stub was handed: the inline-skill prompt on stdin, the token
    // only inside a 0600 file whose directory is gone now.
    const t = JSON.parse(fs.readFileSync(trace, "utf8"));
    assert.ok(
      t.prompt.startsWith(
        "Follow the Markdown Collab review workflow in your instructions in Review Mode on `headless-target.md`.",
      ),
      t.prompt,
    );
    assert.ok(!t.prompt.includes("`mdc` CLI"), "the terminal-only tools directive leaked into a headless prompt");
    assert.strictEqual(t.mcpConfigMode, "600");
    assert.strictEqual(t.systemPromptMode, "600");
    assert.ok(t.systemPromptHead.startsWith("You are running non-interactively"), t.systemPromptHead);
    const descriptor = JSON.parse(fs.readFileSync(fixturePath(".markdown-collab/.mcp-server.json"), "utf8"));
    assert.ok(descriptor.token && !t.argv.join(" ").includes(descriptor.token), "the token reached argv");
    assert.ok(t.argv.includes("--strict-mcp-config"));
    assert.strictEqual(fs.existsSync(path.dirname(t.mcpConfigPath)), false, "temp dir not deleted");
    assert.strictEqual(run.tempDir, null);

    // Undoable: the write went through a WorkspaceEdit. Control first — a host
    // that doesn't deliver `undo` can't prove anything either way.
    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    const reviewed = doc.getText();
    await editor.edit((b) => b.insert(doc.positionAt(0), "control\n"));
    await vscode.commands.executeCommand("undo");
    await new Promise((r) => setTimeout(r, 200));
    if (doc.getText() !== reviewed) {
      console.log("skipping undo assertion: this host does not deliver the undo command");
      return;
    }
    // Two tool writes: mc_open, then mc_check's review checkpoint.
    for (let i = 0; i < 4 && doc.getText().includes("<!--mc:a:"); i++) {
      await vscode.commands.executeCommand("undo");
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(!doc.getText().includes("<!--mc:a:"), "undo did not take Claude's thread back");
    assert.strictEqual(doc.getText().split("<!--mc:")[0], before.split("<!--mc:")[0]);
  });

  test("when Claude Code can't load the tool server, the send falls back to the terminal and headless stops being offered", async () => {
    const { bin } = wrapper("no-mcp");
    await useClaude(bin);
    await vscode.commands.executeCommand("markdownCollab.resetSendMode");
    const doc = await openDoc("headless-nomcp.md", "# No MCP\n\nA sentence to review.\n");
    await review(doc);
    const run = await finishedRun("headless-nomcp.md");
    assert.strictEqual(run.state.kind, "failed");
    assert.strictEqual(run.state.reason, "mcp-unavailable");
    assert.strictEqual(alive(run.pid), false, "the process outlived the run");

    const s = await waitFor(async () => {
      const now = await status();
      return now.lastFallback?.reason === "mcp-unavailable" ? now : undefined;
    }, "no fallback to the terminal was recorded");
    assert.strictEqual(s.mcpUnavailable, true);
    assert.strictEqual(s.available, false);
    assert.match(s.unavailableReason ?? "", /MCP may be disabled/);
    assert.strictEqual(parse(doc.getText()).threads.length, 0);

    // Reset Send Mode is how the human says "try again".
    await vscode.commands.executeCommand("markdownCollab.resetSendMode");
    assert.strictEqual((await status()).mcpUnavailable, false);
  });

  test("cancelling a hung run leaves no process and no temp files", async () => {
    const { bin, trace } = wrapper("hang");
    await useClaude(bin);
    await vscode.commands.executeCommand("markdownCollab.resetSendMode");
    const doc = await openDoc("headless-hang.md", "# Hang\n\nNothing will happen here.\n");
    await review(doc);

    const running = await waitFor(async () => {
      const s = await status();
      const r = s.active.find((a) => a.file === "headless-hang.md");
      return r && r.state.kind === "working" && r.state.toolCount >= 1 ? r : undefined;
    }, "the hung run never reached working");
    assert.ok(alive(running.pid), "expected the stub to be running");

    const cancelled = await vscode.commands.executeCommand("markdownCollab.cancelHeadlessRun");
    assert.strictEqual(cancelled, 1);
    const run = await finishedRun("headless-hang.md");
    assert.strictEqual(run.state.kind, "cancelled");
    assert.strictEqual(run.state.reason, "user");
    await waitFor(async () => !alive(running.pid), "the process is still alive after cancel", 12000);
    const t = JSON.parse(fs.readFileSync(trace, "utf8"));
    assert.strictEqual(fs.existsSync(path.dirname(t.mcpConfigPath)), false, "temp dir not deleted");
  });
});
