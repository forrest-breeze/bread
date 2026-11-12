export const PRIVATE_PORTAL_LOGIN_CONTEXT = "private-portal"

/**
 * Build the shared login URL while preserving the private portal destination.
 *
 * `nextPath` is either an internal `/p/...` path or the validated absolute
 * public URL of a custom-domain mount (see portalPublicNextPath). The absolute
 * form must round-trip on the app origin — the visitor is on the customer's
 * domain, where a relative `/login` would 404 — so the login href itself goes
 * absolute too.
 */
export function privatePortalLoginHref(nextPath: string, slug: string): string {
  const isPublicUrl = nextPath.startsWith("https://")
  const safeNext =
    isPublicUrl || nextPath.startsWith("/") ? nextPath : `/p/${slug}`
  const params = new URLSearchParams({
    next: safeNext,
    context: PRIVATE_PORTAL_LOGIN_CONTEXT,
  })
  const appOrigin = isPublicUrl
    ? (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")
    : ""
  return `${appOrigin}/login?${params.toString()}`
}

/** Only show portal-specific login copy for a validated portal return path. */
export function isPrivatePortalLogin(
  context: string | null,
  nextPath: string,
): boolean {
  return (
    context === PRIVATE_PORTAL_LOGIN_CONTEXT &&
    (nextPath.startsWith("/p/") || nextPath.startsWith("https://"))
  )
}
