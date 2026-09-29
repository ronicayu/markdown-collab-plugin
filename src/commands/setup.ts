// First-run and setup commands: Set Up Claude Code (the plugin, or the
// standalone skill as a fallback), AGENTS.md, the playground tutorial, and
// re-registering the MCP server (10x-plan-4 P3.2 split of extension.ts).

import { execFile } from "node:child_process";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { ensureAgentsSnippet } from "../agents";
import { checkClaudeSkill, installClaudeSkill, removeLegacySkill, skillFingerprint } from "../skill";
import {
  LOCAL_MARKETPLACE_DIRNAME,
  installedLocalPlugin,
  setUpClaudePlugin,
  type ClaudeRunner,
} from "../claudePlugin";
import { spawnCommand } from "../transports/claudeBinary";
import { lookupClaude } from "../transports/headlessHost";
import { buildTutorialDocument, TUTORIAL_REL } from "../tutorial";
import {
  currentMcpServer,
  ensureMcpJsonRegistration,
  resetMcpJsonConsent,
} from "../mcpServer";
import {
  activateCopilotProvider,
  currentCopilotProvider,
  hasCursorInAppApi,
  isAgentConnected,
  markAgentConnected,
  markAgentDisconnected,
  openGenericSnippetDocument,
  registerCursorInApp,
  removeClaudeMcpJson,
  removeCodexConfig,
  removeCursorCliConfig,
  unregisterCursorInApp,
  writeCodexConfig,
  writeCursorCliConfig,
} from "../mcpServer/agentConnections";
import { hasCopilotProviderApi } from "../mcpServer/clients/copilot";
import type { CommandDeps } from "./deps";

/**
 * Write the playground document and open it in the inline comments view
 * (10x-plan-2 P3.1). The point is that the accept/reject loop is clickable in
 * the first minute, with no skill install, no send mode, and no Claude session.
 */
async function invokeOpenTutorial(log: Logger): Promise<void> {
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
  // Straight into the review surface — the text file is not the point.
  await vscode.commands.executeCommand("markdownCollab.openInlineCommentsView", doc.uri);
}

const SKILL_PROMPT_KEY = "markdownCollab.skillPromptedFingerprint";
/** The extension version the plugin-drift check last ran for. */
const PLUGIN_PROMPT_KEY = "markdownCollab.pluginPromptedVersion";

/** Every `claude plugin …` step gets this long; a registry refresh is seconds. */
const PLUGIN_COMMAND_TIMEOUT_MS = 60_000;

/**
 * `claude <args>` through `execFile`: an argument array, never a command
 * string (on Windows a `.cmd` shim needs the shell, and `spawnCommand` quotes
 * every argument for it). Output goes to the log at trace level — it is what a
 * "Set Up didn't work" report needs, and noise otherwise.
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

/** The plugin shipped inside this extension, and where its local marketplace lives. */
function pluginPaths(context: vscode.ExtensionContext): { sourcePluginDir: string; marketplaceDir: string } {
  return {
    sourcePluginDir: path.join(context.extensionPath, "plugin"),
    marketplaceDir: path.join(context.globalStorageUri.fsPath, LOCAL_MARKETPLACE_DIRNAME),
  };
}

/**
 * On startup, nudge the user when the Claude side is out of date — otherwise
 * they only find out by opening the comments panel.
 *
 * Plugin installs are checked once per extension version, through
 * `claude plugin list --json` (a process, so not on every activation): the
 * plugin comes from this extension's own local marketplace, so a version that
 * differs from the extension's means the Claude side is stale. Standalone
 * skill installs keep the fingerprint check they always had, gated per skill
 * version so it prompts once, not every time.
 */
export async function maybePromptSkillUpdate(
  context: vscode.ExtensionContext,
  log: Logger,
): Promise<void> {
  const extensionVersion = String(context.extension?.packageJSON?.version ?? "");
  if (extensionVersion && context.globalState.get<string>(PLUGIN_PROMPT_KEY) !== extensionVersion) {
    await context.globalState.update(PLUGIN_PROMPT_KEY, extensionVersion);
    try {
      const lookup = await lookupClaude(log);
      if (lookup.ok) {
        const installed = await installedLocalPlugin(claudeRunner(lookup.claude.path, log));
        if (installed) {
          if (installed.version === extensionVersion) return;
          const choice = await vscode.window.showInformationMessage(
            "Markdown Collab's Claude Code plugin is out of date " +
              `(${installed.version}; this extension is ${extensionVersion}).`,
            "Update",
            "Not now",
          );
          if (choice === "Update") await updatePluginFromNudge(context, lookup.claude.path, log);
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

  // Prompt at most once per bundled-skill version, so we don't nag on every
  // window the user opens.
  const fingerprint = skillFingerprint();
  if (context.globalState.get<string>(SKILL_PROMPT_KEY) === fingerprint) return;
  await context.globalState.update(SKILL_PROMPT_KEY, fingerprint);

  // 1.1: the first-activation nudge — nothing set up yet — points at Connect
  // an Agent, the one setup front door, rather than assuming Claude Code.
  // "out of date" is a different situation (something *is* set up, and it's
  // specifically the Claude skill that's stale), so that branch still goes
  // straight to the Claude-specific update.
  const missing = status === "missing";
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

async function updatePluginFromNudge(
  context: vscode.ExtensionContext,
  claudePath: string,
  log: Logger,
): Promise<void> {
  const outcome = await setUpClaudePlugin({ run: claudeRunner(claudePath, log), ...pluginPaths(context) });
  if (outcome.ok) {
    void vscode.window.showInformationMessage(
      `Claude Code plugin updated to ${outcome.version}. Restart running Claude sessions (or run /reload-plugins) to pick it up.`,
    );
  } else {
    log.warn("plugin update failed", { reason: outcome.reason });
    void vscode.window.showErrorMessage(`Markdown Collab: couldn't update the Claude Code plugin — ${outcome.reason}.`);
  }
}

/** What `setUpClaudeCode` did, for a caller that folds it into its own toast (1.1: Connect an Agent → Claude Code does both the plugin *and* `.mcp.json` in one go). */
export interface ClaudeCodeSetupOutcome {
  /** The plugin route succeeded (installed, updated, or already current) — as opposed to the standalone-skill fallback. */
  pluginOk: boolean;
  /** A hard failure (the skill install itself threw), for error-severity toasts. */
  failed: boolean;
  /** One line, or null when there's nothing to report (the user cancelled an overwrite prompt). No restart/reload hint — callers add their own. */
  summary: string | null;
}

/**
 * Set Up Claude Code's actual work, minus the toast: the plugin is the way —
 * skill, CLI on PATH, and the marker hook, installed from the extension's own
 * local marketplace — with the standalone skill as the fallback (no `claude`
 * binary, a Claude Code without plugin commands, or any step failing). Split
 * out from the toast so `invokeSetUpClaudeCode` (still a working alias) and
 * Connect an Agent → Claude Code (1.1, which also registers `.mcp.json`) can
 * share the work and fold the result into whichever toast is theirs.
 */
async function setUpClaudeCode(context: vscode.ExtensionContext, log: Logger): Promise<ClaudeCodeSetupOutcome> {
  const lookup = await lookupClaude(log);
  if (!lookup.ok) {
    const summary = await installLegacySkillSummary(log, `Claude Code wasn't found (${lookup.error})`);
    return { pluginOk: false, failed: summary === null ? false : summary.startsWith("Failed"), summary };
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
    return { pluginOk: true, failed: false, summary };
  }
  if (outcome.unsupported) log.info("claude plugin unavailable, using the standalone skill", { reason: outcome.reason });
  else log.warn("claude plugin setup failed, using the standalone skill", { reason: outcome.reason });
  const summary = await installLegacySkillSummary(log, outcome.reason);
  return { pluginOk: false, failed: summary === null ? false : summary.startsWith("Failed"), summary };
}

/**
 * Set Up Claude Code (`markdownCollab.installClaudeSkill`, the id kept from
 * when this only installed the skill; hidden from the palette after 1.1 —
 * Connect an Agent → Claude Code is the one front door now, and does this
 * plus `.mcp.json`).
 */
async function invokeSetUpClaudeCode(context: vscode.ExtensionContext, log: Logger): Promise<void> {
  const outcome = await setUpClaudeCode(context, log);
  if (outcome.summary === null) return;
  if (outcome.failed) {
    void vscode.window.showErrorMessage(outcome.summary);
    return;
  }
  const hint = outcome.pluginOk
    ? " Restart running Claude sessions (or run /reload-plugins) to pick it up."
    : "";
  void vscode.window.showInformationMessage(`${outcome.summary}${hint}`);
}

/** Today's standalone install, with why the plugin wasn't used folded in — a summary string instead of its own toast, so `setUpClaudeCode`'s callers control when and how it's shown. Null means nothing to report (the user cancelled an overwrite prompt). */
async function installLegacySkillSummary(log: Logger, fallbackReason: string): Promise<string | null> {
  const why = `(the Claude Code plugin wasn't used: ${fallbackReason})`;
  try {
    const result = await installClaudeSkill(os.homedir());
    if (result.action === "installed") {
      return `Markdown Collab skill installed at ${result.path} ${why}.`;
    }
    if (result.action === "already-present") {
      return `Markdown Collab skill is already up to date at ${result.path} ${why}.`;
    }
    const pick = await vscode.window.showWarningMessage(
      `A different Markdown Collab skill already exists at ${result.path} ${why}.`,
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

/**
 * Run `ensureAgentsSnippet` and toast the outcome. Shared by `initializeAgents`
 * (still works, just hidden from the palette after 0.4) and Connect an Agent →
 * Other agent…'s "Add to AGENTS.md" follow-up action.
 */
async function applyAgentsSnippet(folder: vscode.WorkspaceFolder, log: Logger): Promise<void> {
  try {
    const action = await ensureAgentsSnippet(folder.uri.fsPath);
    const verb =
      action === "created"
        ? "created"
        : action === "appended"
          ? "updated"
          : "already up to date";
    void vscode.window.showInformationMessage(
      `AGENTS.md ${verb} in ${folder.name}.`,
    );
  } catch (e) {
    log.error("ensureAgentsSnippet failed", e);
    void vscode.window.showErrorMessage(
      `Failed to update AGENTS.md: ${(e as Error).message}`,
    );
  }
}

async function invokeInitializeAgents(log: Logger): Promise<void> {
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Open a workspace folder first to initialize AGENTS.md.",
    );
    return;
  }
  await applyAgentsSnippet(folder, log);
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const active = vscode.window.activeTextEditor;
  if (active) {
    const f = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (f) return f;
  }
  if (folders.length === 1) return folders[0];
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: "Choose a workspace folder" },
  );
  return pick?.folder;
}

/** One entry in the Connect an Agent quick pick. */
export interface ConnectAgentItem extends vscode.QuickPickItem {
  id: "claude" | "cursor-inapp" | "cursor-cli" | "codex" | "copilot" | "other";
}

/**
 * Build the Connect an Agent quick-pick list. Pure — no vscode APIs beyond
 * the plain data shape of `QuickPickItem` — so which entries show up for a
 * given host is guard-testable without a real extension host: Cursor's
 * in-app agent and Copilot's agent-mode provider are the two whose API might
 * not exist (older forks, older VS Code); Claude Code, Cursor CLI, Codex, and
 * the generic fallback need no runtime capability and are always offered.
 */
export function buildConnectAgentItems(caps: { cursorInApp: boolean; copilot: boolean }): ConnectAgentItem[] {
  const items: ConnectAgentItem[] = [
    {
      id: "claude",
      label: "Claude Code",
      description:
        "Installs/updates the plugin and adds a markdown-collab entry to .mcp.json — no token written to the file.",
    },
  ];
  if (caps.cursorInApp) {
    items.push({
      id: "cursor-inapp",
      label: "Cursor (in-app agent)",
      description: "Registers the live URL and token directly with Cursor's agent — nothing on disk.",
    });
  }
  items.push({
    id: "cursor-cli",
    label: "Cursor CLI (cursor-agent)",
    description: "Writes .cursor/mcp.json with ${env:...} references — no port or token on disk.",
  });
  items.push({
    id: "codex",
    label: "Codex",
    description: "Writes .codex/config.toml with the loopback URL and bearer_token_env_var — no token on disk.",
  });
  if (caps.copilot) {
    items.push({
      id: "copilot",
      label: "GitHub Copilot (agent mode)",
      description: "Registers an MCP server definition with the live URL and token — nothing on disk.",
    });
  }
  items.push({
    id: "other",
    label: "Other agent…",
    description: "Opens a scratch document with the URL, token, and a generic mcpServers snippet.",
  });
  return items;
}

async function invokeConnectAgent(deps: CommandDeps): Promise<void> {
  const { context, rootLog, log } = deps;
  const handle = currentMcpServer();
  if (!handle) {
    void vscode.window.showWarningMessage(
      "Markdown Collab: the review tool server isn't running — reload the window and try again. See the Markdown Collab output channel.",
    );
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  const items = buildConnectAgentItems({ cursorInApp: hasCursorInAppApi(), copilot: hasCopilotProviderApi() });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Markdown Collab: connect an agent to the review tools",
  });
  if (!pick) return;

  switch (pick.id) {
    case "claude": {
      // 1.1: one setup does both — the plugin install (same code
      // `installClaudeSkill`/`Set Up Claude Code` uses, kept working as a
      // hidden alias) and the `.mcp.json` registration (same code
      // `registerMcpServer` uses, also kept as a hidden alias) — one toast
      // summarizing both outcomes.
      const pluginOutcome = await setUpClaudeCode(context, log);
      // Reset the remembered answer so a previous "Not now" can't silently
      // swallow this explicit request.
      await resetMcpJsonConsent(context);
      const mcpOutcome = await ensureMcpJsonRegistration(context, handle, rootLog.scope("mcp"));

      const parts: string[] = [];
      if (pluginOutcome.summary) parts.push(pluginOutcome.summary);
      if (mcpOutcome !== "declined") {
        parts.push(
          "Connected via `.mcp.json` in this workspace (no token written to the file).",
        );
      }
      if (parts.length === 0) break; // both declined/cancelled — nothing to report
      const hint =
        " Restart running Claude sessions (or run /reload-plugins and /mcp inside it) to pick this up.";
      if (pluginOutcome.failed) {
        void vscode.window.showErrorMessage(`Markdown Collab: ${parts.join(" ")}`);
      } else {
        void vscode.window.showInformationMessage(`Markdown Collab: ${parts.join(" ")}${hint}`);
      }
      break;
    }
    case "cursor-inapp": {
      try {
        registerCursorInApp(handle);
        await markAgentConnected(context, "cursor-inapp");
        void vscode.window.showInformationMessage(
          "Markdown Collab: registered with Cursor's in-app agent for this session — nothing written to disk. " +
            "The tools are available immediately; no restart needed.",
        );
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Markdown Collab: could not register with Cursor — ${(e as Error).message}`,
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
        const outcome = await writeCursorCliConfig(folder.uri);
        void vscode.window.showInformationMessage(
          outcome === "written"
            ? "Markdown Collab: wrote .cursor/mcp.json (env references only — no port or token on disk). Restart cursor-agent to pick it up."
            : "Markdown Collab: .cursor/mcp.json already has this entry. Restart cursor-agent to pick it up.",
        );
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Markdown Collab: could not write .cursor/mcp.json — ${(e as Error).message}`,
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
        const outcome = await writeCodexConfig(folder.uri, handle.port);
        void vscode.window.showInformationMessage(
          `Markdown Collab: ${outcome === "written" ? "wrote" : "confirmed"} the markdown-collab table in ` +
            ".codex/config.toml (no token on disk — only bearer_token_env_var). Codex loads project config only " +
            "for trusted projects — run codex in this folder and trust it.",
        );
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Markdown Collab: could not write .codex/config.toml — ${(e as Error).message}`,
        );
      }
      break;
    }
    case "copilot": {
      const provider = currentCopilotProvider();
      if (!provider) {
        void vscode.window.showWarningMessage(
          "Markdown Collab: this VS Code build doesn't support the Copilot MCP provider API.",
        );
        break;
      }
      provider.setConnected(true);
      provider.setLiveServer({ url: handle.url, token: handle.token });
      await markAgentConnected(context, "copilot");
      void vscode.window.showInformationMessage(
        "Markdown Collab: registered with GitHub Copilot — nothing written to disk. In Copilot Chat, enable the " +
          "Markdown Collab tools in agent mode's tool picker.",
      );
      break;
    }
    case "other": {
      await openGenericSnippetDocument(handle);
      const message =
        "Markdown Collab: opened a scratch document with the URL and a session token — nothing written to disk.";
      if (!folder) {
        void vscode.window.showInformationMessage(message);
        break;
      }
      // A generic client can't read AGENTS.md's hierarchy through a skill
      // loader — this is the offer to still teach it the tools-first rule
      // (0.4), one click away rather than a separate command to know about.
      const action = await vscode.window.showInformationMessage(message, "Add to AGENTS.md");
      if (action === "Add to AGENTS.md") await applyAgentsSnippet(folder, log);
      break;
    }
  }
}

/** One entry in the Disconnect Agent quick pick — the inverse listing of `ConnectAgentItem` (4.4). */
export interface DisconnectAgentItem extends vscode.QuickPickItem {
  id: "claude" | "cursor-inapp" | "cursor-cli" | "codex" | "copilot" | "other";
}

/**
 * Build the Disconnect Agent quick-pick list. Pure, same shape and same
 * capability-gating as `buildConnectAgentItems` — an entry only shows up for
 * a client this host could have connected in the first place. Every item's
 * `detail` says exactly what running it removes, since "disconnect" is
 * otherwise a vague promise (4.4: "Connect an Agent has no inverse").
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
      detail: "Nothing was ever written to disk for this client — the registration just goes away for this session.",
    });
  }
  items.push({
    id: "cursor-cli",
    label: "Cursor CLI (cursor-agent)",
    description: "Removes the markdown-collab entry from .cursor/mcp.json.",
    detail: "Leaves every other server in .cursor/mcp.json untouched.",
  });
  items.push({
    id: "codex",
    label: "Codex",
    description: "Removes the [mcp_servers.markdown-collab] table from .codex/config.toml.",
    detail: "Leaves every other table in .codex/config.toml untouched.",
  });
  if (caps.copilot) {
    items.push({
      id: "copilot",
      label: "GitHub Copilot (agent mode)",
      description: "Unregisters the live server definition from Copilot.",
      detail: "Nothing was ever written to disk for this client — the registration just goes away for this session.",
    });
  }
  items.push({
    id: "other",
    label: "Other agent…",
    description: "Nothing to remove.",
    detail: "Nothing was ever written to disk for a generic agent — the session token dies with this window.",
  });
  return items;
}

/**
 * `markdownCollab.disconnectAgent` (4.4) — the inverse of Connect an Agent.
 * Each branch undoes exactly what its Connect counterpart did: the same file
 * edits in reverse for the three file-based clients, the same live
 * registration torn down for the two session-scoped ones, and a plain
 * explanation for "Other" (there was never anything to undo).
 */
async function invokeDisconnectAgent(deps: CommandDeps): Promise<void> {
  const { context } = deps;
  const folder = vscode.workspace.workspaceFolders?.[0];
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
          "Markdown Collab: this VS Code build doesn't support the Copilot MCP provider API.",
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
    case "other": {
      void vscode.window.showInformationMessage(
        "Markdown Collab: nothing was ever written to disk for a generic agent — the session token already died with this window.",
      );
      break;
    }
  }
}

/** Register the setup family of commands: skill, AGENTS.md, tutorial, MCP re-registration. */
export function registerSetupCommands(deps: CommandDeps): void {
  const { context, rootLog, skillLog, reviewLog, log } = deps;

  // GitHub Copilot's agent-mode MCP discovery (10x-plan-4 P1.1): registered
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
    // logged like the rest of that surface (matches the original wiring).
    vscode.commands.registerCommand("markdownCollab.openTutorial", async () => {
      await invokeOpenTutorial(reviewLog);
    }),
    vscode.commands.registerCommand("markdownCollab.registerMcpServer", async () => {
      const handle = currentMcpServer();
      if (!handle) {
        void vscode.window.showWarningMessage(
          "Markdown Collab: the review tool server isn't running — reload the window and try again. See the Markdown Collab output channel.",
        );
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
