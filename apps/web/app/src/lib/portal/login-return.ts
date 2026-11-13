import "server-only"

import { cache } from "react"
import { headers } from "next/headers"
import {
  customDomainCanonicalPath,
  resolveCustomDomainProjectRoute,
} from "@/lib/public-kb-domain"
import { hostSharesAuthCookieDomain } from "@/lib/portal/login-next"

export { sanitizePostLoginNext, POST_LOGIN_FALLBACK } from "@/lib/portal/login-next"

// ---------------------------------------------------------------------------
// Post-login return URLs for private portals on custom domains.
//
// A private portal reached at its clean public address (example.com/docs, or a
// customer's docs.acme.com) must round-trip the login on the APP origin — auth
// cookies live there — and then land back on the public address, not on the
// internal /p/<ws>/<project> tree. That only works when the session is visible
// on the portal host, i.e. the host is covered by the shared auth cookie
// domain (NEXT_PUBLIC_AUTH_COOKIE_DOMAIN); for any other host the visitor
// would come back unauthenticated and loop through /login forever, so those
// keep the internal path (post-login lands on the app host, where the session
// lives).
//
// The absolute `next` is an open-redirect surface, so both ends validate
// against the portal-domain routes in the DB:
//   • build side (here): the forwarded host must resolve to a configured route
//     for this exact workspace/project;
//   • consume side (sanitizePostLoginNext in login-next.ts): an absolute
//     `next` must resolve to SOME configured portal route for its host+path.
// Spoofed proxy headers or a crafted ?next= can therefore only ever send a
// visitor to a real portal's real public address.
// ---------------------------------------------------------------------------

const REVERSE_PROXY_MARKERS = new Set([
  "cloudflare-worker-v1",
  "reverse-proxy-v1",
])

/**
 * The public host this portal request arrived on, from proxy metadata: the
 * middleware-stamped rewrite header (direct custom domains) or the trusted
 * reverse-proxy forwarding pair (Cloudflare Worker mounts, which skip the
 * middleware rewrite on /p/*). Null for plain app-host requests.
 */
function forwardedPortalHost(h: Headers): string | null {
  const stamped = h.get("x-breezify-portal-host")?.split(":")[0].trim().toLowerCase()
  if (stamped && stamped.includes(".") && !stamped.includes("/")) return stamped
  const marker = h.get("x-breezify-proxy") ?? ""
  if (!REVERSE_PROXY_MARKERS.has(marker)) return null
  const forwarded = (h.get("x-forwarded-host") ?? "")
    .split(",")[0]
    ?.trim()
    .split(":")[0]
    .toLowerCase()
  if (!forwarded || !forwarded.includes(".") || forwarded.includes("/")) {
    return null
  }
  return forwarded
}

/**
 * The login-return path for a portal request: the absolute clean public URL
 * when the request arrived through a validated custom-domain mount whose host
 * shares the auth cookie domain, otherwise the internal `/p/...` path
 * unchanged. React-cached so the route layout, its generateMetadata, and the
 * page share one resolution per request.
 */
export const portalPublicNextPath = cache(
  async (
    workspaceSlug: string,
    projectSlug: string | null,
    internalPath: string,
  ): Promise<string> => {
    const h = await headers()
    const host = forwardedPortalHost(h)
    if (!host || !hostSharesAuthCookieDomain(host)) return internalPath
    const route = await resolveCustomDomainProjectRoute(
      host,
      workspaceSlug,
      projectSlug,
    )
    if (!route) return internalPath
    const canonical = customDomainCanonicalPath(route, internalPath)
    if (!canonical) return internalPath
    return `https://${host}${canonical}`
  },
)
