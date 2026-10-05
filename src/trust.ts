import * as vscode from "vscode";

export function requireTrust(what: string): boolean {
  if (vscode.workspace.isTrusted) return true;
  void Promise.resolve(
    vscode.window.showWarningMessage(
      `Markdown Collab: ${what} is off in Restricted Mode — trust this workspace to use it.`,
      "Manage Workspace Trust",
    ),
  ).then((choice) => {
    if (choice === "Manage Workspace Trust") {
      void vscode.commands.executeCommand("workbench.trust.manage");
    }
  });
  return false;
}
