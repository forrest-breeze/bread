import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Loading skeleton for the portal editor. Mirrors the real two-pane chrome —
// the documentation rail (header switcher + Manage list + document tree) and
// the live-preview pane (centered device frame on the
// muted backdrop) — so the swap to the loaded editor doesn't reflow or jump.
// Presentational and server-safe (Skeleton is a plain styled div).
// ---------------------------------------------------------------------------

function ManageRowSkeleton(): React.ReactElement {
  return (
    <div className="flex h-8 items-center gap-2 px-1">
      <Skeleton className="size-4 shrink-0 rounded" />
      <Skeleton className="h-3.5 w-24" />
    </div>
  )
}

function FolderRowSkeleton({ width }: { width: string }): React.ReactElement {
  return (
    <div className="flex h-7 items-center gap-1.5 px-1">
      <Skeleton className="size-3 shrink-0 rounded-sm" />
      <Skeleton className="size-3.5 shrink-0 rounded-sm" />
      <Skeleton className={cn("h-3", width)} />
      <Skeleton className="ml-auto size-3 shrink-0 rounded-sm" />
    </div>
  )
}

function FileRowSkeleton({ width }: { width: string }): React.ReactElement {
  return (
    <div className="flex h-7 items-center gap-2 px-1">
      <Skeleton className="size-3.5 shrink-0 rounded-sm" />
      <Skeleton className={cn("h-3", width)} />
    </div>
  )
}

export function PortalBuilderSkeleton(): React.ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row" aria-busy="true">
      <span className="sr-only">Loading portal editor</span>

      {/* Documentation rail */}
      <aside className="flex w-full shrink-0 flex-col border-b border-border bg-background lg:w-[320px] lg:border-b-0 lg:border-r">
        {/* Header: project switcher + search/filter actions */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Skeleton className="size-5 shrink-0 rounded-md" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
          </div>
        </div>

        {/* Body: Manage section + Documentation tree */}
        <div className="min-h-0 flex-1 space-y-6 overflow-hidden px-4 py-5">
          <section className="space-y-2">
            <Skeleton className="h-2.5 w-14" />
            <div className="space-y-0.5">
              <ManageRowSkeleton />
              <ManageRowSkeleton />
              <ManageRowSkeleton />
              <ManageRowSkeleton />
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex h-7 items-center justify-between">
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="size-4 rounded-sm" />
            </div>
            <div className="space-y-0.5">
              <FolderRowSkeleton width="w-28" />
              <div className="ml-3 space-y-0.5 border-l border-border/40 pl-1">
                <FileRowSkeleton width="w-32" />
                <FileRowSkeleton width="w-24" />
              </div>
              <FolderRowSkeleton width="w-20" />
              <FolderRowSkeleton width="w-36" />
              <div className="ml-3 space-y-0.5 border-l border-border/40 pl-1">
                <FileRowSkeleton width="w-28" />
              </div>
              <FileRowSkeleton width="w-40" />
              <FileRowSkeleton width="w-32" />
            </div>
          </section>
        </div>
      </aside>

      {/* Live-preview pane */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/30 p-4">
        {/* Centered device frame with a faint page scaffold inside */}
        <div className="flex h-full min-h-[360px] w-full items-center justify-center">
          <div className="flex h-full max-h-[680px] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <div className="flex items-center gap-3 border-b border-border px-5 py-3">
              <Skeleton className="size-6 rounded-md" />
              <Skeleton className="h-3.5 w-24" />
              <div className="ml-auto flex items-center gap-2">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-12" />
              </div>
            </div>
            <div className="flex-1 space-y-4 px-8 py-8">
              <Skeleton className="h-7 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
              <div className="grid grid-cols-1 gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <Skeleton key={index} className="h-24 w-full rounded-xl" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
