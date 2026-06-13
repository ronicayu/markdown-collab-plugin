import * as path from "path";
import * as vscode from "vscode";
import { parse, type InlineThread } from "./inlineComments/format";

export type ReviewNode =
  | { kind: "file"; docPath: string; unresolvedCount: number }
  | { kind: "comment"; docPath: string; thread: InlineThread };

interface CacheEntry {
  /** Open (unresolved) inline threads in document order. */
  openThreads: InlineThread[];
}

/** Dependency-injected hooks — the defaults talk to the real filesystem/vscode. */
export interface ReviewViewDeps {
  /** Return every `.md` URI under a workspace folder. */
  findFiles?: (folder: vscode.WorkspaceFolder) => Promise<vscode.Uri[]>;
  /** Read a file's text, or null when it can't be read. */
  readFile?: (fsPath: string) => Promise<string | null>;
  /**
   * Install change/delete listeners and return a disposable. The default wires
   * a `**​/*.md` filesystem watcher plus save events. Tests inject a fake so
   * they can drive change/delete deterministically.
   */
  watch?: (handlers: {
    onChange: (fsPath: string) => void;
    onDelete: (fsPath: string) => void;
  }) => vscode.Disposable;
}

const CONCURRENCY = 8;
const FILE_CHANGE_DEBOUNCE_MS = 100;
const MARKDOWN_GLOB = "**/*.{md,markdown}";
const THREADS_MARKER = "<!--mc:threads:begin-->";

function isMarkdownPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** Skip vendored trees the full scan also excludes, so the watcher and scan agree. */
function isVendored(p: string): boolean {
  return /(^|[\\/])node_modules[\\/]/.test(p);
}

/**
 * Cross-file overview of every `.md` in the workspace that has at least one
 * unresolved inline-comment thread (`<!--mc:t ...-->` with `status:"open"`).
 * Root nodes are files; leaf nodes are individual open threads. The scan is
 * lazy — the filesystem isn't walked until the user first expands the view —
 * and a `.md` filesystem watcher refreshes single files as they change so
 * rapid reply/resolve sequences don't trigger a full rescan.
 */
export class ReviewView
  implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** docPath (md fsPath) -> cached open-thread summary */
  private readonly cache = new Map<string, CacheEntry>();

  private scanStarted = false;
  private scanComplete = false;
  private lastHasAny = false;

  private readonly findFiles: NonNullable<ReviewViewDeps["findFiles"]>;
  private readonly readFile: NonNullable<ReviewViewDeps["readFile"]>;

  private readonly subs: vscode.Disposable[] = [];
  /** mdPath -> pending change timer, for per-path coalescing. */
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly output: vscode.OutputChannel,
    deps: ReviewViewDeps = {},
  ) {
    this.findFiles =
      deps.findFiles ??
      (async (folder: vscode.WorkspaceFolder) =>
        await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, MARKDOWN_GLOB),
          "**/node_modules/**",
        ));
    this.readFile = deps.readFile ?? defaultReadFile;

    const watch = deps.watch ?? defaultWatch;
    this.subs.push(
      watch({
        onChange: (p) => this.scheduleFileChange(p),
        onDelete: (p) => this.removeFile(p),
      }),
    );

    // Workspace folder changes invalidate the entire cache and re-scan.
    this.subs.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.cache.clear();
        this.scanStarted = false;
        this.scanComplete = false;
        this.syncHasReviewContext();
        this._onDidChangeTreeData.fire();
      }),
    );

    // Seed context key to false on construction.
    this.syncHasReviewContext();
  }

  public getTreeItem(element: ReviewNode): vscode.TreeItem {
    if (element.kind === "file") {
      const label = path.basename(element.docPath);
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.resourceUri = vscode.Uri.file(element.docPath);
      item.description = `${this.relativeDocPath(element.docPath)} (${element.unresolvedCount})`;
      item.contextValue = "markdownCollab.reviewFile";
      return item;
    }
    // kind === "comment"
    const head = headComment(element.thread);
    const snippet = truncate(element.thread.quote || "(unanchored)", 40);
    const item = new vscode.TreeItem(snippet, vscode.TreeItemCollapsibleState.None);
    item.description = truncate(head.body, 60);
    item.tooltip = new vscode.MarkdownString(
      `**Body:** ${head.body}\n\n` +
        `**Anchor:** \`${element.thread.quote}\`\n\n` +
        `**Author:** ${head.author}\n\n` +
        `**Created:** ${head.ts}`,
    );
    item.contextValue = "markdownCollab.reviewComment";
    item.command = {
      command: "markdownCollab.revealComment",
      title: "Reveal Markdown Comment",
      arguments: [element],
    };
    return item;
  }

  public getChildren(element?: ReviewNode): ReviewNode[] | Thenable<ReviewNode[]> {
    if (!element) {
      if (!this.scanStarted) {
        this.scanStarted = true;
        // Fire-and-forget — the view refreshes via onDidChangeTreeData when done.
        void this.runFullScan();
        return [];
      }
      return this.buildFileNodes();
    }
    if (element.kind === "file") {
      const entry = this.cache.get(element.docPath);
      if (!entry) return [];
      return entry.openThreads.map((thread) => ({
        kind: "comment" as const,
        docPath: element.docPath,
        thread,
      }));
    }
    return [];
  }

  public dispose(): void {
    this.disposed = true;
    for (const timer of this.changeTimers.values()) clearTimeout(timer);
    this.changeTimers.clear();
    for (const d of this.subs) {
      try {
        d.dispose();
      } catch {
        /* swallow */
      }
    }
    this.subs.length = 0;
    this._onDidChangeTreeData.dispose();
    // Reset context key so the view hides itself on reload/unload.
    void vscode.commands.executeCommand(
      "setContext",
      "markdownCollab.hasReview",
      false,
    );
  }

  // -------------------------------------------------------------------------
  // Internal: scan & cache management
  // -------------------------------------------------------------------------

  private buildFileNodes(): ReviewNode[] {
    const nodes: ReviewNode[] = [];
    for (const [docPath, entry] of this.cache) {
      if (entry.openThreads.length === 0) continue;
      nodes.push({
        kind: "file",
        docPath,
        unresolvedCount: entry.openThreads.length,
      });
    }
    nodes.sort((a, b) => a.docPath.localeCompare(b.docPath));
    return nodes;
  }

  private async runFullScan(): Promise<void> {
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const tasks: Array<() => Promise<{ mdPath: string; entry: CacheEntry } | null>> = [];

      for (const folder of folders) {
        let uris: vscode.Uri[];
        try {
          uris = await this.findFiles(folder);
        } catch (e) {
          this.output.appendLine(
            `ReviewView findFiles failed for ${folder.uri.fsPath}: ${(e as Error).message}`,
          );
          continue;
        }
        for (const uri of uris) {
          const mdPath = uri.fsPath;
          tasks.push(async () => {
            const entry = await this.readEntry(mdPath);
            if (!entry || entry.openThreads.length === 0) return null;
            return { mdPath, entry };
          });
        }
      }

      const results = await pMap(tasks, CONCURRENCY, (fn) => fn());
      if (this.disposed) return;

      this.cache.clear();
      for (const r of results) {
        if (!r) continue;
        this.cache.set(r.mdPath, r.entry);
      }
      this.scanComplete = true;
      this.syncHasReviewContext();
      this._onDidChangeTreeData.fire();
    } catch (e) {
      this.output.appendLine(`ReviewView scan failed: ${(e as Error).message}`);
    }
  }

  /** Parse a `.md` file and collect its open inline threads. */
  private async readEntry(mdPath: string): Promise<CacheEntry | null> {
    const text = await this.readFile(mdPath);
    if (text === null) return null;
    // Fast-path: skip the full code-mask/marker parse for the overwhelming
    // majority of docs that carry no threads region at all.
    if (!text.includes(THREADS_MARKER)) return { openThreads: [] };
    const open = parse(text).threads.filter(
      (t) => t.status === "open" && t.comments.some((c) => !c.deleted),
    );
    return { openThreads: open };
  }

  private scheduleFileChange(mdPath: string): void {
    // Ignore until the first scan has started (the lazy scan will pick up the
    // current state on expand) and skip non-markdown / vendored paths the scan
    // itself excludes, so the watcher and scan never disagree.
    if (this.disposed || !this.scanStarted || !isMarkdownPath(mdPath) || isVendored(mdPath)) {
      return;
    }
    const existing = this.changeTimers.get(mdPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.changeTimers.delete(mdPath);
      void this.invalidateOne(mdPath);
    }, FILE_CHANGE_DEBOUNCE_MS);
    timer.unref?.();
    this.changeTimers.set(mdPath, timer);
  }

  /** Re-read a single `.md` (keyed by path) and update the cache. */
  private async invalidateOne(mdPath: string): Promise<void> {
    if (this.disposed) return;
    if (!this.folderForPath(mdPath)) return;
    const entry = await this.readEntry(mdPath);
    const existed = this.cache.has(mdPath);
    if (!entry || entry.openThreads.length === 0) {
      if (existed) {
        this.cache.delete(mdPath);
        this.syncHasReviewContext();
        this._onDidChangeTreeData.fire();
      }
      return;
    }
    this.cache.set(mdPath, entry);
    this.syncHasReviewContext();
    this._onDidChangeTreeData.fire();
  }

  private removeFile(mdPath: string): void {
    if (this.disposed || !this.scanStarted) return;
    const t = this.changeTimers.get(mdPath);
    if (t) {
      clearTimeout(t);
      this.changeTimers.delete(mdPath);
    }
    if (this.cache.delete(mdPath)) {
      this.syncHasReviewContext();
      this._onDidChangeTreeData.fire();
    }
  }

  private folderForPath(mdPath: string): string | null {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      const root = f.uri.fsPath;
      const rel = path.relative(root, mdPath);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return root;
    }
    return null;
  }

  private relativeDocPath(docPath: string): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      const root = f.uri.fsPath;
      const rel = path.relative(root, docPath);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    }
    return docPath;
  }

  private syncHasReviewContext(): void {
    let hasAny = false;
    if (this.scanComplete || this.cache.size > 0) {
      for (const [, entry] of this.cache) {
        if (entry.openThreads.length > 0) {
          hasAny = true;
          break;
        }
      }
    }
    if (hasAny !== this.lastHasAny) {
      this.lastHasAny = hasAny;
      void vscode.commands.executeCommand(
        "setContext",
        "markdownCollab.hasReview",
        hasAny,
      );
    }
  }
}

interface HeadComment {
  body: string;
  author: string;
  ts: string;
}

/** First non-deleted comment of a thread, with safe fallbacks. */
function headComment(thread: InlineThread): HeadComment {
  const live = thread.comments.filter((c) => !c.deleted);
  const root = live[0];
  return {
    body: root?.body ?? "",
    author: root?.author ?? "unknown",
    ts: root?.ts ?? "",
  };
}

/** Default file reader: prefer an open editor's live text, else read from disk. */
async function defaultReadFile(fsPath: string): Promise<string | null> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  if (open) return open.getText();
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return null;
  }
}

/** Default watcher: a `**​/*.md` filesystem watcher plus markdown save events. */
function defaultWatch(handlers: {
  onChange: (fsPath: string) => void;
  onDelete: (fsPath: string) => void;
}): vscode.Disposable {
  const disps: vscode.Disposable[] = [];
  if (typeof vscode.workspace.createFileSystemWatcher === "function") {
    const w = vscode.workspace.createFileSystemWatcher(MARKDOWN_GLOB);
    disps.push(
      w,
      w.onDidChange((u) => handlers.onChange(u.fsPath)),
      w.onDidCreate((u) => handlers.onChange(u.fsPath)),
      w.onDidDelete((u) => handlers.onDelete(u.fsPath)),
    );
  }
  if (typeof vscode.workspace.onDidSaveTextDocument === "function") {
    disps.push(
      vscode.workspace.onDidSaveTextDocument((d) => handlers.onChange(d.uri.fsPath)),
    );
  }
  return {
    dispose: () => {
      for (const d of disps) {
        try {
          d.dispose();
        } catch {
          /* swallow */
        }
      }
    },
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/**
 * Tiny concurrency-limited map. Runs `tasks` with at most `limit` in flight,
 * preserving order of results. Kept inline to avoid adding a dependency.
 */
async function pMap<T, R>(
  tasks: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(tasks.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(limit, tasks.length));
  for (let i = 0; i < n; i++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = next++;
          if (idx >= tasks.length) return;
          results[idx] = await fn(tasks[idx]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}
