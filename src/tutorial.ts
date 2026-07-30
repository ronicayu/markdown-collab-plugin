// A playground document you can click through in the first minute (P3.1).
//
// The install-to-value path currently runs: install the extension, install the
// skill, open a file, select text, write a comment, configure a send mode, get
// Claude running, wait. Every one of those can go wrong, and none of them shows
// what the thing actually feels like — the accept/reject loop, a thread with a
// reply in it, a suggestion sitting there waiting for a decision.
//
// So: a scratch document that arrives already mid-review, with threads, a reply,
// and two pending suggestions. Nothing to configure, no Claude session, no
// network. It is built by the real format engine, so what you click is the same
// machinery a real review uses — a hand-written fixture would drift and would
// teach the wrong thing when it did.

import { addSuggestion, addThread, appendReply, parse, replaceThread } from "./inlineComments/format";
import { withRefreshedAnchorHash } from "./inlineComments/staleness";

/** Fixed timestamps: a tutorial that says "3 minutes ago" every time is a lie. */
const T1 = "2026-01-15T10:00:00.000Z";
const T2 = "2026-01-15T10:04:00.000Z";
const T3 = "2026-01-15T10:06:00.000Z";

const BODY = `# Markdown Collab — playground

This file is a sandbox. Everything below is real review state stored in this
document, so anything you do here works exactly as it would in your own docs.
Delete the file when you're done — nothing else depends on it.

## Try this, in order

1. **Read a thread.** The sidebar has two. One already has a reply.
2. **Reply to one.** Type in the box under the comment and hit Reply.
3. **Accept a suggestion.** The cards at the top propose a change to this file.
   Accept applies it; Reject keeps the current wording. Both are undoable with
   Cmd+Z, like any edit you make yourself.
4. **Resolve a thread** when you're satisfied with it.
5. **Add your own.** Select any sentence in the preview and click Comment.

## How this works

Comments live inside this .md file, wrapped around the text they point at. That
is why review state survives a commit, a branch switch, and a colleague opening
the file — and why there is no database to keep in sync.

The heading above is anchored to a comment. So is this sentence about tokenizers.

## What comes next

When you send comments to Claude, it reads them, edits the document, and replies
in the thread. Point it at a real doc when you're ready — this file has taught
you the loop.
`;

/**
 * The playground document, mid-review. Deterministic apart from the minted
 * thread ids, which nothing here needs to know.
 */
export function buildTutorialDocument(): string {
  const anchor = (src: string, text: string): [number, number] => {
    const at = src.indexOf(text);
    if (at < 0) throw new Error(`tutorial anchor text missing: ${text}`);
    return [at, at + text.length];
  };

  let source = BODY;

  // A thread Claude answered — shows the shape of a finished exchange.
  const [aStart, aEnd] = anchor(source, "review state survives a commit");
  const answered = addThread(source, aStart, aEnd, {
    author: "you",
    body: "Does this hold if two people edit the same file on different branches?",
    ts: T1,
  });
  source = replaceThread(
    answered.source,
    answered.thread.id,
    withRefreshedAnchorHash(
      parse(answered.source),
      appendReply(answered.thread, {
        author: "claude",
        body:
          "Yes — the threads are text, so git merges them like any other change. " +
          "A conflict looks like a normal conflict in the threads block at the end of the file.",
        ts: T2,
      }),
    ),
  );

  // A thread waiting on a reply — the state the "Reply" step acts on.
  const [bStart, bEnd] = anchor(source, "this sentence about tokenizers");
  const waiting = addThread(source, bStart, bEnd, {
    author: "you",
    body: "Reply to this one to see what a thread looks like once it has two comments.",
    ts: T3,
  });
  source = waiting.source;

  // Two suggestions, so the "Accept all" affordance is visible too.
  const [cStart, cEnd] = anchor(source, "a sandbox");
  source = addSuggestion(source, cStart, cEnd, {
    author: "claude",
    proposed: "a scratch document",
    note: "\"Sandbox\" is jargon; \"scratch document\" says what it is.",
    ts: T2,
  }).source;

  const [dStart, dEnd] = anchor(source, "no database to keep in sync");
  source = addSuggestion(source, dStart, dEnd, {
    author: "claude",
    proposed: "no separate database to keep in sync",
    note: "Slightly clearer about what is being ruled out.",
    ts: T3,
  }).source;

  return source;
}

/** Where the playground is written, relative to the workspace root. */
export const TUTORIAL_REL = "markdown-collab-playground.md";
