import { describe, expect, it } from "vitest";
import {
  checkpointFor,
  contentHashOf,
  deltaScope,
  diffAgainstCheckpoint,
  sectionHashes,
  splitSections,
} from "../inlineComments/deltaReview";
import { buildDeltaPrompt } from "../inlineComments/deltaPrompt";
import { addThread, parse, withThreads } from "../inlineComments/format";
import { opCheckpoint, opReply } from "../inlineComments/docOps";

const NOW = () => "2026-07-30T09:00:00.000Z";

const DOC = `# Guide

Intro paragraph.

## Setup

Install the thing.

## Usage

Run the thing.
`;

/** DOC with a checkpoint recorded, as a finished review pass would leave it. */
function reviewed(source = DOC): string {
  return opCheckpoint(source, NOW).next;
}

describe("splitSections", () => {
  it("splits at headings and keeps the heading with its body", () => {
    const sections = splitSections(DOC);
    expect(sections.map((s) => s.heading)).toEqual(["Guide", "Setup", "Usage"]);
    expect(sections[1]!.text).toContain("Install the thing.");
    expect(sections[1]!.startLine).toBe(5);
  });

  it("treats a document with no headings as one section", () => {
    const sections = splitSections("just prose\nover two lines\n");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.heading).toBeNull();
  });

  it("keeps text above the first heading as its own section", () => {
    const sections = splitSections("preamble line\n\n# First\n\nbody\n");
    expect(sections[0]).toMatchObject({ heading: null, ordinal: 0 });
    expect(sections[0]!.text).toContain("preamble line");
  });

  it("numbers repeated headings so they compare one-for-one", () => {
    const sections = splitSections("## Notes\n\na\n\n## Notes\n\nb\n");
    expect(sections.map((s) => [s.heading, s.ordinal])).toEqual([
      ["Notes", 0],
      ["Notes", 1],
    ]);
  });
});

describe("checkpointFor", () => {
  it("records the content hash and a hash per section", () => {
    const cp = checkpointFor(DOC, NOW);
    expect(cp.ts).toBe(NOW());
    expect(cp.contentHash).toBe(contentHashOf(DOC));
    expect(cp.sections).toEqual(sectionHashes(DOC));
    expect(cp.sections).toHaveLength(3);
  });

  it("ignores review markup — a comment is not a document change", () => {
    // Otherwise every thread Claude opens would make the file look edited, and
    // the next delta pass would re-review everything.
    const at = DOC.indexOf("Install the thing.");
    const commented = addThread(DOC, at, at + 7, { author: "claude", body: "?", ts: NOW() });
    expect(contentHashOf(commented.source)).toBe(contentHashOf(DOC));
  });
});

describe("diffAgainstCheckpoint", () => {
  const cp = checkpointFor(DOC, NOW);

  it("finds nothing when the document hasn't moved", () => {
    expect(diffAgainstCheckpoint(DOC, cp).changed).toEqual([]);
  });

  it("names only the section that was edited", () => {
    const edited = DOC.replace("Install the thing.", "Install the thing with npm.");
    const { changed } = diffAgainstCheckpoint(edited, cp);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ heading: "Setup", change: "edited" });
    expect(changed[0]!.text).toContain("with npm");
  });

  it("reports a new section as added", () => {
    const grown = `${DOC}\n## Troubleshooting\n\nTurn it off and on.\n`;
    const { changed } = diffAgainstCheckpoint(grown, cp);
    expect(changed.map((c) => [c.heading, c.change])).toEqual([["Troubleshooting", "added"]]);
  });

  it("reports a deleted section as context, not as a review target", () => {
    const shrunk = DOC.replace("## Usage\n\nRun the thing.\n", "");
    const { changed, removedHeadings } = diffAgainstCheckpoint(shrunk, cp);
    expect(removedHeadings).toEqual(["Usage"]);
    expect(changed.map((c) => c.heading)).not.toContain("Usage");
  });

  it("compares repeated headings one-for-one", () => {
    const doubled = "## Notes\n\na\n\n## Notes\n\nb\n";
    const before = checkpointFor(doubled, NOW);
    const after = doubled.replace("\nb\n", "\nB CHANGED\n");
    const { changed } = diffAgainstCheckpoint(after, before);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.ordinal).toBe(1);
  });
});

describe("deltaScope", () => {
  it("reports no-checkpoint for a file that was never reviewed", () => {
    expect(deltaScope(parse(DOC)).kind).toBe("no-checkpoint");
  });

  it("reports unchanged when the prose hasn't moved since the pass", () => {
    expect(deltaScope(parse(reviewed())).kind).toBe("unchanged");
  });

  it("is incremental once a section changes", () => {
    const scope = deltaScope(parse(reviewed().replace("Run the thing.", "Run the other thing.")));
    expect(scope.kind).toBe("incremental");
    if (scope.kind !== "incremental") return;
    expect(scope.changed.map((c) => c.heading)).toEqual(["Usage"]);
  });

  it("carries the existing threads, with their status and staleness", () => {
    const at = DOC.indexOf("Install the thing.");
    const seeded = addThread(DOC, at, at + "Install the thing.".length, {
      author: "claude",
      body: "Name the package manager.",
      ts: NOW(),
    });
    const checkpointed = opCheckpoint(seeded.source, NOW).next;
    const edited = checkpointed.replace("Run the thing.", "Run the other thing.");
    const scope = deltaScope(parse(edited));
    expect(scope.existing).toHaveLength(1);
    expect(scope.existing[0]).toMatchObject({
      id: seeded.thread.id,
      status: "open",
      stale: false,
      gist: "Name the package manager.",
    });
  });

  // A checkpoint written before section hashes existed can't say what moved.
  // Claiming "nothing changed" there would silently skip the whole review.
  it("falls back to a full pass when the checkpoint has no section hashes", () => {
    const legacy = withThreads(DOC, [], undefined, {
      ts: NOW(),
      contentHash: "00000000",
    });
    expect(deltaScope(parse(legacy)).kind).toBe("no-checkpoint");
  });
});

describe("opCheckpoint", () => {
  it("round-trips through parse", () => {
    const parsed = parse(reviewed());
    expect(parsed.checkpoint).toMatchObject({ ts: NOW(), contentHash: contentHashOf(DOC) });
    expect(parsed.checkpoint!.sections).toHaveLength(3);
  });

  it("leaves the prose untouched", () => {
    expect(reviewed()).toContain("Install the thing.");
    expect(parse(reviewed()).threads).toEqual([]);
  });

  it("survives later thread mutations", () => {
    // Every mutation re-renders the threads region; dropping the checkpoint
    // there would silently reset the next pass to a full review.
    const at = DOC.indexOf("Install the thing.");
    const seeded = addThread(reviewed(), at, at + 7, { author: "ronica", body: "?", ts: NOW() });
    expect(parse(seeded.source).checkpoint?.ts).toBe(NOW());
    const replied = opReply(seeded.source, seeded.thread.id, "answered").next;
    expect(parse(replied).checkpoint?.ts).toBe(NOW());
  });

  it("refuses to checkpoint a damaged document", () => {
    // Otherwise the next pass is told the damage was reviewed and approved.
    const broken = `${DOC}\n<!--mc:a:zzzzz-->orphan\n`;
    expect(() => opCheckpoint(broken, NOW)).toThrow(/integrity/);
  });
});

describe("buildDeltaPrompt", () => {
  const scope = deltaScope(parse(reviewed().replace("Run the thing.", "Run the other thing.")));

  it("says what changed and forbids re-reviewing the rest", () => {
    const prompt = buildDeltaPrompt("docs/guide.md", scope)!;
    expect(prompt).toContain("§Usage");
    expect(prompt).toContain("Run the other thing.");
    expect(prompt).toContain("Do not review unchanged prose");
    // The unchanged section's body must not be shipped.
    expect(prompt).not.toContain("Install the thing.");
  });

  it("returns null for an unchanged document, so the caller sends nothing", () => {
    expect(buildDeltaPrompt("docs/guide.md", deltaScope(parse(reviewed())))).toBeNull();
  });

  it("carries the focus directive through", () => {
    expect(buildDeltaPrompt("docs/guide.md", scope, "check the commands")).toContain(
      "Focus: check the commands",
    );
  });

  it("lists existing threads and marks resolved ones as settled", () => {
    const at = DOC.indexOf("Install the thing.");
    const seeded = addThread(DOC, at, at + "Install the thing.".length, {
      author: "claude",
      body: "Name the package manager.",
      ts: NOW(),
    });
    const resolved = withThreads(
      seeded.source,
      parse(seeded.source).threads.map((t) => ({ ...t, status: "resolved" as const })),
    );
    const withCheckpoint = opCheckpoint(resolved, NOW).next;
    const edited = withCheckpoint.replace("Run the thing.", "Run the other thing.");
    const prompt = buildDeltaPrompt("docs/guide.md", deltaScope(parse(edited)))!;
    expect(prompt).toContain(seeded.thread.id);
    expect(prompt).toContain("resolved");
    expect(prompt).toContain("is settled");
  });

  it("on a first pass, still warns against duplicating existing threads", () => {
    const at = DOC.indexOf("Install the thing.");
    const seeded = addThread(DOC, at, at + 7, { author: "claude", body: "existing note", ts: NOW() });
    const prompt = buildDeltaPrompt("docs/guide.md", deltaScope(parse(seeded.source)))!;
    expect(prompt).toContain("Review Mode");
    expect(prompt).toContain("already has review threads");
    expect(prompt).toContain(seeded.thread.id);
  });
});
