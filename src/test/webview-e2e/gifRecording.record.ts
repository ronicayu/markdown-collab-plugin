// Scripted scenes for the README GIFs (10x-plan-4 P3.3), driven through the
// same stubbed host the webview e2e harness uses (harness.ts) — the shipped
// inline-view bundle in real Chromium, `acquireVsCodeApi` stubbed, host
// pushes simulated with `postMessage`.
//
// Deliberately named `*.record.ts`, not `*.spec.ts`: playwright.config.ts's
// `testDir` is this folder and its default `testMatch` only picks up
// `*.test.*` / `*.spec.*`, so `npm run test:webview` never runs this file —
// only `scripts/record-gifs.mjs` does, by bundling it with esbuild (the same
// way scripts/build-skill-cli.mjs bundles a TS entry point for use outside
// tsc's normal compile) and calling the two exports below directly. No
// assertions here — this drives the UI, it doesn't test it; that's already
// covered by inlineView.spec.ts and inlineViewEmptyState.spec.ts.
//
// Each scene opens its own browser + video-recording context (the shared
// suite's `playwright.config.ts` turns video off, since it doesn't need it)
// and returns the recorded .webm path for scripts/record-gifs.mjs to convert.

import { chromium } from "@playwright/test";
import { acceptSuggestion, addSuggestion, addThread, appendReply, parse, replaceThread } from "../../inlineComments/format";
import { serialize } from "../../inlineComments/serializeState";
import { awaitPosted, bootInlineView, pushToWebview } from "./harness";

const RECORD_VIEWPORT = { width: 1280, height: 800 };

async function hold(page: { waitForTimeout(ms: number): Promise<void> }, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/** `state` field of an `update` message for `source`, matching what the host would send. */
function updateOf(source: string, opts: { pendingThreadIds?: string[]; suggestMode?: boolean } = {}) {
  return {
    type: "update",
    state: serialize(parse(source)),
    suggestMode: opts.suggestMode ?? false,
    pendingThreadIds: opts.pendingThreadIds ?? [],
  };
}

/** `init` message body for `source` (bootInlineView's shape, plus any overrides). */
function initOf(source: string, overrides: Record<string, unknown> = {}) {
  return {
    fileName: "docs/release-notes.md",
    state: serialize(parse(source)),
    user: { name: "ronica" },
    imageBaseUris: { docDir: "", workspaceFolder: null },
    plantuml: { serverUrl: "https://www.plantuml.com/plantuml", format: "svg" },
    skillStatus: "current",
    suggestMode: false,
    pendingThreadIds: [] as string[],
    ...overrides,
  };
}

function anchorOf(source: string, text: string): [number, number] {
  const at = source.indexOf(text);
  if (at < 0) throw new Error(`recording fixture text not found: ${text}`);
  return [at, at + text.length];
}

/**
 * Scene A — "review-loop": two threads, one with the "Claude is working…"
 * row showing; a host push lands Claude's reply plus a pending suggestion;
 * Accept is clicked (the posted message is what the harness sees, then the
 * updated state is pushed so the text visibly changes); the thread resolves.
 */
export async function recordReviewLoop(outDir: string): Promise<string> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: RECORD_VIEWPORT,
      recordVideo: { dir: outDir, size: RECORD_VIEWPORT },
    });
    const page = await context.newPage();

    const base = `# Release notes\n\nThe parser handles nested lists correctly.\n\nSuggest mode ships behind a setting.\n`;

    const [aStart, aEnd] = anchorOf(base, "nested lists correctly");
    const pending = addThread(base, aStart, aEnd, {
      author: "ronica",
      body: "Does this handle deeply nested lists too?",
      ts: "2026-07-01T10:00:00.000Z",
    });

    const [bStart, bEnd] = anchorOf(pending.source, "behind a setting");
    const answered = addThread(pending.source, bStart, bEnd, {
      author: "ronica",
      body: "Which setting is this?",
      ts: "2026-07-01T10:01:00.000Z",
    });
    let source = replaceThread(
      answered.source,
      answered.thread.id,
      appendReply(answered.thread, {
        author: "claude",
        body: "It's `markdownCollab.proposeEditsAsSuggestions`.",
        ts: "2026-07-01T10:02:00.000Z",
      }),
    );

    // Boot with the pending thread showing "Claude is working…".
    await bootInlineView(page, initOf(source, { pendingThreadIds: [pending.thread.id] }));
    await hold(page, 1500);

    // Host push: Claude's reply lands, and a pending suggestion appears.
    source = replaceThread(
      source,
      pending.thread.id,
      appendReply(parse(source).threads.find((t) => t.id === pending.thread.id)!, {
        author: "claude",
        body: "Yes — it also covers ordered and bullet lists two levels deep.",
        ts: "2026-07-01T10:05:00.000Z",
      }),
    );
    const [hStart, hEnd] = anchorOf(source, "Release notes");
    const sug = addSuggestion(source, hStart, hEnd, {
      author: "claude",
      proposed: "Release highlights",
      note: "Matches the heading used in the README.",
      ts: "2026-07-01T10:06:00.000Z",
    });
    source = sug.source;
    await pushToWebview(page, updateOf(source));
    await hold(page, 1800);

    // Accept the suggestion — the posted message is what the harness sees.
    await page.locator(".mc-suggestion").getByRole("button", { name: "Accept" }).click();
    await awaitPosted(page, "accept-suggestion");
    // Then push the state the host would produce after applying it, so the
    // heading text visibly changes.
    source = acceptSuggestion(source, sug.suggestion.anchorId);
    await pushToWebview(page, updateOf(source));
    await hold(page, 1500);

    // Resolve the thread Claude just answered.
    await page
      .locator(`.thread-card[data-thread="${pending.thread.id}"] .thread-actions`)
      .getByRole("button", { name: "Resolve", exact: true })
      .click();
    await awaitPosted(page, "toggle-resolve");
    const resolvedThread = parse(source).threads.find((t) => t.id === pending.thread.id)!;
    source = replaceThread(source, pending.thread.id, {
      ...resolvedThread,
      status: "resolved",
      resolvedBy: "ronica",
      resolvedTs: "2026-07-01T10:07:00.000Z",
    });
    await pushToWebview(page, updateOf(source));
    await hold(page, 1800);

    await context.close();
    const videoPath = await page.video()?.path();
    if (!videoPath) throw new Error("recordReviewLoop: no video was recorded");
    return videoPath;
  } finally {
    await browser.close();
  }
}

/**
 * Scene B — "review-with-claude": the empty-state card, a click on its
 * review button, then three Claude-authored threads arriving via a host
 * push, walked with n / n / p.
 */
export async function recordReviewWithClaude(outDir: string): Promise<string> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: RECORD_VIEWPORT,
      recordVideo: { dir: outDir, size: RECORD_VIEWPORT },
    });
    const page = await context.newPage();

    const emptyDoc =
      "# Notes\n\nNothing has been reviewed in this file yet.\n\n" +
      "The setup section still references the old config path.\n\n" +
      "Error handling around the retry loop looks incomplete.\n";

    await bootInlineView(page, { ...initOf(emptyDoc), headlessAvailable: true });
    await hold(page, 1000);

    await page.locator(".mc-empty-state").getByRole("button", { name: "Review with Claude" }).click();
    await awaitPosted(page, "empty-state-review");
    // No global "review pass pending" row exists in the shipped inline view
    // yet (that's P2.2's terminal-mode progress work, not landed on this
    // branch) — this hold stands in for the wait a real headless run has,
    // rather than fabricating UI that doesn't ship.
    await hold(page, 1200);

    let source = emptyDoc;
    const claudeThread = (text: string, body: string) => {
      const [start, end] = anchorOf(source, text);
      const result = addThread(source, start, end, { author: "claude", body, ts: "2026-07-01T11:00:00.000Z" });
      source = result.source;
    };
    claudeThread("old config path", "This path changed in the last release — update it or link to the new one.");
    claudeThread("retry loop looks incomplete", "What happens after the third retry? Worth spelling out.");
    claudeThread("Nothing has been reviewed", "Once this file has a pass, update this line so it doesn't go stale.");

    await pushToWebview(page, updateOf(source));
    await hold(page, 1500);

    // n / n / p walks the highlight through the three new threads.
    await page.keyboard.press("n");
    await hold(page, 700);
    await page.keyboard.press("n");
    await hold(page, 700);
    await page.keyboard.press("p");
    await hold(page, 1200);

    await context.close();
    const videoPath = await page.video()?.path();
    if (!videoPath) throw new Error("recordReviewWithClaude: no video was recorded");
    return videoPath;
  } finally {
    await browser.close();
  }
}
