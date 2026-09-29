// `HeadlessRun` end to end, minus VS Code (10x-plan-4 P0.1): a real child
// process (the stub `claude` the integration suite also uses), a real MCP
// server on a real socket, a real document on disk. What's left for the
// integration suite is the part only a host can show — the write going through
// a WorkspaceEdit — and the dispatch around it.
//
// POSIX only: the stub is started through a `#!/bin/sh` wrapper.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serveMcp, type McpHttpServer } from "../mcpServer/httpServer";
import { TOOLS, callTool, type ToolDeps } from "../mcpServer/tools";
import { parse } from "../inlineComments/format";
import {
  HeadlessRun,
  activeHeadlessRun,
  lastHeadlessRun,
  trackHeadlessRun,
  type HeadlessState,
} from "../transports/headless";
import { parseClaudeVersion } from "../transports/claudeBinary";
import { runHeadless, type HeadlessDelivery } from "../transports/headlessHost";
import { Uri, commands, window, workspace as vscodeWorkspace } from "./vscode-stub";
import type { Logger } from "../logging";

const STUB = path.resolve(__dirname, "integration", "fixtures", "fake-claude.mjs");
const TOKEN = "a1".repeat(32);
const DOC = `# Release notes

The parser handles nested lists correctly.

Suggest mode ships behind a setting.
`;

let workspace: string;
let scratch: string;
let wrapper: string;
let server: McpHttpServer;
let toolCalls: string[] = [];

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeRun(
  mode: string,
  opts: { budgetMs?: number; cancelGraceMs?: number; binaryPath?: string; trace?: string } = {},
): HeadlessRun {
  return new HeadlessRun({
    binaryPath: opts.binaryPath ?? wrapper,
    version: parseClaudeVersion("2.1.283 (Claude Code)"),
    cwd: workspace,
    prompt: "Follow the Markdown Collab review workflow in your instructions in Review Mode on `notes.md`.",
    systemPrompt: "You are a test.",
    server: { url: server.url, token: TOKEN },
    fileLabel: "notes.md",
    budgetMs: opts.budgetMs,
    cancelGraceMs: opts.cancelGraceMs,
    tmpRoot: scratch,
    env: {
      ...process.env,
      FAKE_CLAUDE_MODE: mode,
      CLAUDECODE: "1",
      ...(opts.trace ? { FAKE_CLAUDE_TRACE: opts.trace } : {}),
    },
  });
}

/** Resolve once `predicate` holds for the run's state. */
function reach(run: HeadlessRun, predicate: (s: HeadlessState) => boolean): Promise<HeadlessState> {
  if (predicate(run.state)) return Promise.resolve(run.state);
  return new Promise((resolve) => {
    const sub = run.onDidChange((s) => {
      if (predicate(s)) {
        sub.dispose();
        resolve(s);
      }
    });
  });
}

describe.skipIf(process.platform === "win32")("HeadlessRun against a stub claude and a real tool server", () => {
  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headless-ws-"));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "headless-tmp-"));
    wrapper = path.join(scratch, "claude");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec node "${STUB}" "$@"\n`, { mode: 0o755 });

    const deps: ToolDeps = {
      resolveFile: async (file) => {
        const p = path.isAbsolute(file) ? file : path.join(workspace, file);
        if (!fs.existsSync(p)) throw new Error(`no such file: ${file}`);
        return p;
      },
      readDoc: async (key) => fs.readFileSync(key, "utf8"),
      writeDoc: async (key, next) => fs.writeFileSync(key, next, "utf8"),
      onCall: (e) => toolCalls.push(e.tool),
    };
    server = await serveMcp({
      token: TOKEN,
      handlers: {
        serverInfo: { name: "markdown-collab", version: "test" },
        tools: TOOLS,
        callTool: (name, args) => callTool(name, args, deps),
      },
    });
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    toolCalls = [];
    fs.writeFileSync(path.join(workspace, "notes.md"), DOC, "utf8");
  });

  it("runs a review to done: real tool calls, a thread by claude, a report and a cost", async () => {
    fs.writeFileSync(path.join(workspace, "notes.md"), DOC, "utf8");
    const trace = path.join(scratch, "trace-ok.json");
    const run = makeRun("ok", { trace });
    const seen: HeadlessState[] = [];
    run.onDidChange((s) => seen.push(s));

    const final = await run.start();

    expect(final.kind).toBe("done");
    if (final.kind !== "done") return;
    expect(final.text).toMatch(/opened 1 thread/);
    expect(final.costUsd).toBe(0.0123);
    expect(final.numTurns).toBe(4);
    expect(final.toolCount).toBe(3);
    // The stream drove the state: working with the tools named, in order.
    const working = seen.filter((s) => s.kind === "working");
    expect(working.map((s) => (s.kind === "working" ? s.lastTool : undefined))).toEqual([
      undefined,
      "mc_status",
      "mc_open",
      "mc_check",
    ]);
    expect(working.at(-1)).toMatchObject({ phase: "reading the document" });
    // …and the tool server really was called, and the document really changed.
    expect(toolCalls).toEqual(["mc_status", "mc_open", "mc_check"]);
    const threads = parse(fs.readFileSync(path.join(workspace, "notes.md"), "utf8")).threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments[0]!.author).toBe("claude");
    expect(run.initServers).toEqual([{ name: "markdown-collab", status: "connected" }]);
  });

  it("hands the prompt over stdin, the token only in the child's environment, and cleans up", async () => {
    fs.writeFileSync(path.join(workspace, "notes.md"), DOC, "utf8");
    const trace = path.join(scratch, "trace-invocation.json");
    const run = makeRun("ok", { trace });
    await run.start();

    const t = JSON.parse(fs.readFileSync(trace, "utf8"));
    expect(t.prompt).toContain("in Review Mode on `notes.md`");
    expect(t.argv.join(" ")).not.toContain(TOKEN);
    expect(t.argv).not.toContain(t.prompt);
    expect(t.mcpConfigMode).toBe("600");
    // The config file names the token by variable; only the child's env has it.
    expect(t.mcpConfigHasTokenLiteral).toBe(false);
    expect(t.envToken).toBe(TOKEN);
    expect(t.systemPromptMode).toBe("600");
    expect(t.systemPromptHead).toBe("You are a test.");
    expect(fs.realpathSync(t.cwd)).toBe(fs.realpathSync(workspace));
    // The nested-session marker from a parent Claude Code is not passed on.
    expect(t.claudecodeEnv).toBeNull();
    // The directory holding the token is gone once the run is.
    expect(fs.existsSync(path.dirname(t.mcpConfigPath))).toBe(false);
    expect(run.tempDir).toBeNull();
  });

  it("stops and reports mcp-unavailable when init doesn't list our server as connected", async () => {
    const trace = path.join(scratch, "trace-nomcp.json");
    const run = makeRun("no-mcp", { trace });
    const final = await run.start();
    expect(final).toMatchObject({ kind: "failed", reason: "mcp-unavailable" });
    expect(alive(run.pid)).toBe(false);
    expect(fs.existsSync(path.dirname(JSON.parse(fs.readFileSync(trace, "utf8")).mcpConfigPath))).toBe(false);
  });

  it("stops on the first authentication retry instead of waiting out the backoff", async () => {
    const run = makeRun("auth-fail");
    const final = await run.start();
    expect(final).toMatchObject({ kind: "failed", reason: "auth" });
    expect(alive(run.pid)).toBe(false);
  });

  it("reports an error result as a failure with Claude's own words", async () => {
    const final = await makeRun("error").start();
    expect(final).toMatchObject({ kind: "failed", reason: "error-result", detail: "Something went wrong mid-run." });
  });

  it("cancel ends a hung run with SIGINT", async () => {
    const run = makeRun("hang");
    void run.start();
    await reach(run, (s) => s.kind === "working" && s.toolCount === 1);
    expect(alive(run.pid)).toBe(true);
    run.cancel();
    const final = await run.finished;
    expect(final).toMatchObject({ kind: "cancelled", reason: "user" });
    expect(alive(run.pid)).toBe(false);
  });

  it("escalates past a process that ignores SIGINT", async () => {
    const run = makeRun("hang-hard", { cancelGraceMs: 200 });
    void run.start();
    await reach(run, (s) => s.kind === "working" && s.toolCount === 1);
    run.cancel();
    const final = await run.finished;
    expect(final).toMatchObject({ kind: "cancelled", reason: "user" });
    expect(alive(run.pid)).toBe(false);
  });

  it("cancels itself when the wall-clock budget runs out", async () => {
    const final = await makeRun("hang", { budgetMs: 400 }).start();
    expect(final).toMatchObject({ kind: "cancelled", reason: "timeout" });
  });

  it("fails cleanly when the binary can't be started, and still deletes the temp files", async () => {
    const run = makeRun("ok", { binaryPath: path.join(scratch, "does-not-exist") });
    const final = await run.start();
    expect(final).toMatchObject({ kind: "failed", reason: "spawn" });
    expect(run.tempDir).toBeNull();
    expect(fs.readdirSync(scratch).filter((n) => n.startsWith("mc-headless-"))).toEqual([]);
  });

  it("allows one run per folder, and remembers the last one", async () => {
    const run = makeRun("hang");
    trackHeadlessRun({ key: workspace, fileLabel: "notes.md", files: [], run });
    expect(activeHeadlessRun(workspace)?.run).toBe(run);
    expect(() =>
      trackHeadlessRun({ key: workspace, fileLabel: "notes.md", files: [], run: makeRun("hang") }),
    ).toThrow(/already active/);
    void run.start();
    await reach(run, (s) => s.kind === "working");
    run.cancel();
    await run.finished;
    expect(activeHeadlessRun(workspace)).toBeUndefined();
    expect(lastHeadlessRun()?.run).toBe(run);
  });

  // -------------------------------------------------------------------
  // headlessHost.ts's onFinished — the "done" toast. Reuses the same real
  // stub-claude process and real MCP server as the tests above (mode "ok"
  // is the one that reaches `final.kind === "done"`), plus the repo's
  // vscode stub for the host-side pieces `runHeadless` touches
  // (workspace.getConfiguration, window.showInformationMessage,
  // commands.executeCommand). `HeadlessRun` defaults to `process.env` when
  // `runHeadless` doesn't pass its own `env` (it doesn't), so the mode is
  // selected by setting `FAKE_CLAUDE_MODE` on `process.env` itself.
  // -------------------------------------------------------------------
  it("routes the done toast's 'Open in Markdown Collab' action to openReviewView with focusNewFromAgent", async () => {
    fs.writeFileSync(path.join(workspace, "notes.md"), DOC, "utf8");

    const executeCalls: unknown[][] = [];
    let openInlineResolve: (() => void) | undefined;
    const openInlineCalled = new Promise<void>((res) => {
      openInlineResolve = res;
    });
    (vscodeWorkspace as any).getConfiguration = () => ({
      get: (_key: string, def?: unknown) => def,
    });
    // The stub doesn't carry Uri.joinPath — patched on for this test only,
    // the same non-invasive way the other vscode-stub gaps here are.
    (Uri as any).joinPath = (base: { fsPath: string }, ...segments: string[]) =>
      Uri.file(path.join(base.fsPath, ...segments));
    (window as any).showInformationMessage = async (_message: string, ..._actions: string[]) =>
      "Open in Markdown Collab";
    (commands as any).executeCommand = async (...args: unknown[]) => {
      executeCalls.push(args);
      if (args[0] === "markdownCollab.openInlineCommentsView") openInlineResolve?.();
      return undefined;
    };

    const silentLog: Logger = {
      trace: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      scope: () => silentLog,
      time: (_l, fn) => fn(),
      show: () => undefined,
    };
    const memento = { get: (_k: string, def?: unknown) => def, update: async () => undefined, keys: () => [] };

    const prevMode = process.env.FAKE_CLAUDE_MODE;
    process.env.FAKE_CLAUDE_MODE = "ok";
    try {
      const delivery = {
        payload: { prompt: "p", file: "notes.md", unresolvedCount: 0, comments: [] },
        prompt: "Follow the Markdown Collab review workflow in Review Mode on `notes.md`.",
        folder: { uri: Uri.file(workspace), name: "ws", index: 0 },
        log: silentLog,
        workspaceState: memento,
        ready: {
          ok: true as const,
          claude: {
            path: wrapper,
            version: parseClaudeVersion("2.1.283 (Claude Code)")!,
            source: "path" as const,
          },
          server: { url: server.url, token: TOKEN },
        },
        fallbackToTerminal: async () => undefined,
        startTerminal: () => undefined,
      } as unknown as HeadlessDelivery;

      const outcome = await runHeadless(delivery);
      expect(outcome).toBe("started");

      // The toast fires after the (real, async) run finishes — not part of
      // runHeadless's own returned promise.
      await openInlineCalled;
    } finally {
      if (prevMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
      else process.env.FAKE_CLAUDE_MODE = prevMode;
      delete (Uri as any).joinPath;
      (window as any).showInformationMessage = async () => undefined;
      (commands as any).executeCommand = async () => undefined;
      (vscodeWorkspace as any).getConfiguration = undefined;
    }

    const call = executeCalls.find((c) => c[0] === "markdownCollab.openInlineCommentsView");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ fsPath: path.join(workspace, "notes.md") });
    expect(call![2]).toEqual({ focusNewFromAgent: true });
  });
});
