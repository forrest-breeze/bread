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

export function withPublicPortalHtml(
  html: string,
  portalBase: string,
  hrefBase: string,
): string {
  const internalBase = `/p/${portalBase}`
  if (hrefBase === internalBase) return html
  return html.replace(
    /(<a\b[^>]*\bhref=["'])([^"']+)(["'])/gi,
    (_match, prefix: string, href: string, quote: string) =>
      `${prefix}${replaceInternalBase(href, internalBase, hrefBase)}${quote}`,
  )
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
    ? `${hrefBase}/_bread/api/${endpoint}`
    : `/api/public/${endpoint}`
}
