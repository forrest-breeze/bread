"use client"

import { cn } from "@/lib/utils"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import type { PortalAnalyticsRangeDays } from "@/hooks/swr"

export interface ReportingPortalOption {
  slug: string
  name: string
}

interface ReportingControlsProps {
  days: PortalAnalyticsRangeDays
  onDaysChange: (days: PortalAnalyticsRangeDays) => void
  projectSlug: string | null
  onProjectChange: (slug: string | null) => void
  projects: ReportingPortalOption[]
  maxDays: number | null | undefined
}

const RANGES: { value: PortalAnalyticsRangeDays; label: string }[] = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
  { value: 180, label: "6m" },
  { value: 365, label: "12m" },
]

export function ReportingControls({
  days,
  onDaysChange,
  projectSlug,
  onProjectChange,
  projects,
  maxDays,
}: ReportingControlsProps): React.ReactElement {
  const ranges =
    maxDays == null ? RANGES : RANGES.filter((range) => range.value <= maxDays)

  // `projects` comes from an SWR hook whose cache is seeded synchronously from
  // localStorage (see swr-provider), so it can be non-empty on the first client
  // render while the server (no localStorage) rendered zero projects. Branching
  // the markup (<select> vs not) on that mismatch throws a hydration error, so
  // hold the project filter until after hydration. useHasHydrated returns false
  // on the server and the first client render, then true.
  const hydrated = useHasHydrated()

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hydrated && projects.length > 0 ? (
        <select
          value={projectSlug ?? ""}
          onChange={(e) => onProjectChange(e.target.value || null)}
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground outline-none transition-colors hover:bg-muted/50 focus:border-ring"
          aria-label="Filter by portal"
        >
          <option value="">All portals</option>
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}

      <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
        {ranges.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => onDaysChange(r.value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
              days === r.value
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  )
}
