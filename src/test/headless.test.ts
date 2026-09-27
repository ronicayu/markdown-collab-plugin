// The pure half of headless runs (10x-plan-4 P0.1): the argv, the temp-file
// contents, the stream parser, and the availability decision.
//
// The parser is tested against a REAL recorded stream (a `claude -p` call on
// Claude Code 2.1.283, sanitized: ids and paths replaced) as well as hand-built
// lines for the cases a healthy session never shows — a missing server, an auth
// retry, a truncated last line. The real one is the check that the shapes these
// tests assume are the shapes the CLI emits.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  HEADLESS_PREAMBLE,
  buildHeadlessArgs,
  HEADLESS_SETTINGS,
  decideHeadlessAvailability,
  headlessSystemPrompt,
  isAuthResultText,
  isAuthRetry,
  mcpConfigJson,
  parseStreamLine,
  shortToolName,
  stripFrontmatter,
  supportsPermissionPrompts,
  unavailableReasonText,
  type HeadlessEvent,
} from "../transports/headless";
import { parseClaudeVersion } from "../transports/claudeBinary";
import { SKILL_CONTENT } from "../skill";

const FIXTURES = path.join(__dirname, "fixtures", "headless");
const TOKEN = "f".repeat(64);

function streamEvents(file: string): HeadlessEvent[] {
  return fs
    .readFileSync(path.join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap(parseStreamLine);
}

const line = (event: unknown): string => JSON.stringify(event);

describe("buildHeadlessArgs", () => {
  const base = {
    mcpConfigPath: "/tmp/mc-headless-x/mcp.json",
    systemPromptPath: "/tmp/mc-headless-x/system-prompt.md",
    settingsPath: "/tmp/mc-headless-x/settings.json",
    supportsPermissionPrompts: true,
  };

  it("never carries the token", () => {
    // The token lives only in the 0600 file; argv is world-readable via `ps`.
    const args = buildHeadlessArgs(base);
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args.join(" ")).not.toMatch(/Bearer/i);
  });

  it("always closes the tool set and the server list", () => {
    for (const supportsPermissionPrompts of [true, false]) {
      const args = buildHeadlessArgs({ ...base, supportsPermissionPrompts });
      const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
      expect(args[0]).toBe("-p");
      expect(after("--output-format")).toBe("stream-json");
      expect(args).toContain("--verbose");
      expect(after("--tools")).toBe("Read,Glob,Grep");
      expect(after("--mcp-config")).toBe(base.mcpConfigPath);
      expect(args).toContain("--strict-mcp-config");
      expect(after("--allowedTools")).toBe("mcp__markdown-collab__*");
      expect(after("--permission-mode")).toBe("dontAsk");
      expect(after("--append-system-prompt-file")).toBe(base.systemPromptPath);
      // The user's hooks are switched off for the run (HEADLESS_SETTINGS).
      expect(after("--settings")).toBe(base.settingsPath);
    }
  });

  it("never asks for the flags the plan rules out", () => {
    const args = buildHeadlessArgs({ ...base, model: "opus" });
    for (const banned of ["--bare", "--dangerously-skip-permissions", "--max-turns"]) {
      expect(args).not.toContain(banned);
    }
  });

  it("passes --permission-prompts only to CLIs that have it", () => {
    expect(buildHeadlessArgs(base).join(" ")).toContain("--permission-prompts none");
    expect(buildHeadlessArgs({ ...base, supportsPermissionPrompts: false })).not.toContain(
      "--permission-prompts",
    );
  });

  it("gates --permission-prompts on 2.1.259", () => {
    expect(supportsPermissionPrompts(parseClaudeVersion("2.1.283 (Claude Code)"))).toBe(true);
    expect(supportsPermissionPrompts(parseClaudeVersion("2.1.259 (Claude Code)"))).toBe(true);
    expect(supportsPermissionPrompts(parseClaudeVersion("2.1.258 (Claude Code)"))).toBe(false);
    expect(supportsPermissionPrompts(parseClaudeVersion("1.9.999"))).toBe(false);
    expect(supportsPermissionPrompts(parseClaudeVersion("3.0.0"))).toBe(true);
    expect(supportsPermissionPrompts(null)).toBe(false);
  });

  it("adds --model only when one is set", () => {
    expect(buildHeadlessArgs(base)).not.toContain("--model");
    expect(buildHeadlessArgs({ ...base, model: "   " })).not.toContain("--model");
    const args = buildHeadlessArgs({ ...base, model: " sonnet " });
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });
});

describe("temp-file contents", () => {
  it("the MCP config names only our server, with the bearer header", () => {
    const parsed = JSON.parse(mcpConfigJson({ url: "http://127.0.0.1:50123/mcp", token: TOKEN }));
    expect(Object.keys(parsed.mcpServers)).toEqual(["markdown-collab"]);
    expect(parsed.mcpServers["markdown-collab"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:50123/mcp",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("the system prompt is the preamble plus the skill, minus its frontmatter", () => {
    const prompt = headlessSystemPrompt(SKILL_CONTENT);
    expect(prompt.startsWith(HEADLESS_PREAMBLE)).toBe(true);
    expect(prompt).not.toMatch(/^name: vs-markdown-collab$/m);
    expect(prompt).toContain("# Markdown Collab — agentic review-address skill");
    expect(stripFrontmatter("no frontmatter here")).toBe("no frontmatter here");
  });

  it("the preamble names the closed tool set and the tools to use instead", () => {
    for (const phrase of ["Read, Glob, Grep", "no Edit/Write/Bash", "no mdc CLI", "mc_edit", "mc_rewrite", "mc_suggest", "mc_check"]) {
      expect(HEADLESS_PREAMBLE).toContain(phrase);
    }
  });
});

describe("parseStreamLine — the real recorded stream", () => {
  const events = streamEvents("real-ok.ndjson");

  it("finds exactly one init, with the fields the run reads", () => {
    const inits = events.filter((e) => e.kind === "init");
    expect(inits).toHaveLength(1);
    const init = inits[0] as Extract<HeadlessEvent, { kind: "init" }>;
    // Recorded with `--tools "" --strict-mcp-config` and no --mcp-config.
    expect(init.mcpServers).toEqual([]);
    expect(init.tools).toEqual([]);
    expect(init.sessionId).toMatch(/^0{8}-/);
    expect(init.model).toBeTruthy();
  });

  it("reads hook events, rate-limit notices and turn summaries as other", () => {
    expect(events.filter((e) => e.kind === "other").length).toBeGreaterThanOrEqual(4);
  });

  it("ends with a successful result carrying cost, turns and text", () => {
    const result = events[events.length - 1] as Extract<HeadlessEvent, { kind: "result" }>;
    expect(result.kind).toBe("result");
    expect(result.isError).toBe(false);
    expect(result.subtype).toBe("success");
    expect(result.text).toBe("OK");
    expect(result.numTurns).toBe(1);
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe("parseStreamLine — hand-written cases", () => {
  it("reads a full review run: init, tools in order, result", () => {
    const events = streamEvents("hand-review.ndjson");
    const init = events.find((e) => e.kind === "init") as Extract<HeadlessEvent, { kind: "init" }>;
    expect(init.mcpServers).toEqual([{ name: "markdown-collab", status: "connected" }]);
    const tools = events.filter((e) => e.kind === "tool") as Array<Extract<HeadlessEvent, { kind: "tool" }>>;
    expect(tools.map((t) => shortToolName(t.name))).toEqual(["Read", "mc_status", "mc_open", "mc_check"]);
    expect(tools[1]!.input).toEqual({ note: "reading guide.md", file: "docs/guide.md" });
    const result = events[events.length - 1] as Extract<HeadlessEvent, { kind: "result" }>;
    expect(result).toMatchObject({ kind: "result", isError: false, numTurns: 5, costUsd: 0.4217 });
  });

  it("yields one event per tool_use block, even several in one message", () => {
    const events = parseStreamLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "two at once" },
            { type: "tool_use", id: "a", name: "mcp__markdown-collab__mc_list", input: { file: "a.md" } },
            { type: "tool_use", id: "b", name: "Grep", input: { pattern: "x" } },
            { type: "tool_use", id: "c", name: "mcp__markdown-collab__mc_open" },
          ],
        },
      }),
    );
    expect(events.map((e) => (e.kind === "tool" ? e.name : e.kind))).toEqual([
      "mcp__markdown-collab__mc_list",
      "Grep",
      "mcp__markdown-collab__mc_open",
    ]);
    // A tool_use without input still parses, with an empty one.
    expect(events[2]).toEqual({ kind: "tool", name: "mcp__markdown-collab__mc_open", input: {} });
  });

  it("an assistant message with only text is other", () => {
    expect(parseStreamLine(line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }))).toEqual([
      { kind: "other" },
    ]);
  });

  it("init with our server connected, missing, or failed", () => {
    const init = (servers: unknown): HeadlessEvent =>
      parseStreamLine(line({ type: "system", subtype: "init", mcp_servers: servers, tools: ["Read"] }))[0]!;
    expect(init([{ name: "markdown-collab", status: "connected" }])).toMatchObject({
      kind: "init",
      mcpServers: [{ name: "markdown-collab", status: "connected" }],
      tools: ["Read"],
    });
    expect(init([{ name: "other-server", status: "connected" }])).toMatchObject({
      mcpServers: [{ name: "other-server", status: "connected" }],
    });
    expect(init([{ name: "markdown-collab", status: "failed" }])).toMatchObject({
      mcpServers: [{ name: "markdown-collab", status: "failed" }],
    });
    // Missing entirely, or malformed: an empty list rather than a throw.
    expect(init(undefined)).toMatchObject({ kind: "init", mcpServers: [] });
    expect(init([null, "x", { name: "markdown-collab" }])).toMatchObject({
      mcpServers: [{ name: "markdown-collab", status: "unknown" }],
    });
  });

  it("reads an api_retry with its error category", () => {
    const [event] = parseStreamLine(
      line({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 1200,
        error_status: 401,
        error: "authentication_failed",
      }),
    );
    expect(event).toEqual({ kind: "retry", error: "authentication_failed", attempt: 2, status: 401 });
    expect(isAuthRetry("authentication_failed")).toBe(true);
    expect(isAuthRetry("oauth_org_not_allowed")).toBe(true);
    expect(isAuthRetry("rate_limit")).toBe(false);
    expect(isAuthRetry("server_error")).toBe(false);
  });

  it("reads an error result, including one that only has `errors`", () => {
    const [withText] = parseStreamLine(
      line({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", num_turns: 1 }),
    );
    expect(withText).toMatchObject({ kind: "result", isError: true, text: "Invalid API key · Please run /login" });
    const [withErrors] = parseStreamLine(
      line({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom", "bang"] }),
    );
    expect(withErrors).toMatchObject({ kind: "result", isError: true, subtype: "error_during_execution", text: "boom\nbang" });
    const [bare] = parseStreamLine(line({ type: "result" }));
    expect(bare).toMatchObject({ kind: "result", isError: false, subtype: "unknown", text: "" });
  });

  it("recognizes an error result that is really a sign-in problem", () => {
    for (const text of [
      "Invalid API key · Please run /login",
      "Not logged in · Please run /login",
      "You need to sign in to Claude Code",
      "Please log in again",
    ]) {
      expect(isAuthResultText(text), text).toBe(true);
    }
    for (const text of ["Something went wrong mid-run.", "Loginless mode", "overloaded_error"]) {
      expect(isAuthResultText(text), text).toBe(false);
    }
  });

  it("never throws on garbage or a truncated line", () => {
    const real = fs.readFileSync(path.join(FIXTURES, "real-ok.ndjson"), "utf8").split("\n")[2]!;
    for (const garbage of [
      "",
      "not json",
      "{",
      real.slice(0, Math.floor(real.length / 2)),
      "null",
      "42",
      '"string"',
      "[1,2]",
      line({ type: "system", subtype: "something_new" }),
      line({ type: "assistant", message: "not an object" }),
      line({ type: "assistant", message: { content: "nope" } }),
    ]) {
      expect(parseStreamLine(garbage), garbage).toEqual([{ kind: "other" }]);
    }
  });
});

describe("headless availability", () => {
  const ok = { trusted: true, binaryResolved: true, serverRunning: true, mcpFailedHere: false };

  it("is available only when everything lines up", () => {
    expect(decideHeadlessAvailability(ok)).toEqual({ ok: true });
  });

  it("names the most fundamental missing piece first", () => {
    expect(decideHeadlessAvailability({ ...ok, trusted: false, binaryResolved: false })).toEqual({
      ok: false,
      reason: "untrusted",
    });
    expect(decideHeadlessAvailability({ ...ok, binaryResolved: false, serverRunning: false })).toEqual({
      ok: false,
      reason: "not-installed",
    });
    expect(decideHeadlessAvailability({ ...ok, serverRunning: false, mcpFailedHere: true })).toEqual({
      ok: false,
      reason: "no-server",
    });
    expect(decideHeadlessAvailability({ ...ok, mcpFailedHere: true })).toEqual({
      ok: false,
      reason: "mcp-disabled",
    });
  });

  it("explains each reason in plain words", () => {
    expect(unavailableReasonText("untrusted")).toMatch(/isn't trusted/);
    expect(unavailableReasonText("not-installed")).toMatch(/isn't installed/);
    expect(unavailableReasonText("no-server")).toMatch(/tool server isn't running/);
    expect(unavailableReasonText("mcp-disabled")).toMatch(/MCP may be disabled/);
  });
});

describe("HEADLESS_SETTINGS", () => {
  it("switches the user's hooks off and nothing else", () => {
    expect(JSON.parse(HEADLESS_SETTINGS)).toEqual({ disableAllHooks: true });
  });
});
