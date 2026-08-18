// Prose line → source line, the mapping behind "show line numbers".
//
// The two line spaces are not the same, and the difference is not cosmetic:
// frontmatter and the threads region are whole blocks the prose never sees, so
// counting newlines in the rendered text puts every number on screen off by the
// height of the frontmatter. A wrong line number is worse than none — it sends
// the reader to the wrong place in their own file — so this is mapped through
// the offset table rather than counted.

import { describe, expect, it } from "vitest";
import { addThread, parse } from "../inlineComments/format";
import { mapProseToSource, sourceLineForProseLine } from "../inlineComments/proseMapping";

const TS = "2026-01-01T00:00:00.000Z";

/** The source line the given prose text sits on, via the map under test. */
function lineOfProseText(src: string, needle: string): number {
  const parsed = parse(src);
  const prose = mapProseToSource(parsed).prose;
  const map = sourceLineForProseLine(parsed);
  const proseLine = prose.slice(0, prose.indexOf(needle)).split("\n").length - 1;
  return map[proseLine];
}

describe("sourceLineForProseLine", () => {
  it("is the identity for a document with nothing stripped", () => {
    const src = "# A\n\nB\n\nC\n";
    expect(sourceLineForProseLine(parse(src)).slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("skips over frontmatter, which the prose never shows", () => {
    const src = "---\ntitle: T\nauthor: R\n---\n\n# Head\n\nBody.\n";
    // "# Head" is the 6th line of the file; a naive count would call it the 2nd.
    expect(lineOfProseText(src, "# Head")).toBe(6);
    expect(lineOfProseText(src, "Body.")).toBe(8);
  });

  it("is unmoved by inline anchor markers, which add no lines", () => {
    const src = "# A\n\nThe quick brown fox.\n\nTail.\n";
    const at = src.indexOf("quick brown");
    const withThread = addThread(src, at, at + 11, { author: "you", body: "x", ts: TS }).source;
    expect(lineOfProseText(withThread, "Tail.")).toBe(5);
    expect(lineOfProseText(withThread, "The quick")).toBe(3);
  });

  it("keeps working when frontmatter and threads are both present", () => {
    const base = "---\nid: 1\n---\n\n# Title\n\nA sentence to anchor.\n";
    const at = base.indexOf("sentence");
    const src = addThread(base, at, at + 8, { author: "you", body: "note", ts: TS }).source;
    // The threads region is appended at the end and must not shift anything.
    expect(lineOfProseText(src, "# Title")).toBe(5);
    expect(lineOfProseText(src, "A sentence")).toBe(7);
  });

  it("gives every prose line a number", () => {
    const src = "---\nid: 1\n---\n\n# T\n\nA\n\nB\n";
    const parsed = parse(src);
    const map = sourceLineForProseLine(parsed);
    expect(map).toHaveLength(mapProseToSource(parsed).prose.split("\n").length);
    // Monotonic: a later line in the prose is never earlier in the file.
    for (let i = 1; i < map.length; i++) expect(map[i]).toBeGreaterThanOrEqual(map[i - 1]);
  });

  it("handles an empty document without throwing", () => {
    expect(sourceLineForProseLine(parse(""))).toEqual([1]);
  });
});
