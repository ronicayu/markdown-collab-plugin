// Connect an Agent (10x-plan-4 P1.1) against a real Extension Host.
//
// The unit suite covers every writer's pure logic and the Copilot provider's
// state machine against the vscode stub. What only the real host can show:
// the provider API actually exists and registering against it doesn't throw
// on the VS Code version we ship against, a real workspace folder round-trips
// through `writeCursorCliConfig`, and the two env vars this whole initiative
// leans on are visible on `process.env` — not just the terminal
// `EnvironmentVariableCollection` — for the lifetime of the running server.
//
// NOTE: written as part of 10x-plan-4 P1.1 but not run from this worktree —
// `npm run test:integration` shares a VS Code user-data dir with the parallel
// "headless mode" work; the integrating session runs the full suite after
// merging both branches.

import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { currentMcpServer } from "../../../mcpServer";
import { ENV_TOKEN, ENV_URL } from "../../../mcpServer/registration";
import { currentCopilotProvider, writeCursorCliConfig } from "../../../mcpServer/agentConnections";

function workspaceRoot(): string {
  return path.resolve(__dirname, "..", "fixtures");
}

suite("connectAgent: the server's URL/token also reach process.env", () => {
  test("match the running handle for as long as the server is up", () => {
    const handle = currentMcpServer();
    assert.ok(handle, "expected the extension's MCP server to be running for this test host");
    // Not just the terminal EnvironmentVariableCollection: a CLI agent that
    // another extension spawns in-process (Claude Code's or Codex's own IDE
    // extension) inherits these from the extension host's own process env.
    assert.strictEqual(process.env[ENV_URL], handle!.url);
    assert.strictEqual(process.env[ENV_TOKEN], handle!.token);
  });
});

suite("connectAgent: the Copilot MCP provider on a real host", () => {
  test("the provider API exists on VS Code 1.139 and registering against it didn't throw", () => {
    assert.strictEqual(
      typeof vscode.lm?.registerMcpServerDefinitionProvider,
      "function",
      "expected this host to support vscode.lm.registerMcpServerDefinitionProvider",
    );
    const provider = currentCopilotProvider();
    assert.ok(
      provider,
      "expected activation to have registered a Copilot provider on a host that supports the API",
    );
  });
});

suite("connectAgent: Cursor CLI writer against a fixture workspace", () => {
  const cursorDir = path.join(workspaceRoot(), ".cursor");

  teardown(async () => {
    await fs.rm(cursorDir, { recursive: true, force: true });
  });

  test("writes .cursor/mcp.json with the env references — no port, no token", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "expected a workspace folder open in the test host");

    const outcome = await writeCursorCliConfig(folder!.uri);
    assert.strictEqual(outcome, "written");

    const written = await fs.readFile(path.join(cursorDir, "mcp.json"), "utf-8");
    const parsed = JSON.parse(written);
    assert.strictEqual(parsed.mcpServers["markdown-collab"].url, `\${env:${ENV_URL}}`);
    assert.strictEqual(
      parsed.mcpServers["markdown-collab"].headers.Authorization,
      `Bearer \${env:${ENV_TOKEN}}`,
    );
    assert.ok(!/127\.0\.0\.1:\d+/.test(written), "no literal port should appear in the file");
    assert.ok(!/[0-9a-f]{32,}/.test(written), "no token should appear in the file");
  });

  test("a second run makes no further change", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    await writeCursorCliConfig(folder!.uri);
    const outcome = await writeCursorCliConfig(folder!.uri);
    assert.strictEqual(outcome, "unchanged");
  });
});
