// The release pipeline's rules, asserted against the workflow file itself
// (10x-plan-2 P2.2).
//
// This is the one part of the system with no runtime and no unit under test: it
// is YAML that runs once per tag, in an environment nobody has locally, doing
// the single most irreversible thing the project does — publishing publicly. So
// the invariants are checked as text, and the checklist script is executed for
// real against known inputs.

import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const release = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
const ci = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("publishing is gated", () => {
  // The rule Ronica set: a tag publishes publicly unless it says otherwise, and
  // nothing publishes without her go-ahead. These assertions are the guardrail.
  it("only publishes from a v-tag, never from a branch push or a dry run", () => {
    const publishSteps = release.split("- name:").filter((s) => s.includes("vsce publish") || s.includes("ovsx publish"));
    expect(publishSteps.length).toBe(2);
    for (const step of publishSteps) {
      expect(step).toContain("startsWith(github.ref, 'refs/tags/v')");
      expect(step).toContain("inputs.dry_run != true");
      expect(step).toContain("steps.gate.outputs.publish == 'true'");
    }
  });

  it("honours [skip-publish] in the release commit", () => {
    expect(release).toContain("skip-publish");
    expect(release).toMatch(/publish=false/);
  });

  it("requires a PAT to be configured — an unset secret publishes nothing", () => {
    expect(release).toContain("env.VSCE_PAT != ''");
    expect(release).toContain("env.OVSX_PAT != ''");
  });
});

describe("the pre-release channel", () => {
  it("passes --pre-release to both marketplaces when the commit asks for it", () => {
    expect(release).toContain("pre-release");
    const preFlags = release.match(/steps\.gate\.outputs\.channel == 'pre-release' && '--pre-release'/g);
    // Three: package, plus the two publishes.
    expect(preFlags).toHaveLength(3);
  });

  // The v0.34.82 attempt failed here, on the first real use of the channel:
  // vsce refuses to publish a pre-release built from a package that was not
  // itself marked as one. The flag has to be set at package time, which means
  // the gate must run before packaging — an ordering nothing was asserting.
  it("packages as a pre-release, not just publishes as one", () => {
    const pkg = release.slice(release.indexOf("- name: Package"));
    const step = pkg.slice(0, pkg.indexOf("- name:", 1));
    expect(step).toContain("vsce package");
    expect(step).toContain("--pre-release");
  });

  it("decides the channel before it builds the package", () => {
    // Order matters and is invisible to any other check: with the gate after
    // Package, `steps.gate.outputs.channel` is empty while the vsix is built,
    // so the flag silently evaluates to "".
    expect(release.indexOf("id: gate")).toBeLessThan(release.indexOf("- name: Package"));
  });

  it("marks the GitHub release as a prerelease too, so the channels agree", () => {
    expect(release).toContain("--prerelease");
  });

  it("defaults to stable when no marker is present", () => {
    expect(release).toContain("channel=stable");
  });
});

describe("the gates a tag must pass", () => {
  // The batch that sat unreleased did so because "is this safe to ship" had no
  // answer a machine gave. Every suite the project has now runs on the tag.
  it("runs unit, integration, and webview e2e suites", () => {
    expect(release).toContain("npm test");
    expect(release).toContain("npm run test:integration");
    expect(release).toContain("npm run test:webview");
  });

  it("verifies the packaged vsix, the same way CI does", () => {
    expect(release).toContain("verify-package.mjs");
    expect(ci).toContain("verify-package.mjs");
  });

  it("checks the tag against package.json and the CHANGELOG", () => {
    expect(release).toContain("does not match package.json version");
    expect(release).toContain("CHANGELOG.md has no");
  });

  it("runs the release checklist", () => {
    expect(release).toContain("release-checklist.mjs");
  });
});

describe("release-checklist.mjs", () => {
  const run = (version?: string): { status: number; out: string } => {
    try {
      const out = execFileSync(
        "node",
        [resolve(ROOT, "scripts/release-checklist.mjs"), ...(version ? [version] : [])],
        { encoding: "utf8", cwd: ROOT },
      );
      return { status: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { status: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("passes for the current version, which has a CHANGELOG section", () => {
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("No blocking problems found.");
  });

  it("fails when asked about a version package.json doesn't hold", () => {
    const r = run("9.9.9");
    expect(r.status).toBe(1);
    expect(r.out).toContain("version mismatch");
  });

  it("says where the tag would publish, before anything is published", () => {
    // The destination line is the one thing a human must read before tagging.
    expect(run().out).toMatch(/Destination: .+/);
  });

  it("prints what no script can check", () => {
    const out = run().out;
    expect(out).toContain("Still on the human");
    expect(out).toContain("dev-host pass");
  });
});

// Found while writing P2.2's own changelog entry: the gate matched the markers
// anywhere in the commit message, so a release commit that *described*
// `[pre-release]` in its body would have chosen the publish channel from a
// sentence of prose.
describe("markers are read from the subject line only", () => {
  it("the workflow greps the subject, not the whole message", () => {
    expect(release).toContain("git log -1 --pretty=%s");
    expect(release).not.toContain("git log -1 --pretty=%B");
  });

  it("the checklist does the same", () => {
    const script = readFileSync(resolve(ROOT, "scripts/release-checklist.mjs"), "utf8");
    expect(script).toContain('"--pretty=%s"');
    expect(script).not.toContain('"--pretty=%B"');
  });
});
