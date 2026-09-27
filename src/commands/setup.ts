// First-run and setup commands: the Claude skill, AGENTS.md, the playground
// tutorial, and re-registering the MCP server (10x-plan-4 P3.2 split of
// extension.ts).

import * as os from "os";
import * as vscode from "vscode";
import type { Logger } from "../logging";
import { ensureAgentsSnippet } from "../agents";
import { checkClaudeSkill, installClaudeSkill, skillFingerprint } from "../skill";
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
  openGenericSnippetDocument,
  registerCursorInApp,
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

/**
 * On startup, nudge the user to install/update the Claude skill if it's
 * missing or out of date — otherwise they only find out by opening the
 * comments panel. Gated per skill version so it prompts once, not every time.
 */
export async function maybePromptSkillUpdate(
  context: vscode.ExtensionContext,
  log: Logger,
): Promise<void> {
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

  const action = status === "missing" ? "Install skill" : "Update skill";
  const message =
    status === "missing"
      ? "Markdown Collab: the Claude skill isn't installed. Claude needs it to read and act on your comments."
      : "Markdown Collab: the Claude skill is out of date. Update it so Claude follows the latest comment-handling behavior.";
  const choice = await vscode.window.showInformationMessage(message, action, "Not now");
  if (choice === action) {
    await vscode.commands.executeCommand("markdownCollab.installClaudeSkill");
  }
}

async function invokeInstallClaudeSkill(
  log: Logger,
): Promise<void> {
  try {
    const result = await installClaudeSkill(os.homedir());
    if (result.action === "installed") {
      void vscode.window.showInformationMessage(
        `Markdown Collab skill installed at ${result.path}.`,
      );
    } else if (result.action === "already-present") {
      void vscode.window.showInformationMessage(
        `Markdown Collab skill is already up to date at ${result.path}.`,
      );
    } else {
      const pick = await vscode.window.showWarningMessage(
        `A different Markdown Collab skill already exists at ${result.path}.`,
        "Overwrite",
        "Cancel",
      );
      if (pick === "Overwrite") {
        const forced = await installClaudeSkill(os.homedir(), { force: true });
        void vscode.window.showInformationMessage(
          `Markdown Collab skill overwritten at ${forced.path}.`,
        );
      }
    }
  } catch (e) {
    log.error("skill install failed", e);
    void vscode.window.showErrorMessage(
      `Failed to install Claude skill: ${(e as Error).message}`,
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
    log.error("initializeAgents failed", e);
    void vscode.window.showErrorMessage(
      `Failed to initialize AGENTS.md: ${(e as Error).message}`,
    );
  }
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
      description: "Adds a markdown-collab entry to .mcp.json — no token written to the file.",
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
  const { context, rootLog } = deps;
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
      // Exactly today's flow: reset the remembered answer so a previous
      // "Not now" can't silently swallow an explicit request, then run the
      // same consent-then-merge path `registerMcpServer` already does —
      // that command stays as a working alias to this same code.
      await resetMcpJsonConsent(context);
      const outcome = await ensureMcpJsonRegistration(context, handle, rootLog.scope("mcp"));
      if (outcome !== "declined") {
        void vscode.window.showInformationMessage(
          "Markdown Collab: Claude Code is connected via `.mcp.json` in this workspace (no token written to the file). " +
            "If Claude Code is already running, run `/mcp` inside it to reconnect.",
        );
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
      void vscode.window.showInformationMessage(
        "Markdown Collab: opened a scratch document with the URL and a session token — nothing written to disk.",
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
      await invokeInstallClaudeSkill(skillLog);
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
