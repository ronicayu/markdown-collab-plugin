// The extension's presence in the raw text editor (10x-plan-3 P0.1).
//
// Thin by design: everything worth testing is in `presence.ts`. This file owns
// the decoration types, the providers, and the "when do we recompute" rules.
//
// Cost discipline, because this runs on every keystroke in every open Markdown
// file: the parse is skipped entirely for documents with no `mc:` markers (a
// substring test), and recomputation is debounced per document. Nothing here
// ever mutates a document.

import * as vscode from "vscode";
import { parse as parseInline } from "../inlineComments/format";
import type { Logger } from "../logging";
import { hasPresence, hoverFor, presenceLensLabel, presenceRanges, threadsFold } from "./presence";

/** Cheapest possible "is this file even ours" test, run before any parse. */
function mightHaveMarkers(text: string): boolean {
  return text.includes("<!--mc:");
}

function isMarkdown(doc: vscode.TextDocument): boolean {
  return doc.languageId === "markdown";
}

function rangesToVsCode(doc: vscode.TextDocument, ranges: Array<{ start: number; end: number }>): vscode.Range[] {
  return ranges.map((r) => new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)));
}

/**
 * Decoration types are created once and reused. Colors come from the theme so
 * this reads correctly in light, dark, and high contrast — a hard-coded
 * background is how an extension makes someone's editor unusable.
 */
function createDecorationTypes(): {
  marker: vscode.TextEditorDecorationType;
  open: vscode.TextEditorDecorationType;
  resolved: vscode.TextEditorDecorationType;
  suggestion: vscode.TextEditorDecorationType;
  dispose(): void;
} {
  // Markers stay selectable and copyable — just quiet. `opacity` on the
  // `after`-less base is enough; hiding them outright would make the format
  // deniable and break click-to-position.
  const marker = vscode.window.createTextEditorDecorationType({
    opacity: "0.35",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const open = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
    borderRadius: "2px",
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.infoForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const resolved = vscode.window.createTextEditorDecorationType({
    // No background: a resolved thread is history, and marking it as loudly as
    // a live one is how a heavily reviewed file becomes unreadable.
    textDecoration: "underline dotted",
    opacity: "0.85",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const suggestion = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
    borderRadius: "2px",
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  return {
    marker,
    open,
    resolved,
    suggestion,
    dispose(): void {
      marker.dispose();
      open.dispose();
      resolved.dispose();
      suggestion.dispose();
    },
  };
}

const DEBOUNCE_MS = 120;

export function activateEditorPresence(log: Logger): vscode.Disposable {
  const types = createDecorationTypes();
  const subs: vscode.Disposable[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const decorate = (editor: vscode.TextEditor): void => {
    const doc = editor.document;
    if (!isMarkdown(doc)) return;
    const text = doc.getText();
    if (!mightHaveMarkers(text)) {
      // Clear rather than skip: the last marker may have just been removed.
      editor.setDecorations(types.marker, []);
      editor.setDecorations(types.open, []);
      editor.setDecorations(types.resolved, []);
      editor.setDecorations(types.suggestion, []);
      return;
    }
    try {
      const ranges = presenceRanges(parseInline(text));
      editor.setDecorations(types.marker, rangesToVsCode(doc, ranges.markers));
      editor.setDecorations(types.open, rangesToVsCode(doc, ranges.openSpans));
      editor.setDecorations(types.resolved, rangesToVsCode(doc, ranges.resolvedSpans));
      editor.setDecorations(types.suggestion, rangesToVsCode(doc, ranges.suggestionSpans));
    } catch (e) {
      // A malformed file is the integrity machinery's problem, not a reason to
      // throw inside a render pass on every keystroke.
      log.warn("could not decorate", { file: doc.uri.fsPath, error: (e as Error).message });
    }
  };

  const decorateAllFor = (doc: vscode.TextDocument): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === doc.uri.toString()) decorate(editor);
    }
  };

  const scheduleDecorate = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        decorateAllFor(doc);
      }, DEBOUNCE_MS),
    );
  };

  for (const editor of vscode.window.visibleTextEditors) decorate(editor);

  subs.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) decorate(editor);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isMarkdown(e.document)) scheduleDecorate(e.document);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isMarkdown(doc)) decorateAllFor(doc);
    }),

    // Folding: the threads region collapses to one line. Registered as a
    // provider rather than an `editor.fold` command so the user's own
    // fold/unfold always wins — we never re-fold what someone opened.
    vscode.languages.registerFoldingRangeProvider(
      { language: "markdown" },
      {
        provideFoldingRanges(doc) {
          const text = doc.getText();
          if (!mightHaveMarkers(text)) return [];
          const fold = threadsFold(text, parseInline(text));
          if (!fold) return [];
          return [
            new vscode.FoldingRange(fold.startLine, fold.endLine, vscode.FoldingRangeKind.Region),
          ];
        },
      },
    ),

    // One lens at the top of a reviewed file: the counts, and a way in. The
    // review view was previously reachable only by a palette command whose
    // name you had to already know.
    vscode.languages.registerCodeLensProvider(
      { language: "markdown" },
      {
        provideCodeLenses(doc) {
          const text = doc.getText();
          if (!mightHaveMarkers(text)) return [];
          const parsed = parseInline(text);
          if (!hasPresence(parsed)) return [];
          const title = presenceLensLabel(parsed);
          if (!title) return [];
          return [
            new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
              title,
              command: "markdownCollab.openInlineCommentsView",
              arguments: [doc.uri],
            }),
          ];
        },
      },
    ),

    // Hover: what the thread says, without leaving the source view.
    vscode.languages.registerHoverProvider(
      { language: "markdown" },
      {
        provideHover(doc, position) {
          const text = doc.getText();
          if (!mightHaveMarkers(text)) return null;
          const parsed = parseInline(text);
          const hit = hoverFor(parsed, doc.offsetAt(position), {
            commandLinks: true,
            file: doc.uri.toString(),
          });
          if (!hit) return null;
          const md = new vscode.MarkdownString(hit.markdown);
          // Required for the `command:` link to be clickable. The content is
          // built from the document's own threads, not from anything remote.
          md.isTrusted = { enabledCommands: ["markdownCollab.revealThread"] };
          const anchor = parsed.anchors.get(hit.thread.id);
          const range = anchor
            ? new vscode.Range(doc.positionAt(anchor.openEnd), doc.positionAt(anchor.closeStart))
            : undefined;
          return new vscode.Hover(md, range);
        },
      },
    ),
  );

  return {
    dispose(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const s of subs) s.dispose();
      types.dispose();
    },
  };
}
