/**
 * Parser coverage for the PR-review diff helpers. These are the bits
 * most likely to break on platform differences (renames, hunk header
 * variants, deletion-only hunks), so they get explicit fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  lineInRanges,
  parseNameStatus,
  parseRemoteUrl,
  parseUnifiedHunkRanges,
} from "../pr/diff";

describe("parseNameStatus", () => {
  it("parses A / M / R entries and skips D", () => {
    const stdout = [
      "A\tnew/added.md",
      "M\tdocs/changed.md",
      "R100\told/path.md\tnew/path.md",
      "D\tgone.md",
      "T\tdocs/typechange.md",
    ].join("\n");
    const got = parseNameStatus(stdout);
    expect(got).toEqual([
      { path: "new/added.md", status: "A" },
      { path: "docs/changed.md", status: "M" },
      { path: "new/path.md", status: "R", oldPath: "old/path.md" },
    ]);
  });

  it("ignores blank lines and trailing whitespace", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("\n\n")).toEqual([]);
    expect(parseNameStatus("M\tfoo.md\n")).toEqual([{ path: "foo.md", status: "M" }]);
  });

  it("handles R with score variants (R, R50, R100)", () => {
    const stdout = ["R\tfrom.md\tto.md", "R50\ta.md\tb.md", "R100\tx.md\ty.md"].join("\n");
    expect(parseNameStatus(stdout)).toEqual([
      { path: "to.md", status: "R", oldPath: "from.md" },
      { path: "b.md", status: "R", oldPath: "a.md" },
      { path: "y.md", status: "R", oldPath: "x.md" },
    ]);
  });
});

describe("parseUnifiedHunkRanges", () => {
  it("parses standard hunks with count", () => {
    const out = [
      "@@ -1,3 +1,4 @@ heading",
      " context",
      "+added",
      "@@ -10,0 +20,2 @@",
      "+line",
      "+line",
    ].join("\n");
    expect(parseUnifiedHunkRanges(out)).toEqual([
      { start: 1, end: 4 },
      { start: 20, end: 21 },
    ]);
  });

  it("defaults count to 1 when omitted", () => {
    expect(parseUnifiedHunkRanges("@@ -5 +9 @@")).toEqual([{ start: 9, end: 9 }]);
  });

  it("skips deletion-only hunks (count=0 on the +)", () => {
    const out = ["@@ -10,2 +9,0 @@", " ignored"].join("\n");
    expect(parseUnifiedHunkRanges(out)).toEqual([]);
  });

  it("returns empty for output without hunk headers", () => {
    expect(parseUnifiedHunkRanges("")).toEqual([]);
    expect(parseUnifiedHunkRanges("diff --git a/x b/x\nindex abc..def 100644\n")).toEqual([]);
  });
});

describe("lineInRanges", () => {
  const ranges = [
    { start: 1, end: 5 },
    { start: 10, end: 10 },
    { start: 20, end: 30 },
  ];
  it.each([
    [1, true],
    [3, true],
    [5, true],
    [6, false],
    [10, true],
    [11, false],
    [25, true],
    [31, false],
  ])("line %i -> %s", (line, expected) => {
    expect(lineInRanges(line, ranges)).toBe(expected);
  });
});

describe("parseRemoteUrl", () => {
  it.each([
    ["git@github.com:owner/repo.git", { host: "github.com", owner: "owner", repo: "repo" }],
    ["git@gitlab.com:group/sub/repo.git", { host: "gitlab.com", owner: "group/sub", repo: "repo" }],
    ["https://github.com/owner/repo", { host: "github.com", owner: "owner", repo: "repo" }],
    ["https://gitlab.acme.com/team/proj.git", { host: "gitlab.acme.com", owner: "team", repo: "proj" }],
    ["ssh://git@gitlab.example.com:2222/team/proj.git", {
      host: "gitlab.example.com:2222",
      owner: "team",
      repo: "proj",
    }],
  ])("%s", (url, want) => {
    expect(parseRemoteUrl(url)).toEqual(want);
  });

  it("returns null for nonsense", () => {
    expect(parseRemoteUrl("not a url")).toBeNull();
    expect(parseRemoteUrl("")).toBeNull();
  });
});
