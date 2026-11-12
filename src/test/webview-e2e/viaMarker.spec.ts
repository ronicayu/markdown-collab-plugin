// The "via tools" / "via cli" / "via file" marker on agent comments
// (round-6 P1.4), in the review view's comment sidebar.

import { expect, test } from "@playwright/test";
import { addThread, appendReply, replaceThread } from "../../inlineComments/format";
import { bootLiveEditor } from "./harness";
import { liveInit } from "./fixtures";

const TS = "2026-07-01T11:30:00.000Z";
const DOC = "# Doc\n\nSome anchored text here.\n";

/** One thread: agent comments through the tools, through mdc and through the file, then a human's. */
function docWithComments(): { source: string; id: string } {
  const at = DOC.indexOf("anchored text");
  const first = addThread(DOC, at, at + "anchored text".length, {
    author: "claude",
    agent: true,
    via: "tools",
    body: "Reworded per the style guide.",
    ts: TS,
  });
  let thread = first.thread;
  thread = appendReply(thread, { author: "codex", agent: true, via: "cli", ts: TS, body: "Applied through mdc." });
  thread = appendReply(thread, { author: "claude", agent: true, ts: TS, body: "Edited the paragraph directly." });
  thread = appendReply(thread, { author: "ronica", ts: TS, body: "Looks good, thanks." });
  return { source: replaceThread(first.source, thread.id, thread), id: thread.id };
}

let threadId = "";

test.beforeEach(async ({ page }) => {
  const { source, id } = docWithComments();
  threadId = id;
  await bootLiveEditor(page, { ...liveInit(source), readOnly: true });
});

const cards = (page: import("@playwright/test").Page) =>
  page.locator(`.thread-card[data-thread="${threadId}"] .mc-card`);

test("an agent comment written through the tools shows 'via tools'", async ({ page }) => {
  const marker = cards(page).nth(0).locator(".mc-card__via");
  await expect(marker).toHaveText("via tools");
  await expect(marker).toHaveAttribute("title", /review tools \(MCP\)/);
});

test("an agent comment written through mdc shows 'via cli'", async ({ page }) => {
  const marker = cards(page).nth(1).locator(".mc-card__via");
  await expect(marker).toHaveText("via cli");
  await expect(marker).toHaveAttribute("title", /mdc/);
});

test("an agent comment with no via field shows 'via file'", async ({ page }) => {
  const marker = cards(page).nth(2).locator(".mc-card__via");
  await expect(marker).toHaveText("via file");
  await expect(marker).toHaveAttribute("title", /directly/);
});

test("a human comment gets no via marker at all", async ({ page }) => {
  await expect(cards(page).nth(3).locator(".mc-card__via")).toHaveCount(0);
  // Exactly the three agent comments above carry the marker.
  await expect(page.locator(`.thread-card[data-thread="${threadId}"] .mc-card__via`)).toHaveCount(3);
});
