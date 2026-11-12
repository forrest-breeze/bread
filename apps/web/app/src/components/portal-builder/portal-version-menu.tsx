"use client"

import { useState } from "react"
import { Check, History } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { RelativeTime } from "@/components/app/relative-time"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import type { PortalVersionSummary } from "@/lib/api/portal"

export interface PortalVersionMenuProps {
  savedStatusVisible?: boolean
  lastEditedAt: string | null
  versions: PortalVersionSummary[]
  loading: boolean
  selectedVersion: number | null
  restoring: boolean
  disabled?: boolean
  onSelect: (version: number | null) => void
  onRestore: (version: number) => void
  className?: string
}

export function formatEditDate(isoDate: string, now = new Date()): string {
  const date = new Date(isoDate)
  if (!Number.isFinite(date.getTime())) return "Unknown date"
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export function PortalVersionMenu({
  savedStatusVisible = false, lastEditedAt, versions, loading, selectedVersion,
  restoring, disabled = false, onSelect, onRestore, className,
}: PortalVersionMenuProps): React.ReactElement {
  const [pendingRestore, setPendingRestore] = useState<number | null>(null)
  const hasHydrated = useHasHydrated()
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={
          <Button variant="outline" size="sm" disabled={disabled}
            aria-label="Portal version history" className={cn("gap-1.5 px-2.5", className)} />
        }>
          {savedStatusVisible ? <Check className="size-3.5 text-emerald-600" /> : <History className="size-3.5" />}
          <span className="tabular-nums" role="status" aria-live="polite">
            {savedStatusVisible ? "Saved" : lastEditedAt ? <RelativeTime isoDate={lastEditedAt} prefix="Edited" /> : "Not edited yet"}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-72 p-1">
          <button type="button" onClick={() => onSelect(null)}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted">
            <Check className={cn("size-3.5", selectedVersion !== null && "invisible")} />
            Editing
          </button>
          <div className="max-h-80 overflow-y-auto border-t border-border">
            {loading ? <p className="p-3 text-xs text-muted-foreground">Loading edits…</p>
              : versions.length === 0 ? <p className="p-3 text-xs text-muted-foreground">No saved edits yet.</p>
              : versions.map((entry) => (
                <div key={entry.version} className="flex items-center gap-1">
                  <button type="button" onClick={() => onSelect(entry.version)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted">
                    <Check className={cn("size-3.5 shrink-0", selectedVersion !== entry.version && "invisible")} />
                    <span className="min-w-0 flex-1 truncate">{entry.publishedBy || "Unknown editor"}</span>
                    <time dateTime={entry.createdAt} className="shrink-0 text-xs text-muted-foreground">
                      {hasHydrated ? formatEditDate(entry.createdAt) : entry.createdAt.slice(0, 10)}
                    </time>
                  </button>
                  <Button variant="ghost" size="sm" disabled={restoring} onClick={() => setPendingRestore(entry.version)}>Restore</Button>
                </div>
              ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={pendingRestore !== null} onOpenChange={(open) => { if (!open && !restoring) setPendingRestore(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this edit?</AlertDialogTitle>
            <AlertDialogDescription>This replaces the current editor content with this saved edit. Your saved history is kept. Publish when you want these changes to go live.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={restoring} onClick={() => {
              if (pendingRestore !== null) onRestore(pendingRestore)
              setPendingRestore(null)
            }}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
