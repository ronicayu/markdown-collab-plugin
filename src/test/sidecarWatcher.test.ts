import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { saveSidecar, __resetSelfWriteTokens, sidecarPathFor } from "../sidecar";
import type { Sidecar } from "../types";
import { SidecarWatcher, type WatcherControllerHost } from "../sidecarWatcher";
import { Uri, workspace, window } from "./vscode-stub";

/**
 * Hand-rolled fake FileSystemWatcher — we capture the callbacks the watcher
 * installs and fire them synchronously from tests. This lets us assert the
 * debounce window, self-write suppression, and queue-aware skip behavior
 * without touching the real filesystem-events subsystem.
 */
type HandlerSet = {
  onDidCreate?: (uri: any) => void;
  onDidChange?: (uri: any) => void;
  onDidDelete?: (uri: any) => void;
  disposed: boolean;
};

function installFakeWatcher(): HandlerSet {
  const set: HandlerSet = { disposed: false };
  (workspace as any).createFileSystemWatcher = (_glob: string) => ({
    onDidCreate: (cb: any) => {
      set.onDidCreate = cb;
      return { dispose: () => undefined };
    },
    onDidChange: (cb: any) => {
      set.onDidChange = cb;
      return { dispose: () => undefined };
    },
    onDidDelete: (cb: any) => {
      set.onDidDelete = cb;
      return { dispose: () => undefined };
    },
    dispose: () => {
      set.disposed = true;
    },
  });
  return set;
}

function makeHost(overrides: Partial<WatcherControllerHost> = {}): WatcherControllerHost & {
  reloadCalls: string[];
  externalCalls: string[];
} {
  const reloadCalls: string[] = [];
  const externalCalls: string[] = [];
  return {
    reload: overrides.reload ?? (async (d: any) => {
      reloadCalls.push(d.uri.fsPath);
    }),
    isReloading: overrides.isReloading ?? (() => false),
    onExternalChange: overrides.onExternalChange ?? ((p: string) => {
      externalCalls.push(p);
    }),
    reloadCalls,
    externalCalls,
  } as any;
}

function validSidecar(): Sidecar {
  return {
    version: 1,
    file: "docs/a.md",
    comments: [],
  };
}

const outputChannel = window.createOutputChannel() as any;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdcollab-watcher-"));
  __resetSelfWriteTokens();
  // Default: empty workspace folders; each test sets the folder to point at tmpDir.
  (workspace as any).workspaceFolders = undefined;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  (workspace as any).textDocuments = [];
  (workspace as any).workspaceFolders = undefined;
});

describe("SidecarWatcher", () => {
  it("debounces rapid events for the same path into a single handler call", async () => {
    // Uses real timers because the post-debounce handler awaits an fs read;
    // fake timers require carefully flushing that microtask chain. 400ms of
    // real wall time is sufficient and keeps the test deterministic on CI.
    const handlers = installFakeWatcher();
    (workspace as any).workspaceFolders = [{ uri: Uri.file(tmpDir) }];
    const sidecarPath = sidecarPathFor(path.join(tmpDir, "docs/a.md"), tmpDir)!;
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, JSON.stringify(validSidecar()), "utf8");
    __resetSelfWriteTokens();

    const host = makeHost();
    const watcher = new SidecarWatcher(host, outputChannel);

    // Fire three change events well inside the 250ms debounce window.
    handlers.onDidChange!(Uri.file(sidecarPath));
    await new Promise((r) => setTimeout(r, 50));
    handlers.onDidChange!(Uri.file(sidecarPath));
    await new Promise((r) => setTimeout(r, 50));
    handlers.onDidChange!(Uri.file(sidecarPath));

    // At this point: last event was just fired; ~100ms of wall time elapsed
    // since the first. Nothing should have flushed yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(host.reloadCalls).toEqual([]);
    expect(host.externalCalls).toEqual([]);

    // Wait well past the 250ms debounce boundary for the LAST event.
    await new Promise((r) => setTimeout(r, 350));

    // Doc not open → external-change path. Exactly one fanout.
    expect(host.reloadCalls).toEqual([]);
    expect(host.externalCalls).toHaveLength(1);
    expect(host.externalCalls[0]).toBe(path.join(tmpDir, "docs/a.md"));

    watcher.dispose();
  });

  it("suppresses events whose contents match a recent saveSidecar hash", async () => {
    const handlers = installFakeWatcher();
    (workspace as any).workspaceFolders = [{ uri: Uri.file(tmpDir) }];
    const sidecarPath = sidecarPathFor(path.join(tmpDir, "docs/a.md"), tmpDir)!;

    const host = makeHost();
    const watcher = new SidecarWatcher(host, outputChannel);

    // Simulate our own write: the hash is registered inside saveSidecar,
    // and the resulting file bytes on disk match the recorded hash.
    await saveSidecar(sidecarPath, validSidecar());

    // Fire the change event the real FileSystemWatcher would fire.
    handlers.onDidChange!(Uri.file(sidecarPath));

    // Wait past the debounce window + a microtask tick.
    await new Promise((r) => setTimeout(r, 300));

    expect(host.reloadCalls).toEqual([]);
    expect(host.externalCalls).toEqual([]);

    watcher.dispose();
  });

  it("skips reload when controller reports isReloading=true", async () => {
    const handlers = installFakeWatcher();
    (workspace as any).workspaceFolders = [{ uri: Uri.file(tmpDir) }];
    const sidecarPath = sidecarPathFor(path.join(tmpDir, "docs/a.md"), tmpDir)!;
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    // Write different bytes so self-write suppression does NOT kick in —
    // we want to see that isReloading is what blocks, not the hash.
    await fs.writeFile(sidecarPath, JSON.stringify({ external: true }), "utf8");
    __resetSelfWriteTokens();

    const host = makeHost({ isReloading: () => true });
    const watcher = new SidecarWatcher(host, outputChannel);

    handlers.onDidChange!(Uri.file(sidecarPath));
    await new Promise((r) => setTimeout(r, 300));

    expect(host.reloadCalls).toEqual([]);
    expect(host.externalCalls).toEqual([]);

    watcher.dispose();
  });

  it("fires onExternalChange with the md path when the doc isn't open", async () => {
    const handlers = installFakeWatcher();
    (workspace as any).workspaceFolders = [{ uri: Uri.file(tmpDir) }];
    (workspace as any).textDocuments = []; // not open
    const mdPath = path.join(tmpDir, "docs/a.md");
    const sidecarPath = sidecarPathFor(mdPath, tmpDir)!;
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    // Bytes chosen specifically to NOT collide with any registered self-write token.
    await fs.writeFile(sidecarPath, '{"external":"yes"}', "utf8");
    __resetSelfWriteTokens();

    const host = makeHost();
    const watcher = new SidecarWatcher(host, outputChannel);

    handlers.onDidChange!(Uri.file(sidecarPath));
    await new Promise((r) => setTimeout(r, 300));

    expect(host.reloadCalls).toEqual([]);
    expect(host.externalCalls).toEqual([mdPath]);

    watcher.dispose();
  });

  it("calls reload when the md doc is currently open", async () => {
    const handlers = installFakeWatcher();
    (workspace as any).workspaceFolders = [{ uri: Uri.file(tmpDir) }];
    const mdPath = path.join(tmpDir, "docs/a.md");
    const fakeDoc = { uri: Uri.file(mdPath) };
    (workspace as any).textDocuments = [fakeDoc];
    const sidecarPath = sidecarPathFor(mdPath, tmpDir)!;
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, '{"external":"yes"}', "utf8");
    __resetSelfWriteTokens();

    const host = makeHost();
    const watcher = new SidecarWatcher(host, outputChannel);

    handlers.onDidChange!(Uri.file(sidecarPath));
    await new Promise((r) => setTimeout(r, 300));

    expect(host.reloadCalls).toEqual([mdPath]);
    expect(host.externalCalls).toEqual([]);

    watcher.dispose();
  });

  it("dispose clears the underlying FileSystemWatcher and timers", async () => {
    const handlers = installFakeWatcher();
    (workspace as any).workspaceFolders = [{ uri: Uri.file(tmpDir) }];
    const sidecarPath = sidecarPathFor(path.join(tmpDir, "docs/a.md"), tmpDir)!;

    const host = makeHost();
    const watcher = new SidecarWatcher(host, outputChannel);

    handlers.onDidChange!(Uri.file(sidecarPath));
    watcher.dispose();
    // Wait well past the 250ms debounce; the handler must not fire because
    // the watcher cleared its timers on dispose.
    await new Promise((r) => setTimeout(r, 400));

    expect(host.reloadCalls).toEqual([]);
    expect(host.externalCalls).toEqual([]);
  });

  it("ignores events for sidecar paths outside every known workspace folder", async () => {
    const handlers = installFakeWatcher();
    (workspace as any).workspaceFolders = [{ uri: Uri.file(tmpDir) }];

    const host = makeHost();
    const watcher = new SidecarWatcher(host, outputChannel);

    // A path that isn't under `<tmpDir>/.markdown-collab/`.
    handlers.onDidChange!(Uri.file("/nowhere/.markdown-collab/stray.md.json"));
    await new Promise((r) => setTimeout(r, 300));

    expect(host.reloadCalls).toEqual([]);
    expect(host.externalCalls).toEqual([]);

    watcher.dispose();
  });
});
