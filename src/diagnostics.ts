// The environment report a bug starts with.
//
// The report builder is pure — it takes a plain snapshot and returns text — so
// its wording is testable and it can't itself throw inside a failure path.
// Collecting the snapshot from the live VS Code host is `collectDiagnostics`.

import { redact } from "./logging";

export interface DiagnosticsSnapshot {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  nodeVersion: string;
  sendMode: string;
  rememberedSendMode: string | null;
  suggestMode: boolean;
  skillStatus: "missing" | "outdated" | "current" | "unknown";
  /**
   * The Claude Code plugin as Claude Code's registry records it; null when not
   * installed. Optional so a snapshot built without the probe still renders.
   */
  claudePlugin?: { id: string; version: string } | null;
  /**
   * The `claude` binary, resolved through transports/claudeBinary.ts via
   * headlessHost's cached lookup — the diagnostics command
   * reads whatever activation already found, it never spawns its own probe.
   * Optional so a snapshot built without collecting it renders as "unknown"
   * rather than a false negative.
   */
  claudeBinary?: { path: string; version: string } | { error: string };
  /**
   * Headless availability and the last run's summary, from
   * `markdownCollab.headlessStatus` — state, file label, turn count, and
   * estimated cost only. Never the prompt or the report text: those are the
   * one thing a user pastes into a public issue that must never carry what
   * the agent read or wrote.
   */
  headless?: {
    available: boolean;
    unavailableReason: string | null;
    lastRun: {
      state: string;
      fileLabel: string;
      turns: number | null;
      costUsd: number | null;
      failureReason: string | null;
    } | null;
  };
  /**
   * Which agent clients are wired up: the in-process
   * connections from `markdownCollab.agentConnectionStatus`, plus a yes/no
   * read of each client's config file — never its contents.
   */
  agentConnections?: {
    copilotConnected: boolean;
    cursorInAppConnected: boolean;
    mcpJson: boolean;
    cursorMcpJson: boolean;
    codexConfig: boolean;
  };
  /** null when the tool server isn't running. Never carries the token. */
  mcpServer: { port: number; registered: boolean } | null;
  claudeTerminalVisible: boolean;
  terminalNames: string[];
  workspaceFolders: string[];
  documents: Array<{
    path: string;
    threads: number;
    unresolved: number;
    suggestions: number;
    brokenAnchors: number;
    hasCheckpoint: boolean;
    bytes: number;
  }>;
  conventionsPresent: boolean;
  pendingThreads: number;
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

/**
 * Render a snapshot as the block a user pastes into an issue. Markdown, so it
 * survives a paste into GitHub; redacted, because a workspace path or a
 * remembered URL can carry a token.
 */
export function formatDiagnostics(s: DiagnosticsSnapshot): string {
  const lines: string[] = [];
  lines.push("# Markdown Collab — diagnostics");
  lines.push("");
  lines.push("## Environment");
  lines.push(`- Extension: ${s.extensionVersion}`);
  lines.push(`- VS Code: ${s.vscodeVersion} (${s.platform}, node ${s.nodeVersion})`);
  lines.push("");
  lines.push("## Configuration");
  lines.push(`- Send mode: ${s.sendMode}${s.rememberedSendMode ? ` (remembered: ${s.rememberedSendMode})` : ""}`);
  lines.push(`- Suggest mode: ${yesNo(s.suggestMode)}`);
  lines.push(`- Review conventions file: ${yesNo(s.conventionsPresent)}`);
  lines.push("");
  lines.push("## Claude wiring");
  lines.push(`- Skill: ${s.skillStatus}`);
  // `undefined` is left as a silent omission, so a snapshot built without the
  // field renders as absent rather than a false "not installed".
  if (s.claudePlugin !== undefined) {
    lines.push(
      `- Claude Code plugin: ${s.claudePlugin ? `${s.claudePlugin.id} ${s.claudePlugin.version}` : "not installed"}`,
    );
  }
  if (s.claudeBinary === undefined) {
    lines.push("- Claude binary: unknown");
  } else if ("error" in s.claudeBinary) {
    lines.push(`- Claude binary: not found — ${s.claudeBinary.error}`);
  } else {
    lines.push(`- Claude binary: ${s.claudeBinary.path} (${s.claudeBinary.version})`);
  }
  lines.push(
    s.mcpServer
      ? `- Tool server: running on port ${s.mcpServer.port}, registered in .mcp.json: ${yesNo(s.mcpServer.registered)}`
      : "- Tool server: not running",
  );
  lines.push(`- Claude terminal detected: ${yesNo(s.claudeTerminalVisible)}`);
  if (s.terminalNames.length > 0) {
    lines.push(`- Open terminals: ${s.terminalNames.join(", ")}`);
  }
  lines.push(`- Threads awaiting a reply: ${s.pendingThreads}`);
  lines.push("");
  lines.push("## Headless runs");
  if (s.headless === undefined) {
    lines.push("- Unknown (not checked)");
  } else {
    lines.push(
      `- Available: ${yesNo(s.headless.available)}${
        s.headless.available ? "" : ` — ${s.headless.unavailableReason ?? "unknown reason"}`
      }`,
    );
    const last = s.headless.lastRun;
    if (!last) {
      lines.push("- Last run: none this session");
    } else {
      const turns = last.turns === null ? "unknown turns" : `${last.turns} turn(s)`;
      const cost = last.costUsd === null ? "cost unknown" : `est. $${last.costUsd.toFixed(4)}`;
      const outcome = last.failureReason ? `${last.state} — ${last.failureReason}` : last.state;
      lines.push(`- Last run: ${outcome} on ${last.fileLabel} — ${turns}, ${cost}`);
    }
  }
  lines.push("");
  lines.push("## Agent connections");
  if (s.agentConnections === undefined) {
    lines.push("- Unknown (not checked)");
  } else {
    const a = s.agentConnections;
    lines.push(`- Claude Code / generic MCP (.mcp.json): ${yesNo(a.mcpJson)}`);
    lines.push(`- Cursor CLI (.cursor/mcp.json): ${yesNo(a.cursorMcpJson)}`);
    lines.push(`- Codex (.codex/config.toml): ${yesNo(a.codexConfig)}`);
    lines.push(`- Cursor in-app: ${yesNo(a.cursorInAppConnected)}`);
    lines.push(`- Copilot agent mode: ${yesNo(a.copilotConnected)}`);
  }
  lines.push("");
  lines.push("## Workspace");
  if (s.workspaceFolders.length === 0) {
    lines.push("- No folder open");
  } else {
    for (const f of s.workspaceFolders) lines.push(`- ${f}`);
  }
  lines.push("");
  lines.push("## Open markdown documents");
  if (s.documents.length === 0) {
    lines.push("- None open");
  } else {
    for (const d of s.documents) {
      const flags: string[] = [];
      if (d.brokenAnchors > 0) flags.push(`${d.brokenAnchors} broken anchor(s)`);
      if (d.hasCheckpoint) flags.push("has review checkpoint");
      lines.push(
        `- ${d.path} — ${d.bytes} bytes, ${d.threads} thread(s) (${d.unresolved} unresolved), ` +
          `${d.suggestions} suggestion(s)${flags.length ? ` — ${flags.join(", ")}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("_Paste this with the Markdown Collab output channel (set to Trace) when reporting a problem._");
  return redact(lines.join("\n"));
}
