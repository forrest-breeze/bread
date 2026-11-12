import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

interface MetricCardProps {
  label: string
  value: string
  description?: string
  loading?: boolean
  className?: string
}

/** A single headline metric tile for the Reporting overview. */
export function MetricCard({
  label,
  value,
  description,
  loading,
  className,
}: MetricCardProps): React.ReactElement {
  return (
    <div className={cn("rounded-xl border bg-card p-5", className)}>
      <p className="text-sm text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-20" />
      ) : (
        <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
          {value}
        </p>
      )}
      {description ? (
        <p className="mt-2 text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}
