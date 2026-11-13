import "server-only"

import { cache } from "react"
import { isNavigableDocument } from "@/lib/document-navigation"
import { readPublishedDate } from "@/lib/documents/published-date"
import { unstable_cache } from "next/cache"
import { createAdminClient } from "@/lib/supabase/admin"
import { getAuthUser } from "@/lib/auth/get-auth-user"
import {
  getKbBranding,
  getKbCustomDomain,
  getKbFooter,
  getKbHeader,
  getPortalAddressMode,
  getPortalAddressScope,
  getPortalChromeScope,
  getLandingPageUrl,
  type KbBranding,
  type PortalAddressMode,
  type PortalAddressScope,
  type PortalChromeScope,
} from "@/lib/workspace-settings"
import type { StoredFooter, StoredHeader } from "@/lib/portal/schema"
import { looksLikeHtml } from "@/lib/html-detection"
import { appAbsoluteAssetUrl } from "@/lib/portal/public-base-path"
import {
  estimateDocumentReadTimeMinutes,
  makeDocumentPreview,
} from "@/lib/document-preview"
import { isProspectPortalExpired } from "@/lib/db/prospect"
import { TimeoutError } from "@/lib/utils"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { DocumentLinkEntry, DocumentLinkStrength } from "@/lib/types"

// ---------------------------------------------------------------------------
// Knowledge-base portal data access.
//
// This is the ONLY data path for the public/private KB portal. It runs on the
// service-role admin client (RLS bypassed), so every query MUST apply the
// portal-visibility contract explicitly:
//
//   • workspace must be published OR caller must be an active workspace member
//   • folders: visibility === 'workspace' AND kind != 'topic'
//   • documents: deleted_at IS NULL AND (folder_id IS NULL OR folder ∈ visible)
//   • documents: document_type IN ('source','page') ONLY (no synthesized
//     topic_page rows)
//
// This mirrors the established /api/v1/documents "workspace-scope" contract for
// portal-visible content. Role-gated and trashed content can never surface here,
// even to signed-in members viewing a private portal.
//
// INVARIANT — there is NO database backstop. Every function here reads via the
// service-role admin client, which BYPASSES RLS, so the contract above lives
// entirely in this file. Any new query MUST re-apply it by hand:
// publicVisibleFolderIds() / visibleDocFilter() for folder scoping,
// `deleted_at IS NULL`, and the `document_type IN ('source','page')` allowlist
// for document listings/fetches. Omit one and hidden content leaks.
// ---------------------------------------------------------------------------

const PUBLIC_FOLDER_VISIBILITY = "workspace" as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Shape returned by every public document listing query. `public_slug` is the
 * human-readable URL slug (null when unset); callers map it to `slug` and fall
 * back to `id` so links stay valid for docs that were never imported with a slug.
 */
interface PublicDocRow {
  id: string
  public_slug: string | null
  title: string
  content?: string | null
  source: string | null
  source_metadata?: unknown
  updated_at?: string
  folder_id?: string | null
  sort_order?: number | null
}

export interface PublicDocCover {
  url: string
  alt: string | null
}

// Social-preview image for a document page, from imported `blog_cover`
// metadata when present.
function readDocCover(sourceMetadata: unknown): PublicDocCover | null {
  if (typeof sourceMetadata !== "object" || sourceMetadata === null) return null
  const cover = (sourceMetadata as Record<string, unknown>).blog_cover
  if (typeof cover !== "object" || cover === null || Array.isArray(cover)) return null
  const { path, url, alt } = cover as Record<string, unknown>
  const location = typeof path === "string" && path.trim() ? path.trim() : url
  if (typeof location !== "string") return null
  const safeUrl = location.trim()
  if (!safeUrl.startsWith("/") && !safeUrl.startsWith("https://")) return null
  return { url: safeUrl, alt: typeof alt === "string" && alt.trim() ? alt.trim() : null }
}

function toDocSummary(row: PublicDocRow): PublicDocSummary {
  return {
    id: row.id,
    slug: row.public_slug ?? row.id,
    title: row.title,
    ...(row.content ? { description: makeDocumentPreview(row.content, 200) } : {}),
    ...(row.content
      ? { readTimeMinutes: estimateDocumentReadTimeMinutes(row.content) }
      : {}),
    source: row.source,
    ...(readPublishedDate(row.source_metadata)
      ? { published_at: readPublishedDate(row.source_metadata) }
      : {}),
    updated_at: row.updated_at,
    folder_id: row.folder_id ?? null,
    sort_order: typeof row.sort_order === "number" ? row.sort_order : null,
  }
}

// Cross-request data-cache window for the caller-independent portal reads
// (slug→workspace row, home taxonomy, root documents). The portal is
// force-dynamic so the page still renders per request, but these admin-client
// queries are shared across hits — bots, link-unfurlers, and refreshes pay one
// query per workspace per window instead of hammering the DB on every request.
// Invalidate eagerly with revalidateTag(PUBLIC_KB_CACHE_TAG) when content is
// (un)published; otherwise entries self-heal after the window.
const PUBLIC_KB_CACHE_SECONDS = 60
export const PUBLIC_KB_CACHE_TAG = "public-kb"

export interface PublicWorkspace {
  id: string
  name: string
  /** The workspace's editable identifier — the public portal URL key (`/p/<slug>`). */
  slug: string
  iconUrl: string | null
  isPublic: boolean
  branding: KbBranding
  /** Preferred workspace-level public host, when custom hosting is configured. */
  customDomain?: string
  /** Whether public hosting is configured once per workspace or per project. */
  portalAddressScope?: PortalAddressScope
  /** Active workspace-level hosting method. */
  portalAddressMode?: PortalAddressMode
  /**
   * The workspace's own landing page / website (normalized absolute http(s)
   * URL), captured during onboarding. When present, generated portal templates
   * point their Home/Pricing nav at this site instead of the Breezify marketing
   * placeholders. Empty string / undefined means none on file.
   */
  websiteUrl?: string
  /**
   * Crawled footer (columns + social) from the workspace's website, captured by
   * the onboarding website import (settings.kb_footer). When present, generated
   * portal templates seed a rich multi-column footer from it. Null when none.
   */
  footer?: StoredFooter | null
  /** Shared workspace portal header settings, editable from any project. */
  header?: StoredHeader | null
  /**
   * Whether portal projects should render shared workspace chrome or their own
   * project-specific header/footer values. Defaults to workspace in settings.
   */
  portalChromeScope: PortalChromeScope
}

export type PortalWorkspaceResolution =
  | { kind: "workspace"; workspace: PublicWorkspace }
  | { kind: "login_required" }
  | { kind: "not_found" }

export interface PublicFolderSummary {
  id: string
  display_name: string
  kind: "user" | "topic" | "system"
  parent_folder_id: string | null
  document_count: number
  sort_order: number | null
  /** Explicit per-folder portal icon; null/unset falls back to name-based resolution. */
  icon?: string | null
  updated_at: string
}

export interface PublicDocSummary {
  id: string
  /**
   * Human-readable URL slug (public_slug). Always populated by the data layer
   * (falls back to `id` when unset); optional only so non-data-layer producers
   * of this shape (portal builder fixtures) need not supply it.
   */
  slug?: string
  title: string
  description?: string
  readTimeMinutes?: number
  source: string | null
  /**
   * Explicit publication date, when the document declares one. Changelog pages
   * order and label by this in preference to `updated_at`, so editing an entry
   * does not re-date it. See lib/documents/published-date.
   */
  published_at?: string | null
  updated_at?: string
  folder_id?: string | null
  /** Explicit manual position within its folder (null = no explicit order). */
  sort_order?: number | null
}

export interface PublicTaxonomy {
  topics: PublicFolderSummary[]
  rootFolders: PublicFolderSummary[]
  allFolders?: PublicFolderSummary[]
  /** Structural roots hidden in favor of their children. */
  promotedRootIds?: string[]
}

export interface PublicFolderDetail {
  folder: {
    id: string
    display_name: string
    kind: "user" | "topic" | "system"
    content: string | null
  }
  ancestors: Array<{ id: string; display_name: string }>
  children: PublicFolderSummary[]
  documents: PublicDocSummary[]
}

export interface PublicDocument {
  id: string
  /** Human-readable URL slug (public_slug); falls back to `id` when unset. */
  slug: string
  title: string
  content: string
  source: string | null
  author: string | null
  /** Social-preview image (og:image) for the document page. */
  cover?: PublicDocCover | null
  /** Explicit publication date; dated surfaces prefer it over `updated_at`. */
  published_at?: string | null
  updated_at: string
  folder_id: string | null
}

export interface PublicSearchHit {
  id: string
  /** Human-readable URL slug (public_slug); falls back to `id` when unset. */
  slug: string
  title: string
  source: string | null
  snippet: string
}

export interface PublicDocumentLinks {
  outbound: DocumentLinkEntry[]
  inbound: DocumentLinkEntry[]
}

function isPortalWrapperFolder(name: string): boolean {
  return /\b(help center|knowledge base|docs|documentation)\b/i.test(name)
}

// ---------------------------------------------------------------------------
// Workspace resolution (public or member-authenticated portal gate)
// ---------------------------------------------------------------------------
// Resolve a workspace by its URL key — the editable `slug`.
async function loadWorkspaceBySlug(
  admin: SupabaseClient,
  key: string,
): Promise<PublicWorkspace | null> {
  if (!key || key.length > 200) return null
  const columns = "id, name, slug, icon_url, settings"

  const { data, error } = await admin
    .from("workspaces")
    .select(columns)
    .eq("slug", key)
    .maybeSingle()
  if (error || !data) return null

  const settings = data.settings as Record<string, unknown> | null
  // Unconverted prospect portals expire after their TTL — serve as not-found.
  if (isProspectPortalExpired(settings)) return null
  const iconUrl = appAbsoluteAssetUrl((data.icon_url as string | null) ?? null)
  return {
    id: data.id as string,
    name: data.name as string,
    slug: data.slug as string,
    iconUrl,
    isPublic: settings?.kb_public === true,
    branding: getKbBranding(settings, data.name as string, iconUrl),
    customDomain: getKbCustomDomain(settings),
    portalAddressScope: getPortalAddressScope(settings),
    portalAddressMode: getPortalAddressMode(settings),
    websiteUrl: getLandingPageUrl(settings),
    footer: getKbFooter(settings),
    header: getKbHeader(settings),
    portalChromeScope: getPortalChromeScope(settings),
  }
}

async function loadWorkspaceById(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<PublicWorkspace | null> {
  if (!UUID_RE.test(workspaceId)) return null
  const { data, error } = await admin
    .from("workspaces")
    .select("id, name, slug, icon_url, settings")
    .eq("id", workspaceId)
    .maybeSingle()

  if (error || !data) return null
  const settings = data.settings as Record<string, unknown> | null
  // Unconverted prospect portals expire after their TTL — serve as not-found.
  if (isProspectPortalExpired(settings)) return null
  const iconUrl = appAbsoluteAssetUrl((data.icon_url as string | null) ?? null)
  return {
    id: data.id as string,
    name: data.name as string,
    slug: data.slug as string,
    iconUrl,
    isPublic: settings?.kb_public === true,
    branding: getKbBranding(settings, data.name as string, iconUrl),
    customDomain: getKbCustomDomain(settings),
    portalAddressScope: getPortalAddressScope(settings),
    portalAddressMode: getPortalAddressMode(settings),
    websiteUrl: getLandingPageUrl(settings),
    footer: getKbFooter(settings),
    header: getKbHeader(settings),
    portalChromeScope: getPortalChromeScope(settings),
  }
}

async function isActiveWorkspaceMember(
  admin: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle()

  return !error && !!data
}

function isTransientPortalAuthFailure(err: unknown): boolean {
  if (err instanceof TimeoutError) return true
  if (err instanceof TypeError) return true
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name?: unknown }).name === "AbortError" ||
      (err as { name?: unknown }).name === "AuthCheckError")
  )
}

// Cross-request cache for the slug→workspace row. Caller-independent (it only
// reads the `workspaces` row; the published-vs-member visibility decision stays
// fresh in getPortalWorkspace below), so it is safe to share across requests
// and cannot leak a private portal.
const loadWorkspaceBySlugCached = unstable_cache(
  async (slug: string): Promise<PublicWorkspace | null> =>
    loadWorkspaceBySlug(createAdminClient(), slug),
  ["public-kb-workspace-by-slug"],
  { revalidate: PUBLIC_KB_CACHE_SECONDS, tags: [PUBLIC_KB_CACHE_TAG] },
)

// Wrapped in React.cache so the layout, page, and generateMetadata share a
// single query per request.
export const getPublishedWorkspace = cache(
  async (slug: string): Promise<PublicWorkspace | null> => {
    const workspace = await loadWorkspaceBySlugCached(slug)
    return workspace?.isPublic ? workspace : null
  },
)

export const getPortalWorkspace = cache(
  async (slug: string): Promise<PortalWorkspaceResolution> => {
    const admin = createAdminClient()
    const workspace = await loadWorkspaceBySlugCached(slug)
    return gatePortalWorkspace(admin, workspace)
  },
)

// Resolve a portal workspace WITHOUT applying any public/member gate — just the
// row (or null). requirePortal uses this so it can gate on the resolved
// PROJECT's visibility instead of the workspace-wide flag. React-cached so the
// layout + page + generateMetadata share one query per request. Never render
// gated content from this directly; always pass through a gate first.
export const resolvePortalWorkspaceUngated = cache(
  async (slug: string): Promise<PublicWorkspace | null> =>
    loadWorkspaceBySlugCached(slug),
)

// Apply the published-vs-member portal gate to an already-loaded workspace.
async function gatePortalWorkspace(
  admin: SupabaseClient,
  workspace: PublicWorkspace | null,
): Promise<PortalWorkspaceResolution> {
  if (!workspace) return { kind: "not_found" }
  return gatePortalVisibility(admin, workspace, workspace.isPublic)
}

// The core public/member decision, parameterized on an explicit `isPublic` flag
// so it serves both the workspace-wide gate (kb_public) and the per-project gate
// (a project's visibility). Public → anyone; private → signed-in active members
// only. Fails closed: a transient auth failure resolves to not_found.
async function gatePortalVisibility(
  admin: SupabaseClient,
  workspace: PublicWorkspace,
  isPublic: boolean,
): Promise<PortalWorkspaceResolution> {
  if (isPublic) return { kind: "workspace", workspace }

  let user: Awaited<ReturnType<typeof getAuthUser>>
  try {
    user = await getAuthUser()
  } catch (err) {
    if (isTransientPortalAuthFailure(err)) {
      console.warn("[Breezify] Public KB auth check unavailable:", err)
      return { kind: "not_found" }
    }
    throw err
  }
  if (!user) return { kind: "login_required" }

  const isMember = await isActiveWorkspaceMember(admin, workspace.id, user.id)
  return isMember ? { kind: "workspace", workspace } : { kind: "not_found" }
}

/**
 * Gate an already-resolved portal workspace on a per-project visibility flag.
 * Exposed for requirePortal, which decides `isPublic` from the resolved
 * project's `visibility` (falling back to the workspace flag for legacy default
 * projects that have no published row).
 */
export async function gatePortalProjectAccess(
  workspace: PublicWorkspace,
  isPublic: boolean,
): Promise<PortalWorkspaceResolution> {
  return gatePortalVisibility(createAdminClient(), workspace, isPublic)
}

/**
 * Resolve + gate a portal workspace by its id (used when a project slug has
 * already resolved the owning workspace). Same public/member visibility gate as
 * getPortalWorkspace, which keys on the workspace slug.
 */
export const getPortalWorkspaceById = cache(
  async (workspaceId: string): Promise<PortalWorkspaceResolution> => {
    const admin = createAdminClient()
    const workspace = await loadWorkspaceById(admin, workspaceId)
    return gatePortalWorkspace(admin, workspace)
  },
)

// ---------------------------------------------------------------------------
// Project scope
//
// A KB project may be scoped to a set of root folders. When a scope is present,
// taxonomy roots + documents are restricted to those folders and ALL their
// descendants; when absent, the whole workspace's public content is surfaced
// (legacy behavior). A scope is normalized to a stable, deduped, sorted string
// so it can key the unstable_cache entry without two projects sharing a cache
// slot. `undefined` means "no scope" and must serialize to a distinct key.
// ---------------------------------------------------------------------------
// A scope entry is a root folder id, optionally wrapped to mark the folder as
// a PROMOTED root: its children surface as the portal's top-level sections in
// place of the folder itself (the explicit version of the wrapper-name
// heuristic below). `rootOnly` makes a promoted folder structural: that folder
// is visible, but only separately selected child entries expand recursively.
// `explicitDocs` (always alongside rootOnly) drops the structural folder's own
// direct documents from the implicit set — only `{ doc }` entries inside it are
// served. `{ doc }` includes one document; `{ workspaceDocs: true }` includes
// the workspace-level (folderless) documents a provided scope otherwise
// excludes. Plain string entries keep the legacy shape — existing stored
// scopes never migrate.
export type PortalScopeEntry =
  | string
  | { id: string; promote?: boolean; rootOnly?: boolean; explicitDocs?: boolean }
  | { doc: string }
  | { workspaceDocs: true }
export type PublicKbScope = PortalScopeEntry[] | null | undefined

/**
 * Folder id of a scope entry, or "" for entries that carry no folder id
 * (`{ doc }` / `{ workspaceDocs }`). "" never passes UUID validation, so
 * id-oriented callers naturally skip the non-folder shapes.
 */
export function scopeEntryId(entry: PortalScopeEntry): string {
  if (typeof entry === "string") return entry
  if ("id" in entry) return entry.id
  return ""
}

/**
 * The explicitly promoted root ids of a scope (deduped, sorted,
 * UUID-validated). Empty for legacy plain-string scopes and unscoped projects.
 */
export function scopePromotedIds(scope: PublicKbScope): string[] {
  if (!Array.isArray(scope)) return []
  return Array.from(
    new Set(
      scope
        .filter(
          (entry): entry is { id: string; promote?: boolean; rootOnly?: boolean } =>
            typeof entry === "object" &&
            entry !== null &&
            "id" in entry &&
            entry.promote === true,
        )
        .map((entry) => entry.id)
        .filter((id) => UUID_RE.test(id)),
    ),
  ).sort()
}

export interface ScopeFolderRow {
  id: string
  kind: string
  parent_folder_id: string | null
}

/**
 * Whether a project explicitly PROVIDED a scope. Any array is a scope, including
 * `[]`: an empty array is the fail-closed state left when the last scoped folder
 * is deleted. Only null/undefined mean the whole workspace. This distinction is
 * security-sensitive — treating `[]` as unscoped would expose every public doc
 * after deleting a project's sole scope root.
 */
export function isScopeProvided(scope: PublicKbScope): boolean {
  return Array.isArray(scope)
}

/**
 * Sentinel cache key for a provided scope that resolves to NO valid root ids
 * (typoed / non-UUID scope). Distinct from the unscoped `""` key so a
 * provided-but-invalid scope can never share an entry with — and thus widen to —
 * the whole-workspace read.
 */
const INVALID_SCOPE_KEY = "invalid"

/**
 * Stable cache key for a project scope. `""` is the unscoped (whole-workspace)
 * key; a scoped project keys on its deduped, sorted, UUID-validated root ids so
 * two projects never collide in unstable_cache. A PROVIDED scope whose ids are
 * all invalid keys to `INVALID_SCOPE_KEY` (fail closed), never `""`.
 */
export function normalizeScopeKey(scope: PublicKbScope): string {
  if (!isScopeProvided(scope)) return ""
  const keys = new Set<string>()
  for (const entry of scope as PortalScopeEntry[]) {
    if (typeof entry === "object" && "doc" in entry) {
      if (UUID_RE.test(entry.doc)) keys.add(`doc:${entry.doc}`)
      continue
    }
    if (typeof entry === "object" && "workspaceDocs" in entry) {
      keys.add("workspace-docs")
      continue
    }
    const id = scopeEntryId(entry)
    if (!UUID_RE.test(id)) continue
    const rootOnly = typeof entry === "object" && entry.rootOnly === true
    const explicitDocs = typeof entry === "object" && entry.explicitDocs === true
    keys.add(`${id}${rootOnly ? "!root" : ""}${explicitDocs ? "!xdocs" : ""}`)
  }
  const validEntries = Array.from(keys).sort()
  return validEntries.length > 0 ? validEntries.join(",") : INVALID_SCOPE_KEY
}

interface ScopeParts {
  recursiveRootIds: string[]
  rootOnlyIds: string[]
  /** Structural folders whose direct docs are NOT implicit (⊆ rootOnlyIds). */
  explicitDocsIds: string[]
  /** Explicitly included document ids. */
  docIds: string[]
  /** Whether workspace-level (folderless) docs are included. */
  includeWorkspaceDocs: boolean
}

/** Split a provided scope into recursive content roots and structural roots. */
function scopeParts(scope: PublicKbScope): ScopeParts | null {
  if (!Array.isArray(scope)) return null
  const recursiveRootIds = new Set<string>()
  const rootOnlyIds = new Set<string>()
  const explicitDocsIds = new Set<string>()
  const docIds = new Set<string>()
  let includeWorkspaceDocs = false
  for (const entry of scope) {
    if (typeof entry === "object" && "doc" in entry) {
      if (UUID_RE.test(entry.doc)) docIds.add(entry.doc)
      continue
    }
    if (typeof entry === "object" && "workspaceDocs" in entry) {
      includeWorkspaceDocs = true
      continue
    }
    const id = scopeEntryId(entry)
    if (!UUID_RE.test(id)) continue
    const explicitDocs = typeof entry === "object" && entry.explicitDocs === true
    // explicitDocs implies structural: a malformed recursive+explicitDocs entry
    // fails closed to structural rather than widening.
    if ((typeof entry === "object" && entry.rootOnly === true) || explicitDocs) {
      rootOnlyIds.add(id)
      if (explicitDocs) explicitDocsIds.add(id)
    } else {
      recursiveRootIds.add(id)
    }
  }
  return {
    recursiveRootIds: Array.from(recursiveRootIds).sort(),
    rootOnlyIds: Array.from(rootOnlyIds).sort(),
    explicitDocsIds: Array.from(explicitDocsIds).sort(),
    docIds: Array.from(docIds).sort(),
    includeWorkspaceDocs,
  }
}

/**
 * Pure scope expansion: from the workspace's public-visible folder rows, return
 * the set of scope roots + all their descendants (topics are never visible).
 * Exported for unit testing; `scopedFolderIdSet` is the DB-backed wrapper.
 */
export function expandScope(
  rows: ScopeFolderRow[],
  scopeRootIds: string[],
  rootOnlyIds: string[] = [],
): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  const visible = new Set<string>()
  for (const row of rows) {
    if (row.kind === "topic") continue
    visible.add(row.id)
    const list = childrenByParent.get(row.parent_folder_id ?? "")
    if (list) list.push(row.id)
    else childrenByParent.set(row.parent_folder_id ?? "", [row.id])
  }

  const allowed = new Set(rootOnlyIds.filter((id) => visible.has(id)))
  const queue = scopeRootIds.filter((id) => visible.has(id))
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (allowed.has(id)) continue
    allowed.add(id)
    for (const child of childrenByParent.get(id) ?? []) queue.push(child)
  }
  return allowed
}

/**
 * A failed read must never masquerade as "no content". The public readers feed
 * 60s `unstable_cache` entries, so a transient DB error that quietly resolves
 * to an empty array gets memoized and served to every visitor as an empty
 * portal (folders with no docs, blank folder pages) until the next successful
 * revalidation. Throwing keeps the bad snapshot out of the cache — Next.js
 * does not store rejected entries — and surfaces the failure in function logs.
 */
function assertNoQueryError(
  context: string,
  error: { message: string } | null | undefined,
): void {
  if (error) {
    throw new Error(`[public-kb] ${context} query failed: ${error.message}`)
  }
}

/**
 * Expand a set of root folder ids to themselves + all descendants, intersected
 * with the workspace's public-visible (non-topic) folders. Folders are loaded
 * once and walked in memory (the public folder tree per workspace is small).
 */
async function scopedFolderIdSet(
  admin: SupabaseClient,
  workspaceId: string,
  scopeRootIds: string[],
  rootOnlyIds: string[] = [],
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("folders")
    .select("id, kind, parent_folder_id")
    .eq("workspace_id", workspaceId)
    .eq("visibility", PUBLIC_FOLDER_VISIBILITY)
  assertNoQueryError("scoped folder set", error)

  return expandScope((data ?? []) as ScopeFolderRow[], scopeRootIds, rootOnlyIds)
}

// ---------------------------------------------------------------------------
// Visibility helpers
// ---------------------------------------------------------------------------

/**
 * The public-visible (non-topic) folder ids for a workspace. When `scope` is an
 * ARRAY of root folder ids (a provided scope), the result is restricted to those
 * roots + their descendants — INCLUDING an empty array, which yields an empty set
 * (fail closed) rather than widening to the whole workspace. `null`/`undefined`
 * means "no scope": the whole workspace's public folder set.
 */
async function publicVisibleFolderIds(
  admin: SupabaseClient,
  workspaceId: string,
  scope?: PublicKbScope,
): Promise<string[]> {
  if (Array.isArray(scope)) {
    const parts = scopeParts(scope) as ScopeParts
    const allowed = await scopedFolderIdSet(
      admin,
      workspaceId,
      parts.recursiveRootIds,
      parts.rootOnlyIds,
    )
    return Array.from(allowed)
  }
  const { data, error } = await admin
    .from("folders")
    .select("id, kind")
    .eq("workspace_id", workspaceId)
    .eq("visibility", PUBLIC_FOLDER_VISIBILITY)
  assertNoQueryError("public visible folders", error)
  return (data ?? [])
    .filter((row) => (row as { kind: string }).kind !== "topic")
    .map((row) => (row as { id: string }).id)
}

/**
 * Public-visible folder ids for a workspace/project scope. This is the
 * service-role-backed counterpart to the public portal read path; callers use it
 * when an authenticated builder surface still needs to honor a public KB
 * project's content scope.
 */
export async function getPublicVisibleFolderIds(
  workspaceId: string,
  scope?: PublicKbScope,
): Promise<string[]> {
  return publicVisibleFolderIds(
    createAdminClient(),
    workspaceId,
    isScopeProvided(scope) ? scope : undefined,
  )
}

/**
 * PostgREST `.or()` filter for the visible document set.
 *
 * Unscoped (whole-workspace): workspace-level docs (folder_id IS NULL) PLUS docs
 * in any visible folder — the legacy contract.
 *
 * Scoped: ONLY docs inside the scoped folder set. Workspace-level docs belong to
 * no folder, so they fall outside a folder-scoped project and are excluded. An
 * empty scoped set matches nothing.
 */
export function visibleDocFilter(visibleFolderIds: string[], scoped = false): string {
  if (scoped) {
    return visibleFolderIds.length > 0
      ? `folder_id.in.(${visibleFolderIds.join(",")})`
      : "folder_id.in.(00000000-0000-0000-0000-000000000000)"
  }
  return visibleFolderIds.length > 0
    ? `folder_id.is.null,folder_id.in.(${visibleFolderIds.join(",")})`
    : "folder_id.is.null"
}

// ---------------------------------------------------------------------------
// Document-level scope resolution
//
// With `explicitDocs` folders and `{ doc }` entries, "which folders are
// visible" (taxonomy) and "which documents are served" diverge: an explicitDocs
// folder renders in the tree but only its picked documents are readable. Every
// document read path resolves a PublicDocScope once and applies BOTH the SQL
// prefilter (docScopeFilter) and the in-memory gate (docScopePermits) — the SQL
// `id.in.(docIds)` arm alone could match a picked doc whose folder has since
// left the visible set, so the predicate is not optional.
// ---------------------------------------------------------------------------
export interface PublicDocScope {
  scoped: boolean
  /** Taxonomy-visible folders (the full public set when unscoped). */
  folderIds: Set<string>
  /** Folders whose direct documents are all served (folderIds minus explicitDocs). */
  docFolderIds: Set<string>
  /** Explicitly included document ids. */
  docIds: Set<string>
  /** Whether workspace-level (folderless) docs are served. */
  includeWorkspaceDocs: boolean
}

async function resolveDocScopeFromParts(
  admin: SupabaseClient,
  workspaceId: string,
  parts: ScopeParts | null,
): Promise<PublicDocScope> {
  if (parts === null) {
    const all = new Set(await publicVisibleFolderIds(admin, workspaceId))
    return {
      scoped: false,
      folderIds: all,
      docFolderIds: all,
      docIds: new Set(),
      includeWorkspaceDocs: true,
    }
  }
  const allowed = await scopedFolderIdSet(
    admin,
    workspaceId,
    parts.recursiveRootIds,
    parts.rootOnlyIds,
  )
  const explicit = new Set(parts.explicitDocsIds)
  const docFolderIds = new Set(
    Array.from(allowed).filter((id) => !explicit.has(id)),
  )
  return {
    scoped: true,
    folderIds: allowed,
    docFolderIds,
    docIds: new Set(parts.docIds),
    includeWorkspaceDocs: parts.includeWorkspaceDocs,
  }
}

/**
 * Resolve a project scope into the document-serving sets. Admin-backed; safe to
 * call from authenticated builder routes that must mirror the public read path.
 */
export async function getPublicDocScope(
  workspaceId: string,
  scope?: PublicKbScope,
): Promise<PublicDocScope> {
  return resolveDocScopeFromParts(
    createAdminClient(),
    workspaceId,
    scopeParts(scope),
  )
}

/** PostgREST `.or()` prefilter for a resolved doc scope. Fails closed to a match-nothing filter. */
export function docScopeFilter(ds: PublicDocScope): string {
  const clauses: string[] = []
  if (ds.includeWorkspaceDocs) clauses.push("folder_id.is.null")
  if (ds.docFolderIds.size > 0) {
    clauses.push(`folder_id.in.(${Array.from(ds.docFolderIds).sort().join(",")})`)
  }
  if (ds.docIds.size > 0) {
    clauses.push(`id.in.(${Array.from(ds.docIds).sort().join(",")})`)
  }
  return clauses.length > 0
    ? clauses.join(",")
    : "folder_id.in.(00000000-0000-0000-0000-000000000000)"
}

/**
 * Exact in-memory gate for a fetched document row. A picked doc is served only
 * while its folder is still taxonomy-visible; a folderless doc only when the
 * scope includes workspace docs or picked it explicitly.
 */
export function docScopePermits(
  ds: PublicDocScope,
  doc: { id: string; folder_id: string | null },
): boolean {
  if (doc.folder_id === null || doc.folder_id === undefined) {
    return ds.includeWorkspaceDocs || ds.docIds.has(doc.id)
  }
  if (ds.docFolderIds.has(doc.folder_id)) return true
  return ds.docIds.has(doc.id) && ds.folderIds.has(doc.folder_id)
}

/**
 * Whether one document is inside a project's scope. True for unscoped
 * projects. Used by the portal doc route to 404 documents a scoped project
 * does not serve (outside folders, or unpicked inside an explicitDocs folder).
 */
export async function isDocInScope(
  workspaceId: string,
  doc: { id: string; folder_id: string | null },
  scope: PublicKbScope,
): Promise<boolean> {
  if (!isScopeProvided(scope)) return true
  const ds = await getPublicDocScope(workspaceId, scope)
  return docScopePermits(ds, doc)
}

// ---------------------------------------------------------------------------
// Taxonomy (home browse + nav)
// ---------------------------------------------------------------------------
// The cached worker takes a normalized scope key as a leading argument so that
// `unstable_cache` keys distinct projects (and the unscoped whole-workspace
// read) to distinct entries. `scopeRootIds` carries the actual ids to filter on.
async function fetchPublicTaxonomy(
  workspaceId: string,
  recursiveRootIds: string[] | null,
  rootOnlyIds: string[],
  promotedRootIds: string[],
): Promise<PublicTaxonomy> {
  const admin = createAdminClient()
  // `recursiveRootIds === null` → whole-workspace (no scope). A non-null array — even
  // empty — is a PROVIDED scope: restrict to that (possibly empty) folder set so
  // a provided-but-invalid scope renders an empty project, not the whole workspace.
  const allowed =
    recursiveRootIds !== null
      ? await scopedFolderIdSet(admin, workspaceId, recursiveRootIds, rootOnlyIds)
      : null
  const { data, error } = await admin
    .from("folder_stats")
    .select("folder_id, name, display_name, kind, parent_folder_id, visibility, sort_order, icon, document_count, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("visibility", PUBLIC_FOLDER_VISIBILITY)
  assertNoQueryError("public taxonomy", error)

  const rows: PublicFolderSummary[] = (data ?? [])
    .filter((row) =>
      allowed ? allowed.has((row as { folder_id: string }).folder_id) : true,
    )
    .map((row) => {
    const r = row as {
      folder_id: string
      name: string
      display_name: string | null
      kind: "user" | "topic" | "system"
      parent_folder_id: string | null
      sort_order?: number | null
      icon?: string | null
      document_count: number
      updated_at: string
    }
    return {
      id: r.folder_id,
      // folders.display_name is nullable; fall back to the folder's name.
      display_name: r.display_name || r.name,
      kind: r.kind,
      parent_folder_id: r.parent_folder_id,
      sort_order: typeof r.sort_order === "number" ? r.sort_order : null,
      icon: r.icon ?? null,
      document_count: r.document_count,
      updated_at: r.updated_at,
    }
  })

  return shapePublicTaxonomy(rows, allowed, promotedRootIds, rootOnlyIds)
}

const getPublicTaxonomyCached = unstable_cache(
  async (
    _scopeKey: string,
    workspaceId: string,
    recursiveRootIds: string[] | null,
    rootOnlyIds: string[],
    // Explicitly promoted scope roots (children become top-level sections).
    // Participates in the unstable_cache key via the argument list, so two
    // projects sharing ids but differing in promotion never share a slot.
    promotedRootIds: string[],
  ): Promise<PublicTaxonomy> =>
    fetchPublicTaxonomy(workspaceId, recursiveRootIds, rootOnlyIds, promotedRootIds),
  ["public-kb-taxonomy"],
  { revalidate: PUBLIC_KB_CACHE_SECONDS, tags: [PUBLIC_KB_CACHE_TAG] },
)

/**
 * Pure taxonomy shaping: which folders render as the portal's top-level
 * sections. Exported for unit testing; the cached taxonomy read is the only
 * production caller.
 *
 * A "root" is a top-level folder, or — within a scoped project — a folder
 * whose parent is outside the scope (i.e. a scope root). A root is a
 * structural WRAPPER (its children surface in its place) when the scope
 * explicitly promotes it (`{ id, promote: true }` entry) or — legacy heuristic
 * — when its name reads as a container ("Docs", "Help Center", ...).
 */
export function shapePublicTaxonomy(
  rows: PublicFolderSummary[],
  allowed: Set<string> | null,
  promotedRootIds: string[] = [],
  rootOnlyIds: string[] = [],
): PublicTaxonomy {
  const userFolders = rows.filter((r) => r.kind === "user")
  const isRoot = (folder: PublicFolderSummary): boolean => {
    if (folder.parent_folder_id === null) return true
    return allowed ? !allowed.has(folder.parent_folder_id) : false
  }
  // Sections honor an explicit folder sort_order (nulls last), then name — so
  // a curated ordering (e.g. Getting Started first) survives promotion instead
  // of collapsing to alphabetical.
  const bySortThenName = (a: PublicFolderSummary, b: PublicFolderSummary): number => {
    if (a.sort_order !== null && b.sort_order !== null && a.sort_order !== b.sort_order) {
      return a.sort_order - b.sort_order
    }
    if (a.sort_order !== null && b.sort_order === null) return -1
    if (a.sort_order === null && b.sort_order !== null) return 1
    return (a.display_name ?? "").localeCompare(b.display_name ?? "")
  }
  const rootFolders = userFolders.filter(isRoot).sort(bySortThenName)
  const explicitPromoted = new Set([...promotedRootIds, ...rootOnlyIds])
  const wrapperRootIds = new Set(
    rootFolders
      .filter(
        (folder) =>
          explicitPromoted.has(folder.id) ||
          isPortalWrapperFolder(folder.display_name),
      )
      .map((folder) => folder.id),
  )
  const promotedChildren = userFolders.filter((folder) =>
    wrapperRootIds.has(folder.parent_folder_id ?? ""),
  )
  const visibleRoots = [
    ...promotedChildren,
    ...rootFolders.filter((folder) => !wrapperRootIds.has(folder.id)),
  ].sort(bySortThenName)

  return {
    topics: [],
    rootFolders: visibleRoots,
    allFolders: userFolders,
    promotedRootIds: Array.from(wrapperRootIds),
  }
}

/**
 * Public taxonomy (home browse + nav) for a workspace. When `scope` is an array
 * of root folder ids, the result is restricted to those folders and descendants;
 * `[]` returns an empty taxonomy. Only omitted/null scope returns the whole
 * workspace. Scope participates in the cache key so projects never collide.
 */
export async function getPublicTaxonomy(
  workspaceId: string,
  scope?: PublicKbScope,
): Promise<PublicTaxonomy> {
  const parts = scopeParts(scope)
  return getPublicTaxonomyCached(
    normalizeScopeKey(scope),
    workspaceId,
    parts?.recursiveRootIds ?? null,
    parts?.rootOnlyIds ?? [],
    promotedIdsForParts(scope, parts),
  )
}

// Promotion only applies to ids that survived scope validation.
function promotedIdsForParts(
  scope: PublicKbScope | undefined,
  parts: ScopeParts | null,
): string[] {
  const validIds = new Set([
    ...(parts?.recursiveRootIds ?? []),
    ...(parts?.rootOnlyIds ?? []),
  ])
  return scopePromotedIds(scope).filter(
    (id) => parts === null || validIds.has(id),
  )
}

/**
 * Uncached taxonomy read for authenticated ADMIN surfaces (portal builder,
 * draft/preview, publish-time layout baking). The public portal's 60s
 * `unstable_cache` snapshot is stale-while-revalidate: the first read after a
 * content change can still serve the pre-change entry — for a fresh workspace
 * that's an EMPTY taxonomy, which the normalize pass then bakes into the
 * rendered (or worse, persisted) layout as "no sidebar, no categories".
 * Admin reads are low-traffic and need read-your-writes, so they skip the
 * cache entirely.
 */
export async function getPublicTaxonomyFresh(
  workspaceId: string,
  scope?: PublicKbScope,
): Promise<PublicTaxonomy> {
  const parts = scopeParts(scope)
  return fetchPublicTaxonomy(
    workspaceId,
    parts?.recursiveRootIds ?? null,
    parts?.rootOnlyIds ?? [],
    promotedIdsForParts(scope, parts),
  )
}

async function fetchPublicDocRows(
  workspaceId: string,
  // Null = whole-workspace (no scope). A non-null parts object — even one
  // resolving to nothing — is a PROVIDED scope and fails closed.
  parts: ScopeParts | null,
): Promise<PublicDocRow[]> {
  const admin = createAdminClient()
  const ds = await resolveDocScopeFromParts(admin, workspaceId, parts)
  const { data, error } = await admin
    .from("documents")
    .select("id, public_slug, title, content, source, source_metadata, updated_at, folder_id, sort_order")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .in("document_type", ["source", "page"])
    .or(docScopeFilter(ds))
    .order("updated_at", { ascending: false })
  assertNoQueryError("public documents", error)
  // Unfiled GitHub repo files are raw sync captures, hidden from the
  // knowledge base tree (isNavigableDocument); the portal mirrors that.
  return ((data ?? []) as PublicDocRow[]).filter(
    (row) =>
      isNavigableDocument({ source: row.source, folder_id: row.folder_id ?? null }) &&
      docScopePermits(ds, { id: row.id, folder_id: row.folder_id ?? null }),
  )
}

async function fetchPublicDocuments(
  workspaceId: string,
  parts: ScopeParts | null,
): Promise<PublicDocSummary[]> {
  return (await fetchPublicDocRows(workspaceId, parts)).map(toDocSummary)
}

const getPublicDocumentsCached = unstable_cache(
  async (
    _scopeKey: string,
    workspaceId: string,
    parts: ScopeParts | null,
  ): Promise<PublicDocSummary[]> => fetchPublicDocuments(workspaceId, parts),
  ["public-kb-documents"],
  { revalidate: PUBLIC_KB_CACHE_SECONDS, tags: [PUBLIC_KB_CACHE_TAG] },
)

/**
 * Every public document for a workspace (including docs inside public user
 * folders). Array scopes return only documents inside those folders and their
 * descendants; `[]` returns none. Workspace-level docs are excluded from every
 * array-scoped project. Omitted/null scope returns the full visible set.
 */
export async function getPublicDocuments(
  workspaceId: string,
  scope?: PublicKbScope,
): Promise<PublicDocSummary[]> {
  return getPublicDocumentsCached(
    normalizeScopeKey(scope),
    workspaceId,
    scopeParts(scope),
  )
}

/**
 * Uncached document read for authenticated ADMIN surfaces. See
 * getPublicTaxonomyFresh for why the builder/publish paths must not read
 * through the public 60s cache.
 */
export async function getPublicDocumentsFresh(
  workspaceId: string,
  scope?: PublicKbScope,
): Promise<PublicDocSummary[]> {
  return fetchPublicDocuments(workspaceId, scopeParts(scope))
}

/** A public document summary with its stored body attached. */
export interface PublicDocWithContent extends PublicDocSummary {
  /** Raw stored body — markdown or authored HTML. "" when empty. */
  content: string
}

/**
 * Every public document for a workspace WITH its body, for whole-KB text output
 * (llms-full.txt). Applies exactly the same visibility + scope contract as
 * getPublicDocuments.
 *
 * Deliberately uncached: the payload is the entire knowledge base, which blows
 * past the Next data-cache entry limit, so callers cache the rendered response
 * at the HTTP layer instead.
 */
export async function getPublicDocumentsWithContent(
  workspaceId: string,
  scope?: PublicKbScope,
): Promise<PublicDocWithContent[]> {
  const rows = await fetchPublicDocRows(workspaceId, scopeParts(scope))
  return rows.map((row) => ({
    ...toDocSummary(row),
    content: typeof row.content === "string" ? row.content : "",
  }))
}

// Back-compat export name for callers that used the original root-only helper.
// The portal home now needs every public document, including docs inside public
// user folders, so this intentionally returns the full visible document set.
export const getRootPublicDocuments = getPublicDocuments

// ---------------------------------------------------------------------------
// Folder detail
// ---------------------------------------------------------------------------
async function loadPublicAncestors(
  admin: SupabaseClient,
  workspaceId: string,
  startParentId: string | null,
): Promise<Array<{ id: string; display_name: string }>> {
  const chain: Array<{ id: string; display_name: string }> = []
  let cursor: string | null = startParentId
  let guard = 0
  while (cursor && guard < 64) {
    const { data, error } = await admin
      .from("folders")
      .select("id, display_name, parent_folder_id, visibility")
      .eq("id", cursor)
      .eq("workspace_id", workspaceId)
      .maybeSingle()
    assertNoQueryError("public ancestors", error)
    if (!data) break
    const row = data as {
      id: string
      display_name: string
      parent_folder_id: string | null
      visibility: string
    }
    // Stop at the first non-public ancestor — never expose a hidden folder's
    // name, even in a breadcrumb.
    if (row.visibility !== PUBLIC_FOLDER_VISIBILITY) break
    chain.unshift({ id: row.id, display_name: row.display_name })
    cursor = row.parent_folder_id
    guard += 1
  }
  return chain
}

/**
 * The set of folder ids a project's scope permits (scope roots + descendants),
 * or `null` for an unscoped (whole-workspace) project. Computes the set once so
 * callers can filter many folders (e.g. a breadcrumb ancestor chain) without one
 * DB round-trip per folder.
 */
export async function scopedFolderIds(
  workspaceId: string,
  scope: PublicKbScope,
): Promise<Set<string> | null> {
  if (!Array.isArray(scope)) return null
  const admin = createAdminClient()
  const parts = scopeParts(scope) as ScopeParts
  return scopedFolderIdSet(
    admin,
    workspaceId,
    parts.recursiveRootIds,
    parts.rootOnlyIds,
  )
}

/**
 * Whether a folder is inside a project's scope. Returns true when scope is
 * absent (whole-workspace project). For a scoped project, true only when
 * the folder is one of the scope roots or a descendant — used by the folder/doc
 * routes to 404 content outside a non-default project's scope.
 */
export async function isFolderInScope(
  workspaceId: string,
  folderId: string,
  scope: PublicKbScope,
): Promise<boolean> {
  const allowed = await scopedFolderIds(workspaceId, scope)
  return allowed === null || allowed.has(folderId)
}

export const getPublicFolderDetail = cache(async (
  workspaceId: string,
  folderId: string,
): Promise<PublicFolderDetail | null> => {
  const admin = createAdminClient()
  const { data: folder, error: folderError } = await admin
    .from("folders")
    .select("id, display_name, name, kind, visibility, parent_folder_id, content")
    .eq("id", folderId)
    .eq("workspace_id", workspaceId)
    .maybeSingle()
  assertNoQueryError("public folder detail", folderError)

  if (!folder) return null
  const f = folder as {
    id: string
    display_name: string
    name: string
    kind: "user" | "topic" | "system"
    visibility: string
    parent_folder_id: string | null
    content: string | null
  }
  if (f.visibility !== PUBLIC_FOLDER_VISIBILITY) return null
  if (f.kind === "topic") return null

  const [childrenRes, docsRes, ancestors] = await Promise.all([
    admin
      .from("folder_stats")
      .select("folder_id, name, display_name, kind, parent_folder_id, visibility, sort_order, icon, document_count, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("parent_folder_id", folderId)
      .eq("visibility", PUBLIC_FOLDER_VISIBILITY)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("display_name", { ascending: true }),
    admin
      .from("documents")
      .select("id, public_slug, title, source, updated_at, folder_id, sort_order")
      .eq("workspace_id", workspaceId)
      .eq("folder_id", folderId)
      .is("deleted_at", null)
      .in("document_type", ["source", "page"])
      // Manually ordered docs first (drag order in the KB sidebar), the rest
      // by recency — matching the portal sidebar's per-folder order.
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("updated_at", { ascending: false }),
    loadPublicAncestors(admin, workspaceId, f.parent_folder_id),
  ])
  assertNoQueryError("public folder children", childrenRes.error)
  assertNoQueryError("public folder documents", docsRes.error)

  const children: PublicFolderSummary[] = (childrenRes.data ?? [])
    .filter((row) => (row as { kind: string }).kind !== "topic")
    .map((row) => {
      const r = row as {
        folder_id: string
        name: string
        display_name: string | null
        kind: "user" | "topic" | "system"
        parent_folder_id: string | null
        sort_order?: number | null
        icon?: string | null
        document_count: number
        updated_at: string
      }
      return {
        id: r.folder_id,
        display_name: r.display_name || r.name,
        kind: r.kind,
        parent_folder_id: r.parent_folder_id,
        sort_order: typeof r.sort_order === "number" ? r.sort_order : null,
        icon: r.icon ?? null,
        document_count: r.document_count,
        updated_at: r.updated_at,
      }
    })

  return {
    folder: {
      id: f.id,
      display_name: f.display_name || f.name,
      kind: f.kind,
      content: f.content,
    },
    ancestors,
    children,
    documents: ((docsRes.data ?? []) as PublicDocRow[]).map(toDocSummary),
  }
})

// ---------------------------------------------------------------------------
// Document detail + links
// ---------------------------------------------------------------------------
export const getPublicDocument = cache(async (
  workspaceId: string,
  idOrSlug: string,
): Promise<PublicDocument | null> => {
  const admin = createAdminClient()
  // Resolve by raw UUID (back-compat) OR by the human-readable public_slug. A
  // UUID-shaped value always matches the primary key; anything else is treated
  // as a slug. Both paths keep the identical scoping: workspace_id, the
  // document_type allowlist (so a synthesized topic_page is never fetchable by
  // direct UUID or slug when it never appears in a listing), deleted_at, and
  // folder visibility below.
  const column = UUID_RE.test(idOrSlug) ? "id" : "public_slug"
  const { data: doc, error: docError } = await admin
    .from("documents")
    .select(
      "id, public_slug, title, content, source, author, source_metadata, updated_at, folder_id, deleted_at",
    )
    .eq(column, idOrSlug)
    .eq("workspace_id", workspaceId)
    .in("document_type", ["source", "page"])
    .maybeSingle()
  assertNoQueryError("public document", docError)

  if (!doc) return null
  const d = doc as Omit<PublicDocument, "slug"> & {
    public_slug: string | null
    deleted_at: string | null
    source_metadata: unknown
  }
  if (d.deleted_at) return null
  if (!isNavigableDocument({ source: d.source, folder_id: d.folder_id })) return null

  if (d.folder_id) {
    const { data: folder, error: folderError } = await admin
      .from("folders")
      .select("visibility, kind")
      .eq("id", d.folder_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle()
    // Without this, a transient error here 404s a perfectly readable doc.
    assertNoQueryError("public document folder gate", folderError)
    const f = folder as { visibility: string; kind: string } | null
    if (!f || f.visibility !== PUBLIC_FOLDER_VISIBILITY || f.kind === "topic") {
      return null
    }
  }

  return {
    id: d.id,
    slug: d.public_slug ?? d.id,
    title: d.title,
    content: d.content,
    source: d.source,
    author: d.author,
    cover: readDocCover(d.source_metadata),
    published_at: readPublishedDate(d.source_metadata),
    updated_at: d.updated_at,
    folder_id: d.folder_id,
  }
})

const VALID_STRENGTHS: ReadonlySet<DocumentLinkStrength> = new Set([
  "related",
  "supersedes",
  "duplicate_of",
])

export async function getPublicDocumentLinks(
  workspaceId: string,
  docId: string,
  scope?: PublicKbScope,
): Promise<PublicDocumentLinks> {
  const admin = createAdminClient()
  const [outboundRes, inboundRes] = await Promise.all([
    admin
      .from("document_links")
      .select("target_document_id, strength")
      .eq("workspace_id", workspaceId)
      .eq("source_document_id", docId),
    admin
      .from("document_links")
      .select("source_document_id, strength")
      .eq("workspace_id", workspaceId)
      .eq("target_document_id", docId),
  ])

  // The related panel is auxiliary: degrade to empty rather than failing the
  // whole doc page, but keep the failure visible in function logs.
  if (outboundRes.error || inboundRes.error) {
    console.error(
      "[public-kb] document links query failed:",
      (outboundRes.error ?? inboundRes.error)!.message,
    )
  }
  const outboundRows = (outboundRes.data ?? []) as Array<{ target_document_id: string; strength: string }>
  const inboundRows = (inboundRes.data ?? []) as Array<{ source_document_id: string; strength: string }>

  const referencedIds = Array.from(
    new Set([
      ...outboundRows.map((r) => r.target_document_id),
      ...inboundRows.map((r) => r.source_document_id),
    ]),
  )
  if (referencedIds.length === 0) return { outbound: [], inbound: [] }

  // Related/linked docs are gated to the same (possibly scoped) visible set as
  // the rest of the portal: a scoped project never relates out to docs the
  // visitor cannot open within that project.
  const ds = await resolveDocScopeFromParts(admin, workspaceId, scopeParts(scope))
  const { data: docs, error: docsError } = await admin
    .from("documents")
    .select("id, public_slug, title, source, document_type, folder_id")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .in("id", referencedIds)
    .in("document_type", ["source", "page"])
    .or(docScopeFilter(ds))
  if (docsError) {
    console.error("[public-kb] document links doc query failed:", docsError.message)
  }

  type LinkDocRow = {
    id: string
    public_slug: string | null
    title: string
    source: string | null
    document_type: string
    folder_id: string | null
  }
  const docsById = new Map<string, LinkDocRow>()
  for (const doc of (docs ?? []) as LinkDocRow[]) {
    if (!isNavigableDocument({ source: doc.source, folder_id: doc.folder_id ?? null })) continue
    if (!docScopePermits(ds, { id: doc.id, folder_id: doc.folder_id ?? null })) continue
    docsById.set(doc.id, doc)
  }

  const toEntry = (id: string, strength: string): DocumentLinkEntry | null => {
    const doc = docsById.get(id)
    if (!doc) return null
    const normalized: DocumentLinkStrength = VALID_STRENGTHS.has(strength as DocumentLinkStrength)
      ? (strength as DocumentLinkStrength)
      : "related"
    return {
      id: doc.id,
      slug: doc.public_slug ?? doc.id,
      title: doc.title,
      source: doc.source,
      document_type: doc.document_type,
      strength: normalized,
    }
  }

  return {
    outbound: outboundRows
      .map((r) => toEntry(r.target_document_id, r.strength))
      .filter((e): e is DocumentLinkEntry => e !== null),
    inbound: inboundRows
      .map((r) => toEntry(r.source_document_id, r.strength))
      .filter((e): e is DocumentLinkEntry => e !== null),
  }
}

// ---------------------------------------------------------------------------
// Search (literal, content-aware via grep_documents, public-filtered)
// ---------------------------------------------------------------------------
function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1")
}

function normalizeSearchSnippet(value: string, title: string): string {
  const text = looksLikeHtml(value)
    ? value.replace(/<[^>]+>/g, " ")
    : value
  const isHeading = /^\s{0,3}#{1,6}\s+/.test(text)
  let withoutBlockSyntax = text
    .replace(/^\s{0,3}#{1,6}\s+/g, "")
    .replace(/\s+#{1,6}\s*$/g, "")
    .replace(/^\s{0,3}>\s?/g, "")
    .replace(/\|/g, " ")
  if (!isHeading) {
    withoutBlockSyntax = withoutBlockSyntax
      .replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/g, "")
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/g, "")
  }
  const snippet = stripInlineMarkdown(withoutBlockSyntax)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
  const normalizedTitle = title.replace(/\s+/g, " ").trim().toLowerCase()
  return snippet.toLowerCase() === normalizedTitle ? "" : snippet
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function searchTerms(value: string): string[] {
  return normalizeSearchText(value).split(" ").filter((term) => term.length > 0)
}

function termVariants(term: string): Set<string> {
  const variants = new Set([term])
  if (term.length <= 2) return variants
  if (term.endsWith("ies")) variants.add(`${term.slice(0, -3)}y`)
  if (term.endsWith("s")) variants.add(term.slice(0, -1))
  if (term.endsWith("y")) variants.add(`${term.slice(0, -1)}ies`)
  variants.add(`${term}s`)
  return variants
}

function termMatchesWordSet(term: string, words: Set<string>): boolean {
  for (const variant of termVariants(term)) {
    if (words.has(variant)) return true
  }
  return false
}

function searchRelevanceScore(input: {
  query: string
  title: string
  snippet: string
}): number {
  const normalizedQuery = normalizeSearchText(input.query)
  const terms = searchTerms(input.query)
  if (!normalizedQuery || terms.length === 0) return 0

  const title = normalizeSearchText(input.title)
  const snippet = normalizeSearchText(input.snippet)
  const titleWords = new Set(searchTerms(input.title))
  const snippetWords = new Set(searchTerms(input.snippet))
  let score = 0

  if (title === normalizedQuery) score += 1000
  if (title.startsWith(normalizedQuery)) score += 800
  if (title.includes(normalizedQuery)) score += 650

  const titleTermMatches = terms.filter((term) => termMatchesWordSet(term, titleWords)).length
  const snippetTermMatches = terms.filter((term) => termMatchesWordSet(term, snippetWords)).length
  if (titleTermMatches === terms.length) score += 350
  score += titleTermMatches * 180

  if (snippet.startsWith(normalizedQuery)) score += 180
  if (snippet.includes(normalizedQuery)) score += 120
  if (snippetTermMatches === terms.length) score += 80
  score += snippetTermMatches * 25

  return score
}

// Upper bound on visible docs scanned for title matches per search.
const TITLE_SCAN_LIMIT = 2000
// Ranks a fuzzy title hit alongside a body hit with a partial title match.
const FUZZY_TITLE_BONUS = 300

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = curr
  }
  return prev[b.length]!
}

/** Edits tolerated for a term of this length: none for short terms. */
function typoBudget(length: number): number {
  if (length >= 8) return 2
  if (length >= 4) return 1
  return 0
}

/**
 * True when `needle` appears in `haystack`, allowing a single typo for long
 * needles (a whole run-together query like "quikstart").
 */
function fuzzyContains(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true
  const budget = needle.length >= 8 ? 1 : 0
  if (budget === 0) return false
  for (let len = needle.length - budget; len <= needle.length + budget; len++) {
    if (len <= 0) continue
    for (let start = 0; start + len <= haystack.length; start++) {
      if (levenshtein(needle, haystack.slice(start, start + len)) <= budget) return true
    }
  }
  return false
}

/**
 * Typo- and spacing-tolerant title match: every query term must appear (as a
 * word prefix, within its typo budget) in the title, or the query with spaces
 * removed must fuzzily appear in the title with spaces removed — so
 * "quit start", "quickstart" and "quick start" all find "Quick Start".
 */
function fuzzyTitleMatches(query: string, title: string): boolean {
  const terms = searchTerms(query)
  if (terms.length === 0) return false
  const words = searchTerms(title)
  if (words.length === 0) return false

  const compactQuery = terms.join("")
  const compactTitle = words.join("")
  if (compactQuery.length >= 3 && fuzzyContains(compactTitle, compactQuery)) return true

  return terms.every((term) =>
    words.some((word) => {
      if (word.startsWith(term)) return true
      // Inside a compound word ("start" in "QuickStart").
      if (term.length >= 4 && word.includes(term)) return true
      const budget = typoBudget(term.length)
      // Typos never touch the first letter — keeps "start" off "status".
      if (budget === 0 || word[0] !== term[0]) return false
      // Compare against the word's prefix of similar length so a partial,
      // misspelled term ("quic", "quit") still matches the full word.
      for (let len = term.length; len <= term.length + budget; len++) {
        if (len <= 0 || len > word.length) continue
        if (levenshtein(term, word.slice(0, len)) <= budget) return true
      }
      return false
    }),
  )
}

export async function searchPublic(
  workspaceId: string,
  query: string,
  limit = 20,
  scope?: PublicKbScope,
): Promise<PublicSearchHit[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const admin = createAdminClient()
  const ds = await resolveDocScopeFromParts(admin, workspaceId, scopeParts(scope))

  // Body grep and the visible-title list load in parallel. The grep RPC only
  // scans document bodies, so titles are matched here in code — that also lets
  // title matching tolerate typos ("quit start") and spacing ("quickstart").
  const [grepResult, titleResult] = await Promise.all([
    admin.rpc("grep_documents", {
      p_workspace_id: workspaceId,
      p_pattern: trimmed,
      p_is_regex: false,
      p_max_results: 80,
      p_max_per_doc: 1,
      p_caller_role: null,
    }),
    // Every publicly visible doc's title, through the public-visibility gate.
    admin
      .from("documents")
      .select("id, public_slug, title, source, folder_id")
      .eq("workspace_id", workspaceId)
      .is("deleted_at", null)
      .in("document_type", ["source", "page"])
      .or(docScopeFilter(ds))
      .limit(TITLE_SCAN_LIMIT),
  ])
  // Search degrades to "no results" rather than failing the page, but a query
  // error should be visible in function logs, not read as a legitimate miss.
  if (grepResult.error) {
    console.error("[public-kb] search grep query failed:", grepResult.error.message)
  }
  if (titleResult.error) {
    console.error("[public-kb] search title query failed:", titleResult.error.message)
  }

  const rows = (
    !grepResult.error && Array.isArray(grepResult.data) ? grepResult.data : []
  ) as Array<{ document_id: string; title: string; line_text: string }>

  const allowedById = new Map<string, PublicDocSummary>()
  const admit = (doc: PublicDocRow): void => {
    if (!isNavigableDocument({ source: doc.source, folder_id: doc.folder_id ?? null })) return
    if (!docScopePermits(ds, { id: doc.id, folder_id: doc.folder_id ?? null })) return
    allowedById.set(doc.id, toDocSummary(doc))
  }

  const visibleDocs = (titleResult.error ? [] : (titleResult.data ?? [])) as PublicDocRow[]
  for (const doc of visibleDocs) admit(doc)
  // When the title scan is complete, it already is the visibility gate for the
  // grep hits; only a truncated (or failed) scan needs the per-id re-check.
  const scanComplete = !titleResult.error && visibleDocs.length < TITLE_SCAN_LIMIT

  // Re-fetch grep-matched docs through the public-visibility gate so role-gated
  // / trashed matches from the (unrestricted) grep are dropped. When a project
  // scope is provided, restrict to its served document set so a scoped portal
  // never surfaces (and links to) docs outside its scope.
  const grepIds = scanComplete
    ? []
    : Array.from(new Set(rows.map((r) => r.document_id))).filter((id) => !allowedById.has(id))
  if (grepIds.length > 0) {
    const { data: allowed, error: allowedError } = await admin
      .from("documents")
      .select("id, public_slug, title, source, folder_id")
      .eq("workspace_id", workspaceId)
      .is("deleted_at", null)
      .in("id", grepIds)
      .in("document_type", ["source", "page"])
      .or(docScopeFilter(ds))
    if (allowedError) {
      console.error("[public-kb] search visibility query failed:", allowedError.message)
    } else {
      for (const doc of (allowed ?? []) as PublicDocRow[]) admit(doc)
    }
  }

  const candidates: Array<PublicSearchHit & { score: number; index: number }> = []
  const seen = new Set<string>()
  const push = (doc: PublicDocSummary, snippet: string, index: number, bonus = 0): void => {
    seen.add(doc.id)
    candidates.push({
      id: doc.id,
      slug: doc.slug ?? doc.id,
      title: doc.title,
      source: doc.source,
      snippet,
      score: searchRelevanceScore({ query: trimmed, title: doc.title, snippet }) + bonus,
      index,
    })
  }
  rows.forEach((row, index) => {
    if (seen.has(row.document_id)) return
    const doc = allowedById.get(row.document_id)
    if (!doc) return
    const titleBonus = fuzzyTitleMatches(trimmed, doc.title) ? FUZZY_TITLE_BONUS : 0
    push(doc, normalizeSearchSnippet(row.line_text, doc.title), index, titleBonus)
  })
  // Title-only matches (body never contains the phrase) — no content snippet.
  visibleDocs.forEach((row, i) => {
    if (seen.has(row.id)) return
    const doc = allowedById.get(row.id)
    if (!doc || !fuzzyTitleMatches(trimmed, doc.title)) return
    push(doc, "", rows.length + i, FUZZY_TITLE_BONUS)
  })
  return candidates
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ score: _score, index: _index, ...hit }) => hit)
}

// Words too generic to retrieve on when a natural-language question has to be
// decomposed into individual grep terms.
const QUESTION_STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "been", "being", "have", "has",
  "had", "having", "does", "did", "doing", "done", "can", "could", "should",
  "would", "will", "shall", "may", "might", "must", "what", "whats", "which",
  "who", "whom", "whose", "when", "where", "why", "how", "that", "this",
  "these", "those", "there", "here", "with", "without", "from", "into",
  "over", "under", "between", "about", "please", "explain", "tell", "show",
  "describe", "help", "need", "want", "know", "mean", "means", "way", "thing",
  "things", "some", "any", "all", "not", "you", "your", "yours", "our",
  "ours", "their", "theirs", "its", "also", "just", "like", "use", "using",
  "used", "get", "got", "make", "makes", "work", "works", "working",
])

function questionKeywords(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []
  const keywords: string[] = []
  const seen = new Set<string>()
  for (const word of words) {
    if (word.length < 3 || QUESTION_STOPWORDS.has(word) || seen.has(word)) continue
    seen.add(word)
    keywords.push(word)
  }
  return keywords.slice(0, 6)
}

/**
 * Retrieval for natural-language questions (public Ask AI). `searchPublic`
 * greps its query as one literal string, which is right for keyword search but
 * matches nothing for a full sentence — so fall back to fanning out over the
 * question's keywords and merging: docs hit by more distinct keywords rank
 * first, ties break toward each term's own relevance ordering. Every path goes
 * through `searchPublic`, so the visibility/scope guard is unchanged.
 */
export async function searchPublicForQuestion(
  workspaceId: string,
  question: string,
  limit = 8,
  scope?: PublicKbScope,
): Promise<PublicSearchHit[]> {
  const direct = await searchPublic(workspaceId, question, limit, scope)
  if (direct.length > 0) return direct

  const keywords = questionKeywords(question)
  if (keywords.length === 0) return []
  const perTerm = await Promise.all(
    keywords.map((term) => searchPublic(workspaceId, term, limit, scope)),
  )

  const merged = new Map<string, { hit: PublicSearchHit; terms: number; bestRank: number }>()
  for (const hits of perTerm) {
    hits.forEach((hit, rank) => {
      const entry = merged.get(hit.id)
      if (entry) {
        entry.terms += 1
        entry.bestRank = Math.min(entry.bestRank, rank)
      } else {
        merged.set(hit.id, { hit, terms: 1, bestRank: rank })
      }
    })
  }
  return Array.from(merged.values())
    .sort((a, b) => b.terms - a.terms || a.bestRank - b.bestRank)
    .slice(0, limit)
    .map((entry) => entry.hit)
}
