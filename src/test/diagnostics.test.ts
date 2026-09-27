// The diagnostics report. Its whole value is being pasteable into an issue,
// so what it says and what it refuses to say are both asserted here.

import { describe, expect, it } from "vitest";
import { formatDiagnostics, type DiagnosticsSnapshot } from "../diagnostics";

function snapshot(o: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    extensionVersion: "0.34.72",
    vscodeVersion: "1.131.0",
    platform: "darwin arm64",
    nodeVersion: "20.11.0",
    sendMode: "ask",
    rememberedSendMode: "terminal",
    suggestMode: false,
    skillStatus: "current",
    mcpServer: { port: 7391, registered: true },
    claudeTerminalVisible: true,
    terminalNames: ["Claude Review", "zsh"],
    workspaceFolders: ["/Users/x/proj"],
    documents: [
      {
        path: "docs/guide.md",
        threads: 3,
        unresolved: 2,
        suggestions: 1,
        brokenAnchors: 0,
        hasCheckpoint: true,
        bytes: 4096,
      },
    ],
    conventionsPresent: true,
    pendingThreads: 2,
    ...o,
  };
}

describe("formatDiagnostics", () => {
  it("leads with the facts a triager asks for first", () => {
    const out = formatDiagnostics(snapshot());
    expect(out).toContain("Extension: 0.34.72");
    expect(out).toContain("VS Code: 1.131.0 (darwin arm64, node 20.11.0)");
    expect(out).toContain("Send mode: ask (remembered: terminal)");
    expect(out).toContain("Skill: current");
  });

  it("reports the tool server by port and never by URL or token", () => {
    const out = formatDiagnostics(snapshot());
    expect(out).toContain("running on port 7391");
    expect(out).toContain("registered in .mcp.json: yes");
    expect(out).not.toContain("http://");
  });

  // 10x-plan-4 P0.2: "is the skill installed?" now has two answers.
  it("names the Claude Code plugin and its version when installed, and says so when not", () => {
    const withPlugin = formatDiagnostics(
      snapshot({ claudePlugin: { id: "markdown-collab@markdown-collab-local", version: "0.35.4" } }),
    );
    expect(withPlugin).toContain("Claude Code plugin: markdown-collab@markdown-collab-local 0.35.4");
    expect(formatDiagnostics(snapshot({ claudePlugin: null }))).toContain("Claude Code plugin: not installed");
    expect(formatDiagnostics(snapshot())).not.toContain("Claude Code plugin:");
  });

  it("says plainly when the tool server is down", () => {
    expect(formatDiagnostics(snapshot({ mcpServer: null }))).toContain("Tool server: not running");
  });

  it("summarizes each open document's review state", () => {
    const out = formatDiagnostics(snapshot());
    expect(out).toContain("docs/guide.md — 4096 bytes, 3 thread(s) (2 unresolved), 1 suggestion(s)");
    expect(out).toContain("has review checkpoint");
  });

  it("calls out broken anchors, which explain most 'my comment vanished' reports", () => {
    const out = formatDiagnostics(
      snapshot({
        documents: [
          {
            path: "a.md",
            threads: 2,
            unresolved: 2,
            suggestions: 0,
            brokenAnchors: 1,
            hasCheckpoint: false,
            bytes: 10,
          },
        ],
      }),
    );
    expect(out).toContain("1 broken anchor(s)");
  });

  it("handles the empty case without pretending", () => {
    const out = formatDiagnostics(
      snapshot({ workspaceFolders: [], documents: [], terminalNames: [] }),
    );
    expect(out).toContain("No folder open");
    expect(out).toContain("None open");
  });

  it("redacts a credential that reached the snapshot anyway", () => {
    // Defence in depth: a workspace path or a remembered mode should never
    // carry a token, but the report is the last thing between it and a
    // public issue.
    const token = "b".repeat(48);
    const out = formatDiagnostics(snapshot({ workspaceFolders: [`/tmp/x?token=${token}`] }));
    expect(out).not.toContain(token);
  });

  it("tells the reader to bring the log too", () => {
    expect(formatDiagnostics(snapshot())).toContain("output channel");
  });

  // 10x-plan-4 P3.4: the new paths — claude binary, headless, agent
  // connections — each render as an explicit "unknown" section rather than
  // silently vanishing when a snapshot doesn't carry them.
  it("reports every new P3.4 field as unknown when the snapshot doesn't carry it", () => {
    const out = formatDiagnostics(snapshot());
    expect(out).toContain("## Headless runs\n- Unknown (not checked)");
    expect(out).toContain("## Agent connections\n- Unknown (not checked)");
  });

  it("names the resolved claude binary and its version", () => {
    const out = formatDiagnostics(snapshot({ claudeBinary: { path: "/opt/homebrew/bin/claude", version: "2.1.283 (Claude Code)" } }));
    expect(out).toContain("Claude binary: /opt/homebrew/bin/claude (2.1.283 (Claude Code))");
  });

  it("says why the claude binary wasn't found, without pretending it's fine", () => {
    const out = formatDiagnostics(
      snapshot({ claudeBinary: { error: "no `claude` executable on PATH or in the usual install locations" } }),
    );
    expect(out).toContain("Claude binary: not found — no `claude` executable on PATH");
  });

  it("reports headless availability and why not, when unavailable", () => {
    const out = formatDiagnostics(
      snapshot({
        headless: {
          available: false,
          unavailableReason: "Claude Code isn't installed, or isn't on your PATH (set markdownCollab.claudePath)",
          lastRun: null,
        },
      }),
    );
    expect(out).toContain("Available: no — Claude Code isn't installed");
    expect(out).toContain("Last run: none this session");
  });

  it("summarizes the last headless run's state, turns, and cost — never the prompt or report text", () => {
    const out = formatDiagnostics(
      snapshot({
        headless: {
          available: true,
          unavailableReason: null,
          lastRun: { state: "done", fileLabel: "docs/guide.md", turns: 4, costUsd: 0.0231, failureReason: null },
        },
      }),
    );
    expect(out).toContain("Last run: done on docs/guide.md — 4 turn(s), est. $0.0231");
    expect(out).not.toContain("prompt");
  });

  it("names a failed or cancelled headless run's reason", () => {
    const out = formatDiagnostics(
      snapshot({
        headless: {
          available: true,
          unavailableReason: null,
          lastRun: { state: "failed", fileLabel: "a.md", turns: null, costUsd: null, failureReason: "not signed in" },
        },
      }),
    );
    expect(out).toContain("Last run: failed — not signed in on a.md");
  });

  it("reports each agent client's config file as yes/no, and in-process connections separately", () => {
    const out = formatDiagnostics(
      snapshot({
        agentConnections: {
          copilotConnected: true,
          cursorInAppConnected: false,
          mcpJson: true,
          cursorMcpJson: false,
          codexConfig: true,
        },
      }),
    );
    expect(out).toContain("Claude Code / generic MCP (.mcp.json): yes");
    expect(out).toContain("Cursor CLI (.cursor/mcp.json): no");
    expect(out).toContain("Codex (.codex/config.toml): yes");
    expect(out).toContain("Cursor in-app: no");
    expect(out).toContain("Copilot agent mode: yes");
  });
});
