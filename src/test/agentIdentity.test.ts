import { describe, expect, it } from "vitest";
import {
  agentDisplayName,
  agentGroupLabel,
  agentSlugFromClientName,
  isAgentComment,
} from "../agentIdentity";

describe("agentSlugFromClientName", () => {
  const cases: Array<[string | undefined, string]> = [
    ["claude-code", "claude"],
    ["Claude Code", "claude"],
    ["codex-mcp-client", "codex"],
    ["cursor-vscode", "cursor"],
    ["Visual Studio Code", "copilot"],
    ["gemini-cli-mcp-client", "gemini"],
    ["", "agent"],
    [undefined, "agent"],
    ["My Weird Client 2", "my"],
  ];

  for (const [name, expected] of cases) {
    it(`maps ${JSON.stringify(name)} to "${expected}"`, () => {
      expect(agentSlugFromClientName(name)).toBe(expected);
    });
  }

  it("caps a pathological client name rather than embedding it whole", () => {
    const slug = agentSlugFromClientName("a".repeat(500));
    expect(slug.length).toBeLessThanOrEqual(24);
  });

  it("is case-insensitive for every known agent", () => {
    expect(agentSlugFromClientName("CODEX-CLI")).toBe("codex");
    expect(agentSlugFromClientName("GEMINI-CLI")).toBe("gemini");
  });
});

describe("agentDisplayName", () => {
  it("names the agents this module knows about", () => {
    expect(agentDisplayName("claude")).toEqual({ noun: "Claude", sentence: "Claude" });
    expect(agentDisplayName("codex")).toEqual({ noun: "Codex", sentence: "Codex" });
    expect(agentDisplayName("cursor")).toEqual({ noun: "Cursor", sentence: "Cursor" });
    expect(agentDisplayName("copilot")).toEqual({ noun: "Copilot", sentence: "Copilot" });
    expect(agentDisplayName("gemini")).toEqual({ noun: "Gemini", sentence: "Gemini" });
  });

  it("reads as 'the agent' mid-sentence for the generic slug", () => {
    expect(agentDisplayName("agent")).toEqual({ noun: "Agent", sentence: "the agent" });
  });

  it("title-cases an unrecognized slug rather than showing it raw", () => {
    expect(agentDisplayName("my")).toEqual({ noun: "My", sentence: "My" });
  });

  it("is case-insensitive", () => {
    expect(agentDisplayName("CODEX")).toEqual({ noun: "Codex", sentence: "Codex" });
  });
});

describe("agentGroupLabel", () => {
  it("names the one agent when every slug in the group agrees", () => {
    expect(agentGroupLabel(["claude", "claude"]).noun).toBe("Claude");
    expect(agentGroupLabel(["codex"]).noun).toBe("Codex");
  });

  it("is case-insensitive when deciding whether the group agrees", () => {
    expect(agentGroupLabel(["Codex", "codex"]).noun).toBe("Codex");
  });

  it("falls back to the generic plural for more than one distinct agent", () => {
    expect(agentGroupLabel(["claude", "codex"])).toEqual({ noun: "Agents", sentence: "agents" });
    expect(agentGroupLabel(["codex", "cursor"])).toEqual({ noun: "Agents", sentence: "agents" });
  });

  it("defaults to Claude for an empty group", () => {
    expect(agentGroupLabel([]).noun).toBe("Claude");
  });
});

describe("isAgentComment", () => {
  it("is true for every known slug, with no explicit flag — back-compat for files written before this change", () => {
    for (const slug of ["claude", "codex", "cursor", "copilot", "gemini", "agent"]) {
      expect(isAgentComment({ author: slug })).toBe(true);
    }
  });

  it("is case-insensitive on the known-slug fallback", () => {
    expect(isAgentComment({ author: "Codex" })).toBe(true);
  });

  it("is false for a human author with no explicit flag", () => {
    expect(isAgentComment({ author: "ronica" })).toBe(false);
  });

  it("the explicit `agent: true` flag is sufficient on its own", () => {
    expect(isAgentComment({ author: "some-future-agent", agent: true })).toBe(true);
  });

  it("an explicit `agent: false` does not override a known slug", () => {
    // The flag is additive evidence, not a veto — the known-slug list still
    // stands even if some future caller sets the flag to false (which nothing
    // in this codebase does, but the contract should be unambiguous).
    expect(isAgentComment({ author: "claude", agent: false })).toBe(true);
  });
});
