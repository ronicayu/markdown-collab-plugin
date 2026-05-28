import { describe, expect, it } from "vitest";
import { detectPlatformName } from "../pr/platform";

describe("detectPlatformName", () => {
  it.each([
    ["git@github.com:owner/repo.git", "github"],
    ["https://github.com/owner/repo", "github"],
    ["git@github.acme.com:owner/repo.git", "github"],
    ["https://gitlab.com/owner/repo", "gitlab"],
    ["git@gitlab.com:owner/repo.git", "gitlab"],
    ["https://gitlab.acme.com/team/proj.git", "gitlab"],
    ["ssh://git@gitlab.example.com:2222/team/proj.git", "gitlab"],
    // Mixed case + substring anywhere in the URL still wins for GitLab.
    ["https://GITLAB.acme.com/team/proj", "gitlab"],
    ["https://code.example.org/gitlab/team/proj", "gitlab"],
  ] as const)("%s -> %s", (url, want) => {
    expect(detectPlatformName(url)).toBe(want);
  });
});
