"use client"

import { useWorkspace, type WorkspaceWithRole } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"

/**
 * Knowledge and the portal editor are one surface: a workspace has a single
 * portal, built from its knowledge. When the plan includes the portal and the
 * member can manage it, Knowledge renders inside the builder (portal controls,
 * live preview, publish). Everyone else gets the plain Knowledge view.
 */
export function canManageKnowledgePortal(
  workspace: WorkspaceWithRole | undefined,
): boolean {
  if (!workspace) return false
  return (
    workspace.portal_editor_enabled === true &&
    (workspace.user_role === "admin" || workspace.user_role === "owner")
  )
}

export function isKnowledgePath(pathname: string): boolean {
  return pathname === "/knowledge" || pathname.startsWith("/knowledge/")
}

/** Whether the builder rail replaces the app's Knowledge sub-sidebar. */
export function useKnowledgeBuilderActive(pathname: string): boolean {
  const { data: workspace } = useWorkspace()
  // The workspace comes from a client cache the server never sees. Until
  // hydration, assume the builder (whose skeleton KnowledgeShell shows) so the
  // first client render matches the server HTML and nothing flashes.
  const hasHydrated = useHasHydrated()
  if (!isKnowledgePath(pathname)) return false
  return !hasHydrated || canManageKnowledgePortal(workspace)
}
