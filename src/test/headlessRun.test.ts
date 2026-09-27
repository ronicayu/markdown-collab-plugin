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

  it("hands the prompt over stdin, the token only in a 0600 file, and cleans up", async () => {
    fs.writeFileSync(path.join(workspace, "notes.md"), DOC, "utf8");
    const trace = path.join(scratch, "trace-invocation.json");
    const run = makeRun("ok", { trace });
    await run.start();

    const t = JSON.parse(fs.readFileSync(trace, "utf8"));
    expect(t.prompt).toContain("in Review Mode on `notes.md`");
    expect(t.argv.join(" ")).not.toContain(TOKEN);
    expect(t.argv).not.toContain(t.prompt);
    expect(t.mcpConfigMode).toBe("600");
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
});
