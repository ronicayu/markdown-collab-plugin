// Collect the diagnostics snapshot from the live VS Code host.
//
// Split from `diagnostics.ts` so the report's wording stays pure and testable:
// everything that touches `vscode` is here, everything that formats is there.
// Every probe is individually guarded — a diagnostics command that throws
// while diagnosing is worse than one that reports "unknown".

import * as os from "os";
import * as vscode from "vscode";
import { parse as parseInline } from "./inlineComments/format";
import { claudePending } from "./claudePendingService";
import { currentMcpServer } from "./mcpServer";
import { checkClaudeSkill, installedClaudePlugin } from "./skill";
import { CONVENTIONS_REL } from "./reviewConventions";
import type { DiagnosticsSnapshot } from "./diagnostics";
import { lookupClaude, headlessAvailability } from "./transports/headlessHost";
import { isFinished, lastHeadlessRun, unavailableReasonText } from "./transports/headless";
import { currentCopilotProvider, hasCursorInAppApi, isAgentConnected } from "./mcpServer/agentConnections";
import { agentFolder } from "./workspaceFolder";
import { codexTablePresent } from "./mcpServer/clients/codex";

const REMEMBERED_SEND_MODE_KEY = "markdownCollab.rememberedSendMode";

/** Run `probe`, and fall back rather than let the diagnostics command fail. */
async function safe<T>(probe: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await probe();
  } catch {
    return fallback;
  }
}

export async function collectDiagnostics(
  context: vscode.ExtensionContext,
): Promise<DiagnosticsSnapshot> {
  const config = vscode.workspace.getConfiguration("markdownCollab");
  const folders = vscode.workspace.workspaceFolders ?? [];
  const server = currentMcpServer();

  const registered = await safe(async () => {
    const folder = agentFolder(context);
    if (!folder) return false;
    const uri = vscode.Uri.joinPath(folder.uri, ".mcp.json");
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    return text.includes("markdown-collab");
  }, false);

  const conventionsPresent = await safe(async () => {
    if (folders.length === 0) return false;
    const uri = vscode.Uri.joinPath(folders[0].uri, ...CONVENTIONS_REL.split("/"));
    await vscode.workspace.fs.stat(uri);
    return true;
  }, false);

  const skillStatus = await safe<DiagnosticsSnapshot["skillStatus"]>(
    () => checkClaudeSkill(os.homedir()),
    "unknown",
  );
  const claudePlugin = await safe(() => installedClaudePlugin(os.homedir()), null);

  // Reuses lookupClaude's per-activation cache (transports/headlessHost.ts) —
  // this never spawns its own `claude --version` probe; it reads whatever the
  // picker or headless availability check already found (or triggers the one
  // lookup lazily, the same as they would).
  const claudeBinary = await safe<DiagnosticsSnapshot["claudeBinary"]>(async () => {
    const lookup = await lookupClaude();
    return lookup.ok
      ? { path: lookup.claude.path, version: lookup.claude.version.raw }
      : { error: lookup.error };
  }, undefined);

  // Headless: available now, and the last finished run's
  // shape only — never the prompt or the report text `runHeadless` produced.
  const headless = await safe<DiagnosticsSnapshot["headless"]>(async () => {
    const availability = await headlessAvailability(context.workspaceState);
    const record = lastHeadlessRun();
    const state = record?.run.state;
    const lastRun =
      record && state && isFinished(state)
        ? {
            state: state.kind,
            fileLabel: record.fileLabel,
            turns: state.kind === "done" ? (state.numTurns ?? null) : null,
            costUsd: state.kind === "done" ? (state.costUsd ?? null) : null,
            failureReason:
              state.kind === "failed"
                ? state.detail
                : state.kind === "cancelled"
                  ? `cancelled (${state.reason})`
                  : null,
          }
        : null;
    return {
      available: availability.ok,
      unavailableReason: availability.ok ? null : unavailableReasonText(availability.reason),
      lastRun,
    };
  }, undefined);

  // Agent connections: in-process state for the clients
  // that don't write a file, plus a yes/no read of each client's config —
  // never its contents (a header the file happens to hold, port included, is
  // not secret; the token it never carries is what matters).
  const agentConnections = await safe<DiagnosticsSnapshot["agentConnections"]>(async () => {
    const folder = agentFolder(context);
    const readFile = async (...rel: string[]): Promise<string | null> => {
      if (!folder) return null;
      try {
        const uri = vscode.Uri.joinPath(folder.uri, ...rel);
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        return null;
      }
    };
    const cursorMcpJson = (await readFile(".cursor", "mcp.json"))?.includes("markdown-collab") ?? false;
    const codexText = await readFile(".codex", "config.toml");
    return {
      copilotConnected: currentCopilotProvider() !== null && isAgentConnected(context, "copilot"),
      cursorInAppConnected: hasCursorInAppApi() && isAgentConnected(context, "cursor-inapp"),
      // `.mcp.json` is the same file `registered` above already read.
      mcpJson: registered,
      cursorMcpJson,
      codexConfig: codexText !== null && codexTablePresent(codexText),
    };
  }, undefined);

  // Only markdown documents VS Code already has open — this must not walk the
  // workspace. A diagnostics command that scans a monorepo is one nobody runs.
  const documents: DiagnosticsSnapshot["documents"] = [];
  let pendingThreads = 0;
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId !== "markdown") continue;
    await safe(() => {
      const text = doc.getText();
      const parsed = parseInline(text);
      documents.push({
        path: vscode.workspace.asRelativePath(doc.uri),
        threads: parsed.threads.length,
        unresolved: parsed.threads.filter((t) => t.status === "open").length,
        suggestions: parsed.suggestions.length,
        brokenAnchors: parsed.unanchoredThreadIds.length + parsed.unanchoredSuggestionIds.length,
        hasCheckpoint: parsed.checkpoint !== null,
        bytes: Buffer.byteLength(text, "utf8"),
      });
      pendingThreads += claudePending.peek(doc.uri.toString()).threadIds.length;
    }, undefined);
  }

  const terminalNames = vscode.window.terminals.map((t) => t.name);

  return {
    extensionVersion: String(context.extension?.packageJSON?.version ?? "unknown"),
    vscodeVersion: vscode.version,
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.versions.node,
    sendMode: String(config.get("sendMode", "ask")),
    rememberedSendMode: (context.workspaceState.get<string>(REMEMBERED_SEND_MODE_KEY) ?? null),
    suggestMode: config.get<boolean>("proposeEditsAsSuggestions", false),
    skillStatus,
    claudePlugin,
    claudeBinary,
    headless,
    agentConnections,
    // The port is safe to report; the token is not, and is never read here.
    mcpServer: server ? { port: server.port, registered } : null,
    claudeTerminalVisible: terminalNames.some((n) => /claude/i.test(n)),
    terminalNames,
    workspaceFolders: folders.map((f) => f.uri.fsPath),
    documents,
    conventionsPresent,
    pendingThreads,
  };
}
