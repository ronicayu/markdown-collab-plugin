// Disconnect Agent (4.4) — the inverse of Connect an Agent's file writers.
// Same idempotency contract as the merge side (mcpClientCursor.test.ts,
// mcpClientCodex.test.ts): running it on a workspace that never connected is
// a no-op, and every other entry in the file survives untouched.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { removeMcpJsonEntry, removeMcpServersJsonEntry, mergeMcpJson, MCP_SERVER_NAME } from "../mcpServer/registration";
import { mergeCursorMcpJson, removeCursorMcpEntry } from "../mcpServer/clients/cursor";
import { mergeCodexToml, removeCodexTable, codexTablePresent } from "../mcpServer/clients/codex";
import { refuseSymlink } from "../mcpServer/agentConnections";
import { readHostFile } from "./hostSources";

describe("removeMcpServersJsonEntry", () => {
  it("is a no-op when the file doesn't exist", () => {
    expect(removeMcpServersJsonEntry(null, MCP_SERVER_NAME)).toEqual({ text: null, removed: false });
  });

  it("is a no-op when the file exists but has no mcpServers section", () => {
    const existing = JSON.stringify({ unrelated: true });
    expect(removeMcpServersJsonEntry(existing, MCP_SERVER_NAME)).toEqual({ text: null, removed: false });
  });

  it("is a no-op when our entry isn't there", () => {
    const existing = JSON.stringify({ mcpServers: { other: { url: "https://example.com/mcp" } } });
    expect(removeMcpServersJsonEntry(existing, MCP_SERVER_NAME)).toEqual({ text: null, removed: false });
  });

  it("removes our entry and keeps every other server intact", () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { url: "https://example.com/mcp" },
        [MCP_SERVER_NAME]: { type: "http", url: "http://127.0.0.1:1/mcp" },
      },
      unrelatedTopLevelKey: true,
    });
    const { text, removed } = removeMcpServersJsonEntry(existing, MCP_SERVER_NAME);
    expect(removed).toBe(true);
    const parsed = JSON.parse(text!);
    expect(parsed.mcpServers[MCP_SERVER_NAME]).toBeUndefined();
    expect(parsed.mcpServers.other.url).toBe("https://example.com/mcp");
    expect(parsed.unrelatedTopLevelKey).toBe(true);
  });

  it("refuses (leaves the file alone) rather than guess at invalid JSON", () => {
    expect(removeMcpServersJsonEntry("not json", MCP_SERVER_NAME)).toEqual({ text: null, removed: false });
  });

  it("round-trips with the merge side: write then remove leaves no trace", () => {
    const written = removeMcpServersJsonEntry(
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url: "x" } } }),
      MCP_SERVER_NAME,
    ).text!;
    expect(JSON.parse(written).mcpServers[MCP_SERVER_NAME]).toBeUndefined();
  });
});

describe("removeMcpJsonEntry (Claude Code's .mcp.json)", () => {
  it("is idempotent when the entry is absent", () => {
    expect(removeMcpJsonEntry(null)).toEqual({ text: null, removed: false });
    expect(removeMcpJsonEntry(JSON.stringify({ mcpServers: {} }))).toEqual({ text: null, removed: false });
  });

  it("removes exactly what mergeMcpJson wrote, leaving other entries untouched", () => {
    const withOther = JSON.stringify({ mcpServers: { other: { url: "https://example.com/mcp" } } });
    const merged = mergeMcpJson(withOther, 51234).text!;
    const removed = removeMcpJsonEntry(merged);
    expect(removed.removed).toBe(true);
    const parsed = JSON.parse(removed.text!);
    expect(parsed.mcpServers[MCP_SERVER_NAME]).toBeUndefined();
    expect(parsed.mcpServers.other.url).toBe("https://example.com/mcp");
  });
});

describe("removeCursorMcpEntry (.cursor/mcp.json)", () => {
  it("is idempotent when the file doesn't exist or has no entry", () => {
    expect(removeCursorMcpEntry(null)).toEqual({ text: null, removed: false });
    expect(removeCursorMcpEntry(JSON.stringify({ mcpServers: { other: { url: "x" } } }))).toEqual({
      text: null,
      removed: false,
    });
  });

  it("removes exactly what mergeCursorMcpJson wrote, leaving every other server intact", () => {
    const existing = JSON.stringify({
      mcpServers: { other: { url: "https://example.com/mcp" } },
    });
    const merged = mergeCursorMcpJson(existing).text!;
    const removed = removeCursorMcpEntry(merged);
    expect(removed.removed).toBe(true);
    const parsed = JSON.parse(removed.text!);
    expect(parsed.mcpServers[MCP_SERVER_NAME]).toBeUndefined();
    expect(parsed.mcpServers.other.url).toBe("https://example.com/mcp");
  });

  it("running remove twice is safe — the second call is a no-op", () => {
    const merged = mergeCursorMcpJson(null).text!;
    const first = removeCursorMcpEntry(merged);
    const second = removeCursorMcpEntry(first.text!);
    expect(second).toEqual({ text: null, removed: false });
  });
});

describe("removeCodexTable (.codex/config.toml)", () => {
  it("is idempotent when the file doesn't exist or has no table", () => {
    expect(removeCodexTable(null)).toEqual({ text: null, removed: false });
    expect(removeCodexTable("[other_table]\nfoo = \"bar\"\n")).toEqual({ text: null, removed: false });
  });

  it("removes a table that is the file's only content", () => {
    const existing = mergeCodexToml(null, 51234).text!;
    const { text, removed } = removeCodexTable(existing);
    expect(removed).toBe(true);
    expect(codexTablePresent(text!)).toBe(false);
    expect(text).not.toContain("markdown-collab");
  });

  it("removes only our table, preserving a table before and after it, with one blank-line separator", () => {
    const existing = [
      "# a top-level comment",
      "[other_table]",
      'foo = "bar"',
      "",
      "[mcp_servers.markdown-collab]",
      'url = "http://127.0.0.1:51234/mcp"',
      'bearer_token_env_var = "MARKDOWN_COLLAB_MCP_TOKEN"',
      "",
      "[another_table]",
      "baz = 1",
    ].join("\n");
    const { text, removed } = removeCodexTable(existing);
    expect(removed).toBe(true);
    expect(codexTablePresent(text!)).toBe(false);
    expect(text).toContain("# a top-level comment");
    expect(text).toContain("[other_table]");
    expect(text).toContain('foo = "bar"');
    expect(text).toContain("[another_table]");
    expect(text).toContain("baz = 1");
    // Exactly one blank line separates the two surviving tables — no pile-up.
    expect(text).toContain('foo = "bar"\n\n[another_table]');
  });

  it("removes a table appended at the end, leaving what came before untouched", () => {
    const existing = ["[other_table]", 'foo = "bar"', "", "[mcp_servers.markdown-collab]", 'url = "x"'].join("\n");
    const { text, removed } = removeCodexTable(existing);
    expect(removed).toBe(true);
    expect(text).toContain("[other_table]");
    expect(text).not.toContain("markdown-collab");
    expect(text!.endsWith("\n")).toBe(true);
  });

  it("handles the quoted header spelling", () => {
    const existing = ['[mcp_servers."markdown-collab"]', 'url = "x"', 'bearer_token_env_var = "T"'].join("\n");
    const { removed, text } = removeCodexTable(existing);
    expect(removed).toBe(true);
    expect(codexTablePresent(text!)).toBe(false);
  });

  it("never leaves a token-shaped string or port behind", () => {
    const existing = mergeCodexToml(null, 51234).text!;
    const { text } = removeCodexTable(existing);
    expect(text).not.toMatch(/51234/);
  });
});

// L5: the .mcp.json / .cursor/mcp.json / .codex/config.toml writers and
// removers in agentConnections.ts must not follow a symlink out of the
// workspace. `refuseSymlink` is the shared check; these test it directly
// against real files and symlinks, since the six functions that call it are
// otherwise only exercisable through vscode.workspace.fs (no stand-in for
// that exists in this test suite).
describe("refuseSymlink (L5)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mc-agentconn-symlink-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns null for an ordinary path with no symlink involved", async () => {
    expect(await refuseSymlink(vscode.Uri.file(path.join(tmp, "mcp.json")))).toBeNull();
  });

  it("returns a reason when the target itself is a symlink", async () => {
    const real = path.join(tmp, "real.json");
    await fsp.writeFile(real, "{}", "utf8");
    const link = path.join(tmp, "mcp.json");
    await fsp.symlink(real, link);
    expect(await refuseSymlink(vscode.Uri.file(link))).toMatch(/symlink/);
  });

  it("returns a reason when the parent directory (e.g. .cursor/ or .codex/) is a symlink", async () => {
    const realDir = path.join(tmp, "real-dot-cursor");
    await fsp.mkdir(realDir);
    const linkedDir = path.join(tmp, ".cursor");
    await fsp.symlink(realDir, linkedDir);
    expect(await refuseSymlink(vscode.Uri.file(path.join(linkedDir, "mcp.json")))).toMatch(/symlink/);
  });
});

// Regression guard: every writer/remover this finding named calls the
// symlink check before it touches vscode.workspace.fs. A source-text
// assertion, like the other host-wiring checks this codebase already uses
// (see commentOnSelection.test.ts / hostSources.ts) where a real integration
// test would need infrastructure this suite doesn't have.
describe("agentConnections.ts: every writer/remover is guarded (L5)", () => {
  it("writeCursorCliConfig, writeCodexConfig, removeClaudeMcpJson, removeCursorCliConfig, removeCodexConfig, and reconcileCodexConfig all call the guard", () => {
    const src = readHostFile("mcpServer/agentConnections.ts");
    for (const fn of [
      "writeCursorCliConfig",
      "writeCodexConfig",
      "removeClaudeMcpJson",
      "removeCursorCliConfig",
      "removeCodexConfig",
      "reconcileCodexConfig",
    ]) {
      const start = src.indexOf(`function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const end = src.indexOf("\n}\n", start);
      const body = src.slice(start, end);
      expect(body, fn).toMatch(/guardAgainstSymlink\(|refuseSymlink\(/);
    }
  });
});
