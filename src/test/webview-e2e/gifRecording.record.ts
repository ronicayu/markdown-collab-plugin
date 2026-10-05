// Scripted scenes for the README GIFs (re-recorded from the
// live editor), driven through the same stubbed host the webview e2e harness
// uses (harness.ts) — the shipped live-editor bundle (out/webview/client.js,
// the default view since 0.35.16) in real Chromium, `acquireVsCodeApi`
// stubbed, host pushes simulated with `postMessage`. The harness page has no
// VS Code theme, so a dark VS Code-like set of `--vscode-*` variables is
// injected after boot (see THEME_CSS) and a fake cursor dot is drawn so clicks
// are visible in the video.
//
// Deliberately named `*.record.ts`, not `*.spec.ts`: playwright.config.ts's
// `testDir` is this folder and its default `testMatch` only picks up
// `*.test.*` / `*.spec.*`, so `npm run test:webview` never runs this file —
// only `scripts/record-gifs.mjs` does, by bundling it with esbuild (the same
// way scripts/build-skill-cli.mjs bundles a TS entry point for use outside
// tsc's normal compile) and calling the two exports below directly. No
// assertions here beyond what tells a scene it progressed — this drives the UI,
// it doesn't test it; that's covered by liveSidebar*.spec.ts and friends.
//
// Each scene opens its own browser + video-recording context (the shared
// suite's `playwright.config.ts` turns video off, since it doesn't need it)
// and returns the recorded .webm path for scripts/record-gifs.mjs to convert.

import { chromium, type Locator, type Page } from "@playwright/test";
import { acceptSuggestion, addSuggestion, addThread, appendReply, parse, replaceThread } from "../../inlineComments/format";
import { awaitPosted, bootLiveEditor, pushToWebview } from "./harness";
import { liveInit, liveProse, liveSidecar } from "./fixtures";

// Narrower than a full editor window on purpose: the script downscales to
// <= 900px wide, and at this width the document and sidebar stay legible.
const RECORD_VIEWPORT = { width: 1000, height: 640 };

/**
 * A dark VS Code-like theme for the bare harness page: the webview CSS reads
 * `--vscode-*` variables that VS Code injects and the harness doesn't.
 */
const THEME_CSS = `
:root, body {
  --vscode-font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-font-weight: normal;
  --vscode-editor-font-family: "SF Mono", Menlo, Consolas, monospace;
  --vscode-editor-font-size: 13px;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #cccccc;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-disabledForeground: #6e6e6e;
  --vscode-sideBar-background: #252526;
  --vscode-sideBar-foreground: #cccccc;
  --vscode-sideBar-border: #3c3c3c;
  --vscode-panel-border: #3c3c3c;
  --vscode-widget-border: #3c3c3c;
  --vscode-contrastBorder: #3c3c3c;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #3c3c3c;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-button-background: #0e639c;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-foreground: #ffffff;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryHoverBackground: #45494e;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-focusBorder: #007fd4;
  --vscode-textLink-foreground: #3794ff;
  --vscode-textLink-activeForeground: #3794ff;
  --vscode-menu-background: #252526;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-border: #454545;
  --vscode-menu-selectionBackground: #04395e;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-textCodeBlock-background: #2d2d2d;
  --vscode-textBlockQuote-background: #2a2a2a;
  --vscode-textBlockQuote-border: #3c3c3c;
  --vscode-textPreformat-foreground: #d7ba7d;
  --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
  --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
  --vscode-editor-selectionBackground: #264f78;
  --vscode-editor-findMatchHighlightBackground: rgba(234, 92, 0, 0.33);
  --vscode-charts-green: #89d185;
  --vscode-testing-iconPassed: #73c991;
  --vscode-editorGutter-addedBackground: #2ea043;
  --vscode-editorGutter-deletedBackground: #f85149;
  --vscode-diffEditor-insertedTextBackground: rgba(155, 185, 85, 0.2);
  --vscode-diffEditor-removedTextBackground: rgba(255, 0, 0, 0.2);
  color-scheme: dark;
}
html, body { background: #1e1e1e; color: #cccccc; font-family: var(--vscode-font-family); font-size: 13px; }
/* The fake cursor: Playwright's video has no pointer, so clicks would be invisible. */
#mc-fake-cursor {
  position: fixed; left: 0; top: 0; width: 18px; height: 18px; z-index: 99999; pointer-events: none;
  transition: transform 450ms cubic-bezier(.4, 0, .2, 1);
  transform: translate(-40px, -40px);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .6));
}
#mc-fake-cursor.mc-click::after {
  content: ""; position: absolute; left: -9px; top: -9px; width: 36px; height: 36px; border-radius: 50%;
  border: 2px solid rgba(55, 148, 255, .9); animation: mc-ripple 400ms ease-out forwards;
}
@keyframes mc-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1); opacity: 0; } }
`;

const CURSOR_SVG =
  '<svg viewBox="0 0 18 18" width="18" height="18"><path d="M2 1 L2 14 L5.5 11 L8 16.5 L10.3 15.5 L7.8 10.2 L12.5 10.2 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/></svg>';

async function hold(page: { waitForTimeout(ms: number): Promise<void> }, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Boot the live editor (Reading mode) and dress the page: theme + fake cursor.
 * The dressing is applied on every document load — the harness's `setContent`
 * replaces the document, and the video records from the first frame — over a
 * dark placeholder page, so no white flash ends up in the GIF.
 */
async function bootRecorded(page: Page, source: string, opts: Parameters<typeof liveSidecar>[1] = {}): Promise<void> {
  const dress = async () => {
    await page.addStyleTag({ content: THEME_CSS }).catch(() => undefined);
    await page
      .evaluate((svg) => {
        if (document.getElementById("mc-fake-cursor")) return;
        const el = document.createElement("div");
        el.id = "mc-fake-cursor";
        el.innerHTML = svg;
        document.body.appendChild(el);
      }, CURSOR_SVG)
      .catch(() => undefined);
  };
  page.on("load", () => void dress());
  await page.goto("data:text/html,<body style='background:%231e1e1e'></body>");
  await bootLiveEditor(page, { ...liveInit(source, opts), readOnly: true, epoch: 1 });
  await dress();
}

/** Glide the fake cursor onto `target`, ripple, then really click it. */
async function clickWithCursor(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("recording: click target has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(
    ([px, py]) => {
      const c = document.getElementById("mc-fake-cursor")!;
      c.style.transform = `translate(${px}px, ${py}px)`;
    },
    [x, y],
  );
  await hold(page, 650);
  await page.evaluate(() => {
    const c = document.getElementById("mc-fake-cursor")!;
    c.classList.remove("mc-click");
    void c.offsetWidth;
    c.classList.add("mc-click");
  });
  await target.click();
}

/** Host push of `source`'s comments/suggestions, as the provider's file watcher would send. */
function pushSidecar(page: Page, source: string, opts: Parameters<typeof liveSidecar>[1] = {}): Promise<void> {
  return pushToWebview(page, { type: "sidecar-changed", ...liveSidecar(source, opts) });
}

/** Host push of the document text itself (an accepted suggestion rewrites the file). */
function pushText(page: Page, source: string, epoch: number): Promise<void> {
  return pushToWebview(page, { type: "externalChange", text: liveProse(source), epoch, quiet: true });
}

function anchorOf(source: string, text: string): [number, number] {
  const at = source.indexOf(text);
  if (at < 0) throw new Error(`recording fixture text not found: ${text}`);
  return [at, at + text.length];
}

/** What a scene hands back: the .webm, and how much of its start (browser + bundle boot) to cut. */
export interface RecordedScene {
  videoPath: string;
  trimStartSeconds: number;
}

async function newScene(outDir: string) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: RECORD_VIEWPORT,
    recordVideo: { dir: outDir, size: RECORD_VIEWPORT },
  });
  const page = await context.newPage();
  const startedAt = Date.now(); // the video's clock starts with the page
  return { browser, context, page, secondsSinceStart: () => (Date.now() - startedAt) / 1000 };
}

/**
 * Scene A — "review-loop": two threads, one with the waiting row showing; a
 * host push lands the agent's reply plus a pending suggestion; Accept is
 * clicked (the posted message is what the harness sees, then the updated text
 * and comments are pushed so the heading visibly changes); the thread resolves.
 */
export async function recordReviewLoop(outDir: string): Promise<RecordedScene> {
  const { browser, context, page, secondsSinceStart } = await newScene(outDir);
  try {
    const base =
      "# Release notes\n\n" +
      "This release focuses on the Markdown parser and on how reviews are written back to the file.\n\n" +
      "## Parser\n\n" +
      "The parser handles nested lists correctly, including the edge cases that used to trip up the older tokenizer.\n\n" +
      "Tables with escaped pipes and fenced code inside list items now round-trip without changes.\n\n" +
      "## Suggestions\n\n" +
      "Suggest mode ships behind a setting, so existing reviews keep working exactly as they do today.\n\n" +
      "- Suggestions are shown inline and applied with a single click.\n" +
      "- Rejected suggestions leave no trace in the file.\n";

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
        agent: true,
        via: "tools",
      }),
    );

    // Boot with the first thread waiting on the agent.
    await bootRecorded(page, source, { pendingThreadIds: [pending.thread.id] });
    const trimStartSeconds = Math.max(0, secondsSinceStart());
    await hold(page, 1800);

    // Host push: the agent's reply lands, and a pending suggestion appears.
    source = replaceThread(
      source,
      pending.thread.id,
      appendReply(parse(source).threads.find((t) => t.id === pending.thread.id)!, {
        author: "claude",
        body: "Yes — it also covers ordered and bullet lists two levels deep.",
        ts: "2026-07-01T10:05:00.000Z",
        agent: true,
        via: "tools",
      }),
    );
    const [hStart, hEnd] = anchorOf(source, "Release notes");
    const sug = addSuggestion(source, hStart, hEnd, {
      author: "claude",
      proposed: "Release highlights",
      note: "Matches the heading used in the README.",
      ts: "2026-07-01T10:06:00.000Z",
      agent: true,
        via: "tools",
    });
    source = sug.source;
    await pushSidecar(page, source);
    await hold(page, 2000);

    // Accept the suggestion — the posted message is what the harness sees.
    await clickWithCursor(page, page.locator(".mc-suggestion").getByRole("button", { name: "Accept", exact: true }));
    await awaitPosted(page, "accept-suggestion");
    // Then push what the host would produce after applying it: the new text,
    // and the sidecar without the suggestion.
    source = acceptSuggestion(source, sug.suggestion.anchorId);
    await pushText(page, source, 2);
    await pushSidecar(page, source);
    await hold(page, 1800);

    // Resolve the thread the agent just answered.
    await clickWithCursor(
      page,
      page
        .locator(`.thread-card[data-thread="${pending.thread.id}"] .thread-actions`)
        .getByRole("button", { name: "Resolve", exact: true }),
    );
    await awaitPosted(page, "toggle-resolve");
    const resolvedThread = parse(source).threads.find((t) => t.id === pending.thread.id)!;
    source = replaceThread(source, pending.thread.id, {
      ...resolvedThread,
      status: "resolved",
      resolvedBy: "ronica",
      resolvedTs: "2026-07-01T10:07:00.000Z",
    });
    await pushSidecar(page, source);
    await hold(page, 2000);

    await context.close();
    const videoPath = await page.video()?.path();
    if (!videoPath) throw new Error("recordReviewLoop: no video was recorded");
    return { videoPath, trimStartSeconds };
  } finally {
    await browser.close();
  }
}

/**
 * Scene B — "ask-agent-to-review": the empty state with its "Ask agent to
 * review" button, a click on it, the wait, then three agent-authored threads
 * arriving via a host push, walked with n / n / p.
 */
export async function recordAskAgentToReview(outDir: string): Promise<RecordedScene> {
  const { browser, context, page, secondsSinceStart } = await newScene(outDir);
  try {
    const emptyDoc =
      "# Service notes\n\n" +
      "Nothing has been reviewed in this file yet.\n\n" +
      "## Setup\n\n" +
      "The setup section still references the old config path, which moved in the last release.\n\n" +
      "Copy the sample file, fill in your credentials, and restart the service.\n\n" +
      "## Retries\n\n" +
      "Error handling around the retry loop looks incomplete: the failure case after the final attempt is never described.\n\n" +
      "- Requests are retried with exponential backoff.\n" +
      "- Each attempt is logged with its status code.\n";

    await bootRecorded(page, emptyDoc);
    const trimStartSeconds = Math.max(0, secondsSinceStart());
    await hold(page, 1600);

    await clickWithCursor(page, page.locator(".mc-empty-state").getByRole("button", { name: "Ask agent to review" }));
    await awaitPosted(page, "empty-state-review");
    // The sidebar shows nothing new until the agent's threads land, so this
    // hold is the wait. (The host's `review-pending` push is left out: it makes
    // the sidebar reveal the first new thread, and when that thread arrives the
    // read-only highlight for it isn't drawn yet, which raises a "Couldn't
    // locate this comment's anchor" toast over the footer.)
    await hold(page, 1800);

    let source = emptyDoc;
    const agentThread = (text: string, body: string) => {
      const [start, end] = anchorOf(source, text);
      source = addThread(source, start, end, { author: "claude", body, ts: "2026-07-01T11:00:00.000Z", agent: true, via: "tools" }).source;
    };
    agentThread("old config path", "This path changed in the last release — update it or link to the new one.");
    agentThread("retry loop looks incomplete", "What happens after the third retry? Worth spelling out.");
    agentThread("Nothing has been reviewed", "Once this file has a pass, update this line so it doesn't go stale.");

    await pushSidecar(page, source);
    await hold(page, 1800);

    // n / n / p walks the highlight through the new threads.
    await page.keyboard.press("n");
    await hold(page, 1000);
    await page.keyboard.press("n");
    await hold(page, 1000);
    await page.keyboard.press("p");
    await hold(page, 1400);

    await context.close();
    const videoPath = await page.video()?.path();
    if (!videoPath) throw new Error("recordAskAgentToReview: no video was recorded");
    return { videoPath, trimStartSeconds };
  } finally {
    await browser.close();
  }
}
