// The UI labels follow `markdownCollab.agentName`: the host ships the name in
// its state messages and both webviews relabel from it. The default wording
// ("Claude") is covered by every other spec; these use a different agent.

import { expect, test } from "@playwright/test";
import { awaitPosted, bootInlineView, bootLiveEditor, pushToWebview } from "./harness";
import { inlineInit, liveInit, liveSidecar, reviewFixture } from "./fixtures";

const fixture = reviewFixture();

test("inline view: buttons, filter and thread actions use the configured name", async ({ page }) => {
  await bootInlineView(page, { ...inlineInit(fixture.source), agentName: "Codex" });

  await expect(page.locator("#send-to-claude")).toHaveText("Send to Codex");
  await expect(page.locator("#filter-claude-text")).toHaveText("New from Codex");
  await expect(page.locator("#suggest-mode-toggle")).toHaveAttribute("title", /Send to Codex asks Codex/);
  await expect(page.locator(".thread-card").first().getByRole("button", { name: "→ Codex" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Claude");

  // Renaming is only a label: the button still posts the same message.
  await page.locator("#send-to-claude").click();
  expect(await awaitPosted(page, "send-to-claude")).toEqual({ type: "send-to-claude" });
});

test("inline view: a later update renames the labels without a reload", async ({ page }) => {
  await bootInlineView(page, inlineInit(fixture.source));
  await expect(page.locator("#send-to-claude")).toHaveText("Send to Claude");

  await pushToWebview(page, {
    type: "update",
    state: inlineInit(fixture.source).state,
    agentName: "Codex",
  });

  await expect(page.locator("#send-to-claude")).toHaveText("Send to Codex");
  await expect(page.locator(".thread-card").first().getByRole("button", { name: "→ Codex" })).toBeVisible();
});

test("live editor: send button and thread action use the configured name", async ({ page }) => {
  await bootLiveEditor(page, { ...liveInit(fixture.source), agentName: "Codex" });

  await expect(page.getByRole("button", { name: "Send to Codex" })).toBeVisible();
  await expect(
    page.locator(`.mdc-comment[data-id="${fixture.openThreadId}"]`).getByRole("button", { name: "→ Codex" }),
  ).toBeVisible();
});

test("live editor: a later sidecar update renames the labels", async ({ page }) => {
  await bootLiveEditor(page, liveInit(fixture.source));
  await expect(page.getByRole("button", { name: "Send to Claude" })).toBeVisible();

  await pushToWebview(page, {
    type: "sidecar-changed",
    ...liveSidecar(fixture.source),
    agentName: "Codex",
  });

  await expect(page.getByRole("button", { name: "Send to Codex" })).toBeVisible();
});
