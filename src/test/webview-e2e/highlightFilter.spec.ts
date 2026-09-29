// The live editor's highlights follow the sidebar's filter, as the review
// view's do: a thread the list doesn't show paints nothing in the document,
// and a resolved one it does show is greyed. Both decoration builders — edit
// mode's text search and read-only's source positions — go through the same
// rule.

import { expect, test } from "@playwright/test";
import { bootLiveEditor } from "./harness";
import { liveInit, reviewFixture } from "./fixtures";
import { setThreadResolved } from "../../collab/inlineBridge";

for (const readOnly of [true, false]) {
  test(`highlights follow the thread filter (${readOnly ? "read-only" : "edit"} mode)`, async ({ page }) => {
    const fixture = reviewFixture();
    const source = setThreadResolved(fixture.source, fixture.answeredThreadId, true, "ronica", "2026-09-29T00:00:00.000Z")!;
    await bootLiveEditor(page, { ...liveInit(source), readOnly });
    const open = page.locator(`.mdc-anchor-highlight[data-comment-id="${fixture.openThreadId}"]`);
    const resolved = page.locator(`.mdc-anchor-highlight[data-comment-id="${fixture.answeredThreadId}"]`);

    // Open (the default): only the open thread.
    await expect(open).toHaveCount(1);
    await expect(resolved).toHaveCount(0);

    await page.locator('input[name="filter"][value="resolved"]').click();
    await expect(open).toHaveCount(0);
    await expect(resolved).toHaveCount(1);
    await expect(resolved).toHaveClass(/mdc-anchor-highlight--resolved/);

    await page.locator('input[name="filter"][value="all"]').click();
    await expect(open).toHaveCount(1);
    await expect(open).not.toHaveClass(/mdc-anchor-highlight--resolved/);
    await expect(resolved).toHaveCount(1);
  });
}
