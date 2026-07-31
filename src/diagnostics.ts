// The environment report a bug starts with.
//
// Nearly every "it didn't work" needs the same six facts before anything else
// can be said: which version, which send mode, is the skill installed and
// current, is the tool server up, is a Claude terminal visible, and what does
// the document actually contain. Asking for them one message at a time is how
// a diagnosis takes three days.
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
  /** Configured send mode, plus what was actually remembered for this workspace. */
  sendMode: string;
  rememberedSendMode: string | null;
  suggestMode: boolean;
  skillStatus: "missing" | "outdated" | "current" | "unknown";
  /** null when the tool server isn't running. Never carries the token. */
  mcpServer: { port: number; registered: boolean } | null;
  claudeTerminalVisible: boolean;
  terminalNames: string[];
  workspaceFolders: string[];
  /** Per-document review state for the open markdown files. */
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
