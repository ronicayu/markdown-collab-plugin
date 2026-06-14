import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "node:crypto";

export const SKILL_REL_PATH = ".claude/skills/vs-markdown-collab/SKILL.md";
export const TAIL_SCRIPT_REL = ".claude/skills/vs-markdown-collab/mdc-tail.mjs";
export const CHANNEL_SCRIPT_REL = ".claude/skills/vs-markdown-collab/mdc-channel.mjs";

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
//   After addressing a batch, Claude appends \`{"id":"<event-id>"}\` to a
//   sibling \`.events.acked.jsonl\` (see SKILL.md → channel modes). The tailer
//   reads that file on startup and watches it; any event whose id is already
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
description: Agentic workflow for addressing review comments on Markdown (.md) files in a Markdown Collab workspace, AND for reviewing Markdown docs by leaving review comments for the human. Comments are stored INLINE in the .md file itself (look for \`<!--mc:threads:begin-->\`). TRIGGER when the user asks to address, resolve, respond to, incorporate, or act on review comments, notes, suggestions, or feedback on any Markdown document — trigger phrases include "address the comments on foo.md", "apply the review feedback", "respond to the notes in README", "incorporate the suggestions", "fix the markdown collab comments", "work through the review on docs/spec.md". ALSO TRIGGER on review-mode requests where the user asks YOU to play reviewer — "review this doc", "leave your thoughts on README", "do a review pass on docs/spec.md", "second pair of eyes on this", "what would you flag in this file", "review the markdown collab doc on X".
---

# Markdown Collab — agentic review-address skill

You are addressing human review comments left on Markdown files via the Markdown Collab VS Code extension. The user runs the IDE; you do the writing.

## Storage format

Comments are stored INLINE in the \`.md\` file itself — there is no sidecar.

- Anchored spans are wrapped in paired HTML comments:
  \`<!--mc:a:ID-->anchored text<!--mc:/a:ID-->\` (ID = 1–12 char base36).
- A single block at the end of the file holds one \`<!--mc:t {JSON}-->\` line per thread, fenced by \`<!--mc:threads:begin-->\` and \`<!--mc:threads:end-->\`.
- Each thread JSON:
  \`{"id":"<ID>","quote":"<original anchor text>","status":"open"|"resolved","comments":[Comment, …]}\`.
- Each \`Comment\`:
  \`{"id":"c<N>","parent"?:"c<N>","author":"<name>","ts":"<ISO-8601 UTC>","body":"<markdown>","editedTs"?:"<ISO-8601 UTC>","deleted"?:true}\`.

**Detection:** the \`.md\` file contains the literal string \`<!--mc:threads:begin-->\`. A file without that block simply has no comments yet.

If a named file has no threads region:
- If the user is asking you to **address** comments, there are none — tell the user and stop.
- If the user is asking you to **initiate** a thread (opt-in, see Phase 5), create the inline threads region.

## Workflow

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

1. **Make the prose change.** Use the Edit tool. **The anchor markers MUST travel with their text. Dropping a marker silently orphans the reviewer's comment — this is the single most common way this workflow breaks, so handle it deliberately.** Three cases:

   - **Rewrite in place (you change the anchored text):** the marker pair moves with the text and keeps the SAME id. The reliable way is to put the markers *inside* your Edit — \`old_string\` = open marker + old passage + close marker; \`new_string\` = the same open marker + the NEW passage + the same close marker. Do NOT Edit the bare visible text: the markers sit flush against it, so a bare-text \`old_string\` either fails to match or drops a marker. Example — renaming an anchored heading from "Main business flows" to "Core business processes":
       - \`old_string\`: \`### <!--mc:a:aopzy-->Main business flows<!--mc:/a:aopzy-->\`
       - \`new_string\`: \`### <!--mc:a:aopzy-->Core business processes<!--mc:/a:aopzy-->\`

     Same \`aopzy\` id, both markers kept, only the wrapped text changed. When the anchored text changes this way, also update that thread's \`quote\` field to the new text in step 2 (the quote is the fallback locator). Never leave the rewritten text un-wrapped; never duplicate or split a marker.
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
   - **Do NOT mutate any existing comment.** Only append. (One exception: if you rewrote the anchored text in step 1, update this thread's \`quote\` field to the new text in the same Edit — \`quote\` is a thread-level field, not a comment, and keeping it current makes the comment recoverable if a marker is ever lost.)
   - Preserve the JSON exactly otherwise: same key order, same escaping, same trailing \`-->\`. The line stays on a single line; do not introduce newlines inside the JSON.

3. **For threads you cannot fully address** (ambiguous request, missing info, conflicting with another thread), still append a reply explaining what you tried and what you need. Do not pretend it's done.

### Phase 4 — Deletion (opt-in)

You only delete or tombstone a thread when the human's body or trailing reply unambiguously asks for it ("delete this comment", "remove this thread", "drop this", "this comment is no longer relevant"):

- Remove the matching \`<!--mc:t {…}-->\` line outright AND remove the matching anchor marker pair from the prose. Both edits in one pass.
- Never delete to "clean up". Never delete just because you addressed a comment — the human resolves.

### Phase 5 — Initiate a new thread (opt-in)

You only **create** a new review thread when the human explicitly asks you to — "leave a comment on X", "add a review note about Y", "flag this section for follow-up", "drop a TODO comment here". Never initiate threads spontaneously while addressing existing ones, while doing maintenance edits, or to leave yourself a reminder.

Use it when:
- the target \`.md\` already contains \`<!--mc:threads:begin-->\`, OR
- the target \`.md\` has no threads region yet (a fresh file) — create one.

When asked to add a thread:

1. **Pick the passage to anchor.** It must:
   - Be a verbatim substring of the current \`.md\` text.
   - Be a meaningful span (at least a word) — markers store exact offsets, so there's no minimum length, but a one-character anchor is rarely useful.
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
- Initiate a new thread (Phase 5) unless the human explicitly asked. The Review Mode trigger ("review this doc", "leave your thoughts on X", "do a review pass") counts as an explicit ask and unlocks one or more thread initiations — see the Review Mode section below.
- Reformat the threads region (drop newlines, merge lines, reorder threads). Only line-level edits to one thread JSON at a time.
- Edit prose in Review Mode. In review mode you OPEN threads, you do not modify the doc text. Even obvious typos go in a thread unless the human said "fix as you go".

### Review Mode (inline) — Claude as the reviewer

When the human's request matches **Review Mode** trigger phrases — "review this doc", "leave your thoughts on X", "do a review pass on Y", "second pair of eyes on README", "what would you flag in this file", or the Markdown Collab extension's "Ask Claude to Review This Doc" command — you switch from addressing existing comments to **initiating** new review threads. The human will triage them in the sidebar.

The mechanics are the same as Phase 5: pick a passage, allocate an id, insert paired markers, append a \`<!--mc:t {…}-->\` line with a single \`c1\` comment authored by \`"claude"\`, verify. Read Phase 5 first if you have not — it carries the invariants you must respect when wrapping passages.

#### Focus directive

The prompt may include a \`Focus:\` line — a free-form instruction from the human (e.g. *"check API examples for correctness," "find marketing-y tone," "look for contradictions with the architecture doc"*). When a focus directive is present:

- It is the **primary filter** for what counts as a concern worth a thread. Only flag things that match the focus.
- A general-quality issue that doesn't match the focus does **not** warrant a thread unless it's a hard error (e.g. broken example, factually wrong claim).
- If no concerns match the focus after a careful read, reply (via the send channel, not via a thread) saying so. **Do not fabricate threads to feel productive.**

Without a focus directive, do a general review against the rubric below.

#### What warrants a thread

- Factual error or claim that's wrong.
- Unclear claim that a reader could plausibly misinterpret.
- Missing context the reader will need (e.g. an undefined term used in passing).
- Broken example: code that won't run, a command with a wrong flag, a link to a nonexistent file.
- Contradiction between this doc and another section / file the human has scoped in.
- Structural issue: section out of order, heading hierarchy broken, key info buried.
- Anything matching the focus directive when one was given.

#### What does NOT warrant a thread by default

- Pure typos (commas, articles, capitalization). Skip unless the focus is "copy-edit".
- Style preferences (Oxford comma, sentence length, voice). Skip unless the focus is "tone" / "style".
- Generic "could be clearer" / "this section feels long" without naming the specific problem. If you can't name it, you can't anchor it.
- Restating the anchored text. The body must add something the human doesn't already see.

#### Anchor sizing in Review Mode

- The anchor should be the **smallest passage that makes the comment make sense**. Prefer one sentence over a paragraph. Prefer one phrase over a sentence when the issue is local.
- Avoid wrapping a whole section. If the issue is structural ("this section is in the wrong place"), anchor the section heading line, not the body.
- Anchors must still satisfy Phase 5 constraints: a meaningful span, outside code spans, marker-safe location.

#### Thread body — specificity rule

Every \`c1\` body must name the concern concretely.

- **Good:** *"The claim that \`X\` implies \`Y\` skips intermediate step \`Z\`. Either justify the jump or add the step."*
- **Good:** *"Example uses \`--all\` but the CLI flag is \`--include-deleted\` per \`cli.ts\` line 142. Update the flag or update the CLI."*
- **Bad:** *"This could be clearer."*
- **Bad:** *"The whole section needs work."*
- **Bad:** *Restating the anchored text with no analysis.*

The body should fit in 1–3 sentences. If you need more, split into separate threads on different anchors.

#### Worked examples — good vs bad

These calibrate the rubric. Mirror the *shape* of the good examples; avoid the failure modes in the bad ones.

**Good — concrete factual correction.** Doc says: *"The CLI accepts \`--all\` to include resolved comments."* Code says the flag is \`--include-resolved\`. Anchor the literal \`--all\` token only (smallest meaningful span). Body: *"CLI flag is \`--include-resolved\` per \`cli.ts:142\`, not \`--all\`. Either rename the doc or update the CLI."*

**Good — unclear claim with a named ambiguity.** Doc says: *"The skill triggers on review-mode phrases."* Anchor the sentence. Body: *"\\'Review-mode phrases\\' isn't defined here — the rubric for what counts as one is in Phase 5+. Either inline a one-line definition or link to the Review Mode section."*

**Good — contradiction across sections.** Doc's \`Quick start\` says \`Send to Claude\` is in the right-click menu; doc's \`Commands\` table says it's palette-only. Anchor the quick-start claim (because it's the one that's likely wrong). Body: *"Conflicts with the Commands table, which marks this palette-only as of v0.28. Update one or the other to match reality."*

**Good — structural issue, anchored at a heading.** Doc has a \`## Settings\` heading before \`## Storage layout\`, but Storage explains terms used in Settings. Anchor the \`## Settings\` heading. Body: *"Settings references the \`<!--mc:threads:begin-->\` marker introduced in Storage layout below. Move Storage layout above Settings, or forward-link explicitly."*

**Bad — vague.** *"This could be clearer."* No anchored specifics, no named problem, nothing the human can act on without re-deriving the concern. Either name the specific issue or skip.

**Bad — anchor too wide.** Anchoring an entire 8-paragraph section because *"the whole section needs work."* The human can't tell which sentence drove the comment. Pick the single sentence (or heading) that crystallizes the issue.

**Bad — restating the anchor.** Anchored: *"Channels need MCP."* Body: *"This sentence is about channels needing MCP."* Adds nothing the reader doesn't see. Either explain *why* the claim is problematic (it's incomplete? wrong? unclear in this context?) or skip.

**Bad — opinion presented as fact.** *"This intro is too marketing-y."* — only valid if the focus directive explicitly asks for tone. Without that, style preferences aren't a substantive concern.

**Bad — fix dressed as a comment.** Body: *"I changed this to X."* You don't edit prose in Review Mode. Open a thread proposing the change in the body; let the human accept it.

#### No upper bound on thread count

There is **no maximum number of threads** per review pass. Leave a thread for every substantive concern that fits the focus directive (or the general rubric, if no focus was given). If you find 30 issues, leave 30 threads. The human triages with the sidebar UI; your job is signal, not curation.

Do not "leave the top N" — dropping findings to hit a count target risks suppressing the one that matters most.

#### Honest empty result

If you read the doc carefully and find no concerns that match the focus (or no general-rubric concerns if no focus was given), say so explicitly via the send channel. Do **not** open a thread to comment "looks good" — threads are for actionable concerns. A short reply of *"Reviewed \`<path>\` against focus \`<focus>\`. No concerns found."* is the correct outcome.

#### Workflow — Review Mode pass

1. **Read the doc end to end** before opening any threads. Cross-referencing the focus directive against the whole doc avoids redundant or contradictory threads.
2. **List concerns mentally** with anchor candidate, severity (in your head — do not encode it in JSON), and one-sentence body. Discard anything that fails the specificity rule.
3. **Initiate threads one at a time**, in document order (earlier anchors first). Use the Phase 5 mechanics:
   - Verbatim anchor passage (a meaningful span, outside code fences).
   - 5-char lowercase base36 id, unique against existing markers and \`<!--mc:t …-->\` ids.
   - Paired markers wrap the passage; \`<!--mc:t {…}-->\` line appended in the threads region (create the region if absent).
   - \`c1\` comment: \`author:"claude"\`, current UTC ISO-8601 \`ts\`, body following the specificity rule.
4. **Re-read after each Edit.** Anchor offsets may shift; the next thread's anchor must still be a unique substring.
5. **Do not edit prose.** Even if the fix is obvious. Open a thread; the human decides.
6. **Verify.** Re-read the file. Confirm every new thread has a paired marker, a \`<!--mc:t …-->\` line with valid JSON, \`status:"open"\`, and a single \`c1\` from \`"claude"\`. Confirm no existing thread or prose was disturbed.

### Phase 7 — Verify

Before reporting done:
- Re-read the threads region. Confirm each addressed thread now ends with a comment authored by you and \`"status":"open"\`.
- For each thread whose passage you rewrote: confirm the file still contains exactly one matched marker pair for that id, wrapping the new wording.
- For each thread whose passage you removed: confirm both markers are gone and the \`<!--mc:t …-->\` line is unchanged (it will orphan in the UI).
- For each deletion (opt-in): confirm the \`<!--mc:t …-->\` line is gone AND the marker pair is gone.
- For each thread you initiated (opt-in): confirm a paired marker exists, the new \`<!--mc:t …-->\` line parses as valid JSON with \`status:"open"\` and a single \`c1\` comment, and the id is unique in the file.

If any check fails, fix it before reporting.

## When this skill applies

Invoke when:
- The user names one or more \`.md\` files and asks you to act on review comments / feedback / notes.
- The user says "address the markdown collab comments" without naming files (operate workspace-wide).
- The user references a specific comment thread or quote and asks you to apply / respond.
- The user asks you to "watch for review batches" or to wait for the VS Code "Send to Claude" button (use the channel watch loop or MCP channel mode below).

## Anchor maintenance applies on EVERY \`.md\` edit, not just comment-driven ones

Whenever you modify a \`.md\` file in a Markdown Collab workspace — for any reason, not only when addressing review comments — you MUST also reconcile that file's anchors after the edit. Rewording a sentence, refactoring a heading, fixing a typo: any of these can break an existing anchor.

1. After your Edit, search the \`.md\` text for \`<!--mc:a:\` and \`<!--mc:/a:\` markers. Each opener must have a matching closer with the same id; mismatched, dropped, or duplicated markers are a bug you just introduced.
2. For each thread id whose markers are still paired, confirm the wrapped text still reflects the same idea the reviewer commented on:
   - **You rewrote the passage in place** → keep the markers wrapping the new wording (this should already be the case if you used surgical Edits).
   - **You removed the passage** → both markers should now be gone; the thread will surface as unanchored in the UI. That is the correct outcome. Do NOT re-add markers to wrap unrelated nearby text.
3. Do NOT change any \`<!--mc:t {…}-->\` line during maintenance — only the human reviewer and the inline-mode reply workflow append to threads.

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
The button click POSTs to the running channel server, which fires \`notifications/claude/channel\`. The body of the \`<channel>\` tag is the same JSON payload \`{prompt, file, unresolvedCount, comments}\`. The \`prompt\` field tells you to follow this skill. Address each comment per the phases above, then append \`{"id": "<id-from-tag>"}\` to \`<workspace>/.markdown-collab/.events.acked.jsonl\` so the tailer stops re-surfacing that batch on restart.

**Caveats:** channels require claude.ai login (no API keys / Console), and the protocol is research preview — Anthropic warns it may change. If channels aren't supported in your harness or version, fall back to one of the modes below.

## Channel watch loop (button-driven)

The VS Code extension exposes a "Send to Claude" button in the Inline Comments View. When configured for channel mode it appends one JSON line per click to \`<workspace>/.markdown-collab/.events.jsonl\`. To watch for the next click:

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

3. **Per notification**, parse the JSON line as \`{prompt, file, unresolvedCount, comments, ts}\`. Address the batch using the phases above, then return to the Monitor stream for the next event.

4. **Stopping**: the user ends the session, or you exit the watch when they say "stop watching." Kill the background tailer process when done.

Skip / abort if:
- The user is asking for a general edit unrelated to review comments.
- The target \`.md\` file contains no \`<!--mc:threads:begin-->\` block — there is nothing to act on.


## Reporting

Tell the user, per file:
- Threads addressed (id + one-line summary of each change).
- Threads initiated on explicit request (id + anchored passage + the note you left).
- Threads deleted on explicit request (id).
- Threads left unanchored / orphaned because their target was removed (id + why).
- Threads answered without a prose change (id + the question / clarification you replied with).
- Anything you skipped and why.

Use the thread id so the human can find each thread in VS Code (thread IDs are 1–12 char base36).

## Anti-patterns

- Don't change any thread's \`"status"\` field. Only the human resolves.
- Don't mutate or reorder existing comment objects. Append only.
- Don't move or duplicate anchor markers without moving the passage they wrap.
- Don't re-add markers to wrap unrelated nearby text after a deletion.
- Don't reformat the threads region (newlines, key order, escaping).
- Don't reply with vague "applied" — say what you applied, quoting the new wording.
- Don't fabricate that you handled a comment you couldn't actually address.
- Don't re-anchor a deleted passage to nearby unrelated text. Deletions become orphans by design.
- Don't delete a thread the human didn't explicitly tell you to delete.
- Don't initiate a new thread the human didn't explicitly ask for. The skill is reply-driven by default.
- Don't operate on a file with no \`<!--mc:threads:begin-->\` block — surface this rather than invent state.
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

export type SkillStatus = "missing" | "outdated" | "current";

/**
 * Compare the installed Claude skill against what this extension bundles:
 *   - "missing"  — SKILL.md isn't installed.
 *   - "outdated" — SKILL.md or a bundled helper script differs from this build.
 *   - "current"  — everything matches.
 * Read errors other than "not found" report "current" so a transient or
 * permission issue never nags the user.
 */
export async function checkClaudeSkill(homeDir: string): Promise<SkillStatus> {
  let skill: string | null = null;
  try {
    skill = await fs.readFile(path.join(homeDir, SKILL_REL_PATH), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "current";
  }
  if (skill !== SKILL_CONTENT) return "outdated";
  for (const [rel, content] of [
    [TAIL_SCRIPT_REL, TAIL_SCRIPT_CONTENT],
    [CHANNEL_SCRIPT_REL, CHANNEL_SCRIPT_CONTENT],
  ] as const) {
    try {
      if ((await fs.readFile(path.join(homeDir, rel), "utf8")) !== content) return "outdated";
    } catch (e) {
      // A missing helper script means the install is incomplete → outdated.
      // Other read errors (permission, transient) shouldn't nag — same posture
      // as the SKILL.md read above.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "outdated";
    }
  }
  return "current";
}

/**
 * Short, stable fingerprint of the bundled skill (SKILL.md + helper scripts).
 * Changes whenever the bundled skill content changes, so callers can prompt the
 * user to update exactly once per skill version instead of every activation.
 */
export function skillFingerprint(): string {
  return createHash("sha1")
    .update(SKILL_CONTENT)
    .update(TAIL_SCRIPT_CONTENT)
    .update(CHANNEL_SCRIPT_CONTENT)
    .digest("hex")
    .slice(0, 12);
}

async function syncCliScript(homeDir: string): Promise<void> {
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
