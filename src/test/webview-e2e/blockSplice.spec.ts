// The gate for edit mode: a keystroke may
// only change the bytes of the top-level block it happened in.
//
// On every document the one-view spike used, with a thread added to every
// block that has a word to anchor (so every splice carries markers), type one
// character at the end of every top-level block. The shipped bundle builds the
// `edit-blocks` message the keystroke would post (its test seam,
// `typeAtEveryBlockEnd`: the keystroke's transaction, the plugins' appended
// ones, and the live diff and serializer); the host's `applyBlockEdits`
// splices it into the file. Then, outside the block's lines: the file is
// byte-identical (the threads region included) and so is
// `stripAllInlineMarkup`. The character landed, and no thread lost its anchor.
//
// Then the same over variants the corpus doesn't have: four documents with
// CRLF line endings (converted here, threads region included, as VS Code
// would hold such a file) and three without a final newline. The serializer
// writes `\n`, so a CRLF file must also come back with no LF or CR of its own.
//
// The real keystroke → debounce → post path, Enter and Backspace included, is
// exercised in modeToggle.spec.ts.

import { expect, test, type Page } from "@playwright/test";
import { bootLiveEditor } from "./harness";
import { liveInit } from "./fixtures";
import { addThreadAtProseRange, applyBlockEdits, frontmatterOf, proseOf } from "../../collab/inlineBridge";
import type { BlockEdit } from "../../collab/blockEdits";
import { editorBlockCount, markdownBlocks, type MarkdownBlock } from "../../collab/sourcePositions";
import { parse, stripAllInlineMarkup } from "../../inlineComments/format";
import { oneViewCorpus } from "../support/oneViewCorpus";

const COMMENT = { author: "ronica", body: "gate", ts: "2026-09-29T00:00:00.000Z" };
const TYPED = "Z";

interface Probe {
  index: number;
  type: string;
  how: "end" | "selected";
  message: { epoch: number; baseTypes: string[]; edits: BlockEdit[] } | null;
}

/** Add a thread on the first word of every block (every `step`-th on a long document). */
function withThreadPerBlock(source: string, blocks: readonly MarkdownBlock[], step: number): string {
  const prose = proseOf(source);
  for (let i = 0; i < blocks.length; i += step) {
    const m = /[A-Za-z]{4,}/.exec(prose.slice(blocks[i]!.start, blocks[i]!.end));
    if (!m) continue;
    const start = blocks[i]!.start + m.index;
    const r = addThreadAtProseRange(source, { start, end: start + m[0].length, text: m[0] }, COMMENT);
    // The format can't anchor inside code; those blocks go without.
    if (r.ok) source = r.source;
  }
  return source;
}

async function probe(page: Page): Promise<Probe[]> {
  return page.evaluate(
    (ch) =>
      (window as unknown as { __mcTestHooks: { typeAtEveryBlockEnd: (c: string) => Probe[] } }).__mcTestHooks.typeAtEveryBlockEnd(ch),
    TYPED,
  );
}

const count = (s: string, ch: string): number => s.split(ch).length - 1;

/**
 * Whether `after` equals `before` outside lines `[first, last]` of `before`.
 * Returns the problems, empty when clean.
 */
function sameOutside(before: string, after: string, first: number, last: number): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const tail = a.length - (last + 1);
  const problems: string[] = [];
  if (b.length - tail < first) return [`the file lost lines around the block`];
  for (let i = 0; i < first; i++) {
    if (a[i] !== b[i]) return [`line ${i + 1} (before the block) changed: ${JSON.stringify(a[i])} → ${JSON.stringify(b[i])}`];
  }
  for (let k = 0; k < tail; k++) {
    const x = a[last + 1 + k];
    const y = b[b.length - tail + k];
    if (x !== y) return [`line ${last + 2 + k} (after the block) changed: ${JSON.stringify(x)} → ${JSON.stringify(y)}`];
  }
  return problems;
}

const regionOf = (source: string): string => {
  const r = parse(source).threadsRegion;
  return r ? source.slice(r.start, r.end) : "";
};

// Line endings of the other kind in a CRLF file: a LF without its CR, a CR without its LF.
const strays = (s: string): number => (s.match(/(?<!\r)\n|\r(?!\n)/g) ?? []).length;

interface GateCase {
  name: string;
  /** The document before threads are added. */
  base: string;
  /** Applied after: the variant under test. */
  variant?: (source: string) => string;
  /** False for a file without a final newline: the threads region would give it one. */
  threads?: boolean;
}

const corpusByName = new Map(oneViewCorpus().map((d) => [d.name, d.source]));
const toCrlf = (s: string): string => s.replace(/\r?\n/g, "\r\n");
const cases: GateCase[] = [
  ...oneViewCorpus().map((d): GateCase => ({ name: d.name, base: d.source })),
  ...["rt-tables", "rt-frontmatter-lists", "e2e-review-fixture", "README"].map(
    (name): GateCase => ({ name: `${name}, CRLF`, base: corpusByName.get(name)!, variant: toCrlf }),
  ),
  ...["embeds", "int-sample", "probe-syntax"].map(
    (name): GateCase => ({
      name: `${name}, no final newline`,
      base: corpusByName.get(name)!.replace(/\n+$/, ""),
      threads: false,
    }),
  ),
];

const totals = { documents: 0, blocks: 0, failures: 0, byType: {} as Record<string, number> };

for (const doc of cases) {
  test(`a keystroke at the end of every block changes only that block: ${doc.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    const table0 = markdownBlocks(proseOf(doc.base));
    // CHANGELOG's 1,247 blocks get a thread every tenth block; every block is still typed into.
    const threaded = doc.threads === false ? doc.base : withThreadPerBlock(doc.base, table0, table0.length > 200 ? 10 : 1);
    const source = doc.variant ? doc.variant(threaded) : threaded;
    const crlf = source.includes("\r\n");
    const prose = proseOf(source);
    expect(prose.replace(/\r\n/g, "\n").trimEnd()).toBe(proseOf(doc.base).trimEnd());
    const table = markdownBlocks(prose);
    const anchoredBefore = [...parse(source).anchors.keys()];
    const region = regionOf(source);
    const stripped = stripAllInlineMarkup(source);
    const fmLines = frontmatterOf(source).split("\n").length - 1;
    const lineOf = (offset: number): number => count(prose.slice(0, offset), "\n") + fmLines;

    await page.evaluate(() => {
      (window as unknown as { __mcTestHooks: Record<string, unknown> }).__mcTestHooks = {};
    });
    await bootLiveEditor(page, { ...liveInit(source), epoch: 1 });
    const probes = await probe(page);
    expect(probes.length, "the editor's blocks are the table's").toBe(editorBlockCount(table));

    const failures: string[] = [];
    const byType: Record<string, number> = {};
    for (const p of probes) {
      const label = `block ${p.index + 1} (${p.type}, ${p.how})`;
      byType[p.type] = (byType[p.type] ?? 0) + 1;
      if (!p.message) {
        failures.push(`${label}: no edit posted`);
        continue;
      }
      expect(p.message.epoch).toBe(1);
      const r = applyBlockEdits(source, p.message, table);
      if (!r.ok) {
        failures.push(`${label}: refused — ${r.error}`);
        continue;
      }
      const problems: string[] = [];
      const block = table[p.index]!;
      const first = lineOf(block.start);
      const last = lineOf(block.end);
      problems.push(...sameOutside(source, r.source, first, last));
      if (regionOf(r.source) !== region) problems.push("the threads region changed");
      const strippedAfter = stripAllInlineMarkup(r.source);
      problems.push(...sameOutside(stripped, strippedAfter, first, last).map((x) => `stripAllInlineMarkup: ${x}`));
      if (count(strippedAfter, TYPED) !== count(stripped, TYPED) + 1) problems.push(`the typed ${TYPED} didn't land once`);
      if (crlf && strays(r.source) !== strays(source)) problems.push("the new text doesn't use the file's CRLF line endings");
      const anchoredAfter = parse(r.source).anchors;
      const lost = anchoredBefore.filter((id) => !anchoredAfter.has(id));
      if (lost.length > 0) problems.push(`threads lost their anchor: ${lost.join(", ")}`);
      for (const problem of problems) failures.push(`${label}: ${problem}\n  sent: ${JSON.stringify(p.message.edits)}`);
    }

    totals.documents++;
    totals.blocks += probes.length;
    totals.failures += failures.length;
    for (const [t, n] of Object.entries(byType)) totals.byType[t] = (totals.byType[t] ?? 0) + n;
    console.log(
      `blockSplice ${doc.name}: ${probes.length} blocks, ${anchoredBefore.length} anchors, ` +
        `${failures.length} failures — ${JSON.stringify(byType)}` +
        (totals.documents === cases.length ? `\nblockSplice total: ${JSON.stringify(totals)}` : ""),
    );
    expect(failures, failures.slice(0, 8).join("\n")).toEqual([]);
  });
}
