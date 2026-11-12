import "server-only"

import { revalidateTag } from "next/cache"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  getKbBranding,
  getKbFooter,
  getKbHeader,
  getKbPrimaryProject,
  getPortalChromeScope,
} from "@/lib/workspace-settings"
import {
  getPublicTaxonomyFresh,
  getPublicDocumentsFresh,
  type PortalScopeEntry,
  type PublicWorkspace,
} from "@/lib/public-kb"
import { buildDefaultPortalLayout } from "@/lib/portal/build-default"
import { validatePortalLayout, type PortalLayout } from "@/lib/portal/schema"
import { PUBLIC_KB_CACHE_TAG } from "@/lib/portal/experiences"
import { PORTAL_RESERVED_PROJECT_SLUGS } from "@/lib/portal/portal-path"

// ---------------------------------------------------------------------------
// Public-KB portal layout — write side.
//
// Manages the lifecycle of the `kind='kb' audience='public'` rows in
// `workspace_experiences`: draft creation/edit, publish, and version rollback.
// The read side (experiences.ts) resolves the single `status='published'` row;
// this module is the only writer.
//
// Server-only: uses the service-role admin client. The visibility/scoping
// contract is enforced by the callers (API routes resolve the workspace via
// getActiveWorkspace() and require an admin/owner role) — this module trusts
// the workspaceId it's handed and operates within it.
//
// Each portal is a PROJECT, identified by `slug`. Callers that omit a slug
// resolve the workspace's DEFAULT 'docs' project (slug = workspace slug), which
// keeps the legacy single-portal callers working unchanged.
//
// Invariants this module must preserve:
//  - At most ONE published row per project (slug) — guarded by the partial
//    unique index `workspace_experiences_one_published_per_slug_idx`. publish
//    and rollback therefore archive the live published row before promoting the
//    new one, so the index can never momentarily see two published rows.
//  - version is monotonic per project (workspace, kind, slug): max(version)+1.
//  - After any publish/rollback, revalidate the read cache tag so the public
//    portal reflects the change within the request, not after the 60s TTL.
// ---------------------------------------------------------------------------

const KB_KIND = "kb" as const
const PUBLIC_AUDIENCE = "public" as const

// Same format rule the builder UI enforces (PORTAL_SLUG_RE in portal-builder.tsx
// and the shared slugSchema in @/lib/validation): lowercase a-z0-9 and dashes,
// 1-50 chars, no leading/trailing dash.
const PORTAL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/

/** Columns selected for any layout-bearing experience row. */
const ROW_COLUMNS =
  "id, workspace_id, kind, status, version, slug, scope, audience, visibility, required_role, spec, name, created_by, published_by, created_at, updated_at"

export interface PortalExperienceRow {
  id: string
  workspace_id: string
  kind: string
  status: string
  version: number
  /** The project's public URL slug. The default 'docs' project equals the workspace slug. */
  slug: string | null
  /**
   * NULL = whole-workspace public docs; else a JSON array of scope entries —
   * root folder UUIDs, each optionally wrapped as { id, promote } to surface
   * the folder's children as top-level sections in place of the folder.
   */
  scope: PortalScopeEntry[] | null
  audience: string
  /** Per-project access. 'public' = anonymous; 'private' = members only. */
  visibility: "public" | "private"
  /** Minimum role for a private project (Phase 2b); null for now. */
  required_role: string | null
  spec: unknown
  name: string | null
  created_by: string | null
  published_by: string | null
  created_at: string
  updated_at: string
}

export interface PortalProjectSummary {
  id: string | null
  slug: string
  scope: PortalScopeEntry[] | null
  name: string | null
  displayName: string
  /** Emoji icon for the project: spec.theme.icon, else the default docs icon. */
  icon: string
  isDefault: boolean
  /** Per-project access. 'public' = anonymous; 'private' = members only. */
  visibility: "public" | "private"
  draftVersion: number | null
  publishedVersion: number | null
  updatedAt: string | null
}

export interface PortalProjectScopeResult {
  slug: string
  scope: PortalScopeEntry[] | null
  draftVersion: number
}

export interface PortalProjectVisibilityResult {
  slug: string
  visibility: "public" | "private"
  draftVersion: number
}

export interface PortalProjectPathResult {
  previousSlug: string
  slug: string
}

export interface PortalProjectContentScope {
  slug: string
  scope: PortalScopeEntry[] | null
}

type AdminClient = ReturnType<typeof createAdminClient>

// Accepts every scope entry shape (plain folder id, an object carrying root
// metadata, `{ doc }`, `{ workspaceDocs }`) and normalizes folder objects
// without metadata back to plain strings so stored scopes and equality checks
// stay canonical. `explicitDocs` implies a structural root, so it forces
// `rootOnly` rather than trusting the stored flag combination.
function coerceScope(value: unknown): PortalScopeEntry[] | null {
  if (!Array.isArray(value)) return null
  const entries: PortalScopeEntry[] = []
  for (const v of value) {
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

/** The emoji shown for a project when its spec carries no explicit theme.icon. */
export const DEFAULT_PROJECT_ICON = "📚"

/** Resolve a project's icon: spec.theme.icon if non-empty, else the default. */
function resolveProjectIcon(spec: unknown): string {
  if (typeof spec === "object" && spec !== null) {
    const theme = (spec as { theme?: unknown }).theme
    if (typeof theme === "object" && theme !== null) {
      const icon = (theme as { icon?: unknown }).icon
      if (typeof icon === "string" && icon.trim()) return icon.trim()
    }
  }
  return DEFAULT_PROJECT_ICON
}

function specBrandName(spec: unknown): string | null {
  if (typeof spec !== "object" || spec === null) return null
  const theme = (spec as { theme?: unknown }).theme
  if (typeof theme !== "object" || theme === null) return null
  const brandName = (theme as { brandName?: unknown }).brandName
  return typeof brandName === "string" && brandName.trim()
    ? brandName.trim()
    : null
}

function fallbackProjectName(
  slug: string,
  defaultSlug: string,
): string {
  if (slug === defaultSlug) return "Docs"
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Portal"
}

function projectDisplayName(input: {
  slug: string
  defaultSlug: string
  name: string | null
  spec: unknown
}): string {
  if (input.name?.trim()) return input.name.trim()
  return (
    specBrandName(input.spec) ??
    fallbackProjectName(input.slug, input.defaultSlug)
  )
}

/**
 * Resolve the slug of the PROJECT a write operates on. Callers that pass an
 * explicit project slug target that project; callers that omit it (the legacy
 * single-portal callers) resolve the workspace's DEFAULT 'docs' project, whose
 * slug equals the workspace slug.
 */
/**
 * Resolve the project a slug-less call targets. When the caller names a slug it
 * wins. Otherwise resolve to the workspace's DEFAULT project exactly as the
 * builder does (`listPortalProjects` order: the root project when one exists,
 * else the first listed project). A workspace with no projects at all resolves
 * to the workspace slug, so the synthesized root gets created on first write.
 *
 * Previously a missing slug always meant the workspace slug. Once the root
 * project had been moved to a suffix (e.g. `docs`), any slug-less request —
 * a stale /portal-preview URL, a draft PUT without a slug — silently recreated
 * a phantom root project named after the workspace.
 */
async function resolveProjectSlug(
  _admin: AdminClient,
  workspaceId: string,
  projectSlug?: string,
): Promise<string> {
  if (projectSlug) return projectSlug
  const projects = await listPortalProjects(workspaceId)
  const fallback = projects[0]
  if (!fallback) {
    throw new Error("portal experiences: no default project could be resolved")
  }
  return fallback.slug
}

async function assertKnownProjectSlug(
  admin: AdminClient,
  workspaceId: string,
  slug: string,
): Promise<void> {
  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .select("slug")
    .eq("id", workspaceId)
    .maybeSingle()
  if (workspaceError || !workspace) {
    throw new Error(
      `portal experiences: workspace lookup failed: ${workspaceError?.message ?? "not found"}`,
    )
  }
  if ((workspace as { slug: string }).slug === slug) return

  const { data, error } = await admin
    .from("workspace_experiences")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("slug", slug)
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`portal experiences: project lookup failed: ${error.message}`)
  }
  if (!data) throw new Error("portal experiences: unknown project")
}

async function validateScopeFolders(
  admin: AdminClient,
  workspaceId: string,
  scope: PortalScopeEntry[] | null,
): Promise<PortalScopeEntry[] | null> {
  if (scope === null) return null
  if (scope.length === 0) return []
  // Canonicalize before validating: dedupe folder entries by id (root metadata
  // wins) and doc entries by doc id, sort each group by id so stored scopes
  // compare stably. Folder entries first, then doc entries, then the single
  // optional workspaceDocs sentinel.
  const byId = new Map<string, PortalScopeEntry>()
  const docIds = new Set<string>()
  let workspaceDocs = false
  for (const entry of scope) {
    if (typeof entry === "object" && "doc" in entry) {
      docIds.add(entry.doc)
      continue
    }
    if (typeof entry === "object" && "workspaceDocs" in entry) {
      workspaceDocs = true
      continue
    }
    const id = typeof entry === "string" ? entry : entry.id
    const existing = byId.get(id)
    const promoted =
      (typeof entry === "object" && "id" in entry && entry.promote === true) ||
      (typeof existing === "object" && "id" in existing && existing.promote === true)
    const explicitDocs =
      (typeof entry === "object" && "id" in entry && entry.explicitDocs === true) ||
      (typeof existing === "object" &&
        "id" in existing &&
        existing.explicitDocs === true)
    const rootOnly =
      explicitDocs ||
      (typeof entry === "object" && "id" in entry && entry.rootOnly === true) ||
      (typeof existing === "object" && "id" in existing && existing.rootOnly === true)
    byId.set(
      id,
      promoted || rootOnly
        ? { id, promote: promoted, rootOnly, ...(explicitDocs ? { explicitDocs: true } : {}) }
        : id,
    )
  }
  const ids = Array.from(byId.keys()).sort()
  if (ids.length > 0) {
    const found = new Set<string>()
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100)
      const { data, error } = await admin
        .from("folders")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("visibility", "workspace")
        .eq("kind", "user")
        .in("id", chunk)
      if (error) {
        throw new Error(`portal experiences: scope validation failed: ${error.message}`)
      }
      for (const row of (data ?? []) as Array<{ id: string }>) found.add(row.id)
    }
    const missing = ids.filter((id) => !found.has(id))
    if (missing.length > 0) {
      throw new Error("portal experiences: scope contains unavailable folders")
    }
  }
  const sortedDocIds = Array.from(docIds).sort()
  if (sortedDocIds.length > 0) {
    // Picked docs must be publishable (source/page, not trashed) in this
    // workspace — the same allowlist the public read path enforces.
    const found = new Set<string>()
    for (let offset = 0; offset < sortedDocIds.length; offset += 100) {
      const chunk = sortedDocIds.slice(offset, offset + 100)
      const { data, error } = await admin
        .from("documents")
        .select("id")
        .eq("workspace_id", workspaceId)
        .is("deleted_at", null)
        .in("document_type", ["source", "page"])
        .in("id", chunk)
      if (error) {
        throw new Error(`portal experiences: scope validation failed: ${error.message}`)
      }
      for (const row of (data ?? []) as Array<{ id: string }>) found.add(row.id)
    }
    const missing = sortedDocIds.filter((id) => !found.has(id))
    if (missing.length > 0) {
      throw new Error("portal experiences: scope contains unavailable documents")
    }
  }
  return [
    ...ids.map((id) => byId.get(id) as PortalScopeEntry),
    ...sortedDocIds.map((doc): PortalScopeEntry => ({ doc })),
    ...(workspaceDocs ? [{ workspaceDocs: true } as PortalScopeEntry] : []),
  ]
}

/**
 * List the portal projects available to the builder for a workspace. Returns
 * ONLY persisted projects — an empty array means the workspace has no portals
 * yet (or deleted them all), and the builder shows its empty "create a project"
 * state. (The public /p/<workspace-slug> route still serves a default layout via
 * the workspace-slug fallback in experiences.ts, independent of this list.)
 */
export async function listPortalProjects(
  workspaceId: string,
): Promise<PortalProjectSummary[]> {
  const admin = createAdminClient()
  const [{ data: workspace, error: workspaceError }, { data: rows, error }] =
    await Promise.all([
      admin
        .from("workspaces")
        .select("slug, name")
        .eq("id", workspaceId)
        .maybeSingle(),
      admin
        .from("workspace_experiences")
        .select("id, slug, scope, status, version, name, spec, updated_at, visibility")
        .eq("workspace_id", workspaceId)
        .eq("kind", KB_KIND)
        .eq("audience", PUBLIC_AUDIENCE)
        .order("updated_at", { ascending: false }),
    ])

  if (workspaceError || !workspace) {
    throw new Error(
      `portal experiences: workspace lookup failed: ${workspaceError?.message ?? "not found"}`,
    )
  }
  if (error) {
    throw new Error(`portal experiences: project list failed: ${error.message}`)
  }

  const defaultSlug = (workspace as { slug: string }).slug
  const bySlug = new Map<string, PortalProjectSummary>()

  for (const row of (rows ?? []) as Array<{
    id: string
    slug: string | null
    scope: unknown
    status: string
    version: number
    name: string | null
    spec: unknown
    updated_at: string | null
    visibility: unknown
  }>) {
    if (!row.slug) continue
    const existing = bySlug.get(row.slug)
    const displayName = projectDisplayName({
      slug: row.slug,
      defaultSlug,
      name: row.name,
      spec: row.spec,
    })
    if (!existing) {
      bySlug.set(row.slug, {
        id: row.id,
        slug: row.slug,
        scope: coerceScope(row.scope),
        name: row.name,
        displayName,
        icon: resolveProjectIcon(row.spec),
        isDefault: row.slug === defaultSlug,
        visibility: row.visibility === "private" ? "private" : "public",
        draftVersion: row.status === "draft" ? row.version : null,
        publishedVersion: row.status === "published" ? row.version : null,
        updatedAt: row.updated_at,
      })
      continue
    }

    existing.updatedAt =
      row.updated_at && (!existing.updatedAt || row.updated_at > existing.updatedAt)
        ? row.updated_at
        : existing.updatedAt
    if (row.status === "draft") {
      existing.draftVersion = Math.max(existing.draftVersion ?? 0, row.version)
      existing.scope = coerceScope(row.scope)
      existing.name = row.name
      existing.displayName = displayName
      existing.icon = resolveProjectIcon(row.spec)
      existing.visibility = row.visibility === "private" ? "private" : "public"
      if (existing.publishedVersion === null) {
        existing.id = row.id
      }
    } else if (row.status === "published") {
      existing.publishedVersion = Math.max(existing.publishedVersion ?? 0, row.version)
      existing.id = row.id
      if (existing.draftVersion === null) {
        existing.scope = coerceScope(row.scope)
        existing.name = row.name
        existing.displayName = displayName
        existing.icon = resolveProjectIcon(row.spec)
        existing.visibility = row.visibility === "private" ? "private" : "public"
      }
    }
  }

  // The workspace root renders via an implicit fallback when no stored project
  // exists. Synthesize that starter project only for a brand-new workspace. If
  // a workspace has persisted projects but none use the workspace slug, the
  // former root project was intentionally moved to a suffix, so do not create a
  // duplicate root entry in the builder.
  if (bySlug.size === 0) {
    bySlug.set(defaultSlug, {
      id: null,
      slug: defaultSlug,
      scope: null,
      name: null,
      displayName: projectDisplayName({
        slug: defaultSlug,
        defaultSlug,
        name: null,
        spec: null,
      }),
      icon: DEFAULT_PROJECT_ICON,
      isDefault: true,
      visibility: "public",
      draftVersion: null,
      publishedVersion: null,
      updatedAt: null,
    })
  }

  return Array.from(bySlug.values()).sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.displayName.localeCompare(b.displayName)
  })
}

/**
 * Update a project's draft content scope. Scope is draft metadata: it affects
 * the builder preview immediately, then goes live when the project draft is
 * published. `null` means the whole workspace's public docs; otherwise the array
 * is the root folder ids to surface, validated as public user folders.
 */
export async function updatePortalProjectScope(
  workspaceId: string,
  userId: string,
  projectSlug: string | undefined,
  scope: PortalScopeEntry[] | null,
): Promise<PortalProjectScopeResult> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)
  await assertKnownProjectSlug(admin, workspaceId, slug)
  const normalizedScope = await validateScopeFolders(admin, workspaceId, scope)
  const draft = await getOrCreateDraft(workspaceId, userId, slug)
  const { data, error } = await admin
    .from("workspace_experiences")
    .update({ scope: normalizedScope, updated_at: new Date().toISOString() })
    .eq("id", draft.id)
    .eq("workspace_id", workspaceId)
    .select("slug, scope, version")
    .single()

  if (error || !data) {
    throw new Error(
      `portal experiences: scope update failed: ${error?.message ?? "no row"}`,
    )
  }
  const row = data as { slug: string; scope: unknown; version: number }
  return {
    slug: row.slug,
    scope: coerceScope(row.scope),
    draftVersion: row.version,
  }
}

/**
 * Update a project's per-project visibility. Unlike scope/spec, access is NOT
 * draft metadata: it applies to the live portal immediately, so the change is
 * written to both the draft row (so a later publish carries it) and the
 * published row (so the gate enforces it now), and the portal cache is expired.
 * Routing it through publish would silently ship unrelated draft content edits
 * alongside an access change. Phase 2a is public/private only — required_role
 * is always cleared here (the CHECK also forbids a role on a public project).
 */
export async function updatePortalProjectVisibility(
  workspaceId: string,
  userId: string,
  projectSlug: string | undefined,
  visibility: "public" | "private",
): Promise<PortalProjectVisibilityResult> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)
  await assertKnownProjectSlug(admin, workspaceId, slug)
  const draft = await getOrCreateDraft(workspaceId, userId, slug)
  const { data, error } = await admin
    .from("workspace_experiences")
    .update({
      visibility,
      required_role: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", draft.id)
    .eq("workspace_id", workspaceId)
    .select("slug, visibility, version")
    .single()

  if (error || !data) {
    throw new Error(
      `portal experiences: visibility update failed: ${error?.message ?? "no row"}`,
    )
  }

  const published = await admin
    .from("workspace_experiences")
    .update({
      visibility,
      required_role: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("status", "published")

  if (published.error) {
    throw new Error(
      `portal experiences: published visibility update failed: ${published.error.message}`,
    )
  }

  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 })

  const row = data as { slug: string; visibility: unknown; version: number }
  return {
    slug: row.slug,
    visibility: row.visibility === "private" ? "private" : "public",
    draftVersion: row.version,
  }
}

/**
 * Resolve the content scope currently used by the builder for a project.
 * Draft rows win because scope edits are draft metadata until publish; when no
 * draft exists, fall back to the published project. A default docs project with
 * no persisted row is the legacy whole-workspace project.
 */
export async function resolvePortalProjectContentScope(
  workspaceId: string,
  projectSlug?: string,
): Promise<PortalProjectContentScope> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)
  await assertKnownProjectSlug(admin, workspaceId, slug)

  const { data, error } = await admin
    .from("workspace_experiences")
    .select("status, scope, version")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .in("status", ["draft", "published"])
    .order("version", { ascending: false })

  if (error) {
    throw new Error(`portal experiences: content scope lookup failed: ${error.message}`)
  }

  const rows = (data ?? []) as Array<{
    status: string
    scope: unknown
    version: number
  }>
  const selected =
    rows.find((row) => row.status === "draft") ??
    rows.find((row) => row.status === "published")

  return {
    slug,
    scope: selected ? coerceScope(selected.scope) : null,
  }
}

/** Highest version across a project's kb rows (the unique key omits audience). */
async function maxVersion(
  admin: AdminClient,
  workspaceId: string,
  slug: string,
): Promise<number> {
  const { data, error } = await admin
    .from("workspace_experiences")
    .select("version")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`portal experiences: version lookup failed: ${error.message}`)
  }
  return data ? (data as { version: number }).version : 0
}

/** The current published kb/public row for a project, or null. */
async function getPublishedRow(
  admin: AdminClient,
  workspaceId: string,
  slug: string,
): Promise<PortalExperienceRow | null> {
  const { data, error } = await admin
    .from("workspace_experiences")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("status", "published")
    .maybeSingle()

  if (error) {
    throw new Error(`portal experiences: published lookup failed: ${error.message}`)
  }
  return (data as PortalExperienceRow | null) ?? null
}

/**
 * The latest kb/public row (any status) for a project. Used to recover the
 * project's scope/name/access when seeding a fresh draft.
 */
async function getLatestProjectRow(
  admin: AdminClient,
  workspaceId: string,
  slug: string,
): Promise<PortalExperienceRow | null> {
  const { data, error } = await admin
    .from("workspace_experiences")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`portal experiences: latest row lookup failed: ${error.message}`)
  }
  return (data as PortalExperienceRow | null) ?? null
}

/**
 * Build the initial docs layout for a NEW project, scoped to the
 * given root folders. Resolves the workspace branding + the scoped public KB data
 * so the seeded layout already reflects what visitors will see at the project's
 * workspace-scoped public path.
 */
async function buildLayoutForNewProject(
  admin: AdminClient,
  workspaceId: string,
  slug: string,
  scope: PortalScopeEntry[] | null,
): Promise<PortalLayout> {
  const { data, error } = await admin
    .from("workspaces")
    .select("id, name, slug, icon_url, settings")
    .eq("id", workspaceId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(
      `portal experiences: workspace lookup failed: ${error?.message ?? "not found"}`,
    )
  }

  const row = data as {
    id: string
    name: string
    slug: string
    icon_url: string | null
    settings: Record<string, unknown> | null
  }
  const workspace: PublicWorkspace = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    iconUrl: row.icon_url,
    isPublic: row.settings?.kb_public === true,
    branding: getKbBranding(row.settings, row.name, row.icon_url),
    primaryProjectSlug: getKbPrimaryProject(row.settings),
    footer: getKbFooter(row.settings),
    header: getKbHeader(row.settings),
    portalChromeScope: getPortalChromeScope(row.settings),
  }

  // Fresh (uncached) reads: this layout gets PERSISTED into the project's
  // spec, so baking it from the public 60s cache can permanently capture a
  // pre-write empty snapshot (no sidebar/categories) for a workspace whose
  // docs were seeded moments earlier.
  const [taxonomy, rootDocs] = await Promise.all([
    getPublicTaxonomyFresh(workspaceId, scope ?? undefined),
    getPublicDocumentsFresh(workspaceId, scope ?? undefined),
  ])

  return buildDefaultPortalLayout({
    slug,
    workspace,
    taxonomy,
    rootDocs,
  })
}

/**
 * Create a NEW portal project as a DRAFT (status 'draft', version 1). Validates
 * the slug format, rejects a slug that is already taken or equal to the workspace
 * slug (reserved for the default 'docs' project), validates the scope folders,
 * seeds the initial docs layout from the scoped data, and stamps the default
 * emoji into theme.icon. Returns the created row.
 */
export async function createPortalProject(
  workspaceId: string,
  userId: string,
  input: {
    slug: string
    name: string
    scope?: PortalScopeEntry[] | null
  },
): Promise<PortalExperienceRow> {
  const admin = createAdminClient()
  const slug = input.slug.trim()
  if (!PORTAL_SLUG_RE.test(slug)) {
    throw new Error("portal experiences: invalid project slug")
  }
  const name = input.name.trim()
  if (!name) {
    throw new Error("portal experiences: project name is required")
  }

  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .select("slug")
    .eq("id", workspaceId)
    .maybeSingle()
  if (workspaceError || !workspace) {
    throw new Error(
      `portal experiences: workspace lookup failed: ${workspaceError?.message ?? "not found"}`,
    )
  }
  if ((workspace as { slug: string }).slug === slug) {
    throw new Error("portal experiences: slug is reserved for the default project")
  }
  // `doc` / `folder` / `page` are structural segments under the workspace root,
  // so a named project may not use one or its routes would be shadowed.
  if (PORTAL_RESERVED_PROJECT_SLUGS.has(slug)) {
    throw new Error("portal experiences: that project slug is reserved")
  }

  // Project slugs are unique PER WORKSPACE (model B): the same slug may exist in
  // different workspaces, each addressed under its own subdomain/path. Only
  // reject a collision within THIS workspace; the partial unique index
  // (workspace_id, slug) is the authoritative guard at insert/publish time.
  const { data: clash, error: clashError } = await admin
    .from("workspace_experiences")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("slug", slug)
    .limit(1)
    .maybeSingle()
  if (clashError) {
    throw new Error(`portal experiences: slug check failed: ${clashError.message}`)
  }
  if (clash) {
    throw new Error("portal experiences: project slug is already taken")
  }

  const normalizedScope = await validateScopeFolders(
    admin,
    workspaceId,
    coerceScope(input.scope),
  )

  const layout = await buildLayoutForNewProject(
    admin,
    workspaceId,
    slug,
    normalizedScope,
  )
  const seedSpec: PortalLayout = {
    ...layout,
    theme: { ...layout.theme, icon: DEFAULT_PROJECT_ICON },
  }

  const now = new Date().toISOString()
  const { data: inserted, error: insertError } = await admin
    .from("workspace_experiences")
    .insert({
      workspace_id: workspaceId,
      kind: KB_KIND,
      slug,
      scope: normalizedScope,
      name,
      audience: PUBLIC_AUDIENCE,
      status: "draft",
      version: 1,
      // New projects are public by default; access is narrowed later via the
      // visibility control (updatePortalProjectVisibility).
      visibility: "public",
      spec: seedSpec,
      created_by: userId,
      created_at: now,
      updated_at: now,
    })
    .select(ROW_COLUMNS)
    .single()

  if (insertError || !inserted) {
    // A concurrent create for the same slug loses on the unique index — surface
    // it as a taken-slug conflict rather than a generic 500.
    if (insertError?.code === "23505") {
      throw new Error("portal experiences: project slug is already taken")
    }
    throw new Error(
      `portal experiences: project create failed: ${insertError?.message ?? "no row"}`,
    )
  }
  return inserted as PortalExperienceRow
}

/**
 * Publish the workspace's DEFAULT portal project (slug = workspace slug). Used
 * by onboarding after the knowledge base is seeded so the visitor-facing portal
 * is a real published project instead of the implicit fallback.
 *
 * Idempotent: when ANY row already exists for the default slug (a draft or a
 * published version), this is a no-op — onboarding must never clobber a portal
 * an admin/agent has started editing. Returns the published row or null when
 * skipped.
 */
export async function publishDefaultPortalProject(
  workspaceId: string,
  userId: string,
): Promise<PortalExperienceRow | null> {
  const admin = createAdminClient()

  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .select("slug, name")
    .eq("id", workspaceId)
    .maybeSingle()
  if (workspaceError || !workspace) {
    throw new Error(
      `portal experiences: workspace lookup failed: ${workspaceError?.message ?? "not found"}`,
    )
  }
  const { slug, name } = workspace as { slug: string; name: string }

  // Skip when the workspace already has ANY project — not just one on the root
  // slug. A workspace whose root was moved to a suffix must not get a second,
  // default root published underneath it.
  const { data: anyProject, error: anyProjectError } = await admin
    .from("workspace_experiences")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("audience", PUBLIC_AUDIENCE)
    .limit(1)
    .maybeSingle()
  if (anyProjectError) {
    throw new Error(
      `portal experiences: project lookup failed: ${anyProjectError.message}`,
    )
  }
  if (anyProject) return null

  const layout = await buildLayoutForNewProject(
    admin,
    workspaceId,
    slug,
    null,
  )
  const seedSpec: PortalLayout = {
    ...layout,
    theme: { ...layout.theme, icon: DEFAULT_PROJECT_ICON },
  }

  const now = new Date().toISOString()
  const { data: inserted, error: insertError } = await admin
    .from("workspace_experiences")
    .insert({
      workspace_id: workspaceId,
      kind: KB_KIND,
      slug,
      scope: null,
      name: projectDisplayName({
        slug,
        defaultSlug: slug,
        name: name || null,
        spec: seedSpec,
      }),
      audience: PUBLIC_AUDIENCE,
      status: "published",
      version: 1,
      spec: seedSpec,
      created_by: userId,
      published_by: userId,
      published_at: now,
      created_at: now,
      updated_at: now,
    })
    .select(ROW_COLUMNS)
    .single()

  if (insertError || !inserted) {
    // A concurrent publish for the same slug loses on the partial unique
    // index — treat it as "already initialized" rather than failing onboarding.
    if (insertError?.code === "23505") return null
    throw new Error(
      `portal experiences: default project publish failed: ${insertError?.message ?? "no row"}`,
    )
  }
  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 })
  return inserted as PortalExperienceRow
}

/**
 * Rename a project: set workspace_experiences.name across EVERY row of the
 * project (all versions and statuses) so the display name is consistent
 * regardless of which version the builder/reader resolves. Returns the new name.
 */
export async function renamePortalProject(
  workspaceId: string,
  input: { slug: string; name: string },
): Promise<{ slug: string; name: string }> {
  const admin = createAdminClient()
  const name = input.name.trim()
  if (!name) {
    throw new Error("portal experiences: project name is required")
  }
  await assertKnownProjectSlug(admin, workspaceId, input.slug)

  const { error } = await admin
    .from("workspace_experiences")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", input.slug)
    .eq("audience", PUBLIC_AUDIENCE)

  if (error) {
    throw new Error(`portal experiences: rename failed: ${error.message}`)
  }
  return { slug: input.slug, name }
}

/**
 * Update a named project's public path suffix. This changes the `slug` across
 * every stored version/status for that project so draft, published, and archived
 * rows continue to represent one project.
 *
 * A project whose current slug equals the workspace slug is the root project.
 * Saving a non-empty suffix moves it under that suffix, e.g.
 * `<workspace-domain>/help`.
 */
export async function updatePortalProjectPath(
  workspaceId: string,
  input: { currentSlug: string; slug: string },
): Promise<PortalProjectPathResult> {
  const admin = createAdminClient()
  const currentSlug = input.currentSlug.trim()
  const nextSlug = input.slug.trim().toLowerCase()

  if (!PORTAL_SLUG_RE.test(currentSlug) || !PORTAL_SLUG_RE.test(nextSlug)) {
    throw new Error("portal experiences: invalid project slug")
  }

  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .select("slug")
    .eq("id", workspaceId)
    .maybeSingle()
  if (workspaceError || !workspace) {
    throw new Error(
      `portal experiences: workspace lookup failed: ${workspaceError?.message ?? "not found"}`,
    )
  }
  const defaultSlug = (workspace as { slug: string }).slug

  if (nextSlug === defaultSlug) {
    throw new Error("portal experiences: slug is reserved for the default project")
  }
  if (PORTAL_RESERVED_PROJECT_SLUGS.has(nextSlug)) {
    throw new Error("portal experiences: that project slug is reserved")
  }
  await assertKnownProjectSlug(admin, workspaceId, currentSlug)
  if (currentSlug === nextSlug) {
    return { previousSlug: currentSlug, slug: nextSlug }
  }

  const { data: clash, error: clashError } = await admin
    .from("workspace_experiences")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("slug", nextSlug)
    .limit(1)
    .maybeSingle()
  if (clashError) {
    throw new Error(`portal experiences: slug check failed: ${clashError.message}`)
  }
  if (clash) {
    throw new Error("portal experiences: project slug is already taken")
  }

  const { data, error } = await admin
    .from("workspace_experiences")
    .update({ slug: nextSlug, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", currentSlug)
    .eq("audience", PUBLIC_AUDIENCE)
    .select("id")

  if (error) {
    if (error.code === "23505") {
      throw new Error("portal experiences: project slug is already taken")
    }
    throw new Error(`portal experiences: path update failed: ${error.message}`)
  }
  if (!data || data.length === 0) {
    throw new Error("portal experiences: unknown project")
  }

  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 })
  return { previousSlug: currentSlug, slug: nextSlug }
}

/**
 * Delete a portal project: removes EVERY kb/public row (all versions and
 * statuses) for the slug in the workspace, taking down its public project path.
 * Only the portal layout is removed — the underlying documents and
 * folders are untouched (the project's `scope` merely references folder ids).
 *
 * The default 'docs' project (slug = workspace slug) CAN be deleted; because
 * listPortalProjects re-synthesizes an empty default when no row exists, this
 * resets the workspace's primary portal to an empty starter rather than
 * removing it from the builder. Returns the deleted slug.
 */
export async function deletePortalProject(
  workspaceId: string,
  slug: string,
): Promise<{ slug: string }> {
  const admin = createAdminClient()

  // Surfaces "unknown project" (→ 400) when the slug isn't a project in this
  // workspace, so a stale client can't silently no-op a delete. Accepts the
  // default slug (= workspace slug) too.
  await assertKnownProjectSlug(admin, workspaceId, slug)

  const { error } = await admin
    .from("workspace_experiences")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)

  if (error) {
    throw new Error(`portal experiences: delete failed: ${error.message}`)
  }
  return { slug }
}

/**
 * Retrieve a project's current draft kb/public row, or synthesize an in-memory
 * one if absent (without writing it to the database).
 */
export async function getDraftOrSynthesize(
  workspaceId: string,
  projectSlug?: string,
): Promise<PortalExperienceRow> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)

  const { data: existing, error: draftError } = await admin
    .from("workspace_experiences")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("status", "draft")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (draftError) {
    throw new Error(`portal experiences: draft lookup failed: ${draftError.message}`)
  }
  if (existing) return existing as PortalExperienceRow

  // No draft — seed in-memory from published spec or the docs default.
  const published = await getPublishedRow(admin, workspaceId, slug)
  const meta = published ?? (await getLatestProjectRow(admin, workspaceId, slug))
  const projectScope = coerceScope(meta?.scope ?? null)
  const projectName = meta?.name ?? null
  const projectVisibility = meta?.visibility === "private" ? "private" : "public"
  const projectRequiredRole =
    projectVisibility === "private" && typeof meta?.required_role === "string"
      ? meta.required_role
      : null
  const publishedValidation = published ? validatePortalLayout(published.spec) : null
  const seedSpec: PortalLayout = publishedValidation?.ok
    ? publishedValidation.data
    : await buildLayoutForNewProject(admin, workspaceId, slug, projectScope)

  const nextVersion = published ? published.version : (meta ? meta.version : 0)
  const now = new Date().toISOString()

  return {
    id: "",
    workspace_id: workspaceId,
    kind: KB_KIND,
    status: "draft",
    version: nextVersion,
    slug,
    scope: projectScope,
    name: projectName,
    audience: PUBLIC_AUDIENCE,
    visibility: projectVisibility,
    required_role: projectRequiredRole,
    spec: seedSpec,
    created_by: null,
    published_by: null,
    created_at: now,
    updated_at: now,
  }
}

/**
 * Return a project's current draft kb/public row, creating one if absent.
 * A new draft clones the published spec when one exists, otherwise the default
 * layout, at version = max(version)+1. `projectSlug` omitted resolves the
 * workspace's default 'docs' project (slug = workspace slug).
 */
export async function getOrCreateDraft(
  workspaceId: string,
  userId: string,
  projectSlug?: string,
): Promise<PortalExperienceRow> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)

  for (let attempt = 0; ; attempt += 1) {
    const { data: existing, error: draftError } = await admin
      .from("workspace_experiences")
      .select(ROW_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("kind", KB_KIND)
      .eq("slug", slug)
      .eq("audience", PUBLIC_AUDIENCE)
      .eq("status", "draft")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (draftError) {
      throw new Error(`portal experiences: draft lookup failed: ${draftError.message}`)
    }
    if (existing) return existing as PortalExperienceRow

    // No draft — seed one from the published spec, or a fresh docs default.
    // Recover the project's scope/name from any existing row.
    const published = await getPublishedRow(admin, workspaceId, slug)
    const meta = published ?? (await getLatestProjectRow(admin, workspaceId, slug))
    const projectScope = coerceScope(meta?.scope ?? null)
    const projectName = meta?.name ?? null
    // Carry the project's access setting into the new draft so editing content
    // (scope/spec) and then publishing never resets a private portal to public.
    const projectVisibility = meta?.visibility === "private" ? "private" : "public"
    const projectRequiredRole =
      projectVisibility === "private" && typeof meta?.required_role === "string"
        ? meta.required_role
        : null
    const publishedValidation = published ? validatePortalLayout(published.spec) : null
    const seedSpec: PortalLayout = publishedValidation?.ok
      ? publishedValidation.data
      : await buildLayoutForNewProject(admin, workspaceId, slug, projectScope)

    const nextVersion = (await maxVersion(admin, workspaceId, slug)) + 1
    const now = new Date().toISOString()

    const { data: inserted, error: insertError } = await admin
      .from("workspace_experiences")
      .insert({
        workspace_id: workspaceId,
        kind: KB_KIND,
        slug,
        scope: projectScope,
        name: projectName,
        audience: PUBLIC_AUDIENCE,
        status: "draft",
        version: nextVersion,
        visibility: projectVisibility,
        required_role: projectRequiredRole,
        spec: seedSpec,
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .select(ROW_COLUMNS)
      .single()

    if (insertError) {
      // The editor fires several /api/portal/draft GETs at once — notably right
      // after publish, which leaves the project with no draft. Two getOrCreateDraft
      // calls can then race past the existence check above and both insert the
      // same (workspace, kind, slug, version), so one loses on the unique
      // constraint. That just means the other call already created the draft —
      // re-read and return it instead of failing the editor load.
      if (insertError.code === "23505") {
        const { data: raced, error: racedError } = await admin
          .from("workspace_experiences")
          .select(ROW_COLUMNS)
          .eq("workspace_id", workspaceId)
          .eq("kind", KB_KIND)
          .eq("slug", slug)
          .eq("audience", PUBLIC_AUDIENCE)
          .eq("status", "draft")
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (racedError) {
          throw new Error(`portal experiences: draft lookup failed: ${racedError.message}`)
        }
        if (raced) return raced as PortalExperienceRow
        // The winning draft may already have been published or discarded.
        // Refresh both the seed and max version before trying again.
        if (attempt < 2) continue
      }
      throw new Error(
        `portal experiences: draft create failed: ${insertError.message}`,
      )
    }
    if (!inserted) {
      throw new Error("portal experiences: draft create failed: no row")
    }
    return inserted as PortalExperienceRow
  }
}

/**
 * Discard the project's draft edits and reset the draft to the live published
 * version — its spec AND scope. When the project has never been published,
 * the draft is reset to a fresh docs default instead. Returns the
 * reset draft row.
 *
 * This is the write side of the builder's "Revert to published" action: a draft
 * accumulates edits (and, for drafts seeded by older code, could lose its scope)
 * that the editor otherwise has no way to throw away. Scope is reset here too so
 * a draft can never stay silently divergent from the published portal's scope.
 */
export async function discardDraft(
  workspaceId: string,
  userId: string,
  projectSlug?: string,
): Promise<PortalExperienceRow> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)

  // Reset target = published spec/scope; fall back to the latest row (any
  // status) for a project's metadata, then a fresh docs default spec.
  const published = await getPublishedRow(admin, workspaceId, slug)
  const meta = published ?? (await getLatestProjectRow(admin, workspaceId, slug))
  const scope = coerceScope(meta?.scope ?? null)
  const name = meta?.name ?? null
  const publishedValidation = published ? validatePortalLayout(published.spec) : null
  const spec: PortalLayout = publishedValidation?.ok
    ? publishedValidation.data
    : await buildLayoutForNewProject(admin, workspaceId, slug, scope)

  const { data: existing, error: existingError } = await admin
    .from("workspace_experiences")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("status", "draft")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) {
    throw new Error(`portal experiences: draft lookup failed: ${existingError.message}`)
  }

  const now = new Date().toISOString()

  // Reset the existing draft in place when one exists; otherwise seed a fresh
  // draft row (publishing promotes the draft, leaving the project with none).
  if (existing) {
    const { data: updated, error: updateError } = await admin
      .from("workspace_experiences")
      .update({ spec, scope, name, updated_at: now })
      .eq("id", (existing as { id: string }).id)
      .select(ROW_COLUMNS)
      .single()
    if (updateError || !updated) {
      throw new Error(
        `portal experiences: draft reset failed: ${updateError?.message ?? "no row"}`,
      )
    }
    return updated as PortalExperienceRow
  }

  const nextVersion = (await maxVersion(admin, workspaceId, slug)) + 1
  const { data: inserted, error: insertError } = await admin
    .from("workspace_experiences")
    .insert({
      workspace_id: workspaceId,
      kind: KB_KIND,
      slug,
      scope,
      name,
      audience: PUBLIC_AUDIENCE,
      status: "draft",
      version: nextVersion,
      spec,
      created_by: userId,
      created_at: now,
      updated_at: now,
    })
    .select(ROW_COLUMNS)
    .single()
  if (insertError || !inserted) {
    throw new Error(
      `portal experiences: draft reset failed: ${insertError?.message ?? "no row"}`,
    )
  }
  return inserted as PortalExperienceRow
}

function sameScope(
  a: PortalScopeEntry[] | null,
  b: PortalScopeEntry[] | null,
): boolean {
  // Promotion is part of scope identity: same ids with different promotion
  // renders a different taxonomy, so it must read as a divergence.
  const key = (scope: PortalScopeEntry[] | null): string =>
    (coerceScope(scope) ?? [])
      .map((e) => {
        if (typeof e === "string") return e
        if (typeof e === "object" && e !== null) {
          if ("id" in e) {
            return `${e.id}${e.promote ? "!promoted" : ""}${e.rootOnly ? "!root-only" : ""}`
          }
          if ("doc" in e) {
            return `doc:${e.doc}`
          }
          if ("workspaceDocs" in e) {
            return "workspace-docs"
          }
        }
        return ""
      })
      .sort()
      .join(",")
  return key(a) === key(b)
}

/**
 * Whether a project's draft diverges from its live published version — i.e. the
 * draft carries saved spec or scope changes that publishing would push live.
 * Returns false when the project has never been published (nothing to revert to)
 * or when the draft is byte-for-byte the published layout. Specs are compared
 * after schema validation, so both sides share the validator's canonical key
 * order and JSON equality is reliable. Gates the builder's "Revert" affordance.
 */
export async function draftDivergesFromPublished(
  workspaceId: string,
  draft: PortalExperienceRow,
): Promise<boolean> {
  if (!draft.slug) return false
  const admin = createAdminClient()
  const published = await getPublishedRow(admin, workspaceId, draft.slug)
  if (!published) return false
  if (!sameScope(draft.scope, published.scope)) return true
  const draftValidation = validatePortalLayout(draft.spec)
  const publishedValidation = validatePortalLayout(published.spec)
  if (!draftValidation.ok || !publishedValidation.ok) return true
  return JSON.stringify(draftValidation.data) !== JSON.stringify(publishedValidation.data)
}

/**
 * Validate and persist a layout to the workspace's draft row. Throws if the
 * spec is invalid or no draft exists (callers should getOrCreateDraft first).
 */
export async function saveDraft(
  workspaceId: string,
  spec: unknown,
  projectSlug?: string,
  editorId?: string,
  sourceVersion?: number,
): Promise<PortalExperienceRow> {
  const validation = validatePortalLayout(spec)
  if (!validation.ok) {
    throw new Error(`portal experiences: invalid layout: ${validation.error}`)
  }

  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)

  const { data, error } = await admin.rpc("save_portal_edit", {
    p_workspace_id: workspaceId,
    p_slug: slug,
    p_spec: validation.data,
    p_editor_id: editorId ?? null,
    p_source_version: sourceVersion ?? null,
  }).single()

  if (error) {
    throw new Error(`portal experiences: draft save failed: ${error.message}`)
  }
  if (!data) {
    throw new Error("portal experiences: no draft to save")
  }
  return data as PortalExperienceRow
}

/**
 * Publish the workspace's draft: archive the live published row and promote the
 * draft to published in a single UPDATE so the one-published partial-unique
 * index is never violated mid-flight. Returns the now-published row.
 */
export async function publishDraft(
  workspaceId: string,
  userId: string,
  projectSlug?: string,
): Promise<PortalExperienceRow> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)

  const draft = await admin
    .from("workspace_experiences")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("status", "draft")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (draft.error) {
    throw new Error(`portal experiences: draft lookup failed: ${draft.error.message}`)
  }
  if (!draft.data) {
    throw new Error("portal experiences: no draft to publish")
  }
  const draftId = (draft.data as { id: string }).id

  // Archive the currently-published row first, then promote the draft. Archive
  // must precede promote so the partial unique index (one published per
  // workspace/kind/audience) never sees two published rows. PostgREST has no
  // multi-row transaction primitive here; ordering archive→promote, both scoped
  // to this workspace, makes the violation window impossible — the archive frees
  // the unique slot before the promote claims it. If the promote then fails, the
  // workspace is left with zero published rows (safe: read side falls back to
  // the default layout), recoverable by re-publishing.
  const archive = await admin
    .from("workspace_experiences")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("status", "published")

  if (archive.error) {
    throw new Error(`portal experiences: archive failed: ${archive.error.message}`)
  }

  const now = new Date().toISOString()
  const { data: promoted, error: promoteError } = await admin
    .from("workspace_experiences")
    .update({
      status: "published",
      published_by: userId,
      updated_at: now,
    })
    .eq("id", draftId)
    .eq("workspace_id", workspaceId)
    .select(ROW_COLUMNS)
    .single()

  if (promoteError || !promoted) {
    throw new Error(
      `portal experiences: publish failed: ${promoteError?.message ?? "no row"}`,
    )
  }

  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 })
  return promoted as PortalExperienceRow
}

/**
 * Roll back to an older version: clone that version's spec into a fresh
 * published row (version = max+1) and archive the current published row.
 * Archive precedes insert so the one-published index is never violated.
 */
export async function rollbackTo(
  workspaceId: string,
  version: number,
  userId: string,
  projectSlug?: string,
): Promise<PortalExperienceRow> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)

  const { data: target, error: targetError } = await admin
    .from("workspace_experiences")
    .select("spec, version, scope, name")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("version", version)
    .maybeSingle()

  if (targetError) {
    throw new Error(`portal experiences: rollback lookup failed: ${targetError.message}`)
  }
  if (!target) {
    throw new Error(`portal experiences: no version ${version} to roll back to`)
  }

  const validation = validatePortalLayout((target as { spec: unknown }).spec)
  if (!validation.ok) {
    throw new Error(
      `portal experiences: version ${version} has an invalid layout: ${validation.error}`,
    )
  }

  // Preserve the CURRENTLY live access setting across the rollback: a rollback
  // restores content (spec), not access, and must never silently re-expose a
  // private portal. Read it before archiving the live row.
  const { data: liveAccess } = await admin
    .from("workspace_experiences")
    .select("visibility, required_role")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("status", "published")
    .maybeSingle()
  const rolledVisibility =
    (liveAccess as { visibility?: unknown } | null)?.visibility === "private"
      ? "private"
      : "public"
  const rolledRequiredRole =
    rolledVisibility === "private" &&
    typeof (liveAccess as { required_role?: unknown } | null)?.required_role === "string"
      ? ((liveAccess as { required_role: string }).required_role)
      : null

  // Archive the live published row before inserting the new published clone, so
  // the partial unique index never sees two published rows (same ordering
  // rationale as publishDraft).
  const archive = await admin
    .from("workspace_experiences")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("status", "published")

  if (archive.error) {
    throw new Error(`portal experiences: archive failed: ${archive.error.message}`)
  }

  const nextVersion = (await maxVersion(admin, workspaceId, slug)) + 1
  const now = new Date().toISOString()
  const { data: inserted, error: insertError } = await admin
    .from("workspace_experiences")
    .insert({
      workspace_id: workspaceId,
      kind: KB_KIND,
      slug,
      scope: coerceScope((target as { scope?: unknown }).scope),
      status: "published",
      audience: PUBLIC_AUDIENCE,
      version: nextVersion,
      visibility: rolledVisibility,
      required_role: rolledRequiredRole,
      spec: validation.data,
      name: (target as { name?: string | null }).name ?? `Rollback to v${version}`,
      created_by: userId,
      published_by: userId,
      created_at: now,
      updated_at: now,
    })
    .select(ROW_COLUMNS)
    .single()

  if (insertError || !inserted) {
    throw new Error(
      `portal experiences: rollback publish failed: ${insertError?.message ?? "no row"}`,
    )
  }

  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 })
  return inserted as PortalExperienceRow
}

// ---------------------------------------------------------------------------
// Version history (builder version selector).
//
// Each save stores an immutable archived snapshot alongside the editable row.
// Publication rows remain separate and do not appear in the edit history.
// ---------------------------------------------------------------------------

/** Cap on how far back the builder's version selector reads. */
const VERSION_HISTORY_LIMIT = 50

export interface PortalVersionSummary {
  version: number
  /** 'published' = live right now; 'archived' = a superseded version. */
  status: "published" | "archived"
  /** Saved editor display name; legacy field name retained for API compatibility. */
  publishedBy: string | null
  createdAt: string
  updatedAt: string
}

/**
 * List immutable saved edits, newest first. Publishing does not add entries.
 */
export async function listPortalVersions(
  workspaceId: string,
  projectSlug?: string,
  limit: number = VERSION_HISTORY_LIMIT,
): Promise<PortalVersionSummary[]> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)

  const { data, error } = await admin
    .from("workspace_experiences")
    .select("version, status, published_by, created_by, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("is_save_snapshot", true)
    .order("version", { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`portal experiences: version list failed: ${error.message}`)
  }

  const rows = (data ?? []) as Array<{
    version: number
    status: string
    published_by: string | null
    created_by: string | null
    created_at: string
    updated_at: string
  }>
  if (rows.length === 0) return []

  // Resolve author names in one round trip. A missing profile is not an error —
  // the selector falls back to "Unknown editor".
  const authorIds = Array.from(
    new Set(
      rows
        .map((row) => row.published_by ?? row.created_by)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  )
  const names = new Map<string, string>()
  if (authorIds.length > 0) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("user_id, display_name, email")
      .in("user_id", authorIds)
    for (const profile of (profiles ?? []) as Array<{
      user_id: string
      display_name: string | null
      email: string | null
    }>) {
      const label = profile.display_name ?? profile.email
      if (label) names.set(profile.user_id, label)
    }
  }

  return rows.map((row) => {
    const authorId = row.published_by ?? row.created_by
    return {
      version: row.version,
      status: row.status === "published" ? "published" : "archived",
      publishedBy: authorId ? (names.get(authorId) ?? null) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  })
}

/**
 * Read one historical version's row, for previewing a version before restoring
 * it. Returns the whole row (not just the spec) so the preview renders that
 * version's scope too. Null when the version does not exist for
 * the project; drafts are never returned.
 */
export async function getPortalVersionRow(
  workspaceId: string,
  version: number,
  projectSlug?: string,
): Promise<PortalExperienceRow | null> {
  const admin = createAdminClient()
  const slug = await resolveProjectSlug(admin, workspaceId, projectSlug)

  const { data, error } = await admin
    .from("workspace_experiences")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", KB_KIND)
    .eq("slug", slug)
    .eq("audience", PUBLIC_AUDIENCE)
    .eq("version", version)
    .in("status", ["published", "archived"])
    .maybeSingle()

  if (error) {
    throw new Error(`portal experiences: version lookup failed: ${error.message}`)
  }
  return (data as PortalExperienceRow | null) ?? null
}
