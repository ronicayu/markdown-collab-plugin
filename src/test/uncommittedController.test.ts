/**
 * Coverage for the Uncommitted Markdown tree controller — the local
 * counterpart of the PR review view. Previously
 * untested end to end.
 *
 * Git is faked at the CLI chokepoint (`setCliRunner`, same seam
 * `gitUncommitted.test.ts` uses at the function level) since the controller
 * calls straight through to `getCliRunner()` with no injectable runner of its
 * own. `vscode` resolves to the repo's stub (vitest.config.ts alias); the
 * pieces the controller touches (`window.createTreeView`,
 * `commands.registerCommand`, `commands.executeCommand`,
 * `window.showInformationMessage`) are re-assigned per test the same way
 * `reviewView.test.ts` does it. Thread counts are read from a real temp
 * directory on disk — only git is faked, not the filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { UncommittedChangesController } from "../uncommitted/uncommittedController";
import { CollabEditorProvider } from "../collab/collabEditorProvider";
import {
  getCliRunner,
  setCliGate,
  setCliLogger,
  setCliRunner,
  type CliRunner,
  type RunCliResult,
} from "../pr/cli";
import { Uri, commands, window, workspace } from "./vscode-stub";
import type { Logger } from "../logging";

const ok = (stdout: string): RunCliResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string, code = 1): RunCliResult => ({ stdout: "", stderr, code });

/** Same shape as `gitUncommitted.test.ts`'s `runnerFor` — canned by argv prefix. */
function fakeGit(handlers: Record<string, RunCliResult>): CliRunner {
  return async (bin, args) => {
    const key = `${bin} ${args.join(" ")}`;
    const hit = Object.entries(handlers).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected CLI call: ${key}`);
    return hit[1];
  };
}

/** A Logger that records nothing — these tests assert behaviour, not logs. */
function makeLogger(): Logger {
  const noop = (): void => {};
  const log: Logger = {
    trace: noop,
    info: noop,
    warn: noop,
    error: noop,
    scope: () => log,
    time: (_l, fn) => fn(),
    show: noop,
  };
  return log;
}

const withThreadsBlock = (...lines: string[]) =>
  ["Body.", "", "<!--mc:threads:begin-->", ...lines, "<!--mc:threads:end-->"].join("\n");
const threadLine = (id: string) =>
  `<!--mc:t ${JSON.stringify({
    id,
    quote: "x",
    status: "open",
    comments: [{ id: "c1", author: "r", ts: "2026-01-01T00:00:00Z", body: "b" }],
  })}-->`;

const realRunner = getCliRunner();
const tempDirs: string[] = [];

function mkTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-uncommitted-"));
  tempDirs.push(dir);
  return dir;
}

let capturedProvider: any;
let capturedView: any;
let registeredCommands: Map<string, (...args: any[]) => any>;
let executeCalls: any[][];

function latestSetContext(key: string): unknown {
  for (let i = executeCalls.length - 1; i >= 0; i--) {
    if (executeCalls[i][0] === "setContext" && executeCalls[i][1] === key) return executeCalls[i][2];
  }
  return undefined;
}

/** Resolves the next time the captured tree provider fires a data-change event. */
function waitForChange(): Promise<void> {
  return new Promise((resolve) => {
    const disp = capturedProvider.onDidChangeTreeData(() => {
      disp.dispose();
      resolve();
    });
  });
}

async function makeController(opts: {
  repoRoot: string;
  openFile?: (uri: any, o: { showDiff: boolean }) => Promise<void>;
  openLiveFile?: (uri: any) => Promise<void>;
}): Promise<UncommittedChangesController> {
  (workspace as any).workspaceFolders = [{ uri: Uri.file(opts.repoRoot), name: "ws", index: 0 }];
  const controller = new UncommittedChangesController(
    opts.openFile ?? (async () => undefined),
    makeLogger(),
    opts.openLiveFile,
  );
  await waitForChange();
  return controller;
}

beforeEach(() => {
  registeredCommands = new Map();
  executeCalls = [];
  capturedProvider = undefined;
  capturedView = undefined;

  (workspace as any).workspaceFolders = undefined;
  // The stub (src/test/vscode-stub.ts) doesn't yet carry these two file
  // watchers — patched on per test, the same non-invasive way the other
  // vscode-stub hooks below are, rather than editing the shared stub file.
  (workspace as any).onDidCreateFiles = () => ({ dispose: () => undefined });
  (workspace as any).onDidDeleteFiles = () => ({ dispose: () => undefined });
  (window as any).createTreeView = (_id: string, opts: any) => {
    capturedProvider = opts.treeDataProvider;
    capturedView = { message: undefined, dispose: () => undefined };
    return capturedView;
  };
  (commands as any).registerCommand = (name: string, cb: (...args: any[]) => any) => {
    registeredCommands.set(name, cb);
    return { dispose: () => undefined };
  };
  (commands as any).executeCommand = async (...args: any[]) => {
    executeCalls.push(args);
    return undefined;
  };
  (window as any).showInformationMessage = async () => undefined;
});

afterEach(() => {
  setCliRunner(realRunner);
  (workspace as any).workspaceFolders = undefined;
  (window as any).createTreeView = () => ({ dispose: () => undefined });
  (commands as any).registerCommand = () => ({ dispose: () => undefined });
  (commands as any).executeCommand = async () => undefined;
  (window as any).showInformationMessage = async () => undefined;
  vi.restoreAllMocks();
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("UncommittedChangesController — file listing", () => {
  it("lists markdown files that differ from HEAD, tracked and untracked, with status descriptions", async () => {
    const repoRoot = mkTempRepo();
    fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs/spec.md"), "Body only, no threads.\n");
    fs.writeFileSync(path.join(repoRoot, "notes.md"), "Untracked note.\n");

    setCliRunner(
      fakeGit({
        "git rev-parse --show-toplevel": ok(`${repoRoot}\n`),
        "git diff --name-status -M HEAD": ok("M\tdocs/spec.md"),
        "git ls-files --others --exclude-standard": ok("notes.md\n"),
        "git diff --name-only --cached -M": ok(""),
        "git diff --name-only -M": ok("docs/spec.md"),
      }),
    );

    const controller = await makeController({ repoRoot });
    const roots = capturedProvider.getChildren(undefined) as any[];

    const dir = roots.find((n) => n.kind === "dir");
    expect(dir.name).toBe("docs");
    const specItem = capturedProvider.getTreeItem(dir.children[0]);
    expect(specItem.description).toBe("modified"); // unstaged -> bare status, no threads

    const notesNode = roots.find((n) => n.kind === "file");
    const notesItem = capturedProvider.getTreeItem(notesNode);
    expect(notesItem.description).toBe("new"); // untracked -> status "A" -> "new"
    expect(notesItem.contextValue).toBe("uncommittedFile-unstaged");

    expect(capturedView.message).toBeUndefined();
    controller.dispose();
  });

  it("shows the thread count in the description and appends -threads to contextValue", async () => {
    const repoRoot = mkTempRepo();
    fs.writeFileSync(path.join(repoRoot, "reviewed.md"), withThreadsBlock(threadLine("t1"), threadLine("t2")));
    fs.writeFileSync(path.join(repoRoot, "single.md"), withThreadsBlock(threadLine("t1")));

    setCliRunner(
      fakeGit({
        "git rev-parse --show-toplevel": ok(`${repoRoot}\n`),
        "git diff --name-status -M HEAD": ok(["M\treviewed.md", "M\tsingle.md"].join("\n")),
        "git ls-files --others --exclude-standard": ok(""),
        "git diff --name-only --cached -M": ok(""),
        "git diff --name-only -M": ok(["reviewed.md", "single.md"].join("\n")),
      }),
    );

    const controller = await makeController({ repoRoot });
    const roots = capturedProvider.getChildren(undefined) as any[];
    const reviewedNode = roots.find((n) => n.file?.path === "reviewed.md");
    const singleNode = roots.find((n) => n.file?.path === "single.md");

    const reviewedItem = capturedProvider.getTreeItem(reviewedNode);
    expect(reviewedItem.description).toBe("modified · 2 threads");
    expect(reviewedItem.contextValue).toBe("uncommittedFile-unstaged-threads");

    const singleItem = capturedProvider.getTreeItem(singleNode);
    expect(singleItem.description).toBe("modified · 1 thread");
    expect(singleItem.contextValue).toBe("uncommittedFile-unstaged-threads");

    controller.dispose();
  });
});

describe("UncommittedChangesController — open()", () => {
  it("routes to the injected review-view opener with { diff: true }, same wiring as extension.ts", async () => {
    const repoRoot = mkTempRepo();
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "Body.\n");
    setCliRunner(
      fakeGit({
        "git rev-parse --show-toplevel": ok(`${repoRoot}\n`),
        "git diff --name-status -M HEAD": ok("M\tdoc.md"),
        "git ls-files --others --exclude-standard": ok(""),
        "git diff --name-only --cached -M": ok(""),
        "git diff --name-only -M": ok("doc.md"),
      }),
    );

    // Exactly the composition extension.ts wires up: openFile -> openReviewView(uri, {diff}).
    const openReviewView = vi.fn(async (_uri: any, _opts: { diff: boolean }) => undefined);
    const controller = await makeController({
      repoRoot,
      openFile: (uri, o) => openReviewView(uri, { diff: o.showDiff }),
    });

    const openHandler = registeredCommands.get("markdownCollab.openUncommittedFile")!;
    const [fileNode] = capturedProvider.getChildren(undefined) as any[];
    await openHandler(fileNode.file);

    expect(openReviewView).toHaveBeenCalledTimes(1);
    const [uriArg, optsArg] = openReviewView.mock.calls[0];
    expect(uriArg.fsPath).toBe(path.join(repoRoot, "doc.md"));
    expect(optsArg).toEqual({ diff: true });

    controller.dispose();
  });
});

describe("UncommittedChangesController — stage-time thread reminder", () => {
  function setup(repoRoot: string, fileName: string, content: string) {
    fs.writeFileSync(path.join(repoRoot, fileName), content);
    setCliRunner(
      fakeGit({
        "git rev-parse --show-toplevel": ok(`${repoRoot}\n`),
        "git diff --name-status -M HEAD": ok(`M\t${fileName}`),
        "git ls-files --others --exclude-standard": ok(""),
        "git diff --name-only --cached -M": ok(""),
        "git diff --name-only -M": ok(fileName),
        "git add --": ok(""),
      }),
    );
  }

  it("nudges once per file per session, with the right text and actions, and never touches the file", async () => {
    const repoRoot = mkTempRepo();
    const original = withThreadsBlock(threadLine("t1"), threadLine("t2"));
    setup(repoRoot, "reviewed.md", original);

    const infoCalls: Array<{ message: string; actions: string[] }> = [];
    (window as any).showInformationMessage = async (message: string, ...actions: string[]) => {
      infoCalls.push({ message, actions });
      return undefined; // toast dismissed — neither button picked
    };

    const controller = await makeController({ repoRoot });
    const stageHandler = registeredCommands.get("markdownCollab.stageUncommittedFile")!;

    const [fileNode] = capturedProvider.getChildren(undefined) as any[];
    await stageHandler(fileNode);

    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0].message).toBe(
      "2 threads are still in reviewed.md — Remove All Review Data strips them before you commit.",
    );
    expect(infoCalls[0].actions).toEqual(["Remove review data", "Keep them"]);

    // Staging the same file again in this session (e.g. re-picking the row
    // after refresh) must not nudge a second time.
    const [fileNodeAgain] = capturedProvider.getChildren(undefined) as any[];
    await stageHandler(fileNodeAgain);
    expect(infoCalls).toHaveLength(1);

    // Never modifies the file — dismissing (or "Keep them") does nothing to it.
    expect(fs.readFileSync(path.join(repoRoot, "reviewed.md"), "utf8")).toBe(original);
    expect(executeCalls.some((c) => c[0] === "markdownCollab.finalizeDocument")).toBe(false);

    controller.dispose();
  });

  it("uses singular grammar for exactly one thread", async () => {
    const repoRoot = mkTempRepo();
    setup(repoRoot, "single.md", withThreadsBlock(threadLine("t1")));

    const infoCalls: string[] = [];
    (window as any).showInformationMessage = async (message: string) => {
      infoCalls.push(message);
      return undefined;
    };

    const controller = await makeController({ repoRoot });
    const stageHandler = registeredCommands.get("markdownCollab.stageUncommittedFile")!;
    const [fileNode] = capturedProvider.getChildren(undefined) as any[];
    await stageHandler(fileNode);

    expect(infoCalls).toEqual([
      "1 thread is still in single.md — Remove All Review Data strips them before you commit.",
    ]);
    controller.dispose();
  });

  it("routes the 'Remove review data' action to markdownCollab.finalizeDocument for that file", async () => {
    const repoRoot = mkTempRepo();
    setup(repoRoot, "reviewed.md", withThreadsBlock(threadLine("t1")));

    (window as any).showInformationMessage = async () => "Remove review data";

    const controller = await makeController({ repoRoot });
    const stageHandler = registeredCommands.get("markdownCollab.stageUncommittedFile")!;
    const [fileNode] = capturedProvider.getChildren(undefined) as any[];
    await stageHandler(fileNode);
    // The reminder's `.then` runs off-band from `setStaged`'s own await chain.
    await new Promise((r) => setTimeout(r, 0));

    const call = executeCalls.find((c) => c[0] === "markdownCollab.finalizeDocument");
    expect(call).toBeDefined();
    expect(call![1].fsPath).toBe(path.join(repoRoot, "reviewed.md"));

    controller.dispose();
  });

  it("does not nudge when staging a file that carries no threads", async () => {
    const repoRoot = mkTempRepo();
    setup(repoRoot, "plain.md", "Just prose, no review data.\n");

    const infoCalls: string[] = [];
    (window as any).showInformationMessage = async (message: string) => {
      infoCalls.push(message);
      return undefined;
    };

    const controller = await makeController({ repoRoot });
    const stageHandler = registeredCommands.get("markdownCollab.stageUncommittedFile")!;
    const [fileNode] = capturedProvider.getChildren(undefined) as any[];
    await stageHandler(fileNode);

    expect(infoCalls).toEqual([]);
    controller.dispose();
  });
});

describe("UncommittedChangesController — workspaceHasGit context key", () => {
  it("sets it true for a repo with a refresh in progress, and false again on dispose", async () => {
    const repoRoot = mkTempRepo();
    setCliRunner(
      fakeGit({
        "git rev-parse --show-toplevel": ok(`${repoRoot}\n`),
        "git diff --name-status -M HEAD": ok(""),
        "git ls-files --others --exclude-standard": ok(""),
        "git diff --name-only --cached -M": ok(""),
        "git diff --name-only -M": ok(""),
      }),
    );

    const controller = await makeController({ repoRoot });
    expect(latestSetContext("markdownCollab.workspaceHasGit")).toBe(true);

    controller.dispose();
    expect(latestSetContext("markdownCollab.workspaceHasGit")).toBe(false);
  });

  it("clears it (false) when the workspace folder is not a git repo", async () => {
    setCliRunner(
      fakeGit({
        "git rev-parse --show-toplevel": fail("fatal: not a git repository", 128),
      }),
    );

    const controller = await makeController({ repoRoot: "/not-a-repo" });
    expect(latestSetContext("markdownCollab.workspaceHasGit")).toBe(false);
    controller.dispose();
  });
});

describe("UncommittedChangesController — refresh refreshes live-editor diff panels", () => {
  it("calls CollabEditorProvider.refreshDiffPanels on the initial refresh and on markdownCollab.uncommittedRefresh", async () => {
    const spy = vi.spyOn(CollabEditorProvider, "refreshDiffPanels");
    const repoRoot = mkTempRepo();
    setCliRunner(
      fakeGit({
        "git rev-parse --show-toplevel": ok(`${repoRoot}\n`),
        "git diff --name-status -M HEAD": ok(""),
        "git ls-files --others --exclude-standard": ok(""),
        "git diff --name-only --cached -M": ok(""),
        "git diff --name-only -M": ok(""),
      }),
    );

    const controller = await makeController({ repoRoot });
    expect(spy).toHaveBeenCalledTimes(1); // the constructor's own initial refresh

    const refreshHandler = registeredCommands.get("markdownCollab.uncommittedRefresh")!;
    await refreshHandler();
    expect(spy).toHaveBeenCalledTimes(2);

    controller.dispose();
  });
});

describe("UncommittedChangesController — Restricted Mode", () => {
  afterEach(() => {
    (workspace as any).isTrusted = true;
    setCliGate(() => true);
    setCliLogger(null);
  });

  it("shows no repo without running git or logging an error, then lists files once trust is granted", async () => {
    const repoRoot = mkTempRepo();
    fs.writeFileSync(path.join(repoRoot, "notes.md"), "Untracked note.\n");
    const run = vi.fn(
      fakeGit({
        "git rev-parse --show-toplevel": ok(`${repoRoot}\n`),
        "git diff --name-status -M HEAD": ok(""),
        "git ls-files --others --exclude-standard": ok("notes.md\n"),
        "git diff --name-only --cached -M": ok(""),
        "git diff --name-only -M": ok(""),
      }),
    );
    const error = vi.fn();
    const log = makeLogger();
    log.error = error;
    setCliLogger(log);
    setCliRunner(run);
    (workspace as any).isTrusted = false;
    setCliGate(() => (workspace as any).isTrusted);

    (workspace as any).workspaceFolders = [{ uri: Uri.file(repoRoot), name: "ws", index: 0 }];
    const controller = new UncommittedChangesController(async () => undefined, makeLogger());
    await Promise.resolve();

    expect(capturedProvider.getChildren(undefined)).toEqual([]);
    expect(capturedView.message).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    (workspace as any).isTrusted = true;
    const changed = waitForChange();
    await registeredCommands.get("markdownCollab.uncommittedRefresh")!();
    await changed;

    expect((capturedProvider.getChildren(undefined) as any[]).map((n) => n.name)).toEqual(["notes.md"]);
    controller.dispose();
  });
});
