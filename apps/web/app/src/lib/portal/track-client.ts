/**
 * Client-side portal analytics beacon. Best-effort: never throws, never blocks
 * navigation. Prefers navigator.sendBeacon (survives page unload), falling back
 * to a keepalive fetch. The server route (/api/public/track) does the real
 * gating, visitor hashing, and persistence.
 */

import { publicPortalApiPath } from "@/lib/portal/public-base-path"

export type PortalTrackType =
  | "pageview"
  | "doc_view"
  | "search"
  | "search_click"
  | "helpful"
  | "not_helpful"

export interface PortalTrackInput {
  /** Portal base path: "<workspace>" or "<workspace>/<project>". */
  portal: string
  type: PortalTrackType
  documentId?: string
  path?: string
  /** Committed query text — only for `search`. */
  query?: string
  /** Result count at commit time — only for `search`. */
  resultCount?: number
}

export function trackPortalEvent(input: PortalTrackInput): void {
  if (typeof window === "undefined") return
  try {
    const body = JSON.stringify(input)
    const endpoint = publicPortalApiPath("track")
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" })
      navigator.sendBeacon(endpoint, blob)
      return
    }
    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    })
  } catch {
    // Analytics is best-effort; swallow everything.
  }
}
