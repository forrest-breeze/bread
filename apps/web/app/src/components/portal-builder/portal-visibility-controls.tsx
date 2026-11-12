"use client"

import { useState } from "react"
import { Check, Globe, Lock, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { updatePortalProjectVisibility } from "@/lib/api/portal"
import type { WorkspaceWithRole } from "@/hooks/swr"
import { PublishDialog } from "./publish-dialog"

// Visibility section of the Customize panel. Two concerns:
//   1. Access — the PROJECT's `visibility` (public/private). Private portals
//      require a signed-in workspace member (enforced per project in
//      requirePortal → gatePortalVisibility, public-kb.ts). Scoped to the active
//      project, not the whole workspace.
//   2. Publish state — mirrors the toolbar's Publish/Revert for the active
//      project. The originals stay in the header; this is a second, in-context
//      surface so visibility lives in one place.
interface PortalVisibilityControlsProps {
  workspace: WorkspaceWithRole
  /** Active project slug — the visibility change targets this project. */
  projectSlug: string
  /** The active project's current access. */
  visibility: "public" | "private"
  /** Refresh the project list after a successful change (reflects new value). */
  onVisibilityChanged?: () => void | Promise<unknown>
  brandName: string
  isPublished: boolean
  hasPublishableChanges: boolean
  canDiscard: boolean
  publishing: boolean
  discarding: boolean
  dirty: boolean
  saving: boolean
  onPublish: () => Promise<boolean>
  onDiscard: () => void
  className?: string
}

export function PortalVisibilityControls({
  workspace,
  projectSlug,
  visibility,
  onVisibilityChanged,
  brandName,
  isPublished,
  hasPublishableChanges,
  canDiscard,
  publishing,
  discarding,
  dirty,
  saving,
  onPublish,
  onDiscard,
  className,
}: PortalVisibilityControlsProps): React.ReactElement {
  const [optimisticPublic, setOptimisticPublic] = useState<boolean | null>(null)
  const [savingAccess, setSavingAccess] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)

  const isPublic = optimisticPublic ?? visibility === "public"
  const role = workspace.user_role
  const canManage = role === "admin" || role === "owner"

  async function handleAccessChange(nextPublic: boolean): Promise<void> {
    if (nextPublic === isPublic || savingAccess || !canManage) return
    setSavingAccess(true)
    setAccessError(null)
    // Optimistically reflect the new value; clear it once the refetched project
    // list carries the persisted value (or on failure, reverting to the prop).
    setOptimisticPublic(nextPublic)
    try {
      await updatePortalProjectVisibility(
        projectSlug,
        nextPublic ? "public" : "private",
      )
      await onVisibilityChanged?.()
      setOptimisticPublic(null)
    } catch (err) {
      setOptimisticPublic(null)
      setAccessError(
        err instanceof Error ? err.message : "Couldn't update portal visibility.",
      )
    } finally {
      setSavingAccess(false)
    }
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Access — public vs private (requires sign-in) */}
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <p className="text-sm font-medium">Who can view</p>
        <Select
          value={isPublic ? "public" : "private"}
          onValueChange={(value) => void handleAccessChange(value === "public")}
          disabled={savingAccess || !canManage}
        >
          <SelectTrigger className="mt-2 w-full" aria-label="Portal access">
            <SelectValue>
              <span className="flex items-center gap-1.5">
                {isPublic ? (
                  <Globe className="size-3.5 text-muted-foreground" />
                ) : (
                  <Lock className="size-3.5 text-muted-foreground" />
                )}
                {isPublic ? "Public" : "Private"}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="public">
              <span className="flex items-center gap-1.5">
                <Globe className="size-3.5 text-muted-foreground" />
                Public
              </span>
            </SelectItem>
            <SelectItem value="private">
              <span className="flex items-center gap-1.5">
                <Lock className="size-3.5 text-muted-foreground" />
                Private
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {isPublic
            ? "Anyone with the link can view this project."
            : "Visitors must sign in, and only workspace members can view this project."}
        </p>
        {!canManage ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Only workspace admins and owners can change access.
          </p>
        ) : null}
        {accessError ? (
          <p className="mt-2 text-[11px] text-destructive">{accessError}</p>
        ) : null}
      </div>

      {/* Publish state — mirrors the toolbar Publish/Revert for this project */}
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  isPublished ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
                aria-hidden
              />
              {isPublished ? "Published" : "Draft"}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {isPublished
                ? hasPublishableChanges
                  ? "Live, with unpublished changes."
                  : "Live and up to date."
                : "Not yet published — only visible here in the builder."}
            </p>
          </div>
          {hasPublishableChanges ? (
            <PublishDialog
              brandName={brandName}
              dirty={dirty}
              publishing={publishing}
              onConfirm={onPublish}
              disabled={dirty || saving}
            />
          ) : (
            <span className="flex h-8 items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
              <Check className="size-3.5 text-emerald-600" />
              Saved
            </span>
          )}
        </div>
        {canDiscard ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            disabled={discarding || saving || publishing}
            title="Discard draft edits and revert to the published version"
            className="mt-2 h-8 px-2 text-xs"
          >
            <RotateCcw className="size-3.5" />
            {discarding ? "Reverting..." : "Revert to published"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
