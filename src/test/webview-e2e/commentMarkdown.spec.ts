// Comment bodies render as markdown in the surfaces that display them.
//
// The unit tests pin what the renderer produces; these pin that the review view
// actually uses it — the bug being fixed was surfaces rendering the same body
// different ways, which is invisible to a test of the renderer alone.

import { expect, test } from "@playwright/test";
import { addThread, appendReply, replaceThread } from "../../inlineComments/format";
import { bootLiveEditor } from "./harness";
import { liveInit } from "./fixtures";

const BODY = "Two problems:\n\n- the retry count is wrong\n- and `maxDelay` is unused\n\n```js\nconst x = 1;\n```\n";

const DOC = "# Doc\n\nThe retry policy needs work.\n";

/** A document carrying one thread whose reply is markdown-heavy. */
function withMarkdownReply(): { source: string; id: string } {
  const at = DOC.indexOf("retry policy");
  const first = addThread(DOC, at, at + 12, {
    author: "ronica",
    body: "What's wrong here?",
    ts: "2026-08-01T10:00:00.000Z",
  });
  const source = replaceThread(
    first.source,
    first.thread.id,
    appendReply(first.thread, { author: "claude", body: BODY, ts: "2026-08-01T10:05:00.000Z" }),
  );
  return { source, id: first.thread.id };
}

test("the live editor renders a reply's list and code block", async ({ page }) => {
  const { source } = withMarkdownReply();
  await bootLiveEditor(page, liveInit(source));
  const body = page.locator(".thread-card .mc-card__body-md").last();
  await expect(body.locator("li")).toHaveCount(2);
  await expect(body.locator("pre code")).toBeVisible();
});

test("a comment cannot inject markup into the surface showing it", async ({ page }) => {
  const at = DOC.indexOf("retry policy");
  const hostile = addThread(DOC, at, at + 12, {
    author: "claude",
    body: '<img src=x onerror="window.__pwned=1"> <b>not bold</b>',
    ts: "2026-08-01T10:00:00.000Z",
  }).source;
  await bootLiveEditor(page, liveInit(hostile));
  const body = page.locator(".thread-card .mc-card__body-md").first();
  await expect(body.locator("img")).toHaveCount(0);
  await expect(body.locator("b")).toHaveCount(0);
  await expect(body).toContainText("not bold");
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("an image in a comment is a link, not a remote fetch", async ({ page }) => {
  const at = DOC.indexOf("retry policy");
  const withImage = addThread(DOC, at, at + 12, {
    author: "claude",
    body: "See ![the graph](https://tracker.example/pixel.png)",
    ts: "2026-08-01T10:00:00.000Z",
  }).source;
  await bootLiveEditor(page, liveInit(withImage));
  const body = page.locator(".thread-card .mc-card__body-md").first();
  await expect(body.locator("img")).toHaveCount(0);
  await expect(body.locator("a.mc-card__image-link")).toHaveText(/the graph/);
});
