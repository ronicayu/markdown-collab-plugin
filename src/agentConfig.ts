// Bridges the `markdownCollab.agentName` setting to the shared label module
// (`agentName.ts`). Kept apart from it because this file needs `vscode` and
// that one must stay importable from the webview bundles.

import * as vscode from "vscode";
import { agentName, setAgentName } from "./agentName";

export const AGENT_NAME_SETTING = "markdownCollab.agentName";

/**
 * Re-read the setting into the shared module and return the current name.
 * Cheap, so every code path that builds user-facing text for a webview calls
 * it rather than trusting that some other listener ran first.
 */
export function syncAgentName(): string {
  setAgentName(vscode.workspace.getConfiguration("markdownCollab").get<string>("agentName"));
  return agentName();
}
