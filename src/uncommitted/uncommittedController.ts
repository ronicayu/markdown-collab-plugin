/**
 * "Uncommitted changes" review view — the local counterpart of the PR/MR
 * review feature. Lists markdown files in the workspace that differ from
 * HEAD (staged, unstaged, or untracked) and opens each one in the review
 * view with diff stripes overlaid, so review comments land as
 * `<!--mc:…-->` threads in the file itself instead of on a platform PR.
 *
 * No platform CLI, no remote — plain `git` against the working tree.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { ChangedFile } from "../pr/diff";
import { InlineCommentsPanel } from "../inlineComments/inlineCommentsPanel";
import { CollabEditorProvider } from "../collab/collabEditorProvider";
import type { Logger } from "../logging";
import { requireTrust } from "../trust";
import {
  countReviewThreads,
  listUncommittedMarkdownFiles,
  repoRootFor,
  stageFile,
  stageStates,
  unstageFile,
  type StageState,
} from "./gitUncommitted";
import { SessionThreadReminderGate } from "./stageReminder";

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
  /** Missing when the stage query failed; the file still lists and opens. */
  stage?: StageState;
  /**
   * Review threads still embedded in the working-tree copy of this file.
   * Zero/absent when the file carries none, or when it couldn't be read —
   * either way it renders the same as "nothing to flag".
   */
  threadCount?: number;
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
  /** One stage-time reminder per file per session. */
  private readonly threadReminders = new SessionThreadReminderGate();

  constructor(
    /** Open a file in the review view — whichever one `markdownCollab.classicReviewView` picks. */
    private readonly openFile: (uri: vscode.Uri, opts: { showDiff: boolean }) => Promise<void>,
    private readonly log: Logger,
    /**
     * Open a file in the live editor with the diff overlay, whatever
     * `markdownCollab.classicReviewView` says. When absent, `openInLiveEditor`
     * silently does nothing.
     */
    private readonly openLiveFile?: (uri: vscode.Uri) => Promise<void>,
  ) {
    this.tree = new UncommittedTreeProvider();
    this.view = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this.tree,
      showCollapseAll: false,
    });
    this.disposables.push(
      this.view,
      vscode.commands.registerCommand("markdownCollab.reviewUncommittedChanges", async () => {
        if (!requireTrust("The uncommitted-changes view")) return;
        await this.refresh();
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      }),
      vscode.commands.registerCommand("markdownCollab.uncommittedRefresh", () => this.refresh()),
      vscode.commands.registerCommand(
        "markdownCollab.openUncommittedFile",
        (file: ChangedFile) => this.open(file),
      ),
      // The command above goes through the review view's router, which picks
      // the previous view while `markdownCollab.classicReviewView` is on; this
      // one always opens the live editor. No tree item or menu uses it.
      vscode.commands.registerCommand(
        "markdownCollab.openUncommittedFileInLiveEditor",
        (file: ChangedFile) => this.openInLiveEditor(file),
      ),
      vscode.commands.registerCommand(
        "markdownCollab.stageUncommittedFile",
        (node: TreeNode) => this.setStaged(node, true),
      ),
      vscode.commands.registerCommand(
        "markdownCollab.unstageUncommittedFile",
        (node: TreeNode) => this.setStaged(node, false),
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
    if (!vscode.workspace.isTrusted) {
      this.setTreeState({ kind: "no-repo" });
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
      // Best-effort: a failed stage query degrades to a list with no staged
      // badges, not to an empty view.
      const stages = await stageStates(this.repoRoot).catch(() => new Map<string, StageState>());
      const threadCounts = await this.readThreadCounts(files);
      this.setTreeState({ kind: "files", repoRoot: this.repoRoot, files, stages, threadCounts });
      InlineCommentsPanel.refreshDiffPanels();
      CollabEditorProvider.refreshDiffPanels();
    } catch (e) {
      this.log.warn(`uncommitted refresh failed: ${(e as Error).message}`);
      this.setTreeState({ kind: "error", message: (e as Error).message });
    }
  }

  /**
   * Threads still embedded in each file's *working-tree* copy — not HEAD's —
   * since staging is exactly the moment that content is about to be
   * committed. Best-effort per file: an unreadable file counts as carrying
   * none rather than failing the whole refresh.
   */
  private async readThreadCounts(files: ChangedFile[]): Promise<Map<string, number>> {
    const root = this.repoRoot;
    const counts = new Map<string, number>();
    if (!root) return counts;
    await Promise.all(
      files.map(async (f) => {
        try {
          const abs = path.join(root, ...f.path.split("/"));
          const text = await fs.readFile(abs, "utf8");
          const count = countReviewThreads(text);
          if (count > 0) counts.set(f.path, count);
        } catch {
          /* unreadable — treat as carrying no threads */
        }
      }),
    );
    return counts;
  }

  private setTreeState(state: TreeState): void {
    this.tree.setState(state);
    const empty = state.kind !== "files" || state.files.length === 0;
    this.view.message = empty ? this.tree.emptyMessage : undefined;
    // `doRefresh` already resolves the repo root (or fails to) to list
    // uncommitted files, so this context key rides along for free — no
    // separate git probe. "files" and "error" both mean a repo root was
    // found (an "error" state is a failed git query *inside* a known
    // repo); "no-workspace" and "no-repo" mean it wasn't.
    void vscode.commands.executeCommand(
      "setContext",
      "markdownCollab.workspaceHasGit",
      state.kind === "files" || state.kind === "error",
    );
  }

  private async open(file: ChangedFile): Promise<void> {
    if (!this.repoRoot) return;
    const abs = path.join(this.repoRoot, ...file.path.split("/"));
    await this.openFile(vscode.Uri.file(abs), { showDiff: true });
  }

  /** Open a file in the live editor with the uncommitted-diff overlay, even while `markdownCollab.classicReviewView` is on. */
  private async openInLiveEditor(file: ChangedFile): Promise<void> {
    if (!this.repoRoot || !this.openLiveFile) return;
    const abs = path.join(this.repoRoot, ...file.path.split("/"));
    await this.openLiveFile(vscode.Uri.file(abs));
  }

  /** Stage/unstage one file from its tree row, then re-query so the badge follows. */
  private async setStaged(node: TreeNode | undefined, staged: boolean): Promise<void> {
    if (!node || node.kind !== "file" || !this.repoRoot) return;
    try {
      if (staged) await stageFile(this.repoRoot, node.file.path);
      else await unstageFile(this.repoRoot, node.file.path);
    } catch (e) {
      this.log.warn(`${staged ? "stage" : "unstage"} failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `Could not ${staged ? "stage" : "unstage"} ${node.file.path}: ${(e as Error).message}`,
      );
    }
    if (staged && node.threadCount) {
      this.remindAboutThreads(node.file.path, node.threadCount);
    }
    await this.refresh();
  }

  /**
   * One nudge, once per file per session, when staging a file that still
   * carries review-thread data. This only ever points at the existing
   * "Remove All Review Data" command — it never runs it and never touches the
   * file itself; that command's own confirmation still applies.
   */
  private remindAboutThreads(relPath: string, count: number): void {
    if (!this.threadReminders.shouldRemind(relPath)) return;
    const root = this.repoRoot;
    const fileName = path.basename(relPath);
    const subject = count === 1 ? "1 thread is" : `${count} threads are`;
    void vscode.window
      .showInformationMessage(
        `${subject} still in ${fileName} — Remove All Review Data strips them before you commit.`,
        "Remove review data",
        "Keep them",
      )
      .then((choice) => {
        // "Keep them", or the toast dismissed with neither — do nothing
        // further. Never modify the file ourselves either way.
        if (choice !== "Remove review data" || !root) return;
        const abs = path.join(root, ...relPath.split("/"));
        void vscode.commands.executeCommand("markdownCollab.finalizeDocument", vscode.Uri.file(abs));
      });
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
    // Reset context key so the (now-gated) trees hide themselves on reload/unload.
    void vscode.commands.executeCommand(
      "setContext",
      "markdownCollab.workspaceHasGit",
      false,
    );
  }
}

type TreeState =
  | { kind: "no-workspace" }
  | { kind: "no-repo" }
  | { kind: "error"; message: string }
  | {
      kind: "files";
      repoRoot: string;
      files: ChangedFile[];
      stages?: Map<string, StageState>;
      threadCounts?: Map<string, number>;
    };

class UncommittedTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private state: TreeState = { kind: "files", repoRoot: "", files: [] };
  private rootChildren: TreeNode[] = [];

  setState(state: TreeState): void {
    this.state = state;
    this.rootChildren =
      state.kind === "files" ? buildTree(state.files, state.stages, state.threadCounts) : [];
    this.emitter.fire();
  }

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
    const stage = node.stage ?? "unstaged";
    item.description = stage === "unstaged" ? status : `${status} · ${stage}`;
    let tooltip = `${node.file.path} (${status}, ${stage})`;
    // A small marker, not a warning: nothing here is wrong, it's just what
    // "Remove All Review Data" is for.
    if (node.threadCount) {
      const label = node.threadCount === 1 ? "1 thread" : `${node.threadCount} threads`;
      item.description += ` · ${label}`;
      tooltip += ` — ${label} still in the file`;
    }
    item.tooltip = tooltip;
    item.resourceUri = vscode.Uri.file(node.file.path);
    item.iconPath = vscode.ThemeIcon.File;
    // The stage state rides on contextValue so the inline +/− buttons follow
    // it: partial offers both, like the built-in SCM view. The "-threads"
    // suffix is additive — it doesn't change the `uncommittedFile-<stage>`
    // prefix the stage/unstage menu regexes match on.
    item.contextValue = `uncommittedFile-${stage}${node.threadCount ? "-threads" : ""}`;
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

function buildTree(
  files: ChangedFile[],
  stages?: Map<string, StageState>,
  threadCounts?: Map<string, number>,
): TreeNode[] {
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
    cursor.files.push({
      kind: "file",
      name: fileName,
      file: f,
      stage: stages?.get(f.path),
      threadCount: threadCounts?.get(f.path),
    });
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
