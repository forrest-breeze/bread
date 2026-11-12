import { Skeleton } from "@/components/ui/skeleton"
import type { PortalDailyBucket } from "@/lib/portal/analytics-types"

interface DailyActivityChartProps {
  data: PortalDailyBucket[]
  loading?: boolean
}

function shortDate(isoDay: string): string {
  // isoDay is YYYY-MM-DD (UTC); render as "Jun 24" without TZ shifting.
  const d = new Date(`${isoDay}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return isoDay
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

/**
 * Lightweight two-series column chart (article views + searches) rendered with
 * plain CSS bars — no charting dependency. Heights are normalized to the max
 * value across both series; non-zero values clamp to a visible minimum.
 */
export function DailyActivityChart({
  data,
  loading,
}: DailyActivityChartProps): React.ReactElement {
  if (loading) {
    return <Skeleton className="h-44 w-full" />
  }

  const max = data.reduce(
    (m, d) => Math.max(m, d.articleViews, d.searches),
    0,
  )

  const heightPct = (value: number): number => {
    if (max <= 0 || value <= 0) return 0
    return Math.max(4, (value / max) * 100)
  }

  const firstLabel = data[0]?.date
  const midLabel = data[Math.floor((data.length - 1) / 2)]?.date
  const lastLabel = data[data.length - 1]?.date

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px] bg-sky-500/80" />
          Article views
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px] bg-violet-500/80" />
          Searches
        </span>
      </div>

      <div className="flex h-44 items-end gap-px border-b border-border/70">
        {data.map((d) => (
          <div
            key={d.date}
            className="flex h-full flex-1 items-end justify-center gap-px"
            title={`${shortDate(d.date)} · ${d.articleViews} views · ${d.searches} searches`}
          >
            <div
              className="w-1/2 max-w-[7px] rounded-t-sm bg-sky-500/80"
              style={{ height: `${heightPct(d.articleViews)}%` }}
            />
            <div
              className="w-1/2 max-w-[7px] rounded-t-sm bg-violet-500/80"
              style={{ height: `${heightPct(d.searches)}%` }}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{firstLabel ? shortDate(firstLabel) : ""}</span>
        <span>{midLabel && data.length > 2 ? shortDate(midLabel) : ""}</span>
        <span>{lastLabel ? shortDate(lastLabel) : ""}</span>
      </div>
    </div>
  )
}
