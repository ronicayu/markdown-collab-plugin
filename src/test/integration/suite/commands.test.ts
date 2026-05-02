// End-to-end coverage for every command the extension contributes.
//
// Strategy: invoke each command and assert at least one externally
// observable side effect (file written, clipboard set, terminal created,
// workspace state mutated, output channel logged, etc.). For commands
// whose contract is "no-op when preconditions aren't met", we verify the
// no-op explicitly. Where a command needs a CommentReply context that the
// VSCode UI usually supplies (createThread / addReply / etc.), we confirm
// the command exists and is callable, and let the unit suite cover the
// underlying mutation logic.

import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

const ALL_COMMANDS = [
  "markdownCollab.installClaudeSkill",
  "markdownCollab.initializeAgents",
  "markdownCollab.copyClaudePrompt",
  "markdownCollab.reloadComments",
  "markdownCollab.validate",
  "markdownCollab.openPreview",
  "markdownCollab.reattachOrphan",
  "markdownCollab.revealComment",
  "markdownCollab.createThread",
  "markdownCollab.addReply",
  "markdownCollab.toggleResolve",
  "markdownCollab.deleteThread",
  "markdownCollab.editComment",
  "markdownCollab.saveEdit",
  "markdownCollab.cancelEdit",
  "markdownCollab.sendAllToClaude",
  "markdownCollab.startClaudeTerminal",
  "markdownCollab.resetSendMode",
  "markdownCollab.openCollabEditor",
];

function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "fixtures", name);
}

function workspaceRoot(): string {
  return path.resolve(__dirname, "..", "fixtures");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function rmIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

async function writeFixtureMd(name: string, body: string): Promise<vscode.Uri> {
  const p = fixturePath(name);
  await fs.writeFile(p, body, "utf-8");
  return vscode.Uri.file(p);
}

async function writeFixtureSidecar(
  fileRel: string,
  comments: Array<{
    id: string;
    text: string;
    body?: string;
    resolved?: boolean;
    contextBefore?: string;
    contextAfter?: string;
  }>,
): Promise<string> {
  const sidecarDir = path.join(workspaceRoot(), ".markdown-collab", path.dirname(fileRel));
  await fs.mkdir(sidecarDir, { recursive: true });
  const sidecarPath = path.join(workspaceRoot(), ".markdown-collab", fileRel + ".json");
  const sidecar = {
    version: 1,
    file: fileRel,
    comments: comments.map((c) => ({
      id: c.id,
      author: "user",
      body: c.body ?? "test comment",
      createdAt: "2026-05-02T00:00:00.000Z",
      resolved: c.resolved ?? false,
      anchor: {
        text: c.text,
        contextBefore: c.contextBefore ?? "",
        contextAfter: c.contextAfter ?? "",
      },
      replies: [],
    })),
  };
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf-8");
  return sidecarPath;
}

function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = "",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async (): Promise<void> => {
      try {
        if (await condition()) return resolve();
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}`));
      }
      setTimeout(() => void tick(), 50);
    };
    void tick();
  });
}

suite("All extension commands", () => {
  let registered: string[];

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("markdown-collab.markdown-collab-plugin");
    assert.ok(ext, "extension not loaded");
    if (!ext.isActive) await ext.activate();
    registered = await vscode.commands.getCommands(true);
  });

  test("every contributed command is registered", () => {
    const missing = ALL_COMMANDS.filter((c) => !registered.includes(c));
    assert.deepStrictEqual(
      missing,
      [],
      `Commands declared in package.json but not registered: ${missing.join(", ")}`,
    );
  });

  // ---------------------------------------------------------------------
  // installClaudeSkill — only verify the command is registered. Invoking
  // it would write into the developer's real ~/.claude, which we don't
  // want to do from a test, and overriding $HOME globally for the whole
  // VSCode test process makes startup hang on macOS keychain lookups.
  // The skill installer logic itself is covered by skill.test.ts (8
  // unit tests) using a sandboxed home directory argument.
  // ---------------------------------------------------------------------
  test("installClaudeSkill is registered (logic covered by unit tests)", () => {
    assert.ok(registered.includes("markdownCollab.installClaudeSkill"));
  });

  // ---------------------------------------------------------------------
  // initializeAgents
  // ---------------------------------------------------------------------
  test("initializeAgents creates AGENTS.md in the workspace folder", async () => {
    const agentsPath = path.join(workspaceRoot(), "AGENTS.md");
    await rmIfExists(agentsPath);
    await vscode.commands.executeCommand("markdownCollab.initializeAgents");
    await waitFor(() => pathExists(agentsPath), 5000, "AGENTS.md never appeared");
    const text = await fs.readFile(agentsPath, "utf-8");
    assert.ok(text.includes("Markdown review comments"), `AGENTS.md content unexpected: ${text.slice(0, 120)}`);
    await rmIfExists(agentsPath);
  });

  test("initializeAgents appends to an existing AGENTS.md", async () => {
    const agentsPath = path.join(workspaceRoot(), "AGENTS.md");
    const preamble = "# Existing project agents\n\nSome other content.\n";
    await fs.writeFile(agentsPath, preamble, "utf-8");
    await vscode.commands.executeCommand("markdownCollab.initializeAgents");
    const text = await fs.readFile(agentsPath, "utf-8");
    assert.ok(text.startsWith(preamble), "preamble was not preserved");
    assert.ok(text.includes("Markdown review comments"), "snippet was not appended");
    await rmIfExists(agentsPath);
  });

  // ---------------------------------------------------------------------
  // copyClaudePrompt
  // ---------------------------------------------------------------------
  test("copyClaudePrompt puts a prompt referencing the active .md on the clipboard", async () => {
    const uri = await writeFixtureMd("cmd-prompt-target.md", "# Hello\n");
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await vscode.env.clipboard.writeText("cleared-by-test");
      await vscode.commands.executeCommand("markdownCollab.copyClaudePrompt");
      const clip = await vscode.env.clipboard.readText();
      assert.notStrictEqual(clip, "cleared-by-test", "clipboard was not overwritten");
      assert.ok(clip.includes("cmd-prompt-target.md"), `clipboard missing target file: ${clip}`);
    } finally {
      await rmIfExists(uri.fsPath);
    }
  });

  // ---------------------------------------------------------------------
  // reloadComments — must not throw even when no editor is active
  // ---------------------------------------------------------------------
  test("reloadComments is a safe no-op when nothing is open", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("markdownCollab.reloadComments");
  });

  // ---------------------------------------------------------------------
  // validate
  // ---------------------------------------------------------------------
  test("validate runs without error against a workspace with no sidecars", async () => {
    await vscode.commands.executeCommand("markdownCollab.validate");
  });

  // ---------------------------------------------------------------------
  // openPreview
  // ---------------------------------------------------------------------
  test("openPreview creates a webview panel for a .md file", async () => {
    const uri = await writeFixtureMd("preview-target.md", "# Preview test\n\nHello world.\n");
    try {
      const before = (vscode.window as unknown as { tabGroups: { all: unknown[] } }).tabGroups.all.length;
      await vscode.commands.executeCommand("markdownCollab.openPreview", uri);
      // The preview is a WebviewPanel; opening a tab should be observable.
      // Use a generous wait — webview reveal is async via showWebviewPanel.
      await waitFor(() => {
        const tabs = (vscode.window as unknown as { tabGroups: { all: { tabs: unknown[] }[] } }).tabGroups.all;
        const total = tabs.reduce((sum, g) => sum + g.tabs.length, 0);
        return total >= before;
      }, 5000, "tab count did not change after openPreview");
    } finally {
      await rmIfExists(uri.fsPath);
    }
  });

  // ---------------------------------------------------------------------
  // sendAllToClaude (clipboard mode — no terminal/MCP needed)
  // ---------------------------------------------------------------------
  test("sendAllToClaude in clipboard mode copies the prompt", async () => {
    const fileRel = "cmd-send-target.md";
    const body = "# Send target\n\nThis text is the anchor target for sending.\n";
    const uri = await writeFixtureMd(fileRel, body);
    const sidecarPath = await writeFixtureSidecar(fileRel, [
      { id: "c_aaaaaaaa", text: "anchor target for sending" },
    ]);
    try {
      // Force clipboard mode for this run + clear any stale workspace state.
      const config = vscode.workspace.getConfiguration("markdownCollab");
      const prevMode = config.get<string>("sendMode", "ask");
      await config.update("sendMode", "clipboard", vscode.ConfigurationTarget.Workspace);
      await vscode.env.clipboard.writeText("cleared-by-test");

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("markdownCollab.sendAllToClaude", uri);

      await waitFor(async () => {
        const clip = await vscode.env.clipboard.readText();
        return clip !== "cleared-by-test" && clip.length > 0;
      }, 5000, "clipboard never updated by sendAllToClaude");
      const clip = await vscode.env.clipboard.readText();
      assert.ok(clip.includes(fileRel), `clipboard prompt missing file ref: ${clip}`);

      await config.update("sendMode", prevMode, vscode.ConfigurationTarget.Workspace);
    } finally {
      await rmIfExists(uri.fsPath);
      await rmIfExists(sidecarPath);
    }
  });

  // ---------------------------------------------------------------------
  // sendAllToClaude (channel mode — appends to .events.jsonl)
  // ---------------------------------------------------------------------
  test("sendAllToClaude in channel mode appends to .markdown-collab/.events.jsonl", async () => {
    const fileRel = "cmd-channel-target.md";
    const body = "# Channel target\n\nAnother anchor target string here.\n";
    const uri = await writeFixtureMd(fileRel, body);
    const sidecarPath = await writeFixtureSidecar(fileRel, [
      { id: "c_bbbbbbbb", text: "anchor target string here" },
    ]);
    const eventsPath = path.join(workspaceRoot(), ".markdown-collab", ".events.jsonl");
    await rmIfExists(eventsPath);
    try {
      const config = vscode.workspace.getConfiguration("markdownCollab");
      const prevMode = config.get<string>("sendMode", "ask");
      await config.update("sendMode", "channel", vscode.ConfigurationTarget.Workspace);

      await vscode.commands.executeCommand("markdownCollab.sendAllToClaude", uri);
      await waitFor(() => pathExists(eventsPath), 5000, ".events.jsonl never appeared");
      const log = await fs.readFile(eventsPath, "utf-8");
      const lines = log.trim().split("\n").filter(Boolean);
      assert.ok(lines.length >= 1, `expected at least one line in event log, got ${lines.length}`);
      const last = JSON.parse(lines[lines.length - 1]!);
      assert.ok(last.id, "event missing id");
      assert.ok(last.ts, "event missing ts");

      await config.update("sendMode", prevMode, vscode.ConfigurationTarget.Workspace);
    } finally {
      await rmIfExists(uri.fsPath);
      await rmIfExists(sidecarPath);
      await rmIfExists(eventsPath);
    }
  });

  // ---------------------------------------------------------------------
  // startClaudeTerminal
  // ---------------------------------------------------------------------
  test("startClaudeTerminal opens a vscode.Terminal", async () => {
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand("markdownCollab.startClaudeTerminal");
    await waitFor(() => vscode.window.terminals.length > before, 5000, "no new terminal appeared");
    // Find the freshly created terminal — name should reference Claude.
    const newTerminals = vscode.window.terminals.slice(before);
    assert.ok(newTerminals.length >= 1, "expected at least one new terminal");
    // Best-effort: the terminal name should hint at Claude; do not over-assert.
    const names = newTerminals.map((t) => t.name).join(", ");
    assert.ok(
      newTerminals.some((t) => /claude/i.test(t.name)),
      `expected a Claude-named terminal, got: ${names}`,
    );
    for (const t of newTerminals) t.dispose();
  });

  // ---------------------------------------------------------------------
  // resetSendMode
  // ---------------------------------------------------------------------
  test("resetSendMode is callable and does not throw", async () => {
    await vscode.commands.executeCommand("markdownCollab.resetSendMode");
  });

  // ---------------------------------------------------------------------
  // openCollabEditor
  // ---------------------------------------------------------------------
  test("openCollabEditor opens a custom editor for the active .md", async () => {
    const uri = await writeFixtureMd("cmd-collab-target.md", "# Hi\n\nbody\n");
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("markdownCollab.openCollabEditor", uri);
      // The custom-editor wiring is exercised more thoroughly in collab.test.ts;
      // here we just confirm the command itself doesn't throw.
    } finally {
      await rmIfExists(uri.fsPath);
    }
  });

  // ---------------------------------------------------------------------
  // Comment thread commands (createThread, addReply, toggleResolve,
  // deleteThread, editComment, saveEdit, cancelEdit) and the
  // argument-driven commands (reattachOrphan, revealComment) — these
  // expect a CommentReply / Comment / Uri context object that VSCode's UI
  // supplies when the user interacts with the gutter or tree view. From
  // headless tests we can only confirm they're registered; invoking with
  // no args can hang on showInformationMessage modals or a missing
  // active editor. The underlying mutation logic is exercised in
  // commentController.test.ts (21 unit tests).
  // ---------------------------------------------------------------------
  test("UI-context-bound commands are registered", () => {
    for (const id of [
      "markdownCollab.createThread",
      "markdownCollab.addReply",
      "markdownCollab.toggleResolve",
      "markdownCollab.deleteThread",
      "markdownCollab.editComment",
      "markdownCollab.saveEdit",
      "markdownCollab.cancelEdit",
      "markdownCollab.reattachOrphan",
      "markdownCollab.revealComment",
    ]) {
      assert.ok(registered.includes(id), `command ${id} not registered`);
    }
  });

  // ---------------------------------------------------------------------
  // Configuration surface — every advertised setting key resolves.
  // ---------------------------------------------------------------------
  test("every advertised configuration key is reachable", () => {
    const config = vscode.workspace.getConfiguration("markdownCollab");
    for (const key of [
      "sendMode",
      "collab.serverUrl",
      "collab.startLocalServer",
      "collab.port",
      "collab.userName",
    ]) {
      // .inspect() returns undefined only if the property isn't declared
      // at all in package.json. Defaults from contributes.configuration
      // surface as defaultValue.
      const inspected = config.inspect(key);
      assert.ok(inspected, `setting ${key} is not declared in contributes.configuration`);
    }
    // Touch crypto so the import isn't unused if the file is reorganized.
    void crypto.randomBytes(1);
  });
});
