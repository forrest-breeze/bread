import "server-only"

import { createHash } from "node:crypto"

import { createAdminClient } from "@/lib/supabase/admin"
import type { PortalAnalyticsEventType } from "./analytics-types"

/**
 * Capture helpers for public-KB portal analytics.
 *
 * `logPortalEvent` is **fire-and-forget** (mirrors logSearchEvent): it kicks
 * off a service-role insert into `portal_events` and returns immediately so the
 * public read path is never blocked. Errors are logged and swallowed.
 *
 * `portalVisitorId` derives a cookieless, one-way anonymous visitor id. We hash
 * a server secret + workspace id + client IP + user-agent. We store only the
 * hash — never the raw IP/UA — so there is no PII at rest and no cookie/consent
 * surface. The same browser hitting the same portal hashes stably for as long
 * as BREAD_PORTAL_VISITOR_SALT is fixed, giving accurate unique-visitor counts
 * across the analysis window. Mixing workspace_id in means the same person on
 * two different workspaces' portals counts as two visitors (correct for
 * per-workspace analytics).
 */

const VISITOR_SALT =
  process.env.BREAD_PORTAL_VISITOR_SALT ?? "bread-portal-visitor-v1"

export function portalVisitorId(
  ip: string,
  userAgent: string,
  workspaceId: string,
): string {
  return createHash("sha256")
    .update(`${VISITOR_SALT}|${workspaceId}|${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 32)
}

function hashQuery(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

// Kill-switch for the portal-analytics write path. Set
// BREAD_PORTAL_ANALYTICS_DISABLED=1 to shed all portal_events inserts
// instantly (no deploy) — reads still work off whatever has been captured.
//
// We also drop all captures outside production. Local dev (`next dev`,
// NODE_ENV=development) talks to the SAME prod Supabase, so without this guard
// your own localhost testing inflates unique-visitor and event counts (this is
// exactly how localhost:3001 traffic showed up in prod analytics). Set
// BREAD_PORTAL_ANALYTICS_FORCE=1 to capture anyway when intentionally testing
// the write path locally.
function portalAnalyticsDisabled(): boolean {
  if (process.env.BREAD_PORTAL_ANALYTICS_DISABLED === "1") return true
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.BREAD_PORTAL_ANALYTICS_FORCE !== "1"
  ) {
    return true
  }
  return false
}

export interface LogPortalEventInput {
  workspaceId: string
  /** Published portal project, or null for the default workspace docs portal. */
  experienceId: string | null
  eventType: PortalAnalyticsEventType
  visitorId: string
  documentId?: string | null
  path?: string | null
  queryText?: string | null
  resultCount?: number | null
  referrerHost?: string | null
}

export function logPortalEvent(input: LogPortalEventInput): void {
  if (portalAnalyticsDisabled()) return
  void (async (): Promise<void> => {
    try {
      const admin = createAdminClient()
      const { error } = await admin.from("portal_events").insert({
        workspace_id: input.workspaceId,
        experience_id: input.experienceId,
        event_type: input.eventType,
        visitor_id: input.visitorId,
        document_id: input.documentId ?? null,
        path: input.path ?? null,
        query_text: input.queryText ?? null,
        query_hash: input.queryText ? hashQuery(input.queryText) : null,
        result_count: input.resultCount ?? null,
        referrer_host: input.referrerHost ?? null,
      })
      if (error) {
        console.error("[Bread] logPortalEvent insert error:", error.message)
      }
    } catch (err) {
      console.error("[Bread] logPortalEvent threw:", err)
    }
  })()
}
