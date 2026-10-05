// The comment sidebar's wire contract (10x-plan-6 P4, sidebar parity).
//
// The live editor's sidebar (`threadSidebar.ts`) renders from `SidebarState`
// and posts `SidebarMessage`s; the host half (`collab/sidebarHost.ts`) builds
// the one and handles the other. Both halves import this file, so it stays
// free of DOM and `vscode` types — the extension host compiles without the
// DOM lib, and the webview bundle has no `vscode`.
//
// The shapes are the review view's (`serializeState.ts`, `mutations.ts`) on
// purpose: when the live editor becomes the only view, the messages a card
// posts and the document operations they run are the ones the review view
// has always used.

/** One comment as the card renders it — `InlineComment`, structurally. */
export interface SidebarComment {
  id: string;
  parent?: string;
  author: string;
  /** Set by the tools/CLI on every comment an agent writes. */
  agent?: boolean;
  /** How an agent's comment reached the file; absent means typed into the text. */
  via?: "tools" | "cli";
  ts: string;
  body: string;
  editedTs?: string;
  deleted?: boolean;
}

/** One thread — `SerializedState["threads"][number]`, structurally. */
export interface SidebarThread {
  id: string;
  quote: string;
  status: "open" | "resolved";
  comments: SidebarComment[];
  /**
   * Null when the thread's markers are gone from the file. The card says so:
   * read-only mode places highlights by marker only, so such a thread has no
   * highlight in the document at all.
   */
  anchor: { proseStart: number; proseEnd: number } | null;
  /** The anchored text changed after this thread's last comment. */
  stale?: boolean;
}

/** A pending suggestion, as its card needs it. */
export interface SidebarSuggestion {
  anchorId: string;
  author: string;
  ts: string;
  original: string;
  proposed: string;
  note?: string;
  /** False once the suggestion lost its markers — it can only be rejected. */
  anchored: boolean;
}

export type DispatchOutcome = "delivered" | "copied" | "cancelled";

export type SkillStatus = "missing" | "outdated" | "current";

/** Everything the sidebar renders from; rebuilt from each host push. */
export interface SidebarState {
  threads: SidebarThread[];
  suggestions: SidebarSuggestion[];
  /** Whether Send asks the agent to propose edits as suggestions. */
  suggestMode: boolean;
  /** Threads sent to an agent and not yet answered. */
  pendingThreadIds: string[];
  /** The host's wording for the waiting row; absent means "<agentName> is working…". */
  pendingLabel?: string;
  /** Who the Send button and the waiting row name. Absent means no agent has written here yet: they read generic ("your agent"). */
  agentName?: string;
  /** Whether the document is read-only (the Edit switch is off). */
  readOnly: boolean;
}

/** Messages the sidebar posts. Every one of them is also a review-view message except `set-read-only`. */
export type SidebarMessage =
  | { type: "send-to-claude" }
  | { type: "copy-prompt" }
  | { type: "toggle-suggest-mode" }
  | { type: "set-read-only"; readOnly: boolean }
  | { type: "remove-resolved" }
  | { type: "finalize" }
  | { type: "install-skill" }
  | { type: "empty-state-review" }
  | { type: "send-to-claude-comment"; threadId: string }
  | { type: "copy-claude-comment"; threadId: string }
  | { type: "open-in-editor"; threadId: string }
  | SidebarMutation;

/**
 * The messages that rewrite the document — the review view's
 * `MutationMessage`, minus `add-comment` (the editor owns adding).
 */
export type SidebarMutation =
  | { type: "reply"; threadId: string; body: string }
  | { type: "edit-comment"; threadId: string; commentId: string; body: string }
  | { type: "toggle-resolve"; threadId: string }
  | { type: "delete-thread"; threadId: string }
  | { type: "delete-comment"; threadId: string; commentId: string }
  | { type: "accept-suggestion"; anchorId: string }
  | { type: "reject-suggestion"; anchorId: string }
  | { type: "accept-all-suggestions" };
