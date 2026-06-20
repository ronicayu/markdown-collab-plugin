import { describe, it, expect } from "vitest";
import {
  addThreadAtOffsets,
  addThreadFromAnchor,
  commentsOf,
  deleteComment,
  deleteThread,
  frontmatterOf,
  mergeProseEdit,
  placeAnchorsInProse,
  proseOf,
  replyToThread,
  setThreadResolved,
} from "../collab/inlineBridge";
import { parse, withThreads } from "../inlineComments/format";
import { locateNthOccurrence } from "../collab/liveAnchorLocator";

const DOC = [
  "# Title",
  "",
  "The quick brown fox jumps over the lazy dog near the river bank.",
  "",
  "A second paragraph with some other words to anchor against here.",
  "",
].join("\n");

/** Anchor on a unique phrase in the first paragraph. */
const ANCHOR = {
  text: "jumps over the lazy dog",
  contextBefore: "The quick brown fox ",
  contextAfter: " near the river",
};

function seed(doc = DOC, anchor = ANCHOR): { source: string; id: string } {
  const res = addThreadFromAnchor(doc, anchor, { author: "ron", body: "first", ts: "2026-01-01T00:00:00.000Z" });
  if (!res.ok) throw new Error(`seed failed: ${res.error}`);
  return { source: res.source, id: parse(res.source).threads[0]!.id };
}

describe("proseOf", () => {
  it("returns the document unchanged when there are no comments", () => {
    expect(proseOf(DOC)).toBe(DOC);
  });

  it("strips anchor markers and the threads region back to clean prose", () => {
    const { source } = seed();
    const prose = proseOf(source);
    expect(prose).not.toContain("<!--mc:");
    expect(prose).toContain("jumps over the lazy dog");
    // Round-trips back to the original prose (markers were invisible).
    expect(prose.trimEnd()).toBe(DOC.trimEnd());
  });

  it("round-trips exactly: stripping a freshly-seeded doc yields the original prose", () => {
    // Regression guard: a stray trailing newline here made the editor↔document
    // echo non-idempotent and reverted edits on save.
    const { source } = seed();
    expect(proseOf(source)).toBe(DOC);
  });

  it("round-trips exactly after a prose edit (proseOf ∘ mergeProseEdit is identity)", () => {
    const { source } = seed();
    const edited = DOC.replace("# Title", "# Title edited");
    expect(proseOf(mergeProseEdit(source, edited))).toBe(edited);
  });
});

describe("addThreadFromAnchor", () => {
  it("wraps the located span in markers and appends a thread", () => {
    const { source, id } = seed();
    expect(source).toContain(`<!--mc:a:${id}-->jumps over the lazy dog<!--mc:/a:${id}-->`);
    expect(source).toContain("<!--mc:threads:begin-->");
    const comments = commentsOf(source);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe("first");
    expect(comments[0]!.author).toBe("ron");
  });

  it("saves loosely-anchored (no markers) when the text isn't found verbatim", () => {
    // e.g. a table cell or formatted span whose visible text isn't in the
    // source markdown verbatim — the comment must still be saved, not refused.
    const res = addThreadFromAnchor(DOC, { text: "Alex — PM", contextBefore: "", contextAfter: "" }, {
      author: "ron",
      body: "x",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).not.toContain("<!--mc:a:"); // no anchor markers placed
    const comments = commentsOf(res.source);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.anchor.text).toBe("Alex — PM"); // quote preserved for the highlight
    expect(proseOf(res.source)).toBe(DOC); // body untouched
  });

  it("disambiguates duplicate anchor text using context", () => {
    const dup = "alpha beta gamma\n\nalpha beta gamma\n";
    const res = addThreadFromAnchor(
      dup,
      { text: "alpha beta gamma", contextBefore: "", contextAfter: "\n\nalpha" },
      { author: "ron", body: "first occurrence" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The first occurrence (followed by the blank line + second copy) gets wrapped.
    const firstMarkerIdx = res.source.indexOf("<!--mc:a:");
    expect(firstMarkerIdx).toBe(0);
  });

  it("places the marker by ordinal on a duplicate table cell (context can't disambiguate)", () => {
    // Tables repeat values ("Yes"), and the rendered context the editor sends
    // carries no `|`, so context matching fails. Before the ordinal fallback
    // this saved loosely-anchored (no markers); now the occurrence index pins it.
    const table = ["| Feature | Free | Pro |", "| :-- | :-- | :-- |", "| Export | No | Yes |", "| Sharing | Yes | Yes |", ""].join("\n");
    const anchor = { text: "Yes", contextBefore: "SharingYes", contextAfter: "Yes" };

    // No ordinal → context fails on a duplicate → loose (no markers).
    const loose = addThreadFromAnchor(table, anchor, { author: "ron", body: "q" });
    expect(loose.ok).toBe(true);
    if (loose.ok) expect(loose.source).not.toContain("<!--mc:a:");

    // Ordinal 1 = the Sharing/Free "Yes" (2nd of three) gets the marker, exactly.
    const placed = addThreadFromAnchor(table, anchor, { author: "ron", body: "q" }, 1);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const sharingRow = placed.source.split("\n").find((l) => l.includes("Sharing"))!;
    expect(sharingRow).toContain("<!--mc:a:");
    expect(sharingRow).toMatch(/\|\s*<!--mc:a:[a-z0-9]+-->Yes<!--mc:\/a:[a-z0-9]+-->\s*\|\s*Yes\s*\|/);
    // The Export row's "Yes" (ordinal 0) stays unmarked.
    const exportRow = placed.source.split("\n").find((l) => l.includes("Export"))!;
    expect(exportRow).not.toContain("<!--mc:a:");
  });
});

describe("commentsOf", () => {
  it("derives anchor text + surrounding context from the prose", () => {
    const { source } = seed();
    const c = commentsOf(source)[0]!;
    expect(c.anchor.text).toBe("jumps over the lazy dog");
    expect(c.anchor.contextBefore.endsWith("brown fox ")).toBe(true);
    expect(c.anchor.contextAfter.startsWith(" near")).toBe(true);
  });

  it("reports an unanchored thread (no markers) using its stored quote", () => {
    // A threads region with no matching anchor markers in the prose.
    const orphan = `${DOC}\n<!--mc:threads:begin-->\n<!--mc:t {"id":"ab12c","quote":"ghost quote","status":"open","comments":[{"id":"c1","author":"ron","ts":"2026-01-01T00:00:00.000Z","body":"orphaned"}]}-->\n<!--mc:threads:end-->\n`;
    const c = commentsOf(orphan)[0]!;
    expect(c.id).toBe("ab12c");
    expect(c.anchor.text).toBe("ghost quote");
    expect(c.anchor.contextBefore).toBe("");
  });

  it("skips a fully tombstoned thread", () => {
    const { source, id } = seed();
    const parsed = parse(source);
    const t = parsed.threads.find((x) => x.id === id)!;
    const tombstoned = `${proseOf(source)}\n<!--mc:threads:begin-->\n<!--mc:t ${JSON.stringify({ ...t, comments: [{ ...t.comments[0], deleted: true }] })}-->\n<!--mc:threads:end-->\n`;
    expect(commentsOf(tombstoned)).toHaveLength(0);
  });
});

describe("replyToThread / setThreadResolved / deleteThread", () => {
  it("appends a reply", () => {
    const { source, id } = seed();
    const next = replyToThread(source, id, { body: "a reply", author: "kit" })!;
    expect(next).not.toBeNull();
    const c = commentsOf(next)[0]!;
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0]).toMatchObject({ author: "kit", body: "a reply" });
  });

  it("flips resolved state and records resolvedBy", () => {
    const { source, id } = seed();
    const resolved = setThreadResolved(source, id, true, "kit", "2026-02-02T00:00:00.000Z")!;
    expect(commentsOf(resolved)[0]!.resolved).toBe(true);
    expect(parse(resolved).threads[0]!.resolvedBy).toBe("kit");
    const reopened = setThreadResolved(resolved, id, false, "kit")!;
    expect(commentsOf(reopened)[0]!.resolved).toBe(false);
    expect(parse(reopened).threads[0]!.resolvedBy).toBeUndefined();
  });

  it("deletes a thread and its markers", () => {
    const { source, id } = seed();
    const next = deleteThread(source, id)!;
    expect(commentsOf(next)).toHaveLength(0);
    expect(next).not.toContain("<!--mc:a:");
  });

  it("returns null for unknown ids", () => {
    const { source } = seed();
    expect(replyToThread(source, "zzzzz", { body: "x", author: "a" })).toBeNull();
    expect(setThreadResolved(source, "zzzzz", true, "a")).toBeNull();
    expect(deleteThread(source, "zzzzz")).toBeNull();
  });
});

describe("addThreadAtOffsets (exact placement, no text search)", () => {
  it("wraps exactly the offset span and saves the comment", () => {
    const sel = "jumps over the lazy dog";
    const start = DOC.indexOf(sel);
    const end = start + sel.length;
    const res = addThreadAtOffsets(DOC, DOC, start, end, { author: "ron", body: "c", ts: "2026-01-01T00:00:00Z" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const id = parse(res.source).threads[0]!.id;
    expect(res.source).toContain(`<!--mc:a:${id}-->${sel}<!--mc:/a:${id}-->`);
    expect(commentsOf(res.source)[0]!.anchor.text).toBe(sel);
    expect(proseOf(res.source)).toBe(DOC);
  });

  it("places the open marker after the heading hashes (keeps the line a heading)", () => {
    const body = "## Section Title\n\nSome body text.";
    // Select from line start (before the `##`) through the heading text.
    const res = addThreadAtOffsets(body, body, 0, "## Section Title".length, {
      author: "ron",
      body: "c",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const id = parse(res.source).threads[0]!.id;
    expect(res.source).toContain(`## <!--mc:a:${id}-->Section Title<!--mc:/a:${id}-->`);
  });

  it("succeeds even when the stored doc has drifted from the editor body", () => {
    // Existing comment in the stored doc; the editor's body is a reformatted
    // version (heading changed) the stored prose never had verbatim.
    const { source } = seed();
    const newBody = proseOf(source).replace("# Title", "# Title (reformatted)");
    const sel = "second paragraph";
    const start = newBody.indexOf(sel);
    const res = addThreadAtOffsets(source, newBody, start, start + sel.length, { author: "ron", body: "new" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(commentsOf(res.source)).toHaveLength(2); // old re-anchored + new
    expect(proseOf(res.source)).toBe(newBody); // editor body adopted, round-trips
  });

  it("keeps the new comment even if an existing anchor can't be relocated", () => {
    const { source, id } = seed();
    // Editor body deletes the old anchor text entirely.
    const newBody = proseOf(source).replace("The quick brown fox jumps over the lazy dog near the river bank.", "Gone.");
    const sel = "second paragraph";
    const start = newBody.indexOf(sel);
    const res = addThreadAtOffsets(source, newBody, start, start + sel.length, { author: "ron", body: "new" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const comments = commentsOf(res.source);
    expect(comments).toHaveLength(2); // both threads survive (old one unanchored)
    expect(res.source).not.toContain(`<!--mc:a:${id}-->`); // old anchor dropped
  });

  it("rejects unusable offsets (caller falls back to text anchoring)", () => {
    expect(addThreadAtOffsets(DOC, DOC, -1, 5, { author: "r", body: "c" }).ok).toBe(false);
    expect(addThreadAtOffsets(DOC, DOC, 5, 5, { author: "r", body: "c" }).ok).toBe(false);
    expect(addThreadAtOffsets(DOC, DOC, 0, DOC.length + 50, { author: "r", body: "c" }).ok).toBe(false);
  });

  it("preserves frontmatter and offsets are body-relative", () => {
    const FM = "---\ntitle: x\n---\n";
    const newBody = DOC;
    const sel = "quick brown fox";
    const start = newBody.indexOf(sel);
    const res = addThreadAtOffsets(FM + DOC, newBody, start, start + sel.length, { author: "r", body: "c" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source.startsWith(FM)).toBe(true);
    expect(commentsOf(res.source)[0]!.anchor.text).toBe(sel);
    expect(proseOf(res.source)).toBe(newBody);
  });
});

describe("quote hygiene (no captured markers)", () => {
  it("a new comment's quote doesn't capture an adjacent comment's markers", () => {
    const { source } = seed(); // existing comment on "jumps over the lazy dog"
    // New comment whose text abuts the existing anchor, so its source span
    // crosses the existing open marker.
    const res = addThreadFromAnchor(
      source,
      { text: "brown fox jumps over", contextBefore: "quick ", contextAfter: " the lazy" },
      { author: "ron", body: "c2" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const t of parse(res.source).threads) {
      expect(t.quote).not.toMatch(/<!--mc/);
    }
    for (const c of commentsOf(res.source)) {
      expect(c.anchor.text).not.toMatch(/<!--mc/);
    }
  });

  it("commentsOf strips markers from a legacy marker-laden quote", () => {
    // A thread whose stored quote captured another thread's marker (from
    // before the source fix) and is unanchored in the body.
    const src = withThreads(DOC, [
      {
        id: "xx111",
        quote: "river bank <!--mc:/a:zz999--> today",
        status: "open",
        comments: [{ id: "c1", author: "r", ts: "2026-01-01T00:00:00Z", body: "b" }],
      },
    ]);
    const c = commentsOf(src)[0]!;
    expect(c.anchor.text).not.toMatch(/<!--mc/);
    expect(c.anchor.text).toBe("river bank  today");
  });
});

describe("frontmatter", () => {
  const FM = "---\ntitle: Hello\ntags: [a, b]\n---\n";
  const fmDoc = FM + DOC;

  it("frontmatterOf extracts the block (with fences); '' when absent", () => {
    expect(frontmatterOf(fmDoc)).toBe(FM);
    expect(frontmatterOf(DOC)).toBe("");
  });

  it("proseOf strips the frontmatter out of the editor body", () => {
    expect(proseOf(fmDoc)).toBe(DOC);
    expect(proseOf(fmDoc)).not.toContain("title: Hello");
  });

  it("adding a comment keeps the frontmatter and anchors in the body", () => {
    const res = addThreadFromAnchor(fmDoc, ANCHOR, { author: "ron", body: "c" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source.startsWith(FM)).toBe(true);
    expect(commentsOf(res.source)[0]!.anchor.text).toBe("jumps over the lazy dog");
  });

  it("a body edit re-prepends the frontmatter verbatim and round-trips", () => {
    const { source } = seed(fmDoc);
    const editedBody = proseOf(source).replace("# Title", "# Title edited");
    const merged = mergeProseEdit(source, editedBody);
    expect(frontmatterOf(merged)).toBe(FM);
    expect(proseOf(merged)).toBe(editedBody);
  });
});

describe("mergeProseEdit", () => {
  it("re-anchors a thread after surrounding prose changes", () => {
    const { source, id } = seed();
    // Insert a new opening paragraph; the anchored sentence is unchanged.
    const editedProse = proseOf(source).replace("# Title", "# Title\n\nBrand new intro paragraph.");
    const merged = mergeProseEdit(source, editedProse);
    // Marker still wraps the same phrase, now at a later offset.
    expect(merged).toContain(`<!--mc:a:${id}-->jumps over the lazy dog<!--mc:/a:${id}-->`);
    expect(merged).toContain("Brand new intro paragraph.");
    expect(commentsOf(merged)).toHaveLength(1);
  });

  it("keeps the thread but drops markers when the anchored text is deleted", () => {
    const { source, id } = seed();
    const editedProse = proseOf(source).replace("The quick brown fox jumps over the lazy dog near the river bank.", "Replaced entirely.");
    const merged = mergeProseEdit(source, editedProse);
    expect(merged).not.toContain(`<!--mc:a:${id}-->`);
    // Thread survives as unanchored (still listed, fallback to stored quote).
    const comments = commentsOf(merged);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(id);
  });

  it("preserves resolved status across an edit", () => {
    const { source, id } = seed();
    const resolved = setThreadResolved(source, id, true, "kit")!;
    const merged = mergeProseEdit(resolved, proseOf(resolved).replace("Title", "Title!"));
    expect(commentsOf(merged)[0]!.resolved).toBe(true);
  });

  it("produces clean prose (no markers) when there are no threads", () => {
    const merged = mergeProseEdit(DOC, "Totally new content.\n");
    expect(merged).toBe("Totally new content.\n");
  });

  it("keeps the marker when text is edited INSIDE the anchored span", () => {
    const { source, id } = seed(); // anchors "jumps over the lazy dog"
    // Change a word in the middle of the anchored phrase — the quote no longer
    // matches, but the marker should track the edit instead of orphaning.
    const edited = proseOf(source).replace("lazy", "sleepy");
    const merged = mergeProseEdit(source, edited);
    expect(merged).toContain(`<!--mc:a:${id}-->jumps over the sleepy dog<!--mc:/a:${id}-->`);
    expect(commentsOf(merged)).toHaveLength(1);
  });

  it("keeps a table-cell marker through a mid-cell edit with column re-padding", () => {
    // Source has tight padding; the editor re-serializes with wide padding AND a
    // character inserted mid-cell. Context that reaches into the separator row
    // (its dash run gets re-padded) must not defeat re-anchoring.
    const src = [
      "| # | Principle | Rationale |",
      "| :-- | :-- | :-- |",
      "| DP-1 | **<!--mc:a:rb824-->Single writer per domain<!--mc:/a:rb824-->** | Eliminates conflicts. |",
      "",
      "<!--mc:threads:begin-->",
      '<!--mc:t {"id":"rb824","quote":"Single writer per domain","status":"open","comments":[{"id":"c1","author":"ron","ts":"2026-01-01T00:00:00Z","body":"q"}]}-->',
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
    const newProse = [
      "| #    | Principle                     | Rationale             |",
      "| :--- | :---------------------------- | :-------------------- |",
      "| DP-1 | **Single wrZiter per domain** | Eliminates conflicts. |",
      "",
    ].join("\n");
    const merged = mergeProseEdit(src, newProse);
    expect(merged).toMatch(/<!--mc:a:rb824-->Single wrZiter per domain<!--mc:\/a:rb824-->/);
    expect(commentsOf(merged)).toHaveLength(1);
  });

  // --- review hardening: in-place edit-tracking edge cases ---

  it("tracks the edited text and does NOT jump to a stale duplicate elsewhere", () => {
    const src = addThreadFromAnchor(
      "intro alpha here.\n\nlater alpha word.\n",
      { text: "alpha", contextBefore: "intro ", contextAfter: " here" },
      { author: "ron", body: "c" },
    );
    expect(src.ok).toBe(true);
    if (!src.ok) return;
    // Edit the FIRST 'alpha' -> 'alphx'; the old quote 'alpha' still occurs in line 2.
    const merged = mergeProseEdit(src.source, proseOf(src.source).replace("intro alpha here", "intro alphx here"));
    expect(merged).toMatch(/intro <!--mc:a:[a-z0-9]+-->alphx<!--mc:\/a:[a-z0-9]+--> here/);
    expect(merged).not.toMatch(/later <!--mc:a:/); // didn't yank onto the 2nd 'alpha'
  });

  it("keeps a marker when the anchor at the start of a line is edited inside", () => {
    const src = addThreadFromAnchor(
      "# Title\n\nAlpha beta is here.\n",
      { text: "Alpha", contextBefore: "\n", contextAfter: " beta" },
      { author: "ron", body: "c" },
    );
    expect(src.ok).toBe(true);
    if (!src.ok) return;
    const merged = mergeProseEdit(src.source, proseOf(src.source).replace("Alpha beta", "Alpheta beta"));
    expect(merged).toMatch(/<!--mc:a:[a-z0-9]+-->Alpheta<!--mc:\/a:[a-z0-9]+--> beta/);
  });

  it("unanchors (no empty marker) when the whole anchored text is deleted", () => {
    const src = addThreadFromAnchor(
      "the quick brown fox.\n",
      { text: "quick brown", contextBefore: "the ", contextAfter: " fox" },
      { author: "ron", body: "c" },
    );
    expect(src.ok).toBe(true);
    if (!src.ok) return;
    const merged = mergeProseEdit(src.source, proseOf(src.source).replace("quick brown ", ""));
    expect(merged).not.toMatch(/<!--mc:a:[a-z0-9]+--><!--mc:\/a:[a-z0-9]+-->/); // no zero-width marker
    expect(commentsOf(merged)).toHaveLength(1); // thread survives, unanchored
  });

  it("does not wrap padding whitespace, and survives editing a hyphenated word", () => {
    const src = addThreadFromAnchor(
      "x ab-cd y\n",
      { text: "ab-cd", contextBefore: "x ", contextAfter: " y" },
      { author: "ron", body: "c" },
    );
    expect(src.ok).toBe(true);
    if (!src.ok) return;
    const merged = mergeProseEdit(src.source, proseOf(src.source).replace("ab-cd", "ab -cd"));
    expect(merged).toMatch(/x <!--mc:a:[a-z0-9]+-->ab -cd<!--mc:\/a:[a-z0-9]+--> y/);
  });

  it("does not split a surrogate pair when an emoji inside the anchor is edited", () => {
    const src = addThreadFromAnchor(
      "see \u{1F600}x done\n",
      { text: "\u{1F600}x", contextBefore: "see ", contextAfter: " done" },
      { author: "ron", body: "c" },
    );
    expect(src.ok).toBe(true);
    if (!src.ok) return;
    const merged = mergeProseEdit(src.source, proseOf(src.source).replace("\u{1F600}x", "\u{1F601}x"));
    // No lone surrogate anywhere in the output.
    expect(merged).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(merged).toMatch(/<!--mc:a:[a-z0-9]+-->\u{1F601}x<!--mc:\/a:[a-z0-9]+-->/u);
  });
});

describe("placeAnchorsInProse (editor-reported positions)", () => {
  const TABLE = [
    "| # | Principle | Rationale |",
    "| :- | :- | :- |",
    "| DP-1 | **<!--mc:a:rb824-->Single writer per domain<!--mc:/a:rb824-->** | Eliminates conflicts. |",
    "",
    "<!--mc:threads:begin-->",
    '<!--mc:t {"id":"rb824","quote":"Single writer per domain","status":"open","comments":[{"id":"c1","author":"ron","ts":"2026-01-01T00:00:00Z","body":"q"}]}-->',
    "<!--mc:threads:end-->",
    "",
  ].join("\n");

  it("places the marker at the editor-reported occurrence after a mid-cell edit", () => {
    // The editor maps its decoration through the edit and reports the new span
    // text + ordinal; the host places by that — no quote re-matching.
    const newProse = [
      "| #    | Principle                     | Rationale             |",
      "| :--- | :---------------------------- | :-------------------- |",
      "| DP-1 | **Single wrZiter per domain** | Eliminates conflicts. |",
      "",
    ].join("\n");
    const out = placeAnchorsInProse(TABLE, newProse, [
      { id: "rb824", text: "Single wrZiter per domain", ordinal: 0 },
    ]);
    expect(out).toMatch(/\*\*<!--mc:a:rb824-->Single wrZiter per domain<!--mc:\/a:rb824-->\*\*/);
    expect(commentsOf(out)).toHaveLength(1);
  });

  it("places duplicate-text anchors at the exact reported occurrences", () => {
    const src = [
      "| F | Free | Pro |",
      "| :- | :- | :- |",
      "| Export | No | Yes |",
      "| Sharing | Yes | Yes |",
      "",
      "<!--mc:threads:begin-->",
      '<!--mc:t {"id":"t1","quote":"Yes","status":"open","comments":[{"id":"c1","author":"r","ts":"2026-01-01T00:00:00Z","body":"a"}]}-->',
      '<!--mc:t {"id":"t2","quote":"Yes","status":"open","comments":[{"id":"c1","author":"r","ts":"2026-01-01T00:00:00Z","body":"b"}]}-->',
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
    const out = placeAnchorsInProse(src, proseOf(src), [
      { id: "t1", text: "Yes", ordinal: 1 },
      { id: "t2", text: "Yes", ordinal: 2 },
    ]);
    const sharing = out.split("\n").find((l) => l.includes("Sharing"))!;
    // Sharing row: Free col = 2nd "Yes" (t1), Pro col = 3rd "Yes" (t2).
    expect(sharing).toMatch(
      /<!--mc:a:t1-->Yes<!--mc:\/a:t1-->\s*\|\s*<!--mc:a:t2-->Yes<!--mc:\/a:t2-->/,
    );
    // The Export row's "Yes" (ordinal 0) is untouched.
    expect(out.split("\n").find((l) => l.includes("Export"))!).not.toContain("<!--mc:a:");
  });

  it("unanchors when the anchored text was deleted and isn't reported", () => {
    // Editor reports nothing (its decoration collapsed) AND the text is gone.
    const deleted = proseOf(TABLE).replace("Single writer per domain", "");
    const out = placeAnchorsInProse(TABLE, deleted, []);
    expect(out).not.toContain("<!--mc:a:"); // nothing to anchor to
    expect(commentsOf(out)).toHaveLength(1); // thread preserved, unanchored
  });

  it("re-anchors an unreported thread whose text is still present (safety net)", () => {
    // If the editor reports nothing for a thread (e.g. its decoration failed to
    // build) but the anchored text is unchanged, fall back to text re-anchoring
    // rather than dropping the marker.
    const out = placeAnchorsInProse(TABLE, proseOf(TABLE), []);
    expect(out).toMatch(/<!--mc:a:rb824-->Single writer per domain<!--mc:\/a:rb824-->/);
  });

  it("recovers a thread by its quote when deleted text is restored by undo", () => {
    // Delete the anchored text: the editor drops the decoration and reports
    // nothing, so the thread unanchors (but keeps its quote).
    const deleted = placeAnchorsInProse(TABLE, proseOf(TABLE).replace("Single writer per domain", ""), []);
    expect(deleted).not.toContain("<!--mc:a:"); // unanchored
    expect(deleted).toContain('"quote":"Single writer per domain"'); // quote retained
    // Undo restores the text; ProseMirror can't resurrect the dropped
    // decoration so the editor STILL reports nothing — recover by the quote.
    const undone = placeAnchorsInProse(deleted, proseOf(TABLE), []);
    expect(undone).toMatch(/<!--mc:a:rb824-->Single writer per domain<!--mc:\/a:rb824-->/);
    expect(commentsOf(undone)).toHaveLength(1);
  });

  it("does not recover by quote when the quote is duplicated (ambiguous)", () => {
    const src = [
      "<!--mc:threads:begin-->",
      '<!--mc:t {"id":"d1","quote":"Yes","status":"open","comments":[{"id":"c1","author":"r","ts":"2026-01-01T00:00:00Z","body":"a"}]}-->',
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
    const unanchored = "Yes and also Yes here.\n"; // 2 occurrences, no marker
    const out = placeAnchorsInProse("Old text.\n\n" + src, unanchored + src, []);
    expect(out).not.toContain("<!--mc:a:"); // ambiguous → stays unanchored
  });

  it("keeps a resolved thread's marker (editor tracks resolved anchors too)", () => {
    const resolved = setThreadResolved(TABLE, "rb824", true, "ron")!;
    const out = placeAnchorsInProse(resolved, proseOf(resolved), [
      { id: "rb824", text: "Single writer per domain", ordinal: 0 },
    ]);
    expect(out).toMatch(/<!--mc:a:rb824-->Single writer per domain<!--mc:\/a:rb824-->/);
    expect(commentsOf(out)[0]!.resolved).toBe(true);
  });
});

describe("deleteComment", () => {
  const REPLY = { author: "alex", body: "a reply", ts: "2026-01-02T00:00:00.000Z" };

  it("drops a reply, keeping the thread and its root comment", () => {
    const { source, id } = seed();
    const withReply = replyToThread(source, id, REPLY);
    expect(withReply).not.toBeNull();
    const replyId = commentsOf(withReply!)[0]!.replies[0]!.id;
    const next = deleteComment(withReply!, id, replyId);
    expect(next).not.toBeNull();
    const after = commentsOf(next!)[0]!;
    expect(after.body).toBe("first");
    expect(after.replies).toHaveLength(0);
  });

  it("removes the whole thread when its only comment is deleted", () => {
    const { source, id } = seed();
    const rootId = commentsOf(source)[0]!.rootCommentId;
    const next = deleteComment(source, id, rootId);
    expect(next).not.toBeNull();
    expect(commentsOf(next!)).toHaveLength(0);
  });

  it("tombstones the root when it has replies, so the reply shows as the root", () => {
    const { source, id } = seed();
    const withReply = replyToThread(source, id, REPLY);
    const rootId = commentsOf(withReply!)[0]!.rootCommentId;
    const next = deleteComment(withReply!, id, rootId);
    expect(next).not.toBeNull();
    const after = commentsOf(next!)[0]!;
    expect(after.body).toBe("a reply");
    expect(after.replies).toHaveLength(0);
  });

  it("returns null for an unknown thread or comment id", () => {
    const { source, id } = seed();
    expect(deleteComment(source, "no-such-thread", "c1")).toBeNull();
    expect(deleteComment(source, id, "no-such-comment")).toBeNull();
  });
});

describe("anchorOrdinal + ordinal highlight (table / structural-markdown regression)", () => {
  it("highlights an anchor in a bold table cell whose context is full of table markdown", () => {
    const source = [
      "| #     | Principle | Rationale |",
      "| :---- | :-------- | :-------- |",
      "| DP-1  | **<!--mc:a:rb824-->Single writer per domain<!--mc:/a:rb824-->** | Eliminates write conflicts. |",
      "",
      "<!--mc:threads:begin-->",
      '<!--mc:t {"id":"rb824","quote":"Single writer per domain","status":"open","comments":[{"id":"c1","author":"ron","ts":"2026-01-01T00:00:00Z","body":"x"}]}-->',
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
    const c = commentsOf(source)[0]!;
    expect(c.anchorOrdinal).toBe(0); // first (only) occurrence
    // Rendered (Milkdown): cell text concatenated, no '|'/'**'/separator row.
    const rendered = "#PrincipleRationaleDP-1Single writer per domainEliminates write conflicts.";
    const loc = locateNthOccurrence(rendered, c.anchor.text, c.anchorOrdinal);
    expect(loc).not.toBeNull();
    expect(rendered.slice(loc!.start, loc!.end)).toBe("Single writer per domain");
  });

  it("the ordinal picks the right occurrence among duplicates", () => {
    const source = [
      "The active flag is set. Later the <!--mc:a:k1-->active<!--mc:/a:k1--> flag is cleared.",
      "",
      "<!--mc:threads:begin-->",
      '<!--mc:t {"id":"k1","quote":"active","status":"open","comments":[{"id":"c1","author":"ron","ts":"2026-01-01T00:00:00Z","body":"x"}]}-->',
      "<!--mc:threads:end-->",
      "",
    ].join("\n");
    const c = commentsOf(source)[0]!;
    expect(c.anchorOrdinal).toBe(1); // the SECOND "active" is the anchored one
    const rendered = "The active flag is set. Later the active flag is cleared.";
    const loc = locateNthOccurrence(rendered, c.anchor.text, c.anchorOrdinal)!;
    expect(loc).not.toBeNull();
    expect(loc.start).toBe(rendered.indexOf("active", rendered.indexOf("active") + 1));
  });
});
