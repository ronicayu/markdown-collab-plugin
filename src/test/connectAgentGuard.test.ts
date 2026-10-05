// Guards for Connect an Agent:
//   - which quick-pick entries show up for a given host's capabilities;
//   - `engines.vscode` stays low so Cursor/Windsurf/VSCodium users aren't
//     locked out by a feature only some hosts have (feature-detected instead,
//     see `hasCursorInAppApi` / `hasCopilotProviderApi`);
//   - the command and the provider contribution point are actually declared.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import {
  agentsSnippetSentence,
  buildConnectAgentItems,
  buildDisconnectAgentItems,
  connectFormatFirst,
  mcpOfferFor,
  type FormatFirstAgentId,
  type FormatFirstIo,
} from "../commands/setup";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));

describe("buildConnectAgentItems", () => {
  it("always offers Claude Code, Cursor CLI, Windsurf, Codex, and the generic fallback", () => {
    const ids = buildConnectAgentItems({ cursorInApp: false, copilot: false }).map((i) => i.id);
    expect(ids).toEqual(["claude", "cursor-cli", "windsurf", "codex", "other"]);
  });

  it("adds Cursor's in-app agent only when that API exists", () => {
    const ids = buildConnectAgentItems({ cursorInApp: true, copilot: false }).map((i) => i.id);
    expect(ids).toContain("cursor-inapp");
  });

  it("adds Copilot only when that API exists", () => {
    const ids = buildConnectAgentItems({ cursorInApp: false, copilot: true }).map((i) => i.id);
    expect(ids).toContain("copilot");
  });

  it("offers every entry when every capability is present, in a stable order", () => {
    const ids = buildConnectAgentItems({ cursorInApp: true, copilot: true }).map((i) => i.id);
    expect(ids).toEqual(["claude", "cursor-inapp", "cursor-cli", "windsurf", "codex", "copilot", "other"]);
  });

  it("lists Windsurf (Cascade) between the Cursor entries and Codex", () => {
    const items = buildConnectAgentItems({ cursorInApp: true, copilot: true });
    const ids = items.map((i) => i.id);
    expect(ids.indexOf("windsurf")).toBe(ids.indexOf("cursor-cli") + 1);
    expect(ids.indexOf("windsurf")).toBe(ids.indexOf("codex") - 1);
    expect(items.find((i) => i.id === "windsurf")!.label).toBe("Windsurf (Cascade)");
  });

  it("every item carries a one-line, non-empty description", () => {
    for (const item of buildConnectAgentItems({ cursorInApp: true, copilot: true })) {
      expect(item.description).toBeTruthy();
      expect(item.description).not.toContain("\n");
    }
  });

  // 1.1: Connect an Agent → Claude Code is the one setup front door now — its
  // description has to say it does both the plugin install and the
  // `.mcp.json` registration, not just the latter.
  it("the Claude Code item's description names both the plugin and .mcp.json", () => {
    const claude = buildConnectAgentItems({ cursorInApp: false, copilot: false }).find(
      (i) => i.id === "claude",
    )!;
    expect(claude.description).toMatch(/plugin/i);
    expect(claude.description).toMatch(/\.mcp\.json/);
  });
});

// 4.4: "Connect an Agent has no inverse" — same guard shape as
// buildConnectAgentItems above, for the QuickPick that undoes it.
describe("buildDisconnectAgentItems", () => {
  it("always offers Claude Code, Cursor CLI, Windsurf, Codex, and Other", () => {
    const ids = buildDisconnectAgentItems({ cursorInApp: false, copilot: false }).map((i) => i.id);
    expect(ids).toEqual(["claude", "cursor-cli", "windsurf", "codex", "other"]);
  });

  it("adds Cursor's in-app agent and Copilot only when those APIs exist — same gating as Connect", () => {
    const withBoth = buildDisconnectAgentItems({ cursorInApp: true, copilot: true }).map((i) => i.id);
    expect(withBoth).toEqual(["claude", "cursor-inapp", "cursor-cli", "windsurf", "codex", "copilot", "other"]);
  });

  it("every item's detail says exactly what running it removes", () => {
    for (const item of buildDisconnectAgentItems({ cursorInApp: true, copilot: true })) {
      expect(item.detail, `${item.id} has no detail`).toBeTruthy();
    }
  });

  it("ids match buildConnectAgentItems' ids one for one", () => {
    const connectIds = buildConnectAgentItems({ cursorInApp: true, copilot: true }).map((i) => i.id).sort();
    const disconnectIds = buildDisconnectAgentItems({ cursorInApp: true, copilot: true }).map((i) => i.id).sort();
    expect(disconnectIds).toEqual(connectIds);
  });
});

// For every agent but Claude Code the file format is the
// API — Connect writes AGENTS.md first and offers the MCP registration second,
// and Disconnect only ever undoes the second step.
const FORMAT_FIRST: FormatFirstAgentId[] = ["cursor-inapp", "cursor-cli", "windsurf", "codex", "copilot", "other"];

describe("Connect an Agent: AGENTS.md first, the review tools optional", () => {
  const items = buildConnectAgentItems({ cursorInApp: true, copilot: true });

  it("every entry but Claude Code says AGENTS.md comes first, before the tools", () => {
    for (const item of items.filter((i) => i.id !== "claude")) {
      expect(item.description, item.id).toMatch(/^Writes AGENTS\.md, then offers /);
      expect(item.description, item.id).toMatch(/review tools/);
    }
  });

  it("the Claude Code entry doesn't mention AGENTS.md — it is unchanged", () => {
    expect(items.find((i) => i.id === "claude")!.description).not.toContain("AGENTS.md");
  });

  it.each([
    ["cursor-inapp", /Cursor's in-app agent/, /registers live/],
    ["cursor-cli", /Cursor CLI/, /writes \.cursor\/mcp\.json/],
    ["windsurf", /Windsurf/, /opens a scratch document/],
    ["codex", /Codex/, /writes \.codex\/config\.toml/],
    ["copilot", /GitHub Copilot/, /registers live/],
    ["other", /your agent/, /opens a scratch document/],
  ] as const)("the %s offer names the client and what saying yes does", (id, client, effect) => {
    const offer = mcpOfferFor(id);
    expect(offer.question).toMatch(/^Also /);
    expect(offer.question).toMatch(/undoable\?/);
    expect(offer.question).toMatch(client);
    expect(offer.question).toMatch(effect);
    expect(offer.accept).toBeTruthy();
  });

  it("says what AGENTS.md got, naming the folder, for every outcome", () => {
    for (const action of ["created", "appended", "refreshed", "already-present", "customized"] as const) {
      const sentence = agentsSnippetSentence(action, "my-repo");
      expect(sentence, action).toContain("AGENTS.md");
      expect(sentence, action).toContain("my-repo");
    }
    expect(agentsSnippetSentence("customized", "my-repo")).toMatch(/left as is/);
  });
});

describe("connectFormatFirst", () => {
  /** A recording host: `answer` is what the human clicks on the follow-up question. */
  function host(opts: { agents?: string | null; serverRunning?: boolean; answer?: (accept: string) => string | undefined }) {
    const log: string[] = [];
    const io: FormatFirstIo = {
      writeAgentsSnippet: async () => {
        log.push("agents");
        return opts.agents === undefined ? "Created AGENTS.md in ws." : opts.agents;
      },
      serverRunning: opts.serverRunning ?? true,
      ask: async (message, ...actions) => {
        log.push(`ask: ${message} [${actions.join(" | ")}]`);
        return opts.answer?.(actions[0]!);
      },
      tell: (message) => void log.push(`tell: ${message}`),
      register: async () => void log.push("register"),
    };
    return { io, log };
  }

  it.each(FORMAT_FIRST)("%s: writes AGENTS.md, then asks, then registers on yes", async (id) => {
    const { io, log } = host({ answer: (accept) => accept });
    expect(await connectFormatFirst(id, io)).toBe("registered");
    expect(log).toHaveLength(3);
    expect(log[0]).toBe("agents");
    expect(log[1]).toBe(`ask: Markdown Collab: Created AGENTS.md in ws. ${mcpOfferFor(id).question} [${mcpOfferFor(id).accept} | Not now]`);
    expect(log[2]).toBe("register");
  });

  it("Not now, or dismissing the question, stops after AGENTS.md", async () => {
    for (const answer of [() => "Not now", () => undefined]) {
      const { io, log } = host({ answer });
      expect(await connectFormatFirst("codex", io)).toBe("agents-only");
      expect(log).not.toContain("register");
    }
  });

  it("without the tool server, AGENTS.md is still written and the step is explained instead of offered", async () => {
    const { io, log } = host({ serverRunning: false, answer: (accept) => accept });
    expect(await connectFormatFirst("cursor-cli", io)).toBe("agents-only");
    expect(log[0]).toBe("agents");
    expect(log[1]).toMatch(/^tell: Markdown Collab: Created AGENTS\.md in ws\. .*reload the window/);
    expect(log.some((l) => l.startsWith("ask:") || l === "register")).toBe(false);
  });

  it("a failed AGENTS.md write stops there — the error was already shown", async () => {
    const { io, log } = host({ agents: null, answer: (accept) => accept });
    expect(await connectFormatFirst("copilot", io)).toBe("failed");
    expect(log).toEqual(["agents"]);
  });
});

describe("Disconnect an Agent: the tools only, never AGENTS.md", () => {
  const items = buildDisconnectAgentItems({ cursorInApp: true, copilot: true });

  it("every entry whose Connect wrote AGENTS.md says it is left as is", () => {
    for (const item of items.filter((i) => i.id !== "claude")) {
      expect(item.detail, item.id).toMatch(/AGENTS\.md is left as is/);
    }
  });

  it("the Claude Code entry doesn't mention AGENTS.md — its Connect never wrote it", () => {
    expect(items.find((i) => i.id === "claude")!.detail).not.toContain("AGENTS.md");
  });
});

describe("engines.vscode", () => {
  it("stays at ^1.80.0 — feature-detect Cursor/Copilot APIs instead of raising the floor", () => {
    expect(pkg.engines.vscode).toBe("^1.80.0");
  });

  it("the installed @types/vscode range is unchanged too", () => {
    expect(pkg.devDependencies["@types/vscode"]).toBe("^1.80.0");
  });
});

// L2c: the "Other agent…" scratch document DOES carry the token (in memory,
// hot-exit-backed) — "nothing written to disk" overclaimed that. Both the
// pre-consent question and the toast after saying yes made the same claim; a
// source-text check because `registerWithClient`'s "other" branch isn't
// exported (invoking it needs a live McpServerHandle and a real document).
describe("the generic scratch-document copy doesn't overclaim 'nothing on disk' (L2c)", () => {
  const src = readFileSync(resolve(__dirname, "../commands/setup.ts"), "utf8");

  it("the pre-consent question says the token lives only in this session", () => {
    expect(mcpOfferFor("other").question).toMatch(/lives only in this session/);
    expect(mcpOfferFor("other").question).not.toMatch(/nothing on disk/);
  });

  it("the post-consent toast says the same, and tells the user not to save the document", () => {
    // The source wraps the string across lines, so match its two halves
    // rather than the exact concatenated sentence.
    expect(src).toContain("the token lives only in");
    expect(src).toContain("this session; don't save this document.");
    expect(src).not.toMatch(/session token — nothing written to disk/);
  });
});

describe("package.json names Windsurf", () => {
  it("lists Windsurf among the supported agents in the description", () => {
    expect(pkg.description).toMatch(/Claude Code, Cursor, Windsurf, Codex and Copilot\.$/);
  });

  it("has windsurf and cascade keywords", () => {
    expect(pkg.keywords).toEqual(expect.arrayContaining(["windsurf", "cascade"]));
  });

  it("names Windsurf in the walkthrough step that lists the agents", () => {
    const step = pkg.contributes.walkthroughs
      .flatMap((w: { steps: Array<{ id: string; description: string }> }) => w.steps)
      .find((s: { id: string }) => s.id === "connect-agent");
    expect(step.description).toMatch(/Windsurf/);
  });
});

describe("package.json contributions", () => {
  it("declares the Connect an Agent command", () => {
    const command = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "markdownCollab.connectAgent",
    );
    expect(command).toBeTruthy();
    expect(command.title).toMatch(/Connect an Agent/);
  });

  it("still declares the Claude Code registration command as a working alias", () => {
    const command = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "markdownCollab.registerMcpServer",
    );
    expect(command).toBeTruthy();
  });

  it("declares the Disconnect Agent command (4.4)", () => {
    const command = pkg.contributes.commands.find(
      (c: { command: string }) => c.command === "markdownCollab.disconnectAgent",
    );
    expect(command).toBeTruthy();
    expect(command.title).toMatch(/Disconnect/i);
  });

  it("declares exactly one mcpServerDefinitionProviders entry, matching the Copilot provider id", () => {
    const providers = pkg.contributes.mcpServerDefinitionProviders;
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("markdownCollab.mcpServerDefinitionProvider");
    expect(providers[0].label).toBeTruthy();
  });
});
