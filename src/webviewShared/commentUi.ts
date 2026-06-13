// Shared comment-panel UI builders.
//
// Plain-DOM, framework-agnostic builders for the pieces every comment panel
// needs — a composer (textarea + submit/cancel + status) and a comment card
// (author / time / body / actions). Imported by the inline-comments, PR/MR
// review, and live-collab webviews so the three surfaces render the same
// markup and pick up the shared `comments.css` styles. No view-specific data
// models leak in here: callers pass strings + callbacks.

import { formatRelativeTime } from "../collab/relativeTime";

export interface ComposerHandle {
  /** The composer root element to mount. */
  el: HTMLElement;
  /** The textarea, for callers that need focus / value access. */
  textarea: HTMLTextAreaElement;
  /** Put the composer into a "submitting" state (disables input + shows status). */
  setBusy(message: string): void;
  /** Re-enable after a failed submit and surface an error inline. */
  setError(message: string): void;
}

export interface ComposerOptions {
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  initialValue?: string;
  rows?: number;
  /** Optional one-line note shown above the textarea (e.g. "Comment on lines 3–7"). */
  meta?: string;
  /** Focus the textarea on mount (default true). */
  autofocus?: boolean;
  onSubmit(body: string): void;
  onCancel?(): void;
}

/** Build a shared comment composer. Returns the element plus busy/error helpers. */
export function buildComposer(opts: ComposerOptions): ComposerHandle {
  const el = document.createElement("div");
  el.className = "mc-composer";

  if (opts.meta) {
    const meta = document.createElement("div");
    meta.className = "mc-composer__meta";
    meta.textContent = opts.meta;
    el.appendChild(meta);
  }

  const textarea = document.createElement("textarea");
  textarea.placeholder = opts.placeholder ?? "Your comment…";
  textarea.rows = opts.rows ?? 3;
  if (opts.initialValue) textarea.value = opts.initialValue;

  const actions = document.createElement("div");
  actions.className = "mc-composer__actions";

  const submit = document.createElement("button");
  submit.className = "mc-btn mc-btn--primary";
  submit.textContent = opts.submitLabel ?? "Comment";
  submit.disabled = textarea.value.trim().length === 0;

  const cancel = opts.onCancel ? document.createElement("button") : null;
  if (cancel) {
    cancel.className = "mc-btn mc-btn--ghost";
    cancel.textContent = opts.cancelLabel ?? "Cancel";
    cancel.addEventListener("click", () => opts.onCancel?.());
  }

  const status = document.createElement("span");
  status.className = "mc-composer__status";

  textarea.addEventListener("input", () => {
    submit.disabled = textarea.value.trim().length === 0;
    status.textContent = "";
    status.classList.remove("mc-composer__status--error");
  });
  submit.addEventListener("click", () => {
    const body = textarea.value.trim();
    if (!body) return;
    opts.onSubmit(body);
  });
  // Consistent keyboard shortcuts in every view: Cmd/Ctrl+Enter submits, Esc cancels.
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !submit.disabled) {
      e.preventDefault();
      submit.click();
    } else if (e.key === "Escape" && opts.onCancel) {
      e.preventDefault();
      opts.onCancel();
    }
  });

  actions.appendChild(submit);
  if (cancel) actions.appendChild(cancel);
  actions.appendChild(status);
  el.append(textarea, actions);

  if (opts.autofocus !== false) requestAnimationFrame(() => textarea.focus());

  return {
    el,
    textarea,
    setBusy(message: string): void {
      submit.disabled = true;
      if (cancel) cancel.disabled = true;
      textarea.disabled = true;
      status.classList.remove("mc-composer__status--error");
      status.textContent = message;
    },
    setError(message: string): void {
      submit.disabled = textarea.value.trim().length === 0;
      if (cancel) cancel.disabled = false;
      textarea.disabled = false;
      status.classList.add("mc-composer__status--error");
      status.textContent = message;
    },
  };
}

export interface CardAction {
  label: string;
  onClick(): void;
  variant?: "link" | "danger";
  title?: string;
}

export interface CommentCardOptions {
  author: string;
  /** ISO-8601 (or epoch ms) — rendered as relative time. Omit to hide. */
  timestamp?: string | number;
  /** Extra muted note in the meta row after the time (e.g. "edited"). */
  note?: string;
  /** Plain-text body. Rendered as text (callers that want markdown set `bodyEl`). */
  body?: string;
  /** Pre-rendered body element (e.g. markdown HTML), used instead of `body`. */
  bodyEl?: HTMLElement;
  badges?: string[];
  /** Render as a nested reply (indented, lighter chrome). */
  reply?: boolean;
  actions?: CardAction[];
  /** Card-level click handler (e.g. reveal the anchored text). */
  onClick?(): void;
}

/** Build a shared comment card (author + relative time + body + actions). */
export function buildCommentCard(opts: CommentCardOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = opts.reply ? "mc-card mc-card--reply" : "mc-card";

  const meta = document.createElement("div");
  meta.className = "mc-card__meta";
  const author = document.createElement("span");
  author.className = "mc-card__author";
  author.textContent = opts.author;
  meta.appendChild(author);
  if (opts.timestamp !== undefined) {
    const time = document.createElement("span");
    time.className = "mc-card__time";
    time.textContent = formatRelativeTime(opts.timestamp);
    meta.appendChild(time);
  }
  if (opts.note) {
    const note = document.createElement("span");
    note.className = "mc-card__time";
    note.textContent = `· ${opts.note}`;
    meta.appendChild(note);
  }
  for (const b of opts.badges ?? []) {
    const badge = document.createElement("span");
    badge.className = b.toLowerCase() === "resolved" ? "mc-badge mc-badge--resolved" : "mc-badge";
    badge.textContent = b;
    meta.appendChild(badge);
  }
  card.appendChild(meta);

  const bodyEl = opts.bodyEl ?? (() => {
    const d = document.createElement("div");
    d.textContent = opts.body ?? "";
    return d;
  })();
  bodyEl.classList.add("mc-card__body");
  card.appendChild(bodyEl);

  if (opts.actions && opts.actions.length > 0) {
    const row = document.createElement("div");
    row.className = "mc-card__actions";
    for (const a of opts.actions) {
      const btn = document.createElement("button");
      btn.className = a.variant === "danger" ? "mc-btn mc-btn--link mc-btn--danger" : "mc-btn mc-btn--link";
      btn.textContent = a.label;
      if (a.title) btn.title = a.title;
      btn.addEventListener("click", (e) => {
        // Don't let an action bubble to a card-level click handler.
        e.stopPropagation();
        a.onClick();
      });
      row.appendChild(btn);
    }
    card.appendChild(row);
  }

  if (opts.onClick) {
    card.style.cursor = "pointer";
    card.addEventListener("click", opts.onClick);
  }

  return card;
}
