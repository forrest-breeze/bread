"use client"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PortalChromeScopeCard } from "@/components/settings/portal-chrome-scope-card"
import { WorkspacePortalAddressCard } from "@/components/settings/workspace-portal-address-card"
import { useWorkspace } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"

// ---------------------------------------------------------------------------
// Project settings — everything that configures portal projects rather than the
// workspace itself: where projects are addressed (URL ownership, custom domain,
// primary project) and whether they share one header and footer.
// ---------------------------------------------------------------------------

export default function ProjectsSettingsPage() {
  const hasHydrated = useHasHydrated()
  const { data: workspace, isLoading } = useWorkspace()

  if (!hasHydrated || (isLoading && !workspace)) {
    return (
      <div className="space-y-6 p-6 lg:p-8">
        <div className="space-y-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-4 w-64" />
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-9 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold">Portal</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure how your portal projects are published
        </p>
      </div>

      <WorkspacePortalAddressCard />

      <PortalChromeScopeCard />
    </div>
  )
}
