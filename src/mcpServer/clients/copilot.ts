// GitHub Copilot (VS Code agent mode) — 10x-plan-4 P1.1.
//
// Copilot discovers MCP servers through `vscode.lm.registerMcpServerDefinitionProvider`
// (paired with `contributes.mcpServerDefinitionProviders` in package.json),
// not a file: the provider hands back a live `McpHttpServerDefinition` — url
// and bearer header included — so nothing touches disk and nothing goes
// stale on its own. Two things that shape this class:
//
//   - `provideMcpServerDefinitions` answers `[]` until the human has actually
//     run Connect an Agent → Copilot *in this workspace*. The provider itself
//     is registered at activation whenever the host supports the API (see
//     `agentConnections.ts`) so a later "Connect" doesn't need a reload —
//     but registering the provider is not the same as opting in, and
//     Copilot must not see our tools before that.
//   - the token (and, if the server had to fall back to another port, the
//     URL) are fresh every session, so whoever owns this instance calls
//     `setLiveServer` again on every restart and this fires
//     `onDidChangeMcpServerDefinitions`, telling Copilot to re-fetch.
//
// The installed `@types/vscode` (1.116) has these types even though
// `engines.vscode` stays `^1.80.0` for older forks — see `hasCopilotProviderApi`
// below, which is what actually guards against running on a host that
// predates them; do not raise `engines.vscode` instead.
//
// This is the one file in `clients/` that imports `vscode`: it has to, since
// what it hands back is a real `vscode.McpHttpServerDefinition` instance, not
// data the glue layer could wrap later. Kept in its own module (rather than
// folded into `commands/setup.ts`) so this class — connected vs not, one
// definition vs none — is unit-testable against the vscode stub without a
// real extension host.

import * as vscode from "vscode";

export const COPILOT_PROVIDER_ID = "markdownCollab.mcpServerDefinitionProvider";
export const COPILOT_SERVER_LABEL = "Markdown Collab review tools";

/** `true` only on a host new enough to have the provider API — never assume
 *  it from `engines.vscode`, which intentionally stays low for older forks. */
export function hasCopilotProviderApi(): boolean {
  return typeof vscode.lm?.registerMcpServerDefinitionProvider === "function";
}

export interface CopilotLiveServer {
  url: string;
  token: string;
}

export class CopilotMcpProvider implements vscode.McpServerDefinitionProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;
  private connected = false;
  private live: CopilotLiveServer | null = null;

  dispose(): void {
    this.emitter.dispose();
  }

  /** Whether Connect an Agent → Copilot has been run in this workspace. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Flip the opt-in. Called once at activation with the remembered
   *  `workspaceState` answer, and again whenever the human runs Connect an
   *  Agent → Copilot. */
  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.emitter.fire();
  }

  /** Called whenever the server (re)starts — a fresh token and, if the port
   *  had to move, a fresh URL — so a workspace that connected Copilot last
   *  session re-provides itself instead of quietly going stale. */
  setLiveServer(live: CopilotLiveServer | null): void {
    this.live = live;
    if (this.connected) this.emitter.fire();
  }

  provideMcpServerDefinitions(): vscode.McpHttpServerDefinition[] {
    if (!this.connected || !this.live) return [];
    return [
      new vscode.McpHttpServerDefinition(COPILOT_SERVER_LABEL, vscode.Uri.parse(this.live.url), {
        Authorization: `Bearer ${this.live.token}`,
      }),
    ];
  }
}
