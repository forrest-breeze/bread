/**
 * analytics-queries.ts — portal analytics reducer.
 *
 * Most logic lives in `aggregatePortalOverview`, a pure reducer over
 * already-fetched portal_events rows. These tests pin the contract:
 *   - counts default to 0; searchCtrPct null when searches = 0, capped at 100.
 *   - uniqueVisitors = distinct visitor_id across all event types.
 *   - daily buckets cover every UTC day in range, zero-filled, ascending.
 *   - topArticles rank doc_view counts desc (ties by doc id), titled via docMeta.
 */

import { describe, expect, it } from "vitest"
import {
  aggregatePortalOverview,
  enumerateDays,
  type DocMeta,
  type PortalAnalyticsRange,
  type PortalEventRow,
} from "./analytics-queries"

const RANGE: PortalAnalyticsRange = {
  from: new Date("2026-06-01T00:00:00.000Z"),
  to: new Date("2026-06-03T23:59:59.000Z"),
}

function ev(partial: Partial<PortalEventRow> & { event_type: string }): PortalEventRow {
  return {
    visitor_id: "v1",
    document_id: null,
    created_at: "2026-06-01T12:00:00.000Z",
    ...partial,
  }
}

describe("enumerateDays", () => {
  it("returns inclusive UTC day keys ascending", () => {
    expect(enumerateDays(RANGE.from, RANGE.to)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ])
  })

  it("returns a single day for a same-day range", () => {
    const d = new Date("2026-06-10T05:00:00.000Z")
    expect(enumerateDays(d, d)).toEqual(["2026-06-10"])
  })

  it("does not spin on an inverted range", () => {
    expect(enumerateDays(RANGE.to, RANGE.from)).toEqual(["2026-06-03"])
  })
})

describe("aggregatePortalOverview", () => {
  it("returns zeroed metrics + zero-filled daily buckets for no events", () => {
    const out = aggregatePortalOverview([], new Map(), RANGE)
    expect(out.uniqueVisitors).toBe(0)
    expect(out.articleViews).toBe(0)
    expect(out.pageViews).toBe(0)
    expect(out.searches).toBe(0)
    expect(out.searchClicks).toBe(0)
    expect(out.searchCtrPct).toBeNull()
    expect(out.topArticles).toEqual([])
    expect(out.rangeDays).toBe(3)
    expect(out.daily).toHaveLength(3)
    expect(out.daily.every((d) => d.articleViews === 0 && d.searches === 0)).toBe(true)
  })

  it("counts each event type and dedupes unique visitors", () => {
    const events: PortalEventRow[] = [
      ev({ event_type: "pageview", visitor_id: "a" }),
      ev({ event_type: "pageview", visitor_id: "a" }),
      ev({ event_type: "doc_view", visitor_id: "b", document_id: "d1" }),
      ev({ event_type: "search", visitor_id: "b" }),
      ev({ event_type: "search_click", visitor_id: "c", document_id: "d1" }),
    ]
    const out = aggregatePortalOverview(events, new Map(), RANGE)
    expect(out.uniqueVisitors).toBe(3) // a, b, c
    expect(out.pageViews).toBe(2)
    expect(out.articleViews).toBe(1)
    expect(out.searches).toBe(1)
    expect(out.searchClicks).toBe(1)
  })

  it("computes CTR and caps it at 100", () => {
    const balanced = aggregatePortalOverview(
      [
        ev({ event_type: "search" }),
        ev({ event_type: "search" }),
        ev({ event_type: "search_click", document_id: "d1" }),
      ],
      new Map(),
      RANGE,
    )
    expect(balanced.searchCtrPct).toBe(50)

    const overOne = aggregatePortalOverview(
      [
        ev({ event_type: "search" }),
        ev({ event_type: "search_click", document_id: "d1" }),
        ev({ event_type: "search_click", document_id: "d1" }),
      ],
      new Map(),
      RANGE,
    )
    expect(overOne.searchCtrPct).toBe(100)
  })

  it("buckets activity by UTC day", () => {
    const events: PortalEventRow[] = [
      ev({ event_type: "doc_view", created_at: "2026-06-01T01:00:00.000Z", document_id: "d1" }),
      ev({ event_type: "doc_view", created_at: "2026-06-01T23:00:00.000Z", document_id: "d1" }),
      ev({ event_type: "search", created_at: "2026-06-03T10:00:00.000Z" }),
    ]
    const out = aggregatePortalOverview(events, new Map(), RANGE)
    expect(out.daily.find((d) => d.date === "2026-06-01")?.articleViews).toBe(2)
    expect(out.daily.find((d) => d.date === "2026-06-03")?.searches).toBe(1)
    expect(out.daily.find((d) => d.date === "2026-06-02")?.articleViews).toBe(0)
  })

  it("ranks most-viewed articles and titles them via docMeta", () => {
    const events: PortalEventRow[] = [
      ev({ event_type: "doc_view", document_id: "d1" }),
      ev({ event_type: "doc_view", document_id: "d1" }),
      ev({ event_type: "doc_view", document_id: "d2" }),
    ]
    const meta = new Map<string, DocMeta>([
      ["d1", { title: "Getting Started", slug: "getting-started" }],
      ["d2", { title: "Billing", slug: null }],
    ])
    const out = aggregatePortalOverview(events, meta, RANGE)
    expect(out.topArticles).toEqual([
      { documentId: "d1", title: "Getting Started", slug: "getting-started", views: 2 },
      { documentId: "d2", title: "Billing", slug: null, views: 1 },
    ])
  })

  it("counts helpful votes and computes the helpful rate", () => {
    const out = aggregatePortalOverview(
      [
        ev({ event_type: "helpful", document_id: "d1" }),
        ev({ event_type: "helpful", document_id: "d2" }),
        ev({ event_type: "helpful", document_id: "d3" }),
        ev({ event_type: "not_helpful", document_id: "d4" }),
      ],
      new Map(),
      RANGE,
    )
    expect(out.helpfulYes).toBe(3)
    expect(out.helpfulNo).toBe(1)
    expect(out.helpfulRatePct).toBe(75)
  })

  it("returns a null helpful rate with no votes", () => {
    const out = aggregatePortalOverview([], new Map(), RANGE)
    expect(out.helpfulYes).toBe(0)
    expect(out.helpfulNo).toBe(0)
    expect(out.helpfulRatePct).toBeNull()
  })

  it("falls back to 'Untitled' when a viewed doc has no meta", () => {
    const out = aggregatePortalOverview(
      [ev({ event_type: "doc_view", document_id: "ghost" })],
      new Map(),
      RANGE,
    )
    expect(out.topArticles[0]).toMatchObject({ documentId: "ghost", title: "Untitled", views: 1 })
  })
})
