// The `mc_*` tools Claude calls, dispatched onto the shared review ops.
//
// These are the same verbs as the `mdc` CLI, and they run the same functions
// (`inlineComments/docOps.ts`) — the only difference is what happens either side
// of the operation. The CLI reads and writes the file directly; here the host
// injects document I/O that goes through a `WorkspaceEdit`, so Claude's edits
// are ordered against unsaved buffers, land in the editor's undo stack, and are
// validated before they touch anything.
//
// Pure apart from the injected `ToolDeps`, so the whole tool surface is
// unit-testable against an in-memory document.

import {
  DocOpError,
  opAccept,
  opCheckAndCheckpoint,
  opEdit,
  opList,
  opOpen,
  opReject,
  opReply,
  opResolve,
  opRewrite,
  opSuggest,
  parseOccurrence,
  type OpOutcome,
} from "../inlineComments/docOps";
import type { McpTool, ToolResult } from "./protocol";
import { renderSkill } from "../skillText";

export interface ToolDeps {
  /**
   * Turn a caller-supplied path into a document key the host can read/write.
   * Throws `ToolRefusal` when the path escapes the workspace or doesn't exist —
   * the boundary that keeps a tool call from reaching arbitrary files.
   */
  resolveFile(file: string): Promise<string>;
  readDoc(key: string): Promise<string>;
  /** Apply `next` to the document. Rejects if the edit could not be applied. */
  writeDoc(key: string, next: string): Promise<void>;
  /**
   * Called for every tool invocation before it runs, with the resolved document
   * key when the tool names one. The lifecycle signals (P0.2) hang off this:
   * it is the first hard evidence that Claude is actually working. `agent` is
   * the calling session's slug (10x-plan-4 P1.2).
   */
  onCall?(event: { tool: string; file?: string; note?: string; agent: string }): void;
  /** Fired when a call is refused. The result still goes back to Claude. */
  onRefusal?(event: { tool: string; code: string; message: string }): void;
  now?(): string;
  /**
   * Whether the human's `markdownCollab.proposeEditsAsSuggestions` choice is on
   * for this document (10x-plan-6 P2.1), keyed by the same document key
   * `resolveFile` returned. `mc_edit`/`mc_rewrite` refuse outright when it is —
   * optional so a caller that predates the setting (a test harness, the
   * `mdc` CLI's own local-write path, which can't ask a VS Code window
   * anything) keeps today's behaviour: direct edits allowed.
   */
  suggestModeFor?(file: string): boolean;
}

/** A refusal the caller should see as a tool error, not a transport failure. */
export class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolRefusal";
  }
}

/**
 * 10x-plan-6 P2.1: suggest mode used to be a request the agent could ignore
 * (and did — the plan's whole reason for enforcing it here). `mc_edit` and
 * `mc_rewrite` now refuse outright when it's on for the file, writing
 * nothing; the forwarded `mdc edit`/`mdc rewrite` inherit the refusal for
 * free because they run this same `callTool`.
 */
function refuseIfSuggestMode(deps: ToolDeps, key: string): void {
  if (deps.suggestModeFor?.(key)) {
    throw new ToolRefusal(
      "suggest_mode_on",
      "Suggest mode is on for this file — propose the change with mc_suggest instead",
    );
  }
}

/**
 * 10x-plan-6 P2.3: a suggestion is meant to read as one sentence or one list
 * item, not a whole paragraph pasted into `with`. The multiplier gives a
 * short quote room to grow into a fuller clause; the flat floor keeps a long
 * quote from earning a proportionally enormous replacement. Whichever is
 * larger wins, so neither end of the quote-length range is unfairly strict.
 */
export const SUGGESTION_MAX_MULTIPLE_OF_QUOTE = 3;
export const SUGGESTION_MIN_CHARS = 300;

/** Exported for tests — the refusal itself only ever runs through `mc_suggest`. */
export function suggestionTooLarge(quote: string, replacement: string): boolean {
  return replacement.length > Math.max(SUGGESTION_MAX_MULTIPLE_OF_QUOTE * quote.length, SUGGESTION_MIN_CHARS);
}

const FILE_PROP = {
  file: {
    type: "string",
    description: "Path to the .md file, absolute or relative to the workspace root.",
  },
} as const;

const BASE_TOOLS: readonly McpTool[] = [
  {
    name: "mc_list",
    title: "List review threads",
    description:
      "List the review threads and pending suggestions in a Markdown Collab document. " +
      "Set actionable=true for only the threads still waiting on you (open, and whose last comment isn't yours). " +
      "Always start here: thread ids from this call are what every other tool takes.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        actionable: {
          type: "boolean",
          // Read by every connected agent (10x-plan-4 P1.1), not just Claude —
          // "you" here is whichever agent is asking, per its own session.
          description: "Only threads that are open and not already answered by you.",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "mc_reply",
    title: "Reply to a thread",
    description:
      "Append a reply, authored by you, to an existing thread. Use this to answer the human's question — " +
      "it is not a way to edit the document. Replying to a resolved thread reopens it " +
      "(the result says reopened: true).",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        threadId: { type: "string", description: "Thread id from mc_list." },
        body: { type: "string", description: "Markdown body of the reply." },
      },
      required: ["file", "threadId", "body"],
    },
  },
  {
    name: "mc_open",
    title: "Open a new thread",
    description:
      "Open a new review thread on a passage, locating it by exact quoted text. " +
      "This is how you leave review comments for the human. If the passage appears more than once, " +
      "pass occurrence (1-based) — the call is refused rather than guessing.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        quote: { type: "string", description: "Exact text to anchor the thread to." },
        body: { type: "string", description: "Markdown body of the comment." },
        occurrence: {
          type: "number",
          description: "1-based occurrence of `quote` when it appears more than once.",
        },
      },
      required: ["file", "quote", "body"],
    },
  },
  {
    name: "mc_rewrite",
    title: "Rewrite an anchored span",
    description:
      "Replace the text a thread is anchored to, keeping its markers intact. " +
      "Use this to apply a change the human asked for in that thread. Refused with suggest_mode_on when " +
      "suggest mode is on for the file — use mc_suggest instead.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        threadId: { type: "string", description: "Thread id from mc_list." },
        with: { type: "string", description: "Replacement text for the anchored span." },
      },
      required: ["file", "threadId", "with"],
    },
  },
  {
    name: "mc_edit",
    title: "Edit prose",
    description:
      "Replace exact text in the document, for prose outside anchored spans — to change text inside a thread's " +
      "anchor, use mc_rewrite instead. To delete an anchored passage, make `old` span its open marker, the " +
      "passage and its close marker: the thread is left unanchored, by design. Anything else that touches a " +
      "review marker (splits one, or holds only one of a pair) or the threads region is refused with " +
      "not_editable. Ambiguous text (appears more than once) is refused unless occurrence (1-based) is given. " +
      "Refused with suggest_mode_on when suggest mode is on for the file — use mc_suggest instead.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        old: { type: "string", description: "Exact current text to replace, as it appears in the file." },
        new: { type: "string", description: "Replacement text. May be empty to delete." },
        occurrence: {
          type: "number",
          description: "1-based occurrence of `old` when it appears more than once.",
        },
      },
      required: ["file", "old", "new"],
    },
  },
  {
    name: "mc_resolve",
    title: "Resolve a thread",
    description: "Mark a thread resolved once it has been dealt with.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        threadId: { type: "string", description: "Thread id from mc_list." },
      },
      required: ["file", "threadId"],
    },
  },
  {
    name: "mc_suggest",
    title: "Propose an edit as a suggestion",
    description:
      "Propose a change the human accepts or rejects, instead of applying it. The document still reads as the " +
      "original until they accept. Use this whenever suggest mode is requested. One suggestion, one sentence or " +
      "list item — a `with` far longer than `quote` is refused with suggestion_too_large; split a paragraph " +
      "rewrite into several suggestions instead.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        quote: { type: "string", description: "Exact current text to replace." },
        with: { type: "string", description: "Proposed replacement." },
        note: { type: "string", description: "Short rationale shown with the suggestion." },
        threadId: { type: "string", description: "Thread this suggestion answers, if any." },
        occurrence: {
          type: "number",
          description: "1-based occurrence of `quote` when it appears more than once.",
        },
      },
      required: ["file", "quote", "with"],
    },
  },
  {
    name: "mc_accept",
    title: "Accept a suggestion",
    description:
      "Apply a pending suggestion. Normally the human's call — use only when they explicitly ask you to accept.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        anchorId: { type: "string", description: "Suggestion anchor id from mc_list." },
      },
      required: ["file", "anchorId"],
    },
  },
  {
    name: "mc_reject",
    title: "Reject a suggestion",
    description: "Drop a pending suggestion, keeping the original text.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILE_PROP,
        anchorId: { type: "string", description: "Suggestion anchor id from mc_list." },
      },
      required: ["file", "anchorId"],
    },
  },
  {
    name: "mc_check",
    title: "Check document integrity",
    description:
      "Report anchor/thread integrity for a document, and record that you reviewed it in this state. " +
      "End every pass with this: it clears the human's 'is working…' indicator, and the record it " +
      "leaves is what lets the next pass review only what changed.",
    inputSchema: {
      type: "object",
      properties: { ...FILE_PROP },
      required: ["file"],
    },
  },
  {
    name: "mc_status",
    title: "Report progress",
    description:
      "Tell the human what you are doing right now (\"reading 2 of 3 files\", \"opening threads on §Setup\"). " +
      "Shown next to the waiting indicator. Costs nothing and replaces silence during a long pass.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "One short phrase, present tense." },
        file: { type: "string", description: "File the work concerns, if any." },
      },
      required: ["note"],
    },
  },
];

/**
 * The tools that change a document. Their descriptions point at `mc_help`: a
 * client that doesn't surface the server's `instructions` sees nothing of the
 * workflow but these descriptions, and a write is where a wrong guess costs.
 */
const MUTATING_TOOLS = new Set([
  "mc_reply",
  "mc_open",
  "mc_rewrite",
  "mc_edit",
  "mc_resolve",
  "mc_suggest",
  "mc_accept",
  "mc_reject",
]);

export const HELP_HINT = " If unsure of the workflow, call mc_help first.";

/**
 * `mc_help` (10x-plan-4 P1.3): the whole tools-only workflow, for clients that
 * don't show `instructions` to the model (or show them and still leave it
 * unsure). The same text a headless run gets as its system prompt, minus that
 * run's preamble — see `renderSkill` in skillText.ts.
 */
const HELP_TOOL: McpTool = {
  name: "mc_help",
  title: "Review workflow",
  description:
    "Return the full Markdown Collab review workflow: how to address comments, review mode, suggest mode, " +
    "verification, and what to report. Takes no arguments. Call it before your first edit if you haven't " +
    "been given the workflow.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const TOOLS: readonly McpTool[] = [
  ...BASE_TOOLS.map((t) => (MUTATING_TOOLS.has(t.name) ? { ...t, description: t.description + HELP_HINT } : t)),
  HELP_TOOL,
];

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function refusal(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } }, null, 2),
      },
    ],
  };
}

function str(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v === "") {
    throw new ToolRefusal("invalid_arguments", `missing required argument: ${name}`);
  }
  return v;
}

/**
 * Like `str`, but accepts "" — `mc_edit`'s `new` is legitimately empty (a
 * deletion), where `str`'s "missing" heuristic would wrongly refuse it.
 */
function strAllowEmpty(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string") {
    throw new ToolRefusal("invalid_arguments", `missing required argument: ${name}`);
  }
  return v;
}

function optionalStr(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new ToolRefusal("invalid_arguments", `${name} must be a string`);
  }
  return v;
}

/**
 * Run one tool call. Every refusal — bad arguments, unknown thread, a change
 * that would break integrity — comes back as an `isError` result carrying a
 * machine-readable code, and the document is left untouched.
 */
/** Read the machine-readable code back out of a refusal result, for logging. */
function refusalCode(r: ToolResult): string {
  try {
    const first = r.content?.[0];
    if (first && first.type === "text") {
      // `refusal()` nests the code under `error`; reading the top level logged
      // every refusal as "unknown".
      const parsed = JSON.parse(first.text) as { error?: { code?: unknown } };
      return String(parsed.error?.code ?? "unknown");
    }
  } catch {
    /* the log line is worth less than the refusal it describes */
  }
  return "unknown";
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
  /**
   * The calling session's agent slug (10x-plan-4 P1.2) — resolved by the
   * protocol layer from `initialize`'s `clientInfo.name` before the call ever
   * reaches here. Defaults to `claude` so every existing caller (the `mdc`
   * CLI without `--author`, a test harness that never wires up sessions)
   * keeps behaving exactly as it did before this parameter existed.
   */
  author = "claude",
): Promise<ToolResult> {
  try {
    if (name === "mc_help") {
      deps.onCall?.({ tool: name, agent: author });
      return { content: [{ type: "text", text: renderSkill("headless") }] };
    }
    if (name === "mc_status") {
      const note = str(args, "note");
      deps.onCall?.({ tool: name, file: optionalStr(args, "file"), note, agent: author });
      return text({ ok: true, note });
    }

    const key = await deps.resolveFile(str(args, "file"));
    deps.onCall?.({ tool: name, file: key, agent: author });
    const source = await deps.readDoc(key);
    const now = deps.now;

    // Read-only tools first — no write, no integrity gate.
    if (name === "mc_list") {
      return text({ file: key, ...opList(source, args.actionable === true) });
    }
    if (name === "mc_check") {
      // A healthy document also gets a review checkpoint: this call is the one
      // moment we know a pass over this file finished (P1.1). Shared with
      // `mdc check` (no `--repair`) via `opCheckAndCheckpoint` so the two
      // front ends can't drift on when a checkpoint gets written.
      const { report, next, checkpoint } = opCheckAndCheckpoint(source, now);
      if (next !== undefined && checkpoint) {
        await deps.writeDoc(key, next);
        return text({ file: key, ...report, checkpointed: checkpoint.ts });
      }
      return text({ file: key, ...report });
    }

    const write = async <T>(outcome: OpOutcome<T>, action: string): Promise<ToolResult> => {
      await deps.writeDoc(key, outcome.next);
      return text({ action, file: key, ...outcome.result });
    };

    // Every comment or suggestion written here is stamped as arriving through
    // the tools (10x-plan-6 P1.4) — a forwarded `mdc` write included, since it
    // is this same call by the time it lands.
    switch (name) {
      case "mc_reply":
        return write(opReply(source, str(args, "threadId"), str(args, "body"), now, author, true, "tools"), "reply");
      case "mc_open":
        return write(
          opOpen(source, str(args, "quote"), str(args, "body"), parseOccurrence(args.occurrence), now, author, "tools"),
          "open",
        );
      case "mc_rewrite":
        refuseIfSuggestMode(deps, key);
        return write(opRewrite(source, str(args, "threadId"), str(args, "with")), "rewrite");
      case "mc_edit":
        refuseIfSuggestMode(deps, key);
        return write(
          opEdit(source, str(args, "old"), strAllowEmpty(args, "new"), parseOccurrence(args.occurrence)),
          "edit",
        );
      case "mc_resolve":
        return write(opResolve(source, str(args, "threadId"), now, author), "resolve");
      case "mc_suggest": {
        const quote = str(args, "quote");
        const proposed = str(args, "with");
        if (suggestionTooLarge(quote, proposed)) {
          throw new ToolRefusal(
            "suggestion_too_large",
            `suggestion is too large (${proposed.length} chars replacing a ${quote.length}-char quote) — ` +
              "split it into smaller suggestions, one sentence or list item each",
          );
        }
        return write(
          opSuggest(
            source,
            quote,
            proposed,
            {
              note: optionalStr(args, "note"),
              threadId: optionalStr(args, "threadId"),
              occurrence: parseOccurrence(args.occurrence),
            },
            now,
            author,
            "tools",
          ),
          "suggest",
        );
      }
      case "mc_accept":
        return write(opAccept(source, str(args, "anchorId")), "accept");
      case "mc_reject":
        return write(opReject(source, str(args, "anchorId")), "reject");
      default:
        return refusal("unknown_tool", `unknown tool: ${name}`);
    }
  } catch (e) {
    // Refusals are reported to Claude as `isError` results, which means the
    // human never sees them — the model reads the error and moves on, and the
    // document simply doesn't change. Log every one, or "Claude said it was
    // done but nothing happened" has no evidence behind it.
    const r =
      e instanceof DocOpError || e instanceof ToolRefusal
        ? refusal(e.code, e.message, e.details)
        : refusal("host_error", (e as Error).message);
    deps.onRefusal?.({ tool: name, code: refusalCode(r), message: (e as Error).message });
    return r;
  }
}
