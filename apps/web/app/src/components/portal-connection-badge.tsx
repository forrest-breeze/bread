import { CheckCircle2, Clock3, RefreshCw, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export type PortalConnectionStatus =
  | "pending"
  | "connected"
  | "needs_update"
  | "not_connected"

export function PortalConnectionBadge({
  status,
  className,
}: {
  status: PortalConnectionStatus
  className?: string
}): React.ReactElement {
  if (status === "connected") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300",
          className,
        )}
      >
        <CheckCircle2 className="size-3" />
        Connected
      </span>
    )
  }

  if (status === "not_connected") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-destructive",
          className,
        )}
      >
        <XCircle className="size-3" />
        Not connected
      </span>
    )
  }

  if (status === "needs_update") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300",
          className,
        )}
      >
        <RefreshCw className="size-3" />
        Update required
      </span>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <Clock3 className="size-3" />
      Pending
    </span>
  )
}
