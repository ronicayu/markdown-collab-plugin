// Naming the agent.
//
// The wording rule: if the code knows which agent (an author slug on a
// comment or suggestion, or the agent recorded by a protocol/tool call), copy
// names it through `agentDisplayName`. If it doesn't, copy is generic: "the
// agent", "your agent", "an agent", "Agent" — never "Claude" for an unknown agent. Copy about features that
// genuinely ARE Claude Code — "Run Claude for me", the Claude skill/plugin —
// stays as it is.
//
// This module is the one place that maps an MCP client's self-reported name
// to a short slug, turns a slug into copy, and answers "is this comment an
// agent's?" for every other file to read through. Pure and vscode-free (like
// `pathUtils.ts`) so it works unmodified in the extension host, the `mdc` CLI
// bundle, and every webview client.

/** The slugs this module recognizes by construction — an author string equal
 * to one of these (case-insensitively) reads as an agent comment even on a
 * file whose comments carry no explicit
 * `agent: true` flag at all. Removing a name from this list would silently
 * turn every old file's agent comments back into "someone named codex". */
const KNOWN_AGENT_SLUGS = new Set(["claude", "codex", "cursor", "copilot", "gemini", "agent"]);

const UNKNOWN_SLUG = "agent";

/** `agentSlugFromClientName`'s fallback-token cap — long enough for any real
 * client name, short enough that a pathological one doesn't bloat every
 * comment it writes. */
const MAX_SLUG_LEN = 24;

/**
 * Order matters: `cursor-vscode` must read as `cursor`, not `copilot`, so the
 * specific agent names are checked before the generic "this is VS Code
 * itself" pattern. Everything is matched case-insensitively — clients are not
 * consistent about capitalizing their own name.
 */
export function agentSlugFromClientName(name?: string): string {
  if (!name) return UNKNOWN_SLUG;
  if (/claude/i.test(name)) return "claude";
  if (/codex/i.test(name)) return "codex";
  if (/cursor/i.test(name)) return "cursor";
  if (/copilot|visual studio code|vscode/i.test(name)) return "copilot";
  if (/gemini/i.test(name)) return "gemini";
  const m = /[a-z0-9-]+/.exec(name.toLowerCase());
  if (!m || m[0].length === 0) return UNKNOWN_SLUG;
  return m[0].slice(0, MAX_SLUG_LEN);
}

export interface AgentDisplayName {
  /** Capitalized, for a label or the start of a sentence: "Claude", "Codex", "Agent". */
  noun: string;
  /** How it reads mid-sentence: same as `noun` for a named agent, "the agent" for the generic fallback. */
  sentence: string;
}

const DISPLAY_NAMES: Record<string, AgentDisplayName> = {
  claude: { noun: "Claude", sentence: "Claude" },
  codex: { noun: "Codex", sentence: "Codex" },
  cursor: { noun: "Cursor", sentence: "Cursor" },
  copilot: { noun: "Copilot", sentence: "Copilot" },
  gemini: { noun: "Gemini", sentence: "Gemini" },
  agent: { noun: "Agent", sentence: "the agent" },
};

/** Turn a slug into copy. Unknown slugs are title-cased rather than shown raw. */
export function agentDisplayName(slug: string): AgentDisplayName {
  const known = DISPLAY_NAMES[slug.toLowerCase()];
  if (known) return known;
  const cap = slug.length > 0 ? slug[0]!.toUpperCase() + slug.slice(1) : DISPLAY_NAMES[UNKNOWN_SLUG]!.noun;
  return { noun: cap, sentence: cap };
}

/**
 * The waiting row's wording when the code knows a prompt went out but not who
 * picked it up (an inferred wait, or a sidebar that hasn't seen an agent yet).
 */
export const WAITING_FOR_AGENT = "Waiting for the agent…";

export function sentenceLead(name: AgentDisplayName): string {
  return name.sentence.length > 0 ? name.sentence[0]!.toUpperCase() + name.sentence.slice(1) : name.sentence;
}

/**
 * Name the agent(s) behind a group of author slugs — the "N new from X" /
 * "X is working…" family. Say the one agent's name when every
 * slug in the group is the same; fall back to the generic plural when more
 * than one distinct agent contributed, because naming just one of several
 * would imply the others didn't participate. An empty group has no agent to
 * name, so it reads as the generic "Agent" rather than guessing Claude.
 */
export function agentGroupLabel(slugs: Iterable<string>): AgentDisplayName {
  const distinct = new Set([...slugs].map((s) => s.toLowerCase()));
  if (distinct.size === 0) return agentDisplayName(UNKNOWN_SLUG);
  if (distinct.size === 1) return agentDisplayName([...distinct][0]!);
  return { noun: "Agents", sentence: "agents" };
}

export interface AuthoredEntity {
  author: string;
  /** Set explicitly by the tools/CLI on every comment or suggestion an agent writes. */
  agent?: boolean;
}

/**
 * Two ways to qualify, either sufficient on its own: the explicit `agent:
 * true` flag every NEW agent-written comment carries, or — for a file
 * written before this change, which has no such flag at all — an author
 * string that is one of the slugs this module has always recognized. The
 * known-slug fallback is what keeps every comment ever written by this
 * extension reading correctly without a migration; it does mean a human who
 * happens to be named "codex" reads as the agent.
 */
export function isAgentComment(c: AuthoredEntity): boolean {
  if (c.agent === true) return true;
  return KNOWN_AGENT_SLUGS.has(c.author.toLowerCase());
}
