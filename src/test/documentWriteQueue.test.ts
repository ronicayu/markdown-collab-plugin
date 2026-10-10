// The per-document write queue: writes land one at a time, each computed on
// the text as it is when its turn comes, and a write refused because the
// document moved underneath it is recomputed rather than lost or forced.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConflictError, exclusive, mutateDocument } from "../collab/documentWriteQueue";

vi.mock("vscode", async (importOriginal) => {
  const stub = await importOriginal<typeof import("./vscode-stub")>();
  class WorkspaceEdit {
    readonly replacements: Array<{ range: vscode.Range; text: string }> = [];
    replace(_uri: unknown, range: vscode.Range, text: string): void {
      this.replacements.push({ range, text });
    }
  }
  return { ...stub, WorkspaceEdit };
});

/** A document over a string; offsets and positions agree. */
class FakeDocument {
  isDirty = false;
  saves = 0;
  constructor(public text: string) {}
  getText(): string {
    return this.text;
  }
  positionAt(offset: number): vscode.Position {
    const before = this.text.slice(0, offset);
    const line = before.split("\n").length - 1;
    return new vscode.Position(line, offset - (before.lastIndexOf("\n") + 1));
  }
  offsetAt(pos: vscode.Position): number {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += lines[i]!.length + 1;
    return offset + pos.character;
  }
  async save(): Promise<boolean> {
    this.saves++;
    this.isDirty = false;
    return true;
  }
}

const ws = vscode.workspace as unknown as Record<string, unknown>;
let docs: Map<string, FakeDocument>;
/** Edits to refuse before applying again, as VS Code does when the version moved. */
let refuseNext: number;
/** Runs during the renderer round trip, before the edit lands: another writer. */
let duringApply: (() => void) | null;

const uriOf = (name: string): vscode.Uri => vscode.Uri.file(`/w/${name}`);

beforeEach(() => {
  docs = new Map();
  refuseNext = 0;
  duringApply = null;
  ws.openTextDocument = async (uri: vscode.Uri) => docs.get(uri.toString());
  ws.applyEdit = async (edit: { replacements: Array<{ range: vscode.Range; text: string }> }) => {
    const doc = [...docs.values()][0]!;
    // Capture the edit's ranges against the text it was built for.
    const ranges = edit.replacements.map(({ range, text }) => ({
      start: doc.offsetAt(range.start),
      end: doc.offsetAt(range.end),
      text,
    }));
    await new Promise((r) => setTimeout(r, 1));
    if (duringApply) {
      duringApply();
      duringApply = null;
    }
    if (refuseNext > 0) {
      refuseNext--;
      return false;
    }
    for (const { start, end, text } of ranges) doc.text = doc.text.slice(0, start) + text + doc.text.slice(end);
    doc.isDirty = true;
    return true;
  };
});

function open(name: string, text: string): vscode.Uri {
  const uri = uriOf(name);
  docs.set(uri.toString(), new FakeDocument(text));
  return uri;
}

const append = (suffix: string) => (source: string) => ({ next: source + suffix, result: suffix });

describe("mutateDocument", () => {
  it("lands two writes queued in the same tick, each on the text the other left", async () => {
    const uri = open("a.md", "start");
    const results = await Promise.all([mutateDocument(uri, append(" one")), mutateDocument(uri, append(" two"))]);
    expect(results).toEqual([" one", " two"]);
    expect(docs.get(uri.toString())!.text).toBe("start one two");
  });

  it("computes each write when its turn comes, not when it was queued", async () => {
    const uri = open("a.md", "v1");
    const seen: string[] = [];
    await Promise.all([
      mutateDocument(uri, (s) => ({ next: "v2", result: s })),
      mutateDocument(uri, (s) => {
        seen.push(s);
        return { next: `${s}+`, result: s };
      }),
    ]);
    expect(seen).toEqual(["v2"]);
    expect(docs.get(uri.toString())!.text).toBe("v2+");
  });

  it("recomputes a refused edit on the newer text instead of overwriting it", async () => {
    const uri = open("a.md", "Hello.");
    const doc = docs.get(uri.toString())!;
    // A human types in the text editor while the edit is in flight; VS Code
    // refuses the edit because the version moved.
    duringApply = () => {
      doc.text = "Hello, world.";
    };
    refuseNext = 1;
    const calls: string[] = [];
    await mutateDocument(uri, (s) => {
      calls.push(s);
      return { next: `${s} [reply]`, result: null };
    });
    expect(calls).toEqual(["Hello.", "Hello, world."]);
    expect(doc.text).toBe("Hello, world. [reply]");
  });

  it("gives up with a ConflictError after the attempts run out, writing nothing", async () => {
    const uri = open("a.md", "same");
    refuseNext = 3;
    await expect(mutateDocument(uri, append("!"))).rejects.toBeInstanceOf(ConflictError);
    expect(docs.get(uri.toString())!.text).toBe("same");
  });

  it("does nothing, and doesn't save, when the mutation has nothing to do", async () => {
    const uri = open("a.md", "x");
    expect(await mutateDocument(uri, () => null, { save: true })).toBeNull();
    expect(await mutateDocument(uri, (s) => ({ next: s, result: "same" }), { save: true })).toBe("same");
    expect(docs.get(uri.toString())!.saves).toBe(0);
  });

  it("saves after the edit when asked", async () => {
    const uri = open("a.md", "x");
    await mutateDocument(uri, append("y"), { save: true });
    const doc = docs.get(uri.toString())!;
    expect(doc.saves).toBe(1);
    expect(doc.isDirty).toBe(false);
  });

  it("leaves the document untouched and the queue running when a mutation throws", async () => {
    const uri = open("a.md", "x");
    const failed = mutateDocument(uri, () => {
      throw new Error("refused");
    });
    const after = mutateDocument(uri, append("y"));
    await expect(failed).rejects.toThrow("refused");
    expect(await after).toBe("y");
    expect(docs.get(uri.toString())!.text).toBe("xy");
  });
});

describe("exclusive", () => {
  it("runs jobs for one document in the order they were queued, mutations included", async () => {
    const uri = open("a.md", "");
    const order: string[] = [];
    const slow = (name: string) => () =>
      new Promise<void>((r) =>
        setTimeout(() => {
          order.push(name);
          r();
        }, 5),
      );
    await Promise.all([
      exclusive(uri, slow("panel edit")),
      mutateDocument(uri, (s) => {
        order.push("tool call");
        return { next: `${s}t`, result: null };
      }),
      exclusive(uri, slow("autosave")),
    ]);
    expect(order).toEqual(["panel edit", "tool call", "autosave"]);
  });

  it("doesn't make one document wait for another", async () => {
    const a = uriOf("a.md");
    const b = uriOf("b.md");
    const order: string[] = [];
    let releaseA!: () => void;
    const blockedA = exclusive(a, () => new Promise<void>((r) => (releaseA = r)).then(() => void order.push("a")));
    await exclusive(b, async () => void order.push("b"));
    releaseA();
    await blockedA;
    expect(order).toEqual(["b", "a"]);
  });
});
