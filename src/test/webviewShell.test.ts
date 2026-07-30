import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { inlineCommentsAppBody } from "../inlineComments/webviewShell";

const clientSource = fs.readFileSync(
  path.resolve(__dirname, "../inlineComments/webview/client.ts"),
  "utf8",
);
const panelSource = fs.readFileSync(
  path.resolve(__dirname, "../inlineComments/inlineCommentsPanel.ts"),
  "utf8",
);

/** Every id the inline-comments client resolves at module load. */
function idsRequiredByClient(): string[] {
  const out = new Set<string>();
  for (const m of clientSource.matchAll(/document\.getElementById\("([^"]+)"\)/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

describe("inlineCommentsAppBody", () => {
  const body = inlineCommentsAppBody();

  // The client casts every lookup (`as HTMLElement`), so a missing element is a
  // null that only explodes at the first click. This is the check that would
  // have caught a rename during the shell's extraction out of the panel.
  it("provides every element the client looks up by id", () => {
    const ids = idsRequiredByClient();
    expect(ids.length).toBeGreaterThan(20);
    const missing = ids.filter((id) => !body.includes(`id="${id}"`));
    expect(missing, `shell is missing elements the client requires`).toEqual([]);
  });

  it("provides the filter radios the client queries by name", () => {
    expect(clientSource).toContain(`querySelectorAll<HTMLInputElement>('input[name="filter"]')`);
    for (const value of ["open", "all", "resolved", "claude-unread"]) {
      expect(body).toContain(`name="filter" value="${value}"`);
    }
  });

  // The panel and the webview e2e harness must serve the SAME skeleton, or the
  // suite passes against markup no user ever sees. Enforced by the panel having
  // no `<div id="app">` of its own.
  it("is the panel's only source of the app skeleton", () => {
    expect(panelSource).toContain("${inlineCommentsAppBody()}");
    expect(panelSource).not.toContain(`<div id="app">`);
  });
});
