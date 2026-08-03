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
 * with VS Code — it is a base path with a name, used for prompt-relative paths
 * and per-folder state, and it must never be mistaken for an open folder.
 */
export function folderForDocument(uri: vscode.Uri): vscode.WorkspaceFolder {
  const real = vscode.workspace.getWorkspaceFolder(uri);
  if (real) return real;
  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  return { uri: dir, name: path.basename(dir.fsPath) || dir.fsPath, index: 0 };
}

/** True when the document sits outside every open workspace folder. */
export function isLooseDocument(uri: vscode.Uri): boolean {
  return vscode.workspace.getWorkspaceFolder(uri) === undefined;
}
