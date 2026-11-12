import "server-only"

import { cache } from "react"
import { notFound, redirect } from "next/navigation"
import {
  getPortalWorkspace,
  getPortalWorkspaceById,
  gatePortalProjectAccess,
  resolvePortalWorkspaceUngated,
  type PortalScopeEntry,
  type PortalWorkspaceResolution,
  type PublicWorkspace,
} from "@/lib/public-kb"
import {
  resolveDefaultPublishedProjectByWorkspace,
  resolvePublishedProjectByWorkspace,
} from "@/lib/portal/experiences"
import type { PortalLayout } from "@/lib/portal/schema"
import { privatePortalLoginHref } from "@/lib/portal/private-portal-login"

function resolveOrRedirect(
  result: PortalWorkspaceResolution,
  slug: string,
  nextPath: string,
): PublicWorkspace {
  if (result.kind === "workspace") return result.workspace
  if (result.kind === "login_required") {
    redirect(privatePortalLoginHref(nextPath, slug))
  }
  notFound()
}

export async function requirePortalWorkspace(
  slug: string,
  nextPath: string,
): Promise<PublicWorkspace> {
  return resolveOrRedirect(await getPortalWorkspace(slug), slug, nextPath)
}

/**
 * Gate a portal workspace resolved by id (when a project slug already resolved
 * the owning workspace). `slug` is the request slug, used only for the
 * login-redirect `next` fallback.
 */
export async function requirePortalWorkspaceById(
  workspaceId: string,
  slug: string,
  nextPath: string,
): Promise<PublicWorkspace> {
  return resolveOrRedirect(
    await getPortalWorkspaceById(workspaceId),
    slug,
    nextPath,
  )
}

/**
 * A resolved portal request: the gated workspace, the resolved project, the
 * folder scope to feed the read path, and the published
 * layout (if any).
 *
 * Model B addressing — the workspace is resolved first (by its own slug, the
 * `[workspace]` URL segment), then the project within it:
 *   /p/<workspace>            → the workspace's DEFAULT project (root)
 *   /p/<workspace>/<project>  → a named published project in that workspace
 */
export interface ResolvedPortal {
  workspace: PublicWorkspace
  /** Resolved project slug, or null for the workspace's default project. */
  projectSlug: string | null
  /** Stored project slug used when selecting its preferred public address. */
  addressProjectSlug: string
  /**
   * URL prefix for in-portal links: `<workspace>` (default project) or
   * `<workspace>/<project>` (named). Pass this where a flat `slug` was passed
   * before — `/p/${base}`, `/p/${base}/doc/<id>`, `/p/${base}/folder/<id>`.
   */
  base: string
  /**
   * Published project row id (workspace_experiences.id), or null for the
   * implicit default fallback. Used for portal-analytics attribution.
   */
  experienceId: string | null
  /** Scope of the project itself — what the HOME surface renders. */
  scope: PortalScopeEntry[] | null
  /**
   * The project scope widened by every page's own scope. Everything the portal
   * addresses by URL — doc pages, folder pages, search — gates on this, so a
   * document a page lists stays reachable even when the home scope excludes it.
   */
  contentScope: PortalScopeEntry[] | null
  layout: PortalLayout | null
  /**
   * Set on a root request (`/p/<workspace>`, no project segment) when the
   * resolved default project actually lives under a suffix — i.e. no project is
   * hosted at the workspace root itself. The page redirects the root *home* to
   * `/p/<workspace>/<rootRedirectSlug>` so the root never renders a project's
   * content inline. Null when a real root project exists or for named requests.
   */
  rootRedirectSlug: string | null
}

// A project with no custom logo inherits the workspace logo (brand logo, else
// the workspace icon) so a blank logo renders the workspace mark on the live
// portal, not just the brand initial. Mirrors buildPortalTheme's default for
// freshly-built layouts.
export function withWorkspaceLogo(
  layout: PortalLayout | null,
  workspace: PublicWorkspace,
): PortalLayout | null {
  if (!layout || layout.theme.logoUrl) return layout
  const workspaceLogo = workspace.branding.logoUrl || workspace.iconUrl || ""
  if (!workspaceLogo) return layout
  return { ...layout, theme: { ...layout.theme, logoUrl: workspaceLogo } }
}

// cache(): the route layout, its generateMetadata, and the page all resolve the
// same portal within one request — memoize so they share a single lookup.
export const requirePortal = cache(async function requirePortal(
  workspaceSlug: string,
  projectSlug: string | null | undefined,
  nextPath: string,
): Promise<ResolvedPortal> {
  // Resolve the workspace WITHOUT gating — per-project visibility is
  // authoritative, so we gate below on the resolved project rather than on the
  // workspace-wide kb_public flag.
  const workspace = await resolvePortalWorkspaceUngated(workspaceSlug)
  if (!workspace) notFound()

  // A project slug equal to the workspace's own slug addresses the default
  // project at root; treat it as the default so `base` stays `<workspace>`. The
  // slug is both the visible URL key and the lookup key.
  const wsKey = workspace.slug
  const named =
    projectSlug && projectSlug !== workspace.slug ? projectSlug : null
  const base = named ? `${wsKey}/${named}` : wsKey

  const project = named
    ? await resolvePublishedProjectByWorkspace(workspace.id, named)
    : await resolveDefaultPublishedProjectByWorkspace(
        workspace.id,
        workspace.slug,
        workspace.primaryProjectSlug,
      )

  if (named && !project) {
    notFound()
  }

  // Per-project visibility gate. A legacy default project with no published row
  // falls back to the workspace-wide flag, preserving prior behavior. Fails
  // closed: private → sign-in (members only), non-member → not found.
  const isPublic = project ? project.visibility === "public" : workspace.isPublic
  resolveOrRedirect(
    await gatePortalProjectAccess(workspace, isPublic),
    workspaceSlug,
    nextPath,
  )

  // Root request that resolved to a project living under a suffix: signal a
  // redirect to its canonical URL. Only meaningful for the root home view — the
  // page ignores it for doc/folder views, which still resolve against the
  // default project so deep links keep working.
  const rootRedirectSlug =
    !named && project && project.slug !== wsKey ? project.slug : null

  return {
    workspace,
    projectSlug: named,
    addressProjectSlug: project?.slug ?? wsKey,
    base,
    experienceId: project?.experienceId ?? null,
    scope: project?.scope ?? null,
    contentScope: project?.contentScope ?? null,
    layout: withWorkspaceLogo(project?.layout ?? null, workspace),
    rootRedirectSlug,
  }
})
