import { createClient } from "@supabase/supabase-js"
import { supabaseSecretKey, supabaseUrl } from "@/lib/supabase/env"

// ---------------------------------------------------------------------------
// Custom-domain → public-KB slug resolution for the proxy (middleware).
//
// An inbound custom Host can resolve through either a project-level route
// (`portal_domain_routes`) or the legacy workspace custom-domain setting. The
// project-level form supports both dedicated hosts and shared-host path mounts.
//
// IMPORTANT: this module is imported by the edge middleware, so it must NOT pull
// in `server-only` or React `cache`. It uses a bare supabase-js client and a
// small in-process TTL cache to bound DB hits to ~one per host per TTL window.
// Legacy routes only return `kb_public` workspaces. Structured routes are gated
// by the target project's public/private visibility in the `/p` route itself,
// so resolving a route never bypasses portal access control.
// ---------------------------------------------------------------------------

const TTL_MS = 60_000
const NEGATIVE = Symbol("no-match")

type CacheEntry = { slug: string | typeof NEGATIVE; at: number }
const cache = new Map<string, CacheEntry>()
type RouteCacheEntry = { routes: ResolvedCustomDomainRoute[]; at: number }
const routeCache = new Map<string, RouteCacheEntry>()
// Separate namespace so a subdomain slug ("docs") can never collide with a
// custom domain key ("docs.acme.com") in the shared cache.
const subdomainCache = new Map<string, CacheEntry>()

export interface ResolvedCustomDomainRoute {
  workspaceSlug: string
  /** Null only for the legacy workspace-wide custom-domain fallback. */
  projectSlug: string | null
  /** External mount point. `/` means the project owns the whole host. */
  pathPrefix: string
}

const PROJECT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/
const PATH_PREFIX_RE =
  /^\/(?:[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)(?:\/[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)*$/

function normalizePathPrefix(value: unknown): string | null {
  if (value === "/") return "/"
  if (typeof value !== "string") return null
  const normalized = value.replace(/\/+$/, "")
  return PATH_PREFIX_RE.test(normalized) ? normalized : null
}

function routeMatchesPath(
  route: ResolvedCustomDomainRoute,
  pathname: string,
): boolean {
  return (
    route.pathPrefix === "/" ||
    pathname === route.pathPrefix ||
    pathname.startsWith(`${route.pathPrefix}/`)
  )
}

/** Select the most-specific configured mount for an inbound path. */
export function matchCustomDomainRoute(
  routes: readonly ResolvedCustomDomainRoute[],
  pathname: string,
): ResolvedCustomDomainRoute | null {
  return (
    routes
      .filter((route) => routeMatchesPath(route, pathname))
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0] ?? null
  )
}

/**
 * Translate an external custom-domain path to the internal portal route.
 *
 *   docs.customer.com/doc/install + `/`     -> /p/acme/docs/doc/install
 *   customer.com/docs/doc/install + `/docs` -> /p/acme/docs/doc/install
 */
export function customDomainRewritePath(
  route: ResolvedCustomDomainRoute,
  pathname: string,
): string | null {
  if (!route.projectSlug || !routeMatchesPath(route, pathname)) return null

  const remainder =
    route.pathPrefix === "/" ? pathname : pathname.slice(route.pathPrefix.length)
  const suffix = !remainder || remainder === "/" ? "" : remainder
  const internalBase =
    route.projectSlug === route.workspaceSlug
      ? `/p/${route.workspaceSlug}`
      : `/p/${route.workspaceSlug}/${route.projectSlug}`
  return `${internalBase}${suffix}`
}

/** Convert an internal `/p/...` project URL back to its clean external mount. */
export function customDomainCanonicalPath(
  route: ResolvedCustomDomainRoute,
  pathname: string,
): string | null {
  const namedProjectSlug =
    route.projectSlug && route.projectSlug !== route.workspaceSlug
      ? route.projectSlug
      : null
  const internalBase = `/p/${route.workspaceSlug}${
    namedProjectSlug ? `/${namedProjectSlug}` : ""
  }`
  if (
    pathname !== internalBase &&
    !pathname.startsWith(`${internalBase}/`)
  ) {
    return null
  }

  const remainder = pathname.slice(internalBase.length)
  if (route.pathPrefix === "/") return remainder || "/"
  return `${route.pathPrefix}${remainder}`
}

function adminClient(): ReturnType<typeof createClient> | null {
  const url = supabaseUrl()
  const key = supabaseSecretKey()
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Resolve a custom-domain Host to a published workspace slug, or null. Never
 * throws — any failure resolves to null so the proxy falls through cleanly.
 */
export async function resolveCustomDomainSlug(
  host: string,
): Promise<string | null> {
  const domain = host.split(":")[0].trim().toLowerCase()
  if (!domain || !domain.includes(".")) return null

  const hit = cache.get(domain)
  const now = Date.now()
  if (hit && now - hit.at < TTL_MS) {
    return hit.slug === NEGATIVE ? null : hit.slug
  }

  try {
    const admin = adminClient()
    if (!admin) return null
    // Containment (`settings @> {...}`) is served by the existing
    // workspaces_settings_gin_idx, so no dedicated index is required.
    const { data, error } = await admin
      .from("workspaces")
      .select("slug, settings")
      .contains("settings", { kb_custom_domain: domain })
      .limit(1)
      .maybeSingle()

    const row = data as
      | { slug: string; settings: Record<string, unknown> | null }
      | null
    const slug =
      !error &&
      row &&
      row.settings?.kb_public === true &&
      row.settings?.portal_address_scope !== "project" &&
      row.settings?.portal_address_mode !== "bread"
        ? row.slug
        : null

    cache.set(domain, { slug: slug ?? NEGATIVE, at: now })
    return slug
  } catch {
    cache.set(domain, { slug: NEGATIVE, at: now })
    return null
  }
}

async function loadCustomDomainRoutes(
  domain: string,
): Promise<ResolvedCustomDomainRoute[] | null> {
  const hit = routeCache.get(domain)
  const now = Date.now()
  if (hit && now - hit.at < TTL_MS) return hit.routes

  try {
    const admin = adminClient()
    if (!admin) return null
    const { data, error } = await admin
      .from("portal_domain_routes")
      .select(
        "project_slug, path_prefix, workspace:workspaces!inner(slug,settings)",
      )
      .eq("domain", domain)

    // A deployment can briefly run this code before its migration lands. In
    // that case, fall back to the legacy workspace custom-domain setting.
    if (error) return null

    const routes = (data ?? []).flatMap((value) => {
      const row = value as {
        project_slug?: unknown
        path_prefix?: unknown
        workspace?:
          | { slug?: unknown; settings?: Record<string, unknown> | null }
          | { slug?: unknown; settings?: Record<string, unknown> | null }[]
          | null
      }
      const workspace = Array.isArray(row.workspace)
        ? row.workspace[0]
        : row.workspace
      const workspaceSlug = workspace?.slug
      const projectSlug = row.project_slug
      const pathPrefix = normalizePathPrefix(row.path_prefix)
      if (
        workspace?.settings?.portal_address_scope === "workspace" ||
        typeof workspaceSlug !== "string" ||
        typeof projectSlug !== "string" ||
        !PROJECT_SLUG_RE.test(projectSlug) ||
        !pathPrefix
      ) {
        return []
      }
      return [{ workspaceSlug, projectSlug, pathPrefix }]
    })

    routeCache.set(domain, { routes, at: now })
    return routes
  } catch {
    return null
  }
}

/**
 * Resolve a host + path to a project-level custom-domain route. Structured
 * routes take precedence over the legacy workspace-wide custom domain. When a
 * host has structured routes but none match the requested path, the request
 * deliberately falls through instead of exposing the entire workspace.
 */
export async function resolveCustomDomainRoute(
  host: string,
  pathname: string,
): Promise<ResolvedCustomDomainRoute | null> {
  const domain = host.split(":")[0].trim().toLowerCase()
  if (!domain || !domain.includes(".")) return null

  const routes = await loadCustomDomainRoutes(domain)
  if (routes && routes.length > 0) {
    return matchCustomDomainRoute(routes, pathname)
  }

  const workspaceSlug = await resolveCustomDomainSlug(domain)
  if (!workspaceSlug) return null

  // Legacy custom domains own the workspace root. Their first path segment is
  // still interpreted as a named project by the existing /p route parser.
  return { workspaceSlug, projectSlug: null, pathPrefix: "/" }
}

/** Resolve an internal project address to its clean route on a custom host. */
export async function resolveCustomDomainProjectRoute(
  host: string,
  workspaceSlug: string,
  projectSlug: string | null,
): Promise<ResolvedCustomDomainRoute | null> {
  const domain = host.split(":")[0].trim().toLowerCase()
  if (!domain || !domain.includes(".")) return null

  const routes = await loadCustomDomainRoutes(domain)
  if (routes && routes.length > 0) {
    return (
      routes.find(
        (route) =>
          route.workspaceSlug === workspaceSlug &&
          route.projectSlug === (projectSlug ?? workspaceSlug),
      ) ?? null
    )
  }

  const legacyWorkspaceSlug = await resolveCustomDomainSlug(domain)
  if (legacyWorkspaceSlug !== workspaceSlug) return null
  return {
    workspaceSlug,
    projectSlug,
    pathPrefix: projectSlug ? `/${projectSlug}` : "/",
  }
}

/**
 * Resolve a public-KB subdomain label (the workspace `slug`) to that workspace's
 * slug, or null. Only **published** (`kb_public === true`) workspaces resolve, so
 * an unpublished or unknown slug never serves content — same guarantee as
 * {@link resolveCustomDomainSlug}. Never throws; caller falls through on null.
 *
 * Results are cached for `TTL_MS` (60s), so unpublishing or renaming a slug has
 * up to a 60s eventual-consistency window at the proxy. This cannot leak private
 * content: the `/p/<slug>` portal page re-checks `kb_public` per request
 * (`requirePortalWorkspace`) and 404s/redirects a now-private KB regardless.
 */
export async function resolveSubdomainSlug(
  slug: string,
): Promise<string | null> {
  const s = slug.trim().toLowerCase()
  if (!s) return null

  const hit = subdomainCache.get(s)
  const now = Date.now()
  if (hit && now - hit.at < TTL_MS) {
    return hit.slug === NEGATIVE ? null : hit.slug
  }

  try {
    const admin = adminClient()
    if (!admin) return null
    // Served by the unique workspaces_slug_key index.
    const { data, error } = await admin
      .from("workspaces")
      .select("slug, settings")
      .eq("slug", s)
      .limit(1)
      .maybeSingle()

    const row = data as
      | { slug: string; settings: Record<string, unknown> | null }
      | null
    const resolved =
      !error && row && row.settings?.kb_public === true ? row.slug : null

    subdomainCache.set(s, { slug: resolved ?? NEGATIVE, at: now })
    return resolved
  } catch {
    subdomainCache.set(s, { slug: NEGATIVE, at: now })
    return null
  }
}
