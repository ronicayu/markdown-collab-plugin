import * as vscode from "vscode";
import type { Logger } from "../logging";
import { collectDiagnostics } from "../diagnosticsHost";
import { formatDiagnostics } from "../diagnostics";
import type { CommandDeps } from "./deps";

/**
 * Build the diagnostics report, open it, and mirror it into the log so the
 * channel a user copies already carries the environment it was produced in.
 */
async function invokeReportDiagnostics(
  context: vscode.ExtensionContext,
  log: Logger,
): Promise<void> {
  let report: string;
  try {
    report = formatDiagnostics(await collectDiagnostics(context));
  } catch (e) {
    log.error("could not collect diagnostics", e);
    void vscode.window.showErrorMessage(
      `Markdown Collab: could not collect diagnostics — ${(e as Error).message}`,
    );
    return;
  }
  log.info(`diagnostics report\n${report}`);
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
  await vscode.window.showTextDocument(doc, { preview: false });
  const choice = await vscode.window.showInformationMessage(
    "Diagnostics collected. Copy this into your bug report, along with the output channel.",
    "Copy to clipboard",
    "Show output channel",
  );
  if (choice === "Copy to clipboard") await vscode.env.clipboard.writeText(report);
  if (choice === "Show output channel") log.show();
}

export function registerDiagnosticsCommands(deps: CommandDeps): void {
  const { context, rootLog, diagnosticsLog } = deps;
  context.subscriptions.push(
    vscode.commands.registerCommand("markdownCollab.showOutput", () => {
      rootLog.show();
    }),
    vscode.commands.registerCommand("markdownCollab.reportDiagnostics", async () => {
      await invokeReportDiagnostics(context, diagnosticsLog);
    }),
  );
}
