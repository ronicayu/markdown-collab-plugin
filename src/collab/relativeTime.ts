// Compact relative-time formatter for comment + reply timestamps.
//
// Exports a pure function so the webview rendering and unit tests share
// one source of truth. Output strings are short (e.g. "2m", "3h", "Aug
// 12") because the sidebar is narrow and we want every reply card to
// stay one line per metadata row.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatRelativeTime(
  isoOrEpochMs: string | number,
  nowMs: number = Date.now(),
): string {
  let then: number;
  if (typeof isoOrEpochMs === "number") {
    then = isoOrEpochMs;
  } else {
    const parsed = Date.parse(isoOrEpochMs);
    if (Number.isNaN(parsed)) return "";
    then = parsed;
  }
  let diff = nowMs - then;
  if (diff < 0) diff = 0; // clock skew — clamp instead of saying "in the future"

  if (diff < 30 * SECOND) return "just now";
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;

  // > 7 days: switch to absolute date.
  const d = new Date(then);
  const sameYear = new Date(nowMs).getFullYear() === d.getFullYear();
  const month = MONTHS[d.getMonth()];
  return sameYear ? `${month} ${d.getDate()}` : `${month} ${d.getDate()}, ${d.getFullYear()}`;
}
