"use client"

import { useEffect } from "react"

/** Reset the viewport after client-side navigation replaces the current document. */
export function PortalDocumentScrollReset({
  documentId,
}: {
  documentId: string
}): null {
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  }, [documentId])

  return null
}
