/**
 * "Uncommitted changes" review view — the local counterpart of the PR/MR
 * review feature. Lists markdown files in the workspace that differ from
 * HEAD (staged, unstaged, or untracked) and opens each one in the inline
 * comments panel with diff stripes overlaid, so review comments land as
 * `<!--mc:…-->` threads in the file itself instead of on a platform PR.
 *
 * No platform CLI, no remote — plain `git` against the working tree.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { ChangedFile } from "../pr/diff";
import { InlineCommentsPanel } from "../inlineComments/inlineCommentsPanel";
import type { Logger } from "../logging";
import { listUncommittedMarkdownFiles, repoRootFor } from "./gitUncommitted";

interface DirNode {
  kind: "dir";
  name: string;
  fullPath: string;
  children: TreeNode[];
}

interface FileNode {
  kind: "file";
  name: string;
  file: ChangedFile;
}

type TreeNode = DirNode | FileNode;

const VIEW_ID = "markdownCollab.uncommittedFiles";

export class UncommittedChangesController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tree: UncommittedTreeProvider;
  private readonly view: vscode.TreeView<TreeNode>;
  private repoRoot: string | null = null;
  /** Serializes refreshes; a refresh requested mid-refresh runs once more after. */
  private refreshing: Promise<void> | null = null;
  private refreshQueued = false;

  constructor(
    private readonly openFile: (uri: vscode.Uri, opts: { showDiff: boolean }) => Promise<void>,
    private readonly log: Logger,
  ) {
    this.tree = new UncommittedTreeProvider();
    this.view = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this.tree,
      showCollapseAll: false,
    });
    this.disposables.push(
      this.view,
      vscode.commands.registerCommand("markdownCollab.reviewUncommittedChanges", async () => {
        await this.refresh();
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      }),
      vscode.commands.registerCommand("markdownCollab.uncommittedRefresh", () => this.refresh()),
      vscode.commands.registerCommand(
        "markdownCollab.openUncommittedFile",
        (file: ChangedFile) => this.open(file),
      ),
      // Saves change what's uncommitted; so do file creates/deletes/renames.
      // Git-only transitions (commit, stash) have no workspace file event —
      // those are covered by the refresh command and panel visibility refetch.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (isMarkdown(doc.uri.fsPath)) void this.refresh();
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        if (e.files.some((f) => isMarkdown(f.fsPath))) void this.refresh();
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        if (e.files.some((f) => isMarkdown(f.fsPath))) void this.refresh();
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        if (e.files.some((f) => isMarkdown(f.newUri.fsPath) || isMarkdown(f.oldUri.fsPath))) {
          void this.refresh();
        }
      }),
    );
    void this.refresh();
  }

  /** Re-query git and rebuild the tree. Also refreshes open diff-mode panels. */
  private refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.setTreeState({ kind: "no-workspace" });
      return;
    }
    if (!this.repoRoot) {
      this.repoRoot = await repoRootFor(folder.uri.fsPath);
    }
    if (!this.repoRoot) {
      this.setTreeState({ kind: "no-repo" });
      return;
    }
    try {
      const files = await listUncommittedMarkdownFiles(this.repoRoot);
      this.setTreeState({ kind: "files", repoRoot: this.repoRoot, files });
      InlineCommentsPanel.refreshDiffPanels();
    } catch (e) {
      this.log.warn(`uncommitted refresh failed: ${(e as Error).message}`);
      this.setTreeState({ kind: "error", message: (e as Error).message });
    }
  }

  private setTreeState(state: TreeState): void {
    this.tree.setState(state);
    const empty = state.kind !== "files" || state.files.length === 0;
    this.view.message = empty ? this.tree.emptyMessage : undefined;
  }

  private async open(file: ChangedFile): Promise<void> {
    if (!this.repoRoot) return;
    const abs = path.join(this.repoRoot, ...file.path.split("/"));
    await this.openFile(vscode.Uri.file(abs), { showDiff: true });
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.length = 0;
  }
}

type TreeState =
  | { kind: "no-workspace" }
  | { kind: "no-repo" }
  | { kind: "error"; message: string }
  | { kind: "files"; repoRoot: string; files: ChangedFile[] };

class UncommittedTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private state: TreeState = { kind: "files", repoRoot: "", files: [] };
  private rootChildren: TreeNode[] = [];

  setState(state: TreeState): void {
    this.state = state;
    this.rootChildren = state.kind === "files" ? buildTree(state.files) : [];
    this.emitter.fire();
  }

  /** Message shown via the view's welcome content when the tree is empty. */
  get emptyMessage(): string {
    switch (this.state.kind) {
      case "no-workspace":
        return "Open a folder to review uncommitted changes.";
      case "no-repo":
        return "This folder is not a git repository.";
      case "error":
        return `git failed: ${this.state.message}`;
      default:
        return "No uncommitted markdown changes.";
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.rootChildren;
    if (node.kind === "dir") return node.children;
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "dir") {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = "uncommittedDir";
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    const status =
      node.file.status === "A" ? "new" :
      node.file.status === "R" ? "renamed" : "modified";
    item.description = status;
    item.tooltip = `${node.file.path} (${status}, uncommitted)`;
    item.resourceUri = vscode.Uri.file(node.file.path);
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = "uncommittedFile";
    item.command = {
      command: "markdownCollab.openUncommittedFile",
      title: "Review uncommitted changes",
      arguments: [node.file],
    };
    return item;
  }
}

function isMarkdown(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function buildTree(files: ChangedFile[]): TreeNode[] {
  interface MutableDir { name: string; fullPath: string; dirs: Map<string, MutableDir>; files: FileNode[]; }
  const root: MutableDir = { name: "", fullPath: "", dirs: new Map(), files: [] };

  for (const f of files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = f.path.split("/");
    const fileName = parts.pop() ?? f.path;
    let cursor = root;
    let acc = "";
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = cursor.dirs.get(seg);
      if (!child) {
        child = { name: seg, fullPath: acc, dirs: new Map(), files: [] };
        cursor.dirs.set(seg, child);
      }
      cursor = child;
    }
    cursor.files.push({ kind: "file", name: fileName, file: f });
  }

  const toNodes = (m: MutableDir): TreeNode[] => {
    const dirs: TreeNode[] = Array.from(m.dirs.values()).map<DirNode>((d) => ({
      kind: "dir",
      name: d.name,
      fullPath: d.fullPath,
      children: toNodes(d),
    }));
    return [...dirs, ...m.files];
  };
  return toNodes(root);
}
