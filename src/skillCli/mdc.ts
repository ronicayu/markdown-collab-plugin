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
// Contract with the caller:
//   - stdout is always a single JSON document, written with writeSync(1) so
//     it survives a POSIX pipe without buffering loss
//   - stderr carries human-readable errors
//   - exit 0 = success, 1 = command/usage error, 2 = integrity violation
//
// Every mutating command re-checks integrity after writing and refuses to
// leave the file worse than it found it.

import { writeSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import {
  acceptSuggestion,
  addSuggestion,
  addThread,
  appendReply,
  parse,
  rejectSuggestion,
  replaceThread,
  stripAllInlineMarkup,
  type InlineThread,
} from "../inlineComments/format";
import { checkIntegrity, repairIntegrity } from "../inlineComments/integrity";

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
 * Write only if the mutation left the document at least as healthy as it
 * found it. A command that would introduce a new integrity problem aborts
 * with exit 2 and touches nothing — the caller sees the failure instead of
 * discovering it later as a lost comment.
 */
function writeChecked(file: string, before: string, after: string): {
  ok: boolean;
  issues: ReturnType<typeof checkIntegrity>["issues"];
} {
  const wasOk = checkIntegrity(before).issues.length;
  const report = checkIntegrity(after);
  if (report.issues.length > wasOk) {
    process.stderr.write(
      `mdc: refusing to write — the change would introduce ${report.issues.length - wasOk} integrity problem(s):\n`,
    );
    for (const i of report.issues) process.stderr.write(`  - ${i.message}\n`);
    process.exit(EXIT_INTEGRITY);
  }
  writeFileSync(file, after, "utf8");
  return { ok: report.ok, issues: report.issues };
}

function findThread(source: string, threadId: string): InlineThread {
  const t = parse(source).threads.find((x) => x.id === threadId);
  if (!t) fail(`no thread with id ${threadId} in this file`);
  return t;
}

/** Last non-deleted comment, used to decide whether a thread awaits Claude. */
function lastLiveComment(t: InlineThread) {
  const live = t.comments.filter((c) => !c.deleted);
  return live[live.length - 1];
}

function cmdList(file: string, actionableOnly: boolean): void {
  const source = readDoc(file);
  const parsed = parse(source);
  const threads = parsed.threads
    .filter((t) => {
      if (!actionableOnly) return true;
      if (t.status !== "open") return false;
      const last = lastLiveComment(t);
      return last !== undefined && last.author !== "claude";
    })
    .map((t) => {
      const a = parsed.anchors.get(t.id);
      return {
        id: t.id,
        status: t.status,
        quote: t.quote,
        anchored: a !== undefined,
        /** The live text between the markers — what the reviewer is pointing at. */
        anchoredText: a ? source.slice(a.openEnd, a.closeStart) : null,
        comments: t.comments
          .filter((c) => !c.deleted)
          .map((c) => ({ id: c.id, author: c.author, ts: c.ts, body: c.body })),
      };
    });
  const suggestions = parsed.suggestions.map((s) => {
    const a = parsed.anchors.get(s.anchorId);
    return {
      anchorId: s.anchorId,
      threadId: s.threadId,
      author: s.author,
      anchored: a !== undefined,
      original: s.original,
      proposed: s.proposed,
      note: s.note,
    };
  });
  out({ file, threadCount: parsed.threads.length, threads, suggestionCount: parsed.suggestions.length, suggestions });
}

function cmdReply(file: string, threadId: string, body: string): void {
  const source = readDoc(file);
  const thread = findThread(source, threadId);
  const next = replaceThread(
    source,
    threadId,
    appendReply(thread, { author: "claude", body, ts: new Date().toISOString() }),
  );
  const r = writeChecked(file, source, next);
  const updated = findThread(next, threadId);
  out({
    action: "reply",
    file,
    threadId,
    commentId: updated.comments[updated.comments.length - 1].id,
    integrityOk: r.ok,
  });
}

/**
 * Replace the text between a thread's markers.
 *
 * This is the operation the skill's marker-surgery instructions were for,
 * and the one most likely to drop a marker by hand: the markers sit flush
 * against the text, so a bare-text edit either fails to match or eats one.
 * Here the markers are never part of the edit — we splice between them and
 * update the thread's `quote`, which is the fallback locator.
 */
function cmdRewrite(file: string, threadId: string, replacement: string): void {
  const source = readDoc(file);
  const parsed = parse(source);
  const thread = findThread(source, threadId);
  const a = parsed.anchors.get(threadId);
  if (!a) {
    fail(
      `thread ${threadId} has no anchor markers in the prose; rewrite needs an anchored span (see \`mdc check\`)`,
    );
  }
  const previous = source.slice(a.openEnd, a.closeStart);
  const spliced = source.slice(0, a.openEnd) + replacement + source.slice(a.closeStart);
  const next = replaceThread(spliced, threadId, { ...thread, quote: replacement });
  const r = writeChecked(file, source, next);
  out({ action: "rewrite", file, threadId, previous, replacement, integrityOk: r.ok });
}

/**
 * Open a new thread on a passage, locating it by exact text.
 *
 * Refuses ambiguity rather than guessing: if the passage appears more than
 * once the caller must say which occurrence it means. The offsets are
 * computed against the raw source but the *search* runs on the prose so a
 * passage adjacent to another thread's markers is still findable.
 */
/**
 * Locate the `occurrence`-th appearance of `quote` in the prose (before the
 * threads region), refusing ambiguity. Shared by `open` and `suggest`.
 */
function locatePassage(file: string, source: string, quote: string, occurrence: number): number {
  const parsed = parse(source);
  const limit = parsed.threadsRegion ? parsed.threadsRegion.start : source.length;
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(quote, from);
    if (at === -1 || at >= limit) break;
    hits.push(at);
    from = at + quote.length;
  }
  if (hits.length === 0) {
    fail(`passage not found in ${file}: ${JSON.stringify(quote.slice(0, 60))}`);
  }
  if (hits.length > 1 && occurrence === 0) {
    fail(`passage appears ${hits.length} times; pass --occurrence 1..${hits.length} to say which one you mean`);
  }
  const index = occurrence === 0 ? 0 : occurrence - 1;
  if (index < 0 || index >= hits.length) {
    fail(`--occurrence ${occurrence} is out of range (passage appears ${hits.length} time(s))`);
  }
  return hits[index];
}

function cmdOpen(file: string, quote: string, body: string, occurrence: number): void {
  const source = readDoc(file);
  const at = locatePassage(file, source, quote, occurrence);

  let result;
  try {
    result = addThread(source, at, at + quote.length, {
      author: "claude",
      body,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    // addThread refuses frontmatter, the threads region, and code — surface
    // the reason rather than a stack trace.
    return fail((e as Error).message);
  }
  const r = writeChecked(file, source, result.source);
  out({ action: "open", file, threadId: result.thread.id, quote, integrityOk: r.ok });
}

function cmdResolve(file: string, threadId: string): void {
  const source = readDoc(file);
  const thread = findThread(source, threadId);
  const next = replaceThread(source, threadId, {
    ...thread,
    status: "resolved",
    resolvedBy: "claude",
    resolvedTs: new Date().toISOString(),
  });
  const r = writeChecked(file, source, next);
  out({ action: "resolve", file, threadId, integrityOk: r.ok });
}

/**
 * Propose an edit: wrap the passage's original text and record the proposal.
 * The file still renders as the original — the human accepts or rejects the
 * change in the review UI (or via `mdc accept` / `mdc reject`).
 */
function cmdSuggest(
  file: string,
  quote: string,
  proposed: string,
  note: string | undefined,
  occurrence: number,
): void {
  const source = readDoc(file);
  const at = locatePassage(file, source, quote, occurrence);
  let result;
  try {
    result = addSuggestion(source, at, at + quote.length, {
      author: "claude",
      proposed,
      note,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  const r = writeChecked(file, source, result.source);
  out({
    action: "suggest",
    file,
    anchorId: result.suggestion.anchorId,
    original: result.suggestion.original,
    proposed,
    integrityOk: r.ok,
  });
}

function cmdAccept(file: string, anchorId: string): void {
  const source = readDoc(file);
  const parsed = parse(source);
  const suggestion = parsed.suggestions.find((s) => s.anchorId === anchorId);
  if (!suggestion) fail(`no suggestion with anchor id ${anchorId} in this file`);
  if (!parsed.anchors.has(anchorId)) {
    fail(`suggestion ${anchorId} lost its anchor markers; cannot place the change (see \`mdc check\`)`, EXIT_INTEGRITY);
  }
  const next = acceptSuggestion(source, anchorId);
  const r = writeChecked(file, source, next);
  out({ action: "accept", file, anchorId, applied: suggestion.proposed, integrityOk: r.ok });
}

function cmdReject(file: string, anchorId: string): void {
  const source = readDoc(file);
  const parsed = parse(source);
  if (!parsed.suggestions.some((s) => s.anchorId === anchorId)) {
    fail(`no suggestion with anchor id ${anchorId} in this file`);
  }
  const next = rejectSuggestion(source, anchorId);
  const r = writeChecked(file, source, next);
  out({ action: "reject", file, anchorId, integrityOk: r.ok });
}

function cmdCheck(file: string, repair: boolean): void {
  const source = readDoc(file);
  if (!repair) {
    const report = checkIntegrity(source);
    out({
      file,
      ok: report.ok,
      counts: report.counts,
      issues: report.issues.map((i) => ({
        kind: i.kind,
        severity: i.severity,
        threadId: i.threadId,
        repairable: i.repairable,
        message: i.message,
      })),
    });
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
