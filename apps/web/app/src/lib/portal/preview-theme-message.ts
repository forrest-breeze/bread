export const PORTAL_PREVIEW_THEME_MESSAGE = "breezify:portal-preview-theme"
export const PORTAL_PREVIEW_THEME_READY_MESSAGE =
  "breezify:portal-preview-theme-ready"

export type PortalPreviewThemeMode = "light" | "dark"

export interface PortalPreviewThemeMessage {
  type: typeof PORTAL_PREVIEW_THEME_MESSAGE
  mode: PortalPreviewThemeMode
}

export interface PortalPreviewThemeReadyMessage {
  type: typeof PORTAL_PREVIEW_THEME_READY_MESSAGE
}

export function createPortalPreviewThemeMessage(
  mode: PortalPreviewThemeMode,
): PortalPreviewThemeMessage {
  return { type: PORTAL_PREVIEW_THEME_MESSAGE, mode }
}

export function createPortalPreviewThemeReadyMessage(): PortalPreviewThemeReadyMessage {
  return { type: PORTAL_PREVIEW_THEME_READY_MESSAGE }
}

export function isPortalPreviewThemeMessage(
  value: unknown,
): value is PortalPreviewThemeMessage {
  if (!value || typeof value !== "object") return false

  const candidate = value as Partial<PortalPreviewThemeMessage>
  return (
    candidate.type === PORTAL_PREVIEW_THEME_MESSAGE &&
    (candidate.mode === "light" || candidate.mode === "dark")
  )
}

export function isPortalPreviewThemeReadyMessage(
  value: unknown,
): value is PortalPreviewThemeReadyMessage {
  if (!value || typeof value !== "object") return false

  const candidate = value as Partial<PortalPreviewThemeReadyMessage>
  return candidate.type === PORTAL_PREVIEW_THEME_READY_MESSAGE
}
