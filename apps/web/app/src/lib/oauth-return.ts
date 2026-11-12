import type { NextRequest } from "next/server"

const LOCAL_URL_BASE = "https://bread.local"
const ALLOWED_RETURN_PATHS = ["/settings", "/knowledge", "/kb"]

export function sanitizeOAuthReturnPath(
  rawPath: string | null | undefined,
  fallbackPath: string,
): string {
  if (!rawPath) return fallbackPath
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return fallbackPath

  try {
    const url = new URL(rawPath, LOCAL_URL_BASE)
    const allowed = ALLOWED_RETURN_PATHS.some((path) =>
      url.pathname === path || url.pathname.startsWith(`${path}/`),
    )
    if (!allowed) return fallbackPath
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallbackPath
  }
}

export function appendOAuthResult(
  path: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(path, LOCAL_URL_BASE)
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value)
  }
  return `${url.pathname}${url.search}${url.hash}`
}

export function absoluteOAuthReturnUrl(
  request: NextRequest,
  path: string,
): string {
  const requestOrigin = new URL(request.url).origin
  const base =
    process.env.NODE_ENV === "development"
      ? requestOrigin
      : process.env.NEXT_PUBLIC_APP_URL || requestOrigin

  return new URL(path, base).toString()
}
