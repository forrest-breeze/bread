import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { cn, formatRelativeDate, formatRelativeTime, getInitials } from "@/lib/utils"

// ---------------------------------------------------------------------------
// cn() — Tailwind class merger
// ---------------------------------------------------------------------------

describe("cn", () => {
  it("concatenates plain string classes", () => {
    expect(cn("px-2", "py-4")).toBe("px-2 py-4")
  })

  it("drops falsy values", () => {
    expect(cn("px-2", false, null, undefined, "py-4")).toBe("px-2 py-4")
  })

  it("merges duplicate Tailwind utilities, keeping the later class", () => {
    expect(cn("px-2", "px-4")).toBe("px-4")
  })

  it("flattens arrays and record conditionals", () => {
    expect(cn(["px-2", { "py-4": true, "py-8": false }])).toBe("px-2 py-4")
  })
})

// ---------------------------------------------------------------------------
// formatRelativeTime() — bucketed duration formatting
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  beforeEach(() => {
    // Freeze `now` so "just now", "5m ago", etc. are deterministic.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-20T12:00:00Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns 'just now' for events under a minute old", () => {
    const thirtySecondsAgo = new Date("2026-04-20T11:59:30Z").toISOString()
    expect(formatRelativeTime(thirtySecondsAgo)).toBe("just now")
  })

  it("returns Nm ago for events under an hour old", () => {
    const fiveMinAgo = new Date("2026-04-20T11:55:00Z").toISOString()
    expect(formatRelativeTime(fiveMinAgo)).toBe("5m ago")
  })

  it("returns Nh ago for events under a day old", () => {
    const threeHoursAgo = new Date("2026-04-20T09:00:00Z").toISOString()
    expect(formatRelativeTime(threeHoursAgo)).toBe("3h ago")
  })

  it("returns Nd ago for events under a week old", () => {
    const twoDaysAgo = new Date("2026-04-18T12:00:00Z").toISOString()
    expect(formatRelativeTime(twoDaysAgo)).toBe("2d ago")
  })

  it("returns Nw ago for older events", () => {
    const threeWeeksAgo = new Date("2026-03-30T12:00:00Z").toISOString()
    expect(formatRelativeTime(threeWeeksAgo)).toBe("3w ago")
  })
})

// ---------------------------------------------------------------------------
// formatRelativeDate() — calendar-style formatting
// ---------------------------------------------------------------------------

describe("formatRelativeDate", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-20T12:00:00Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns an empty string for null", () => {
    expect(formatRelativeDate(null)).toBe("")
  })

  it("returns an empty string for an unparseable date", () => {
    expect(formatRelativeDate("not a date")).toBe("")
  })

  it("returns 'today' for values inside the last 24 hours", () => {
    const eightHoursAgo = new Date("2026-04-20T04:00:00Z").toISOString()
    expect(formatRelativeDate(eightHoursAgo)).toBe("today")
  })

  it("returns 'yesterday' for values 1-2 days old", () => {
    const yesterday = new Date("2026-04-19T10:00:00Z").toISOString()
    expect(formatRelativeDate(yesterday)).toBe("yesterday")
  })

  it("returns 'N days ago' for values under a week old", () => {
    const fourDaysAgo = new Date("2026-04-16T12:00:00Z").toISOString()
    expect(formatRelativeDate(fourDaysAgo)).toBe("4 days ago")
  })

  it("falls back to localized calendar formatting for older dates", () => {
    // Older than a week — formatted via toLocaleDateString. The exact string
    // depends on the JS engine's default locale, so we only assert
    // non-empty, non-relative output.
    const fortyDaysAgo = new Date("2026-03-11T12:00:00Z").toISOString()
    const formatted = formatRelativeDate(fortyDaysAgo)
    expect(formatted).not.toBe("today")
    expect(formatted).not.toBe("yesterday")
    expect(formatted.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getInitials()
// ---------------------------------------------------------------------------

describe("getInitials", () => {
  it("returns the first two initials of a two-word name", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL")
  })

  it("uppercases lowercase initials", () => {
    expect(getInitials("grace hopper")).toBe("GH")
  })

  it("truncates to at most two letters even for long names", () => {
    expect(getInitials("Mary Ada Grace Lovelace")).toBe("MA")
  })

  it("returns a single letter for single-word names", () => {
    expect(getInitials("Ada")).toBe("A")
  })

  it("returns empty string for empty name", () => {
    expect(getInitials("")).toBe("")
  })
})
