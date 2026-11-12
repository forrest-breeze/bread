import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  PortalAnalyticsOverview,
  PortalDailyBucket,
  PortalTopArticle,
} from "./analytics-types"

/**
 * Live-aggregation queries for the Reporting > Overview page.
 *
 * Same approach as lib/ops/queries.ts: load raw `portal_events` rows for the
 * range via the admin client (the route already authorized the caller against
 * their active workspace), then feed them through `aggregatePortalOverview`, a
 * pure reducer that holds all the counting logic so it can be unit-tested
 * without a database.
 */

const TOP_ARTICLES_LIMIT = 10
const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface PortalAnalyticsRange {
  from: Date
  to: Date
}

/** The columns the reducer needs from each portal_events row. */
export interface PortalEventRow {
  event_type: string
  visitor_id: string
  document_id: string | null
  created_at: string
}

export interface DocMeta {
  title: string
  slug: string | null
}

function utcDayKey(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/** Inclusive list of YYYY-MM-DD UTC days spanning [from, to]. */
export function enumerateDays(from: Date, to: Date): string[] {
  const days: string[] = []
  let cur = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  // Guard against an inverted range so we never spin.
  if (cur > end) return [utcDayKey(from)]
  while (cur <= end) {
    days.push(new Date(cur).toISOString().slice(0, 10))
    cur += MS_PER_DAY
  }
  return days
}

// ---------------------------------------------------------------------------
// aggregatePortalOverview — pure reducer.
//
// Contract:
//   - counts default to 0; searchCtrPct is null when searches = 0.
//   - uniqueVisitors is the cardinality of distinct visitor_id across ALL
//     event types in range.
//   - articleViews counts 'doc_view'; pageViews counts 'pageview'; searches
//     counts 'search'; searchClicks counts 'search_click'.
//   - daily buckets cover every day in range (zero-filled), date ascending.
//   - topArticles ranks doc_view counts desc, ties broken by document id for
//     stability, capped at TOP_ARTICLES_LIMIT, titled via docMeta.
// ---------------------------------------------------------------------------
export function aggregatePortalOverview(
  events: readonly PortalEventRow[],
  docMeta: ReadonlyMap<string, DocMeta>,
  range: PortalAnalyticsRange,
): PortalAnalyticsOverview {
  const visitors = new Set<string>()
  let articleViews = 0
  let pageViews = 0
  let searches = 0
  let searchClicks = 0
  let helpfulYes = 0
  let helpfulNo = 0

  const days = enumerateDays(range.from, range.to)
  const dayMap = new Map<string, { articleViews: number; searches: number }>()
  for (const d of days) dayMap.set(d, { articleViews: 0, searches: 0 })

  const viewsByDoc = new Map<string, number>()

  for (const e of events) {
    if (e.visitor_id) visitors.add(e.visitor_id)
    const day = e.created_at.slice(0, 10)
    const bucket = dayMap.get(day)
    switch (e.event_type) {
      case "doc_view":
        articleViews += 1
        if (bucket) bucket.articleViews += 1
        if (e.document_id) {
          viewsByDoc.set(e.document_id, (viewsByDoc.get(e.document_id) ?? 0) + 1)
        }
        break
      case "pageview":
        pageViews += 1
        break
      case "search":
        searches += 1
        if (bucket) bucket.searches += 1
        break
      case "search_click":
        searchClicks += 1
        break
      case "helpful":
        helpfulYes += 1
        break
      case "not_helpful":
        helpfulNo += 1
        break
      default:
        break
    }
  }

  const daily: PortalDailyBucket[] = days.map((date) => {
    const v = dayMap.get(date)!
    return { date, articleViews: v.articleViews, searches: v.searches }
  })

  const topArticles: PortalTopArticle[] = Array.from(viewsByDoc.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
    .slice(0, TOP_ARTICLES_LIMIT)
    .map(([documentId, views]) => {
      const meta = docMeta.get(documentId)
      return {
        documentId,
        title: meta?.title || "Untitled",
        slug: meta?.slug ?? null,
        views,
      }
    })

  const searchCtrPct =
    searches > 0 ? Math.min(100, (searchClicks / searches) * 100) : null

  const helpfulVotes = helpfulYes + helpfulNo
  const helpfulRatePct =
    helpfulVotes > 0 ? (helpfulYes / helpfulVotes) * 100 : null

  return {
    rangeDays: days.length,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    uniqueVisitors: visitors.size,
    articleViews,
    pageViews,
    searches,
    searchClicks,
    searchCtrPct,
    helpfulYes,
    helpfulNo,
    helpfulRatePct,
    daily,
    topArticles,
  }
}

// ---------------------------------------------------------------------------
// getPortalOverview — fetch raw rows + doc titles, then reduce.
//
// experienceId semantics:
//   - undefined → all portals in the workspace (no experience filter).
//   - null      → the default workspace docs portal only (experience_id IS NULL).
//   - string    → that specific published portal project.
// ---------------------------------------------------------------------------
export async function getPortalOverview(
  admin: SupabaseClient,
  opts: {
    workspaceId: string
    experienceId?: string | null
    range: PortalAnalyticsRange
  },
): Promise<PortalAnalyticsOverview> {
  const { workspaceId, experienceId, range } = opts

  let query = admin
    .from("portal_events")
    .select("event_type, visitor_id, document_id, created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", range.from.toISOString())
    .lt("created_at", range.to.toISOString())

  if (experienceId === null) {
    query = query.is("experience_id", null)
  } else if (typeof experienceId === "string") {
    query = query.eq("experience_id", experienceId)
  }

  const { data, error } = await query
  if (error) throw new Error(`getPortalOverview: portal_events (${error.message})`)
  const events = (data ?? []) as PortalEventRow[]

  // Titles for the "most viewed articles" list — only for docs actually viewed.
  const docIds = Array.from(
    new Set(
      events
        .filter((e) => e.event_type === "doc_view" && e.document_id)
        .map((e) => e.document_id as string),
    ),
  )
  const docMeta = new Map<string, DocMeta>()
  if (docIds.length > 0) {
    const { data: docs, error: docErr } = await admin
      .from("documents")
      .select("id, title, public_slug")
      .in("id", docIds)
    if (docErr) throw new Error(`getPortalOverview: documents (${docErr.message})`)
    for (const d of docs ?? []) {
      docMeta.set(d.id as string, {
        title: (d.title as string) || "Untitled",
        slug: (d.public_slug as string | null) ?? null,
      })
    }
  }

  return aggregatePortalOverview(events, docMeta, range)
}
