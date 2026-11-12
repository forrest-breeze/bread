/**
 * Shared portal-analytics shapes. Client-safe (no `server-only`): consumed by
 * the SWR hook + Reporting UI as well as the server-side query layer.
 */

export type PortalAnalyticsEventType =
  | "pageview"
  | "doc_view"
  | "search"
  | "search_click"
  | "ask"
  | "helpful"
  | "not_helpful"

/** One UTC day of activity for the daily-activity chart. */
export interface PortalDailyBucket {
  /** YYYY-MM-DD (UTC). */
  date: string
  articleViews: number
  searches: number
}

export interface PortalTopArticle {
  documentId: string
  title: string
  /** public_slug when set, else null (link falls back to the doc id). */
  slug: string | null
  views: number
}

/** The single payload the Reporting > Overview page consumes. */
export interface PortalAnalyticsOverview {
  /** Number of whole UTC days covered (inclusive). */
  rangeDays: number
  /** ISO timestamps of the analysis window. */
  from: string
  to: string

  uniqueVisitors: number
  articleViews: number
  pageViews: number
  searches: number
  searchClicks: number
  /** searchClicks / searches, capped at 100. Null when searches = 0. */
  searchCtrPct: number | null

  /** "Was this page helpful?" Yes votes. */
  helpfulYes: number
  /** "Was this page helpful?" No votes. */
  helpfulNo: number
  /** helpfulYes / (helpfulYes + helpfulNo) as a percent. Null when no votes. */
  helpfulRatePct: number | null

  daily: PortalDailyBucket[]
  topArticles: PortalTopArticle[]
}
