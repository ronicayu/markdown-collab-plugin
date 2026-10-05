import * as os from "os";
import * as vscode from "vscode";

export function currentAuthorName(): string {
  const configured = vscode.workspace
    .getConfiguration("markdownCollab")
    .get<string>("collab.userName", "")
    .trim();
  if (configured) return configured;
  try {
    return os.userInfo().username || "anonymous";
  } catch {
    return "anonymous";
  }
}
