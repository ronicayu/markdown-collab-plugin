// Tests for the extension-side drawio-read handler. We run the static
// helper that backs `handleDrawioRead`, injecting an in-memory file
// reader so the test stays independent of the VS Code workspace API.
//
// What we pin here:
//   - File outside the workspace (no workspaceRoot) → friendly error.
//   - Resolver rejects → response carries the reason mapped to a
//     human-readable error string.
//   - Reader rejects → response includes the reader's error message.
//   - Happy path → ok=true with the file's content verbatim.
//   - The requestId from the request is echoed back unchanged so the
//     webview can correlate.

import { describe, expect, it } from "vitest";
import { CollabEditorProvider } from "../collab/collabEditorProvider";

describe("runDrawioRead", () => {
  const REQ_ID = "req-1";
  const ROOT = "/work/repo";
  const DOC = "/work/repo/docs/spec.md";

  it("returns ok with file contents on the happy path", async () => {
    const seenPaths: string[] = [];
    const result = await CollabEditorProvider.runDrawioRead(
      REQ_ID,
      "flow.drawio",
      DOC,
      ROOT,
      async (abs) => {
        seenPaths.push(abs);
        return "<mxfile><diagram>x</diagram></mxfile>";
      },
    );
    expect(result.type).toBe("drawio-read-result");
    expect(result.requestId).toBe(REQ_ID);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("<mxfile><diagram>x</diagram></mxfile>");
    expect(seenPaths).toEqual(["/work/repo/docs/flow.drawio"]);
  });

  it("returns error when the markdown file is outside any workspace folder", async () => {
    const result = await CollabEditorProvider.runDrawioRead(
      REQ_ID,
      "flow.drawio",
      DOC,
      null,
      async () => {
        throw new Error("should not be called");
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside any workspace folder/);
  });

  it("returns error when the href has the wrong extension", async () => {
    const result = await CollabEditorProvider.runDrawioRead(
      REQ_ID,
      "readme.md",
      DOC,
      ROOT,
      async () => {
        throw new Error("should not be called");
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/\.drawio/);
  });

  it("returns error when the href escapes the workspace root", async () => {
    const result = await CollabEditorProvider.runDrawioRead(
      REQ_ID,
      "../../outside.drawio",
      DOC,
      ROOT,
      async () => {
        throw new Error("should not be called");
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the workspace/);
  });

  it("returns error when the href has a scheme", async () => {
    const result = await CollabEditorProvider.runDrawioRead(
      REQ_ID,
      "http://example.com/x.drawio",
      DOC,
      ROOT,
      async () => {
        throw new Error("should not be called");
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/workspace-relative/);
  });

  it("returns error when the reader throws", async () => {
    const logs: string[] = [];
    const result = await CollabEditorProvider.runDrawioRead(
      REQ_ID,
      "flow.drawio",
      DOC,
      ROOT,
      async () => {
        throw new Error("ENOENT");
      },
      (line) => logs.push(line),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not read flow\.drawio/);
    expect(result.error).toMatch(/ENOENT/);
    // Log line should mention the resolved absolute path so operators
    // can find the bad reference quickly.
    expect(logs.some((l) => l.includes("/work/repo/docs/flow.drawio"))).toBe(true);
  });
});
