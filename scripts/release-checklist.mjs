#!/usr/bin/env node
// Release readiness, checked where a machine can and printed where it can't
// (10x-plan-2 P2.2).
//
// The gate that actually held releases up was never a failing test — it was the
// list of things someone had to remember: is the CHANGELOG written, does the tag
// match, did anyone click through the accept button this month. Everything on
// that list which a script can decide is decided here, and what remains is
// printed rather than left in someone's head.
//
// Usage:
//   node scripts/release-checklist.mjs            # check HEAD's version
//   node scripts/release-checklist.mjs 0.34.67    # check a specific version
//
// Exits non-zero when a hard requirement is missing.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const problems = [];
const notes = [];

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = process.argv[2] ?? pkg.version;

if (version !== pkg.version) {
  problems.push(
    `version mismatch: asked to release ${version} but package.json says ${pkg.version}`,
  );
}

// --- CHANGELOG -------------------------------------------------------------
let changelog = "";
try {
  changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
} catch {
  problems.push("CHANGELOG.md is missing");
}

const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}( |$)`, "m");
if (changelog && !heading.test(changelog)) {
  problems.push(`CHANGELOG.md has no "## ${version}" section`);
}

// The section has to say something. A heading with nothing under it is the
// shape a rushed release takes, and it is exactly when notes matter most.
if (changelog && heading.test(changelog)) {
  const body = changelog
    .slice(changelog.search(heading))
    .split("\n")
    .slice(1);
  const end = body.findIndex((line) => line.startsWith("## "));
  const section = (end === -1 ? body : body.slice(0, end)).join("\n").trim();
  if (section.length < 40) {
    problems.push(`the CHANGELOG section for ${version} is empty or near-empty`);
  }
}

// --- git state -------------------------------------------------------------
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const message = git("log", "-1", "--pretty=%B");
const isSkipPublish = /\[skip-publish\]/.test(message);
const isPreRelease = /\[pre-release\]/.test(message);

if (isSkipPublish && isPreRelease) {
  problems.push("the release commit says both [skip-publish] and [pre-release] — pick one");
}

// --- what this tag will actually do ---------------------------------------
const destination = isSkipPublish
  ? "GitHub Release only (no marketplace publish)"
  : isPreRelease
    ? "PUBLIC pre-release on VS Code Marketplace + Open VSX"
    : "PUBLIC stable release on VS Code Marketplace + Open VSX";

// --- the part no script can check -----------------------------------------
notes.push(
  "Automated gates that must be green before a tag: unit tests, integration tests,",
  "webview e2e, and `verify-package` on the built .vsix. The release workflow runs all four.",
  "",
  "Still on the human:",
  "  - Does the CHANGELOG say what a user would want to know, not just what changed?",
  "  - Anything in this batch that only a dev-host pass can see — explorer right-click menus,",
  "    the skill install flow, a real Claude session end to end?",
  "  - For a stable release: has this build been dogfooded as a pre-release first?",
);

const line = "─".repeat(72);
console.log(line);
console.log(`Release checklist — v${version}`);
console.log(line);
console.log(`Destination: ${destination}`);
console.log("");

if (problems.length > 0) {
  for (const p of problems) console.log(`  ✘ ${p}`);
  console.log("");
}
console.log(notes.join("\n"));
console.log(line);

if (problems.length > 0) {
  console.error(`release-checklist: ${problems.length} problem(s) — fix them before tagging.`);
  process.exit(1);
}
console.log("No blocking problems found.");
