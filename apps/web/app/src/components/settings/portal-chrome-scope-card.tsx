"use client"

import { useState } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useWorkspace } from "@/hooks/swr"
import { updateWorkspacePortalChromeScope } from "@/lib/api/workspace"
import {
  getPortalChromeScope,
  type PortalChromeScope,
} from "@/lib/workspace-settings"
import type { WorkspaceRole } from "@bread/core"

// ---------------------------------------------------------------------------
// Portal header & footer scope (`portal_chrome_scope`).
//
// Lives on /settings/projects next to the portal address card, and saves on
// toggle rather than through a page-level save bar — matching how the
// neighbouring project settings persist.
// ---------------------------------------------------------------------------

export function PortalChromeScopeCard(): React.ReactElement | null {
  const { data: workspace, mutate } = useWorkspace()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!workspace) return null

  const role = (workspace.user_role as WorkspaceRole | undefined) ?? "viewer"
  const isAdmin = role === "admin" || role === "owner"
  const scope = getPortalChromeScope(workspace.settings)

  const onToggle = async (shared: boolean): Promise<void> => {
    if (!isAdmin || saving) return
    const next: PortalChromeScope = shared ? "workspace" : "project"
    if (next === scope) return
    setSaving(true)
    setError(null)
    // Optimistic — the switch should follow the pointer, not the round-trip.
    void mutate(
      {
        ...workspace,
        settings: { ...workspace.settings, portal_chrome_scope: next },
      },
      false,
    )
    const result = await updateWorkspacePortalChromeScope(next)
    setSaving(false)
    if (!result.ok || !result.workspace) {
      setError(result.error ?? "Couldn't change the header and footer scope.")
      void mutate()
      return
    }
    void mutate(result.workspace, false)
    window.dispatchEvent(new Event("workspace-updated"))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portal Header &amp; Footer</CardTitle>
        <CardDescription>
          Control whether portal projects share one workspace header and footer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="portal-shared-chrome">Share across projects</Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              When enabled, every portal project uses the workspace header and footer.
            </p>
          </div>
          <Switch
            id="portal-shared-chrome"
            checked={scope === "workspace"}
            disabled={!isAdmin || saving}
            onCheckedChange={(checked) => void onToggle(checked)}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <p className="text-[11px] text-muted-foreground">
          {scope === "workspace"
            ? "Header and footer edits are shared across all portal projects."
            : "Header and footer edits are saved per portal project."}
        </p>
      </CardContent>
    </Card>
  )
}
