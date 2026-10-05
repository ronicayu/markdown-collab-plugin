import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { currentAuthorName } from "../authorName";

const userInfo = vi.hoisted(() => vi.fn());

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, userInfo };
});

function setting(value: string) {
  (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key === "collab.userName" ? value : fallback),
  });
}

beforeEach(() => {
  userInfo.mockReset();
  userInfo.mockReturnValue({ username: "osuser" });
});

describe("currentAuthorName", () => {
  it("uses the collab.userName setting when it is set", () => {
    setting("ronica");
    expect(currentAuthorName()).toBe("ronica");
  });

  it("falls back to the OS username when the setting is empty", () => {
    setting("");
    expect(currentAuthorName()).toBe("osuser");
  });

  it("treats a whitespace-only setting as empty", () => {
    setting("   ");
    expect(currentAuthorName()).toBe("osuser");
  });

  it("falls back to anonymous when the OS has no user entry", () => {
    setting("");
    userInfo.mockImplementation(() => {
      throw new Error("ENOENT: no passwd entry for uid 4242");
    });
    expect(currentAuthorName()).toBe("anonymous");
  });

  it("falls back to anonymous when the OS username is empty", () => {
    setting("");
    userInfo.mockReturnValue({ username: "" });
    expect(currentAuthorName()).toBe("anonymous");
  });
});
