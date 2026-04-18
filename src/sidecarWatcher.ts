import * as fs from "fs/promises";
import * as vscode from "vscode";
import { mdPathForSidecar, wasSelfWrite } from "./sidecar";

/**
 * Minimal contract the watcher needs from the controller. Keeping this as an
 * interface rather than importing `MarkdownCollabController` directly keeps the
 * watcher unit-testable against a hand-rolled fake and prevents a circular
 * import chain between the watcher and the controller.
 */
export interface WatcherControllerHost {
  /** Rebuild threads for a currently-open markdown document. */
  reload(doc: vscode.TextDocument): Promise<void>;
  /** True when a reload is already queued/in-flight for the given md fsPath. */
  isReloading(uriFsPath: string): boolean;
  /**
   * Notify downstream consumers (orphan tree / future cache layers) that the
   * sidecar for an unopened md file changed. No-op for now; F3 will subscribe.
   */
  onExternalChange(uriFsPath: string): void;
}

const DEBOUNCE_MS = 250;

/**
 * Watches `**\/.markdown-collab/**\/*.md.json` for external mutations and
 * triggers controller reloads. Four suppression paths:
 *
 *   1. Debounce — coalesce bursts of create/change events for the same path
 *      into a single handler invocation.
 *   2. Self-write suppression — echoes of our own `saveSidecar` output are
 *      skipped via a content-hash token set.
 *   3. Queue-aware skip — if the controller is already reloading this URI
 *      (user is mid-mutation), rely on the in-flight reload rather than
 *      stacking another one behind it.
 *   4. Not-open fall-through — sidecars for files that aren't currently open
 *      are forwarded via `onExternalChange` for downstream cache invalidation
 *      (F3) instead of attempting to reload a doc that VS Code isn't tracking.
 */
export class SidecarWatcher implements vscode.Disposable {
  private readonly fsWatcher: {
    onDidCreate: (cb: (uri: vscode.Uri) => void) => vscode.Disposable;
    onDidChange: (cb: (uri: vscode.Uri) => void) => vscode.Disposable;
    onDidDelete: (cb: (uri: vscode.Uri) => void) => vscode.Disposable;
    dispose: () => void;
  };
  private readonly subs: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly host: WatcherControllerHost,
    private readonly output: vscode.OutputChannel,
  ) {
    // The glob intentionally uses a leading `**/` so it matches the sidecar
    // root under any workspace folder, not just the top-level one.
    this.fsWatcher = vscode.workspace.createFileSystemWatcher(
      "**/.markdown-collab/**/*.md.json",
    ) as unknown as typeof this.fsWatcher;
    this.subs.push(
      this.fsWatcher.onDidCreate((uri) => this.schedule(uri, "create")),
      this.fsWatcher.onDidChange((uri) => this.schedule(uri, "change")),
      this.fsWatcher.onDidDelete((uri) => this.schedule(uri, "delete")),
    );
  }

  /**
   * Debounce a raw FS event for one sidecar path. 250ms trailing-edge: a
   * rapid-fire sequence (rename-atomic write on some platforms produces
   * delete+create+change) collapses to a single handler call.
   */
  private schedule(uri: vscode.Uri, kind: "create" | "change" | "delete"): void {
    if (this.disposed) return;
    const key = uri.fsPath;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.timers.delete(key);
      void this.handleEvent(uri, kind);
    }, DEBOUNCE_MS);
    handle.unref?.();
    this.timers.set(key, handle);
  }

  private async handleEvent(
    uri: vscode.Uri,
    kind: "create" | "change" | "delete",
  ): Promise<void> {
    if (this.disposed) return;
    const sidecarPath = uri.fsPath;

    // Map the sidecar path back to the md file it describes by trying each
    // workspace folder root (the watcher glob is workspace-wide, and we don't
    // know a priori which folder contains this sidecar).
    const folders = vscode.workspace.workspaceFolders ?? [];
    let mdPath: string | null = null;
    for (const folder of folders) {
      const candidate = mdPathForSidecar(sidecarPath, folder.uri.fsPath);
      if (candidate !== null) {
        mdPath = candidate;
        break;
      }
    }
    if (mdPath === null) {
      // Sidecar didn't resolve to any workspace's md file (e.g. stray file
      // under a nested .markdown-collab/ outside a known folder). Ignore.
      return;
    }

    // Queue-aware skip: the controller is mid-write on this URI — the
    // saveSidecar call will finish and the next natural reload picks up the
    // final state. Triggering another reload here would race disposeThreadsFor
    // against an in-progress reply render.
    if (this.host.isReloading(mdPath)) {
      return;
    }

    // Self-write suppression (skipped on delete — nothing to hash). Reading
    // the file after every change keeps the check path simple; the cost is
    // one read per external event which is already a rare operation.
    if (kind !== "delete") {
      try {
        const contents = await fs.readFile(sidecarPath, "utf8");
        if (await wasSelfWrite(sidecarPath, contents)) {
          return;
        }
      } catch {
        // Read failed (ENOENT from a still-settling rename; perms; etc.) —
        // fall through. A subsequent debounced event will likely re-fire.
      }
    }

    // Find the open md doc, if any. VS Code uri.toString() comparisons can be
    // normalization-sensitive; fsPath equality is sufficient for local files.
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === mdPath);
    if (doc) {
      try {
        await this.host.reload(doc);
      } catch (e) {
        this.output.appendLine(
          `SidecarWatcher reload failed for ${mdPath}: ${(e as Error).message}`,
        );
      }
      return;
    }

    // Doc not open — hand to the external-change hook so orphan caches / the
    // future F3 tree can invalidate without forcing the doc into memory.
    try {
      this.host.onExternalChange(mdPath);
    } catch (e) {
      this.output.appendLine(
        `SidecarWatcher onExternalChange threw for ${mdPath}: ${(e as Error).message}`,
      );
    }
  }

  public dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const s of this.subs) {
      try {
        s.dispose();
      } catch {
        /* swallow */
      }
    }
    try {
      this.fsWatcher.dispose();
    } catch {
      /* swallow */
    }
  }
}
