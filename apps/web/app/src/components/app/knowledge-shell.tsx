"use client"

import { useWorkspace } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { PortalBuilder } from "@/components/portal-builder/portal-builder"
import { PortalBuilderSkeleton } from "@/components/portal-builder/portal-builder-skeleton"
import { canManageKnowledgePortal } from "@/components/app/knowledge-portal-access"

/** Wraps Knowledge in the portal builder for members who can manage the portal. */
export function KnowledgeShell({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  const { data: workspace, isLoading } = useWorkspace()
  // Same gate as the sidebar (useKnowledgeBuilderActive) so both pick the
  // builder or the plain view on the same render and the server HTML matches.
  const hasHydrated = useHasHydrated()

  if (!hasHydrated || (!workspace && isLoading)) {
    return (
      <div className="h-[calc(100svh-3.5rem)] lg:h-screen lg:min-h-screen">
        <PortalBuilderSkeleton />
      </div>
    )
  }

  if (!canManageKnowledgePortal(workspace)) return <>{children}</>

  return (
    <div className="h-[calc(100svh-3.5rem)] lg:h-screen lg:min-h-screen">
      <PortalBuilder>{children}</PortalBuilder>
    </div>
  )
}
