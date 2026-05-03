import * as fs from "fs/promises";
import * as path from "path";

export const SKILL_REL_PATH = ".claude/skills/vs-markdown-collab/SKILL.md";
export const CLI_SCRIPT_REL = ".claude/skills/vs-markdown-collab/mdc.mjs";
export const TAIL_SCRIPT_REL = ".claude/skills/vs-markdown-collab/mdc-tail.mjs";
export const CHANNEL_SCRIPT_REL = ".claude/skills/vs-markdown-collab/mdc-channel.mjs";

export const CLI_SCRIPT_CONTENT = `#!/usr/bin/env node
// Markdown Collab agent helper.
//
// Filters sidecars to actionable comments only and applies targeted
// mutations (reply / delete / set-anchor / validate). Lets the agent
// operate on a large corpus of resolved comments without loading any
// of them into context. Writes are atomic (temp + rename) with cleanup
// on rename failure. Schema validation runs on every read.
//
// Usage:
//   node mdc.mjs list [--workspace <ws>] [--file <rel-md-path>]
//   node mdc.mjs reply <sidecar> <commentId> --body <text>
//   node mdc.mjs delete <sidecar> <commentId>
//   node mdc.mjs set-anchor <sidecar> <commentId> --text <s> [--before <s>] [--after <s>]
//   node mdc.mjs validate <sidecar>
//
// Argv: positional args (subcommand <pos1> <pos2>) come first; flags
// (--name value) follow. Use \`--\` to terminate flag parsing if a
// positional value happens to start with \`--\`.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

function fail(msg, code = 1) {
  process.stderr.write(\`mdc: \${msg}\\n\`);
  process.exit(code);
  throw new Error(msg); // unreachable in practice; satisfies static control-flow analysis
}

// Split argv into positional and flag arrays. \`--\` terminates flag parsing
// so a positional that legitimately starts with \`--\` can be passed verbatim.
function splitArgs(argv) {
  const positional = [];
  const flags = new Map();
  let i = 0;
  let endOfFlags = false;
  while (i < argv.length) {
    const a = argv[i];
    if (!endOfFlags && a === "--") { endOfFlags = true; i++; continue; }
    if (!endOfFlags && a.startsWith("--")) {
      const name = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || (val.startsWith("--") && val !== "--")) {
        // Bare flag with no value — treat as boolean true (none of our
        // current commands use this, so we just store true for forward use).
        flags.set(name, true);
        i++;
      } else {
        flags.set(name, val);
        i += 2;
      }
    } else {
      positional.push(a);
      i++;
    }
  }
  return { positional, flags };
}

const { positional, flags } = splitArgs(process.argv.slice(2));
const cmd = positional[0];
const pos = positional.slice(1);

function flag(name, def) {
  return flags.has(name) ? flags.get(name) : def;
}

const ID_RE = /^c_[0-9a-f]{8}$/;
function validateComment(c, i) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return \`comment[\${i}] must be an object\`;
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) return \`comment[\${i}].id invalid\`;
  if (!c.anchor || typeof c.anchor !== "object") return \`comment[\${i}].anchor must be an object\`;
  for (const k of ["text", "contextBefore", "contextAfter"]) {
    if (typeof c.anchor[k] !== "string") return \`comment[\${i}].anchor.\${k} must be a string\`;
  }
  if (typeof c.body !== "string") return \`comment[\${i}].body must be a string\`;
  if (typeof c.author !== "string") return \`comment[\${i}].author must be a string\`;
  if (typeof c.createdAt !== "string") return \`comment[\${i}].createdAt must be a string\`;
  if (typeof c.resolved !== "boolean") return \`comment[\${i}].resolved must be a boolean\`;
  if (!Array.isArray(c.replies)) return \`comment[\${i}].replies must be an array\`;
  for (let j = 0; j < c.replies.length; j++) {
    const r = c.replies[j];
    if (!r || typeof r !== "object") return \`comment[\${i}].replies[\${j}] must be an object\`;
    if (typeof r.author !== "string") return \`comment[\${i}].replies[\${j}].author must be a string\`;
    if (typeof r.body !== "string") return \`comment[\${i}].replies[\${j}].body must be a string\`;
    if (typeof r.createdAt !== "string") return \`comment[\${i}].replies[\${j}].createdAt must be a string\`;
  }
  return null;
}

function readSidecar(p, opts) {
  const strict = !!(opts && opts.strict);
  if (!existsSync(p)) fail(\`sidecar not found: \${p}\`, 2);
  let raw;
  try { raw = readFileSync(p, "utf8"); }
  catch (e) { fail(\`read failed: \${p}: \${e.message}\`, 2); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { fail(\`invalid JSON in \${p}: \${e.message}\`, 2); }
  if (!data || data.version !== 1 || typeof data.file !== "string" || !Array.isArray(data.comments)) {
    fail(\`schema mismatch in \${p} (need version=1)\`, 2);
  }
  if (strict) {
    for (let i = 0; i < data.comments.length; i++) {
      const err = validateComment(data.comments[i], i);
      if (err) fail(\`schema mismatch in \${p}: \${err}\`, 2);
    }
  }
  return data;
}

function writeSidecar(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = \`\${p}.tmp.\${randomBytes(8).toString("hex")}\`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    try { unlinkSync(tmp); } catch (_) {}
    fail(\`write failed: \${p}: \${e.message}\`, 2);
  }
  try {
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch (_) {}
    fail(\`rename failed: \${p}: \${e.message}\`, 2);
  }
}

function nowZ() {
  // Strip sub-second precision so display formatters don't show ms.
  return new Date().toISOString().replace(/\\.\\d+Z$/, "Z");
}

function isActionable(c) {
  if (c.resolved) return false;
  const replies = c.replies || [];
  if (replies.length === 0) return true;
  return replies[replies.length - 1].author !== "ai";
}

function findSidecars(workspaceRoot, mdRel) {
  if (mdRel) {
    const sc = join(workspaceRoot, ".markdown-collab", \`\${mdRel}.json\`);
    return existsSync(sc) ? [sc] : [];
  }
  const root = join(workspaceRoot, ".markdown-collab");
  if (!existsSync(root)) return [];
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); }
    catch (e) {
      // A single unreadable subdir shouldn't blank the agent's worklist.
      // Surface the failure on stderr and keep walking siblings.
      process.stderr.write(\`mdc: skipping unreadable dir \${dir}: \${e.message}\\n\`);
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); }
      catch (err) {
        process.stderr.write(\`mdc: skipping unreadable entry \${p}: \${err.message}\\n\`);
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".md.json")) out.push(p);
    }
  }
  walk(root);
  return out;
}

if (cmd === "list") {
  const ws = flag("workspace", process.cwd());
  const md = flag("file");
  const sidecars = findSidecars(ws, md);
  const out = [];
  for (const sc of sidecars) {
    const data = readSidecar(sc);
    for (const c of data.comments) {
      if (!isActionable(c)) continue;
      out.push({
        sidecar: sc,
        file: data.file,
        id: c.id,
        anchor: c.anchor,
        body: c.body,
        author: c.author,
        createdAt: c.createdAt,
        replies: c.replies,
      });
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\\n");
  process.exit(0);
}

if (cmd === "reply") {
  const sc = pos[0];
  const id = pos[1];
  const body = flag("body");
  if (!sc || !id || body == null || body === true) fail("usage: reply <sidecar> <id> --body <text>");
  if (typeof body !== "string" || body.trim() === "") fail("--body cannot be empty", 4);
  const data = readSidecar(sc);
  const c = data.comments.find((x) => x.id === id);
  if (!c) fail(\`comment \${id} not found\`, 3);
  c.replies.push({ author: "ai", body, createdAt: nowZ() });
  writeSidecar(sc, data);
  process.stdout.write(\`ok: replied to \${id}\\n\`);
  process.exit(0);
}

if (cmd === "delete") {
  const sc = pos[0];
  const id = pos[1];
  if (!sc || !id) fail("usage: delete <sidecar> <id>");
  const data = readSidecar(sc);
  const before = data.comments.length;
  data.comments = data.comments.filter((c) => c.id !== id);
  if (data.comments.length === before) fail(\`comment \${id} not found\`, 3);
  writeSidecar(sc, data);
  process.stdout.write(\`ok: deleted \${id}\\n\`);
  process.exit(0);
}

if (cmd === "set-anchor") {
  const sc = pos[0];
  const id = pos[1];
  const text = flag("text");
  const before = flag("before", "");
  const after = flag("after", "");
  if (!sc || !id || text == null || text === true) fail("usage: set-anchor <sidecar> <id> --text <s> [--before <s>] [--after <s>]");
  if (typeof text !== "string") fail("--text must be a string", 4);
  if (text.replace(/\\s/g, "").length < 8) fail("anchor.text needs >= 8 non-whitespace chars", 4);
  const data = readSidecar(sc);
  const c = data.comments.find((x) => x.id === id);
  if (!c) fail(\`comment \${id} not found\`, 3);
  c.anchor = {
    text,
    contextBefore: typeof before === "string" ? before : "",
    contextAfter: typeof after === "string" ? after : "",
  };
  writeSidecar(sc, data);
  process.stdout.write(\`ok: anchor updated for \${id}\\n\`);
  process.exit(0);
}

if (cmd === "validate") {
  const sc = pos[0];
  if (!sc) fail("usage: validate <sidecar>");
  const data = readSidecar(sc, { strict: true });
  process.stdout.write(\`ok: version=\${data.version} comments=\${data.comments.length}\\n\`);
  process.exit(0);
}

fail("unknown command. supported: list | reply | delete | set-anchor | validate");
`;

export const TAIL_SCRIPT_CONTENT = `#!/usr/bin/env node
// Markdown Collab event-log tailer for Claude Code's Monitor tool.
//
// Why a Node tailer instead of \`tail -f\`?
//   When run as a background bash with stdout connected to a pipe (which is
//   how Claude Code captures it), \`tail -f\` switches to block-buffered mode
//   on most platforms — lines aren't visible to Monitor until ~4 KB
//   accumulates. We avoid that by writing through fs.writeSync(1, ...) so
//   every emitted line is flushed synchronously to fd 1; Node's regular
//   process.stdout.write is itself buffered on POSIX pipes and would have
//   the same problem.
//
// Acked-event suppression:
//   The VS Code extension writes a sibling \`.events.acked.jsonl\` whenever
//   every comment in a previously-emitted event has been addressed (last
//   reply is \`ai\`, or the comment was resolved/deleted). The tailer reads
//   that file on startup and watches it; any event whose id is already
//   acked is silently skipped on emit. This makes \`--from-start\` safe to
//   re-run without re-bothering Claude with already-addressed batches.
//
// Usage:
//   node mdc-tail.mjs [--workspace <ws>] [--from-start]
//
// Default: streams ONLY new lines (history is skipped, matching \`tail -n 0\`).
// Pass --from-start to replay all existing events first.

import { readFileSync, statSync, watch, openSync, readSync, closeSync, existsSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Synchronous, unbuffered write to stdout. process.stdout.write is async
// when stdout is a pipe on POSIX, so lines could sit in the buffer until
// the event loop ticks — bad for Monitor / TaskOutput which expects each
// notification to arrive as soon as the underlying append happens.
function emit(line) {
  writeSync(1, line);
}

function fail(msg, code = 1) {
  process.stderr.write(\`mdc-tail: \${msg}\\n\`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { workspace: null, fromStart: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") out.workspace = argv[++i];
    else if (a === "--from-start") out.fromStart = true;
  }
  return out;
}

function findWorkspace(start) {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, ".markdown-collab"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

const args = parseArgs(process.argv.slice(2));
const ws = args.workspace || process.env.MDC_WORKSPACE || findWorkspace(process.cwd());
if (!ws) fail("could not locate a workspace with a .markdown-collab/ directory; pass --workspace <path>");

const logPath = join(ws, ".markdown-collab", ".events.jsonl");
const ackedPath = join(ws, ".markdown-collab", ".events.acked.jsonl");

// Seek positions. When a file doesn't exist yet we start at 0 and wait for
// fs.watch to surface its creation.
let pos = 0;
try {
  const st = statSync(logPath);
  pos = args.fromStart ? 0 : st.size;
} catch {
  pos = 0;
}
let ackedPos = 0;
const ackedIds = new Set();

let leftover = "";
let ackedLeftover = "";

function loadAcked() {
  let st;
  try {
    st = statSync(ackedPath);
  } catch {
    return;
  }
  if (st.size < ackedPos) {
    ackedPos = 0;
    ackedLeftover = "";
    ackedIds.clear();
  }
  if (st.size === ackedPos) return;
  const fd = openSync(ackedPath, "r");
  try {
    const need = st.size - ackedPos;
    const buf = Buffer.alloc(need);
    let read = 0;
    while (read < need) {
      const n = readSync(fd, buf, read, need - read, ackedPos + read);
      if (n === 0) break;
      read += n;
    }
    ackedPos += read;
    ackedLeftover += buf.subarray(0, read).toString("utf8");
    let nl;
    while ((nl = ackedLeftover.indexOf("\\n")) >= 0) {
      const line = ackedLeftover.slice(0, nl);
      ackedLeftover = ackedLeftover.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.id === "string") ackedIds.add(obj.id);
      } catch { /* skip malformed */ }
    }
  } finally {
    closeSync(fd);
  }
}

function drain() {
  let st;
  try {
    st = statSync(logPath);
  } catch {
    return;
  }
  if (st.size < pos) {
    // File was truncated or rotated. Restart at 0.
    pos = 0;
    leftover = "";
  }
  if (st.size === pos) return;
  const fd = openSync(logPath, "r");
  try {
    const need = st.size - pos;
    const buf = Buffer.alloc(need);
    let read = 0;
    while (read < need) {
      const n = readSync(fd, buf, read, need - read, pos + read);
      if (n === 0) break;
      read += n;
    }
    pos += read;
    leftover += buf.subarray(0, read).toString("utf8");
    let nl;
    while ((nl = leftover.indexOf("\\n")) >= 0) {
      const line = leftover.slice(0, nl);
      leftover = leftover.slice(nl + 1);
      if (line.length === 0) continue;
      // Suppress emission when this event is already acked. Parse defensively;
      // a malformed line is forwarded as-is so debugging stays observable.
      let id = null;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.id === "string") id = obj.id;
      } catch { /* fall through */ }
      if (id && ackedIds.has(id)) continue;
      emit(line + "\\n");
    }
  } finally {
    closeSync(fd);
  }
}

loadAcked();
drain();

// Watch both files. fs.watch may fire 'rename' on some platforms when a
// file is replaced; in that case we re-arm by polling.
function armWatch(target, onChange) {
  let watcher = null;
  function arm() {
    try {
      watcher = watch(target, { persistent: true }, () => onChange());
      watcher.on("error", () => {
        if (watcher) watcher.close();
        setTimeout(arm, 250);
      });
    } catch {
      setTimeout(arm, 250);
    }
  }
  arm();
}
armWatch(logPath, drain);
armWatch(ackedPath, () => {
  loadAcked();
  // After acks update, no need to re-emit anything from the main log —
  // an ack arrives AFTER the corresponding event was emitted (if at all).
});

// Belt-and-suspenders polling — handles editors / FS layers that drop
// inotify events. Cheap; runs every 500ms.
setInterval(() => { loadAcked(); drain(); }, 500).unref?.();

// Keep the process alive forever.
process.stdin.resume();
`;

export const CHANNEL_SCRIPT_CONTENT = `#!/usr/bin/env node
// Markdown Collab — Claude Code MCP channel server (research preview).
//
// Spawned by Claude Code over stdio when the user runs:
//   claude --dangerously-load-development-channels server:markdown-collab
// after registering this script in .mcp.json or ~/.claude.json:
//   "markdown-collab": { "command": "node", "args": ["<this script>"] }
//
// What it does:
// - Implements the minimum MCP handshake to declare the experimental
//   "claude/channel" capability. (Hand-rolled JSON-RPC; no SDK dep.)
// - Opens a localhost HTTP listener on a random port and writes the port
//   plus a per-session bearer token to <workspace>/.markdown-collab/.channel.json.
// - On POST /push, forwards the body to Claude as a notifications/claude/channel
//   event so it arrives in Claude's next turn as a <channel source="markdown-collab" ...>
//   tag.
//
// Reference: https://code.claude.com/docs/en/channels-reference

import { createServer } from "node:http";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

function findWorkspace(start) {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, ".markdown-collab"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

let workspace = process.env.MDC_WORKSPACE || null;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--workspace") workspace = process.argv[i + 1];
}
workspace = workspace || findWorkspace(process.cwd()) || process.cwd();

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

let nextId = 1;
let buffer = "";
let initialized = false;

function send(message) {
  // writeSync to fd 1 — process.stdout.write is async on POSIX pipes and
  // Claude Code is on the other end of this pipe expecting line-delimited
  // JSON-RPC. Buffering would stall the handshake and notifications.
  writeSync(1, JSON.stringify(message) + "\\n");
}

function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
      capabilities: {
        experimental: { "claude/channel": {} },
      },
      serverInfo: { name: "markdown-collab", version: "0.13.0" },
      instructions:
        "Markdown Collab review batches arrive as <channel source=markdown-collab file=... count=N id=evt_...>. " +
        "The body is JSON: { prompt, file, unresolvedCount, comments }. " +
        "Address each unresolved comment per the vs-markdown-collab skill, then mark the event addressed " +
        "by writing an ack line to <workspace>/.markdown-collab/.events.acked.jsonl using the event id from the tag.",
    });
    return;
  }
  if (msg.method === "initialized" || msg.method === "notifications/initialized") {
    initialized = true;
    return;
  }
  if (msg.method === "shutdown") {
    reply(msg.id, {});
    cleanup();
    process.exit(0);
  }
  // Unknown methods: respond with method-not-found if it's a request.
  if (typeof msg.id !== "undefined") {
    replyError(msg.id, -32601, "method not found: " + msg.method);
  }
}

// ---------------------------------------------------------------------------
// Localhost HTTP receiver — extension POSTs button-click payloads here
// ---------------------------------------------------------------------------

const token = randomBytes(32).toString("hex");
const channelDir = join(workspace, ".markdown-collab");
const channelFile = join(channelDir, ".channel.json");

const server = createServer((req, res) => {
  const remote = req.socket.remoteAddress ?? "";
  if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
    res.statusCode = 403; res.end(); return;
  }
  if (req.headers.authorization !== \`Bearer \${token}\`) {
    res.statusCode = 401; res.end(); return;
  }
  if (req.method !== "POST" || req.url !== "/push") {
    res.statusCode = 404; res.end(); return;
  }
  const chunks = [];
  let total = 0;
  req.on("data", (c) => {
    total += c.length;
    if (total > 256 * 1024) { res.statusCode = 413; res.end(); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.statusCode = 400; res.end("bad json"); return; }
    if (!initialized) { res.statusCode = 503; res.end("not initialized"); return; }
    sendNotification("notifications/claude/channel", {
      content: JSON.stringify(payload, null, 2),
      meta: {
        file: String(payload.file ?? ""),
        count: String(payload.unresolvedCount ?? 0),
        id: String(payload.id ?? ""),
      },
    });
    res.statusCode = 200; res.end("ok");
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(
    channelFile,
    JSON.stringify({ port, token, pid: process.pid }, null, 2),
    { mode: 0o600 },
  );
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  try { unlinkSync(channelFile); } catch {}
  try { server.close(); } catch {}
}
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
`;

export const SKILL_CONTENT = `---
name: vs-markdown-collab
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace (a workspace containing a .markdown-collab/ folder). TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document. Trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md".
---

# Markdown Collab — agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. Each \`.md\` file's comments live in a sibling sidecar JSON under \`.markdown-collab/\`. The user runs the IDE; you do the writing.

**Always drive the workflow through the bundled CLI helper at \`~/.claude/skills/vs-markdown-collab/mdc.mjs\`.** The CLI filters out resolved comments and AI-replied threads at the source so your context window only ever sees the actionable subset, and applies mutations atomically with the right schema. Hand-editing the JSON is allowed only as a last resort and must preserve the schema (\`version: 1\`, \`comments: []\`, \`anchor.text\` ≥ 8 non-whitespace chars).

## Sidecar layout (reference)

For a file at \`<workspaceRoot>/<rel>/<name>.md\`:
- Sidecar path: \`<workspaceRoot>/.markdown-collab/<rel>/<name>.md.json\`
- Schema: \`{ "version": 1, "file": "<rel>/<name>.md", "comments": Comment[] }\`
- \`Comment\`: \`{ "id", "anchor": { "text", "contextBefore", "contextAfter" }, "body", "author", "createdAt", "resolved", "replies": Reply[] }\`
- \`Reply\`: \`{ "author", "body", "createdAt" }\`

Anchors are resolved against the \`.md\` text by exact match → context match → whitespace-normalized match. \`anchor.text\` must contain at least **8 non-whitespace characters** to remain valid.

## CLI helper

\`mdc.mjs\` is a Node script with no external dependencies. Invoke with:

\`\`\`
node ~/.claude/skills/vs-markdown-collab/mdc.mjs <subcommand> [...args]
\`\`\`

Subcommands:

- \`list [--workspace <ws>] [--file <rel-md>]\` — print JSON of **actionable** comments only (unresolved AND last reply not from \`"ai"\`). Default workspace is \`pwd\`. Use \`--file\` to scope to one .md path (relative to workspace root). Each entry has \`{sidecar, file, id, anchor, body, author, createdAt, replies}\` so you have everything you need without reading the whole file.
- \`reply <sidecar> <commentId> --body "<text>"\` — append a reply with \`author: "ai"\` and a current UTC timestamp. The CLI handles the \`Z\` suffix correctly; do not pre-compute a timestamp.
- \`set-anchor <sidecar> <commentId> --text "<s>" [--before "<s>"] [--after "<s>"]\` — overwrite the anchor (used only when you rewrote the anchored passage in place; see Phase 4).
- \`delete <sidecar> <commentId>\` — remove the comment (and its replies) from the sidecar entirely. **Only when the human has explicitly asked you to delete.** See "Deletion" below.
- \`validate <sidecar>\` — light sanity check (parses, version=1, returns count).

The CLI writes atomically (temp file + rename) and validates the schema before committing.

## When this skill applies

Invoke when:
- The user names one or more \`.md\` files and asks you to act on review comments / feedback / notes.
- The user says "address the markdown collab comments" without naming files (operate workspace-wide).
- The user references a specific comment thread or quote and asks you to apply / respond.
- The user asks you to "watch for review batches" or to wait for the VS Code "Send to Claude" button (use the channel watch loop or MCP channel mode below).

## Anchor maintenance applies on EVERY \`.md\` edit, not just comment-driven ones

Whenever you modify a \`.md\` file in a workspace that has a \`.markdown-collab/\` directory — for any reason, not only when addressing review comments — you MUST also reconcile the file's sidecar after the edit. Reword a sentence the user pointed at in chat, refactor a section heading, fix a typo: any of these can break an existing comment's anchor.

Procedure after editing any \`.md\` file in such a workspace:

1. Compute the sidecar path: \`<workspace-root>/.markdown-collab/<rel-path-to-md>.json\`. If it does not exist, you are done — there are no anchors to maintain.
2. Run \`mdc.mjs validate <sidecar>\` to surface any anchor whose stored \`text\` no longer occurs (or no longer occurs uniquely) in the new \`.md\` content.
3. For each anchor flagged as broken or ambiguous:
   - If the passage was **rewritten** — the same idea is still there in different words — update the anchor SURGICALLY with the **Edit** tool. **Do NOT use \`mdc.mjs set-anchor\` and do NOT rewrite the whole sidecar JSON.** Locate the offending comment's \`"anchor": { ... }\` object inside the sidecar file by its \`"id"\` and replace ONLY the three string fields (\`text\`, \`contextBefore\`, \`contextAfter\`). Concretely: read the sidecar with the Read tool, find the unique \`"text": "<old anchor text>"\` line plus its sibling \`contextBefore\` / \`contextAfter\` lines, then issue separate Edit calls — one per field — with old\\_string set to the literal current line and new\\_string to the new value. Preserve indentation, quoting, trailing commas, and the surrounding JSON structure exactly.
   - The new \`text\` must be a verbatim substring of the new \`.md\` content, ≥ 8 non-whitespace chars, and must occur exactly once after applying. Verify with a grep before committing the Edit.
   - If the passage was **deleted** — the comment's target is gone — leave the anchor untouched. The comment will surface as an orphan in the editor; the human resolves or deletes it.
   - If you are uncertain whether the passage was rewritten or deleted, leave the anchor untouched. Re-anchoring to nearby unrelated text creates a misleading link to content the comment was never about.
4. Do NOT change \`comment.body\`, \`comment.replies\`, \`comment.resolved\`, or any other field while doing this maintenance pass — only the three \`anchor.*\` strings of comments whose target was rewritten, and only via the Edit tool. The full-rewrite path (\`mdc.mjs set-anchor\`) is a churn-prone fallback only — it touches the whole file and races with concurrent writers (the webview, the standard editor) that may also be holding the sidecar open.

This applies in addition to the comment-driven workflow below; do not skip it just because no review batch was active.

## MCP channel mode (preferred when supported)

Claude Code v2.1.80+ supports first-party MCP channels: events arrive natively as \`<channel source="markdown-collab" file="..." count="N" id="evt_…">\` tags in your context with no streaming-tool dependency.

**Setup (one-time):**

1. Run the **Markdown Collab: Install Claude Skill** command in VS Code. This drops \`mdc-channel.mjs\` into \`~/.claude/skills/vs-markdown-collab/\`.
2. Add the server to \`~/.claude.json\` (user-level) or the workspace's \`.mcp.json\` (project-level):
   \`\`\`json
   {
     "mcpServers": {
       "markdown-collab": {
         "command": "node",
         "args": ["~/.claude/skills/vs-markdown-collab/mdc-channel.mjs"]
       }
     }
   }
   \`\`\`
3. Start Claude with the development flag (channels are still research preview):
   \`\`\`
   claude --dangerously-load-development-channels server:markdown-collab
   \`\`\`
4. Set \`markdownCollab.sendMode\` to \`mcp-channel\` in VS Code, or pick it from the quick-pick.

**Runtime:**
The button click POSTs to the running channel server, which fires \`notifications/claude/channel\`. The body of the \`<channel>\` tag is the same JSON payload \`{prompt, file, unresolvedCount, comments}\`. Address each comment per Phases 1–6, then append \`{"id": "<id-from-tag>"}\` to \`<workspace>/.markdown-collab/.events.acked.jsonl\` so the extension knows the batch is done.

**Caveats:** channels require claude.ai login (no API keys / Console), and the protocol is research preview — Anthropic warns it may change. If channels aren't supported in your harness or version, fall back to one of the modes below.

## Channel watch loop (button-driven)

The VS Code extension exposes a "Send to Claude" button on each Markdown preview's comments sidebar. When configured for channel mode it appends one JSON line per click to \`<workspace>/.markdown-collab/.events.jsonl\`. To watch for the next click:

1. **Start the tailer in background** using the Bash tool with \`run_in_background: true\`:
   \`\`\`
   node ~/.claude/skills/vs-markdown-collab/mdc-tail.mjs --workspace <workspace>
   \`\`\`
   Use the absolute workspace path. Do NOT use \`tail -f\` directly — when its stdout is a pipe (which it is for background bash), most platforms switch \`tail\` to block-buffered output and Monitor sees nothing until ~4 KB accumulates. \`mdc-tail.mjs\` flushes per line.

2. **Subscribe to the bash's stdout stream.** Look for a tool whose contract is "each stdout line of a long-running process surfaces as a model notification" — typically \`Monitor\` or \`BashOutput\`. NOT \`TaskOutput\`: \`TaskOutput\` waits for the task to *complete*, and \`mdc-tail.mjs\` runs forever by design.

   **If neither \`Monitor\` nor \`BashOutput\` is in your tool list**, the channel transport cannot run reactively in this harness. Options:
   - Stop the tailer (kill the background bash) and tell the user to switch the VS Code setting \`markdownCollab.sendMode\` to \`terminal\` — that mode bracketed-pastes each click directly into your REPL, no watch loop required.
   - Or fall back to polling: call \`TaskOutput block=false\` on the bash periodically, diff against the last-seen offset of stdout, process any new JSON lines. Functional but consumes one iteration per poll.
   - Or skip the tailer entirely and \`Read\` \`.markdown-collab/.events.jsonl\` directly each turn, tracking the highest line you've already addressed.

3. **Per notification**, parse the JSON line as \`{prompt, file, unresolvedCount, comments, ts}\`. Address the batch on \`<workspace>/<file>\` per Phases 1–6 above, then return to the Monitor stream for the next event.

4. **Stopping**: the user ends the session, or you exit the watch when they say "stop watching." Kill the background tailer process when done.

Skip / abort if:
- No \`.markdown-collab/\` directory exists in the workspace — there is nothing to act on. Tell the user.
- The user is asking for a general edit unrelated to review comments.

## Workflow

### Phase 1 — Discover

1. Confirm the workspace has \`.markdown-collab/\` (check via \`ls\` or by running the CLI; an empty list means nothing to do).
2. Run \`mdc.mjs list\` (with \`--file <path>\` if the user scoped to a particular doc). The output is the only context you need — do NOT read raw sidecars unless \`list\` returns something inconsistent.

### Phase 2 — Plan

Group the actionable entries by \`file\`. For each file, sort the entries by anchor location (top of file first) so later edits don't invalidate earlier offsets. For each entry, write down:
- The user's intent (from \`body\` and the trailing human reply, if any).
- The concrete edit you will apply (rewrite / append / delete).
- Whether the anchored passage will be rewritten in place (anchor will be updated) or removed (anchor will orphan).

If two entries target overlapping or adjacent passages, decide an order that preserves both intents. Prefer combining edits in a single rewrite over sequential conflicting edits.

### Phase 3 — Edit & sync

For each entry, in order:

1. **Edit the \`.md\` file first.** This invariant is critical — if interrupted between writes, a stale sidecar pointing at old text is recoverable; a fresh sidecar pointing at vanished text is not.

2. **Update the anchor** ONLY when you rewrote the anchored passage in place. If you DELETED the anchored passage (the comment said "remove this", "drop this section", "cut", etc.), leave the anchor untouched — the comment will correctly surface as an orphan in the UI, and the human can then resolve or delete it. Never re-anchor a deleted comment to neighbouring text; that produces a misleading link to content the comment was never about.

   When you DID rewrite the passage: update the anchor SURGICALLY using the **Edit** tool — not \`mdc.mjs set-anchor\`, which rewrites the entire sidecar file and races with concurrent writers (the webview, the standard editor's CommentController). Steps:
   1. Read the sidecar JSON.
   2. Locate the comment by its \`"id"\`.
   3. Issue a separate Edit call for each of the three anchor strings (\`text\`, \`contextBefore\`, \`contextAfter\`) — \`old_string\` = the literal current line (including indentation, quoting, and trailing comma), \`new_string\` = the same shape with the new value.
   4. Preserve the surrounding JSON structure exactly. Do not reformat, re-key, or change ordering.

   Constraints on the new anchor:
   - \`text\` must be a verbatim substring of the new passage, ≥ 8 non-whitespace chars.
   - \`text\` must occur exactly once in the new file (use grep to verify before committing the Edit).
   - \`text\` must quote the new wording of the same idea, not an unrelated nearby sentence.

   If you cannot honestly say the new anchor points to a rewritten version of the same idea, leave the anchor untouched and let the comment orphan.

   The CLI fallback \`mdc.mjs set-anchor\` is permitted only when the Edit-based approach is blocked (e.g. a one-shot batch script with no Edit tool available). Default to Edit.

3. **Append your reply:**
   \`\`\`
   node ~/.claude/skills/vs-markdown-collab/mdc.mjs reply <sidecar> <id> \\
     --body "<one or two sentences quoting the new wording, naming the section, etc.>"
   \`\`\`
   Be specific. Don't say "done" with no detail.

4. **For comments you cannot fully address** (ambiguous request, missing information, conflicting with another comment), still reply via the CLI with what you tried and what you need from the human. Do not pretend it's done.

### Phase 4 — Deletion (opt-in)

You only delete a thread when the human's body or trailing reply unambiguously asks for it:
- "delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"

When deleting:
\`\`\`
node ~/.claude/skills/vs-markdown-collab/mdc.mjs delete <sidecar> <id>
\`\`\`

Do not delete to "clean up" resolved threads, do not delete after you addressed a comment (the human resolves), and do not delete because the anchor orphaned.

### Phase 5 — Invariants

You MUST NOT:
- Change \`comment.resolved\`. Only the human resolves comments.
- Delete a comment that the human has not explicitly asked to delete (Phase 4).
- Modify \`anchor\` for comments whose target text was unchanged or deleted (only rewrites trigger anchor updates — see Phase 3 step 2).
- Re-anchor a comment to nearby unrelated text after a deletion. Let it orphan.
- Touch \`comment.id\`, \`comment.author\`, \`comment.createdAt\`, or any reply's existing fields.
- Bump \`sidecar.version\`.
- Edit a sidecar whose \`.md\` file you have not just modified (no speculative anchor "cleanups").

### Phase 6 — Verify

Before reporting done:
- Run \`mdc.mjs list\` again. Confirm the entries you addressed are gone from the actionable list (because your reply was the last and now \`author === "ai"\`).
- For any anchor you updated, grep the \`.md\` file to confirm \`anchor.text\` plus its surrounding context occurs exactly once.
- For any comment you deleted, run \`mdc.mjs validate <sidecar>\` and confirm the count decreased by one.

If any check fails, fix it before reporting.

## Reporting

Tell the user, per file:
- Comments addressed (id + one-line summary of each change).
- Comments deleted on explicit request (id).
- Comments left as orphans because their anchor target was removed (id + why).
- Comments answered without a code change (id + the question / clarification you replied with).
- Anything you skipped and why.

Use the comment id (\`c_xxxxxxxx\`) so they can find each thread in VS Code.

## Anti-patterns

- Don't read whole sidecars when \`mdc.mjs list\` will give you exactly the actionable subset.
- Don't write the sidecar before the \`.md\`.
- Don't hand-edit JSON when a CLI subcommand exists for the same operation.
- Don't reply with vague "applied" — say what you applied.
- Don't fabricate that you handled a comment you couldn't actually address.
- Don't update an anchor unless you actually rewrote its target.
- Don't re-anchor a deleted passage to nearby unrelated text. Deletions become orphans by design.
- Don't delete a thread the human didn't explicitly tell you to delete.
- Don't operate on a workspace without a \`.markdown-collab/\` directory — surface this rather than create one.
`;

export async function installClaudeSkill(
  homeDir: string,
  options?: { force?: boolean },
): Promise<{ action: "installed" | "already-present" | "exists-differs"; path: string }> {
  const target = path.join(homeDir, SKILL_REL_PATH);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }

  // The CLI helper is auto-generated and silently kept in sync — never a
  // user-edited file, so we always overwrite it (when content differs).
  // Don't gate this on the SKILL.md path so a user with a customized SKILL.md
  // can still pick up CLI fixes.
  await syncCliScript(homeDir);

  if (existing !== null) {
    if (existing === SKILL_CONTENT) {
      return { action: "already-present", path: target };
    }
    if (!options?.force) {
      return { action: "exists-differs", path: target };
    }
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, SKILL_CONTENT, "utf8");
  return { action: "installed", path: target };
}

async function syncCliScript(homeDir: string): Promise<void> {
  await syncScript(path.join(homeDir, CLI_SCRIPT_REL), CLI_SCRIPT_CONTENT);
  await syncScript(path.join(homeDir, TAIL_SCRIPT_REL), TAIL_SCRIPT_CONTENT);
  await syncScript(path.join(homeDir, CHANNEL_SCRIPT_REL), CHANNEL_SCRIPT_CONTENT);
}

async function syncScript(target: string, content: string): Promise<void> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }
  if (existing === content) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  try {
    await fs.chmod(target, 0o755);
  } catch {
    /* Windows / restricted FS — irrelevant, we invoke via `node` */
  }
}
