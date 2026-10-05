import * as vscode from "vscode";
import { isMarkdownPath } from "./pathUtils";

function tabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  const input = tab?.input;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}

/**
 * The Markdown file the user is looking at. The review view is a custom editor
 * and the Welcome page a webview tab, so `activeTextEditor` is undefined while
 * either has focus. Order: the active text editor; the active tab (a document
 * tab that is not Markdown ends the search); with focus on a non-document tab,
 * the one Markdown file shown by the other groups, if there is exactly one.
 */
export function activeMarkdownUri(): vscode.Uri | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.languageId === "markdown") return doc.uri;

  const groups = vscode.window.tabGroups;
  const active = groups.activeTabGroup.activeTab;
  const activeUri = tabUri(active);
  if (activeUri) return isMarkdownPath(activeUri.fsPath) ? activeUri : undefined;

  const found = new Map<string, vscode.Uri>();
  for (const group of groups.all) {
    if (group === groups.activeTabGroup) continue;
    const uri = tabUri(group.activeTab);
    if (uri && isMarkdownPath(uri.fsPath)) found.set(uri.toString(), uri);
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}
