// One log channel, with levels, scopes, and nothing secret in it.
//
// The extension used to have 46 `output.appendLine` calls and 63 silent
// `catch {}` blocks. When a send didn't arrive, or a tool call refused, or a
// panel came up empty, the channel said nothing at all — every diagnosis
// started by adding logging and asking the user to reproduce.
//
// This is a `LogOutputChannel`, not a plain one: VS Code stamps each line with
// a timestamp and a level, and the Output panel gets a level picker, so a user
// can turn on trace for one reproduction without a setting or a reload. The
// wrapper adds two things the platform doesn't: a scope tag, so a line says
// which subsystem produced it, and redaction, because the MCP bearer token and
// the URLs carrying it must never reach a channel people paste into issues.

import * as vscode from "vscode";

/** Every subsystem that logs. Adding one here is how it gets a tag. */
export type LogScope =
  | "activation"
  | "send"
  | "terminal"
  | "mcp"
  | "mcp-tool"
  | "panel"
  | "live-editor"
  | "review"
  | "pr"
  | "skill"
  | "format"
  | "diagnostics";

export interface Logger {
  /** Verbose detail: payload sizes, message traffic, per-call timings. */
  trace(message: string, data?: unknown): void;
  /** The normal narrative: what the user's action did. */
  info(message: string, data?: unknown): void;
  /** Something degraded but the operation continued. */
  warn(message: string, data?: unknown): void;
  /** Something failed. Errors log their stack. */
  error(message: string, err?: unknown): void;
  /** A child logger that tags every line with `scope`. */
  scope(scope: LogScope): Logger;
  /**
   * Time an operation and log its outcome at trace (success) or error
   * (throw), including the elapsed milliseconds. Rethrows unchanged.
   */
  time<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Reveal the channel in the Output panel. */
  show(): void;
}

/**
 * Anything that looks like a credential, replaced before it is written.
 *
 * Deliberately broad and applied to every line rather than at chosen call
 * sites: the whole point is that a future call site cannot leak by forgetting.
 * The MCP token is 32 hex chars from `randomBytes(16).toString("hex")`.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  // Bearer tokens in headers or serialized config.
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer «redacted»"],
  // `token=…` / `"token": "…"` in query strings and JSON.
  [/(["']?(?:token|access_token|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{8,})/gi, '$1«redacted»'],
  // A bare 32+ char hex run — the shape of our own session token.
  [/\b[0-9a-f]{32,}\b/g, "«redacted»"],
];

/** Strip anything credential-shaped from a line. Exported for tests. */
export function redact(line: string): string {
  let out = line;
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

/**
 * Render a log line's optional payload. Objects are JSON, truncated — a log
 * line that dumps a whole document is one nobody reads, and the payloads here
 * routinely carry a full prompt.
 */
const MAX_DATA = 600;
export function formatData(data: unknown): string {
  if (data === undefined) return "";
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (data instanceof Error) {
    text = data.stack ?? `${data.name}: ${data.message}`;
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }
  if (text.length > MAX_DATA) text = `${text.slice(0, MAX_DATA)}… (${text.length} chars)`;
  return text;
}

/** Compose the final line: `[scope] message — data`, redacted. */
export function composeLine(scope: LogScope | null, message: string, data?: unknown): string {
  const tag = scope ? `[${scope}] ` : "";
  const rendered = formatData(data);
  return redact(rendered ? `${tag}${message} — ${rendered}` : `${tag}${message}`);
}

/** The sink a Logger writes to. `LogOutputChannel` satisfies it; tests fake it. */
export interface LogSink {
  trace(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show?(): void;
}

class ScopedLogger implements Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly tag: LogScope | null,
  ) {}

  trace(message: string, data?: unknown): void {
    this.sink.trace(composeLine(this.tag, message, data));
  }
  info(message: string, data?: unknown): void {
    this.sink.info(composeLine(this.tag, message, data));
  }
  warn(message: string, data?: unknown): void {
    this.sink.warn(composeLine(this.tag, message, data));
  }
  error(message: string, err?: unknown): void {
    // An Error's stack is the useful part, and formatData already extracts it.
    this.sink.error(composeLine(this.tag, message, err));
  }
  scope(scope: LogScope): Logger {
    return new ScopedLogger(this.sink, scope);
  }
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.trace(`${label} ok`, { ms: Date.now() - started });
      return result;
    } catch (e) {
      this.error(`${label} failed after ${Date.now() - started}ms`, e);
      throw e;
    }
  }
  show(): void {
    this.sink.show?.();
  }
}

/** Build a Logger over any sink. Used by tests and by `createLogger`. */
export function loggerFor(sink: LogSink): Logger {
  return new ScopedLogger(sink, null);
}

/**
 * The extension's logger, backed by a `LogOutputChannel` named "Markdown
 * Collab". `{ log: true }` is what gives the channel its level picker and
 * per-line timestamps — without it this is just an append-only text buffer.
 */
export function createLogger(): Logger & vscode.Disposable {
  const channel = vscode.window.createOutputChannel("Markdown Collab", { log: true });
  const base = new ScopedLogger(channel, null);
  return {
    trace: (m, d) => base.trace(m, d),
    info: (m, d) => base.info(m, d),
    warn: (m, d) => base.warn(m, d),
    error: (m, e) => base.error(m, e),
    scope: (s) => base.scope(s),
    time: (label, fn) => base.time(label, fn),
    show: () => base.show(),
    dispose: () => channel.dispose(),
  };
}
