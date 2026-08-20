// `mdc` — the CLI Claude uses to mutate inline-comment documents.
//
// WHY THIS EXISTS (10x-plan P0.1): the skill used to ask Claude to hand-edit
// `<!--mc:a:ID-->` markers and `<!--mc:t {JSON}-->` lines with string surgery.
// A single dropped `-->` orphans a reviewer's comment, and the skill warned
// about it three separate times — a tell that prose instructions were not
// enough. Every marker-level mutation now goes through the same engine the
// extension uses, so the integrity risk stops living in the model's diligence.
//
// This file is bundled (esbuild, ESM, zero deps) into `mdc.mjs` and installed
// next to the skill. It imports the real format engine — it must never grow
// its own copy of the parser.
//
// Since 10x-plan-2 P0.1 the verbs themselves live in `inlineComments/docOps.ts`,
// shared with the extension-hosted MCP server: this file is argv parsing, file
// I/O, and exit codes over those ops. Fixing a rule in one front end fixes it in
// both, which is the point — a CLI that accepted an edit the MCP tools refused
// would be a second, quieter definition of the format.
//
// Contract with the caller:
//   - stdout is always a single JSON document, written with writeSync(1) so
//     it survives a POSIX pipe without buffering loss
//   - stderr carries human-readable errors
//   - exit 0 = success, 1 = command/usage error, 2 = integrity violation
//
// Mutations are validated before the write, and refuse to leave the file worse
// than they found it.

import { writeSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { stripAllInlineMarkup } from "../inlineComments/format";
import { checkIntegrity, repairIntegrity } from "../inlineComments/integrity";
import {
  DocOpError,
  opAccept,
  opCheck,
  opList,
  opOpen,
  opReject,
  opReply,
  opResolve,
  opRewrite,
  opSuggest,
  type DocOpCode,
  type OpOutcome,
} from "../inlineComments/docOps";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_INTEGRITY = 2;

const USAGE = `mdc — Markdown Collab inline-comment CLI

  mdc list <file> [--actionable]              threads as JSON
  mdc reply <file> <threadId> --body TEXT     append a reply authored by claude
  mdc rewrite <file> <threadId> --with TEXT   replace the anchored span, markers preserved
  mdc open <file> --quote TEXT --body TEXT [--occurrence N]
                                              open a new thread on a passage
  mdc resolve <file> <threadId>               mark a thread resolved
  mdc suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N]
                                              propose an edit (accept/reject in the UI)
  mdc accept <file> <anchorId>                apply a pending suggestion
  mdc reject <file> <anchorId>                drop a pending suggestion, keep the original
  mdc check <file> [--repair]                 integrity report; exit 2 if broken

All commands print JSON to stdout. Exit codes: 0 ok, 1 usage, 2 integrity.`;

function out(obj: unknown): void {
  writeSync(1, `${JSON.stringify(obj, null, 2)}\n`);
}

function fail(message: string, code = EXIT_USAGE): never {
  process.stderr.write(`mdc: ${message}\n`);
  process.exit(code);
}

/**
 * Which exit status each refusal reason maps to. Integrity-class refusals
 * (a broken anchor, a change that would corrupt the file) are exit 2 so a
 * caller can tell "you asked for the wrong thing" from "the document is
 * damaged"; everything else is a usage error.
 */
const EXIT_FOR_CODE: Record<DocOpCode, number> = {
  thread_not_found: EXIT_USAGE,
  suggestion_not_found: EXIT_USAGE,
  passage_not_found: EXIT_USAGE,
  passage_ambiguous: EXIT_USAGE,
  not_anchorable: EXIT_USAGE,
  unanchored: EXIT_USAGE,
  // Only reachable through the editor's selection path, but the map is
  // exhaustive over DocOpCode on purpose: a new refusal must be given an exit
  // status deliberately rather than defaulting to one.
  empty_selection: EXIT_USAGE,
  out_of_range: EXIT_USAGE,
  nothing_to_do: EXIT_USAGE,
  integrity: EXIT_INTEGRITY,
};

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function str(flags: Args["flags"], name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v === "") fail(`missing required --${name}`);
  return v;
}

function readDoc(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return fail(err.code === "ENOENT" ? `no such file: ${file}` : `cannot read ${file}: ${err.message}`);
  }
}

/**
 * Run a mutating op and write the result. Refusals from the shared ops arrive as
 * DocOpError and become the CLI's own exit codes; `unanchored` on a suggestion
 * is reported as an integrity problem, matching what a `check` would say about
 * the same document.
 */
function apply<T>(
  file: string,
  action: string,
  run: (source: string) => OpOutcome<T>,
  opts: { integrityCodes?: DocOpCode[] } = {},
): void {
  const source = readDoc(file);
  let outcome: OpOutcome<T>;
  try {
    outcome = run(source);
  } catch (e) {
    if (e instanceof DocOpError) {
      const escalated = opts.integrityCodes?.includes(e.code) ? EXIT_INTEGRITY : EXIT_FOR_CODE[e.code];
      const hint = e.code === "unanchored" || e.code === "integrity" ? " (see `mdc check`)" : "";
      // The shared ops phrase "occurrence" without a flag, since the MCP tools
      // take it as a field. Name the flag here, where the caller has one.
      if (e.code === "passage_ambiguous") {
        const n = e.details?.occurrences;
        return fail(
          `passage appears ${n} times; pass --occurrence 1..${n} to say which one you mean`,
          escalated,
        );
      }
      return fail(`${e.message}${hint}`, escalated);
    }
    throw e;
  }
  writeFileSync(file, outcome.next, "utf8");
  out({ action, file, ...outcome.result, integrityOk: checkIntegrity(outcome.next).ok });
}

function cmdList(file: string, actionableOnly: boolean): void {
  out({ file, ...opList(readDoc(file), actionableOnly) });
}

function cmdReply(file: string, threadId: string, body: string): void {
  apply(file, "reply", (s) => opReply(s, threadId, body));
}

function cmdRewrite(file: string, threadId: string, replacement: string): void {
  apply(file, "rewrite", (s) => opRewrite(s, threadId, replacement));
}

function cmdOpen(file: string, quote: string, body: string, occurrence: number): void {
  apply(file, "open", (s) => opOpen(s, quote, body, occurrence));
}

function cmdResolve(file: string, threadId: string): void {
  apply(file, "resolve", (s) => opResolve(s, threadId));
}

function cmdSuggest(
  file: string,
  quote: string,
  proposed: string,
  note: string | undefined,
  occurrence: number,
): void {
  apply(file, "suggest", (s) => opSuggest(s, quote, proposed, { note, occurrence }));
}

function cmdAccept(file: string, anchorId: string): void {
  // A suggestion that lost its markers is a damaged document, not a typo in the
  // command — exit 2 so a wrapper can tell the two apart.
  apply(file, "accept", (s) => opAccept(s, anchorId), { integrityCodes: ["unanchored"] });
}

function cmdReject(file: string, anchorId: string): void {
  apply(file, "reject", (s) => opReject(s, anchorId));
}

function cmdCheck(file: string, repair: boolean): void {
  const source = readDoc(file);
  if (!repair) {
    const report = opCheck(source);
    out({ file, ...report });
    process.exit(report.ok ? EXIT_OK : EXIT_INTEGRITY);
  }

  const result = repairIntegrity(source);
  if (result.source !== source) {
    // The prose rule is enforced inside repairIntegrity, but this is the
    // process that actually writes to the user's file — verify again here.
    if (stripAllInlineMarkup(result.source) !== stripAllInlineMarkup(source)) {
      fail("internal error: repair would have altered prose; nothing was written", EXIT_INTEGRITY);
    }
    writeFileSync(file, result.source, "utf8");
  }
  out({
    file,
    repaired: result.repairs.length,
    repairs: result.repairs,
    ok: result.remaining.length === 0,
    remaining: result.remaining.map((i) => ({
      kind: i.kind,
      threadId: i.threadId,
      repairable: i.repairable,
      message: i.message,
    })),
  });
  process.exit(result.remaining.length === 0 ? EXIT_OK : EXIT_INTEGRITY);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    writeSync(1, `${USAGE}\n`);
    process.exit(argv.length === 0 ? EXIT_USAGE : EXIT_OK);
  }
  const { _, flags } = parseArgs(argv);
  const [command, ...rest] = _;

  switch (command) {
    case "list":
      if (!rest[0]) fail("usage: mdc list <file> [--actionable]");
      return cmdList(rest[0], flags.actionable === true);
    case "reply":
      if (!rest[0] || !rest[1]) fail("usage: mdc reply <file> <threadId> --body TEXT");
      return cmdReply(rest[0], rest[1], str(flags, "body"));
    case "rewrite":
      if (!rest[0] || !rest[1]) fail("usage: mdc rewrite <file> <threadId> --with TEXT");
      return cmdRewrite(rest[0], rest[1], str(flags, "with"));
    case "open":
      if (!rest[0]) fail("usage: mdc open <file> --quote TEXT --body TEXT [--occurrence N]");
      return cmdOpen(
        rest[0],
        str(flags, "quote"),
        str(flags, "body"),
        typeof flags.occurrence === "string" ? Number(flags.occurrence) : 0,
      );
    case "resolve":
      if (!rest[0] || !rest[1]) fail("usage: mdc resolve <file> <threadId>");
      return cmdResolve(rest[0], rest[1]);
    case "suggest":
      if (!rest[0]) fail("usage: mdc suggest <file> --quote TEXT --with TEXT [--note TEXT] [--occurrence N]");
      return cmdSuggest(
        rest[0],
        str(flags, "quote"),
        str(flags, "with"),
        typeof flags.note === "string" ? flags.note : undefined,
        typeof flags.occurrence === "string" ? Number(flags.occurrence) : 0,
      );
    case "accept":
      if (!rest[0] || !rest[1]) fail("usage: mdc accept <file> <anchorId>");
      return cmdAccept(rest[0], rest[1]);
    case "reject":
      if (!rest[0] || !rest[1]) fail("usage: mdc reject <file> <anchorId>");
      return cmdReject(rest[0], rest[1]);
    case "check":
      if (!rest[0]) fail("usage: mdc check <file> [--repair]");
      return cmdCheck(rest[0], flags.repair === true);
    default:
      fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main();
