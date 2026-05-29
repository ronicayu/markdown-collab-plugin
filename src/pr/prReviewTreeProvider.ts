/**
 * Tree view of the markdown files changed in the active PR / MR.
 *
 * Replaces the QuickPick file picker. Directory nesting mirrors the
 * Explorer (paths split on `/`). Each leaf shows the file's diff status
 * plus the number of unsubmitted drafts on it. Clicking a leaf opens
 * the file in the preview-mode PR review panel.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { ChangedFile } from "./diff";

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
  draftCount: number;
}

type TreeNode = DirNode | FileNode;

export interface PrReviewTreeDeps {
  /** Click handler — invoked when the user activates a file leaf. */
  onOpenFile: (file: ChangedFile) => void;
  /** Returns the current draft count for `relPath`. */
  getDraftCount: (relPath: string) => number;
}

export class PrReviewTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private rootChildren: TreeNode[] = [];

  constructor(private readonly deps: PrReviewTreeDeps) {}

  /** Reset the tree to reflect a new set of changed files. */
  setFiles(files: ChangedFile[]): void {
    this.rootChildren = buildTree(files, this.deps.getDraftCount);
    this.emitter.fire();
  }

  /** Re-render — pulls fresh draft counts. Call after every draft mutation. */
  refresh(): void {
    // Rebuild from the same files we already have so the file list stays stable.
    const flat = flatten(this.rootChildren);
    this.rootChildren = buildTree(flat, this.deps.getDraftCount);
    this.emitter.fire();
  }

  clear(): void {
    this.rootChildren = [];
    this.emitter.fire();
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
      item.contextValue = "prReviewDir";
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    const status =
      node.file.status === "A" ? "added" :
      node.file.status === "R" ? "renamed" : "modified";
    const draftPart =
      node.draftCount > 0
        ? `${status} · ${node.draftCount} draft${node.draftCount === 1 ? "" : "s"}`
        : status;
    item.description = draftPart;
    item.tooltip = `${node.file.path} (${draftPart})`;
    item.resourceUri = vscode.Uri.file(node.file.path);
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = "prReviewFile";
    item.command = {
      command: "markdownCollab.openPrReviewFile",
      title: "Open in PR review",
      arguments: [node.file],
    };
    return item;
  }
}

function flatten(nodes: TreeNode[]): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const n of nodes) {
    if (n.kind === "file") out.push(n.file);
    else out.push(...flatten(n.children));
  }
  return out;
}

function buildTree(files: ChangedFile[], getDraftCount: (p: string) => number): TreeNode[] {
  // Build a tree from the directory segments. Single-child chains are
  // collapsed visually by VS Code automatically (expanded state); we just
  // produce honest nested nodes.
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
    cursor.files.push({ kind: "file", name: fileName, file: f, draftCount: getDraftCount(f.path) });
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

/** Best-effort: derive a short directory-only display path for a file. */
export function directoryOnly(p: string): string {
  const dir = path.dirname(p);
  return dir === "." ? "" : dir;
}
