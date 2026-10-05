import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
const trust = pkg.capabilities.untrustedWorkspaces;
const properties = Object.keys(pkg.contributes.configuration.properties);
const views = pkg.contributes.views.explorer as Array<{ id: string; when?: string }>;
const palette = pkg.contributes.menus.commandPalette as Array<{ command: string; when: string }>;
const steps = pkg.contributes.walkthroughs[0].steps as Array<{ id: string; when?: string }>;

describe("the Restricted Mode manifest", () => {
  it("declares limited support with a description", () => {
    expect(trust.supported).toBe("limited");
    expect(trust.description.length).toBeGreaterThan(0);
  });

  it("lists only settings that exist", () => {
    expect(trust.restrictedConfigurations.length).toBeGreaterThan(0);
    for (const key of trust.restrictedConfigurations) expect(properties).toContain(key);
  });

  it("restricts every setting that reaches a process, a fetched URL or the author name", () => {
    expect(trust.restrictedConfigurations).toEqual(
      expect.arrayContaining([
        "markdownCollab.claudePath",
        "markdownCollab.headlessModel",
        "markdownCollab.sendMode",
        "markdownCollab.plantuml.serverUrl",
        "markdownCollab.plantuml.format",
      ]),
    );
  });

  it("hides both git views until the workspace is trusted", () => {
    for (const id of ["markdownCollab.prReviewFiles", "markdownCollab.uncommittedFiles"]) {
      expect(views.find((v) => v.id === id)?.when).toContain("isWorkspaceTrusted");
    }
  });

  it("hides connect, disconnect, the git views' open commands, the playground and the conventions editor from the palette until trusted", () => {
    for (const command of [
      "markdownCollab.connectAgent",
      "markdownCollab.disconnectAgent",
      "markdownCollab.startPrReview",
      "markdownCollab.reviewUncommittedChanges",
      "markdownCollab.openTutorial",
      "markdownCollab.editReviewConventions",
    ]) {
      expect(palette.find((e) => e.command === command)?.when).toContain("isWorkspaceTrusted");
    }
  });

  it("hides the walkthrough steps that run setup or write the playground until trusted", () => {
    for (const id of ["playground", "connect-agent"]) {
      expect(steps.find((s) => s.id === id)?.when).toBe("isWorkspaceTrusted");
    }
  });

  it("leaves Send and Ask Agent to Review visible", () => {
    for (const command of ["markdownCollab.sendAllToClaude", "markdownCollab.askClaudeToReview"]) {
      expect(palette.find((e) => e.command === command)?.when).not.toBe("false");
    }
  });
});
