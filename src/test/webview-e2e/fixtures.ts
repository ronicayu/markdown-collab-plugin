// Fixture documents for the webview e2e suite.
//
// Built by running the real format engine over real markdown, then serialized
// by the same functions the host uses (`serialize` for the inline view,
// `commentsOf`/`suggestionsOf`/`proseOf` for the live editor). A hand-written
// init payload would let the specs keep passing after a wire-shape change; this
// way the fixture breaks with the engine.

import { addSuggestion, addThread, appendReply, parse, replaceThread } from "../../inlineComments/format";
import { serialize } from "../../inlineComments/serializeState";
import { commentsOf, frontmatterOf, proseOf, suggestionsOf } from "../../collab/inlineBridge";
import { withRefreshedAnchorHash } from "../../inlineComments/staleness";

const BASE = `# Release notes

The parser handles nested lists correctly.

Suggest mode ships behind a setting.
`;

export interface ReviewFixture {
  /** Full markdown source, markers and threads region included. */
  source: string;
  /** Thread carrying a human comment and Claude's reply. */
  answeredThreadId: string;
  /** Thread the human opened that Claude hasn't answered. */
  openThreadId: string;
  /** Anchor id of the pending suggestion. */
  suggestionId: string;
}

/**
 * A document mid-review: one answered thread, one thread still waiting on
 * Claude, and one pending suggestion. Deterministic apart from the minted ids,
 * which the caller reads off the returned fixture.
 */
export function reviewFixture(): ReviewFixture {
  const anchorOf = (src: string, text: string): [number, number] => {
    const at = src.indexOf(text);
    if (at < 0) throw new Error(`fixture text not found: ${text}`);
    return [at, at + text.length];
  };

  let source = BASE;
  const [aStart, aEnd] = anchorOf(source, "nested lists");
  const first = addThread(source, aStart, aEnd, {
    author: "ronica",
    body: "Does this cover ordered lists too?",
    ts: "2026-07-01T10:00:00.000Z",
  });
  source = replaceThread(
    first.source,
    first.thread.id,
    appendReply(first.thread, {
      author: "claude",
      body: "Yes — ordered and bullet lists share the tokenizer.",
      ts: "2026-07-01T10:05:00.000Z",
    }),
  );

  const [bStart, bEnd] = anchorOf(source, "behind a setting");
  const second = addThread(source, bStart, bEnd, {
    author: "ronica",
    body: "Which setting, exactly?",
    ts: "2026-07-01T11:00:00.000Z",
  });
  source = second.source;

  const [cStart, cEnd] = anchorOf(source, "Release notes");
  const sug = addSuggestion(source, cStart, cEnd, {
    author: "claude",
    proposed: "Release highlights",
    note: "Matches the heading used in the README.",
    ts: "2026-07-01T11:30:00.000Z",
  });
  source = sug.source;

  return {
    source,
    answeredThreadId: first.thread.id,
    openThreadId: second.thread.id,
    suggestionId: sug.suggestion.anchorId,
  };
}

/**
 * Rewrite the text between a thread's markers, the way an editor would — which
 * is what makes the thread stale (its last comment predates the new text).
 */
export function editAnchoredText(source: string, threadId: string, next: string): string {
  const a = parse(source).anchors.get(threadId);
  if (!a) throw new Error(`thread ${threadId} has no anchor`);
  return source.slice(0, a.openEnd) + next + source.slice(a.closeStart);
}

/** The `init` message body the inline-comments panel would push for `source`. */
export function inlineInit(
  source: string,
  opts: { pendingThreadIds?: string[]; suggestMode?: boolean } = {},
): Record<string, unknown> {
  return {
    fileName: "docs/release-notes.md",
    state: serialize(parse(source)),
    user: { name: "ronica" },
    imageBaseUris: { docDir: "", workspaceFolder: null },
    plantuml: { serverUrl: "https://www.plantuml.com/plantuml", format: "svg" },
    skillStatus: "current",
    suggestMode: opts.suggestMode ?? false,
    pendingThreadIds: opts.pendingThreadIds ?? [],
  };
}

/**
 * The comment/suggestion half of what the live-editor provider pushes — the
 * body of both `init` and the `sidecar-changed` update.
 */
export function liveSidecar(
  source: string,
  opts: { pendingThreadIds?: string[] } = {},
): Record<string, unknown> {
  return {
    comments: commentsOf(source),
    suggestions: suggestionsOf(source),
    pendingThreadIds: opts.pendingThreadIds ?? [],
  };
}

/** The `init` message body the live-editor provider would push for `source`. */
export function liveInit(
  source: string,
  opts: { pendingThreadIds?: string[] } = {},
): Record<string, unknown> {
  return {
    text: proseOf(source),
    user: { name: "ronica", color: "#4f8cff" },
    ...liveSidecar(source, opts),
    frontmatter: frontmatterOf(source),
    imageBaseUris: { docDir: "", workspaceFolder: null },
  };
}

/** The prose the live editor shows for `source` (markers + threads region gone). */
export function liveProse(source: string): string {
  return proseOf(source);
}

/**
 * Append a human reply to a thread, exactly as the panel's mutation handler
 * would — including refreshing the anchor hash, since the replier has just read
 * the passage as it now stands.
 */
export function replyTo(source: string, threadId: string, body: string): string {
  const parsed = parse(source);
  const thread = parsed.threads.find((t) => t.id === threadId);
  if (!thread) throw new Error(`no thread ${threadId}`);
  return replaceThread(
    source,
    threadId,
    withRefreshedAnchorHash(
      parsed,
      appendReply(thread, { author: "ronica", body, ts: "2026-07-02T09:00:00.000Z" }),
    ),
  );
}
