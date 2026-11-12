import { resolveCustomDomainRoute } from "@/lib/public-kb-domain"

// ---------------------------------------------------------------------------
// Post-login `next` sanitization. Edge-safe (imported by the middleware as well
// as server routes): no `server-only`, no next/headers.
//
// Relative app paths pass through. An ABSOLUTE URL — a private portal's clean
// public address on a custom-domain mount — is allowed only when BOTH hold:
//   1. its host is covered by the shared auth cookie domain
//      (NEXT_PUBLIC_AUTH_COOKIE_DOMAIN, e.g. ".example.com") — otherwise the
//      visitor lands back on a host that cannot see their session and the
//      private-portal gate bounces them to /login forever;
//   2. its host+path resolve to a configured portal domain route in the DB —
//      otherwise ?next= is an open redirect.
// Everything else falls back to Knowledge.
// ---------------------------------------------------------------------------

export const POST_LOGIN_FALLBACK = "/knowledge"

/** True when the app's auth cookie is visible on `host` (shared cookie domain). */
export function hostSharesAuthCookieDomain(host: string): boolean {
  const configured = (process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN ?? "")
    .trim()
    .toLowerCase()
  if (!configured) return false
  const suffix = configured.replace(/^\./, "")
  const normalized = host.trim().toLowerCase()
  return normalized === suffix || normalized.endsWith(`.${suffix}`)
}

export async function sanitizePostLoginNext(
  raw: string | null | undefined,
): Promise<string> {
  if (!raw) return POST_LOGIN_FALLBACK
  if (raw.startsWith("/")) {
    // Protocol-relative ("//evil.com") and backslash-scheme tricks are not
    // in-app paths.
    return raw.startsWith("//") || raw.includes("\\") ? POST_LOGIN_FALLBACK : raw
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return POST_LOGIN_FALLBACK
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return POST_LOGIN_FALLBACK
  }
  if (!hostSharesAuthCookieDomain(url.hostname)) return POST_LOGIN_FALLBACK
  const route = await resolveCustomDomainRoute(url.hostname, url.pathname)
  if (!route) return POST_LOGIN_FALLBACK
  return `${url.origin}${url.pathname}${url.search}`
}
