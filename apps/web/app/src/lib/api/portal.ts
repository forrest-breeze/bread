import type { PortalLayout } from "@/lib/portal/schema"
import type { PortalScopeEntry } from "@/lib/public-kb"

// ---------------------------------------------------------------------------
// Portal builder client API.
//
// All network calls for the admin portal builder live here so the components
// stay presentational (no fetch in components — see CLAUDE.md §3). The SWR hook
// `usePortalDraft` handles the read; these handle the mutations.
// ---------------------------------------------------------------------------

export interface PortalDraftResult {
  version: number
  spec: PortalLayout
  projectSlug: string | null
  scope: PortalScopeEntry[] | null
  /** True when the draft has saved spec/scope changes not yet published. */
  divergedFromPublished?: boolean
}

export interface PortalProjectResult {
  id: string | null
  slug: string
  scope: PortalScopeEntry[] | null
  name: string | null
  displayName: string
  /** Emoji icon for the project (spec.theme.icon or the default). */
  icon: string
  isDefault: boolean
  /** Per-project access: 'public' = anonymous, 'private' = members only. */
  visibility: "public" | "private"
  draftVersion: number | null
  publishedVersion: number | null
  updatedAt: string | null
}

/**
 * The switcher historically labels live projects with their published
 * version. A new project has only a v1 draft, so fall back to that until its
 * first publish instead of leaving the version column blank.
 */
export function getPortalProjectDisplayVersion(
  project: Pick<PortalProjectResult, "draftVersion" | "publishedVersion">,
): number | null {
  return project.publishedVersion ?? project.draftVersion
}

/** One entry in a project's published version history. */
export interface PortalVersionSummary {
  version: number
  /** 'published' = live right now; 'archived' = a superseded version. */
  status: "published" | "archived"
  /** Saved editor display name; legacy field name retained for API compatibility. */
  publishedBy: string | null
  createdAt: string
  updatedAt: string
}

export interface PortalVersionsResult {
  versions: PortalVersionSummary[]
}

export interface CreatePortalProjectInput {
  slug: string
  name: string
  scope?: PortalScopeEntry[]
}

export interface PortalProjectsResult {
  projects: PortalProjectResult[]
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

export type PortalDomainRouteMode = "domain" | "path"

export interface PortalDomainRoute {
  projectSlug: string
  domain: string
  pathPrefix: string
  mode: PortalDomainRouteMode
}

export interface PortalDomainRouteResult {
  route: PortalDomainRoute | null
}

export interface PortalAgentToolCall {
  op: string
  ok: boolean
  error?: string
  /** Human-readable summary of the applied change (panel step copy). */
  summary?: string
}

export interface PortalAgentResult {
  layout: PortalLayout
  reply: string
  toolCalls: PortalAgentToolCall[]
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string }
    return body.message ?? body.error ?? `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

function projectQuery(projectSlug?: string): string {
  return projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : ""
}

/** Upload a project logo image; returns its public URL (store on theme.logoUrl). */
export async function uploadPortalLogo(file: File): Promise<string> {
  const body = new FormData()
  body.append("file", file)
  const res = await fetch("/api/portal/logo", { method: "POST", body })
  if (!res.ok) throw new Error(await parseError(res))
  const data = (await res.json()) as { logo_url: string }
  return data.logo_url
}

/** List portal projects for the active workspace. */
export async function listPortalProjects(): Promise<PortalProjectsResult> {
  const res = await fetch("/api/portal/projects")
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalProjectsResult
}

/** Create a new portal project (returns the created project summary). */
export async function createPortalProject(
  input: CreatePortalProjectInput,
): Promise<PortalProjectResult> {
  const res = await fetch("/api/portal/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return ((await res.json()) as { project: PortalProjectResult }).project
}

/** Update a named portal project's public path suffix. */
export async function updatePortalProjectPath(
  currentSlug: string,
  slug: string,
): Promise<PortalProjectPathResult> {
  const res = await fetch(
    `/api/portal/projects/${encodeURIComponent(currentSlug)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    },
  )
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalProjectPathResult
}

/** Save a project-specific dedicated domain or shared-domain path route. */
export async function updatePortalProjectDomainRoute(
  projectSlug: string,
  input: { domain: string; mode: PortalDomainRouteMode },
): Promise<PortalDomainRouteResult> {
  const res = await fetch(
    `/api/portal/projects/${encodeURIComponent(projectSlug)}/domain-route`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  )
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalDomainRouteResult
}

/** Remove a project override so it inherits the workspace portal address. */
export async function clearPortalProjectDomainRoute(
  projectSlug: string,
): Promise<PortalDomainRouteResult> {
  const res = await fetch(
    `/api/portal/projects/${encodeURIComponent(projectSlug)}/domain-route`,
    { method: "DELETE" },
  )
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalDomainRouteResult
}

/** Permanently delete a non-default portal project (returns the deleted slug). */
export async function deletePortalProject(
  slug: string,
): Promise<{ slug: string }> {
  const res = await fetch(`/api/portal/projects/${encodeURIComponent(slug)}`, {
    method: "DELETE",
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as { slug: string }
}

/** Update the selected project's draft folder scope. */
export async function updatePortalProjectScope(
  projectSlug: string | undefined,
  scope: PortalScopeEntry[] | null,
): Promise<PortalProjectScopeResult> {
  const res = await fetch("/api/portal/projects", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectSlug, scope }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalProjectScopeResult
}

/** Update the selected project's per-project access (public/private). */
export async function updatePortalProjectVisibility(
  projectSlug: string | undefined,
  visibility: "public" | "private",
): Promise<PortalProjectVisibilityResult> {
  const res = await fetch("/api/portal/projects", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectSlug, visibility }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalProjectVisibilityResult
}

/** Persist an edited draft layout. */
export async function savePortalDraft(
  spec: PortalLayout,
  projectSlug?: string,
): Promise<PortalDraftResult> {
  const res = await fetch(`/api/portal/draft${projectQuery(projectSlug)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec, projectSlug }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalDraftResult
}

/** Discard draft edits, resetting the draft to the live published version. */
export async function discardPortalDraft(
  projectSlug?: string,
): Promise<PortalDraftResult> {
  const res = await fetch(`/api/portal/draft${projectQuery(projectSlug)}`, {
    method: "DELETE",
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalDraftResult
}

/** Publish the current draft to the public portal (double-confirmed server-side). */
export async function publishPortalDraft(
  projectSlug?: string,
): Promise<PortalDraftResult> {
  const res = await fetch("/api/portal/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true, projectSlug }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalDraftResult
}

/**
 * Roll the published portal back to an earlier version.
 *
 * `resetDraft` also resets the builder's draft to the restored layout, so the
 * editor shows what visitors now see instead of the pre-rollback draft. It
 * discards unpublished draft edits, so callers must confirm first.
 */
export async function rollbackPortal(
  version: number,
  projectSlug?: string,
  options?: { resetDraft?: boolean },
): Promise<PortalDraftResult> {
  const res = await fetch("/api/portal/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rollbackToVersion: version,
      resetDraft: options?.resetDraft === true ? true : undefined,
      projectSlug,
    }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as PortalDraftResult
}

// The portal agent (natural-language editing and "generate a draft") used an
// LLM. The Breeze internal build has no AI subprocessors, so its route was
// removed. The builder UI that calls these is already shelved
// (AI_BUILDER_UI_ENABLED in portal-builder.tsx); they fail fast if reached.
const AI_DISABLED_MESSAGE = "AI features are disabled in this build."

/** Ask the portal agent to edit the layout in natural language. Disabled. */
export async function runPortalAgent(
  _message: string,
  _layout: PortalLayout,
  _projectSlug?: string | null,
  _history?: ReadonlyArray<{ role: "user" | "agent"; text: string }>,
): Promise<PortalAgentResult> {
  throw new Error(AI_DISABLED_MESSAGE)
}

/** Generate a complete portal draft layout. Disabled (see above). */
export async function generatePortalDraft(_input: {
  layout: PortalLayout
  message?: string
  projectSlug?: string | null
}): Promise<PortalAgentResult> {
  throw new Error(AI_DISABLED_MESSAGE)
}

/** Restore a saved edit to the editor without publishing it. */
export async function restorePortalEdit(version: number, projectSlug?: string): Promise<void> {
  const res = await fetch(`/api/portal/versions${projectQuery(projectSlug)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  })
  if (!res.ok) throw new Error(await parseError(res))
}
