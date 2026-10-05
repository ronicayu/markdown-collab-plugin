// The folder a document belongs to, for features that need one.
//
// A `.md` opened on its own — `code notes.md`, a file dragged onto the editor,
// a doc outside every open folder — has no `vscode.WorkspaceFolder`. Several
// features asked for one and refused outright when it was missing, which is how
// a loose file ended up unable to take a comment at all.
//
// Almost nothing here actually needs a *workspace*; what the callers need is a
// base directory: somewhere to look for review conventions, somewhere to put
// the event log, and something to make the document's path relative to. The
// file's own directory answers all three. So this returns the real workspace
// folder when there is one and a folder-shaped value rooted at the file's
// directory when there isn't.
//
// Review state itself never needs this: threads live inside the .md.

import * as path from "path";
import * as vscode from "vscode";

/**
 * The document's workspace folder, or a stand-in rooted at its directory.
 *
 * The stand-in is deliberately a plain object rather than anything registered
 * with VS Code — it is a base path with a name, used for the payload's relative path
 * and per-folder state, and it must never be mistaken for an open folder.
 */
export function folderForDocument(uri: vscode.Uri): vscode.WorkspaceFolder {
  const real = vscode.workspace.getWorkspaceFolder(uri);
  if (real) return real;
  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  return { uri: dir, name: path.basename(dir.fsPath) || dir.fsPath, index: 0 };
}

const AGENT_FOLDER_KEY = "markdownCollab.agentFolder";

/**
 * The folder agent config lives in: the one Connect an Agent last chose in a
 * multi-root window, while it is still open, else the first folder. A
 * single-root window never stores one, so it always answers its only folder.
 */
export function agentFolder(context: vscode.ExtensionContext): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  const stored = context.workspaceState.get<string>(AGENT_FOLDER_KEY);
  return folders?.find((f) => f.uri.toString() === stored) ?? folders?.[0];
}

export function setAgentFolder(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): Thenable<void> {
  return context.workspaceState.update(AGENT_FOLDER_KEY, folder.uri.toString());
}

/** True when the document sits outside every open workspace folder. */
export function isLooseDocument(uri: vscode.Uri): boolean {
  return vscode.workspace.getWorkspaceFolder(uri) === undefined;
}

/**
 * The path a prompt names the document by. Workspace-relative is only
 * unambiguous with a single open folder holding the file; with several folders
 * the agent's tools would try the same relative path in each of them, and a
 * loose file has no folder to be relative to — both name the absolute path.
 */
export function promptPathFor(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder && vscode.workspace.workspaceFolders?.length === 1) {
    return path.relative(folder.uri.fsPath, uri.fsPath);
  }
  return uri.fsPath;
}
