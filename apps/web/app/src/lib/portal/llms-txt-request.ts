// ---------------------------------------------------------------------------
// Routing + public-URL resolution for the portal llms.txt files.
//
// A portal's llms.txt must be reachable at the mount a visitor actually uses:
//
//   app.example.com/p/acme/help/llms.txt   direct internal address
//   help.acme.com/llms.txt               host-wide custom domain / subdomain
//   acme.com/help/llms.txt               path mount (Cloudflare Worker proxy)
//
// All three arrive at the internal `/p/<workspace>[/<project>]/llms.txt` path
// (the proxy resolves the host first). A page route can't answer with
// text/plain, so the proxy rewrites that path onto the public API route below.
//
// This module is PURE and dependency-free: the proxy (middleware) and the route
// both import it, so it must not pull in `server-only`, React cache, or any
// Node built-in.
// ---------------------------------------------------------------------------

export type PortalLlmsVariant = "index" | "full"

export const PORTAL_LLMS_API_PATH = "/api/public/llms"

const FILENAME_VARIANTS: Record<string, PortalLlmsVariant> = {
  "llms.txt": "index",
  "llms-full.txt": "full",
}

export function portalLlmsFilename(variant: PortalLlmsVariant): string {
  return variant === "full" ? "llms-full.txt" : "llms.txt"
}

export interface PortalLlmsTarget {
  /** Portal base path without the `/p/` mount: `<ws>` or `<ws>/<project>`. */
  base: string
  variant: PortalLlmsVariant
}

/**
 * Parse an internal portal path into an llms.txt request, or null when it isn't
 * one. Structural segments are rejected so a document whose slug happens to end
 * in `llms.txt` (`/p/acme/doc/llms.txt`) still renders as a document.
 */
export function parsePortalLlmsPath(pathname: string): PortalLlmsTarget | null {
  const segments = pathname.split("/").filter(Boolean)
  if (segments.length < 3 || segments[0] !== "p") return null

  const variant = FILENAME_VARIANTS[segments[segments.length - 1].toLowerCase()]
  if (!variant) return null

  // [p, workspace, (project)?, file]
  const middle = segments.slice(1, -1)
  if (middle.length < 1 || middle.length > 2) return null
  if (middle.some((segment) => segment === "doc" || segment === "folder")) {
    return null
  }
  return { base: middle.join("/"), variant }
}

/** Internal API URL (path + query) that serves a parsed llms.txt request. */
export function portalLlmsApiSearch(target: PortalLlmsTarget): string {
  const params = new URLSearchParams({ portal: target.base })
  if (target.variant === "full") params.set("variant", "full")
  return params.toString()
}

// Trusted proxy markers — kept in sync with proxy.ts, which validates the
// marker before any forwarding header is believed.
export const PORTAL_PROXY_MARKERS: ReadonlySet<string> = new Set([
  "cloudflare-worker-v1",
  "reverse-proxy-v1",
])

/** Minimal read-only view of request headers (Headers or Next's ReadonlyHeaders). */
export interface HeaderReader {
  get(name: string): string | null
}

function firstHeaderValue(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? ""
}

function hostOnly(value: string | null): string {
  const host = firstHeaderValue(value).split(":")[0].toLowerCase()
  return host.includes("/") ? "" : host
}

/**
 * Normalize a mount path: "/" (whole host), "/help" (path mount), or null when
 * absent/internal. An internal `/p/...` value is not a public mount.
 */
export function normalizePortalMountPath(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim()
  if (!raw || !raw.startsWith("/")) return null
  const normalized = raw.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/"
  if (normalized.startsWith("/p/")) return null
  return normalized
}

/**
 * Absolute public base URL of the portal serving this request, derived from the
 * proxy's forwarding headers:
 *
 *   x-bread-portal-host      set by the custom-domain rewrite (real Host)
 *   x-forwarded-host          set by the Worker proxy (trusted only with a marker)
 *   x-bread-base-path        Worker mount path
 *   x-bread-portal-mount-path custom-domain / subdomain mount path
 *
 * Falls back to the request Host and the internal `/p/<base>` path, which is
 * always a valid address for the portal.
 */
export function resolvePortalPublicUrl(
  headers: HeaderReader,
  internalBase: string,
): string {
  const proxied = PORTAL_PROXY_MARKERS.has(
    headers.get("x-bread-proxy")?.trim() ?? "",
  )
  const host =
    hostOnly(headers.get("x-bread-portal-host")) ||
    (proxied ? hostOnly(headers.get("x-forwarded-host")) : "") ||
    hostOnly(headers.get("host"))
  const forwardedProto = firstHeaderValue(headers.get("x-forwarded-proto"))
  const isLocal = host === "localhost" || host.endsWith(".localhost")
  const protocol = forwardedProto || (isLocal ? "http" : "https")

  const port = firstHeaderValue(headers.get("host")).split(":")[1] ?? ""
  const authority = isLocal && port ? `${host}:${port}` : host

  const mount =
    normalizePortalMountPath(headers.get("x-bread-base-path")) ??
    normalizePortalMountPath(headers.get("x-bread-portal-mount-path"))
  const path = mount === "/" ? "" : (mount ?? `/p/${internalBase}`)

  return `${protocol}://${authority}${path}`
}
