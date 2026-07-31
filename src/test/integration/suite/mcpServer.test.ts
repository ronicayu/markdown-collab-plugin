// The MCP tool server against a real Extension Host (10x-plan-2 P0.1).
//
// The unit tests cover the verbs, the protocol, and the socket. What only the
// host can show is the property the whole initiative exists for: a tool call
// reaches the document through a `WorkspaceEdit`, so it is ordered against the
// live buffer, it lands in the undo stack, and Cmd+Z takes it back.

import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../../../logging";
import { parse } from "../../../inlineComments/format";
import { deltaScope } from "../../../inlineComments/deltaReview";
import { buildToolDeps } from "../../../mcpServer";
import { callTool, TOOLS } from "../../../mcpServer/tools";
import { serveMcp, type McpHttpServer } from "../../../mcpServer/httpServer";
import { PROTOCOL_VERSION } from "../../../mcpServer/protocol";

const TOKEN = "t".repeat(64);
const BODY = `# Release notes

The parser handles nested lists correctly.

Suggest mode ships behind a setting.
`;

function fixturePath(name: string): string {
  return path.resolve(__dirname, "..", "fixtures", name);
}

const noop = (): void => undefined;
const testLogger: Logger = {
  trace: noop,
  info: noop,
  warn: noop,
  error: noop,
  scope: () => testLogger,
  time: (_label, fn) => fn(),
  show: noop,
};

function deps() {
  return buildToolDeps({ log: testLogger });
}

/** Fixture names are unique per test: rewriting a file underneath a document
 *  VS Code still has open races its own reload, which is a property of the
 *  harness rather than anything under test. */
const created: string[] = [];
let seq = 0;

async function openFixture(body = BODY): Promise<{ doc: vscode.TextDocument; name: string }> {
  const name = `mcp-server-scratch-${++seq}.md`;
  const p = fixturePath(name);
  await fs.writeFile(p, body, "utf-8");
  created.push(p);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
  await vscode.window.showTextDocument(doc, { preview: false });
  return { doc, name };
}

/** Poll a condition the editor reaches asynchronously (undo, reload). */
async function waitFor(cond: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(cond(), message);
}

async function cleanup(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  for (const p of created.splice(0, created.length)) await fs.rm(p, { force: true });
}

function json(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

suite("mcpServer: tools against a real workspace", () => {
  suiteTeardown(cleanup);

  test("a tool call edits the open document and saves it", async () => {
    const { doc, name } = await openFixture();
    const opened = json(
      await callTool("mc_open", { file: name, quote: "nested lists", body: "Ordered too?" }, deps()),
    );
    assert.ok(opened.threadId, "expected a thread id");

    // The open TextDocument reflects the change without a reload — proof it
    // went through the editor rather than around it.
    assert.ok(doc.getText().includes(`<!--mc:a:${opened.threadId}-->`), "marker missing from the buffer");
    assert.strictEqual(doc.isDirty, false, "document should have been saved");

    const onDisk = await fs.readFile(fixturePath(name), "utf-8");
    assert.strictEqual(onDisk, doc.getText(), "disk and buffer disagree");
  });

  test("Claude's edit is undoable, exactly like a human's", async () => {
    const { doc, name } = await openFixture();
    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });

    // Control: undo a plain editor edit first. The `undo` command needs a
    // focused editor, which a headless test host doesn't always provide — and
    // a test that can't undo anything must say so rather than quietly claim
    // Claude's edit is undoable.
    const original = doc.getText();
    await editor.edit((b) => b.insert(doc.positionAt(0), "control\n"));
    assert.notStrictEqual(doc.getText(), original, "control edit did not apply");
    await vscode.commands.executeCommand("undo");
    await new Promise((r) => setTimeout(r, 200));
    if (doc.getText() !== original) {
      // No undo in this host at all. Restore and skip rather than fail.
      await editor.edit((b) => b.delete(new vscode.Range(doc.positionAt(0), doc.positionAt(8))));
      console.log("skipping undo assertion: this host does not deliver the undo command");
      return;
    }

    const before = doc.getText();
    json(await callTool("mc_open", { file: name, quote: "nested lists", body: "Undo me." }, deps()));
    assert.notStrictEqual(doc.getText(), before, "the edit did not apply");

    // The property P0.1 exists for: because the tool wrote through a
    // WorkspaceEdit rather than to disk, this is on the editor's undo stack.
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand("undo");
    await waitFor(() => doc.getText() === before, "undo did not restore the document");
  });

  test("an unsaved buffer edit is not clobbered by a tool call", async () => {
    // The failure this replaces: a separate process writing the file while the
    // human had unsaved changes, and the write winning.
    const { doc, name } = await openFixture();
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await editor.edit((b) => b.insert(doc.positionAt(doc.getText().length), "\nA line typed by the human.\n"));
    assert.ok(doc.isDirty, "expected an unsaved buffer");

    json(await callTool("mc_open", { file: name, quote: "nested lists", body: "Both, please." }, deps()));

    const text = doc.getText();
    assert.ok(text.includes("A line typed by the human."), "the human's unsaved line was lost");
    assert.ok(text.includes("<!--mc:a:"), "the tool's edit was lost");
  });

  test("a refused call leaves the document untouched", async () => {
    const { doc, name } = await openFixture();
    const before = doc.getText();
    const result = await callTool("mc_reply", { file: name, threadId: "nope1", body: "hi" }, deps());
    assert.strictEqual(result.isError, true);
    assert.strictEqual(json(result).error.code, "thread_not_found");
    assert.strictEqual(doc.getText(), before);
  });

  test("a path outside the workspace is refused", async () => {
    await openFixture();
    const result = await callTool("mc_list", { file: "/etc/hosts" }, deps());
    assert.strictEqual(result.isError, true);
    assert.strictEqual(json(result).error.code, "file_not_found");
  });

  test("mc_check reports the document the tools just wrote as healthy", async () => {
    const { name } = await openFixture();
    json(await callTool("mc_open", { file: name, quote: "nested lists", body: "check me" }, deps()));
    const checked = json(await callTool("mc_check", { file: name }, deps()));
    assert.strictEqual(checked.ok, true, JSON.stringify(checked.issues));
  });
});

suite("mcpServer: over HTTP", () => {
  let server: McpHttpServer | undefined;

  suiteTeardown(async () => {
    await server?.close();
    await cleanup();
  });

  test("a full handshake → tools/call round trip mutates the document", async () => {
    const { doc, name } = await openFixture();
    const toolDeps = deps();
    server = await serveMcp({
      token: TOKEN,
      handlers: {
        serverInfo: { name: "markdown-collab", version: "test" },
        tools: TOOLS,
        callTool: (name, args) => callTool(name, args, toolDeps),
      },
    });

    const rpc = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      const res = await fetch(server!.url, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return res.json();
    };

    const init = await rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {} });
    assert.strictEqual(init.result.serverInfo.name, "markdown-collab");

    const listed = await rpc("tools/list");
    assert.ok(listed.result.tools.some((t: { name: string }) => t.name === "mc_reply"));

    const called = await rpc("tools/call", {
      name: "mc_open",
      arguments: { file: name, quote: "behind a setting", body: "Which one?" },
    });
    const payload = JSON.parse(called.result.content[0].text);
    assert.ok(payload.threadId, "expected a thread id from the HTTP round trip");
    assert.strictEqual(parse(doc.getText()).threads.length, 1);
  });
});

suite("mcpServer: the review checkpoint", () => {
  suiteTeardown(cleanup);

  test("mc_check records a checkpoint through the editor, and a delta pass sees it", async () => {
    const { doc, name } = await openFixture();
    const checked = json(await callTool("mc_check", { file: name }, deps()));
    assert.strictEqual(checked.ok, true);
    assert.ok(checked.checkpointed, "expected mc_check to record a checkpoint");

    // The record is in the buffer, saved, and parses back.
    const parsed = parse(doc.getText());
    assert.ok(parsed.checkpoint, "no checkpoint in the document");
    assert.strictEqual(parsed.checkpoint!.ts, checked.checkpointed);
    assert.ok((parsed.checkpoint!.sections ?? []).length > 0, "no section hashes recorded");
    assert.strictEqual(doc.isDirty, false, "checkpoint left the buffer unsaved");

    // Nothing has changed yet, so a delta pass has nothing to review.
    assert.strictEqual(deltaScope(parse(doc.getText())).kind, "unchanged");
  });

  test("editing one section makes exactly that section the delta scope", async () => {
    const { doc, name } = await openFixture();
    json(await callTool("mc_check", { file: name }, deps()));

    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const target = doc.getText().indexOf("Suggest mode ships behind a setting.");
    await editor.edit((b) =>
      b.replace(
        new vscode.Range(doc.positionAt(target), doc.positionAt(target + "Suggest mode ships behind a setting.".length)),
        "Suggest mode ships behind a setting, off by default.",
      ),
    );
    await doc.save();

    const scope = deltaScope(parse(doc.getText()));
    assert.strictEqual(scope.kind, "incremental");
    if (scope.kind !== "incremental") return;
    // The fixture has one heading, so the edit lands in that section and the
    // scope names it rather than the whole file.
    assert.strictEqual(scope.changed.length, 1);
    assert.ok(scope.changed[0]!.text.includes("off by default"));
  });
});
