import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildTutorialDocument, TUTORIAL_REL } from "../tutorial";
import { parse, stripAllInlineMarkup } from "../inlineComments/format";
import { checkIntegrity } from "../inlineComments/integrity";
import { serialize } from "../inlineComments/serializeState";
import { commentsOf, suggestionsOf } from "../collab/inlineBridge";

const doc = buildTutorialDocument();
const parsed = parse(doc);

describe("the tutorial playground", () => {
  // It is the first thing a new user sees. A malformed one would teach the
  // failure mode instead of the feature.
  it("is a healthy document", () => {
    expect(checkIntegrity(doc).ok, JSON.stringify(checkIntegrity(doc).issues)).toBe(true);
    expect(parsed.unanchoredThreadIds).toEqual([]);
    expect(parsed.unanchoredSuggestionIds).toEqual([]);
  });

  it("arrives mid-review, which is the whole point", () => {
    expect(parsed.threads).toHaveLength(2);
    expect(parsed.suggestions).toHaveLength(2);
  });

  it("has one thread already answered and one still waiting", () => {
    const withReply = parsed.threads.filter((t) => t.comments.length > 1);
    expect(withReply).toHaveLength(1);
    expect(withReply[0]!.comments.at(-1)!.author).toBe("claude");
    expect(parsed.threads.filter((t) => t.comments.length === 1)).toHaveLength(1);
  });

  it("has two suggestions, so the bulk-accept affordance is visible too", () => {
    expect(parsed.suggestions.every((s) => s.note && s.note.length > 10)).toBe(true);
    expect(parsed.suggestions.every((s) => s.original !== s.proposed)).toBe(true);
  });

  it("uses fixed timestamps — a tutorial that says '3 minutes ago' every time is a lie", () => {
    for (const t of parsed.threads) {
      for (const c of t.comments) expect(c.ts.startsWith("2026-01-15")).toBe(true);
    }
  });

  it("renders without any marker leaking into the prose", () => {
    expect(stripAllInlineMarkup(doc)).not.toContain("mc:");
    expect(stripAllInlineMarkup(doc)).toContain("Markdown Collab — playground");
  });

  it("tells the reader it is disposable", () => {
    expect(doc).toContain("Delete the file when you're done");
  });

  it("serializes for both review surfaces", () => {
    // If either projection throws or comes back empty, the playground opens to
    // an empty sidebar — the worst possible first impression.
    expect(serialize(parsed).threads).toHaveLength(2);
    expect(commentsOf(doc)).toHaveLength(2);
    expect(suggestionsOf(doc)).toHaveLength(2);
    expect(commentsOf(doc).every((c) => c.anchorOrdinal >= 0)).toBe(true);
  });

  it("is deterministic apart from the minted ids", () => {
    const again = buildTutorialDocument();
    const strip = (s: string) => s.replace(/[a-z0-9]{5}/g, "ID");
    expect(strip(again)).toBe(strip(doc));
  });

  it("writes to a name that reads as disposable", () => {
    expect(TUTORIAL_REL.endsWith(".md")).toBe(true);
    expect(TUTORIAL_REL).toContain("playground");
  });
});

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
}

interface Walkthrough {
  id: string;
  steps: WalkthroughStep[];
}

interface CommandContribution {
  command: string;
}

/**
 * Wiring coverage for the `markdownCollab.gettingStarted` walkthrough
 * (round-4 coverage review): every step's `[label](command:...)` link must
 * name a command the extension actually contributes, or clicking it in the
 * Get Started page is a silent no-op. Manifest-level — the same
 * `package.json`-reading approach `titleBarAndKeybindings.test.ts` uses —
 * since a vitest unit test has no extension host to check live registration
 * against; "contributed" is the checkable proxy for "registered".
 */
describe("the getting-started walkthrough", () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as {
    contributes: { walkthroughs: Walkthrough[]; commands: CommandContribution[] };
  };
  const walkthrough = pkg.contributes.walkthroughs.find((w) => w.id === "markdownCollab.gettingStarted");
  const contributedCommands = new Set(pkg.contributes.commands.map((c) => c.command));

  /** Every `command:foo.bar` target in a step's markdown description. */
  function commandLinks(step: WalkthroughStep): string[] {
    return [...step.description.matchAll(/\(command:([A-Za-z0-9_.]+)\)/g)].map((m) => m[1]!);
  }

  it("is contributed, with at least one step", () => {
    expect(walkthrough, "markdownCollab.gettingStarted is not contributed").toBeTruthy();
    expect(walkthrough!.steps.length).toBeGreaterThan(0);
  });

  it("every step links at least one command, and every linked command is contributed", () => {
    for (const step of walkthrough!.steps) {
      const links = commandLinks(step);
      expect(links.length, `step "${step.id}" has no command: link`).toBeGreaterThan(0);
      for (const command of links) {
        expect(
          contributedCommands.has(command),
          `step "${step.id}" links "${command}", which isn't in contributes.commands`,
        ).toBe(true);
      }
    }
  });

  it("the comment step links markdownCollab.openInlineCommentsView", () => {
    const step = walkthrough!.steps.find((s) => s.id === "comment");
    expect(step, "walkthrough has no \"comment\" step").toBeTruthy();
    expect(commandLinks(step!)).toContain("markdownCollab.openInlineCommentsView");
  });
});
