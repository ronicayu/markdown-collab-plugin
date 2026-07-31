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
});
