import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../collab/relativeTime";

const NOW = Date.parse("2026-05-03T12:00:00.000Z");

describe("formatRelativeTime", () => {
  it("returns 'just now' for under 30s ago", () => {
    expect(formatRelativeTime(NOW - 1_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 29_000, NOW)).toBe("just now");
  });

  it("returns Ns / Nm / Nh / Nd for sub-week deltas", () => {
    expect(formatRelativeTime(NOW - 45_000, NOW)).toBe("45s");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h");
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d");
  });

  it("switches to absolute month/day after 7 days", () => {
    // 10 days before May 3 → April 23
    const tenDaysBefore = NOW - 10 * 86_400_000;
    expect(formatRelativeTime(tenDaysBefore, NOW)).toBe("Apr 23");
  });

  it("includes the year when the timestamp is in a different year", () => {
    const lastYear = Date.parse("2025-12-15T00:00:00.000Z");
    expect(formatRelativeTime(lastYear, NOW)).toBe("Dec 15, 2025");
  });

  it("clamps future timestamps to 'just now' rather than saying 'in the future'", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("just now");
  });

  it("returns empty string for unparseable input", () => {
    expect(formatRelativeTime("not a date", NOW)).toBe("");
    expect(formatRelativeTime("", NOW)).toBe("");
  });

  it("accepts ISO 8601 strings (the format the sidecar stores)", () => {
    const iso = new Date(NOW - 5 * 3_600_000).toISOString();
    expect(formatRelativeTime(iso, NOW)).toBe("5h");
  });
});
