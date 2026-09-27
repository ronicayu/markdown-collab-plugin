// Headless runs: the extension starts Claude Code itself (10x-plan-4 P0.1).
//
// WHY THIS EXISTS. Every other send mode hands the prompt to a Claude session
// the human had to start, find, and keep visible — and a human who doesn't run
// Claude Code in a VS Code terminal stalls at "start Claude where?". The
// extension already hosts the tool server the agent needs; this starts the
// agent.
//
// The run is `claude -p` with a closed tool set: Read, Glob, Grep, and the
// markdown-collab MCP tools. No Edit, no Write, no Bash. That makes round 2's
// guarantee total rather than advisory: nothing reaches the document except a
// tool call, and every tool call lands as a `WorkspaceEdit` the human can undo
// and the integrity gate checked first.
//
// Progress is read off the process, not inferred. `--output-format
// stream-json` is the lifecycle: `system/init` says whether our server
// actually connected (if not, the run is stopped and the caller falls back to
// the terminal), each `tool_use` block says what Claude is doing, and the final
// `result` says done, what it cost, and what Claude wants to tell the human.
//
// The token never touches argv — `ps` shows every argument to every user on the
// machine. It lives in a 0600 file inside a fresh `mkdtemp` directory that is
// deleted when the process exits, however it exits. The prompt goes over stdin
// for the same reason, and because no quoting rule survives arbitrary Markdown
// through a Windows `.cmd` shim.
//
// Split: the argument builder, the stream parser, and the availability
// decision are pure; `HeadlessRun` owns one process and its temp files; the
// registry at the bottom enforces one run per workspace folder. vscode-free —
// the VS Code glue is `headlessHost.ts`.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "../logging";
import { MCP_SERVER_NAME } from "../mcpServer/registration";
import {
  PERMISSION_PROMPTS_MIN,
  spawnCommand,
  versionAtLeast,
  type ClaudeVersion,
} from "./claudeBinary";

/** What Claude Code prefixes our tool names with. */
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * The built-in tools a headless run gets. Reading is what a review needs;
 * everything that writes goes through our tools instead.
 */
export const HEADLESS_BUILTIN_TOOLS = "Read,Glob,Grep";

/**
 * Wall-clock ceiling for one run. The CLI has no turn limit to lean on, and a
 * run nobody is watching must not bill forever; a real review pass is minutes.
 */
export const DEFAULT_BUDGET_MS = 30 * 60 * 1000;

/** How long SIGINT gets to end the turn cleanly before we escalate. */
export const CANCEL_GRACE_MS = 5000;

const STDERR_TAIL_LINES = 50;

// ---------------------------------------------------------------------------
// Arguments and temp-file contents (pure)
// ---------------------------------------------------------------------------

export interface HeadlessArgsInput {
  mcpConfigPath: string;
  systemPromptPath: string;
  /** Extra settings for this run only — see `HEADLESS_SETTINGS`. */
  settingsPath: string;
  /** `markdownCollab.headlessModel`; empty means Claude Code's own default. */
  model?: string;
  supportsPermissionPrompts: boolean;
}

/**
 * The argv for one run (everything after the binary). The prompt is not here —
 * it goes over stdin — and neither is the token, which is only in the file at
 * `mcpConfigPath`.
 */
export function buildHeadlessArgs(input: HeadlessArgsInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    // stream-json in print mode requires --verbose; without it the CLI refuses.
    "--verbose",
    // Exactly these built-ins, no others — see HEADLESS_BUILTIN_TOOLS.
    "--tools",
    HEADLESS_BUILTIN_TOOLS,
    "--mcp-config",
    input.mcpConfigPath,
    // Only our server. `-p` shows no trust dialog, so without this the
    // project's own `.mcp.json` servers would start for a review that has no
    // use for them.
    "--strict-mcp-config",
    // Pre-approve every tool from our server. The glob is only valid after the
    // literal `mcp__<server>__` prefix.
    "--allowedTools",
    `${TOOL_PREFIX}*`,
    // Anything that would still ask is denied: there is nobody to ask.
    "--permission-mode",
    "dontAsk",
    "--append-system-prompt-file",
    input.systemPromptPath,
    // Command-line settings outrank project and user settings, so this is
    // what actually switches the user's hooks off for the run.
    "--settings",
    input.settingsPath,
  ];
  if (input.supportsPermissionPrompts) args.push("--permission-prompts", "none");
  const model = input.model?.trim();
  if (model) args.push("--model", model);
  return args;
}

/** Whether this CLI accepts `--permission-prompts`. Unknown version: no. */
export function supportsPermissionPrompts(version: ClaudeVersion | null): boolean {
  return version !== null && versionAtLeast(version, PERMISSION_PROMPTS_MIN);
}

/**
 * Settings layered on for a headless run. The user's own hooks are for their
 * interactive sessions: a SessionStart hook that injects a persona or a
 * reminder rewrites the report this run hands back, and a Stop hook that plays
 * a sound or posts to chat fires for a review nobody is watching. The run's
 * tool set is closed and its report is the only output, so it runs without
 * them. (Managed settings still apply — an organization's hooks are not the
 * user's to switch off, and not ours either.)
 */
export const HEADLESS_SETTINGS = `${JSON.stringify({ disableAllHooks: true })}\n`;

/** The `--mcp-config` file: our server and nothing else. Holds the token. */
export function mcpConfigJson(server: { url: string; token: string }): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: server.url,
          headers: { Authorization: `Bearer ${server.token}` },
        },
      },
    },
    null,
    2,
  )}\n`;
}

// The system prompt a run carries — the tools-only rendering of the skill plus
// a preamble naming this session's tools — is built in `skillText.ts`, next to
// every other rendering of the same text (`headlessSystemPrompt`).

// ---------------------------------------------------------------------------
// The stream (pure)
// ---------------------------------------------------------------------------

export interface McpServerStatus {
  name: string;
  status: string;
}

export type HeadlessEvent =
  | { kind: "init"; mcpServers: McpServerStatus[]; tools: string[]; sessionId?: string; model?: string }
  /** One per `tool_use` block — an assistant message can carry several. */
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "retry"; error: string; attempt?: number; status?: number }
  | {
      kind: "result";
      isError: boolean;
      subtype: string;
      text: string;
      costUsd?: number;
      numTurns?: number;
      sessionId?: string;
    }
  | { kind: "other" };

const OTHER: HeadlessEvent = { kind: "other" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse one NDJSON line into the events it carries. Always returns at least one
 * event: a line this doesn't recognize — hook chatter, rate-limit notices, a
 * truncated last line — is `other`, never an exception. The stream is a
 * contract we read, not one we own, and a new event type must not break a run.
 */
export function parseStreamLine(line: string): HeadlessEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return [OTHER];
  }
  if (!isRecord(raw)) return [OTHER];

  if (raw.type === "system" && raw.subtype === "init") {
    const servers = Array.isArray(raw.mcp_servers)
      ? raw.mcp_servers.filter(isRecord).map((s) => ({
          name: String(s.name ?? ""),
          status: String(s.status ?? "unknown"),
        }))
      : [];
    const tools = Array.isArray(raw.tools)
      ? raw.tools.filter((t): t is string => typeof t === "string")
      : [];
    return [
      {
        kind: "init",
        mcpServers: servers,
        tools,
        sessionId: optString(raw.session_id),
        model: optString(raw.model),
      },
    ];
  }

  if (raw.type === "system" && raw.subtype === "api_retry") {
    return [
      {
        kind: "retry",
        error: optString(raw.error) ?? "unknown",
        attempt: optNumber(raw.attempt),
        status: optNumber(raw.error_status),
      },
    ];
  }

  if (raw.type === "assistant" && isRecord(raw.message) && Array.isArray(raw.message.content)) {
    const tools: HeadlessEvent[] = raw.message.content
      .filter(isRecord)
      .filter((b) => b.type === "tool_use" && typeof b.name === "string")
      .map((b) => ({
        kind: "tool" as const,
        name: b.name as string,
        input: isRecord(b.input) ? b.input : {},
      }));
    return tools.length > 0 ? tools : [OTHER];
  }

  if (raw.type === "result") {
    // Error results may carry `errors` instead of a `result` string.
    const text =
      optString(raw.result) ??
      (Array.isArray(raw.errors) ? raw.errors.map((e) => String(e)).join("\n") : "");
    return [
      {
        kind: "result",
        isError: raw.is_error === true,
        subtype: optString(raw.subtype) ?? "unknown",
        text,
        costUsd: optNumber(raw.total_cost_usd),
        numTurns: optNumber(raw.num_turns),
        sessionId: optString(raw.session_id),
      },
    ];
  }

  return [OTHER];
}

/**
 * Retry categories that no amount of retrying fixes. The CLI would back off and
 * retry these for minutes; the run is stopped on the first one instead.
 */
const AUTH_RETRY_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);

export function isAuthRetry(error: string): boolean {
  return AUTH_RETRY_ERRORS.has(error);
}

/** An error result that is really "you're not signed in". */
export function isAuthResultText(text: string): boolean {
  return /\b(log(ged)? ?in|sign(ed)? ?in|api[ _-]?key)\b|\/login/i.test(text);
}

/** `mcp__markdown-collab__mc_open` → `mc_open`; built-ins pass through. */
export function shortToolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

// ---------------------------------------------------------------------------
// Availability (pure)
// ---------------------------------------------------------------------------

export type HeadlessUnavailableReason = "untrusted" | "not-installed" | "no-server" | "mcp-disabled";

export interface HeadlessAvailabilityInput {
  trusted: boolean;
  binaryResolved: boolean;
  serverRunning: boolean;
  /** A run in this workspace already found our server missing from Claude's list. */
  mcpFailedHere: boolean;
}

/**
 * Whether headless can run right now, and if not the one reason to name. Order
 * is most-fundamental first: an untrusted workspace never runs headless whatever
 * else is true.
 */
export function decideHeadlessAvailability(
  input: HeadlessAvailabilityInput,
): { ok: true } | { ok: false; reason: HeadlessUnavailableReason } {
  if (!input.trusted) return { ok: false, reason: "untrusted" };
  if (!input.binaryResolved) return { ok: false, reason: "not-installed" };
  if (!input.serverRunning) return { ok: false, reason: "no-server" };
  if (input.mcpFailedHere) return { ok: false, reason: "mcp-disabled" };
  return { ok: true };
}

/** Plain words for a toast: "couldn't run Claude for you — <this>". */
export function unavailableReasonText(reason: HeadlessUnavailableReason): string {
  switch (reason) {
    case "untrusted":
      return "this workspace isn't trusted";
    case "not-installed":
      return "Claude Code isn't installed, or isn't on your PATH (set markdownCollab.claudePath)";
    case "no-server":
      return "the review tool server isn't running";
    case "mcp-disabled":
      return "Claude Code couldn't use the review tools here last time (MCP may be disabled for Claude)";
  }
}

// ---------------------------------------------------------------------------
// One run (impure: a process and two temp files)
// ---------------------------------------------------------------------------

export type HeadlessFailureReason =
  /** The process never started (missing binary, temp files unwritable). */
  | "spawn"
  /** `system/init` didn't list our server as connected. */
  | "mcp-unavailable"
  /** Not signed in, or the org doesn't allow this login. */
  | "auth"
  /** Claude finished with an error result. */
  | "error-result"
  /** The process exited without a result. */
  | "exit";

interface RunClock {
  startedAt: number;
  toolCount: number;
}

export type HeadlessState =
  | ({ kind: "starting" } & RunClock)
  | ({ kind: "working"; lastTool?: string; phase?: string } & RunClock)
  | ({
      kind: "done";
      endedAt: number;
      text: string;
      costUsd?: number;
      numTurns?: number;
      sessionId?: string;
    } & RunClock)
  | ({ kind: "failed"; endedAt: number; reason: HeadlessFailureReason; detail: string } & RunClock)
  | ({ kind: "cancelled"; endedAt: number; reason: "user" | "timeout" } & RunClock);

export type FinishedHeadlessState = Extract<HeadlessState, { kind: "done" | "failed" | "cancelled" }>;

export function isFinished(state: HeadlessState): state is FinishedHeadlessState {
  return state.kind === "done" || state.kind === "failed" || state.kind === "cancelled";
}

export interface HeadlessRunOptions {
  binaryPath: string;
  /** From `claude --version`; decides whether `--permission-prompts` is passed. */
  version: ClaudeVersion | null;
  /** The workspace folder: the files Claude reads resolve against it. */
  cwd: string;
  prompt: string;
  systemPrompt: string;
  server: { url: string; token: string };
  model?: string;
  /** The payload's file label, for log lines. */
  fileLabel: string;
  log?: Logger;
  budgetMs?: number;
  cancelGraceMs?: number;
  tmpRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

type Listener = (state: HeadlessState) => void;

/**
 * One `claude -p` process, from temp files to exit.
 *
 * `start()` resolves once the process is gone and the temp directory deleted,
 * with the final state. Listeners see every transition in between:
 * `starting → working (lastTool, toolCount) → done | failed | cancelled`.
 */
export class HeadlessRun {
  private current: HeadlessState;
  private readonly listeners = new Set<Listener>();
  private child: ChildProcess | null = null;
  private dir: string | null = null;
  private started = false;
  private finishing = false;
  /** A failure decided mid-stream (no MCP, not signed in); the exit only confirms it. */
  private decided: { reason: HeadlessFailureReason; detail: string } | null = null;
  private cancelReason: "user" | "timeout" | null = null;
  private result: Extract<HeadlessEvent, { kind: "result" }> | null = null;
  private stdoutPartial = "";
  private stderrPartial = "";
  private readonly stderrLines: string[] = [];
  private servers: McpServerStatus[] | null = null;
  private readonly timers: Array<ReturnType<typeof setTimeout>> = [];
  private resolveFinished!: (state: FinishedHeadlessState) => void;
  /** Settles with the final state once the process and its temp files are gone. */
  readonly finished: Promise<FinishedHeadlessState>;

  constructor(private readonly opts: HeadlessRunOptions) {
    this.current = { kind: "starting", startedAt: this.now(), toolCount: 0 };
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
  }

  get state(): HeadlessState {
    return this.current;
  }

  /** The temp directory holding the config and system prompt, while it exists. */
  get tempDir(): string | null {
    return this.dir;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The last lines Claude Code wrote to stderr — what a failure report shows. */
  get stderrTail(): string[] {
    return this.stderrPartial ? [...this.stderrLines, this.stderrPartial] : [...this.stderrLines];
  }

  /** MCP server statuses from `system/init`, once it has arrived. */
  get initServers(): McpServerStatus[] | null {
    return this.servers;
  }

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Start the process. Idempotent; resolves with the final state. */
  start(): Promise<FinishedHeadlessState> {
    if (!this.started) {
      this.started = true;
      void this.run();
    }
    return this.finished;
  }

  /**
   * Stop the run: SIGINT first, which ends the turn the way Ctrl+C would, then
   * SIGTERM if it's still alive after the grace period (and SIGKILL after
   * another, because "cancelled" must mean the process is gone).
   */
  cancel(reason: "user" | "timeout" = "user"): void {
    if (isFinished(this.current) || this.finishing) return;
    if (this.cancelReason === null && this.decided === null) this.cancelReason = reason;
    this.opts.log?.info("cancelling headless run", { reason, file: this.opts.fileLabel });
    this.terminate();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async run(): Promise<void> {
    const log = this.opts.log;
    let mcpConfigPath: string;
    let systemPromptPath: string;
    let settingsPath: string;
    try {
      this.dir = await fsp.mkdtemp(path.join(this.opts.tmpRoot ?? os.tmpdir(), "mc-headless-"));
      mcpConfigPath = path.join(this.dir, "mcp.json");
      systemPromptPath = path.join(this.dir, "system-prompt.md");
      settingsPath = path.join(this.dir, "settings.json");
      // `wx`: a file we didn't create (a planted symlink) is refused, not followed.
      await fsp.writeFile(mcpConfigPath, mcpConfigJson(this.opts.server), { mode: 0o600, flag: "wx" });
      await fsp.writeFile(systemPromptPath, this.opts.systemPrompt, { mode: 0o600, flag: "wx" });
      await fsp.writeFile(settingsPath, HEADLESS_SETTINGS, { mode: 0o600, flag: "wx" });
    } catch (e) {
      await this.finish(this.failedState("spawn", `could not write the run's temp files: ${(e as Error).message}`));
      return;
    }
    if (this.cancelReason) {
      await this.finish(this.cancelledState(this.cancelReason));
      return;
    }

    const args = buildHeadlessArgs({
      mcpConfigPath,
      systemPromptPath,
      settingsPath,
      model: this.opts.model,
      supportsPermissionPrompts: supportsPermissionPrompts(this.opts.version),
    });
    const spec = spawnCommand(this.opts.binaryPath, args, this.opts.platform ?? process.platform);
    const env = { ...(this.opts.env ?? process.env) };
    // Set by Claude Code in the shells it spawns. A VS Code launched from one
    // would pass it on, and the child would take itself for a nested session.
    delete env.CLAUDECODE;

    log?.info("starting headless run", {
      binary: this.opts.binaryPath,
      version: this.opts.version?.raw ?? "unknown",
      cwd: this.opts.cwd,
      file: this.opts.fileLabel,
      model: this.opts.model?.trim() || "default",
    });

    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: this.opts.cwd,
        env,
        shell: spec.shell,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      await this.finish(this.failedState("spawn", (e as Error).message));
      return;
    }
    this.child = child;

    child.on("error", (e) => {
      // Only a failure to start ends the run here; a failed kill() also lands
      // on this event and must not.
      if (child.pid === undefined) {
        void this.finish(this.failedState("spawn", `could not start ${this.opts.binaryPath}: ${e.message}`));
      } else {
        log?.warn("headless process error", e.message);
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.onStderr(chunk));
    child.on("close", (code, signal) => void this.onClose(code, signal));

    // A process that dies before reading stdin makes this write fail with
    // EPIPE; the exit handler reports that run, so the write error is noise.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(this.opts.prompt);

    this.later(() => {
      log?.warn("headless run hit its time budget", { minutes: Math.round(this.budgetMs() / 60000) });
      this.cancel("timeout");
    }, this.budgetMs());
  }

  private budgetMs(): number {
    return this.opts.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  private onStdout(chunk: string): void {
    this.stdoutPartial += chunk;
    let nl: number;
    while ((nl = this.stdoutPartial.indexOf("\n")) !== -1) {
      const line = this.stdoutPartial.slice(0, nl);
      this.stdoutPartial = this.stdoutPartial.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onStderr(chunk: string): void {
    const parts = (this.stderrPartial + chunk).split(/\r?\n/);
    this.stderrPartial = parts.pop() ?? "";
    for (const line of parts) {
      this.stderrLines.push(line);
      if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift();
    }
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    for (const event of parseStreamLine(line)) this.onEvent(event);
  }

  private onEvent(event: HeadlessEvent): void {
    // Once the run is decided, the rest of the stream is the process winding down.
    if (this.decided || this.finishing) return;
    const log = this.opts.log;
    switch (event.kind) {
      case "init": {
        this.servers = event.mcpServers;
        log?.info("claude initialized", {
          servers: event.mcpServers.map((s) => `${s.name}:${s.status}`),
          tools: event.tools.length,
          model: event.model,
        });
        const ours = event.mcpServers.find((s) => s.name === MCP_SERVER_NAME);
        if (!ours || ours.status !== "connected") {
          this.failWith(
            "mcp-unavailable",
            ours
              ? `Claude Code reports the ${MCP_SERVER_NAME} server as "${ours.status}"`
              : `Claude Code did not load the ${MCP_SERVER_NAME} server (MCP may be disabled by policy)`,
          );
          return;
        }
        if (this.current.kind === "starting") {
          this.setState({ kind: "working", startedAt: this.current.startedAt, toolCount: 0 });
        }
        return;
      }
      case "tool": {
        const short = shortToolName(event.name);
        log?.trace("tool", { name: short });
        const previous = this.current.kind === "working" ? this.current : undefined;
        const note = short === "mc_status" && typeof event.input.note === "string" ? event.input.note : undefined;
        this.setState({
          kind: "working",
          startedAt: this.current.startedAt,
          toolCount: this.current.toolCount + 1,
          lastTool: short,
          phase: note ?? previous?.phase,
        });
        return;
      }
      case "retry": {
        if (isAuthRetry(event.error)) {
          this.failWith("auth", `Claude Code could not authenticate (${event.error})`);
          return;
        }
        log?.warn("claude is retrying an API call", {
          error: event.error,
          attempt: event.attempt,
          status: event.status,
        });
        return;
      }
      case "result": {
        this.result = event;
        log?.info("claude finished", {
          turns: event.numTurns,
          costUsd: event.costUsd,
          isError: event.isError,
          subtype: event.subtype,
        });
        return;
      }
      case "other":
        return;
    }
  }

  /** Decide the outcome now and stop the process; the exit confirms it. */
  private failWith(reason: HeadlessFailureReason, detail: string): void {
    this.decided = { reason, detail };
    this.opts.log?.warn("stopping headless run", { reason, detail });
    this.terminate();
  }

  private terminate(): void {
    const child = this.child;
    if (!child || !this.alive(child)) return;
    const grace = this.opts.cancelGraceMs ?? CANCEL_GRACE_MS;
    child.kill("SIGINT");
    this.later(() => {
      if (this.alive(child)) child.kill("SIGTERM");
    }, grace);
    this.later(() => {
      if (this.alive(child)) child.kill("SIGKILL");
    }, grace * 2);
  }

  private alive(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    this.timers.push(t);
  }

  private async onClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    // A last line without a newline is still a line — or a truncated one,
    // which the parser reads as `other`.
    if (this.stdoutPartial.trim() !== "") {
      const rest = this.stdoutPartial;
      this.stdoutPartial = "";
      this.onLine(rest);
    }
    const result = this.result;
    let final: FinishedHeadlessState;
    if (this.decided) {
      final = this.failedState(this.decided.reason, this.decided.detail);
    } else if (result && !result.isError) {
      // A result that made it out wins over a cancel that raced it: the work
      // is done, and saying "cancelled" would hide the report.
      final = {
        kind: "done",
        startedAt: this.current.startedAt,
        toolCount: this.current.toolCount,
        endedAt: this.now(),
        text: result.text,
        costUsd: result.costUsd,
        numTurns: result.numTurns,
        sessionId: result.sessionId,
      };
    } else if (this.cancelReason) {
      final = this.cancelledState(this.cancelReason);
    } else if (result) {
      const detail = result.text.trim() || `Claude Code ended with ${result.subtype}`;
      final = this.failedState(isAuthResultText(result.text) ? "auth" : "error-result", detail);
    } else {
      const how = signal ? `on ${signal}` : `with code ${code}`;
      final = this.failedState("exit", `Claude Code exited ${how} before finishing`);
    }
    await this.finish(final);
  }

  private failedState(reason: HeadlessFailureReason, detail: string): FinishedHeadlessState {
    return {
      kind: "failed",
      startedAt: this.current.startedAt,
      toolCount: this.current.toolCount,
      endedAt: this.now(),
      reason,
      detail,
    };
  }

  private cancelledState(reason: "user" | "timeout"): FinishedHeadlessState {
    return {
      kind: "cancelled",
      startedAt: this.current.startedAt,
      toolCount: this.current.toolCount,
      endedAt: this.now(),
      reason,
    };
  }

  /** The one exit: temp files gone, timers cleared, final state announced. */
  private async finish(final: FinishedHeadlessState): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.dir) {
      try {
        await fsp.rm(this.dir, { recursive: true, force: true });
        this.dir = null;
      } catch (e) {
        this.opts.log?.warn("could not delete the headless run's temp directory", {
          dir: this.dir,
          error: (e as Error).message,
        });
      }
    }
    const log = this.opts.log;
    if (final.kind === "failed") {
      log?.warn("headless run failed", {
        reason: final.reason,
        detail: final.detail,
        stderr: this.stderrTail.slice(-10).join("\n"),
      });
      if (this.stderrTail.length > 0) log?.trace("headless stderr tail", this.stderrTail.join("\n"));
    } else {
      log?.info(`headless run ${final.kind}`, {
        file: this.opts.fileLabel,
        seconds: Math.round((final.endedAt - final.startedAt) / 1000),
        tools: final.toolCount,
        ...(final.kind === "cancelled" ? { reason: final.reason } : {}),
      });
    }
    this.setState(final);
    this.resolveFinished(final);
  }

  private setState(next: HeadlessState): void {
    this.current = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // A broken listener must not wedge the run it is watching.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// One run per workspace folder
// ---------------------------------------------------------------------------

export interface HeadlessRunRecord {
  /** The workspace folder's fsPath — the one-run-per-folder key. */
  key: string;
  /** The payload's `file`: a path, or "3 files under docs/". */
  fileLabel: string;
  /** Absolute paths under review; the first is what "Open review view" opens. */
  files: string[];
  run: HeadlessRun;
}

const active = new Map<string, HeadlessRunRecord>();
let last: HeadlessRunRecord | null = null;
const registryListeners = new Set<() => void>();

function fireRegistry(): void {
  for (const listener of [...registryListeners]) {
    try {
      listener();
    } catch {
      // Same rule as the run's own listeners.
    }
  }
}

/**
 * Track a run until it finishes. Refuses a second run in the same folder: two
 * Claudes editing the same documents through the same tool server would
 * interleave writes neither of them planned for.
 */
export function trackHeadlessRun(record: HeadlessRunRecord): void {
  if (active.has(record.key)) {
    throw new Error(`a headless run is already active in ${record.key}`);
  }
  active.set(record.key, record);
  record.run.onDidChange((state) => {
    if (isFinished(state)) {
      if (active.get(record.key) === record) active.delete(record.key);
      last = record;
    }
    fireRegistry();
  });
  fireRegistry();
}

export function activeHeadlessRun(key: string): HeadlessRunRecord | undefined {
  return active.get(key);
}

/** Active runs, newest first. */
export function activeHeadlessRuns(): HeadlessRunRecord[] {
  return [...active.values()].sort((a, b) => b.run.state.startedAt - a.run.state.startedAt);
}

/** The most recently finished run, in any folder. */
export function lastHeadlessRun(): HeadlessRunRecord | null {
  return last;
}

/** Fires on every state change of every tracked run. */
export function onHeadlessRunsChanged(listener: () => void): { dispose(): void } {
  registryListeners.add(listener);
  return { dispose: () => registryListeners.delete(listener) };
}
