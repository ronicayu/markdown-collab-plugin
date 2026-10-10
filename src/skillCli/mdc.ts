// `mdc` — the CLI Claude uses to mutate inline-comment documents. Bundled (esbuild,
// ESM, zero deps) into `mdc.mjs` and installed next to the skill. It imports the real
// format engine and must never grow its own copy of the parser.
//
// The verbs live in `inlineComments/docOps.ts`, shared with the extension-hosted MCP
// server, so a fix in one front end fixes both; this file is argv parsing, file I/O,
// and exit codes. When the extension's server address is in the environment (every
// VS Code terminal has it), mutating verbs are sent there and land as a WorkspaceEdit
// (undoable, ordered against unsaved edits) instead of a raw write; see `forward` for
// when it falls back.
//
// Contract with the caller:
//   - stdout is always a single JSON document, written with writeSync(1) so
//     it survives a POSIX pipe without buffering loss; a failure is
//     `{"ok":false,"code":…,"message":…}` on one line
//   - stderr carries the same failure as a human-readable line
//   - exit 0 = success, 1 = command/usage error, 2 = integrity violation

import { writeSync } from "node:fs";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import * as path from "node:path";
import { stripAllInlineMarkup } from "../inlineComments/format";
import { checkIntegrity, repairIntegrity } from "../inlineComments/integrity";
import {
  DocOpError,
  opAccept,
  opCheckAndCheckpoint,
  opEdit,
  opList,
  opOpen,
  opReject,
  opReply,
  opResolve,
  opRewrite,
  opSuggest,
  parseOccurrence,
  type DocOpCode,
  type OpOutcome,
} from "../inlineComments/docOps";
import { PROTOCOL_VERSION } from "../mcpServer/protocol";
import { ENV_TOKEN, ENV_URL } from "../mcpServer/registration";
import { runCheckHook, type HookIo } from "./checkHook";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_INTEGRITY = 2;

const USAGE = `mdc — Markdown Collab inline-comment CLI

  mdc list <file> [--actionable]              threads as JSON
  mdc reply <file> <threadId> --body TEXT [--author SLUG]
                                              append a reply authored by claude (or --author);
                                              a resolved thread is reopened ("reopened": true)
  mdc rewrite <file> <threadId> --with TEXT   replace the anchored span, markers preserved
  mdc edit <file> --old TEXT --new TEXT [--occurrence N]
                                              replace exact prose text outside anchored spans
  mdc open <file> --quote TEXT --body TEXT [--occurrence N] [--author SLUG]
                                              open a new thread on a passage
  mdc resolve <file> <threadId> [--author SLUG]
                                              mark a thread resolved
  mdc suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N] [--author SLUG]
                                              propose an edit (accept/reject in the UI)
  mdc accept <file> <anchorId>                apply a pending suggestion
  mdc reject <file> <anchorId>                drop a pending suggestion, keep the original
  mdc check <file> [--repair]                 integrity report; exit 2 if broken
  mdc check --hook                            Claude Code PostToolUse hook: reads the hook JSON on stdin;
                                              exit 2 + report on stderr if the edited .md has broken markers

  --author SLUG applies to reply/open/resolve/suggest — the agent writing the
  comment. Defaults to "claude"; every headless Claude Code
  run is that default, so nothing changes for it. Sets the comment's JSON
  "agent" flag alongside "author".

  With ${ENV_URL}/_TOKEN set, writes go through the running extension; --direct writes the file itself.

Every command prints JSON to stdout — on failure {"ok":false,"code":"…","message":"…"}, with the
message also on stderr (check --hook prints only its stderr report). Exit codes: 0 ok, 1 usage or
refused, 2 integrity.`;

function out(obj: unknown): void {
  writeSync(1, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * `code` is the machine-readable reason (a DocOpCode, the extension's refusal code,
 * or `usage`), so stdout has the same shape an MCP refusal has. `detail` goes to
 * stderr only.
 */
function fail(message: string, opts: { code?: string; exit?: number; detail?: string } = {}): never {
  writeSync(1, `${JSON.stringify({ ok: false, code: opts.code ?? "usage", message })}\n`);
  writeSync(2, `mdc: ${message}\n${opts.detail ? `\n${opts.detail}\n` : ""}`);
  process.exit(opts.exit ?? EXIT_USAGE);
}

/**
 * Integrity-class refusals are exit 2 so a caller can tell "you asked for the wrong
 * thing" from "the document is damaged"; everything else is a usage error.
 */
const EXIT_FOR_CODE: Record<DocOpCode, number> = {
  thread_not_found: EXIT_USAGE,
  suggestion_not_found: EXIT_USAGE,
  passage_not_found: EXIT_USAGE,
  passage_ambiguous: EXIT_USAGE,
  not_anchorable: EXIT_USAGE,
  not_editable: EXIT_USAGE,
  unanchored: EXIT_USAGE,
  // Only reachable through the editor's selection path, but the map is
  // exhaustive over DocOpCode on purpose: a new refusal must be given an exit
  // status deliberately rather than defaulting to one.
  empty_selection: EXIT_USAGE,
  out_of_range: EXIT_USAGE,
  nothing_to_do: EXIT_USAGE,
  invalid_arguments: EXIT_USAGE,
  integrity: EXIT_INTEGRITY,
};

/** `unanchored` on some verbs is reported as an integrity problem, matching what `check` says about the same document. */
function refuse(
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
  integrityCodes: readonly string[] = [],
): never {
  // hasOwnProperty, not `in`: a code from the wire could be "constructor".
  const known = Object.prototype.hasOwnProperty.call(EXIT_FOR_CODE, code);
  const exit = integrityCodes.includes(code) ? EXIT_INTEGRITY : known ? EXIT_FOR_CODE[code as DocOpCode] : EXIT_USAGE;
  // The shared ops phrase "occurrence" without a flag, since the MCP tools
  // take it as a field. Name the flag here, where the caller has one.
  if (code === "passage_ambiguous") {
    const n = details?.occurrences;
    return fail(`passage appears ${n} times; pass --occurrence 1..${n} to say which one you mean`, { code, exit });
  }
  const hint = code === "unanchored" || code === "integrity" ? " (see `mdc check`)" : "";
  return fail(`${message}${hint}`, { code, exit });
}

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

/**
 * The flags that take no value. Every other flag takes the next token as its value
 * whatever it looks like: `--body "--x"` is a body that starts with dashes.
 */
const BOOLEAN_FLAGS = new Set(["repair", "actionable", "hook", "direct", "help"]);

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      flags.help = true;
    } else if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(name) || next === undefined) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function str(flags: Args["flags"], name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v === "") fail(`missing required --${name}`);
  return v;
}

/** Like `str`, but accepts "" — `--new` on `mdc edit` is legitimately empty (a deletion). */
function strAllowEmpty(flags: Args["flags"], name: string): string {
  const v = flags[name];
  if (typeof v !== "string") fail(`missing required --${name}`);
  return v;
}

function occurrenceFlag(flags: Args["flags"]): number {
  const v = flags.occurrence;
  if (v === undefined) return 0;
  if (v === true) fail("--occurrence needs a number", { code: "invalid_arguments" });
  try {
    return parseOccurrence(v);
  } catch (e) {
    if (!(e instanceof DocOpError)) throw e;
    return fail(`--occurrence takes a 1-based number, got ${JSON.stringify(v)}`, { code: e.code });
  }
}

function readDoc(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "ENOENT"
      ? fail(`no such file: ${file}`, { code: "file_not_found" })
      : fail(`cannot read ${file}: ${err.message}`, { code: "io_error" });
  }
}

interface Extension {
  url: string;
  token: string;
}

const REACH_TIMEOUT_MS = 3000;
/**
 * How long a call it has accepted gets to finish. Longer than the probe: the write
 * includes a save (format-on-save can be slow), and giving up on a call that went
 * out is not free — see `forward`.
 */
const CALL_TIMEOUT_MS = 10000;

type Answer =
  | { kind: "answered"; status: number; sessionId?: string; body: string }
  /** Nothing reached the server: refused connection, bad URL, no connection in time. */
  | { kind: "unreachable"; reason: string }
  /** The request went out; no complete answer came back. */
  | { kind: "lost"; reason: string };

function post(ext: Extension, message: unknown, sessionId: string | undefined, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const settle = (a: Answer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(a);
    };
    const payload = JSON.stringify(message);
    let req: ReturnType<typeof request>;
    try {
      req = request(
        ext.url,
        {
          method: "POST",
          // A fresh connection, closed after: a pooled keep-alive socket
          // would hold this process open after it has printed its answer.
          agent: false,
          headers: {
            authorization: `Bearer ${ext.token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "content-length": Buffer.byteLength(payload),
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const header = res.headers["mcp-session-id"];
            settle({
              kind: "answered",
              status: res.statusCode ?? 0,
              sessionId: typeof header === "string" ? header : undefined,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", (e) => settle({ kind: "lost", reason: e.message }));
          res.on("close", () => settle({ kind: "lost", reason: "connection closed mid-answer" }));
        },
      );
    } catch (e) {
      // An unparseable URL or a non-http scheme throws synchronously.
      resolve({ kind: "unreachable", reason: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      settle({ kind: connected ? "lost" : "unreachable", reason: `no answer within ${timeoutMs}ms` });
      req.destroy();
    }, timeoutMs);
    req.on("socket", (s) => s.once("connect", () => (connected = true)));
    req.on("error", (e) => settle({ kind: connected ? "lost" : "unreachable", reason: e.message }));
    req.end(payload);
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `result` of a JSON-RPC response body, or null for anything else (an `error`, garbage). */
function rpcResult(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) && isObject(parsed.result) ? parsed.result : null;
  } catch {
    return null;
  }
}

type Forwarded =
  | { kind: "applied"; result: Record<string, unknown> }
  | { kind: "refused"; code: string; message: string; details?: Record<string, unknown> }
  /** The extension did not take the call; writing directly is safe. */
  | { kind: "fallback" }
  /** The call went out and never came back: it may or may not have been applied. */
  | { kind: "unknown"; reason: string };

/**
 * Falls back (the caller writes directly) whenever the extension provably
 * didn't run the call: nothing listening, no answer to `initialize` in time,
 * a rejected token, a non-2xx, a reply that isn't JSON-RPC, a JSON-RPC error
 * (an older extension without this tool). A refusal — the tool ran and said
 * no — is the answer, exactly as a local DocOpError would be.
 *
 * The one case that is neither: the call went out and no answer came back.
 * The extension may already have applied it, and writing it again here would
 * post the same reply twice, so that is reported, never retried.
 */
async function forward(
  ext: Extension,
  tool: string,
  args: Record<string, unknown>,
  author: string,
): Promise<Forwarded> {
  // `initialize` is what attributes the call: the server names the author
  // from `clientInfo`, the way it names any agent that connects. (No
  // `notifications/initialized` — this server needs none.)
  const init = await post(
    ext,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: author, version: "mdc" } },
    },
    undefined,
    REACH_TIMEOUT_MS,
  );
  if (init.kind !== "answered" || init.status !== 200 || !rpcResult(init.body)) return { kind: "fallback" };

  const call = await post(
    ext,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
    init.sessionId,
    CALL_TIMEOUT_MS,
  );
  if (call.kind === "unreachable") return { kind: "fallback" };
  if (call.kind === "lost") return { kind: "unknown", reason: call.reason };
  const result = call.status === 200 ? rpcResult(call.body) : null;
  if (!result) return { kind: "fallback" };

  const first = Array.isArray(result.content) ? (result.content[0] as unknown) : undefined;
  const text = isObject(first) && typeof first.text === "string" ? first.text : "";
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (result.isError === true) {
    const err = isObject(payload) && isObject(payload.error) ? payload.error : undefined;
    if (err && typeof err.code === "string" && typeof err.message === "string") {
      return { kind: "refused", code: err.code, message: err.message, details: isObject(err.details) ? err.details : undefined };
    }
    return { kind: "refused", code: "refused", message: text || "the extension refused the call" };
  }
  // Not an error, so the write happened — report it even if the text is odd.
  return { kind: "applied", result: isObject(payload) ? payload : {} };
}

/** Hosts that can ever be "the running extension". The port varies; the loopback address doesn't. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
/** The one path the extension's tool server answers on (httpServer.ts's `serveMcp`
 *  default `path`, which `startMcpServer` never overrides). */
const MCP_PATH = "/mcp";

/**
 * Both env vars, or null — null under `--direct`, and null when the URL doesn't point
 * at the local tool server. `MARKDOWN_COLLAB_MCP_URL` is meant to come only from a
 * VS Code terminal's environment, but anything that can set an env var (a poisoned
 * shell rc file, a compromised `.env`, a misconfigured devcontainer) can set it to any
 * `http://` URL — and every mutating verb otherwise POSTs the document's own text
 * there, with the bearer token in the header. Forwarding only to `127.0.0.1`/`::1`/
 * `localhost` on the server's own path keeps a document (and the token) from ever
 * leaving the machine through this path; anything else falls back to a direct local
 * write, exactly like an unreachable server does.
 */
function extensionFromEnv(flags: Args["flags"]): Extension | null {
  if (flags.direct === true) return null;
  const url = process.env[ENV_URL];
  const token = process.env[ENV_TOKEN];
  if (!url || !token) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    writeSync(2, `mdc: ${ENV_URL} is not a valid URL (${JSON.stringify(url)}) — writing directly\n`);
    return null;
  }
  // URL.hostname keeps IPv6 addresses bracketed ("[::1]"); strip that to
  // compare against the plain form.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host) || parsed.pathname !== MCP_PATH) {
    writeSync(2, `mdc: ${ENV_URL} does not point at the local tool server (${url}) — writing directly\n`);
    return null;
  }
  return { url, token };
}

/** Re-read after a forwarded write, for the same `integrityOk` a direct write reports. */
function integrityOkOnDisk(absPath: string): boolean | undefined {
  try {
    return checkIntegrity(readFileSync(absPath, "utf8")).ok;
  } catch {
    return undefined;
  }
}

/**
 * Compute a new text from the file and write it — unless the file changed
 * between the read and the write, which means another process (an agent's own
 * edit tool, a second `mdc`) wrote it meanwhile and this result would erase
 * that write. Then the computation is redone on the new text, a few times,
 * before giving up with `conflict` and writing nothing. Only for the direct
 * path: a forwarded call is ordered by the extension's own write queue.
 *
 * `compute` returns null to write nothing.
 */
function writeComputed<T>(
  file: string,
  compute: (source: string) => { next: string; result: T } | null,
): { source: string; outcome: { next: string; result: T } | null } {
  for (let attempt = 1; ; attempt++) {
    const source = readDoc(file);
    const outcome = compute(source);
    if (!outcome || outcome.next === source) return { source, outcome };
    if (readFileSync(file, "utf8") === source) {
      writeFileSync(file, outcome.next, "utf8");
      return { source, outcome };
    }
    if (attempt === 3) {
      fail(`${file} kept changing while mdc was writing it; nothing was written — run the command again`, {
        code: "conflict",
      });
    }
  }
}

interface Mutation<T> {
  action: string;
  tool: string;
  args: Record<string, unknown>;
  run: (source: string) => OpOutcome<T>;
  /** Refusal codes reported as exit 2 for this verb. */
  integrityCodes?: DocOpCode[];
}

async function apply<T>(file: string, m: Mutation<T>, ext: Extension | null, author: string): Promise<void> {
  if (ext) {
    // A missing file is the same error either way; say so before a round trip.
    readDoc(file);
    // Absolute: the server resolves a relative path against the workspace
    // root, not against the directory this was run from.
    const abs = path.resolve(file);
    const f = await forward(ext, m.tool, { file: abs, ...m.args }, author);
    switch (f.kind) {
      case "applied": {
        // The tool's `file` is the editor's URI; keep the path as given.
        const rest = { ...f.result };
        delete rest.action;
        delete rest.file;
        out({ action: m.action, file, ...rest, integrityOk: integrityOkOnDisk(abs), via: "extension" });
        return;
      }
      case "refused":
        // "Not in this window's workspace" is about routing, not the edit: a
        // file outside the workspace was always writable from here.
        if (f.code !== "file_not_found" && f.code !== "no_workspace") {
          return refuse(f.code, f.message, f.details, m.integrityCodes);
        }
        writeSync(2, `mdc: ${file} is not in the extension's workspace — writing directly\n`);
        break;
      case "unknown":
        return fail(
          `the extension at ${ext.url} did not answer (${f.reason}); the ${m.action} may already be applied — ` +
            `run \`mdc list ${file}\` before retrying`,
          { code: "no_answer" },
        );
      case "fallback":
        writeSync(2, `mdc: extension not reachable at ${ext.url} — writing directly\n`);
        break;
    }
  }

  let outcome: OpOutcome<T>;
  try {
    outcome = writeComputed(file, m.run).outcome!;
  } catch (e) {
    if (e instanceof DocOpError) return refuse(e.code, e.message, e.details, m.integrityCodes);
    throw e;
  }
  out({ action: m.action, file, ...outcome.result, integrityOk: checkIntegrity(outcome.next).ok });
}

function cmdList(file: string, actionableOnly: boolean): void {
  out({ file, ...opList(readDoc(file), actionableOnly) });
}

async function cmdCheck(file: string, repair: boolean, ext: Extension | null, author: string): Promise<void> {
  if (!repair) {
    // The checkpoint is a write, so with the extension running it goes through
    // `mc_check` like every other write: ordered in the document's write
    // queue, never racing an unsaved buffer in the editor.
    if (ext) {
      readDoc(file);
      const f = await forward(ext, "mc_check", { file: path.resolve(file) }, author);
      if (f.kind === "applied") {
        const rest = { ...f.result };
        delete rest.file;
        out({ file, ...rest, via: "extension" });
        process.exit(rest.ok === true ? EXIT_OK : EXIT_INTEGRITY);
      }
      if (f.kind === "refused" && f.code !== "file_not_found" && f.code !== "no_workspace") {
        return refuse(f.code, f.message, f.details);
      }
      if (f.kind === "unknown") {
        return fail(
          `the extension at ${ext.url} did not answer (${f.reason}); run \`mdc check ${file}\` again`,
          { code: "no_answer" },
        );
      }
      writeSync(2, `mdc: checking ${file} directly\n`);
    }
    // Shares `opCheckAndCheckpoint` with `mc_check`: a healthy document gets a review
    // checkpoint here too, so "Review Changes Since Last Pass" is incremental for a
    // terminal Claude. A broken document is reported and left untouched.
    let report!: ReturnType<typeof opCheckAndCheckpoint>["report"];
    const { outcome } = writeComputed(file, (source) => {
      const checked = opCheckAndCheckpoint(source);
      report = checked.report;
      return checked.next !== undefined && checked.checkpoint ? { next: checked.next, result: checked.checkpoint } : null;
    });
    out(outcome ? { file, ...report, checkpointed: outcome.result.ts } : { file, ...report });
    process.exit(report.ok ? EXIT_OK : EXIT_INTEGRITY);
  }

  let result!: ReturnType<typeof repairIntegrity>;
  writeComputed(file, (source) => {
    result = repairIntegrity(source);
    if (result.source === source) return null;
    // The prose rule is enforced inside repairIntegrity, but this is the
    // process that actually writes to the user's file — verify again here.
    if (stripAllInlineMarkup(result.source) !== stripAllInlineMarkup(source)) {
      fail("internal error: repair would have altered prose; nothing was written", {
        code: "integrity",
        exit: EXIT_INTEGRITY,
      });
    }
    return { next: result.source, result: null };
  });
  out({
    file,
    repaired: result.repairs.length,
    repairs: result.repairs,
    ok: result.remaining.length === 0,
    remaining: result.remaining.map((i) => ({
      kind: i.kind,
      threadId: i.threadId,
      repairable: i.repairable,
      message: i.message,
    })),
  });
  process.exit(result.remaining.length === 0 ? EXIT_OK : EXIT_INTEGRITY);
}

/** A directory must read as "missing" rather than throw or return its listing — `statSync` guards that before `readFileSync`. */
const realHookIo: HookIo = {
  readFile(absPath: string): string | null {
    try {
      if (!statSync(absPath).isFile()) return null;
      return readFileSync(absPath, "utf8");
    } catch {
      return null;
    }
  },
  cwd: () => process.cwd(),
};

/**
 * `mdc check --hook` — no positional file, no JSON on stdout; Claude Code gives the
 * edited path on stdin. Reading stdin can fail (no stdin attached, a closed pipe);
 * that must be survived silently rather than crash the hook.
 */
function cmdCheckHook(): void {
  let stdinText: string;
  try {
    stdinText = readFileSync(0, "utf8");
  } catch {
    process.exit(EXIT_OK);
  }
  const outcome = runCheckHook(stdinText, realHookIo);
  // writeSync, like `out()`: on macOS a pipe write is asynchronous, and the
  // exit below would race it — and the report IS the point of exit 2.
  if (outcome.stderr) writeSync(2, outcome.stderr);
  process.exit(outcome.exitCode);
}

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  // `--help` wins wherever it appears — `mdc reply --help` is a question, not
  // a reply with a missing body.
  if (flags.help === true) {
    writeSync(1, `${USAGE}\n`);
    process.exit(EXIT_OK);
  }
  const [command, ...rest] = _;
  if (command === undefined) fail("no command given", { detail: USAGE });
  // "claude" is the default: every existing caller, including headless Claude Code
  // runs, never passes `--author`.
  const author = typeof flags.author === "string" && flags.author !== "" ? flags.author : "claude";
  const ext = extensionFromEnv(flags);
  const mutate = <T>(file: string, m: Mutation<T>): Promise<void> => apply(file, m, ext, author);

  switch (command) {
    case "list":
      if (!rest[0]) fail("usage: mdc list <file> [--actionable]");
      return cmdList(rest[0], flags.actionable === true);
    case "reply": {
      if (!rest[0] || !rest[1]) fail("usage: mdc reply <file> <threadId> --body TEXT [--author SLUG]");
      const threadId = rest[1];
      const body = str(flags, "body");
      return mutate(rest[0], {
        action: "reply",
        tool: "mc_reply",
        args: { threadId, body },
        // `run` is only the direct write — the forwarded one runs `mc_reply`,
        // which stamps "tools" itself.
        run: (s) => opReply(s, threadId, body, undefined, author, true, "cli"),
      });
    }
    case "rewrite": {
      if (!rest[0] || !rest[1]) fail("usage: mdc rewrite <file> <threadId> --with TEXT");
      const threadId = rest[1];
      const replacement = str(flags, "with");
      return mutate(rest[0], {
        action: "rewrite",
        tool: "mc_rewrite",
        args: { threadId, with: replacement },
        run: (s) => opRewrite(s, threadId, replacement),
      });
    }
    case "edit": {
      if (!rest[0]) fail("usage: mdc edit <file> --old TEXT --new TEXT [--occurrence N]");
      const old = str(flags, "old");
      const replacement = strAllowEmpty(flags, "new");
      const occurrence = occurrenceFlag(flags);
      return mutate(rest[0], {
        action: "edit",
        tool: "mc_edit",
        args: { old, new: replacement, occurrence },
        run: (s) => opEdit(s, old, replacement, occurrence),
      });
    }
    case "open": {
      if (!rest[0]) fail("usage: mdc open <file> --quote TEXT --body TEXT [--occurrence N] [--author SLUG]");
      const quote = str(flags, "quote");
      const body = str(flags, "body");
      const occurrence = occurrenceFlag(flags);
      return mutate(rest[0], {
        action: "open",
        tool: "mc_open",
        args: { quote, body, occurrence },
        run: (s) => opOpen(s, quote, body, occurrence, undefined, author, "cli"),
      });
    }
    case "resolve": {
      if (!rest[0] || !rest[1]) fail("usage: mdc resolve <file> <threadId> [--author SLUG]");
      const threadId = rest[1];
      return mutate(rest[0], {
        action: "resolve",
        tool: "mc_resolve",
        args: { threadId },
        run: (s) => opResolve(s, threadId, undefined, author),
      });
    }
    case "suggest": {
      if (!rest[0]) {
        fail("usage: mdc suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N] [--author SLUG]");
      }
      const quote = str(flags, "quote");
      const proposed = str(flags, "with");
      const note = typeof flags.note === "string" ? flags.note : undefined;
      const occurrence = occurrenceFlag(flags);
      return mutate(rest[0], {
        action: "suggest",
        tool: "mc_suggest",
        args: { quote, with: proposed, note, occurrence },
        run: (s) => opSuggest(s, quote, proposed, { note, occurrence }, undefined, author, "cli"),
      });
    }
    case "accept": {
      if (!rest[0] || !rest[1]) fail("usage: mdc accept <file> <anchorId>");
      const anchorId = rest[1];
      return mutate(rest[0], {
        action: "accept",
        tool: "mc_accept",
        args: { anchorId },
        run: (s) => opAccept(s, anchorId),
        // A suggestion that lost its markers is a damaged document, not a typo
        // in the command — exit 2 so a wrapper can tell the two apart.
        integrityCodes: ["unanchored"],
      });
    }
    case "reject": {
      if (!rest[0] || !rest[1]) fail("usage: mdc reject <file> <anchorId>");
      const anchorId = rest[1];
      return mutate(rest[0], {
        action: "reject",
        tool: "mc_reject",
        args: { anchorId },
        run: (s) => opReject(s, anchorId),
      });
    }
    case "check":
      // The hook form takes no positional file — Claude Code gives us the
      // path on stdin instead — so it must be checked before the usage
      // guard below rejects a bare `mdc check --hook` for lacking one.
      if (flags.hook === true) return cmdCheckHook();
      if (!rest[0]) fail("usage: mdc check <file> [--repair]");
      return cmdCheck(rest[0], flags.repair === true, ext, author);
    default:
      fail(`unknown command: ${command}`, { detail: USAGE });
  }
}

main().catch((e: unknown) => fail(`internal error: ${(e as Error).message}`, { code: "internal_error" }));
