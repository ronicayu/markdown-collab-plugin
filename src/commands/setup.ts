import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { agentsSectionPresent, ensureAgentsSnippet, type AgentsSnippetOutcome } from "../agents";
import { installAgentsSkill, type AgentsSkillResult } from "../agentsSkill";
import { checkClaudeSkill, installClaudeSkill, removeLegacySkill, skillFingerprint } from "../skill";
import {
  LOCAL_MARKETPLACE_DIRNAME,
  installedLocalPlugin,
  setUpClaudePlugin,
  type ClaudeRunner,
} from "../claudePlugin";
import { spawnCommand } from "../transports/claudeBinary";
import { lookupClaude } from "../transports/headlessHost";
import { requireTrust } from "../trust";
import { buildTutorialDocument, TUTORIAL_REL } from "../tutorial";
import {
  currentMcpServer,
  ensureMcpJsonRegistration,
  mcpJsonConsentGranted,
  resetMcpJsonConsent,
} from "../mcpServer";
import {
  activateCopilotProvider,
  currentCopilotProvider,
  hasCursorInAppApi,
  isAgentConnected,
  markAgentDisconnected,
  removeClaudeMcpJson,
  removeCodexConfig,
  removeCursorCliConfig,
  unregisterCursorInApp,
} from "../mcpServer/agentConnections";
import { hasCopilotProviderApi } from "../mcpServer/clients/copilot";
import { activeMarkdownUri } from "../activeMarkdown";
import { agentFolder, setAgentFolder } from "../workspaceFolder";
import type { CommandDeps } from "./deps";

async function invokeOpenTutorial(log: Logger): Promise<void> {
  if (!requireTrust("The playground")) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Markdown Collab: open a folder first — the playground is written into your workspace.",
    );
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, TUTORIAL_REL);
  let exists = true;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    exists = false;
  }
  if (exists) {
    // Never silently overwrite: by the time someone re-runs this, the file is
    // usually full of their own experiments.
    const choice = await vscode.window.showWarningMessage(
      `${TUTORIAL_REL} already exists. Start over with a fresh copy?`,
      { modal: false },
      "Open the existing one",
      "Replace it",
    );
    if (choice === undefined) return;
    if (choice === "Replace it") {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(buildTutorialDocument(), "utf8"));
    }
  } else {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(buildTutorialDocument(), "utf8"));
    log.info("created playground document", { file: TUTORIAL_REL });
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", doc.uri);
}

const SKILL_PROMPT_KEY = "markdownCollab.skillPromptedFingerprint";
const NO_AGENT_PROMPT_KEY = "markdownCollab.noAgentPrompted";
const PLUGIN_PROMPT_KEY = "markdownCollab.pluginPromptedVersion";

export const CLAUDE_SETUP_MISSING =
  "Markdown Collab: Claude Code is installed but doesn't have the Markdown Collab plugin, " +
  "so it can't run the review workflow (/markdown-collab:review).";

/** Every `claude plugin …` step gets this long; a registry refresh is seconds. */
const PLUGIN_COMMAND_TIMEOUT_MS = 60_000;

/**
 * `claude <args>` through `execFile`: an argument array, never a command
 * string (on Windows a `.cmd` shim needs the shell, and `spawnCommand` quotes
 * every argument for it).
 */
export function claudeRunner(bin: string, log: Logger): ClaudeRunner {
  return (args) =>
    new Promise((resolve) => {
      const spec = spawnCommand(bin, args, process.platform);
      execFile(
        spec.command,
        spec.args,
        {
          shell: spec.shell,
          timeout: PLUGIN_COMMAND_TIMEOUT_MS,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          // A numeric `code` is the exit status; a string one (ENOENT) or none
          // at all (killed by the timeout) means there was no exit status.
          const exit = err ? (err as { code?: unknown }).code : 0;
          const code = typeof exit === "number" ? exit : null;
          log.trace(`claude ${args.join(" ")} → ${code ?? "no exit status"}`, { stdout, stderr });
          resolve({ code, stdout, stderr, error: code === null && err ? err.message : undefined });
        },
      );
    });
}

function pluginPaths(context: vscode.ExtensionContext): { sourcePluginDir: string; marketplaceDir: string } {
  return {
    sourcePluginDir: path.join(context.extensionPath, "plugin"),
    marketplaceDir: path.join(context.globalStorageUri.fsPath, LOCAL_MARKETPLACE_DIRNAME),
  };
}

/**
 * Plugin installs are checked once per extension version, through
 * `claude plugin list --json` (a process, so not on every activation): the
 * plugin comes from this extension's own local marketplace, so a version that
 * differs from the extension's means the Claude side is stale — and it is
 * updated then and there, without asking. The person agreed to the plugin when
 * they set it up, the update comes from the extension's own copy (no network,
 * nothing new to trust), and an "Update?" prompt dismissed once left them on
 * the old hooks and skill until the next release. A failed update says why and
 * offers Retry. A `claude`
 * with neither the plugin nor the standalone skill gets its own nudge in the
 * same once-per-version check, whatever other agent is connected.
 * "No agent connected yet" is said
 * once per machine, and not at all to a workspace that already has an agent.
 */
export async function maybePromptSkillUpdate(
  context: vscode.ExtensionContext,
  log: Logger,
): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const extensionVersion = String(context.extension?.packageJSON?.version ?? "");
  if (extensionVersion && context.globalState.get<string>(PLUGIN_PROMPT_KEY) !== extensionVersion) {
    await context.globalState.update(PLUGIN_PROMPT_KEY, extensionVersion);
    try {
      const lookup = await lookupClaude(log);
      if (lookup.ok) {
        const installed = await installedLocalPlugin(claudeRunner(lookup.claude.path, log));
        if (installed) {
          if (installed.version === extensionVersion) return;
          await updatePluginQuietly(context, lookup.claude.path, installed.version, log);
          return;
        }
        // Claude Code is here with neither the plugin nor the standalone skill,
        // so `/markdown-collab:review` is an unknown skill. Said regardless of
        // other agents: AGENTS.md or Copilot being connected says nothing about
        // whether Claude Code has the workflow. Once per extension version, by
        // the gate above.
        if ((await checkClaudeSkill(os.homedir())) === "missing") {
          // This covers what the no-agent nudge would say; don't follow it
          // with that one on the next window.
          await context.globalState.update(NO_AGENT_PROMPT_KEY, true);
          const choice = await vscode.window.showInformationMessage(CLAUDE_SETUP_MISSING, "Set Up Claude Code", "Not now");
          if (choice === "Set Up Claude Code") await vscode.commands.executeCommand("markdownCollab.installClaudeSkill");
          return;
        }
      }
    } catch (e) {
      log.error("plugin version check failed", e);
    }
  }

  let status: Awaited<ReturnType<typeof checkClaudeSkill>>;
  try {
    status = await checkClaudeSkill(os.homedir());
  } catch (e) {
    log.error("skill check failed", e);
    return;
  }
  if (status === "current") return;

  // The first-activation nudge points at Connect an Agent rather than assuming
  // Claude Code; "out of date" means the Claude skill specifically is stale,
  // so that branch goes straight to the Claude-specific update.
  const missing = status === "missing";
  if (missing) {
    if (context.globalState.get<boolean>(NO_AGENT_PROMPT_KEY)) return;
    if (await anyAgentConnected(context)) return;
    await context.globalState.update(NO_AGENT_PROMPT_KEY, true);
  } else {
    // Prompt at most once per bundled-skill version, so we don't nag on every
    // window the user opens.
    const fingerprint = skillFingerprint();
    if (context.globalState.get<string>(SKILL_PROMPT_KEY) === fingerprint) return;
    await context.globalState.update(SKILL_PROMPT_KEY, fingerprint);
  }

  const action = missing ? "Connect an Agent" : "Update";
  const message = missing
    ? "Markdown Collab: no agent is connected yet to read and act on your comments."
    : "Markdown Collab: the Claude skill is out of date. Update it so Claude follows the latest comment-handling behavior.";
  const choice = await vscode.window.showInformationMessage(message, action, "Not now");
  if (choice !== action) return;
  await vscode.commands.executeCommand(
    missing ? "markdownCollab.connectAgent" : "markdownCollab.installClaudeSkill",
  );
}

async function anyAgentConnected(context: vscode.ExtensionContext): Promise<boolean> {
  if (isAgentConnected(context, "copilot") || isAgentConnected(context, "cursor-inapp")) return true;
  if (mcpJsonConsentGranted(context)) return true;
  const folder = agentFolder(context);
  return folder !== undefined && agentsSectionPresent(folder.uri.fsPath);
}

/**
 * Bring an installed plugin up to this extension's version, then say so — or,
 * when it fails, say why and offer Retry. Not awaited past the update itself:
 * the messages are fire-and-forget, so activation never waits on a click.
 */
async function updatePluginQuietly(
  context: vscode.ExtensionContext,
  claudePath: string,
  from: string,
  log: Logger,
): Promise<void> {
  const outcome = await setUpClaudePlugin({ run: claudeRunner(claudePath, log), ...pluginPaths(context) });
  if (outcome.ok) {
    log.info("claude plugin updated", { from, to: outcome.version });
    void vscode.window.showInformationMessage(
      `Markdown Collab updated its Claude Code plugin (${from} → ${outcome.version}). ` +
        "Restart running Claude sessions (or run /reload-plugins) to pick it up.",
    );
    return;
  }
  log.warn("plugin update failed", { reason: outcome.reason });
  void Promise.resolve(
    vscode.window.showWarningMessage(
      `Markdown Collab couldn't update its Claude Code plugin (still ${from}) — ${outcome.reason}.`,
      "Retry",
    ),
  ).then((pick) => {
    if (pick === "Retry") void updatePluginQuietly(context, claudePath, from, log);
  });
}

/** What `setUpClaudeCode` did, for a caller that folds it into its own toast. */
export interface ClaudeCodeSetupOutcome {
  /** The plugin route succeeded (installed, updated, or already current) — as opposed to the standalone-skill fallback. */
  pluginOk: boolean;
  /** A hard failure (the skill install itself threw), for error-severity toasts. */
  failed: boolean;
  /** No `claude` binary and no `~/.claude`: Claude Code has never run here, nothing was written, and `summary` is a complete warning to show as is. */
  notFound: boolean;
  /** One line, or null when there's nothing to report (the user cancelled an overwrite prompt). No restart/reload hint — callers add their own. */
  summary: string | null;
}

/**
 * The plugin is the way —
 * skill, CLI on PATH, and the marker hook, installed from the extension's own
 * local marketplace — with the standalone skill as the fallback (a `claude`
 * binary the editor can't see but a `~/.claude` that exists, a Claude Code
 * without plugin commands, or any step failing). With neither a binary nor a
 * `~/.claude` nothing is written and the outcome says `notFound`.
 */
async function setUpClaudeCode(context: vscode.ExtensionContext, log: Logger): Promise<ClaudeCodeSetupOutcome> {
  const lookup = await lookupClaude(log);
  if (!lookup.ok) {
    if (!existsSync(path.join(os.homedir(), ".claude"))) {
      return {
        pluginOk: false,
        failed: false,
        notFound: true,
        summary:
          `Markdown Collab: Claude Code wasn't found (${lookup.error}). Install Claude Code, or set markdownCollab.claudePath ` +
          `if it's installed where your editor can't see it. Using another agent? Run "Markdown Collab: Connect an Agent".`,
      };
    }
    const summary = await installLegacySkillSummary(log, `Claude Code wasn't found (${lookup.error})`);
    return { pluginOk: false, failed: summary === null ? false : summary.startsWith("Failed"), notFound: false, summary };
  }
  const run = claudeRunner(lookup.claude.path, log);
  // Read what's there before touching anything, so "already current" can be
  // told apart from "just installed/updated" in the one-line summary.
  const before = await installedLocalPlugin(run).catch(() => null);
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Markdown Collab: setting up Claude Code…" },
    () => setUpClaudePlugin({ run, ...pluginPaths(context) }),
  );
  if (outcome.ok) {
    log.info("claude plugin installed", { version: outcome.version });
    // Both at once would register the workflow twice.
    const removed = await removeLegacySkill(os.homedir()).catch((e: unknown) => {
      log.warn("could not remove the standalone skill", e);
      return [] as string[];
    });
    if (removed.length > 0) log.info("removed the standalone skill", { files: removed.length });
    const summary =
      before?.version === outcome.version
        ? `Claude Code plugin already up to date (${outcome.version}).`
        : "Claude Code plugin installed.";
    return { pluginOk: true, failed: false, notFound: false, summary };
  }
  if (outcome.unsupported) log.info("claude plugin unavailable, using the standalone skill", { reason: outcome.reason });
  else log.warn("claude plugin setup failed, using the standalone skill", { reason: outcome.reason });
  const summary = await installLegacySkillSummary(log, outcome.reason);
  return { pluginOk: false, failed: summary === null ? false : summary.startsWith("Failed"), notFound: false, summary };
}

function showClaudeCodeNotFound(summary: string): void {
  void Promise.resolve(vscode.window.showWarningMessage(summary, "Connect an Agent")).then((pick) => {
    if (pick === "Connect an Agent") void vscode.commands.executeCommand("markdownCollab.connectAgent");
  });
}

async function invokeSetUpClaudeCode(context: vscode.ExtensionContext, log: Logger): Promise<void> {
  if (!requireTrust("Setting up Claude Code")) return;
  const outcome = await setUpClaudeCode(context, log);
  if (outcome.summary === null) return;
  if (outcome.notFound) {
    showClaudeCodeNotFound(outcome.summary);
    return;
  }
  if (outcome.failed) {
    void vscode.window.showErrorMessage(outcome.summary);
    return;
  }
  const hint = outcome.pluginOk
    ? " Restart running Claude sessions (or run /reload-plugins) to pick it up."
    : "";
  void vscode.window.showInformationMessage(`${outcome.summary}${hint}`);
}

/** The standalone install, with why the plugin wasn't used folded in. Null means nothing to report (the user cancelled an overwrite prompt). */
export async function installLegacySkillSummary(log: Logger, fallbackReason: string): Promise<string | null> {
  const why = `(the Claude Code plugin wasn't used: ${fallbackReason})`;
  try {
    const result = await installClaudeSkill(os.homedir());
    if (result.action === "installed") {
      return `Markdown Collab skill installed at ${result.path} ${why}.`;
    }
    if (result.action === "updated") {
      return `Markdown Collab skill updated at ${result.path} ${why}.`;
    }
    if (result.action === "already-present") {
      return `Markdown Collab skill is already up to date at ${result.path} ${why}.`;
    }
    const pick = await vscode.window.showWarningMessage(
      `A different Markdown Collab skill already exists at ${result.path}.`,
      "Overwrite",
      "Cancel",
    );
    if (pick !== "Overwrite") return null;
    const forced = await installClaudeSkill(os.homedir(), { force: true });
    return `Markdown Collab skill overwritten at ${forced.path}.`;
  } catch (e) {
    log.error("skill install failed", e);
    return `Failed to install the Claude skill: ${(e as Error).message}`;
  }
}

export function agentsSnippetSentence(action: AgentsSnippetOutcome, folderName: string): string {
  switch (action) {
    case "created":
      return `Created AGENTS.md in ${folderName} with the review-comment format.`;
    case "appended":
      return `Added the review-comment format to AGENTS.md in ${folderName}.`;
    case "refreshed":
      return `Refreshed the review-comment format in AGENTS.md in ${folderName}.`;
    case "already-present":
      return `AGENTS.md in ${folderName} already has the review-comment format.`;
    case "customized":
      return `AGENTS.md in ${folderName} has a hand-edited "Markdown review comments" section — left as is.`;
  }
}

const withTilde = (text: string, homeDir: string): string => text.split(homeDir).join("~");

export function agentsSkillSentence(result: AgentsSkillResult, homeDir: string): string {
  switch (result.action) {
    case "installed":
      return "Added the review skill to ~/.agents/skills.";
    case "updated":
      return "Updated the review skill in ~/.agents/skills.";
    case "already-present":
      return "The review skill in ~/.agents/skills is up to date.";
    case "exists-differs":
      return `${withTilde(result.path, homeDir)} is a different skill — left as is.`;
    case "refused":
      return `The review skill wasn't written: ${withTilde(result.reason, homeDir)} — left as is.`;
  }
}

/** A failure is shown here and comes back as null. */
async function applyAgentsSnippet(folder: vscode.WorkspaceFolder, log: Logger): Promise<string | null> {
  try {
    return agentsSnippetSentence(await ensureAgentsSnippet(folder.uri.fsPath), folder.name);
  } catch (e) {
    log.error("ensureAgentsSnippet failed", e);
    void vscode.window.showErrorMessage(
      `Failed to update AGENTS.md: ${(e as Error).message}`,
    );
    return null;
  }
}

async function applyAgentsSkill(log: Logger): Promise<string> {
  const home = os.homedir();
  try {
    return agentsSkillSentence(await installAgentsSkill(home), home);
  } catch (e) {
    log.error("installAgentsSkill failed", e);
    return `The review skill wasn't written to ~/.agents/skills: ${withTilde((e as Error).message, home)}`;
  }
}

async function invokeInitializeAgents(log: Logger): Promise<void> {
  if (!requireTrust("Writing AGENTS.md")) return;
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Open a workspace folder first to initialize AGENTS.md.",
    );
    return;
  }
  const sentence = await applyAgentsSnippet(folder, log);
  if (sentence) void vscode.window.showInformationMessage(sentence);
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const active = vscode.window.activeTextEditor?.document.uri ?? activeMarkdownUri();
  if (active) {
    const f = vscode.workspace.getWorkspaceFolder(active);
    if (f) return f;
  }
  if (folders.length === 1) return folders[0];
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: "Choose a workspace folder" },
  );
  return pick?.folder;
}

export interface ConnectAgentItem extends vscode.QuickPickItem {
  id: "claude" | "agents";
}

/**
 * Two choices, because there are two ways an agent gets the workflow and
 * \`mdc\`: Claude Code through its plugin, every other agent through
 * \`~/.agents/skills\` and AGENTS.md. Which agent it is doesn't change what is
 * written — \`mdc\` reaches the running editor on its own, so there is no
 * per-client tool registration to choose between.
 */
export function buildConnectAgentItems(): ConnectAgentItem[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      description: "Installs the Markdown Collab plugin: the review skill, the mdc command, and a guard against hand edits.",
    },
    {
      id: "agents",
      label: "Another agent — Cursor, Codex, Copilot, Windsurf, …",
      description: "Writes the AGENTS.md section and installs the review skill with the mdc command in ~/.agents/skills.",
    },
  ];
}

export interface FormatFirstIo {
  /** Write or refresh AGENTS.md; the sentence saying what happened, or null when it failed (already reported). */
  writeAgentsSnippet(): Promise<string | null>;
  /** Install the review skill and \`mdc\`; the sentence saying what happened. Never fails Connect. */
  installSkill(): Promise<string>;
  tell(message: string): void;
}

/** AGENTS.md, then the skill and \`mdc\` — everything an agent other than Claude Code needs. */
export async function connectFormatFirst(io: FormatFirstIo): Promise<"connected" | "failed"> {
  const written = await io.writeAgentsSnippet();
  if (written === null) return "failed";
  io.tell(
    `Markdown Collab: ${written} ${await io.installSkill()} Agents that read AGENTS.md or ~/.agents/skills now change ` +
      "reviewed files with mdc.",
  );
  return "connected";
}

export function toolServerDownMessage(): string {
  return vscode.workspace.workspaceFolders?.length
    ? "Markdown Collab: the review tool server isn't running — reload the window and try again. See the Markdown Collab output channel."
    : "Markdown Collab: open a folder first — the review tools need a workspace.";
}

async function invokeConnectAgent(deps: CommandDeps): Promise<void> {
  if (!requireTrust("Connecting an agent")) return;
  const { context, log } = deps;
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
    const chosen = await pickWorkspaceFolder();
    if (!chosen) return;
    await setAgentFolder(context, chosen);
  }
  const folder = agentFolder(context);
  const pick = await vscode.window.showQuickPick(buildConnectAgentItems(), {
    placeHolder: "Markdown Collab: connect an agent to your review comments",
  });
  if (!pick) return;

  if (pick.id === "agents") {
    if (!folder) {
      void vscode.window.showWarningMessage("Markdown Collab: open a folder first — AGENTS.md is written into it.");
      return;
    }
    await connectFormatFirst({
      writeAgentsSnippet: () => applyAgentsSnippet(folder, log),
      installSkill: () => applyAgentsSkill(log),
      tell: (message) => void vscode.window.showInformationMessage(message),
    });
    return;
  }

  // The plugin carries the skill, `mdc` and the guard hook, so Claude Code
  // needs nothing else: `mdc` finds the running editor by itself.
  const pluginOutcome = await setUpClaudeCode(context, log);
  if (pluginOutcome.notFound) {
    showClaudeCodeNotFound(pluginOutcome.summary!);
    return;
  }
  if (!pluginOutcome.summary) return;
  if (pluginOutcome.failed) {
    void vscode.window.showErrorMessage(`Markdown Collab: ${pluginOutcome.summary}`);
    return;
  }
  const hint = pluginOutcome.pluginOk ? " Restart running Claude sessions (or run /reload-plugins) to pick it up." : "";
  void vscode.window.showInformationMessage(`Markdown Collab: ${pluginOutcome.summary}${hint}`);
}

const FILES_KEPT = "AGENTS.md and the review skill in ~/.agents/skills are left as is";
const AGENTS_KEPT = ` ${FILES_KEPT} — other agents and workspaces may be reading them.`;

export interface DisconnectAgentItem extends vscode.QuickPickItem {
  id: "claude" | "cursor-inapp" | "cursor-cli" | "windsurf" | "codex" | "copilot" | "other";
}

/**
 * Disconnect only ever undoes the MCP registration. The AGENTS.md section
 * Connect wrote first is shared by every agent that reads
 * the file, so no single agent's Disconnect gets to remove it — each of those
 * items says so.
 */
export function buildDisconnectAgentItems(caps: { cursorInApp: boolean; copilot: boolean }): DisconnectAgentItem[] {
  const items: DisconnectAgentItem[] = [
    {
      id: "claude",
      label: "Claude Code",
      description: "Removes the markdown-collab entry from .mcp.json.",
      detail: "Leaves every other server in .mcp.json untouched.",
    },
  ];
  if (caps.cursorInApp) {
    items.push({
      id: "cursor-inapp",
      label: "Cursor (in-app agent)",
      description: "Unregisters the live server from Cursor's in-app agent.",
      detail: `Nothing was ever written to disk for this client — the registration just goes away for this session.${AGENTS_KEPT}`,
    });
  }
  items.push({
    id: "cursor-cli",
    label: "Cursor CLI (cursor-agent)",
    description: "Removes the markdown-collab entry from .cursor/mcp.json.",
    detail: `Leaves every other server in .cursor/mcp.json untouched.${AGENTS_KEPT}`,
  });
  items.push({
    id: "windsurf",
    label: "Windsurf (Cascade)",
    description: "Nothing to remove here.",
    detail: `The connection details were never saved by this extension. If you pasted them into ~/.codeium/windsurf/mcp_config.json, delete the markdown-collab entry there.${AGENTS_KEPT}`,
  });
  items.push({
    id: "codex",
    label: "Codex",
    description: "Removes the [mcp_servers.markdown-collab] table from .codex/config.toml.",
    detail: `Leaves every other table in .codex/config.toml untouched.${AGENTS_KEPT}`,
  });
  if (caps.copilot) {
    items.push({
      id: "copilot",
      label: "GitHub Copilot (agent mode)",
      description: "Unregisters the live server definition from Copilot.",
      detail: `Nothing was ever written to disk for this client — the registration just goes away for this session.${AGENTS_KEPT}`,
    });
  }
  items.push({
    id: "other",
    label: "Other agent…",
    description: "Nothing to remove.",
    detail: `The connection details were never saved, and their session token dies with this window.${AGENTS_KEPT}`,
  });
  return items;
}

async function invokeDisconnectAgent(deps: CommandDeps): Promise<void> {
  if (!requireTrust("Connecting an agent")) return;
  const { context } = deps;
  const folder = agentFolder(context);
  const items = buildDisconnectAgentItems({ cursorInApp: hasCursorInAppApi(), copilot: hasCopilotProviderApi() });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Markdown Collab: disconnect an agent",
  });
  if (!pick) return;

  switch (pick.id) {
    case "claude": {
      if (!folder) {
        void vscode.window.showWarningMessage("Markdown Collab: open a folder first.");
        break;
      }
      try {
        const outcome = await removeClaudeMcpJson(folder.uri);
        void vscode.window.showInformationMessage(
          outcome === "written"
            ? "Markdown Collab: removed the markdown-collab entry from .mcp.json."
            : "Markdown Collab: .mcp.json has no markdown-collab entry — nothing to remove.",
        );
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Markdown Collab: could not update .mcp.json — ${(e as Error).message}`,
        );
      }
      break;
    }
    case "cursor-inapp": {
      try {
        unregisterCursorInApp();
        await markAgentDisconnected(context, "cursor-inapp");
        void vscode.window.showInformationMessage(
          "Markdown Collab: unregistered from Cursor's in-app agent for this session.",
        );
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Markdown Collab: could not unregister from Cursor — ${(e as Error).message}`,
        );
      }
      break;
    }
    case "cursor-cli": {
      if (!folder) {
        void vscode.window.showWarningMessage("Markdown Collab: open a folder first.");
        break;
      }
      try {
        const outcome = await removeCursorCliConfig(folder.uri);
        void vscode.window.showInformationMessage(
          outcome === "written"
            ? "Markdown Collab: removed the markdown-collab entry from .cursor/mcp.json."
            : "Markdown Collab: .cursor/mcp.json has no markdown-collab entry — nothing to remove.",
        );
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Markdown Collab: could not update .cursor/mcp.json — ${(e as Error).message}`,
        );
      }
      break;
    }
    case "codex": {
      if (!folder) {
        void vscode.window.showWarningMessage("Markdown Collab: open a folder first.");
        break;
      }
      try {
        const outcome = await removeCodexConfig(folder.uri);
        void vscode.window.showInformationMessage(
          outcome === "written"
            ? "Markdown Collab: removed the markdown-collab table from .codex/config.toml."
            : "Markdown Collab: .codex/config.toml has no markdown-collab table — nothing to remove.",
        );
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Markdown Collab: could not update .codex/config.toml — ${(e as Error).message}`,
        );
      }
      break;
    }
    case "copilot": {
      const provider = currentCopilotProvider();
      if (!provider) {
        void vscode.window.showWarningMessage(
          "Markdown Collab: this editor build doesn't support the Copilot MCP provider API.",
        );
        break;
      }
      provider.setConnected(false);
      await markAgentDisconnected(context, "copilot");
      void vscode.window.showInformationMessage(
        "Markdown Collab: unregistered from GitHub Copilot for this session.",
      );
      break;
    }
    case "windsurf": {
      void vscode.window.showInformationMessage(
        `Markdown Collab: nothing to remove — the connection details were never saved by this extension. If you pasted them into ~/.codeium/windsurf/mcp_config.json, delete the markdown-collab entry there. ${FILES_KEPT}.`,
      );
      break;
    }
    case "other": {
      void vscode.window.showInformationMessage(
        `Markdown Collab: nothing to remove for a generic agent — its connection details were never saved. ${FILES_KEPT}.`,
      );
      break;
    }
  }
}

export function registerSetupCommands(deps: CommandDeps): void {
  const { context, rootLog, skillLog, reviewLog, log } = deps;

  // GitHub Copilot's agent-mode MCP discovery: registered
  // once at activation whenever the host supports it — older forks (Cursor,
  // Windsurf, VSCodium) simply don't have `vscode.lm.registerMcpServerDefinitionProvider`,
  // which is the feature-detect this goes through rather than raising
  // `engines.vscode`. `provideMcpServerDefinitions` still answers `[]` until
  // the human actually runs Connect an Agent → Copilot in this workspace —
  // registering the provider is not the same as opting in, so the remembered
  // answer (if any) is restored here too, ahead of the server having a handle
  // yet (see `reconnectAgents` in extension.ts for the rest of the restart).
  const copilotProvider = activateCopilotProvider(context);
  copilotProvider?.setConnected(isAgentConnected(context, "copilot"));

  context.subscriptions.push(
    vscode.commands.registerCommand("markdownCollab.connectAgent", async () => {
      await invokeConnectAgent(deps);
    }),
    vscode.commands.registerCommand("markdownCollab.disconnectAgent", async () => {
      await invokeDisconnectAgent(deps);
    }),
    // Internal (not in package.json): plain data about which agent clients are
    // wired up. The integration suite reads it through this command because it
    // loads its own copy of these modules, separate from the bundled extension,
    // so module-level state like the provider instance is invisible to it
    // otherwise. The diagnostics report is the other reader.
    vscode.commands.registerCommand("markdownCollab.agentConnectionStatus", () => ({
      copilotProviderRegistered: currentCopilotProvider() !== null,
      copilotConnected: isAgentConnected(context, "copilot"),
      cursorInAppAvailable: hasCursorInAppApi(),
      cursorInAppConnected: isAgentConnected(context, "cursor-inapp"),
    })),
    vscode.commands.registerCommand("markdownCollab.installClaudeSkill", async () => {
      await invokeSetUpClaudeCode(context, skillLog);
    }),
    // `reviewLog`, not `skillLog`: the tutorial is a review-view entry point,
    // logged like the rest of that surface.
    vscode.commands.registerCommand("markdownCollab.openTutorial", async () => {
      await invokeOpenTutorial(reviewLog);
    }),
    vscode.commands.registerCommand("markdownCollab.registerMcpServer", async () => {
      if (!requireTrust("Registering the review tools")) return;
      const handle = currentMcpServer();
      if (!handle) {
        void vscode.window.showWarningMessage(toolServerDownMessage());
        return;
      }
      // Clear the remembered answer so a previous "Not now" doesn't silently
      // swallow an explicit request.
      await resetMcpJsonConsent(context);
      await ensureMcpJsonRegistration(context, handle, rootLog.scope("mcp"));
    }),
    vscode.commands.registerCommand("markdownCollab.initializeAgents", async () => {
      await invokeInitializeAgents(log);
    }),
  );
}
