// Guards for Connect an Agent:
//   - which quick-pick entries show up for a given host's capabilities;
//   - `engines.vscode` stays low so Cursor/Windsurf/VSCodium users aren't
//     locked out by a feature only some hosts have (feature-detected instead,
//     see `hasCursorInAppApi` / `hasCopilotProviderApi`);
//   - the command and the provider contribution point are actually declared.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import type { AgentsSkillResult } from "../agentsSkill";
import {
  agentsSkillSentence,
  agentsSnippetSentence,
  buildConnectAgentItems,
  buildDisconnectAgentItems,
  connectFormatFirst,
  type FormatFirstIo,
} from "../commands/setup";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));

// Two ways an agent gets the workflow and `mdc`, so two choices: which agent it
// is doesn't change what is written, and there is no per-client tool
// registration to pick between any more.
describe("buildConnectAgentItems", () => {
  const items = buildConnectAgentItems();

  it("offers Claude Code and every other agent, in that order", () => {
    expect(items.map((i) => i.id)).toEqual(["claude", "agents"]);
    expect(items[1]!.label).toMatch(/Cursor, Codex, Copilot, Windsurf/);
  });

  it("every item carries a one-line, non-empty description of what it installs", () => {
    for (const item of items) {
      expect(item.description).toBeTruthy();
      expect(item.description).not.toContain("\n");
      expect(item.description).toMatch(/mdc/);
    }
  });

  it("Claude Code gets the plugin, nothing else — no .mcp.json, no AGENTS.md", () => {
    const claude = items.find((i) => i.id === "claude")!.description!;
    expect(claude).toMatch(/plugin/i);
    expect(claude).not.toContain(".mcp.json");
    expect(claude).not.toContain("AGENTS.md");
  });

  it("every other agent gets AGENTS.md and the skill in ~/.agents/skills, and no tool registration", () => {
    const agents = items.find((i) => i.id === "agents")!.description!;
    expect(agents).toContain("AGENTS.md");
    expect(agents).toContain("~/.agents/skills");
    expect(agents).not.toMatch(/offers|register|token/i);
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

});

describe("Connect an Agent → another agent: what it says", () => {
  it("says what AGENTS.md got, naming the folder, for every outcome", () => {
    for (const action of ["created", "appended", "refreshed", "already-present", "customized"] as const) {
      const sentence = agentsSnippetSentence(action, "my-repo");
      expect(sentence, action).toContain("AGENTS.md");
      expect(sentence, action).toContain("my-repo");
    }
    expect(agentsSnippetSentence("customized", "my-repo")).toMatch(/left as is/);
  });

  it("says what happened to the review skill, with ~ for the home directory, for every outcome", () => {
    const home = "/home/me";
    const at = `${home}/.agents/skills/markdown-collab/SKILL.md`;
    const results: AgentsSkillResult[] = [
      { action: "installed", path: at },
      { action: "updated", path: at },
      { action: "already-present", path: at },
      { action: "exists-differs", path: at },
      { action: "refused", path: at, reason: `${home}/.agents/skills is a symlink` },
    ];
    const sentences = results.map((r) => agentsSkillSentence(r, home));
    for (const sentence of sentences) {
      expect(sentence).toContain("~/.agents/skills");
      expect(sentence).not.toContain(home);
    }
    expect(sentences[0]).toBe("Added the review skill to ~/.agents/skills.");
    expect(sentences[1]).toBe("Updated the review skill in ~/.agents/skills.");
    expect(sentences[2]).toBe("The review skill in ~/.agents/skills is up to date.");
    expect(sentences[3]).toMatch(/left as is/);
    expect(sentences[4]).toMatch(/is a symlink — left as is/);
  });
});

const SKILL_SENTENCE = "Added the review skill to ~/.agents/skills.";

describe("connectFormatFirst", () => {
  function host(agents: string | null = "Created AGENTS.md in ws.") {
    const log: string[] = [];
    const io: FormatFirstIo = {
      writeAgentsSnippet: async () => {
        log.push("agents");
        return agents;
      },
      installSkill: async () => {
        log.push("skill");
        return SKILL_SENTENCE;
      },
      tell: (message) => void log.push(`tell: ${message}`),
    };
    return { io, log };
  }

  it("writes AGENTS.md, installs the skill and mdc, and says so in one message — nothing to answer", async () => {
    const { io, log } = host();
    expect(await connectFormatFirst(io)).toBe("connected");
    expect(log).toEqual([
      "agents",
      "skill",
      `tell: Markdown Collab: Created AGENTS.md in ws. ${SKILL_SENTENCE} Agents that read AGENTS.md or ~/.agents/skills now change reviewed files with mdc.`,
    ]);
  });

  it("a failed AGENTS.md write stops there — the skill isn't installed and the error was already shown", async () => {
    const { io, log } = host(null);
    expect(await connectFormatFirst(io)).toBe("failed");
    expect(log).toEqual(["agents"]);
  });
});

describe("Disconnect an Agent: the tools only, never AGENTS.md or the review skill", () => {
  const items = buildDisconnectAgentItems({ cursorInApp: true, copilot: true });

  it("every entry whose Connect wrote AGENTS.md and the skill says both are left as is", () => {
    for (const item of items.filter((i) => i.id !== "claude")) {
      expect(item.detail, item.id).toMatch(/AGENTS\.md and the review skill in ~\/\.agents\/skills are left as is/);
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
