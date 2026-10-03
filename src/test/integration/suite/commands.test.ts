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
import { addThread, parse } from "../../../inlineComments/format";

// Every command the extension registers. The sidecar-era commands
// (reloadComments, validate, openPreview, createThread, addReply,
// toggleResolve, deleteThread, editComment, saveEdit, cancelEdit,
// reattachOrphan) were removed with that architecture; they were left in this
// list long after, which is why the suite has been red.
const ALL_COMMANDS = [
  "markdownCollab.installClaudeSkill",
  "markdownCollab.initializeAgents",
  "markdownCollab.copyClaudePrompt",
  "markdownCollab.revealComment",
  "markdownCollab.sendAllToClaude",
  "markdownCollab.sendThreadToClaude",
  "markdownCollab.copyThreadToClaude",
  "markdownCollab.startClaudeTerminal",
  "markdownCollab.resetSendMode",
  "markdownCollab.openCollabEditor",
  "markdownCollab.askClaudeToReview",
  "markdownCollab.askClaudeToReviewFolder",
  "markdownCollab.nextUnreadFromClaude",
  "markdownCollab.openInlineCommentsView",
  "markdownCollab.repairInlineComments",
  "markdownCollab.toggleSuggestMode",
  "markdownCollab.startPrReview",
  "markdownCollab.connectAgent",
  "markdownCollab.disconnectAgent",
  "markdownCollab.resolveThread",
  "markdownCollab.replyToThread",
  "markdownCollab.liveEditor.keyHandledInEditor",
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

/**
 * Write a `.md` fixture that already carries an inline comment thread — the
 * only comment storage the extension has since the sidecar was removed.
 * Returns the file uri; `anchorText` must appear verbatim in `body`.
 */
async function writeFixtureWithThread(
  name: string,
  body: string,
  anchorText: string,
  commentBody = "test comment",
  author = "user",
): Promise<vscode.Uri> {
  const start = body.indexOf(anchorText);
  assert.ok(start >= 0, `anchor text ${JSON.stringify(anchorText)} not in fixture body`);
  const { source } = addThread(body, start, start + anchorText.length, {
    author,
    body: commentBody,
    ts: "2026-05-02T00:00:00.000Z",
  });
  return writeFixtureMd(name, source);
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
  // openInlineCommentsView — the review view: the title-bar icon, the
  // right-click action on .md files, the key. It opens the live editor
  // (custom editor `markdownCollab.collabEditor`); the previous view, a
  // webview panel, while `markdownCollab.classicReviewView` is on.
  // ---------------------------------------------------------------------
  const LIVE_VIEW_TYPE = "markdownCollab.collabEditor";

  /** Tabs showing the live editor on `uri`, in every group. */
  const liveTabsFor = (uri: vscode.Uri): vscode.Tab[] =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputCustom &&
          t.input.viewType === LIVE_VIEW_TYPE &&
          t.input.uri.toString() === uri.toString(),
      );

  const activeTabIsLiveEditorOn = (uri: vscode.Uri): boolean => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return (
      input instanceof vscode.TabInputCustom &&
      input.viewType === LIVE_VIEW_TYPE &&
      input.uri.toString() === uri.toString()
    );
  };

  test("openInlineCommentsView opens the review view — the live editor — for a .md file", async () => {
    const uri = await writeFixtureMd("preview-target.md", "# Preview test\n\nHello world.\n");
    try {
      await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", uri);
      await waitFor(() => activeTabIsLiveEditorOn(uri), 5000, "the active tab isn't the live editor on the file");
      // A second open brings the same panel forward rather than adding one.
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", uri);
      await waitFor(() => activeTabIsLiveEditorOn(uri), 5000, "the second open didn't land on the live editor");
      assert.strictEqual(liveTabsFor(uri).length, 1, "a second open added another live editor tab");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rmIfExists(uri.fsPath);
    }
  });

  test("revealThread opens the review view on the thread's file", async () => {
    const body = "# Reveal\n\nThe anchored passage is here.\n";
    const uri = await writeFixtureWithThread("reveal-target.md", body, "anchored passage");
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const threadId = parse(doc.getText()).threads[0].id;
      await vscode.commands.executeCommand("markdownCollab.revealThread", uri.toString(), threadId);
      await waitFor(() => activeTabIsLiveEditorOn(uri), 5000, "revealThread didn't open the live editor");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rmIfExists(uri.fsPath);
    }
  });

  // ---------------------------------------------------------------------
  // nextUnreadFromClaude — walks every open thread an agent started that the
  // human hasn't answered yet, one file at a time, in path order. Filenames
  // are prefixed "0-" so they sort ahead of every other fixture in this
  // directory (`ReviewView.listClaudeUnread` walks by absolute fsPath), which
  // keeps the two-file order deterministic regardless of what other fixtures
  // exist at the moment this test runs.
  // ---------------------------------------------------------------------
  test("nextUnreadFromClaude lands on each agent-opened unread thread's file, in order", async () => {
    const bodyA = "# Doc A\n\nThe anchored passage from A is here.\n";
    const bodyB = "# Doc B\n\nThe anchored passage from B is here.\n";
    const uriA = await writeFixtureWithThread(
      "0-next-unread-a.md",
      bodyA,
      "anchored passage from A",
      "needs a look",
      "claude",
    );
    const uriB = await writeFixtureWithThread(
      "0-next-unread-b.md",
      bodyB,
      "anchored passage from B",
      "needs a look too",
      "claude",
    );
    try {
      // `ReviewView`'s scan is lazy and this may be the first thing in the
      // whole suite to touch it, so the very first invocation can land on
      // nothing until the workspace scan (or the fs watcher, on a warm
      // cache) catches up — retry the command itself rather than poll a
      // separate readiness signal the view doesn't expose. Once the cache
      // is warm this resolves on the first call.
      await waitFor(async () => {
        await vscode.commands.executeCommand("markdownCollab.nextUnreadFromClaude");
        return activeTabIsLiveEditorOn(uriA);
      }, 10000, "nextUnreadFromClaude never landed on file 1 (0-next-unread-a.md)");

      await vscode.commands.executeCommand("markdownCollab.nextUnreadFromClaude");
      await waitFor(
        () => activeTabIsLiveEditorOn(uriB),
        5000,
        "nextUnreadFromClaude never landed on file 2 (0-next-unread-b.md)",
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rmIfExists(uriA.fsPath);
      await rmIfExists(uriB.fsPath);
    }
  });

  test("with classicReviewView on, openInlineCommentsView opens the previous review view", async () => {
    const uri = await writeFixtureMd("classic-target.md", "# Classic\n\nHello world.\n");
    const config = vscode.workspace.getConfiguration("markdownCollab");
    await config.update("classicReviewView", true, vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", uri);
      await waitFor(
        () => {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          // A webview panel's viewType carries a host prefix.
          return input instanceof vscode.TabInputWebview && input.viewType.endsWith("markdownCollab.inlineCommentsView");
        },
        5000,
        "the active tab isn't the previous review view",
      );
      assert.strictEqual(liveTabsFor(uri).length, 0, "the live editor opened although classicReviewView is on");
    } finally {
      await config.update("classicReviewView", undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rmIfExists(uri.fsPath);
    }
  });

  // ---------------------------------------------------------------------
  // sendAllToClaude (clipboard mode — no terminal/MCP needed)
  // ---------------------------------------------------------------------
  test("sendAllToClaude in clipboard mode copies the prompt", async () => {
    const fileRel = "cmd-send-target.md";
    const body = "# Send target\n\nThis text is the anchor target for sending.\n";
    const uri = await writeFixtureWithThread(fileRel, body, "anchor target for sending");
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
  // openCollabEditor — hidden from the palette, an alias of the review view
  // ---------------------------------------------------------------------
  test("openCollabEditor opens the review view for the active .md", async () => {
    const uri = await writeFixtureMd("cmd-collab-target.md", "# Hi\n\nbody\n");
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("markdownCollab.openCollabEditor", uri);
      await waitFor(() => activeTabIsLiveEditorOn(uri), 5000, "openCollabEditor didn't open the live editor");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rmIfExists(uri.fsPath);
    }
  });

  // ---------------------------------------------------------------------
  // Argument-driven commands (revealComment, sendThreadToClaude,
  // copyThreadToClaude) expect a tree node / uri + thread id that the UI
  // supplies when the user clicks. From headless tests we can only confirm
  // they're registered; invoking with no args is a documented no-op but
  // tells us nothing. Their logic is exercised by the unit suite.
  // ---------------------------------------------------------------------
  test("argument-driven commands are registered", () => {
    for (const id of [
      "markdownCollab.revealComment",
      "markdownCollab.sendThreadToClaude",
      "markdownCollab.copyThreadToClaude",
      "markdownCollab.repairInlineComments",
    ]) {
      assert.ok(registered.includes(id), `command ${id} not registered`);
    }
  });

  test("argument-driven commands are no-ops when invoked with no context", async () => {
    // The UI never calls them this way, but a palette invocation or a stale
    // keybinding can — they must not throw into the extension host.
    await vscode.commands.executeCommand("markdownCollab.revealComment", undefined);
    await vscode.commands.executeCommand("markdownCollab.sendThreadToClaude", undefined, undefined);
    await vscode.commands.executeCommand("markdownCollab.copyThreadToClaude", undefined, undefined);
  });

  // ---------------------------------------------------------------------
  // Configuration surface — every advertised setting key resolves.
  // ---------------------------------------------------------------------
  test("every advertised configuration key is reachable", () => {
    const config = vscode.workspace.getConfiguration("markdownCollab");
    for (const key of ["sendMode", "collab.userName"]) {
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
