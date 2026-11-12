"use client"

import { WorkspaceDataManagementCard } from "@/components/settings/workspace-data-management-card"
import { useWorkspace } from "@/hooks/swr"

export default function ExportDataPage(): React.ReactElement {
  const { data: workspace } = useWorkspace()
  const isAdmin =
    workspace?.user_role === "admin" || workspace?.user_role === "owner"

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold">Export data</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Export the workspace as a backup, or import from another source
        </p>
      </div>

      <WorkspaceDataManagementCard isAdmin={isAdmin} />
    </div>
  )
}
