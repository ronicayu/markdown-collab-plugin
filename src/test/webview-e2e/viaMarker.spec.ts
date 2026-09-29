// The "via tools" / "via cli" / "via file" marker on agent comments
// (round-6 P1.4). Built from a hand-written wire payload rather than
// `format.ts`'s helpers: the `via` field is new on the comment JSON, landing
// on the host side independently of this webview-only test.

import { expect, test } from "@playwright/test";
import { bootInlineView } from "./harness";

const TS = "2026-07-01T11:30:00.000Z";

function stateWithComments(): Record<string, unknown> {
  return {
    prose: "# Doc\n\nSome anchored text here.\n",
    threads: [
      {
        id: "t0001",
        quote: "anchored text",
        status: "open",
        // Unanchored on purpose — this spec only cares about the comment
        // cards, not the preview highlight, so there's no offset math to
        // get right.
        anchor: null,
        comments: [
          { id: "c1", author: "claude", agent: true, via: "tools", ts: TS, body: "Reworded per the style guide." },
          { id: "c2", author: "codex", agent: true, via: "cli", ts: TS, body: "Applied through mdc." },
          { id: "c3", author: "claude", agent: true, ts: TS, body: "Edited the paragraph directly." },
          { id: "c4", author: "ronica", ts: TS, body: "Looks good, thanks." },
        ],
      },
    ],
    suggestions: [],
  };
}

test.beforeEach(async ({ page }) => {
  await bootInlineView(page, {
    fileName: "doc.md",
    state: stateWithComments(),
    user: { name: "ronica" },
    imageBaseUris: { docDir: "", workspaceFolder: null },
  });
});

test("an agent comment written through the tools shows 'via tools'", async ({ page }) => {
  const marker = page.locator('[data-thread="t0001"] .mc-card').nth(0).locator(".mc-card__via");
  await expect(marker).toHaveText("via tools");
  await expect(marker).toHaveAttribute("title", /review tools \(MCP\)/);
});

test("an agent comment written through mdc shows 'via cli'", async ({ page }) => {
  const marker = page.locator('[data-thread="t0001"] .mc-card').nth(1).locator(".mc-card__via");
  await expect(marker).toHaveText("via cli");
  await expect(marker).toHaveAttribute("title", /mdc/);
});

test("an agent comment with no via field shows 'via file'", async ({ page }) => {
  const marker = page.locator('[data-thread="t0001"] .mc-card').nth(2).locator(".mc-card__via");
  await expect(marker).toHaveText("via file");
  await expect(marker).toHaveAttribute("title", /directly/);
});

test("a human comment gets no via marker at all", async ({ page }) => {
  const card = page.locator('[data-thread="t0001"] .mc-card').nth(3);
  await expect(card.locator(".mc-card__via")).toHaveCount(0);
  // Exactly the three agent comments above carry the marker.
  await expect(page.locator('[data-thread="t0001"] .mc-card__via')).toHaveCount(3);
});
