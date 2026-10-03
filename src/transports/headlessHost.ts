// The VS Code side of headless runs (10x-plan-4 P0.1): is it available here,
// start one, and tell the human how it went.
//
// `headless.ts` owns the process and knows nothing about VS Code; this owns
// the settings, the workspace flag, the toasts, and the fallbacks. The send
// dispatcher (`commands/send.ts`) decides *whether* to run headless and hands
// over a way back to the terminal path; everything after that is here.
//
// Fallbacks are part of the design, not error handling. A headless run can
// find out only after starting that Claude Code won't load our server (MCP
// disabled by policy) or isn't signed in. The first is remembered per
// workspace and the payload goes to the terminal instead, so the human's click
// still reaches Claude; the second offers a terminal to sign in from, and
// sends there only if asked — an unauthenticated terminal would fail the same
// way.

import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { currentMcpServer } from "../mcpServer";
import { claudePending } from "../claudePendingService";
import { headlessSystemPrompt } from "../skillText";
import type { ReviewPayload } from "../sendToClaude";
import { firstLine, headlessDoneToast, headlessReportDocument } from "../headlessStatusText";
import {
  defaultResolveEnv,
  probeClaudeVersion,
  resolveClaudeBinary,
  type ClaudeBinarySource,
  type ClaudeVersion,
} from "./claudeBinary";
import {
  HeadlessRun,
  sweepStaleHeadlessDirs,
  activeHeadlessRun,
  activeHeadlessRuns,
  decideHeadlessAvailability,
  lastHeadlessRun,
  trackHeadlessRun,
  unavailableReasonText,
  type FinishedHeadlessState,
  type HeadlessRunRecord,
  type HeadlessUnavailableReason,
} from "./headless";

/** Set when a run found Claude Code unable to load our server in this workspace. */
export const MCP_UNAVAILABLE_KEY = "markdownCollab.headlessMcpUnavailable";

export interface ResolvedClaude {
  path: string;
  version: ClaudeVersion;
  source: ClaudeBinarySource;
}

type ClaudeLookup = { ok: true; claude: ResolvedClaude } | { ok: false; error: string };

/**
 * One lookup per activation, keyed by the `claudePath` setting so changing it
 * takes effect without a reload. The probe spawns a process; the picker must
 * not do that on every click.
 */
let lookupCache: { key: string; lookup: Promise<ClaudeLookup> } | null = null;

export function lookupClaude(log?: Logger): Promise<ClaudeLookup> {
  const configured =
    vscode.workspace.getConfiguration("markdownCollab").get<string>("claudePath", "") ?? "";
  if (lookupCache && lookupCache.key === configured) return lookupCache.lookup;
  const lookup = (async (): Promise<ClaudeLookup> => {
    const found = resolveClaudeBinary(configured, defaultResolveEnv());
    if (!found.ok) {
      log?.info("claude binary not found", { reason: found.error });
      return { ok: false, error: found.error };
    }
    const probe = await probeClaudeVersion(found.path);
    if (!probe.ok) {
      log?.warn("claude --version probe failed", { binary: found.path, error: probe.error });
      return { ok: false, error: probe.error };
    }
    log?.info("claude binary found", { binary: found.path, via: found.source, version: probe.version.raw });
    return { ok: true, claude: { path: found.path, version: probe.version, source: found.source } };
  })();
  lookupCache = { key: configured, lookup };
  return lookup;
}

/**
 * Whether Claude Code is on this machine — the same `claude` lookup (and the
 * same cache) headless availability uses, so however many editors ask there is
 * one probe. Resolves false in an untrusted workspace without probing: nothing
 * is going to run it, and `claudePath` there is not ours to trust. For
 * surfaces that only matter to Claude Code users (the skill banner) and so
 * stay quiet until this answers yes.
 */
export async function claudeBinaryFound(log?: Logger): Promise<boolean> {
  if (!vscode.workspace.isTrusted) return false;
  return (await lookupClaude(log)).ok;
}

export type HeadlessAvailability =
  | { ok: true; claude: ResolvedClaude; server: { url: string; token: string } }
  | { ok: false; reason: HeadlessUnavailableReason; detail?: string };

/** Everything that has to be true before a headless run may start. */
export async function headlessAvailability(
  workspaceState: vscode.Memento,
  log?: Logger,
): Promise<HeadlessAvailability> {
  const trusted = vscode.workspace.isTrusted;
  const server = currentMcpServer();
  const mcpFailedHere = workspaceState.get<boolean>(MCP_UNAVAILABLE_KEY) === true;
  // No probe in an untrusted workspace: nothing is going to run it.
  const lookup = trusted ? await lookupClaude(log) : null;
  const decision = decideHeadlessAvailability({
    trusted,
    binaryResolved: lookup?.ok === true,
    serverRunning: server !== null,
    mcpFailedHere,
  });
  if (!decision.ok) {
    return { ok: false, reason: decision.reason, detail: lookup && !lookup.ok ? lookup.error : undefined };
  }
  if (!lookup?.ok || !server) throw new Error("unreachable: availability decided without a binary or server");
  return { ok: true, claude: lookup.claude, server: { url: server.url, token: server.token } };
}

/**
 * Part of Reset Send Mode: forget that MCP failed here, and look for the binary
 * again (the human may have just installed it or fixed `claudePath`).
 */
export async function resetHeadlessFailures(workspaceState: vscode.Memento): Promise<void> {
  await workspaceState.update(MCP_UNAVAILABLE_KEY, undefined);
  lookupCache = null;
}

/** The most recent fallback to the terminal, for diagnostics and tests. */
let lastFallback: { reason: string; at: string } | null = null;

export interface HeadlessDelivery {
  payload: ReviewPayload;
  /** The final prompt: the inline-skill variant, conventions included. */
  prompt: string;
  folder: vscode.WorkspaceFolder;
  log: Logger;
  workspaceState: vscode.Memento;
  ready: Extract<HeadlessAvailability, { ok: true }>;
  /** Send this same payload through the terminal path instead. */
  fallbackToTerminal(): Promise<void>;
  /** Open a terminal running `claude`, for signing in. */
  startTerminal(): void;
}

/**
 * Start a headless run for this payload. Returns once the process is started
 * (or the human declined to replace a run already going) — the run itself
 * continues in the background and reports through the status bar.
 */
export async function runHeadless(d: HeadlessDelivery): Promise<"started" | "declined"> {
  const key = d.folder.uri.fsPath;
  const existing = activeHeadlessRun(key);
  if (existing) {
    const choice = await vscode.window.showWarningMessage(
      `Claude is still working on ${existing.fileLabel} in this folder.`,
      "Cancel it and run this one",
      "Keep it running",
    );
    if (choice !== "Cancel it and run this one") {
      d.log.info("kept the running headless run; new send dropped", { running: existing.fileLabel });
      return "declined";
    }
    existing.run.cancel("user");
    await existing.run.finished;
  }

  const rels = d.payload.files ?? [d.payload.file];
  const model = vscode.workspace.getConfiguration("markdownCollab").get<string>("headlessModel", "") ?? "";
  const run = new HeadlessRun({
    binaryPath: d.ready.claude.path,
    version: d.ready.claude.version,
    cwd: key,
    prompt: d.prompt,
    systemPrompt: headlessSystemPrompt(),
    server: d.ready.server,
    model,
    fileLabel: d.payload.file,
    log: d.log,
  });
  const record: HeadlessRunRecord = {
    key,
    fileLabel: d.payload.file,
    files: rels.map((rel) => path.join(key, rel)),
    run,
  };
  try {
    trackHeadlessRun(record);
  } catch (e) {
    // Another send won the race for this folder while we waited on the cancel.
    d.log.warn("headless run not started", (e as Error).message);
    void vscode.window.showWarningMessage(`Claude is already working in this folder — try again when it finishes.`);
    return "declined";
  }
  const docKeys = rels.map((rel) => vscode.Uri.joinPath(d.folder.uri, rel).toString());
  void run.start().then((final) => onFinished(record, final, docKeys, d));
  return "started";
}

async function onFinished(
  record: HeadlessRunRecord,
  final: FinishedHeadlessState,
  docKeys: string[],
  d: HeadlessDelivery,
): Promise<void> {
  // The process is gone, so nothing is working on these files any more —
  // whatever the pass got through, and whether or not it ended with mc_check.
  // Leaving the "working" row up would claim otherwise.
  for (const key of docKeys) claudePending.noteComplete(key);

  switch (final.kind) {
    case "done": {
      const choice = await vscode.window.showInformationMessage(
        headlessDoneToast(record.fileLabel, final.text),
        "Show report",
        "Open in Markdown Collab",
      );
      if (choice === "Show report") {
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: headlessReportDocument(final.text, final.numTurns, final.costUsd),
        });
        await vscode.window.showTextDocument(doc, { preview: false });
      } else if (choice === "Open in Markdown Collab") {
        await openReviewView(record);
      }
      return;
    }
    case "cancelled": {
      if (final.reason === "timeout") {
        const choice = await vscode.window.showWarningMessage(
          `Markdown Collab: Claude ran past its time budget on ${record.fileLabel} and was stopped.`,
          "Show logs",
        );
        if (choice === "Show logs") await showLogs();
      }
      return;
    }
    case "failed":
      break;
  }

  if (final.reason === "mcp-unavailable") {
    // Remembered: every later headless send here would fail the same way until
    // something changes, and Reset Send Mode is how the human says it has.
    await d.workspaceState.update(MCP_UNAVAILABLE_KEY, true);
    lastFallback = { reason: final.reason, at: new Date().toISOString() };
    d.log.info("falling back to the terminal for this send", { reason: final.reason, detail: final.detail });
    void vscode.window.showWarningMessage(
      "Markdown Collab: Claude Code couldn't use the review tools here (MCP may be disabled for Claude), so " +
        "this was sent to your Claude terminal instead. Run \"Markdown Collab: Reset Send Mode\" to try " +
        "running Claude for you again.",
    );
    await d.fallbackToTerminal();
    return;
  }

  if (final.reason === "auth") {
    const choice = await vscode.window.showWarningMessage(
      "Claude Code isn't signed in — run `claude` once in a terminal to sign in, then try again.",
      "Open terminal",
    );
    if (choice !== "Open terminal") return;
    d.startTerminal();
    // Not pasted straight away: the new terminal opens on Claude's sign-in
    // screen, which is no place for a review prompt. Offer it once they're in.
    const send = await vscode.window.showInformationMessage(
      `Once Claude is signed in, send the review of ${record.fileLabel} to that terminal?`,
      "Send to Claude terminal",
    );
    if (send === "Send to Claude terminal") await d.fallbackToTerminal();
    return;
  }

  const choice = await vscode.window.showErrorMessage(
    `Markdown Collab: the Claude run on ${record.fileLabel} failed — ${firstLine(final.detail, 200)}`,
    "Show logs",
  );
  if (choice === "Show logs") await showLogs();
}

/** The run's first file in the review view, on the first thread the agent opened that you haven't answered. */
export async function openReviewView(record: HeadlessRunRecord): Promise<void> {
  const first = record.files[0];
  if (!first) return;
  await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", vscode.Uri.file(first), {
    focusNewFromAgent: true,
  });
}

export async function showLogs(): Promise<void> {
  await vscode.commands.executeCommand("markdownCollab.showOutput");
}

/** Cancel every active run. Returns how many were running. */
export function cancelHeadlessRuns(): number {
  const runs = activeHeadlessRuns();
  for (const r of runs) r.run.cancel("user");
  return runs.length;
}

function snapshot(r: HeadlessRunRecord): Record<string, unknown> {
  return {
    folder: r.key,
    file: r.fileLabel,
    state: r.run.state,
    tempDir: r.run.tempDir,
    pid: r.run.pid,
    servers: r.run.initServers,
  };
}

/**
 * Where headless stands, as plain data: availability, the active and last runs,
 * the last fallback. Never the token, never a prompt. Backs the internal
 * `markdownCollab.headlessStatus` command (integration tests, diagnostics).
 */
export async function headlessStatusSnapshot(
  workspaceState: vscode.Memento,
  log?: Logger,
): Promise<Record<string, unknown>> {
  const availability = await headlessAvailability(workspaceState, log);
  const lookup = vscode.workspace.isTrusted ? await lookupClaude(log) : null;
  const last = lastHeadlessRun();
  return {
    available: availability.ok,
    unavailableReason: availability.ok ? null : unavailableReasonText(availability.reason),
    binary: lookup?.ok ? { path: lookup.claude.path, version: lookup.claude.version.raw } : null,
    serverRunning: currentMcpServer() !== null,
    mcpUnavailable: workspaceState.get<boolean>(MCP_UNAVAILABLE_KEY) === true,
    active: activeHeadlessRuns().map(snapshot),
    last: last ? snapshot(last) : null,
    lastFallback,
  };
}

/**
 * Housekeeping at activation: temp directories from runs that never cleaned up
 * (VS Code quit or crashed mid-run). They hold no secret — the token only ever
 * lived in the child's environment — but they shouldn't accumulate either.
 */
export function sweepHeadlessTempDirs(log?: Logger): void {
  void sweepStaleHeadlessDirs()
    .then((n) => {
      if (n > 0) log?.info("removed stale headless temp directories", { count: n });
    })
    .catch(() => undefined);
}
