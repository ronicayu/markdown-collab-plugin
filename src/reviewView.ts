import * as path from "path";
import * as vscode from "vscode";
import type { MarkdownCollabController } from "./commentController";
import {
  loadSidecar as defaultLoadSidecar,
  mdPathForSidecar,
  sidecarPathFor,
  type LoadResult,
} from "./sidecar";
import type { Comment } from "./types";

export type ReviewNode =
  | { kind: "file"; docPath: string; unresolvedCount: number; readOnly: boolean }
  | { kind: "comment"; docPath: string; comment: Comment; readOnly: boolean };

interface CacheEntry {
  unresolved: Comment[];
  readOnly: boolean;
}

/** Dependency-injected hooks — the defaults talk to the real filesystem/vscode. */
export interface ReviewViewDeps {
  loadSidecar?: (
    sidecarPath: string,
    onError?: (msg: string) => void,
  ) => Promise<LoadResult>;
  findFiles?: (pattern: vscode.RelativePattern) => Promise<vscode.Uri[]>;
}

const CONCURRENCY = 8;
const ORPHAN_REFRESH_DEBOUNCE_MS = 100;
// Per-path debounce for external-sidecar-change events. F2's watcher already
// debounces at 250ms per-path, but bursts that slip through (e.g., staggered
// writes from multiple tools) should still coalesce into a single re-read here
// rather than hammering the disk.
const EXTERNAL_CHANGE_DEBOUNCE_MS = 100;

/**
 * Cross-file overview of every sidecar in the workspace that has at least one
 * unresolved comment. Root nodes are files; leaf nodes are individual
 * unresolved comments. The scan is lazy — the filesystem isn't walked until the
 * user first expands the view — and the cache is invalidated granularly on F2
 * external-change events so rapid reply/resolve sequences don't thrash.
 */
export class ReviewView
  implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** docPath (md fsPath) -> cached unresolved summary */
  private readonly cache = new Map<string, CacheEntry>();

  private scanStarted = false;
  private scanComplete = false;

  private lastHasAny = false;

  private readonly loadSidecar: NonNullable<ReviewViewDeps["loadSidecar"]>;
  private readonly findFiles: NonNullable<ReviewViewDeps["findFiles"]>;

  private readonly subs: vscode.Disposable[] = [];
  private orphanRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** mdPath -> pending external-change timer, for per-path coalescing. */
  private readonly externalChangeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private disposed = false;

  constructor(
    private readonly controller: MarkdownCollabController,
    private readonly output: vscode.OutputChannel,
    deps: ReviewViewDeps = {},
  ) {
    this.loadSidecar = deps.loadSidecar ?? defaultLoadSidecar;
    this.findFiles =
      deps.findFiles ??
      (async (pattern: vscode.RelativePattern) =>
        await vscode.workspace.findFiles(pattern));

    // External sidecar change: re-read the single sidecar and refresh.
    // Per-path debounced so bursts for the same file coalesce into one re-read.
    this.subs.push(
      this.controller.onDidExternalSidecarChange((mdPath) => {
        this.scheduleExternalChange(mdPath);
      }),
    );

    // Orphan-change events may fire many times during a reply/resolve burst;
    // coalesce to a single refresh at the trailing edge.
    this.subs.push(
      this.controller.onDidChangeOrphans(() => {
        this.scheduleOrphanRefresh();
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
      item.contextValue = element.readOnly
        ? "markdownCollab.reviewFileReadOnly"
        : "markdownCollab.reviewFile";
      if (element.readOnly) {
        item.iconPath = new vscode.ThemeIcon("lock");
      }
      return item;
    }
    // kind === "comment"
    const snippet = truncate(element.comment.anchor.text, 40);
    const item = new vscode.TreeItem(
      snippet,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = truncate(element.comment.body, 60);
    item.tooltip = new vscode.MarkdownString(
      `**Body:** ${element.comment.body}\n\n` +
        `**Anchor:** \`${element.comment.anchor.text}\`\n\n` +
        `**Author:** ${element.comment.author}\n\n` +
        `**Created:** ${element.comment.createdAt}`,
    );
    item.contextValue = element.readOnly
      ? "markdownCollab.reviewCommentReadOnly"
      : "markdownCollab.reviewComment";
    if (!element.readOnly) {
      item.command = {
        command: "markdownCollab.revealComment",
        title: "Reveal Markdown Comment",
        arguments: [element],
      };
    }
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
      return entry.unresolved.map((comment) => ({
        kind: "comment" as const,
        docPath: element.docPath,
        comment,
        readOnly: entry.readOnly,
      }));
    }
    return [];
  }

  public dispose(): void {
    this.disposed = true;
    if (this.orphanRefreshTimer) {
      clearTimeout(this.orphanRefreshTimer);
      this.orphanRefreshTimer = null;
    }
    for (const timer of this.externalChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.externalChangeTimers.clear();
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
      if (entry.unresolved.length === 0) continue;
      nodes.push({
        kind: "file",
        docPath,
        unresolvedCount: entry.unresolved.length,
        readOnly: entry.readOnly,
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
        const pattern = new vscode.RelativePattern(
          folder,
          ".markdown-collab/**/*.md.json",
        );
        let sidecarUris: vscode.Uri[];
        try {
          sidecarUris = await this.findFiles(pattern);
        } catch (e) {
          this.output.appendLine(
            `ReviewView findFiles failed for ${folder.uri.fsPath}: ${(e as Error).message}`,
          );
          continue;
        }
        for (const uri of sidecarUris) {
          const wsRoot = folder.uri.fsPath;
          const sidecarPath = uri.fsPath;
          tasks.push(async () => {
            const mdPath = mdPathForSidecar(sidecarPath, wsRoot);
            if (!mdPath) return null;
            const entry = await this.readEntry(sidecarPath);
            if (!entry || entry.unresolved.length === 0) return null;
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
      this.output.appendLine(
        `ReviewView scan failed: ${(e as Error).message}`,
      );
    }
  }

  private async readEntry(sidecarPath: string): Promise<CacheEntry | null> {
    const loaded = await this.loadSidecar(sidecarPath, (msg) =>
      this.output.appendLine(msg),
    );
    if (!loaded) return null;
    const readOnly = loaded.mode === "read-only-unknown-version";
    const unresolved = loaded.sidecar.comments.filter((c) => !c.resolved);
    return { unresolved, readOnly };
  }

  /**
   * Re-read a single sidecar (keyed by md path) and update the cache. Used by
   * both onDidExternalSidecarChange (directly) and the orphan-event debounced
   * refresh (per open doc).
   */
  private async invalidateOne(mdPath: string): Promise<void> {
    if (this.disposed) return;
    const folder = this.folderForPath(mdPath);
    if (!folder) return;
    const sidecarPath = sidecarPathFor(mdPath, folder);
    if (!sidecarPath) return;
    const entry = await this.readEntry(sidecarPath);
    const existed = this.cache.has(mdPath);
    if (!entry || entry.unresolved.length === 0) {
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

  private folderForPath(mdPath: string): string | null {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      const root = f.uri.fsPath;
      const rel = path.relative(root, mdPath);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return root;
      }
    }
    return null;
  }

  /**
   * Debounced refresh for reply/resolve bursts. Collects currently-open md docs
   * that have a resolvable sidecar path, re-reads each, and fires a single
   * tree-data change event.
   */
  private scheduleOrphanRefresh(): void {
    if (this.disposed) return;
    if (this.orphanRefreshTimer) clearTimeout(this.orphanRefreshTimer);
    this.orphanRefreshTimer = setTimeout(() => {
      this.orphanRefreshTimer = null;
      void this.refreshOpenDocs();
    }, ORPHAN_REFRESH_DEBOUNCE_MS);
    this.orphanRefreshTimer.unref?.();
  }

  private scheduleExternalChange(mdPath: string): void {
    if (this.disposed) return;
    const existing = this.externalChangeTimers.get(mdPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.externalChangeTimers.delete(mdPath);
      void this.invalidateOne(mdPath);
    }, EXTERNAL_CHANGE_DEBOUNCE_MS);
    timer.unref?.();
    this.externalChangeTimers.set(mdPath, timer);
  }

  private async refreshOpenDocs(): Promise<void> {
    if (this.disposed) return;
    const docs = vscode.workspace.textDocuments ?? [];
    const targets: Array<{ mdPath: string; sidecarPath: string }> = [];
    for (const d of docs) {
      const mdPath = d.uri.fsPath;
      const folder = this.folderForPath(mdPath);
      if (!folder) continue;
      const sidecarPath = sidecarPathFor(mdPath, folder);
      if (!sidecarPath) continue;
      targets.push({ mdPath, sidecarPath });
    }
    if (targets.length === 0) return;
    let mutated = false;
    for (const t of targets) {
      const entry = await this.readEntry(t.sidecarPath);
      if (!entry || entry.unresolved.length === 0) {
        if (this.cache.delete(t.mdPath)) mutated = true;
      } else {
        this.cache.set(t.mdPath, entry);
        mutated = true;
      }
    }
    if (mutated && !this.disposed) {
      this.syncHasReviewContext();
      this._onDidChangeTreeData.fire();
    }
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
    // Before the first scan completes there are no entries by construction.
    // Only flip the key to `true` after the scan has actually run, else we'd
    // report "false" on startup correctly but then fail to flip true after
    // the cache is populated on the first reply.
    let hasAny = false;
    if (this.scanComplete || this.cache.size > 0) {
      for (const [, entry] of this.cache) {
        if (entry.unresolved.length > 0) {
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
