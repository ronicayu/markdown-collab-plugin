// `checkIntegrity` on a thread opened on nothing (ux-review-2026-09 0.1).
//
// `mdc open --occurrence banana` wrapped zero characters at byte 0 and
// recorded `"quote":""`, and `mdc check` then said `ok: true`. An empty quote
// is now an `empty-quote` issue. A zero-width anchor whose quote survives is
// NOT one: that is what deleting the passage a thread was about leaves behind,
// and the round-trip corpus holds it valid.

import { describe, expect, it } from "vitest";
import { addThread, parse } from "../inlineComments/format";
import { checkIntegrity, repairIntegrity } from "../inlineComments/integrity";

const TS = "2026-07-01T00:00:00.000Z";
const BASE = "# Occ\n\nOnly one alpha here.\n";

function seeded(): { source: string; id: string } {
  const at = BASE.indexOf("alpha");
  const { source, thread } = addThread(BASE, at, at + "alpha".length, { author: "claude", body: "x", ts: TS });
  return { source, id: thread.id };
}

/** Exactly what the NaN occurrence produced: an empty anchor at byte 0, an empty quote. */
function bananaDoc(): { source: string; id: string } {
  const { source, id } = seeded();
  const damaged = source
    .replace(`<!--mc:a:${id}-->alpha<!--mc:/a:${id}-->`, "alpha")
    .replace(/"quote":"alpha"/, '"quote":""');
  return { source: `<!--mc:a:${id}--><!--mc:/a:${id}-->${damaged}`, id };
}

describe("checkIntegrity: a thread with an empty quote", () => {
  it("the zero-width, empty-quote anchor the NaN occurrence wrote is not ok", () => {
    const { source, id } = bananaDoc();
    // Sanity: this is the shape the bug produced — anchored, zero-width.
    const a = parse(source).anchors.get(id)!;
    expect(a.openStart).toBe(0);
    expect(a.openEnd).toBe(a.closeStart);

    const report = checkIntegrity(source);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "empty-quote", severity: "warning", threadId: id, repairable: false }),
    ]);
    expect(report.issues[0]!.message).toMatch(/empty span/);
    expect(report.counts.repairable).toBe(0);
  });

  it("is not repairable: repair leaves the document as it was and still reports it", () => {
    const { source } = bananaDoc();
    const r = repairIntegrity(source);
    expect(r.source).toBe(source);
    expect(r.repairs).toEqual([]);
    expect(r.remaining.map((i) => i.kind)).toEqual(["empty-quote"]);
  });

  it("an empty quote over a non-empty anchor is reported too", () => {
    const { source, id } = seeded();
    const report = checkIntegrity(source.replace(/"quote":"alpha"/, '"quote":""'));
    expect(report.issues).toEqual([expect.objectContaining({ kind: "empty-quote", threadId: id })]);
    expect(report.issues[0]!.message).toMatch(/cannot be re-anchored/);
  });

  it("a zero-width anchor whose quote survives stays ok — the passage was deleted, the thread wasn't", () => {
    const { source, id } = seeded();
    expect(checkIntegrity(source.replace(`<!--mc:a:${id}-->alpha<!--mc:/a:${id}-->`, `<!--mc:a:${id}--><!--mc:/a:${id}-->`)).ok).toBe(true);
  });

  it("an unanchored empty-quote thread is reported once, as unanchored", () => {
    const { source, id } = seeded();
    const unanchored = source
      .replace(`<!--mc:a:${id}-->alpha<!--mc:/a:${id}-->`, "alpha")
      .replace(/"quote":"alpha"/, '"quote":""');
    expect(checkIntegrity(unanchored).issues.map((i) => i.kind)).toEqual(["unanchored-thread"]);
  });
});
