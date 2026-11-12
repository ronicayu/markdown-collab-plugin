// The one way into the review view.
//
// The review view is the live editor (custom editor
// `markdownCollab.collabEditor`): the rendered document with the threads
// sidebar, read-only until its Edit switch is turned on. Every entry point —
// the command and its menus and key, the hover link, the tree rows, the unread
// walk, the status bar — comes through the router built here, so each one asks
// the view for the same things.

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

export interface ReviewViewRoute {
  revealThreadId?: string;
  diff?: boolean;
}

/**
 * Where the review view lands. `source` is the file's text; it's only read
 * when the caller asked to land on the first unread agent thread.
 */
export function routeReviewView(source: string, opts: ReviewViewOpts): ReviewViewRoute {
  const threadId = opts.revealThreadId || (opts.focusNewFromAgent ? firstUnreadFromAgent(source) : undefined);
  const route: ReviewViewRoute = {};
  if (threadId) route.revealThreadId = threadId;
  if (opts.diff) route.diff = true;
  return route;
}

/** The first thread, in document order, an agent opened and no human has answered. */
function firstUnreadFromAgent(source: string): string | undefined {
  return parseInline(source).threads.find((t) => isClaudeUnread(t))?.id;
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
  /** The review view: the live editor (`CollabEditorProvider.open`). */
  live(uri: vscode.Uri, opts: { revealThreadId?: string; diff?: boolean }): Promise<void>;
  /** The file's current text, as an open editor has it. */
  readSource(uri: vscode.Uri): Promise<string>;
}

export type OpenReviewView = (uri: vscode.Uri, opts?: ReviewViewOpts) => Promise<void>;

export function createReviewViewRouter(targets: ReviewViewTargets): OpenReviewView {
  return async (uri, opts = {}) => {
    // Only the unread walk needs the file's text; a named thread is passed through.
    const source = opts.focusNewFromAgent && !opts.revealThreadId ? await targets.readSource(uri) : "";
    const route = routeReviewView(source, opts);
    await targets.live(uri, { revealThreadId: route.revealThreadId, diff: route.diff });
  };
}
