// A .md opened outside every workspace folder must still be reviewable.
//
// `code notes.md`, a file dragged onto the editor, a doc that simply lives
// outside the open folders — several features asked for a
// `vscode.WorkspaceFolder` and refused when there wasn't one. The worst of
// them was adding a comment in the live editor, which failed with "File is
// outside any workspace folder" even though comments live inside the .md and
// no folder is involved at all.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(resolve(__dirname, "..", rel), "utf8");

describe("adding a comment never requires a workspace folder", () => {
  it("the live editor's addComment has no folder gate", () => {
    const provider = read("collab/collabEditorProvider.ts");
    const fn = provider.slice(provider.indexOf("private async addComment("));
    const body = fn.slice(0, fn.indexOf("\n  private "));
    expect(body).not.toContain("getWorkspaceFolder");
    expect(body).not.toContain("outside any workspace folder");
  });

  it("no surface still refuses an action because a file is loose", () => {
    // The message itself is the marker: if it comes back, some path has
    // started gating on a workspace folder again.
    for (const rel of [
      "extension.ts",
      "collab/collabEditorProvider.ts",
      "sendToClaude.ts",
      "inlineComments/sendToClaude.ts",
    ]) {
      expect(read(rel), `${rel} refuses loose files`).not.toContain(
        "outside any workspace folder",
      );
      expect(read(rel), `${rel} refuses loose files`).not.toContain(
        "must live inside a workspace folder",
      );
    }
  });

  it("the send and review paths resolve a folder instead of demanding one", () => {
    const extension = read("extension.ts");
    expect(extension).toContain("folderForDocument(");
    // Every remaining getWorkspaceFolder call must be a query, not a gate.
    const gates = extension.match(/getWorkspaceFolder\([^)]*\);\s*\n\s*if \(!folder\)/g) ?? [];
    expect(gates).toEqual([]);
  });
});

describe("folderForDocument's contract", () => {
  it("is documented as a base directory, not a claim that a workspace exists", () => {
    const src = read("workspaceFolder.ts");
    expect(src).toContain("path.dirname");
    // The stand-in must not be registered with VS Code or treated as real.
    expect(src).not.toContain("updateWorkspaceFolders");
  });
});
