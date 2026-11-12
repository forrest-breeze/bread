import "server-only"

import { unstable_cache } from "next/cache"
import { createAdminClient } from "@/lib/supabase/admin"
import { PUBLIC_KB_CACHE_TAG, type PortalScopeEntry } from "@/lib/public-kb"
import { validatePortalLayout, type PortalLayout } from "@/lib/portal/schema"
import { portalContentScope } from "@/lib/portal/project-scope"

// Re-exported so the write-side (experiences-write.ts) and the publish/rollback
// API routes can `revalidateTag(PUBLIC_KB_CACHE_TAG)` without importing the
// public-kb module directly — the tag is the contract the read cache above keys
// on, so it lives alongside the resolver that registers it.
export { PUBLIC_KB_CACHE_TAG } from "@/lib/public-kb"

// ---------------------------------------------------------------------------
// Published portal layout resolver (read side).
//
// Resolves the live public-KB layout for a workspace from the
// `workspace_experiences` table. Runs on the service-role admin client, so the
// query MUST encode the published/public visibility contract itself:
//   kind = 'kb' AND audience = 'public' AND status = 'published'
// (the partial unique index guarantees at most one such row per workspace).
//
// Fails safe: returns null on no row, query error, or validation failure — the
// caller (the portal route) then falls back to buildDefaultPortalLayout, so a
// malformed stored spec degrades to the default rather than breaking the page.
//
// Cached via unstable_cache (60s) under PUBLIC_KB_CACHE_TAG so it shares the
// portal's existing revalidateTag invalidation on (un)publish.
// ---------------------------------------------------------------------------

const PUBLISHED_PORTAL_CACHE_SECONDS = 60

async function loadPublishedPortalLayoutUncached(
  workspaceId: string,
): Promise<PortalLayout | null> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("workspace_experiences")
    .select("spec")
    .eq("workspace_id", workspaceId)
    .eq("kind", "kb")
    .eq("audience", "public")
    .eq("status", "published")
    .maybeSingle()

  if (error || !data) return null

  const validation = validatePortalLayout((data as { spec: unknown }).spec)
  return validation.ok ? validation.data : null
}

const loadPublishedPortalLayoutCached = unstable_cache(
  loadPublishedPortalLayoutUncached,
  ["public-kb-published-portal-layout"],
  { revalidate: PUBLISHED_PORTAL_CACHE_SECONDS, tags: [PUBLIC_KB_CACHE_TAG] },
)

/**
 * The published public-KB layout for a workspace, or null when none is
 * published / stored / valid. Callers fall back to the default layout on null.
 *
 * NOTE: this resolves the workspace's DEFAULT 'docs' project (slug = workspace
 * slug). It is used by the chrome (layout.tsx) and the draft preview, which only
 * operate on the default project in Phase 1. Project-addressed reads use
 * `resolvePublishedProjectBySlug` below.
 */
export async function loadPublishedPortalLayout(
  workspaceId: string,
): Promise<PortalLayout | null> {
  return loadPublishedPortalLayoutCached(workspaceId)
}

// ---------------------------------------------------------------------------
// Project resolution by slug (read side for /p/[slug]).
//
// A KB project is addressable by its `slug`. Resolving a published row by slug
// yields the workspace it belongs to and its folder scope (which content the read path surfaces). The
// route uses this to render a non-default project; when no published project
// matches the slug it falls back to resolving a WORKSPACE by that slug (the
// legacy /p/<workspace-slug> default-project behavior).
// ---------------------------------------------------------------------------

export interface PublishedProject {
  /** workspace_experiences.id — the published portal project row. Used to
   *  attribute portal analytics events to a specific portal. */
  experienceId: string
  workspaceId: string
  slug: string
  /**
   * NULL = whole-workspace public docs; [] = intentionally empty project.
   * Entries are root folder UUIDs, optionally { id, promote } for a promoted
   * root whose children surface as top-level sections.
   */
  scope: PortalScopeEntry[] | null
  /**
   * The project scope widened by every page's own scope — what the portal
   * ADDRESSES rather than what its home renders. Doc/folder routes, portal
   * search and the public APIs gate on this so a page's documents stay
   * reachable; layout builders keep using `scope`. See portalContentScope.
   */
  contentScope: PortalScopeEntry[] | null
  layout: PortalLayout | null
  /**
   * Per-project access. 'public' = anonymous visitors may view; 'private' =
   * only signed-in active workspace members may view. Authoritative for the
   * portal gate (see requirePortal), replacing the workspace-wide kb_public
   * flag. Defaults to 'public' if missing/invalid.
   */
  visibility: "public" | "private"
  /** Minimum role for a private project (Phase 2b); null for now. */
  requiredRole: string | null
}

function coerceVisibility(raw: unknown): "public" | "private" {
  return raw === "private" ? "private" : "public"
}

function coerceScope(raw: unknown): PortalScopeEntry[] | null {
  if (!Array.isArray(raw)) return null
  const entries: PortalScopeEntry[] = []
  for (const v of raw) {
    if (typeof v === "string") {
      entries.push(v)
    } else if (v && typeof v === "object" && typeof (v as { doc?: unknown }).doc === "string") {
      entries.push({ doc: (v as { doc: string }).doc })
    } else if (v && typeof v === "object" && (v as { workspaceDocs?: unknown }).workspaceDocs === true) {
      entries.push({ workspaceDocs: true })
    } else if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
      const id = (v as { id: string }).id
      const promote = (v as { promote?: unknown }).promote === true
      const explicitDocs = (v as { explicitDocs?: unknown }).explicitDocs === true
      const rootOnly = (v as { rootOnly?: unknown }).rootOnly === true || explicitDocs
      entries.push(
        promote || rootOnly
          ? { id, promote, rootOnly, ...(explicitDocs ? { explicitDocs: true } : {}) }
          : id,
      )
    }
  }
  return entries
}

const PUBLISHED_PROJECT_COLUMNS =
  "id, workspace_id, slug, scope, spec, visibility, required_role"
const LEGACY_DEFAULT_PROJECT_SLUG = "docs"

function rowToPublishedProject(data: unknown): PublishedProject {
  const row = data as {
    id: string
    workspace_id: string
    slug: string
    scope: unknown
    spec: unknown
    visibility: unknown
    required_role: unknown
  }
  const validation = validatePortalLayout(row.spec)
  const scope = coerceScope(row.scope)
  const layout = validation.ok ? validation.data : null
  return {
    experienceId: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    scope,
    contentScope: portalContentScope(scope, layout),
    layout,
    visibility: coerceVisibility(row.visibility),
    requiredRole: typeof row.required_role === "string" ? row.required_role : null,
  }
}

async function resolvePublishedProjectBySlugUncached(
  slug: string,
): Promise<PublishedProject | null> {
  if (!slug || slug.length > 200) return null
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("workspace_experiences")
    .select(PUBLISHED_PROJECT_COLUMNS)
    .eq("kind", "kb")
    .eq("audience", "public")
    .eq("status", "published")
    .eq("slug", slug)
    .maybeSingle()

  if (error || !data) return null
  return rowToPublishedProject(data)
}

const resolvePublishedProjectBySlugCached = unstable_cache(
  resolvePublishedProjectBySlugUncached,
  ["public-kb-published-project-by-slug"],
  { revalidate: PUBLISHED_PORTAL_CACHE_SECONDS, tags: [PUBLIC_KB_CACHE_TAG] },
)

/**
 * Resolve a published KB project by its public slug, or null when no published
 * project owns that slug. Returns the owning workspace, scope and the
 * validated published layout (null if the stored spec failed validation).
 *
 * GLOBAL lookup — slug only. Retained for legacy `/p/<slug>` back-compat
 * redirects; new public routes resolve the workspace first and use the
 * workspace-scoped {@link resolvePublishedProjectByWorkspace} below.
 */
export async function resolvePublishedProjectBySlug(
  slug: string,
): Promise<PublishedProject | null> {
  return resolvePublishedProjectBySlugCached(slug)
}

// ---------------------------------------------------------------------------
// Workspace-scoped project resolution (model B).
//
// Project slugs are unique PER WORKSPACE, so a published project is addressed by
// (workspace_id, slug). The route resolves the workspace first (by its own slug,
// from the `[workspace]` URL segment), then the project within it. The default
// project's slug equals the workspace slug.
// ---------------------------------------------------------------------------

async function resolvePublishedProjectByWorkspaceUncached(
  workspaceId: string,
  slug: string,
): Promise<PublishedProject | null> {
  if (!workspaceId || !slug || slug.length > 200) return null
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("workspace_experiences")
    .select(PUBLISHED_PROJECT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", "kb")
    .eq("audience", "public")
    .eq("status", "published")
    .eq("slug", slug)
    .maybeSingle()

  if (error || !data) return null
  return rowToPublishedProject(data)
}

const resolvePublishedProjectByWorkspaceCached = unstable_cache(
  resolvePublishedProjectByWorkspaceUncached,
  ["public-kb-published-project-by-workspace"],
  { revalidate: PUBLISHED_PORTAL_CACHE_SECONDS, tags: [PUBLIC_KB_CACHE_TAG] },
)

/**
 * Resolve a published KB project within a specific workspace by its slug, or
 * null when no published project with that slug exists in the workspace. The
 * default project's slug equals the workspace slug.
 */
export async function resolvePublishedProjectByWorkspace(
  workspaceId: string,
  slug: string,
): Promise<PublishedProject | null> {
  return resolvePublishedProjectByWorkspaceCached(workspaceId, slug)
}

/**
 * Resolve the workspace-root KB project. The canonical default slug is the
 * workspace slug; when no project lives at the root, fall back to the configured
 * primary project (Settings → Public Portal Address), then the legacy "docs"
 * slug for back-compat. The public root route serves/redirects to whatever this
 * returns. A returned project whose slug differs from the workspace slug means
 * nothing is hosted at the root itself (the caller redirects to its canonical
 * `/p/<workspace>/<slug>` URL rather than rendering it inline at the root).
 */
export async function resolveDefaultPublishedProjectByWorkspace(
  workspaceId: string,
  workspaceSlug: string,
  primaryProjectSlug?: string | null,
): Promise<PublishedProject | null> {
  const canonical = await resolvePublishedProjectByWorkspace(
    workspaceId,
    workspaceSlug,
  )
  if (canonical) return canonical
  const fallbackSlug =
    (primaryProjectSlug && primaryProjectSlug.trim()) ||
    LEGACY_DEFAULT_PROJECT_SLUG
  // The canonical lookup already ran, so a fallback equal to the workspace slug
  // can only miss — short-circuit instead of repeating it.
  if (fallbackSlug === workspaceSlug) return null
  return resolvePublishedProjectByWorkspace(workspaceId, fallbackSlug)
}
