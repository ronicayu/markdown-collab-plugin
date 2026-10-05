import * as assert from "assert";
import * as vscode from "vscode";
import { FIXTURE, SENTINEL, activateExtension, sendFixture, waitFor } from "./sendHarness";

const VIEW_TYPE = "markdownCollab.collabEditor";

suite("Commands run from the review view", () => {
  const f = sendFixture("ask");

  suiteSetup(activateExtension);

  teardown(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  test("Send to Claude from the palette uses the file open in the review view", async () => {
    await f.setMode("clipboard");
    const warnings: string[] = [];
    const stubbable = vscode.window as unknown as { showWarningMessage: unknown };
    const originalWarning = stubbable.showWarningMessage;
    stubbable.showWarningMessage = (message: string): Promise<undefined> => {
      warnings.push(message);
      return Promise.resolve(undefined);
    };
    try {
      await vscode.commands.executeCommand("vscode.openWith", f.uri(), VIEW_TYPE);
      await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE;
      }, "the review view never became the active tab");
      assert.strictEqual(vscode.window.activeTextEditor, undefined);

      await vscode.commands.executeCommand("markdownCollab.sendAllToClaude");

      assert.deepStrictEqual(warnings, []);
      const copied = await vscode.env.clipboard.readText();
      assert.notStrictEqual(copied, SENTINEL);
      assert.ok(copied.includes(FIXTURE));
    } finally {
      stubbable.showWarningMessage = originalWarning;
    }
  });
});
