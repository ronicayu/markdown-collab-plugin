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
  opCheck,
  opCheckpoint,
  opList,
  opOpen,
  opReject,
  opReply,
  opResolve,
  opRewrite,
  opSuggest,
  type OpOutcome,
} from "../inlineComments/docOps";
import type { McpTool, ToolResult } from "./protocol";

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
   * it is the first hard evidence that Claude is actually working.
   */
  onCall?(event: { tool: string; file?: string; note?: string }): void;
  now?(): string;
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

const FILE_PROP = {
  file: {
    type: "string",
    description: "Path to the .md file, absolute or relative to the workspace root.",
  },
} as const;

export const TOOLS: readonly McpTool[] = [
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
          description: "Only threads that are open and not already answered by claude.",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "mc_reply",
    title: "Reply to a thread",
    description:
      "Append a reply authored by claude to an existing thread. Use this to answer the human's question — " +
      "it is not a way to edit the document.",
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
      "Use this to apply a change the human asked for in that thread.",
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
      "original until they accept. Use this whenever suggest mode is requested.",
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
      "End every pass with this: it clears the human's 'Claude is working…' indicator, and the record it " +
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

function optionalStr(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new ToolRefusal("invalid_arguments", `${name} must be a string`);
  }
  return v;
}

function occurrenceOf(args: Record<string, unknown>): number {
  const v = args.occurrence;
  if (v === undefined || v === null) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new ToolRefusal("invalid_arguments", "occurrence must be a non-negative integer");
  }
  return n;
}

/**
 * Run one tool call. Every refusal — bad arguments, unknown thread, a change
 * that would break integrity — comes back as an `isError` result carrying a
 * machine-readable code, and the document is left untouched.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<ToolResult> {
  try {
    if (name === "mc_status") {
      const note = str(args, "note");
      deps.onCall?.({ tool: name, file: optionalStr(args, "file"), note });
      return text({ ok: true, note });
    }

    const key = await deps.resolveFile(str(args, "file"));
    deps.onCall?.({ tool: name, file: key });
    const source = await deps.readDoc(key);
    const now = deps.now;

    // Read-only tools first — no write, no integrity gate.
    if (name === "mc_list") {
      return text({ file: key, ...opList(source, args.actionable === true) });
    }
    if (name === "mc_check") {
      const report = opCheck(source);
      // A healthy document also gets a review checkpoint: this call is the one
      // moment we know a pass over this file finished (P1.1). A broken one is
      // reported and left alone — checkpointing damage would tell the next pass
      // the damage had been reviewed.
      if (report.ok) {
        try {
          const stamped = opCheckpoint(source, now);
          await deps.writeDoc(key, stamped.next);
          return text({ file: key, ...report, checkpointed: stamped.result.checkpoint.ts });
        } catch {
          // The checkpoint is a nicety; never turn a clean check into a failure.
          return text({ file: key, ...report });
        }
      }
      return text({ file: key, ...report });
    }

    const write = async <T>(outcome: OpOutcome<T>, action: string): Promise<ToolResult> => {
      await deps.writeDoc(key, outcome.next);
      return text({ action, file: key, ...outcome.result });
    };

    switch (name) {
      case "mc_reply":
        return write(opReply(source, str(args, "threadId"), str(args, "body"), now), "reply");
      case "mc_open":
        return write(
          opOpen(source, str(args, "quote"), str(args, "body"), occurrenceOf(args), now),
          "open",
        );
      case "mc_rewrite":
        return write(opRewrite(source, str(args, "threadId"), str(args, "with")), "rewrite");
      case "mc_resolve":
        return write(opResolve(source, str(args, "threadId"), now), "resolve");
      case "mc_suggest":
        return write(
          opSuggest(
            source,
            str(args, "quote"),
            str(args, "with"),
            {
              note: optionalStr(args, "note"),
              threadId: optionalStr(args, "threadId"),
              occurrence: occurrenceOf(args),
            },
            now,
          ),
          "suggest",
        );
      case "mc_accept":
        return write(opAccept(source, str(args, "anchorId")), "accept");
      case "mc_reject":
        return write(opReject(source, str(args, "anchorId")), "reject");
      default:
        return refusal("unknown_tool", `unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof DocOpError) return refusal(e.code, e.message, e.details);
    if (e instanceof ToolRefusal) return refusal(e.code, e.message, e.details);
    // Host-side failures (file gone, edit rejected by the editor) are refusals
    // too as far as Claude is concerned: the operation did not happen.
    return refusal("host_error", (e as Error).message);
  }
}
