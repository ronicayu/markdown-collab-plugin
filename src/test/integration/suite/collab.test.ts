// End-to-end tests that run inside a real VSCode Extension Host.
//
// These tests exercise the *extension surface* — they can't see what
// CodeMirror eventually renders inside the webview iframe (the test host
// has no DOM access into webviews), but they can verify:
//
//   - the extension activated cleanly (no thrown errors at activate time)
//   - our customEditor + commands are registered
//   - the relay started on port 1234 and answers the HTTP signature probe
//   - opening a .md with our viewType creates the webview
//   - the seed pipeline reaches the relay (most-likely failure mode for the
//     "empty document" bug — if the webview can't talk to ws://127.0.0.1:1234,
//     the doc never seeds and the user sees an empty editor)
//
// We assert the seed pipeline by spinning up our *own* WebsocketProvider
// inside the test host (with the `ws` polyfill) pointed at the same room
// hash the editor would use, then watching whether the Y.Text receives the
// content — i.e. we play the "second peer" against the relay the extension
// just started.

import * as assert from "assert";
import * as crypto from "crypto";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import {
  _getRoomConnectionCountForTests,
  _getRoomTextForTests,
} from "../../../collab/server";
import {
  _getLastReadyForTests,
  _getLastWebviewErrorForTests,
} from "../../../collab/collabEditorProvider";

const EXT_ID = "markdown-collab.markdown-collab-plugin";
const VIEW_TYPE = "markdownCollab.collabEditor";
// Must match fixtures/.vscode/settings.json. Picked away from 1234 so the
// test extension's relay doesn't collide with a developer's running
// VSCode session that already opened this extension on the default port.
const RELAY_PORT = 17234;

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

function fixturePath(name: string): string {
  // The fixtures dir is copied alongside the compiled tests under
  // out/test/integration/fixtures by tsc.
  return path.resolve(__dirname, "..", "fixtures", name);
}

function probeHttp(port: number, timeoutMs = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("probe timeout"));
    });
  });
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
        /* fall through to retry */
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}`));
      }
      setTimeout(() => void tick(), 50);
    };
    void tick();
  });
}

function roomFor(uri: vscode.Uri): string {
  // Mirrors collabEditorProvider.ts: sha1(fsPath).slice(0, 16). Lock-step
  // with that helper — if it changes, this test must change too.
  return crypto.createHash("sha1").update(uri.fsPath).digest("hex").slice(0, 16);
}

suite("Collab editor integration", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} is not loaded; check publisher/name in package.json`);
    if (!ext.isActive) {
      // Forcing activation rather than relying on activationEvents — we
      // want the relay started before the very first test runs.
      await ext.activate();
    }
  });

  test("registers the custom editor + command", async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(
      cmds.includes("markdownCollab.openCollabEditor"),
      "openCollabEditor command not registered",
    );
  });

  test("relay listens on port 1234 with our signature", async () => {
    // Activation kicks off startCollabServer asynchronously; give it a
    // moment in case the test runs before the listen() callback fires.
    await waitFor(async () => {
      try {
        const body = await probeHttp(RELAY_PORT, 300);
        return body.includes("markdown-collab y-websocket relay");
      } catch {
        return false;
      }
    }, 5000, "relay not reachable");
  });

  test("opening a .md with our viewType produces a connected room on the relay", async () => {
    // Milkdown stores its content in a Y.XmlFragment("prosemirror"), not
    // the legacy Y.Text("doc") that v0.15 used. We can't introspect the
    // PM XML fragment as a string easily, so this test now only asserts
    // "the webview connected and a room exists" — the *content* check is
    // the next test, which uses the webview→extension ready ping.
    const uri = vscode.Uri.file(fixturePath("sample.md"));
    const expectedDoc = (await vscode.workspace.fs.readFile(uri)).toString();
    assert.ok(expectedDoc.length > 0, "fixture is empty — invalid setup");

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const room = roomFor(uri);
    await waitFor(
      () => _getRoomConnectionCountForTests(room) >= 1,
      10000,
      "webview never connected to relay",
    );
    // Touch the room-text accessor so the import is exercised in case of a
    // future refactor regression — the value is intentionally not asserted
    // here (the new editor stores content in Y.XmlFragment, not Y.Text).
    void _getRoomTextForTests(room);
  });

  test("webview reports non-empty content (catches the empty-editor bug)", async () => {
    // The Milkdown editor reports its post-init serializer length back
    // via the `ready-with-content` message. We don't compare to the
    // exact char count of the source file because Milkdown's markdown
    // round-trip normalizes whitespace; instead assert the editor has
    // *some* content with a sensible lower bound (the headline alone
    // is 16 chars, so >100 catches a truly empty editor regression).
    const uri = vscode.Uri.file(fixturePath("sample.md"));
    const expected = (await vscode.workspace.fs.readFile(uri)).toString();
    assert.ok(expected.length > 100, "fixture should have substantial content");

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    await waitFor(
      () => {
        const err = _getLastWebviewErrorForTests(uri);
        if (err) throw new Error(`webview error in ${err.stage}: ${err.message}`);
        const ready = _getLastReadyForTests(uri);
        return !!ready && ready.length > 100;
      },
      8000,
      `webview never reported full content (last=${JSON.stringify(_getLastReadyForTests(uri))}, error=${JSON.stringify(_getLastWebviewErrorForTests(uri))})`,
    );
    const ready = _getLastReadyForTests(uri)!;
    assert.ok(ready.length > 100, `editor content too short: ${ready.length}`);
  });

  test("typing on the relay propagates to a fresh peer", async () => {
    // Sanity: with the editor still open, simulate another peer connecting
    // and observe a write made by yet another peer. This catches a regression
    // where the relay accepts seeds but doesn't broadcast updates.
    const uri = vscode.Uri.file(fixturePath("sample.md"));
    const room = roomFor(uri);

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = new WebsocketProvider(
      `ws://127.0.0.1:${RELAY_PORT}`, room, docA,
      { connect: true, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket },
    );
    const provB = new WebsocketProvider(
      `ws://127.0.0.1:${RELAY_PORT}`, room, docB,
      { connect: true, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket },
    );
    try {
      await waitFor(() => provA.wsconnected && provB.wsconnected, 5000);
      const tag = "\n<!-- inserted by test -->\n";
      docA.getText("doc").insert(docA.getText("doc").length, tag);
      await waitFor(() => docB.getText("doc").toString().includes(tag), 5000, "B never saw A's edit");
    } finally {
      provA.destroy();
      provB.destroy();
      docA.destroy();
      docB.destroy();
    }
  });
});
