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
import { checkClaudeSkill } from "./skill";
import { CONVENTIONS_REL } from "./reviewConventions";
import type { DiagnosticsSnapshot } from "./diagnostics";

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
    if (folders.length === 0) return false;
    const uri = vscode.Uri.joinPath(folders[0].uri, ".mcp.json");
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
