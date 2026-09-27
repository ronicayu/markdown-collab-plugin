// Naming the agent (10x-plan-4 P1.2).
//
// WHY THIS EXISTS. Every agent-written comment used to be stamped
// `author: "claude"` and every "is this from the agent?" check compared to
// that literal — accurate when Claude Code was the only thing that could
// call the tools, wrong the moment P1.1 let Cursor, Codex, Copilot and
// anything else speaking MCP connect too. A Codex reply showed up as
// Claude's, and — the more damaging half — a thread another agent had just
// answered still read as "waiting on you" wherever the check happened to be
// `!== "claude"` instead of "did *an* agent already reply".
//
// This module is the one place that maps an MCP client's self-reported name
// to a short slug, turns a slug into copy, and answers "is this comment an
// agent's?" for every other file to read through. Pure and vscode-free (like
// `pathUtils.ts`) so it works unmodified in the extension host, the `mdc` CLI
// bundle, and every webview client.

/** The slugs this module recognizes by construction — an author string equal
 * to one of these (case-insensitively) reads as an agent comment even on a
 * file written before this change, when no comment carries the explicit
 * `agent: true` flag at all. Removing a name from this list would silently
 * turn every old file's agent comments back into "someone named codex". */
const KNOWN_AGENT_SLUGS = new Set(["claude", "codex", "cursor", "copilot", "gemini", "agent"]);

/** A slug's fallback has nowhere left to go — the generic label. */
const UNKNOWN_SLUG = "agent";

/** `agentSlugFromClientName`'s fallback-token cap — long enough for any real
 * client name, short enough that a pathological one doesn't bloat every
 * comment it writes. */
const MAX_SLUG_LEN = 24;

/**
 * Map an MCP `initialize` `clientInfo.name` to a short author slug.
 *
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

/** The two shapes a display name is needed in. */
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
 * Name the agent(s) behind a group of author slugs — the "N new from X" /
 * "X is working…" family (the wording rule, 10x-plan-4 P1.2). Say the one
 * agent's name when every slug in the group is the same; fall back to the
 * generic plural when more than one distinct agent contributed, because
 * naming just one of several would imply the others didn't participate. An
 * empty group reads as Claude — every caller of this only calls it once it
 * already knows at least one agent is involved, and Claude is the safe
 * default when that provenance somehow got lost.
 */
export function agentGroupLabel(slugs: Iterable<string>): AgentDisplayName {
  const distinct = new Set([...slugs].map((s) => s.toLowerCase()));
  if (distinct.size === 0) return agentDisplayName("claude");
  if (distinct.size === 1) return agentDisplayName([...distinct][0]!);
  return { noun: "Agents", sentence: "agents" };
}

/** The shape `isAgentComment` needs — satisfied by both `InlineComment` and `InlineSuggestion`. */
export interface AuthoredEntity {
  author: string;
  /** Set explicitly by the tools/CLI on every comment or suggestion an agent writes. */
  agent?: boolean;
}

/**
 * Is this comment (or suggestion) an agent's?
 *
 * Two ways to qualify, either sufficient on its own: the explicit `agent:
 * true` flag every NEW agent-written comment carries, or — for a file
 * written before this change, which has no such flag at all — an author
 * string that is one of the slugs this module has always recognized. The
 * known-slug fallback is what keeps every comment ever written by this
 * extension reading correctly without a migration; it does mean a human who
 * happens to be named "codex" reads as the agent, which is the same
 * trade-off the literal `=== "claude"` check it replaces always made.
 */
export function isAgentComment(c: AuthoredEntity): boolean {
  if (c.agent === true) return true;
  return KNOWN_AGENT_SLUGS.has(c.author.toLowerCase());
}
