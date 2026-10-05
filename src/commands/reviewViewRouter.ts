// The one way into the review view.
//
// The review view is the live editor (custom editor
// `markdownCollab.collabEditor`): the rendered document with the threads
// sidebar, read-only until its Edit switch is turned on. The markdown-it panel
// (`InlineCommentsPanel`) stays behind
// `markdownCollab.classicReviewView`. Every entry point — the command and its
// menus and key, the hover link, the tree rows, the unread walk, the status
// bar — comes through the router built here, so the setting is read in one
// place and each view is asked for the same things.

import type * as vscode from "vscode";
import { isClaudeUnread } from "../inlineComments/claudeUnread";
import { parse as parseInline } from "../inlineComments/format";

export interface ReviewViewOpts {
  /** Land on this thread: its card becomes the current one and the document scrolls to it. */
  revealThreadId?: string;
  /** Overlay the uncommitted-vs-HEAD diff (the Uncommitted Markdown tree). */
  diff?: boolean;
  /**
   * Land on the first thread an agent opened that no human has answered yet —
   * after a review pass. `revealThreadId` wins when both are given.
   */
  focusNewFromAgent?: boolean;
}

export type ReviewViewRoute =
  | { view: "classic"; line?: number; showDiff?: boolean }
  | { view: "live"; revealThreadId?: string; diff?: boolean };

/**
 * Which view opens, and where it lands. `source` is the file's text; it's only
 * read when the caller asked to land on a thread. The classic panel addresses
 * a thread by its anchor's source line (1-based, the line the thread's text
 * starts on); an unanchored thread gives it no line, so it opens at the top.
 */
export function routeReviewView(source: string, opts: ReviewViewOpts, classic: boolean): ReviewViewRoute {
  const threadId = opts.revealThreadId || (opts.focusNewFromAgent ? firstUnreadFromAgent(source) : undefined);
  if (classic) {
    const route: ReviewViewRoute = { view: "classic" };
    const anchor = threadId ? parseInline(source).anchors.get(threadId) : undefined;
    if (anchor) route.line = lineOf(source, anchor.openEnd);
    if (opts.diff) route.showDiff = true;
    return route;
  }
  const route: ReviewViewRoute = { view: "live" };
  if (threadId) route.revealThreadId = threadId;
  if (opts.diff) route.diff = true;
  return route;
}

/** The first thread, in document order, an agent opened and no human has answered. */
function firstUnreadFromAgent(source: string): string | undefined {
  return parseInline(source).threads.find((t) => isClaudeUnread(t))?.id;
}

/** 1-based line of `offset`, counted the way `TextDocument.positionAt` does. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * The options a caller passed as a command's second argument. Menus pass
 * their own second argument there (the editor group, the explorer selection),
 * so only the known fields, with the right types, are read.
 */
export function reviewViewOptsFrom(arg: unknown): ReviewViewOpts {
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) return {};
  const o = arg as Record<string, unknown>;
  const opts: ReviewViewOpts = {};
  if (typeof o.revealThreadId === "string" && o.revealThreadId) opts.revealThreadId = o.revealThreadId;
  if (o.diff === true) opts.diff = true;
  if (o.focusNewFromAgent === true) opts.focusNewFromAgent = true;
  return opts;
}

export interface ReviewViewTargets {
  /** The previous review view (`InlineCommentsPanel`). */
  classic(uri: vscode.Uri, opts: { line?: number; showDiff?: boolean }): Promise<void>;
  /** The review view: the live editor (`CollabEditorProvider.open`). */
  live(uri: vscode.Uri, opts: { revealThreadId?: string; diff?: boolean }): Promise<void>;
  /** The file's current text, as an open editor has it. */
  readSource(uri: vscode.Uri): Promise<string>;
  /** `markdownCollab.classicReviewView`, read on every open so a change applies to the next one. */
  classicEnabled(): boolean;
}

export type OpenReviewView = (uri: vscode.Uri, opts?: ReviewViewOpts) => Promise<void>;

export function createReviewViewRouter(targets: ReviewViewTargets): OpenReviewView {
  return async (uri, opts = {}) => {
    const needsSource = !!opts.revealThreadId || !!opts.focusNewFromAgent;
    const source = needsSource ? await targets.readSource(uri) : "";
    const route = routeReviewView(source, opts, targets.classicEnabled());
    if (route.view === "classic") await targets.classic(uri, { line: route.line, showDiff: route.showDiff });
    else await targets.live(uri, { revealThreadId: route.revealThreadId, diff: route.diff });
  };
}
