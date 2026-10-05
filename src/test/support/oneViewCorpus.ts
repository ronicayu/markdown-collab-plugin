// The one-view spike's documents, shared by
// the read-only gates: the vitest host check and
// the webview-e2e runs through the real bundle.
//
// Fixtures are read from disk, the assembled/probe documents are the spike's
// own strings, and the real docs are the snapshots in fixtures/alignment/
// (frozen, since the alignment probes carry offsets into them) — except
// CHANGELOG.md, read from the checkout: at 280 KB it isn't worth a copy, and
// the property it's checked for holds for any version of it.

import * as fs from "fs";
import * as path from "path";
import { addThread, parse } from "../../inlineComments/format";
import { reviewFixture } from "../webview-e2e/fixtures";

export const REPO_ROOT = path.resolve(__dirname, "../../..");

export interface CorpusDoc {
  name: string;
  source: string;
}

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Every document the spike rendered: 8 fixtures, 2 assembled, 3 probes, 4 real docs. */
export function oneViewCorpus(): CorpusDoc[] {
  return [
    { name: "embeds", source: read("src/test/fixtures/embeds.md") },
    { name: "rt-tables", source: read("src/test/fixtures/roundtrip/tables.md") },
    { name: "rt-code-and-markers", source: read("src/test/fixtures/roundtrip/code-and-markers.md") },
    { name: "rt-frontmatter-lists", source: read("src/test/fixtures/roundtrip/frontmatter-lists.md") },
    { name: "int-sample", source: read("src/test/integration/fixtures/sample.md") },
    { name: "int-with-drawio", source: read("src/test/integration/fixtures/with-drawio.md") },
    { name: "legacy-skill", source: read("src/test/fixtures/skill/legacy-SKILL.pre-p02.md") },
    { name: "e2e-review-fixture", source: reviewFixture().source },
    {
      name: "html-img",
      source:
        `# Doc\n\n<img src="shot.png" alt="a shot" width="400">\n\n<p align="center"><img src="../diagrams/arch.png"></p>\n\n` +
        `<script>alert(1)</script>\n\n![md](../diagrams/tn5.png)\n`,
    },
    { name: "hard-breaks", source: hardBreaksDoc() },
    {
      name: "probe-align-footnote",
      source:
        `# Probe\n\n| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |\n\n` +
        `Text with a footnote.[^1]\n\n[^1]: The note.\n`,
    },
    {
      name: "probe-drawio",
      source:
        `# Drawio probe\n\nImage syntax:\n\n![flow](diagrams/flow.drawio)\n\n` +
        `Link syntax, alone in its paragraph:\n\n[Flow diagram](diagrams/flow.drawio)\n`,
    },
    { name: "probe-syntax", source: PROBE_SYNTAX },
    { name: "README", source: read("src/test/fixtures/alignment/README.md") },
    { name: "10x-plan-6", source: read("src/test/fixtures/alignment/10x-plan-6.md") },
    { name: "ux-review", source: read("src/test/fixtures/alignment/ux-review-2026-09.md") },
    { name: "CHANGELOG", source: read("CHANGELOG.md") },
  ];
}

/** `docWithHardBreaks(6)` from liveHighlightAlignment.spec.ts: a thread below six hard breaks. */
function hardBreaksDoc(): string {
  const anchor = "A single horizontal storyline of the four lifecycles";
  const broken = Array.from({ length: 6 }, (_, i) => `Line ${i + 1}.  `).join("\n");
  const base = `# Journey view\n\n${broken}\n\n${anchor} as a chain of business moments.\n`;
  const at = base.indexOf(anchor);
  return addThread(base, at, at + anchor.length, {
    author: "ronica",
    body: "what if there are multiple storylines?",
    ts: "2026-09-05T10:00:00.000Z",
  }).source;
}

// Syntax no repo fixture uses: setext headings, `_`/`__`, a backslash hard
// break, inline HTML, `+` bullets, `1)` lists, `~~~` fences, reference links,
// an HTML block, nested quotes.
const PROBE_SYNTAX = [
  "Setext heading",
  "==============",
  "",
  "Sub heading",
  "-----------",
  "",
  "Some _underscore emphasis_ and __underscore strong__ and a backslash\\",
  "hard break, then an <br> inline tag and <kbd>Ctrl</kbd>.",
  "",
  "+ plus bullet",
  "+ another",
  "",
  "1) paren ordered",
  "2) second",
  "",
  "3. starts at three",
  "4. four",
  "",
  "***",
  "",
  "~~~js",
  "const x = 1;",
  "~~~",
  "",
  "A [reference link][ref] and ![ref image][img].",
  "",
  '[ref]: https://example.com "Title"',
  "[img]: ./x.png",
  "",
  "<!-- a plain HTML comment -->",
  "",
  "<details>",
  "<summary>More</summary>",
  "",
  "Hidden *body*.",
  "",
  "</details>",
  "",
  "> quote",
  ">",
  "> > nested quote",
  "",
].join("\n");

/**
 * Gate 2's byte check: `after` is `before` plus exactly the new thread's two
 * markers and its record in the threads block. Returns a list of problems
 * (empty when clean) so a failure names every one.
 *
 * The one byte outside the markers a first comment is allowed to add is the
 * format's own framing: `withThreads` separates a new threads block from the
 * text with one blank line and normalizes the newlines at the end of the file
 * to do it — the review view's add does exactly the same.
 */
export function onlyMarkersAdded(before: string, after: string, threadId: string): string[] {
  const problems: string[] = [];
  const open = `<!--mc:a:${threadId}-->`;
  const close = `<!--mc:/a:${threadId}-->`;
  const regionAfter = parse(after).threadsRegion;
  if (!regionAfter) return ["no threads block after the add"];
  const bodyAfter = after.slice(0, regionAfter.start) + after.slice(regionAfter.end);
  const regionBefore = parse(before).threadsRegion;
  const bodyBefore = regionBefore ? before.slice(0, regionBefore.start) + before.slice(regionBefore.end) : before;
  if (bodyAfter.split(open).length !== 2) problems.push(`open marker appears ${bodyAfter.split(open).length - 1}×`);
  if (bodyAfter.split(close).length !== 2) problems.push(`close marker appears ${bodyAfter.split(close).length - 1}×`);
  if (bodyAfter.indexOf(open) > bodyAfter.indexOf(close)) problems.push("close marker before open marker");
  const unmarked = bodyAfter.replace(open, "").replace(close, "");
  const expected = regionBefore ? bodyBefore : `${bodyBefore.replace(/\n+$/, "")}\n\n\n`;
  if (unmarked !== expected) {
    let i = 0;
    while (i < unmarked.length && unmarked[i] === expected[i]) i++;
    problems.push(
      `body differs outside the markers at ${i}: ${JSON.stringify(expected.slice(i, i + 40))} → ${JSON.stringify(unmarked.slice(i, i + 40))}`,
    );
  }
  return problems;
}
