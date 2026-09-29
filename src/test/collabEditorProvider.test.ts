// The live editor's host, driven through its message port: a fake panel posts
// what the webview would, a fake document stands in for the TextDocument, and
// `workspace.applyEdit` takes a turn of the event loop before it lands, as
// the real one (a round trip to the renderer) does. What these pin is what no
// pure function can show: the order writes land in, what the host tells the
// person when one fails, and that the editor is never left showing text the
// file doesn't have.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as vscode from "vscode";
import { CollabEditorProvider } from "../collab/collabEditorProvider";
import { applyBlockEdits, proseOf } from "../collab/inlineBridge";
import type { BlockEdit } from "../collab/blockEdits";
import { editorBlockCount, markdownBlocks } from "../collab/sourcePositions";
import { addSuggestion, addThread, appendReply, parse, replaceThread } from "../inlineComments/format";
import { applyClientMutation } from "../inlineComments/mutations";
import type { Logger } from "../logging";
import { onlyMarkersAdded } from "./support/oneViewCorpus";

vi.mock("vscode", async (importOriginal) => {
  const stub = await importOriginal<typeof import("./vscode-stub")>();
  class WorkspaceEdit {
    readonly replacements: Array<{ range: vscode.Range; text: string }> = [];
    replace(_uri: unknown, range: vscode.Range, text: string): void {
      this.replacements.push({ range, text });
    }
  }
  return {
    ...stub,
    WorkspaceEdit,
    ViewColumn: { Active: -1, Beside: -2 },
    Uri: { ...stub.Uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => stub.Uri.file([base.fsPath, ...parts].join("/")) },
  };
});

// The seam for "the splice threw": the provider's own import of the bridge,
// passed through unless a test says otherwise.
vi.mock("../collab/inlineBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../collab/inlineBridge")>();
  return { ...actual, applyBlockEdits: vi.fn(actual.applyBlockEdits) };
});

const TS = "2026-09-30T00:00:00.000Z";
const DOC = "# Doc\n\nAlpha sentence.\n\nBeta sentence.\n";
const COULDNT_SAVE_EDIT = "Markdown Collab couldn't save your last edit — the view was reloaded from the file.";

/** A TextDocument over a string, with `positionAt`/`offsetAt` that agree. */
class FakeDocument {
  readonly uri = vscode.Uri.file("/w/notes.md");
  isDirty = false;
  /** What `save()` resolves to next, or an error it throws. */
  saveResult: boolean | Error = true;
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
    if (this.saveResult instanceof Error) throw this.saveResult;
    if (this.saveResult) this.isDirty = false;
    return this.saveResult;
  }
}

type Listener = (e: { document: FakeDocument }) => void;

type AsyncSpy = Mock<unknown[], Promise<unknown>>;

interface Harness {
  doc: FakeDocument;
  posted: Array<Record<string, unknown>>;
  send(msg: unknown): void;
  log: { [K in "trace" | "info" | "warn" | "error" | "show"]: Mock };
  shown: { error: AsyncSpy; warning: AsyncSpy; info: AsyncSpy };
  exec: AsyncSpy;
}

// Every panel a test opened, closed after it: open panels are registered by
// document, and every test's document has the same name.
const disposers: Array<() => void> = [];

let changeListeners: Listener[] = [];

async function openEditor(source: string, opts: { readOnly?: boolean } = {}): Promise<Harness> {
  const doc = new FakeDocument(source);
  changeListeners = [];
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  ws.getConfiguration = () => ({
    get: (key: string, fallback: unknown) =>
      key === "liveEditor.readOnly" ? (opts.readOnly ?? false) : key === "collab.userName" ? "ronica" : fallback,
  });
  ws.onDidChangeTextDocument = (l: Listener) => {
    changeListeners.push(l);
    return { dispose: () => undefined };
  };
  ws.onDidChangeConfiguration = () => ({ dispose: () => undefined });
  ws.applyEdit = async (edit: { replacements: Array<{ range: vscode.Range; text: string }> }) => {
    // The renderer round trip: anything the host does meanwhile sees the old text.
    await new Promise((r) => setTimeout(r, 1));
    // VS Code keeps one kind of line ending: inserted text takes the document's.
    const eol = doc.text.includes("\r\n") ? "\r\n" : "\n";
    for (const { range, text } of edit.replacements) {
      const start = doc.offsetAt(range.start);
      const end = doc.offsetAt(range.end);
      doc.text = doc.text.slice(0, start) + text.replace(/\r\n?|\n/g, eol) + doc.text.slice(end);
    }
    doc.isDirty = true;
    for (const l of changeListeners) l({ document: doc });
    return true;
  };
  const shown = {
    error: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    warning: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    info: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  };
  const win = vscode.window as unknown as Record<string, unknown>;
  win.showErrorMessage = shown.error;
  win.showWarningMessage = shown.warning;
  win.showInformationMessage = shown.info;
  const exec = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
  (vscode.commands as unknown as Record<string, unknown>).executeCommand = exec;

  const posted: Array<Record<string, unknown>> = [];
  let receive: (msg: unknown) => void = () => undefined;
  const noop = { dispose: () => undefined };
  const panel = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (u: unknown) => u,
      postMessage: async (m: Record<string, unknown>) => {
        posted.push(m);
        return true;
      },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        receive = cb;
        return noop;
      },
    },
    onDidChangeViewState: () => noop,
    onDidDispose: (cb: () => void) => {
      disposers.push(cb);
      return noop;
    },
    viewColumn: 1,
    active: true,
    visible: true,
  };
  const log = {
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
  };
  const logger = { ...log, scope: () => logger, time: <T,>(_l: string, fn: () => Promise<T>) => fn() } as unknown as Logger;
  const provider = new CollabEditorProvider(vscode.Uri.file("/ext") as vscode.Uri, logger);
  await provider.resolveCustomTextEditor(
    doc as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    {} as vscode.CancellationToken,
  );
  return { doc, posted, send: (m) => receive(m), log, shown, exec };
}

/** The editor's block types for `source` — the `baseTypes` a webview on it sends. */
function typesOf(source: string): string[] {
  const blocks = markdownBlocks(proseOf(source));
  return blocks.slice(0, editorBlockCount(blocks)).map((b) => b.type);
}

function editBlocks(source: string, epoch: number, edits: BlockEdit[]): Record<string, unknown> {
  return { type: "edit-blocks", epoch, baseTypes: typesOf(source), edits };
}

/** `source` with `edits` spliced in, as the host would — the expected file. */
function spliced(source: string, edits: BlockEdit[]): string {
  const r = applyBlockEdits(source, { baseTypes: typesOf(source), edits });
  if (!r.ok) throw new Error(r.error);
  return r.source;
}

const BETA_BANG: BlockEdit[] = [{ from: 2, to: 3, markdown: "Beta sentence!", types: ["paragraph"] }];

/** A document with a thread on "Alpha" (answered) and a suggestion on "Beta". */
function reviewed(): { source: string; threadId: string; suggestionId: string } {
  const at = DOC.indexOf("Alpha");
  const first = addThread(DOC, at, at + 5, { author: "ronica", body: "Why?", ts: TS });
  const withReply = replaceThread(
    first.source,
    first.thread.id,
    appendReply(first.thread, { author: "claude", body: "Because.", ts: TS, agent: true }),
  );
  const b = withReply.indexOf("Beta");
  const s = addSuggestion(withReply, b, b + 4, { author: "claude", proposed: "Gamma", ts: TS });
  return { source: s.source, threadId: first.thread.id, suggestionId: s.suggestion.anchorId };
}

const ofType = (h: Harness, type: string): Array<Record<string, unknown>> => h.posted.filter((m) => m.type === type);

/** Wait on real timers — `vi.waitFor` would advance a faked clock, and with it the comments' timestamps. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  vi.mocked(applyBlockEdits).mockClear();
  vi.useRealTimers();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("a block edit that throws", () => {
  it("re-renders the editor from the file under a new epoch, and says so with the log a click away", async () => {
    const h = await openEditor(DOC);
    h.shown.error.mockResolvedValueOnce("Show Logs");
    vi.mocked(applyBlockEdits).mockImplementationOnce(() => {
      throw new Error("splice exploded");
    });
    h.send(editBlocks(DOC, 0, BETA_BANG));
    await vi.waitFor(() => expect(ofType(h, "externalChange")).toHaveLength(1));
    const [rerender] = ofType(h, "externalChange");
    expect(rerender).toMatchObject({ text: proseOf(DOC), epoch: 1, toast: COULDNT_SAVE_EDIT });
    expect(h.doc.text).toBe(DOC);
    expect(h.shown.error).toHaveBeenCalledWith(COULDNT_SAVE_EDIT, "Show Logs");
    expect(h.log.error).toHaveBeenCalledWith(expect.stringContaining("edit"), expect.any(Error));
    await vi.waitFor(() => expect(h.log.show).toHaveBeenCalled());

    // An edit the webview made before it took the re-render isn't spliced in…
    h.send(editBlocks(DOC, 0, BETA_BANG));
    await vi.waitFor(() => expect(ofType(h, "externalChange")).toHaveLength(2));
    expect(h.doc.text).toBe(DOC);
    // …and the queue isn't wedged: the next edit, on the latest re-render, lands.
    const alpha: BlockEdit[] = [{ from: 1, to: 2, markdown: "Alpha sentence?", types: ["paragraph"] }];
    h.send(editBlocks(DOC, ofType(h, "externalChange")[1]!.epoch as number, alpha));
    await vi.waitFor(() => expect(h.doc.text).toBe(spliced(DOC, alpha)));
  });

  it("a diff the webview couldn't make is recovered the same way", async () => {
    const h = await openEditor(DOC);
    h.send({ type: "webview-error", stage: "edit-blocks", message: "TypeError: serializer" });
    await vi.waitFor(() => expect(ofType(h, "externalChange")).toHaveLength(1));
    expect(ofType(h, "externalChange")[0]).toMatchObject({ text: proseOf(DOC), epoch: 1, toast: COULDNT_SAVE_EDIT });
    expect(h.shown.error).toHaveBeenCalledWith(COULDNT_SAVE_EDIT, "Show Logs");
  });
});

describe("epochs: an edit made on text the editor no longer shows", () => {
  it("is never dropped silently: the editor is re-rendered from the file with a new epoch, and told why", async () => {
    const h = await openEditor(DOC);
    h.send({ type: "ready" });
    await vi.waitFor(() => expect(ofType(h, "init")).toHaveLength(1));
    expect(ofType(h, "init")[0]!.epoch).toBe(1);
    // Someone else changes the file: the editor is sent it at epoch 2…
    h.doc.text = DOC.replace("Alpha", "Omega");
    for (const l of changeListeners) l({ document: h.doc });
    expect(ofType(h, "externalChange").at(-1)).toMatchObject({ epoch: 2 });
    // …while an edit made on epoch 1 is on its way.
    h.send(editBlocks(DOC, 1, BETA_BANG));
    await vi.waitFor(() => expect(ofType(h, "externalChange")).toHaveLength(2));
    expect(ofType(h, "externalChange")[1]).toMatchObject({
      epoch: 3,
      text: proseOf(h.doc.text),
      toast: expect.stringContaining("wasn't saved"),
    });
    expect(h.doc.text).toBe(DOC.replace("Alpha", "Omega"));
  });

  it("made just before a switch to Reading, on the text the switch re-sent, is written and shown", async () => {
    const h = await openEditor(DOC);
    h.send({ type: "ready" });
    await vi.waitFor(() => expect(ofType(h, "init")).toHaveLength(1));
    h.send({ type: "set-read-only", readOnly: true });
    await vi.waitFor(() => expect(ofType(h, "init")).toHaveLength(2));
    expect(ofType(h, "init")[1]).toMatchObject({ readOnly: true, epoch: 2 });
    // Typed while the switch was on its way, flushed by the webview as it rebuilt.
    h.send(editBlocks(DOC, 1, BETA_BANG));
    await vi.waitFor(() => expect(h.doc.text).toBe(spliced(DOC, BETA_BANG)));
    await vi.waitFor(() => expect(ofType(h, "externalChange")).toHaveLength(1));
    expect(ofType(h, "externalChange")[0]).toMatchObject({ text: proseOf(h.doc.text), epoch: 3, quiet: true });
  });

  it("a read-only editor's own edit is still refused", async () => {
    const h = await openEditor(DOC, { readOnly: true });
    h.send(editBlocks(DOC, 0, BETA_BANG));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.doc.text).toBe(DOC);
  });

  it("a save that rewrites the prose (format-on-save) sends the editor the saved text under a new epoch", async () => {
    const h = await openEditor(DOC);
    const save = h.doc.save.bind(h.doc);
    h.doc.save = async () => {
      // A save participant appends a line while the echo guard is up.
      h.doc.text += "\nFormatted.\n";
      for (const l of changeListeners) l({ document: h.doc });
      return save();
    };
    h.send(editBlocks(DOC, 0, BETA_BANG));
    h.send({ type: "send-to-claude" });
    await vi.waitFor(() => expect(ofType(h, "send-result")).toHaveLength(1));
    const pushed = ofType(h, "externalChange");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ text: proseOf(h.doc.text), epoch: 1 });
    expect(pushed[0]!.text).toContain("Formatted.");
    // An edit made before the editor took it is refused, not spliced into the new text.
    h.send(editBlocks(DOC, 0, [{ from: 1, to: 2, markdown: "Alpha?", types: ["paragraph"] }]));
    await vi.waitFor(() => expect(ofType(h, "externalChange")).toHaveLength(2));
    expect(proseOf(h.doc.text)).not.toContain("Alpha?");
  });
});

describe("line endings the document normalizes", () => {
  it("the first comment on a CRLF file doesn't re-render the editor or announce an outside edit", async () => {
    // The threads block the add creates comes back with the document's CRLF.
    const source = DOC.replace(/\n/g, "\r\n");
    const h = await openEditor(source, { readOnly: true });
    const prose = proseOf(source);
    const start = prose.indexOf("Beta");
    h.send({
      type: "add-comment",
      anchor: { text: "Beta", contextBefore: prose.slice(0, start), contextAfter: prose.slice(start + 4) },
      body: "Why?",
      proseStart: start,
      proseEnd: start + 4,
      proseText: "Beta",
    });
    await vi.waitFor(() => expect(ofType(h, "add-comment-result")).toHaveLength(1));
    expect(ofType(h, "add-comment-result")[0]).toMatchObject({ ok: true });
    expect(parse(h.doc.text).threads).toHaveLength(1);
    expect(ofType(h, "externalChange")).toEqual([]);
  });
});

describe("saving", () => {
  it("a send waits for the editor's edits and the save, then dispatches and tells the webview", async () => {
    const h = await openEditor(DOC);
    h.send(editBlocks(DOC, 0, BETA_BANG));
    h.send({ type: "send-to-claude" });
    await vi.waitFor(() => expect(ofType(h, "send-result")).toHaveLength(1));
    expect(h.doc.text).toBe(spliced(DOC, BETA_BANG));
    expect(h.doc.saves).toBe(1);
    expect(h.exec).toHaveBeenCalledWith("markdownCollab.sendAllToClaude", h.doc.uri);
    expect(ofType(h, "send-result")[0]).toEqual({ type: "send-result", ok: true, saved: true });
  });

  it.each([
    ["resolves false", false],
    ["throws", new Error("EACCES")],
  ] as const)("a send whose save %s is not dispatched, and says why", async (_how, result) => {
    const h = await openEditor(DOC);
    h.doc.saveResult = result;
    h.send(editBlocks(DOC, 0, BETA_BANG));
    h.send({ type: "send-to-claude-comment", threadId: "t1" });
    await vi.waitFor(() => expect(ofType(h, "send-result")).toHaveLength(1));
    expect(h.exec).not.toHaveBeenCalledWith("markdownCollab.sendThreadToClaude", expect.anything(), "t1");
    expect(h.shown.warning).toHaveBeenCalledWith(
      "Not sent: notes.md couldn't be saved, so your agent would read the old version.",
    );
    expect(ofType(h, "send-result")[0]).toEqual({ type: "send-result", ok: false, saved: false });
    expect(h.log.warn).toHaveBeenCalled();
  });

  it("an autosave that fails warns once, naming the file, until a save succeeds", async () => {
    const h = await openEditor(DOC);
    h.doc.saveResult = false;
    h.send(editBlocks(DOC, 0, BETA_BANG));
    await vi.waitFor(() => expect(h.doc.saves).toBe(1), { timeout: 3000 });
    await vi.waitFor(() => expect(h.shown.warning).toHaveBeenCalledTimes(1));
    expect(h.shown.warning.mock.calls[0]![0]).toContain("notes.md");
    expect(h.log.warn).toHaveBeenCalled();
    // A second failure in the same streak goes to the log only.
    const alpha: BlockEdit[] = [{ from: 1, to: 2, markdown: "Alpha sentence?", types: ["paragraph"] }];
    h.send(editBlocks(DOC, 0, alpha));
    await vi.waitFor(() => expect(h.doc.saves).toBe(2), { timeout: 3000 });
    expect(h.shown.warning).toHaveBeenCalledTimes(1);
  });

  it("a comment action whose save fails warns, naming the file", async () => {
    const { source, threadId } = reviewed();
    const h = await openEditor(source);
    h.doc.saveResult = false;
    h.send({ type: "reply", threadId, body: "Thanks." });
    await vi.waitFor(() => expect(h.shown.warning).toHaveBeenCalledTimes(1));
    expect(h.shown.warning.mock.calls[0]![0]).toContain("notes.md");
  });
});

describe("sidebar writes and block edits", () => {
  it("a reply posted while a block edit is being written lands after it: both, byte for byte", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(TS));
    const { source, threadId } = reviewed();
    const h = await openEditor(source);
    const edits: BlockEdit[] = [{ from: 1, to: 2, markdown: "Alpha sentence, edited.", types: ["paragraph"] }];
    h.send(editBlocks(source, 0, edits));
    h.send({ type: "reply", threadId, body: "Thanks." });
    const afterEdit = spliced(source, edits);
    const expected = applyClientMutation(parse(afterEdit), { type: "reply", threadId, body: "Thanks." }, {
      author: "ronica",
      now: () => TS,
    }).source;
    await until(() => h.doc.text.includes("Thanks."));
    expect(h.doc.text).toBe(expected);
    expect(proseOf(h.doc.text)).toContain("Alpha sentence, edited.");
  });

  it("a block edit posted while a thread is being deleted lands after it: both, byte for byte", async () => {
    const { source, threadId } = reviewed();
    const h = await openEditor(source);
    // The edited paragraph holds the thread's markers, which the delete removes.
    const edits: BlockEdit[] = [{ from: 1, to: 2, markdown: "Alpha sentence, edited.", types: ["paragraph"] }];
    h.send({ type: "delete-thread", threadId });
    h.send(editBlocks(source, 0, edits));
    const deleted = applyClientMutation(parse(source), { type: "delete-thread", threadId }, {
      author: "ronica",
      now: () => TS,
    }).source;
    await vi.waitFor(() => expect(h.doc.text).toBe(spliced(deleted, edits)));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.doc.text).toBe(spliced(deleted, edits));
  });

  it("accepting a suggestion after a queued edit keeps the edit; an edit made on the old text is dropped for the re-render", async () => {
    const { source, suggestionId } = reviewed();
    const h = await openEditor(source);
    const edits: BlockEdit[] = [{ from: 0, to: 1, markdown: "# Doc!", types: ["heading"] }];
    h.send(editBlocks(source, 0, edits));
    h.send({ type: "accept-suggestion", anchorId: suggestionId });
    await vi.waitFor(() => expect(proseOf(h.doc.text)).toBe("# Doc!\n\nAlpha sentence.\n\nGamma sentence.\n"));
    const rerenders = ofType(h, "externalChange");
    expect(rerenders).toHaveLength(1);
    expect(rerenders[0]).toMatchObject({ epoch: 1, text: proseOf(h.doc.text) });
    // Typed before the re-render arrived: made on the text without "Gamma".
    const before = h.doc.text;
    h.send(editBlocks(source, 0, [{ from: 2, to: 3, markdown: "Beta sentence!", types: ["paragraph"] }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.doc.text).toBe(before);
  });
});

describe("adding a comment in edit mode", () => {
  const point = (block: number, type: string, offset: number, text: string) => ({ block, type, container: 0, offset, text });

  it("adds two markers where the named characters are in the file's own bytes", async () => {
    // A table the serializer would re-pad: adopting its output would rewrite it.
    const source = "Intro __strong__ here.\n\n| a   | b   |\n|-----|-----|\n| 1   | 2   |\n";
    const h = await openEditor(source);
    const text = "Intro strong here.";
    h.send({
      type: "add-comment",
      anchor: { text: "strong", contextBefore: "", contextAfter: "" },
      body: "Why?",
      editRange: { first: point(0, "paragraph", 6, text), last: point(0, "paragraph", 11, text) },
      epoch: 0,
    });
    await vi.waitFor(() => expect(ofType(h, "add-comment-result")).toHaveLength(1));
    expect(ofType(h, "add-comment-result")[0]).toMatchObject({ ok: true });
    const id = parse(h.doc.text).threads[0]!.id;
    expect(onlyMarkersAdded(source, h.doc.text, id)).toEqual([]);
  });

  it("refuses a selection named in text the editor has since been sent something else in place of", async () => {
    const h = await openEditor(DOC);
    h.send({ type: "ready" });
    await vi.waitFor(() => expect(ofType(h, "init")).toHaveLength(1));
    h.doc.text = DOC.replace("Alpha", "Omega");
    for (const l of changeListeners) l({ document: h.doc });
    const text = "Beta sentence.";
    h.send({
      type: "add-comment",
      anchor: { text: "Beta", contextBefore: "", contextAfter: "" },
      body: "x",
      editRange: { first: point(2, "paragraph", 0, text), last: point(2, "paragraph", 3, text) },
      epoch: 1,
    });
    await vi.waitFor(() => expect(ofType(h, "add-comment-result")).toHaveLength(1));
    expect(ofType(h, "add-comment-result")[0]).toMatchObject({ ok: false, error: expect.stringContaining("Select it again") });
    expect(parse(h.doc.text).threads).toEqual([]);
  });

  it("never adopts a serialization the editor sends along", async () => {
    const h = await openEditor(DOC);
    h.send({
      type: "add-comment",
      anchor: { text: "Beta", contextBefore: "", contextAfter: "" },
      body: "x",
      fullMd: "# Rewritten\n\nBeta sentence.\n",
      selStart: 13,
      selEnd: 17,
    });
    await vi.waitFor(() => expect(ofType(h, "add-comment-result")).toHaveLength(1));
    expect(ofType(h, "add-comment-result")[0]).toMatchObject({ ok: false });
    expect(h.doc.text).toBe(DOC);
  });
});

describe("the uncommitted-changes overlay", () => {
  // Its stripes are placed by source position, which only Reading has.
  it("asked of a panel in Editing, switches it to Reading, after its queued edits, and says so", async () => {
    const h = await openEditor(DOC);
    h.send({ type: "ready" });
    await vi.waitFor(() => expect(ofType(h, "init")).toHaveLength(1));
    expect(ofType(h, "init")[0]).toMatchObject({ readOnly: false });
    h.send(editBlocks(DOC, 1, BETA_BANG));
    await CollabEditorProvider.open(h.doc.uri as unknown as vscode.Uri, { diff: true });
    await vi.waitFor(() => expect(ofType(h, "init")).toHaveLength(2));
    expect(h.doc.text).toBe(spliced(DOC, BETA_BANG));
    expect(ofType(h, "init")[1]).toMatchObject({ readOnly: true, text: proseOf(h.doc.text) });
    expect(h.shown.info).toHaveBeenCalledWith(expect.stringContaining("Reading"));
  });

  it("a panel opened for it opens in Reading, whatever the setting says", async () => {
    await CollabEditorProvider.open(vscode.Uri.file("/w/notes.md") as unknown as vscode.Uri, { diff: true });
    const h = await openEditor(DOC, { readOnly: false });
    h.send({ type: "ready" });
    await vi.waitFor(() => expect(ofType(h, "init")).toHaveLength(1));
    expect(ofType(h, "init")[0]).toMatchObject({ readOnly: true });
  });
});

describe("failures the person has to hear about", () => {
  it("a sidebar action that throws shows an error with Show Logs", async () => {
    const h = await openEditor(DOC);
    h.exec.mockRejectedValueOnce(new Error("command exploded"));
    h.shown.error.mockResolvedValueOnce("Show Logs");
    h.send({ type: "finalize" });
    await vi.waitFor(() =>
      expect(h.shown.error).toHaveBeenCalledWith("Markdown Collab: that action failed — see Show Logs.", "Show Logs"),
    );
    expect(h.log.error).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    await vi.waitFor(() => expect(h.log.show).toHaveBeenCalled());
  });

  it.each(["init", "reinit", "reveal-thread"])("a webview failure at %s offers Reload, which re-sends init", async (stage) => {
    const h = await openEditor(DOC);
    h.shown.error.mockResolvedValueOnce("Reload");
    h.send({ type: "webview-error", stage, message: "boom" });
    await vi.waitFor(() => expect(ofType(h, "init")).toHaveLength(1));
    expect(h.shown.error).toHaveBeenCalledWith(expect.stringContaining("notes.md"), "Reload");
    expect(ofType(h, "init")[0]).toMatchObject({ text: proseOf(DOC), readOnly: false });
  });

  it("a webview failure anywhere else stays in the log", async () => {
    const h = await openEditor(DOC);
    h.send({ type: "webview-error", stage: "uncaught", message: "boom" });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.shown.error).not.toHaveBeenCalled();
    expect(h.log.info).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
