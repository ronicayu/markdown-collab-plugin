import * as fs from "fs/promises";
import * as path from "path";

export const SKILL_REL_PATH = ".claude/skills/vs-markdown-collab/SKILL.md";
export const SIDECAR_REF_REL = ".claude/skills/vs-markdown-collab/SIDECAR.md";
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
//   node mdc.mjs add --workspace <ws> --file <rel-md> --text <anchor> [--before <s>] [--after <s>] --body <text> [--author <name>]
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

if (cmd === "add") {
  const ws = flag("workspace", process.cwd());
  const rel = flag("file");
  const text = flag("text");
  const before = flag("before", "");
  const after = flag("after", "");
  const body = flag("body");
  const author = flag("author", "claude");
  if (rel == null || rel === true) fail("usage: add --workspace <ws> --file <rel-md> --text <s> [--before <s>] [--after <s>] --body <s> [--author <s>]");
  if (typeof rel !== "string" || rel === "") fail("--file must be a non-empty string", 4);
  if (text == null || text === true || typeof text !== "string") fail("--text must be a string", 4);
  if (text.replace(/\\s/g, "").length < 8) fail("anchor.text needs >= 8 non-whitespace chars", 4);
  if (body == null || body === true || typeof body !== "string" || body.trim() === "") fail("--body cannot be empty", 4);
  if (typeof author !== "string" || author === "") fail("--author must be a non-empty string", 4);
  const sidecarPath = join(ws, ".markdown-collab", \`\${rel}.json\`);
  let data;
  if (existsSync(sidecarPath)) {
    data = readSidecar(sidecarPath);
    if (data.file !== rel) fail(\`sidecar.file (\${data.file}) does not match --file (\${rel})\`, 4);
  } else {
    data = { version: 1, file: rel, comments: [] };
  }
  let id;
  for (let attempt = 0; attempt < 16; attempt++) {
    id = "c_" + randomBytes(4).toString("hex");
    if (!data.comments.find((c) => c.id === id)) break;
    id = null;
  }
  if (!id) fail("failed to generate a unique comment id", 5);
  const newComment = {
    id,
    anchor: {
      text,
      contextBefore: typeof before === "string" ? before : "",
      contextAfter: typeof after === "string" ? after : "",
    },
    body,
    author,
    createdAt: nowZ(),
    resolved: false,
    replies: [],
  };
  data.comments.push(newComment);
  writeSidecar(sidecarPath, data);
  process.stdout.write(\`ok: added \${id} to \${sidecarPath}\\n\`);
  process.exit(0);
}

if (cmd === "validate") {
  const sc = pos[0];
  if (!sc) fail("usage: validate <sidecar>");
  const data = readSidecar(sc, { strict: true });
  process.stdout.write(\`ok: version=\${data.version} comments=\${data.comments.length}\\n\`);
  process.exit(0);
}

fail("unknown command. supported: list | reply | add | delete | set-anchor | validate");
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

export const SIDECAR_CONTENT = `# Markdown Collab — sidecar-mode reference (legacy)

This file is the on-demand reference for the **legacy sidecar storage format**. SKILL.md only loads inline-mode instructions by default; load this file when the target \`.md\` does NOT contain \`<!--mc:threads:begin-->\` but a sidecar exists at \`<workspaceRoot>/.markdown-collab/<rel>.md.json\`.

Inline mode is the v0.27+ format of record. Do NOT create a fresh sidecar to host a brand-new thread — for a file that has neither inline markers nor a sidecar, fall back to inline-mode initiation per SKILL.md.

## Sidecar format

For a file at \`<workspaceRoot>/<rel>/<name>.md\`:
- Sidecar path: \`<workspaceRoot>/.markdown-collab/<rel>/<name>.md.json\`
- Schema: \`{ "version": 1, "file": "<rel>/<name>.md", "comments": Comment[] }\`
- \`Comment\`: \`{ "id", "anchor": { "text", "contextBefore", "contextAfter" }, "body", "author", "createdAt", "resolved", "replies": Reply[] }\`
- \`Reply\`: \`{ "author", "body", "createdAt" }\`

Anchors are resolved against the \`.md\` text by exact match → context match → whitespace-normalized match. \`anchor.text\` must contain at least **8 non-whitespace characters** to remain valid.

## CLI helper — \`mdc.mjs\`

Always drive sidecar-mode work through the bundled CLI at \`~/.claude/skills/vs-markdown-collab/mdc.mjs\`. The CLI filters resolved comments and AI-replied threads at the source so your context only sees the actionable subset, and applies mutations atomically with the right schema. Hand-editing the JSON is a last resort and must preserve the schema.

\`\`\`
node ~/.claude/skills/vs-markdown-collab/mdc.mjs <subcommand> [...args]
\`\`\`

Subcommands:

- \`list [--workspace <ws>] [--file <rel-md>]\` — print JSON of **actionable** comments only (unresolved AND last reply not from \`"ai"\`). Default workspace is \`pwd\`. Use \`--file\` to scope to one .md path (relative to workspace root). Each entry has \`{sidecar, file, id, anchor, body, author, createdAt, replies}\` so you have everything you need without reading the whole file.
- \`reply <sidecar> <commentId> --body "<text>"\` — append a reply with \`author: "ai"\` and a current UTC timestamp. The CLI handles the \`Z\` suffix correctly; do not pre-compute a timestamp.
- \`add --workspace <ws> --file <rel-md> --text "<anchor>" [--before "<s>"] [--after "<s>"] --body "<text>" [--author "<name>"]\` — create a brand-new comment thread. Generates a unique \`c_<8 hex>\` id, defaults \`author\` to \`"claude"\`, creates the sidecar with \`version: 1\` if it doesn't exist yet. **Only when the human has explicitly asked.** See Phase 5 below.
- \`set-anchor <sidecar> <commentId> --text "<s>" [--before "<s>"] [--after "<s>"]\` — overwrite the anchor (used only when you rewrote the anchored passage in place; see Phase 3).
- \`delete <sidecar> <commentId>\` — remove the comment (and its replies) from the sidecar entirely. **Only when the human has explicitly asked.** See Phase 4.
- \`validate <sidecar>\` — light sanity check (parses, version=1, returns count).

The CLI writes atomically (temp file + rename) and validates the schema before committing.

## Sidecar phases

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

   The CLI fallback \`mdc.mjs set-anchor\` is a churn-prone fallback only — it touches the whole file and races with concurrent writers (the webview, the standard editor) that may also be holding the sidecar open. Use it only when the Edit-based approach is blocked (e.g. a one-shot batch script with no Edit tool available). Default to Edit.

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

### Phase 5 — Initiate a new thread (opt-in)

You only **create** a new review thread when the human explicitly asks you to ("leave a comment on X", "add a review note about Y", "flag this section for follow-up", "drop a TODO comment here"). Never spontaneously seed threads while addressing existing ones or while doing maintenance edits.

**Use this sidecar path ONLY when the file already has a sidecar.** On a file with no sidecar AND no inline markers, fall back to inline-mode initiation per SKILL.md. Don't create a fresh sidecar to host a brand-new thread — inline is the v0.27+ format of record.

When asked to add a thread to a file that already has a sidecar:

1. **Pick the anchor.** It must be a verbatim substring of the current \`.md\` text, ≥ 8 non-whitespace chars, and occur exactly once in the file. Grep to confirm uniqueness before committing.
2. **Compute optional context.** \`--before\` = up to ~40 chars immediately preceding the anchor (helpful for disambiguation if the anchor's uniqueness is borderline). \`--after\` = up to ~40 chars immediately following. Pass empty strings when uniqueness is already strong.
3. **Run the CLI:**
   \`\`\`
   node ~/.claude/skills/vs-markdown-collab/mdc.mjs add \\
     --workspace <abs-workspace> \\
     --file <rel-md-path> \\
     --text "<anchor text>" \\
     [--before "<≤40 chars before>"] \\
     [--after "<≤40 chars after>"] \\
     --body "<your note, markdown OK>" \\
     [--author "<name, defaults to claude>"]
   \`\`\`
   The CLI generates a unique \`c_<8 hex>\` id, sets \`resolved: false\`, sets \`createdAt\` to current UTC, and creates the sidecar with \`version: 1\` if it didn't exist yet. It refuses an anchor with < 8 non-whitespace chars and refuses an empty body.
4. **Do NOT also edit the \`.md\` file** when initiating a thread — sidecar-mode anchors are stored separately and the \`.md\` text is not modified by thread creation. (Contrast with inline mode, where wrapping markers is required.)
5. **Verify** by running \`mdc.mjs validate <sidecar>\`, then \`mdc.mjs list --file <rel>\` and confirming the new id appears.

If you need to add multiple threads in one turn, run \`add\` once per thread. The CLI is atomic per call.

### Phase 6 — Invariants

You MUST NOT:
- Change \`comment.resolved\`. Only the human resolves comments.
- Delete a comment that the human has not explicitly asked to delete (Phase 4).
- Modify \`anchor\` for comments whose target text was unchanged or deleted (only rewrites trigger anchor updates — see Phase 3 step 2).
- Re-anchor a comment to nearby unrelated text after a deletion. Let it orphan.
- Touch \`comment.id\`, \`comment.author\`, \`comment.createdAt\`, or any reply's existing fields.
- Bump \`sidecar.version\`.
- Edit a sidecar whose \`.md\` file you have not just modified (no speculative anchor "cleanups").
- Initiate a new thread (Phase 5) unless the human explicitly asked.

### Phase 7 — Verify

Before reporting done:
- Run \`mdc.mjs list\` again. Confirm the entries you addressed are gone from the actionable list (because your reply was the last and now \`author === "ai"\`).
- For any anchor you updated, grep the \`.md\` file to confirm \`anchor.text\` plus its surrounding context occurs exactly once.
- For any comment you deleted, run \`mdc.mjs validate <sidecar>\` and confirm the count decreased by one.
- For any thread you initiated (opt-in): \`mdc.mjs list --file <rel>\` shows the new id, the sidecar passes \`validate\`, and \`anchor.text\` (plus context) resolves to exactly one location in the \`.md\`.

If any check fails, fix it before reporting.

## Anchor maintenance applies on EVERY \`.md\` edit, not just comment-driven ones

Whenever you modify a \`.md\` file in a sidecar-mode workspace — for any reason, not only when addressing review comments — you MUST also reconcile that file's sidecar after the edit. Rewording a sentence, refactoring a heading, fixing a typo: any of these can break an existing anchor.

1. Compute the sidecar path: \`<workspace-root>/.markdown-collab/<rel-path-to-md>.json\`. If it does not exist, you are done — there are no anchors to maintain.
2. Run \`mdc.mjs validate <sidecar>\` to surface any anchor whose stored \`text\` no longer occurs (or no longer occurs uniquely) in the new \`.md\` content.
3. For each anchor flagged as broken or ambiguous:
   - If the passage was **rewritten** — the same idea is still there in different words — update the anchor SURGICALLY with the **Edit** tool. **Do NOT use \`mdc.mjs set-anchor\` and do NOT rewrite the whole sidecar JSON.** Locate the offending comment's \`"anchor": { ... }\` object inside the sidecar file by its \`"id"\` and replace ONLY the three string fields (\`text\`, \`contextBefore\`, \`contextAfter\`). Read the sidecar with the Read tool, find the unique \`"text": "<old anchor text>"\` line plus its sibling \`contextBefore\` / \`contextAfter\` lines, then issue separate Edit calls — one per field — with old\\_string set to the literal current line and new\\_string to the new value. Preserve indentation, quoting, trailing commas, and the surrounding JSON structure exactly.
   - The new \`text\` must be a verbatim substring of the new \`.md\` content, ≥ 8 non-whitespace chars, and must occur exactly once after applying. Verify with a grep before committing the Edit.
   - If the passage was **deleted** — the comment's target is gone — leave the anchor untouched. The comment will surface as an orphan in the editor; the human resolves or deletes it.
   - If you are uncertain whether the passage was rewritten or deleted, leave the anchor untouched. Re-anchoring to nearby unrelated text creates a misleading link to content the comment was never about.
4. Do NOT change \`comment.body\`, \`comment.replies\`, \`comment.resolved\`, or any other field while doing this maintenance pass — only the three \`anchor.*\` strings of comments whose target was rewritten, and only via the Edit tool.

## Anti-patterns (sidecar)

- Don't read whole sidecars when \`mdc.mjs list\` will give you exactly the actionable subset.
- Don't write the sidecar before the \`.md\`.
- Don't hand-edit JSON when a CLI subcommand exists for the same operation.
- Don't update an anchor unless you actually rewrote its target.
- Don't initiate a new thread unless the human explicitly asked.
- Don't create a sidecar from scratch — inline is the v0.27+ format of record. Fall back to inline-mode initiation in SKILL.md.
`;

export const SKILL_CONTENT = `---
name: vs-markdown-collab
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace. Comments are stored INLINE in the .md file itself (default in v0.27+, look for \`<!--mc:threads:begin-->\`); a legacy sidecar format (\`.markdown-collab/<rel>.md.json\`) is documented separately in SIDECAR.md, loaded on demand. TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document. Trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md".
---

# Markdown Collab — agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. The user runs the IDE; you do the writing.

## Two storage formats — detect first, act second

Markdown Collab supports two coexisting on-disk formats. Detect which one applies **per file** before acting.

### Inline format (default in v0.27+)

Threads live inside the \`.md\` file itself.

- Anchored spans are wrapped in paired HTML comments:
  \`<!--mc:a:ID-->anchored text<!--mc:/a:ID-->\` (ID = 1–12 char base36).
- A single block at the end of the file holds one \`<!--mc:t {JSON}-->\` line per thread, fenced by \`<!--mc:threads:begin-->\` and \`<!--mc:threads:end-->\`.
- Each thread JSON:
  \`{"id":"<ID>","quote":"<original anchor text>","status":"open"|"resolved","comments":[Comment, …]}\`.
- Each \`Comment\`:
  \`{"id":"c<N>","parent"?:"c<N>","author":"<name>","ts":"<ISO-8601 UTC>","body":"<markdown>","editedTs"?:"<ISO-8601 UTC>","deleted"?:true}\`.

**Detection:** the \`.md\` file contains the literal string \`<!--mc:threads:begin-->\`. If yes → inline mode. Skip the sidecar pipeline for this file even if a sidecar happens to coexist.

### Sidecar format (legacy)

Each \`.md\` file's comments live in a sibling sidecar JSON under \`<workspaceRoot>/.markdown-collab/<rel>.md.json\`.

- Schema: \`{ "version": 1, "file": "<rel>/<name>.md", "comments": Comment[] }\`.
- \`Comment\`: \`{ "id", "anchor": { "text", "contextBefore", "contextAfter" }, "body", "author", "createdAt", "resolved", "replies": Reply[] }\`.
- \`Reply\`: \`{ "author", "body", "createdAt" }\`.

**Detection:** the \`.md\` file does NOT contain \`<!--mc:threads:begin-->\`, but \`<workspaceRoot>/.markdown-collab/<rel>.md.json\` exists.

If neither marker nor sidecar exists for a named file:
- If the user is asking you to **address** comments, there are none — tell the user and stop.
- If the user is asking you to **initiate** a thread (opt-in, see Phase 5), default to **inline mode**. Inline is the format of record in v0.27+; sidecar is the legacy path retained only for workspaces with existing \`.markdown-collab/*.md.json\` history. Don't create a sidecar from scratch.

## Inline-mode workflow (default path)

This is the path you take when the target \`.md\` contains \`<!--mc:threads:begin-->\`.

### Phase 1 — Discover

1. Read the \`.md\` file.
2. Locate the threads region: everything between \`<!--mc:threads:begin-->\` and \`<!--mc:threads:end-->\`. Each \`<!--mc:t {JSON}-->\` line is one thread.
3. Filter to **actionable** threads only:
   - \`status === "open"\` AND
   - The last non-deleted entry in \`comments\` has \`author !== "claude"\` (and is not an AI alias you chose previously).
4. For each actionable thread, locate the anchored prose with a regex search for \`<!--mc:a:<thread-id>-->\`. The text between the open and close marker is the passage the reviewer is talking about. If the open or close marker is missing, the thread is **unanchored** — fall back to the \`quote\` field as the locator.

### Phase 2 — Plan

Group by file. Within a file, order edits by anchor position (earlier first). For each thread, write down: the reviewer's intent, the concrete edit, and whether the anchored passage will be rewritten in place (marker pair must move with it) or removed (markers go away, thread orphans).

### Phase 3 — Edit & reply

For each thread, in order, do everything in **one Edit call per concern** against the \`.md\` file:

1. **Make the prose change.** Use the Edit tool. **You MUST preserve the anchor markers if and only if the passage is being rewritten, not removed.**

   - **Rewrite in place:** keep the \`<!--mc:a:ID-->\` open marker immediately before the new passage and the \`<!--mc:/a:ID-->\` close marker immediately after it. Move the markers with the text; do not duplicate or split them.
   - **Remove the passage:** delete the open marker, the passage, and the close marker together. The thread will orphan and surface in the UI as "broken anchor". That is the correct outcome — do NOT re-anchor to nearby unrelated text.
   - **Touch surrounding prose without touching the anchored span:** the markers stay exactly where they were.

2. **Append a reply to the thread.** Locate the matching \`<!--mc:t {…}-->\` line by its \`"id":"<thread-id>"\`, then Edit only that single line:
   - Append a new comment object at the END of the thread's \`comments\` array.
   - The new comment must have:
     - \`"id"\`: the next sequential \`c<N>\` for that thread (find the highest existing N including deleted entries; new id = N+1).
     - \`"parent"\`: the id of the LAST non-deleted comment in the thread (the one you are replying to).
     - \`"author"\`: \`"claude"\` unless the user has told you to use a different name.
     - \`"ts"\`: current UTC timestamp in ISO-8601, e.g. \`"2026-05-13T14:32:11Z"\` (omit sub-second precision).
     - \`"body"\`: one or two sentences quoting the new wording, naming the section, or naming the file/function you changed. Be specific. Don't say "done".
   - **Do NOT change \`status\`.** The human reviewer marks threads resolved. Leave \`"status":"open"\`.
   - **Do NOT mutate any existing comment.** Only append.
   - Preserve the JSON exactly otherwise: same key order, same escaping, same trailing \`-->\`. The line stays on a single line; do not introduce newlines inside the JSON.

3. **For threads you cannot fully address** (ambiguous request, missing info, conflicting with another thread), still append a reply explaining what you tried and what you need. Do not pretend it's done.

### Phase 4 — Deletion (opt-in)

You only delete or tombstone a thread when the human's body or trailing reply unambiguously asks for it ("delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"):

- Remove the matching \`<!--mc:t {…}-->\` line outright AND remove the matching anchor marker pair from the prose. Both edits in one pass.
- Never delete to "clean up". Never delete just because you addressed a comment — the human resolves.

### Phase 5 — Initiate a new thread (opt-in)

You only **create** a new review thread when the human explicitly asks you to — "leave a comment on X", "add a review note about Y", "flag this section for follow-up", "drop a TODO comment here". Never initiate threads spontaneously while addressing existing ones, while doing maintenance edits, or to leave yourself a reminder.

This is the **default path** for thread creation. Use it when:
- the target \`.md\` is already in inline mode (contains \`<!--mc:threads:begin-->\`), OR
- the target \`.md\` has neither inline markers nor a sidecar (a fresh file). Inline is the v0.27+ format of record; don't fall back to creating a sidecar.

When asked to add a thread to a file in inline mode:

1. **Pick the passage to anchor.** It must:
   - Be a verbatim substring of the current \`.md\` text.
   - Contain at least **8 non-whitespace characters**.
   - Sit OUTSIDE fenced code blocks and inline code spans (markers inside code are deliberately ignored by the parser, so a thread anchored there would be invisible).
   - Occur in a location where adding the marker pair won't break neighbouring markdown syntax (don't split a link target, an image alt, a table cell delimiter, or a heading underline).

2. **Pick a thread id.** 5-char lowercase base36 (\`[a-z0-9]{5}\`). It MUST be unique across:
   - every \`<!--mc:a:ID-->\` and \`<!--mc:/a:ID-->\` marker already in the file, and
   - every \`"id":"…"\` in existing \`<!--mc:t {…}-->\` lines.
   Generate a random id; if it collides, retry.

3. **Wrap the passage in paired markers.** Use the Edit tool. \`old_string\` = the passage, \`new_string\` = \`<!--mc:a:ID-->\` + passage + \`<!--mc:/a:ID-->\`. The markers must hug the passage with no extra whitespace inserted.

4. **Append a thread JSON line to the threads region.** If \`<!--mc:threads:begin-->\` already exists, Edit to insert a new line just before the matching \`<!--mc:threads:end-->\` line. If neither fence exists yet, append a fresh region at the end of the file:
   \`\`\`

   <!--mc:threads:begin-->
   <!--mc:t {"id":"ID","quote":"<anchored text>","status":"open","comments":[{"id":"c1","author":"claude","ts":"<ISO-8601 UTC>","body":"<your note>"}]}-->
   <!--mc:threads:end-->
   \`\`\`
   The thread JSON must be on a single line. \`quote\` is the verbatim anchored text. \`status\` is always \`"open"\` — never seed a thread as resolved. The first \`comments\` entry is your note (\`id\`: \`c1\`; \`author\`: \`"claude"\` unless the user gave you a different alias; \`ts\`: current UTC ISO-8601, sub-second precision stripped; \`body\`: the note itself, markdown allowed).

5. **Verify.** Re-read the file. Confirm: (a) exactly one open marker and one close marker exist for the new id, wrapping the chosen passage; (b) exactly one \`<!--mc:t …-->\` line carries that id; (c) the JSON parses and matches the schema in section "Inline format" above.

If you need to add **multiple** threads in one turn, do them one at a time, re-reading after each to make sure earlier marker offsets weren't invalidated by intervening prose edits.

### Phase 6 — Invariants (inline mode)

You MUST NOT:
- Change any thread's \`status\` field. Only the human resolves.
- Edit any comment object other than to APPEND new entries.
- Re-anchor an orphaned thread to nearby unrelated text. Let it orphan.
- Move existing anchor markers to a new location unless you also moved the passage they wrap.
- Change \`thread.id\`, \`thread.quote\`, existing comment \`id\` / \`author\` / \`ts\` / \`body\`, or any other historical field.
- Introduce comment ids that don't follow the \`c<N>\` sequence within a thread (\`c1\` for the first comment, \`c2\` next, etc.).
- Initiate a new thread (Phase 5) unless the human explicitly asked.
- Reformat the threads region (drop newlines, merge lines, reorder threads). Only line-level edits to one thread JSON at a time.

### Phase 7 — Verify (inline mode)

Before reporting done:
- Re-read the threads region. Confirm each addressed thread now ends with a comment authored by you and \`"status":"open"\`.
- For each thread whose passage you rewrote: confirm the file still contains exactly one matched marker pair for that id, wrapping the new wording.
- For each thread whose passage you removed: confirm both markers are gone and the \`<!--mc:t …-->\` line is unchanged (it will orphan in the UI).
- For each deletion (opt-in): confirm the \`<!--mc:t …-->\` line is gone AND the marker pair is gone.
- For each thread you initiated (opt-in): confirm a paired marker exists, the new \`<!--mc:t …-->\` line parses as valid JSON with \`status:"open"\` and a single \`c1\` comment, and the id is unique in the file.

If any check fails, fix it before reporting.

## Sidecar-mode workflow (legacy path) — load on demand

When the target \`.md\` does NOT contain \`<!--mc:threads:begin-->\` but a sidecar exists at \`<workspaceRoot>/.markdown-collab/<rel>.md.json\`, you are in **sidecar mode**. This is a legacy path retained for workspaces with existing \`.markdown-collab/*.md.json\` history.

**The full sidecar workflow lives in a separate reference file to keep this SKILL.md lean.** Before acting in sidecar mode, READ the reference:

\`\`\`
~/.claude/skills/vs-markdown-collab/SIDECAR.md
\`\`\`

That file covers: the sidecar format spec, the \`mdc.mjs\` CLI (\`list\`, \`reply\`, \`add\`, \`delete\`, \`set-anchor\`, \`validate\`), the seven-phase sidecar workflow (Discover / Plan / Edit / Delete / Initiate / Invariants / Verify), sidecar anchor maintenance after any \`.md\` edit, and sidecar-specific anti-patterns. Do not act in sidecar mode without first loading it.

## When this skill applies

Invoke when:
- The user names one or more \`.md\` files and asks you to act on review comments / feedback / notes.
- The user says "address the markdown collab comments" without naming files (operate workspace-wide).
- The user references a specific comment thread or quote and asks you to apply / respond.
- The user asks you to "watch for review batches" or to wait for the VS Code "Send to Claude" button (use the channel watch loop or MCP channel mode below).

## Anchor maintenance applies on EVERY \`.md\` edit, not just comment-driven ones

Whenever you modify a \`.md\` file in a Markdown Collab workspace — for any reason, not only when addressing review comments — you MUST also reconcile that file's anchors after the edit. Rewording a sentence, refactoring a heading, fixing a typo: any of these can break an existing anchor.

### Inline mode (default)

1. After your Edit, search the \`.md\` text for \`<!--mc:a:\` and \`<!--mc:/a:\` markers. Each opener must have a matching closer with the same id; mismatched, dropped, or duplicated markers are a bug you just introduced.
2. For each thread id whose markers are still paired, confirm the wrapped text still reflects the same idea the reviewer commented on:
   - **You rewrote the passage in place** → keep the markers wrapping the new wording (this should already be the case if you used surgical Edits).
   - **You removed the passage** → both markers should now be gone; the thread will surface as unanchored in the UI. That is the correct outcome. Do NOT re-add markers to wrap unrelated nearby text.
3. Do NOT change any \`<!--mc:t {…}-->\` line during maintenance — only the human reviewer and the inline-mode reply workflow append to threads.

### Sidecar mode (legacy)

If you're operating on a sidecar-mode file (see "Sidecar-mode workflow" above for detection), the maintenance procedure is in SIDECAR.md → "Anchor maintenance applies on EVERY \`.md\` edit". Load SIDECAR.md before doing maintenance in sidecar mode; do not try to recall the rules from this file.

The maintenance pass applies in addition to the comment-driven workflows above; do not skip it just because no review batch was active.

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
The button click POSTs to the running channel server, which fires \`notifications/claude/channel\`. The body of the \`<channel>\` tag is the same JSON payload \`{prompt, file, unresolvedCount, comments}\`. The payload's \`prompt\` field self-documents the format (inline or sidecar). Address each comment per the matching mode's phases above, then append \`{"id": "<id-from-tag>"}\` to \`<workspace>/.markdown-collab/.events.acked.jsonl\` so the extension knows the batch is done.

**Caveats:** channels require claude.ai login (no API keys / Console), and the protocol is research preview — Anthropic warns it may change. If channels aren't supported in your harness or version, fall back to one of the modes below.

## Channel watch loop (button-driven)

The VS Code extension exposes a "Send to Claude" button in both the Inline Comments View and the legacy Preview comments sidebar. When configured for channel mode it appends one JSON line per click to \`<workspace>/.markdown-collab/.events.jsonl\`. The event payload itself encodes whether the comments came from inline markers or a sidecar, so you can branch on it. To watch for the next click:

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

3. **Per notification**, parse the JSON line as \`{prompt, file, unresolvedCount, comments, ts}\`. Detect the storage mode for \`<workspace>/<file>\` (inline markers in the .md vs sidecar JSON) and address the batch using the matching mode's phases above, then return to the Monitor stream for the next event.

4. **Stopping**: the user ends the session, or you exit the watch when they say "stop watching." Kill the background tailer process when done.

Skip / abort if:
- The user is asking for a general edit unrelated to review comments.
- Neither the target \`.md\` file contains \`<!--mc:threads:begin-->\` nor a matching sidecar exists — there is nothing to act on.


## Reporting

Tell the user, per file, what storage mode was in play (inline / sidecar) plus:
- Threads addressed (id + one-line summary of each change).
- Threads initiated on explicit request (id + anchored passage + the note you left).
- Threads deleted on explicit request (id).
- Threads left unanchored / orphaned because their target was removed (id + why).
- Threads answered without a prose change (id + the question / clarification you replied with).
- Anything you skipped and why.

Use the thread id so the human can find each thread in VS Code (inline IDs are 1–12 char base36; sidecar IDs are \`c_xxxxxxxx\`).

## Anti-patterns

Inline mode:
- Don't change any thread's \`"status"\` field. Only the human resolves.
- Don't mutate or reorder existing comment objects. Append only.
- Don't move or duplicate anchor markers without moving the passage they wrap.
- Don't re-add markers to wrap unrelated nearby text after a deletion.
- Don't reformat the threads region (newlines, key order, escaping).

Sidecar mode: see SIDECAR.md → "Anti-patterns (sidecar)".

Both modes:
- Don't reply with vague "applied" — say what you applied, quoting the new wording.
- Don't fabricate that you handled a comment you couldn't actually address.
- Don't re-anchor a deleted passage to nearby unrelated text. Deletions become orphans by design.
- Don't delete a thread the human didn't explicitly tell you to delete.
- Don't initiate a new thread the human didn't explicitly ask for. The skill is reply-driven by default.
- Don't operate on a file with neither inline markers nor a sidecar — surface this rather than invent state.
- Don't act in sidecar mode without first reading SIDECAR.md.
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
  await syncScript(path.join(homeDir, SIDECAR_REF_REL), SIDECAR_CONTENT);
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
