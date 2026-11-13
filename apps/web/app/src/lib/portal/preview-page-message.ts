// Preview → editor page reporting.
//
// The preview iframe navigates between portal pages on its own (the portal
// header's page nav is a real link), so the editor cannot learn the previewed
// page from the src it committed. The preview posts this message on every
// render so the builder can keep its page switcher, document rail, and page
// controls pointed at whatever the preview is actually showing.

export const PORTAL_PREVIEW_PAGE_MESSAGE = "breezify:portal-preview-page"

export interface PortalPreviewPageMessage {
  type: typeof PORTAL_PREVIEW_PAGE_MESSAGE
  /** Project-local page slug; null is the portal home. */
  page: string | null
}

export function createPortalPreviewPageMessage(
  page: string | null,
): PortalPreviewPageMessage {
  return { type: PORTAL_PREVIEW_PAGE_MESSAGE, page }
}

export function isPortalPreviewPageMessage(
  value: unknown,
): value is PortalPreviewPageMessage {
  if (!value || typeof value !== "object") return false

  const candidate = value as Partial<PortalPreviewPageMessage>
  return (
    candidate.type === PORTAL_PREVIEW_PAGE_MESSAGE &&
    (candidate.page === null || typeof candidate.page === "string")
  )
}
