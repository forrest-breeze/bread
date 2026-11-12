import "server-only"

import {
  gatePortalProjectAccess,
  resolvePortalWorkspaceUngated,
  type PublicKbScope,
  type PublicWorkspace,
} from "@/lib/public-kb"
import {
  resolveDefaultPublishedProjectByWorkspace,
  resolvePublishedProjectByWorkspace,
} from "@/lib/portal/experiences"

// ---------------------------------------------------------------------------
// Public portal "base" resolution for the unauthenticated public APIs
// (search / ask / track).
//
// A base path is the in-portal URL prefix without the `/p/` mount:
//   "<workspace>"            → the workspace's default project
//   "<workspace>/<project>"  → a named published project in that workspace
//
// This mirrors requirePortal (the page resolver) but returns plain data instead
// of redirecting/404ing, so an API route can map a miss to its own 404/204.
// It applies the SAME gate as the page: the resolved project's visibility is
// authoritative (legacy default projects without a published row fall back to
// the workspace-wide kb_public flag); a private project resolves only for
// signed-in members. Gating on kb_public alone made search/ask/track 404 on
// portals whose page rendered fine (published project, kb_public=false).
// ---------------------------------------------------------------------------

export interface ResolvedPortalBase {
  workspace: PublicWorkspace
  /** Published project row id (for analytics attribution), or null for the
   *  implicit default project with no stored row. */
  experienceId: string | null
  /**
   * Folder scope to feed the read path; null = whole-workspace public docs.
   * This is the project scope widened by every page's scope, so a document a
   * portal page lists is searchable and readable through the public APIs even
   * when the project's home scope excludes its folder.
   */
  scope: PublicKbScope
  /** Canonical base path, for building hrefs back into this portal. */
  base: string
}

/**
 * Resolve a portal base path to its gated workspace, scope, and analytics id.
 * Returns null when the workspace KB is not published/public, when a named
 * project doesn't exist, or when the path shape is invalid.
 */
export async function resolvePortalBase(
  base: string,
): Promise<ResolvedPortalBase | null> {
  const parts = base.split("/").filter((p) => p.length > 0)
  if (parts.length === 0 || parts.length > 2) return null
  const workspaceSlug = parts[0]
  const projectSlug = parts[1] ?? null

  const workspace = await resolvePortalWorkspaceUngated(workspaceSlug)
  if (!workspace) return null

  // A project slug equal to the workspace's own slug addresses the default
  // project. The slug is both the visible URL key and the lookup key.
  const wsKey = workspace.slug
  const named =
    projectSlug && projectSlug !== workspace.slug ? projectSlug : null
  const project = named
    ? await resolvePublishedProjectByWorkspace(workspace.id, named)
    : await resolveDefaultPublishedProjectByWorkspace(
        workspace.id,
        workspace.slug,
        workspace.primaryProjectSlug,
      )
  // A named project URL must resolve to a published project.
  if (named && !project) return null

  // Same per-project gate as requirePortal. Fails closed: anything other than
  // an allowed workspace (login_required, not_found) is a miss.
  const isPublic = project ? project.visibility === "public" : workspace.isPublic
  const access = await gatePortalProjectAccess(workspace, isPublic)
  if (access.kind !== "workspace") return null

  return {
    workspace,
    experienceId: project?.experienceId ?? null,
    scope: project?.contentScope ?? null,
    base: named ? `${wsKey}/${named}` : wsKey,
  }
}
