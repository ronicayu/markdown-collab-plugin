import * as vscode from "vscode";
import type { MarkdownCollabController } from "./commentController";
import type { Comment } from "./types";

type Node =
  | { kind: "file"; docPath: string }
  | { kind: "orphan"; docPath: string; comment: Comment };

export class OrphanView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private lastHasAny = false;

  constructor(private readonly controller: MarkdownCollabController) {
    controller.onDidChangeOrphans(() => {
      this._onDidChangeTreeData.fire();
      this.syncHasOrphansContext();
    });
    // Establish the context key at construction so the view's `when` clause
    // reflects reality before the first refresh.
    this.syncHasOrphansContext();
  }

  public getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === "file") {
      const label = element.docPath.split(/[\\/]/).pop() ?? element.docPath;
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = element.docPath;
      item.resourceUri = vscode.Uri.file(element.docPath);
      item.contextValue = "markdownCollab.orphanFile";
      return item;
    }
    const snippet = truncate(element.comment.anchor.text, 40);
    const item = new vscode.TreeItem(
      snippet,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = truncate(element.comment.body, 60);
    item.tooltip = new vscode.MarkdownString(
      `**Body:** ${element.comment.body}\n\n**Anchor:** \`${element.comment.anchor.text}\``,
    );
    item.contextValue = "markdownCollab.orphanComment";
    // No `item.command`: clicking a leaf just selects it. Re-attach is a
    // right-click menu action (see `view/item/context` in package.json) so
    // users don't trigger a potentially destructive operation on a single
    // selection click.
    return item;
  }

  public getChildren(element?: Node): Node[] {
    const orphans = this.controller.getOrphans();
    if (!element) {
      const files: Node[] = [];
      for (const [docPath, list] of orphans) {
        if (list.length > 0) files.push({ kind: "file", docPath });
      }
      return files;
    }
    if (element.kind === "file") {
      const list = orphans.get(element.docPath) ?? [];
      return list.map((comment) => ({
        kind: "orphan" as const,
        docPath: element.docPath,
        comment,
      }));
    }
    return [];
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
    // Reset the context key so the view hides itself on reload/unload.
    void vscode.commands.executeCommand(
      "setContext",
      "markdownCollab.hasOrphans",
      false,
    );
  }

  private syncHasOrphansContext(): void {
    const orphans = this.controller.getOrphans();
    let hasAny = false;
    for (const [, list] of orphans) {
      if (list.length > 0) {
        hasAny = true;
        break;
      }
    }
    if (hasAny !== this.lastHasAny) {
      this.lastHasAny = hasAny;
      void vscode.commands.executeCommand(
        "setContext",
        "markdownCollab.hasOrphans",
        hasAny,
      );
    }
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
