import { describe, it, expect } from "vitest";
import {
  addThreadFromAnchor,
  commentsOf,
  deleteThread,
  mergeProseEdit,
  proseOf,
  replyToThread,
  setThreadResolved,
} from "../collab/inlineBridge";
import { parse } from "../inlineComments/format";

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

  it("keeps frontmatter in the prose (the editor shows it)", () => {
    const withFm = `---\ntitle: x\n---\n\n${DOC}`;
    expect(proseOf(withFm)).toContain("title: x");
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

  it("rejects an anchor whose text isn't in the document", () => {
    const res = addThreadFromAnchor(DOC, { text: "nonexistent phrase here", contextBefore: "", contextAfter: "" }, {
      author: "ron",
      body: "x",
    });
    expect(res.ok).toBe(false);
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
});
