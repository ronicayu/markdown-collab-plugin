#!/usr/bin/env node
// A stand-in `claude` binary for the headless-run tests (10x-plan-4 P0.1).
//
// It behaves like `claude -p --output-format stream-json` closely enough for
// the extension not to know the difference: it reads the prompt from stdin,
// connects to the MCP server named in --mcp-config, and makes REAL tool calls
// over HTTP — so a thread it "opens" goes through the extension's own tool
// server and lands in the document exactly like Claude's would. It emits the
// same event shapes as the real CLI (see src/test/fixtures/headless/).
//
// FAKE_CLAUDE_MODE picks the scenario:
//   ok         init (connected) → mc_status → mc_open → mc_check → result
//   no-mcp     init listing markdown-collab as "failed", then waits to be killed
//   auth-fail  init, then an api_retry authentication_failed, then waits
//   hang       init, one tool call, then never finishes (cancel tests)
//   hang-hard  like hang, but ignores SIGINT (escalation tests)
//   error      init, then an error result
// FAKE_CLAUDE_TRACE, when set, is a file this writes what it was given to —
// argv, cwd, the prompt, and the temp files' modes — so a test can assert on
// the invocation without trusting the extension's own report of it.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("2.1.283 (Claude Code)\n");
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE || "ok";
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
// Exit only once stdout has drained: on macOS a pipe write is asynchronous, and
// process.exit() straight after one can drop the final `result` line.
const exitAfterFlush = (code) => process.stdout.write("", () => process.exit(code));
const SESSION = "00000000-0000-4000-8000-00000000fake";
let turn = 0;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function modeOf(p) {
  try {
    return (statSync(p).mode & 0o777).toString(8);
  } catch {
    return null;
  }
}

const prompt = await readStdin();
const mcpConfigPath = flag("--mcp-config");
const systemPromptPath = flag("--append-system-prompt-file");
const configText = readFileSync(mcpConfigPath, "utf8");
const config = JSON.parse(configText);
// Like the real CLI: `${VAR}` in url/headers expands from the environment.
const expand = (v) => (typeof v === "string" ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "") : v);
const raw = config.mcpServers["markdown-collab"];
const server = {
  ...raw,
  url: expand(raw.url),
  headers: Object.fromEntries(Object.entries(raw.headers ?? {}).map(([k, v]) => [k, expand(v)])),
};

if (process.env.FAKE_CLAUDE_TRACE) {
  writeFileSync(
    process.env.FAKE_CLAUDE_TRACE,
    JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        prompt,
        mcpConfigPath,
        mcpConfigMode: modeOf(mcpConfigPath),
        systemPromptPath,
        systemPromptMode: modeOf(systemPromptPath),
        systemPromptHead: readFileSync(systemPromptPath, "utf8").slice(0, 400),
        claudecodeEnv: process.env.CLAUDECODE ?? null,
        mcpConfigHasTokenLiteral: /[0-9a-f]{32,}/.test(configText),
        envToken: process.env.MARKDOWN_COLLAB_MCP_TOKEN ?? null,
      },
      null,
      2,
    ),
  );
}

let rpcId = 0;
// The streamable-HTTP transport issues an `Mcp-Session-Id` on `initialize`
// (10x-plan-4 P1.2) and a compliant client echoes it on every request after —
// that's how the real Claude Code CLI's author slug reaches the document
// (`initialize`'s `clientInfo.name` → the session → every `tools/call`). This
// stub models that faithfully rather than being a special case the extension
// happens to tolerate.
let sessionId;
async function rpc(method, params) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const gotSessionId = res.headers.get("mcp-session-id");
  if (gotSessionId) sessionId = gotSessionId;
  if (res.status === 202) return null;
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  return res.json();
}

async function connect() {
  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.1.283" },
    });
    if (!init || init.error) return { status: "failed", tools: [] };
    await fetch(server.url, {
      method: "POST",
      headers: {
        ...server.headers,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const list = await rpc("tools/list", {});
    return { status: "connected", tools: (list?.result?.tools ?? []).map((t) => `mcp__markdown-collab__${t.name}`) };
  } catch {
    return { status: "failed", tools: [] };
  }
}

function init(status, mcpTools) {
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: SESSION,
    tools: ["Read", "Glob", "Grep", ...mcpTools],
    mcp_servers: [{ name: "markdown-collab", status }],
    model: "fake-model",
    permissionMode: "dontAsk",
    claude_code_version: "2.1.283",
  });
}

async function callTool(name, args) {
  const id = `toolu_fake_${++turn}`;
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: `mcp__markdown-collab__${name}`, input: args }],
    },
    session_id: SESSION,
  });
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res?.result?.content?.[0]?.text ?? JSON.stringify(res?.error ?? null);
  emit({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: res?.result?.isError === true }],
    },
    session_id: SESSION,
  });
  return res?.result;
}

/** The file the prompt names — the first backticked `.md` path. */
function targetFile() {
  const m = /`([^`]+\.md)`/.exec(prompt);
  return m ? m[1] : null;
}

/** A passage that exists in the document: the first words of its first prose line. */
function quoteFrom(file) {
  const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("<!--") && !l.startsWith("---") && !l.startsWith("```"));
  if (!line) return null;
  return line.split(/\s+/).slice(0, 4).join(" ").replace(/[`*_[\]]/g, "");
}

const waitForever = () => setInterval(() => {}, 1 << 30);

if (mode === "no-mcp") {
  init("failed", []);
  waitForever();
} else {
  const { status, tools } = await connect();
  init(status, tools);

  if (mode === "auth-fail") {
    emit({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 500,
      error_status: 401,
      error: "authentication_failed",
      session_id: SESSION,
    });
    waitForever();
  } else if (mode === "hang" || mode === "hang-hard") {
    if (mode === "hang-hard") process.on("SIGINT", () => {});
    await callTool("mc_status", { note: "reading the document" });
    waitForever();
  } else if (mode === "error") {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Something went wrong mid-run.",
      num_turns: 1,
      total_cost_usd: 0.001,
      session_id: SESSION,
    });
    exitAfterFlush(1);
  } else {
    const file = targetFile();
    if (!file) throw new Error("fake-claude: no `.md` path in the prompt");
    await callTool("mc_status", { note: "reading the document", file });
    const quote = quoteFrom(file);
    const opened = quote
      ? await callTool("mc_open", { file, quote, body: "Fake review: is this claim sourced?" })
      : null;
    await callTool("mc_check", { file });
    const threadId = opened && !opened.isError ? JSON.parse(opened.content[0].text).threadId : null;
    const report = threadId
      ? `Reviewed \`${file}\`: opened 1 thread (${threadId}) on "${quote}".\n\nNothing else stood out.`
      : `Reviewed \`${file}\`: no concerns.`;
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: report }] },
      session_id: SESSION,
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: report,
      num_turns: 4,
      total_cost_usd: 0.0123,
      session_id: SESSION,
    });
    exitAfterFlush(0);
  }
}
