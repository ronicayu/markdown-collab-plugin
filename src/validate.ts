import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { resolve as resolveAnchor } from "./anchor";
import { loadSidecar } from "./sidecar";
import type { Comment } from "./types";

interface FileReport {
  mdRelPath: string;
  schemaIssues: string[];
  orphanCount: number;
  orphanIds: string[];
  suspiciousResolved: string[];
  unknownVersion: boolean;
  missingMd: boolean;
}

/**
 * Walk every `.md` file in every workspace folder, load its sidecar, and
 * report three kinds of problems:
 *   • Schema-violation files (surfaced via `loadSidecar`'s onError callback).
 *   • Comments whose anchors would orphan against the current on-disk text.
 *   • Comments marked `resolved: true` whose most recent reply is from
 *     `"user"` — the user replied after marking resolved, which is suspicious.
 *
 * Results are written to the output channel; the command is purely observational.
 */
export async function runValidate(output: vscode.OutputChannel): Promise<void> {
  output.show(true);
  output.appendLine("");
  output.appendLine(`--- markdown-collab validate @ ${new Date().toISOString()} ---`);

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    output.appendLine("No workspace folder open. Nothing to validate.");
    return;
  }

  let totalFiles = 0;
  let totalSchemaIssues = 0;
  let totalOrphans = 0;
  let totalSuspicious = 0;
  let totalUnknownVersion = 0;
  let totalMissingMd = 0;

  for (const folder of folders) {
    output.appendLine(`\n# Folder: ${folder.uri.fsPath}`);
    // Walk sidecars directly so deleted .md files still surface their
    // orphaned sidecars (findFiles("**/*.md") would skip them entirely).
    const pattern = new vscode.RelativePattern(folder, ".markdown-collab/**/*.json");
    const sidecarUris = await vscode.workspace.findFiles(pattern);
    for (const sidecarUri of sidecarUris) {
      const report = await validateSidecarFile(output, folder, sidecarUri);
      if (!report) continue;
      totalFiles++;
      totalSchemaIssues += report.schemaIssues.length;
      totalOrphans += report.orphanCount;
      totalSuspicious += report.suspiciousResolved.length;
      if (report.unknownVersion) totalUnknownVersion++;
      if (report.missingMd) totalMissingMd++;
    }
  }

  output.appendLine("");
  output.appendLine(
    `Summary: ${totalFiles} sidecar(s) | ${totalSchemaIssues} schema issue(s) | ${totalOrphans} would-be-orphan(s) | ${totalSuspicious} suspicious-resolved comment(s) | ${totalUnknownVersion} unknown-version | ${totalMissingMd} missing-md.`,
  );
}

async function validateSidecarFile(
  output: vscode.OutputChannel,
  folder: vscode.WorkspaceFolder,
  sidecarUri: vscode.Uri,
): Promise<FileReport | null> {
  const sidecarPath = sidecarUri.fsPath;
  // Derive the referenced .md path: strip the .markdown-collab/ prefix and
  // the .json suffix. Sidecar lives at <folder>/.markdown-collab/<rel>.json
  // and the md file is at <folder>/<rel-without-.json>.
  const collabRoot = path.join(folder.uri.fsPath, ".markdown-collab");
  const rel = path.relative(collabRoot, sidecarPath);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !rel.endsWith(".json")) {
    return null;
  }
  const mdRelPath = rel.slice(0, -".json".length);
  const mdAbsPath = path.join(folder.uri.fsPath, mdRelPath);

  const report: FileReport = {
    mdRelPath,
    schemaIssues: [],
    orphanCount: 0,
    orphanIds: [],
    suspiciousResolved: [],
    unknownVersion: false,
    missingMd: false,
  };

  const schemaErrors: string[] = [];
  const loaded = await loadSidecar(sidecarPath, (msg) => schemaErrors.push(msg));
  if (schemaErrors.length > 0) report.schemaIssues.push(...schemaErrors);

  if (loaded?.mode === "read-only-unknown-version") {
    report.unknownVersion = true;
  }

  // Check referenced .md existence before attempting to resolve anchors.
  let mdExists = true;
  try {
    await fs.access(mdAbsPath);
  } catch {
    mdExists = false;
    report.missingMd = true;
  }

  // Orphan + suspicious checks require a loaded sidecar.
  if (loaded) {
    let text = "";
    if (mdExists) {
      try {
        text = await fs.readFile(mdAbsPath, "utf8");
      } catch {
        text = "";
      }
    }
    for (const comment of loaded.sidecar.comments) {
      // When .md is missing, every comment is effectively an orphan.
      if (!mdExists || resolveAnchor(text, comment.anchor) === null) {
        report.orphanCount++;
        report.orphanIds.push(comment.id);
      }
      if (isSuspiciouslyResolved(comment)) {
        report.suspiciousResolved.push(comment.id);
      }
    }
  }

  writeReport(output, report);
  return report;
}

function isSuspiciouslyResolved(comment: Comment): boolean {
  if (!comment.resolved) return false;
  if (comment.replies.length === 0) return false;
  const last = comment.replies[comment.replies.length - 1];
  return last.author === "user";
}

function writeReport(output: vscode.OutputChannel, report: FileReport): void {
  const issues =
    report.schemaIssues.length +
    report.orphanCount +
    report.suspiciousResolved.length +
    (report.unknownVersion ? 1 : 0) +
    (report.missingMd ? 1 : 0);
  // Only print a line per file when there's something to report — keeps the
  // summary line authoritative for clean runs.
  if (issues === 0) return;
  output.appendLine(`  • ${report.mdRelPath}`);
  if (report.missingMd) {
    output.appendLine(
      `      referenced .md file missing — sidecar orphaned on disk`,
    );
  }
  if (report.unknownVersion) {
    output.appendLine(
      `      version is newer than plugin supports (read-only)`,
    );
  }
  for (const err of report.schemaIssues) {
    output.appendLine(`      schema: ${err}`);
  }
  if (report.orphanCount > 0) {
    output.appendLine(
      `      orphaned: ${report.orphanCount} comment(s) [${report.orphanIds.join(", ")}]`,
    );
  }
  if (report.suspiciousResolved.length > 0) {
    output.appendLine(
      `      suspicious-resolved: ${report.suspiciousResolved.join(", ")} (last reply from "user" after resolve)`,
    );
  }
}
