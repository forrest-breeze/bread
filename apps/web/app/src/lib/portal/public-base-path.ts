import type { PortalLayout } from "@/lib/portal/schema"

function normalizedMountPath(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw || !raw.startsWith("/")) return null
  const normalized = raw.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/"
  if (normalized === "/" || normalized.startsWith("/p/")) return null
  return normalized
}

export function publicPortalBasePath(
  portalBase: string,
  proxyMountPath?: string | null,
): string {
  return normalizedMountPath(proxyMountPath) ?? `/p/${portalBase}`
}

export function publicPortalHref(
  hrefBase: string,
  suffix = "",
): string {
  if (!suffix) return hrefBase
  if (suffix.startsWith("?") || suffix.startsWith("#")) return `${hrefBase}${suffix}`
  return `${hrefBase}${suffix.startsWith("/") ? suffix : `/${suffix}`}`
}

/**
 * The address this portal had while it was still its workspace's default
 * project, or null when it never could have had one.
 *
 * A default project's slug equals its workspace's slug and it is served from
 * `/p/<slug>`. Renaming the workspace turns it into a named project at
 * `/p/<workspace>/<slug>`, but links written into document bodies before the
 * rename still say `/p/<slug>/…`, which now names a workspace that does not
 * exist.
 */
function formerRootBase(portalBase: string): string | null {
  const [workspaceSlug, projectSlug, ...rest] = portalBase.split("/")
  if (!workspaceSlug || !projectSlug || rest.length > 0) return null
  if (projectSlug === workspaceSlug) return null
  return `/p/${projectSlug}`
}

const PORTAL_VIEW_PREFIXES = ["/doc/", "/page/", "/folder/"]

function replaceFormerRootBase(
  value: string,
  formerBase: string,
  hrefBase: string,
): string {
  if (!value.startsWith(`${formerBase}/`)) return value
  const rest = value.slice(formerBase.length)
  // Only content views: `/p/<slug>/<anything else>` may be a real address.
  return PORTAL_VIEW_PREFIXES.some((prefix) => rest.startsWith(prefix))
    ? `${hrefBase}${rest}`
    : value
}

export function withPublicPortalHtml(
  html: string,
  portalBase: string,
  hrefBase: string,
): string {
  const internalBase = `/p/${portalBase}`
  const formerBase = formerRootBase(portalBase)
  const appOrigin = publicAppOrigin()
  if (hrefBase === internalBase && !formerBase && !appOrigin) return html
  return html.replace(
    /(<a\b[^>]*\bhref=["'])([^"']+)(["'])/gi,
    (_match, prefix: string, href: string, quote: string) => {
      const rebased = formerBase
        ? replaceFormerRootBase(href, formerBase, hrefBase)
        : href
      const resolved = replaceInternalBase(rebased, internalBase, hrefBase)
      return `${prefix}${withAppOrigin(resolved, hrefBase, appOrigin)}${quote}`
    },
  )
}

/**
 * The app's public origin from `NEXT_PUBLIC_APP_URL` (the deployed URL in
 * production, the dev server locally), or "" when it is unset or not http(s).
 */
function publicAppOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!raw) return ""
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : ""
  } catch {
    return ""
  }
}

/**
 * Make a root-relative app asset (e.g. the seeded "/breeze-icon.png" workspace
 * icon) absolute on the app origin. Portals also render on custom domains and
 * reverse-proxy mounts, where a root-relative path would 404. Absolute URLs
 * and protocol-relative ones pass through unchanged.
 */
export function appAbsoluteAssetUrl(url: string | null): string | null {
  if (!url || !url.startsWith("/") || url.startsWith("//")) return url
  const origin = publicAppOrigin()
  return origin ? `${origin}${url}` : url
}

// Document links into the portal are made absolute on the app's public origin,
// so they open the real page wherever the body happens to be rendered. A
// reverse-proxy mount is already the portal's public address and stays as is.
function withAppOrigin(href: string, hrefBase: string, appOrigin: string): string {
  if (!appOrigin || !hrefBase.startsWith("/p/")) return href
  const inPortal =
    href === hrefBase ||
    href.startsWith(`${hrefBase}/`) ||
    href.startsWith(`${hrefBase}?`) ||
    href.startsWith(`${hrefBase}#`)
  return inPortal ? `${appOrigin}${href}` : href
}

function replaceInternalBase(
  value: string,
  internalBase: string,
  hrefBase: string,
): string {
  if (value === internalBase) return hrefBase
  if (
    value.startsWith(`${internalBase}/`) ||
    value.startsWith(`${internalBase}?`) ||
    value.startsWith(`${internalBase}#`)
  ) {
    return `${hrefBase}${value.slice(internalBase.length)}`
  }
  return value
}

const LINK_KEYS = new Set(["href", "action", "target"])

function rewriteLinkValues(
  value: unknown,
  internalBase: string,
  hrefBase: string,
  key?: string,
): unknown {
  if (typeof value === "string") {
    if (key && LINK_KEYS.has(key)) {
      return replaceInternalBase(value, internalBase, hrefBase)
    }
    if (key === "html") {
      return withPublicPortalHtml(
        value,
        internalBase.slice("/p/".length),
        hrefBase,
      )
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteLinkValues(entry, internalBase, hrefBase))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        rewriteLinkValues(entryValue, internalBase, hrefBase, entryKey),
      ]),
    )
  }
  return value
}

export function withPublicPortalBase(
  layout: PortalLayout,
  portalBase: string,
  hrefBase: string,
): PortalLayout {
  const internalBase = `/p/${portalBase}`
  if (hrefBase === internalBase) return layout
  return rewriteLinkValues(layout, internalBase, hrefBase) as PortalLayout
}

export function publicPortalApiPath(
  endpoint: "ask" | "search" | "track" | "translate",
): string {
  if (typeof document === "undefined") return `/api/public/${endpoint}`
  const root = document.querySelector<HTMLElement>("[data-portal-href-base]")
  const hrefBase = normalizedMountPath(root?.dataset.portalHrefBase)
  return hrefBase
    ? `${hrefBase}/_breezify/api/${endpoint}`
    : `/api/public/${endpoint}`
}
