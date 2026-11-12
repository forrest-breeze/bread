"use client"

import { useEffect } from "react"
import { createPortalPreviewPageMessage } from "@/lib/portal/preview-page-message"

/**
 * Renders nothing; tells the builder which portal page the preview is showing.
 *
 * In-frame page navigation is a plain link, so the iframe changes page without
 * the editor knowing. Posting on every page change lets the builder mirror the
 * preview in its sidebar page switcher and page controls. Only mounted by
 * `/portal-preview` — the public portal never reports to a parent frame.
 */
export function PortalPreviewPageReporter({
  pageSlug,
}: {
  pageSlug: string | null
}): null {
  useEffect(() => {
    if (window.parent === window) return
    window.parent.postMessage(
      createPortalPreviewPageMessage(pageSlug),
      window.location.origin,
    )
  }, [pageSlug])

  return null
}
