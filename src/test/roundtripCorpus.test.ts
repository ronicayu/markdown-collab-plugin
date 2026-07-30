// Golden round-trip corpus (10x-plan P0.3).
//
// The four chronic failure classes in this project's history — anchoring,
// live-editor sync, image rendering, tables — were each fixed one CHANGELOG
// entry at a time. Nothing prevented regressions across their *combination*
// space: a comment on a table cell with a duplicate value, inside a document
// with frontmatter, edited in place, then undone.
//
// This suite drives scripts of realistic operations over realistic documents
// and asserts a fixed set of invariants after EVERY step:
//
//   I1. integrity — no unpaired markers, orphans, or malformed thread JSON
//   I2. prose fidelity — the document's prose is byte-identical to what the
//       script says it should be; comment ops never touch prose
//   I3. anchoring — every live thread resolves to a span in the prose
//   I4. quote fidelity — an untouched thread's anchored text still equals
//       its recorded quote
//   I5. serialization stability — parse(withThreads(source, threads)) yields
//       the same threads (the round-trip guarantee format.ts promises)
//
// When a new anchoring bug is found, add its shape here FIRST, watch it fail,
// then fix the engine. That is the point of the corpus.

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  addSuggestion,
  addThread,
  appendReply,
  parse,
  rejectSuggestion,
  replaceThread,
  stripAllInlineMarkup,
  withThreads,
  type InlineThread,
} from "../inlineComments/format";
import { checkIntegrity, repairIntegrity } from "../inlineComments/integrity";
import { hashAnchorText } from "../inlineComments/staleness";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "roundtrip");
const TS = "2026-07-25T12:00:00.000Z";

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

// --- operation DSL --------------------------------------------------------

type Op =
  /** Comment on the `occurrence`-th (1-based) appearance of `quote`. */
  | { do: "comment"; quote: string; occurrence?: number; body?: string }
  | { do: "reply"; thread: number; body: string }
  | { do: "resolve"; thread: number }
  | { do: "deleteThread"; thread: number }
  /** Rewrite the text between a thread's markers (markers stay put). */
  | { do: "editInsideAnchor"; thread: number; to: string }
  /** Delete the anchored text but keep the markers — a zero-width anchor. */
  | { do: "emptyAnchor"; thread: number }
  /** Delete text AND markers, the way a careless editor undo does. */
  | { do: "deleteAnchoredSpan"; thread: number }
  /** Simulate raw-edit corruption. Integrity is expected to fail after this. */
  | { do: "corrupt"; how: "drop-close" | "drop-open" | "drop-both" | "break-json"; thread: number }
  /** Run the repair pass. */
  | { do: "repair" }
  /** Reflow table padding, the way a formatter would. */
  | { do: "reflowTable" };

interface Script {
  fixture: string;
  name: string;
  ops: Op[];
}

interface State {
  source: string;
  /** What `stripAllInlineMarkup(source)` must equal right now. */
  expectedProse: string;
  /** Threads whose anchored text was intentionally changed — I4 exempt. */
  edited: Set<string>;
  /** True once a corrupt op ran and before the next repair. */
  corrupted: boolean;
}

/**
 * Offset of the `occurrence`-th appearance of `quote` in the prose part of
 * the source (everything before the threads region). Throws rather than
 * silently anchoring somewhere unintended — a script that can't find its
 * target is a broken test, not a passing one.
 */
function offsetOfOccurrence(source: string, quote: string, occurrence: number): number {
  const region = parse(source).threadsRegion;
  const limit = region ? region.start : source.length;
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    const at = source.indexOf(quote, from);
    if (at === -1 || at >= limit) {
      throw new Error(`fixture text not found: occurrence ${occurrence} of ${JSON.stringify(quote)}`);
    }
    if (i === occurrence - 1) return at;
    from = at + quote.length;
  }
  throw new Error("unreachable");
}

function threadAt(source: string, index: number): InlineThread {
  const threads = parse(source).threads;
  const t = threads[index];
  if (!t) throw new Error(`script referenced thread ${index}, document has ${threads.length}`);
  return t;
}

function applyOp(state: State, op: Op): State {
  const next = { ...state, edited: new Set(state.edited) };

  switch (op.do) {
    case "comment": {
      const at = offsetOfOccurrence(state.source, op.quote, op.occurrence ?? 1);
      const r = addThread(state.source, at, at + op.quote.length, {
        author: "ronica",
        body: op.body ?? `note on ${op.quote}`,
        ts: TS,
      });
      next.source = r.source;
      return next;
    }
    case "reply": {
      const t = threadAt(state.source, op.thread);
      next.source = replaceThread(
        state.source,
        t.id,
        appendReply(t, { author: "claude", body: op.body, ts: TS }),
      );
      return next;
    }
    case "resolve": {
      const t = threadAt(state.source, op.thread);
      next.source = replaceThread(state.source, t.id, {
        ...t,
        status: "resolved",
        resolvedBy: "ronica",
        resolvedTs: TS,
      });
      return next;
    }
    case "deleteThread": {
      const t = threadAt(state.source, op.thread);
      next.source = replaceThread(state.source, t.id, null);
      return next;
    }
    case "editInsideAnchor": {
      const t = threadAt(state.source, op.thread);
      const a = parse(state.source).anchors.get(t.id);
      if (!a) throw new Error(`thread ${t.id} is not anchored; cannot edit inside it`);
      const old = state.source.slice(a.openEnd, a.closeStart);
      next.source = state.source.slice(0, a.openEnd) + op.to + state.source.slice(a.closeStart);
      next.expectedProse = replaceOnce(state.expectedProse, old, op.to);
      next.edited.add(t.id);
      return next;
    }
    case "emptyAnchor": {
      const t = threadAt(state.source, op.thread);
      const a = parse(state.source).anchors.get(t.id);
      if (!a) throw new Error(`thread ${t.id} is not anchored`);
      const old = state.source.slice(a.openEnd, a.closeStart);
      next.source = state.source.slice(0, a.openEnd) + state.source.slice(a.closeStart);
      next.expectedProse = replaceOnce(state.expectedProse, old, "");
      next.edited.add(t.id);
      return next;
    }
    case "deleteAnchoredSpan": {
      const t = threadAt(state.source, op.thread);
      const a = parse(state.source).anchors.get(t.id);
      if (!a) throw new Error(`thread ${t.id} is not anchored`);
      const prose = state.source.slice(a.openEnd, a.closeStart);
      next.source = state.source.slice(0, a.openStart) + state.source.slice(a.closeEnd);
      next.expectedProse = replaceOnce(state.expectedProse, prose, "");
      next.edited.add(t.id);
      next.corrupted = true; // thread is now unanchored
      return next;
    }
    case "corrupt": {
      const t = threadAt(state.source, op.thread);
      if (op.how === "break-json") {
        next.source = state.source.replace(`"id":"${t.id}"`, `"id":"${t.id}"` + ",,");
      } else {
        const a = parse(state.source).anchors.get(t.id);
        if (!a) throw new Error(`thread ${t.id} is not anchored`);
        const open = state.source.slice(a.openStart, a.openEnd);
        const close = state.source.slice(a.closeStart, a.closeEnd);
        let s = state.source;
        if (op.how === "drop-close" || op.how === "drop-both") s = replaceOnce(s, close, "");
        if (op.how === "drop-open" || op.how === "drop-both") s = replaceOnce(s, open, "");
        next.source = s;
      }
      next.corrupted = true;
      return next;
    }
    case "repair": {
      const r = repairIntegrity(state.source);
      next.source = r.source;
      next.corrupted = false;
      return next;
    }
    case "reflowTable": {
      // A formatter widening every column by one space. Prose changes, so
      // the expectation moves with it; anchors must survive.
      const widen = (s: string): string =>
        s.replace(/^\|(.+)\|$/gm, (line) => line.replace(/ \|/g, "  |"));
      next.source = widen(state.source);
      next.expectedProse = widen(state.expectedProse);
      return next;
    }
  }
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle);
  if (at === -1) throw new Error(`expected to find ${JSON.stringify(needle.slice(0, 40))} in document`);
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

// --- invariants -----------------------------------------------------------

/**
 * Appending the threads region leaves the prose with one extra trailing
 * newline (`withThreads` inserts a blank line before the region; the strip
 * collapses the leading run but keeps the newline that follows the region).
 * That is invisible in any renderer and is the *only* prose difference a
 * comment operation is allowed to produce.
 *
 * Normalizing the trailing newline run — rather than trimming the whole end
 * — keeps the invariant sharp: any interior change, and any trailing change
 * that is not a newline, still fails.
 */
function normalizeTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "\n");
}

function assertInvariants(state: State, label: string): void {
  const parsed = parse(state.source);

  // I2 — prose fidelity. Checked first: if prose drifted, everything else
  // is measuring the wrong document.
  expect(
    normalizeTrailingNewlines(stripAllInlineMarkup(state.source)),
    `${label}: prose changed unexpectedly`,
  ).toBe(normalizeTrailingNewlines(state.expectedProse));

  if (!state.corrupted) {
    // I1 — integrity.
    const report = checkIntegrity(state.source);
    expect(report.issues, `${label}: integrity issues`).toEqual([]);

    // I3 — anchoring.
    expect(parsed.unanchoredThreadIds, `${label}: unanchored threads`).toEqual([]);

    // I4 — quote fidelity for untouched threads.
    for (const t of parsed.threads) {
      if (state.edited.has(t.id)) continue;
      const a = parsed.anchors.get(t.id);
      expect(a, `${label}: thread ${t.id} has no anchor`).toBeDefined();
      const anchoredText = state.source.slice(a!.openEnd, a!.closeStart);
      expect(anchoredText, `${label}: thread ${t.id} anchored text drifted from its quote`).toBe(
        t.quote,
      );
    }
  }

  // I5 — serialization stability, always.
  const reserialized = withThreads(state.source, parsed.threads);
  expect(parse(reserialized).threads, `${label}: threads not stable across reserialization`).toEqual(
    parsed.threads,
  );
}

// --- the corpus -----------------------------------------------------------

const SCRIPTS: Script[] = [
  {
    fixture: "tables.md",
    name: "duplicate cell values anchor to the selected cell",
    ops: [
      // "pending" appears twice in the table and a third time inside an
      // inline code span; the two table cells are the anchorable ones.
      { do: "comment", quote: "pending", occurrence: 1 },
      { do: "comment", quote: "pending", occurrence: 2 },
      { do: "reply", thread: 0, body: "which stage is this?" },
      { do: "resolve", thread: 1 },
      { do: "reflowTable" },
      { do: "deleteThread", thread: 0 },
    ],
  },
  {
    fixture: "tables.md",
    name: "editing inside an anchored table cell keeps the anchor",
    ops: [
      { do: "comment", quote: "green", occurrence: 1 },
      { do: "editInsideAnchor", thread: 0, to: "passing" },
      { do: "reply", thread: 0, body: "renamed" },
      { do: "reflowTable" },
    ],
  },
  {
    fixture: "code-and-markers.md",
    name: "decoy markers in code are never treated as anchors",
    ops: [
      { do: "comment", quote: "Real prose resumes here" },
      { do: "reply", thread: 0, body: "body with --> and <!-- inside it" },
      { do: "comment", quote: "legitimate anchor target" },
      { do: "resolve", thread: 0 },
    ],
  },
  {
    fixture: "frontmatter-lists.md",
    name: "frontmatter, emoji and nested lists survive a full comment cycle",
    ops: [
      { do: "comment", quote: "Should suggestions be a thread variant" },
      { do: "comment", quote: "multi-byte" },
      { do: "reply", thread: 0, body: "a variant 👍" },
      { do: "editInsideAnchor", thread: 1, to: "multi-byte 🚀" },
      { do: "resolve", thread: 0 },
      { do: "deleteThread", thread: 1 },
    ],
  },
  {
    fixture: "frontmatter-lists.md",
    name: "emptying an anchored span leaves a valid zero-width anchor",
    ops: [
      { do: "comment", quote: "Inner item with" },
      { do: "emptyAnchor", thread: 0 },
      { do: "reply", thread: 0, body: "text was removed" },
    ],
  },
];

describe("round-trip corpus", () => {
  for (const script of SCRIPTS) {
    it(`${script.fixture}: ${script.name}`, () => {
      const source = fixture(script.fixture);
      let state: State = {
        source,
        expectedProse: stripAllInlineMarkup(source),
        edited: new Set(),
        corrupted: false,
      };
      assertInvariants(state, "initial");
      script.ops.forEach((op, i) => {
        state = applyOp(state, op);
        assertInvariants(state, `after op ${i + 1} (${op.do})`);
      });
    });
  }
});

// --- corruption and repair ------------------------------------------------

describe("round-trip corpus: corruption is detected and repaired", () => {
  it("a dropped closing marker is detected, then repaired back to a healthy anchor", () => {
    const source = fixture("tables.md");
    let state: State = {
      source,
      expectedProse: stripAllInlineMarkup(source),
      edited: new Set(),
      corrupted: false,
    };
    state = applyOp(state, { do: "comment", quote: "needs a fresh PAT" });
    assertInvariants(state, "after comment");

    state = applyOp(state, { do: "corrupt", how: "drop-close", thread: 0 });
    const broken = checkIntegrity(state.source);
    expect(broken.ok).toBe(false);
    expect(broken.issues.some((i) => i.kind === "unpaired-marker")).toBe(true);

    // The repair chain: strip the stray open, which leaves the thread
    // unanchored, then re-anchor it from its unique quote.
    state = applyOp(state, { do: "repair" });
    assertInvariants(state, "after repair");
    expect(parse(state.source).threads).toHaveLength(1);
    expect(parse(state.source).unanchoredThreadIds).toEqual([]);
  });

  it("dropping both markers re-anchors from a unique quote", () => {
    const source = fixture("tables.md");
    let state: State = {
      source,
      expectedProse: stripAllInlineMarkup(source),
      edited: new Set(),
      corrupted: false,
    };
    state = applyOp(state, { do: "comment", quote: "cached deps" });
    state = applyOp(state, { do: "corrupt", how: "drop-both", thread: 0 });
    expect(parse(state.source).unanchoredThreadIds).toHaveLength(1);

    state = applyOp(state, { do: "repair" });
    assertInvariants(state, "after repair");
  });

  it("deleting an anchored span leaves an unrecoverable thread that is reported, not guessed", () => {
    const source = fixture("tables.md");
    let state: State = {
      source,
      expectedProse: stripAllInlineMarkup(source),
      edited: new Set(),
      corrupted: false,
    };
    state = applyOp(state, { do: "comment", quote: "cached deps" });
    state = applyOp(state, { do: "deleteAnchoredSpan", thread: 0 });

    const report = checkIntegrity(state.source);
    const issue = report.issues.find((i) => i.kind === "unanchored-thread");
    expect(issue).toBeDefined();
    expect(issue!.repairable).toBe(false);

    // Repair must not invent an anchor — the text is genuinely gone.
    const proseBefore = stripAllInlineMarkup(state.source);
    const repaired = repairIntegrity(state.source);
    expect(stripAllInlineMarkup(repaired.source)).toBe(proseBefore);
    expect(parse(repaired.source).threads).toHaveLength(1);
    expect(parse(repaired.source).unanchoredThreadIds).toHaveLength(1);
  });

  it("an ambiguous quote is never guessed at", () => {
    const source = fixture("tables.md");
    let state: State = {
      source,
      expectedProse: stripAllInlineMarkup(source),
      edited: new Set(),
      corrupted: false,
    };
    // "pending" appears several times — after losing its markers the thread
    // cannot be placed without guessing.
    state = applyOp(state, { do: "comment", quote: "pending", occurrence: 2 });
    state = applyOp(state, { do: "corrupt", how: "drop-both", thread: 0 });

    const report = checkIntegrity(state.source);
    const issue = report.issues.find((i) => i.kind === "unanchored-thread");
    expect(issue!.repairable).toBe(false);
    const repaired = repairIntegrity(state.source);
    expect(parse(repaired.source).unanchoredThreadIds).toHaveLength(1);
  });

  it("malformed thread JSON is reported and never silently dropped", () => {
    const source = fixture("frontmatter-lists.md");
    let state: State = {
      source,
      expectedProse: stripAllInlineMarkup(source),
      edited: new Set(),
      corrupted: false,
    };
    state = applyOp(state, { do: "comment", quote: "Status-bar item" });
    state = applyOp(state, { do: "corrupt", how: "break-json", thread: 0 });

    const report = checkIntegrity(state.source);
    expect(report.issues.some((i) => i.kind === "malformed-thread-json")).toBe(true);
    // Not repairable — we will not guess at what the author meant.
    expect(report.issues.find((i) => i.kind === "malformed-thread-json")!.repairable).toBe(false);
  });

  it("repair is a no-op on a healthy document", () => {
    const source = fixture("code-and-markers.md");
    const state = applyOp(
      { source, expectedProse: stripAllInlineMarkup(source), edited: new Set(), corrupted: false },
      { do: "comment", quote: "Real prose resumes here" },
    );
    const r = repairIntegrity(state.source);
    expect(r.repairs).toEqual([]);
    expect(r.source).toBe(state.source);
  });
});

// --- the trailing-newline artifact, pinned -------------------------------

describe("round-trip corpus: the one permitted prose difference", () => {
  it("adding a thread changes prose only by a trailing newline", () => {
    const source = "# T\n\nHello world.\n";
    const before = stripAllInlineMarkup(source);
    const r = addThread(source, 6, 11, { author: "ronica", body: "b", ts: TS });
    const after = stripAllInlineMarkup(r.source);

    // Pinned deliberately: if this ever becomes a larger difference — an
    // interior change, a lost newline, stray whitespace — this fails and the
    // looser invariant used everywhere else in this file cannot hide it.
    expect(after).toBe(`${before}\n`);
    expect(after.trimEnd()).toBe(before.trimEnd());
  });

  it("removing the last thread leaves prose intact and the newline does not accumulate", () => {
    const source = "# T\n\nHello world.\n";
    let doc = source;
    // Ten add/remove cycles. The trailing newline must stabilize, never grow —
    // an accumulating newline would slowly reformat every reviewed document.
    for (let i = 0; i < 10; i++) {
      const at = doc.indexOf("world");
      doc = addThread(doc, at, at + 5, { author: "ronica", body: `b${i}`, ts: TS }).source;
      doc = replaceThread(doc, parse(doc).threads[0].id, null);
    }
    // Removing the last thread restores the document byte-for-byte — the
    // add/remove cycle is fully reversible, not merely close.
    expect(doc).toBe(source);
    expect(checkIntegrity(doc).ok).toBe(true);
    expect(parse(doc).threads).toEqual([]);
  });

  it("refuses to anchor inside a code span, rather than creating a broken thread", () => {
    const source = fixture("tables.md");
    // The third "pending" lives inside `pending` — a code span. Markers there
    // are masked by the parser, so the thread would come back unanchored.
    const at = offsetOfOccurrence(source, "pending", 3);
    expect(() =>
      addThread(source, at, at + "pending".length, { author: "ronica", body: "x", ts: TS }),
    ).toThrow(/code block or code span/);
  });

  it("refuses to anchor inside a fenced code block", () => {
    const source = fixture("code-and-markers.md");
    const at = offsetOfOccurrence(source, "Some prose", 1);
    expect(() =>
      addThread(source, at, at + "Some prose".length, { author: "ronica", body: "x", ts: TS }),
    ).toThrow(/code block or code span/);
  });
});

// --- suggestions in combination ------------------------------------------

describe("round-trip corpus: suggestions coexist with threads on gnarly docs", () => {
  function suggest(source: string, quote: string, proposed: string) {
    const at = source.indexOf(quote);
    if (at === -1) throw new Error(`quote not found: ${quote}`);
    return addSuggestion(source, at, at + quote.length, { author: "claude", proposed, ts: TS });
  }

  it("a comment and a suggestion on the same table survive together", () => {
    const source = fixture("tables.md");
    // Comment on one cell, suggest an edit to a different cell's value.
    let doc = addThread(source, source.indexOf("green"), source.indexOf("green") + 5, {
      author: "ronica",
      body: "is this still green?",
      ts: TS,
    }).source;
    doc = suggest(doc, "cached deps", "cached dependencies").source;

    const parsed = parse(doc);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.suggestions).toHaveLength(1);
    expect(checkIntegrity(doc).issues).toEqual([]);
    // Prose still shows the original suggestion text.
    expect(stripAllInlineMarkup(doc)).toContain("cached deps");
    expect(stripAllInlineMarkup(doc)).not.toContain("cached dependencies");
    // Serialization stable.
    expect(parse(withThreads(doc, parsed.threads, parsed.suggestions)).suggestions).toEqual(parsed.suggestions);
  });

  it("accepting a suggestion applies proposed text and keeps integrity", () => {
    const source = fixture("frontmatter-lists.md");
    const { source: doc, suggestion } = suggest(source, "multi-byte", "multi-byte (UTF-8)");
    const proseBefore = stripAllInlineMarkup(doc);
    expect(proseBefore).toContain("multi-byte");

    const after = acceptSuggestion(doc, suggestion.anchorId);
    expect(stripAllInlineMarkup(after)).toContain("multi-byte (UTF-8)");
    expect(parse(after).suggestions).toEqual([]);
    expect(checkIntegrity(after).issues).toEqual([]);
  });

  it("rejecting a suggestion restores the original prose exactly", () => {
    const source = fixture("frontmatter-lists.md");
    const { source: doc, suggestion } = suggest(source, "Status-bar item", "Status bar entry");
    const after = rejectSuggestion(doc, suggestion.anchorId);
    // Rejecting removes only the suggestion's own markup, so the prose returns
    // to what it was before the suggestion was added.
    expect(stripAllInlineMarkup(after)).toBe(stripAllInlineMarkup(source));
    expect(parse(after).suggestions).toEqual([]);
    expect(checkIntegrity(after).issues).toEqual([]);
  });

  it("a suggestion whose original text sits in a code fence is refused", () => {
    const source = fixture("code-and-markers.md");
    const at = source.indexOf("Some prose");
    expect(() =>
      addSuggestion(source, at, at + "Some prose".length, { author: "claude", proposed: "x", ts: TS }),
    ).toThrow(/code/);
  });
});

// --- escaping -------------------------------------------------------------

describe("round-trip corpus: comment bodies with comment-terminating sequences", () => {
  const NASTY = [
    "a body containing --> which would close the comment",
    "a body containing <!-- which would open one",
    'JSON-ish: {"quote":"x","status":"open"}',
    "unicode 🚀 and a newline\nsecond line",
  ];

  for (const body of NASTY) {
    it(`survives a round trip: ${JSON.stringify(body.slice(0, 30))}`, () => {
      const source = fixture("code-and-markers.md");
      const at = source.indexOf("Real prose resumes here");
      const r = addThread(source, at, at + "Real prose".length, {
        author: "claude",
        body,
        ts: TS,
      });
      const parsed = parse(r.source);
      expect(parsed.threads).toHaveLength(1);
      expect(parsed.threads[0].comments[0].body).toBe(body);
      expect(checkIntegrity(r.source).ok).toBe(true);
    });
  }
});

// 10x-plan-2 P1.3. The anchor hash is a new optional field on every thread, so
// it has to survive the same round trips as the rest of the record — and its
// absence has to survive too, because that is what every file written before
// this version looks like.
describe("round-trip corpus: the anchor hash", () => {
  const FIXTURES = ["tables.md", "frontmatter-lists.md", "code-and-markers.md"];

  for (const name of FIXTURES) {
    it(`${name}: survives parse → serialize → parse`, () => {
      const source = fixture(name);
      const at = source.indexOf("\n#") > 0 ? source.indexOf("\n#") + 1 : 0;
      const line = source.slice(at, source.indexOf("\n", at + 1));
      const quote = line.replace(/^#+\s*/, "").trim();
      if (!quote) return;
      const start = source.indexOf(quote);
      const r = addThread(source, start, start + quote.length, {
        author: "ronica",
        body: "hash me",
        ts: TS,
      });
      const parsed = parse(r.source);
      const thread = parsed.threads.find((t) => t.id === r.thread.id)!;
      expect(thread.anchorHash, `${name}: hash missing after parse`).toBe(
        hashAnchorText(quote),
      );
      // Re-serializing must not drop or alter it.
      const again = parse(withThreads(r.source, parsed.threads));
      expect(again.threads.find((t) => t.id === r.thread.id)!.anchorHash).toBe(thread.anchorHash);
      expect(checkIntegrity(r.source).ok).toBe(true);
    });
  }

  it("a document written without the field stays without it", () => {
    // Older versions wrote no anchorHash. Reserializing such a file must not
    // invent one — an invented hash would read as "unchanged" forever after.
    const source = fixture("tables.md");
    const at = source.indexOf("Ops");
    const r = addThread(source, at, at + 3, { author: "ronica", body: "legacy", ts: TS });
    const legacy = withThreads(
      r.source,
      parse(r.source).threads.map((t) => ({ ...t, anchorHash: undefined })),
    );
    expect(legacy).not.toContain("anchorHash");
    const reparsed = parse(legacy);
    expect(reparsed.threads[0]!.anchorHash).toBeUndefined();
    expect(withThreads(legacy, reparsed.threads)).not.toContain("anchorHash");
    expect(checkIntegrity(legacy).ok).toBe(true);
  });
});
