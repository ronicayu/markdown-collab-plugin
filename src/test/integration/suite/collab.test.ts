// End-to-end tests that run inside a real VSCode Extension Host.
//
// These tests exercise the *extension surface* — they can't see what
// Milkdown eventually renders inside the webview iframe (the test host has
// no DOM access into webviews), but they can verify:
//
//   - the extension activated cleanly (no thrown errors at activate time)
//   - our customEditor + command are registered
//   - opening a .md with our viewType boots the webview and it reports
//     non-empty content back (catches the "empty editor" regression)
//   - the drawio-read message round-trip resolves with the file's contents
//
// The relay/seed/second-peer assertions that used to live here were removed
// in v0.34.44 along with the relay itself: the live editor is single-human +
// Claude (the human edits here; Claude edits the .md on disk; convergence is
// via the file, not a websocket). There is no port to probe and no peer to
// spin up.
//
// Both suites are skipped: they need a webview that actually executes its
// script, which requires a real display. In a headless/SSH test host the
// custom-editor tab opens but the webview iframe never boots. Run them from a
// developer's GUI session, or verify the same paths headless by rendering the
// compiled bundle (out/webview/client.js) in a browser with a stubbed
// acquireVsCodeApi.

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import * as fsp from "fs/promises";
import {
  _getDrawioReadHistoryForTests,
  _getHighlightedIdsForTests,
  _getLastReadyForTests,
  _getLastWebviewErrorForTests,
} from "../../../collab/collabEditorProvider";

const EXT_ID = "markdown-collab.markdown-collab-plugin";
const VIEW_TYPE = "markdownCollab.collabEditor";

function fixturePath(name: string): string {
  // The fixtures dir is copied alongside the compiled tests under
  // out/test/integration/fixtures by tsc.
  return path.resolve(__dirname, "..", "fixtures", name);
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

suite.skip("Collab editor integration (needs display)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} is not loaded; check publisher/name in package.json`);
    if (!ext.isActive) await ext.activate();
  });

  test("registers the custom editor + command", async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(
      cmds.includes("markdownCollab.openCollabEditor"),
      "openCollabEditor command not registered",
    );
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

  test("inline drawio link triggers a successful drawio-read round-trip", async () => {
    // The drawio fixture has a single paragraph-only `.drawio` link. When
    // the collab editor renders it, makeDrawioPlugin posts a
    // `drawio-read` message; CollabEditorProvider resolves the path and
    // streams the file content back. We can't see the rendered SVG from
    // the test host (it lives inside the webview's iframe), but we CAN
    // verify the message round-trip succeeded with the file's actual
    // contents — which is the wiring most likely to break.
    const uri = vscode.Uri.file(fixturePath("with-drawio.md"));
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    await waitFor(
      () => {
        const err = _getLastWebviewErrorForTests(uri);
        if (err) throw new Error(`webview error in ${err.stage}: ${err.message}`);
        const history = _getDrawioReadHistoryForTests(uri);
        return history.some((r) => r.ok && (r.content ?? "").includes("<mxfile"));
      },
      10000,
      `drawio-read never resolved successfully (history=${JSON.stringify(_getDrawioReadHistoryForTests(uri))})`,
    );

    const history = _getDrawioReadHistoryForTests(uri);
    const ok = history.find((r) => r.ok);
    assert.ok(ok, "no successful drawio-read result");
    assert.ok(
      (ok.content ?? "").includes("<mxGraphModel"),
      "drawio file content did not include <mxGraphModel>",
    );
    assert.strictEqual(ok.href, "diagrams/flow.drawio");
  });
});

// Skipped: asserts the live-editor anchor highlight end-to-end by having the
// webview report its decorated ids (`highlight-report` → _getHighlightedIdsForTests).
// It needs a webview that actually executes its script, which requires a real
// display. In this headless/SSH test host the custom-editor tab opens but the
// webview iframe never boots (no `ready-with-content`, no `highlight-report`),
// and `screencapture` fails with "could not create image from display". So this
// can only pass in a developer's GUI session.
//
// For headless verification of the same fix, render the compiled bundle
// (out/webview/client.js) in a browser instead — that path is display-free:
// feed it the host's `init` payload via a stubbed acquireVsCodeApi and assert a
// `.mdc-anchor-highlight[data-comment-id="rb824"]` span wraps the table-cell
// text. (Verified 2026-06-15: highlight-report ids = ["rb824"] for the bold
// table-cell anchor whose contextBefore is table markdown — the case the old
// context locator failed on.)
suite.skip("Live editor anchor highlight (real Milkdown, needs display)", () => {
  const tmpPath = fixturePath("zz-highlight-table.md");
  const tmpUri = vscode.Uri.file(tmpPath);
  const CONTENT = [
    "# Data principles",
    "",
    "| #     | Principle | Rationale |",
    "| :---- | :-------- | :-------- |",
    "| DP-1  | **<!--mc:a:rb824-->Single writer per domain<!--mc:/a:rb824-->** | Eliminates write conflicts. |",
    "",
    "<!--mc:threads:begin-->",
    '<!--mc:t {"id":"rb824","quote":"Single writer per domain","status":"open","comments":[{"id":"c1","author":"ron","ts":"2026-01-01T00:00:00Z","body":"why single writer?"}]}-->',
    "<!--mc:threads:end-->",
    "",
  ].join("\n");

  suiteSetup(async () => {
    await fsp.writeFile(tmpPath, CONTENT, "utf8");
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
  });
  suiteTeardown(async () => {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("highlights an anchor inside a bold table cell", async function () {
    this.timeout(40000);
    await vscode.commands.executeCommand("vscode.openWith", tmpUri, VIEW_TYPE);
    await waitFor(() => _getLastReadyForTests(tmpUri) !== undefined, 20000, "webview never booted");
    await waitFor(
      () => (_getHighlightedIdsForTests(tmpUri) ?? []).includes("rb824"),
      10000,
      `rb824 never highlighted (ids=${JSON.stringify(_getHighlightedIdsForTests(tmpUri))})`,
    );
  });
});
