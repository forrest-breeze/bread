"use client"

import { useEffect, useRef } from "react"
import { trackPortalEvent } from "@/lib/portal/track-client"

interface PortalViewBeaconProps {
  slug: string
  type: "pageview" | "doc_view"
  /** Required for doc_view; identifies the article. */
  documentId?: string
}

/**
 * Fires a single analytics beacon when a public portal page actually mounts in
 * a real browser. Client-side on purpose: Next.js route prefetch and crawlers
 * fetch the server payload without ever mounting this component, so view counts
 * reflect real visits rather than prefetches.
 *
 * When a doc is opened from a search surface (?ref=search), it additionally
 * fires a search_click so the Reporting page can compute search CTR.
 */
export function PortalViewBeacon({
  slug,
  type,
  documentId,
}: PortalViewBeaconProps): null {
  const fired = useRef(false)
  useEffect(() => {
    // Guard against React StrictMode's double-invoke in development.
    if (fired.current) return
    fired.current = true

    const path =
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : undefined

    trackPortalEvent({ portal: slug, type, documentId, path })

    if (type === "doc_view" && documentId && typeof window !== "undefined") {
      const ref = new URLSearchParams(window.location.search).get("ref")
      if (ref === "search") {
        trackPortalEvent({ portal: slug, type: "search_click", documentId, path })
      }
    }
  }, [slug, type, documentId])

  return null
}
