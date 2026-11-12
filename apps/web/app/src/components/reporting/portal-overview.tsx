"use client"

import { useState } from "react"
import Link from "next/link"
import { BarChart3 } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  usePortalAnalytics,
  usePortalProjects,
  useWorkspace,
  type PortalAnalyticsRangeDays,
} from "@/hooks/swr"
import { MetricCard } from "./metric-card"
import { DailyActivityChart } from "./daily-activity-chart"
import { TopArticles } from "./top-articles"
import {
  ReportingControls,
  type ReportingPortalOption,
} from "./reporting-controls"
import { Button } from "@/components/ui/button"

function formatInt(n: number): string {
  return n.toLocaleString()
}

function formatPct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)}%`
}

export function PortalOverview(): React.ReactElement {
  const { data: workspace } = useWorkspace()
  const workspaceId = workspace?.id
  const reportingEnabled = workspace?.portal_reporting_enabled === true

  const [days, setDays] = useState<PortalAnalyticsRangeDays>(30)

  // The portal filter is tied to a workspace. Rather than reset it in an effect
  // (which trips react-hooks/set-state-in-effect), key the selection by the
  // workspace it was made in and derive the effective slug — a switch makes the
  // stale key mismatch and falls back to "all portals" with no setState.
  const [selection, setSelection] = useState<{
    ws: string | undefined
    slug: string | null
  }>({ ws: workspaceId, slug: null })
  const projectSlug = selection.ws === workspaceId ? selection.slug : null
  const setProjectSlug = (slug: string | null): void =>
    setSelection({ ws: workspaceId, slug })

  const { data: projectsData } = usePortalProjects({
    workspaceId,
    enabled: reportingEnabled,
  })
  const projects: ReportingPortalOption[] = (projectsData?.projects ?? [])
    .filter((p) => p.publishedVersion != null)
    .map((p) => ({ slug: p.slug, name: p.displayName }))

  const { data, isLoading } = usePortalAnalytics({
    days,
    projectSlug,
    workspaceId,
    enabled: reportingEnabled,
  })
  // `keepPreviousData` makes `data` hold the *previous* query's payload while a
  // new range/portal is in flight, so gating on `!data` would leave stale
  // numbers under the new filter labels. SWR's `isLoading` is keyed to the
  // current query (it ignores laggy data), so it's the honest signal here.
  const loading = !workspaceId || !reportingEnabled || isLoading

  const isEmpty =
    !loading &&
    !!data &&
    data.uniqueVisitors === 0 &&
    data.articleViews === 0 &&
    data.searches === 0 &&
    data.pageViews === 0

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Analytics
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Traffic across your published knowledge base portals.
          </p>
        </div>
        <ReportingControls
          days={days}
          onDaysChange={setDays}
          projectSlug={projectSlug}
          onProjectChange={setProjectSlug}
          projects={projects}
          maxDays={workspace?.portal_reporting_max_days}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Unique visitors"
          value={loading ? "" : formatInt(data?.uniqueVisitors ?? 0)}
          description="People who visited your portals"
          loading={loading}
        />
        <MetricCard
          label="Article views"
          value={loading ? "" : formatInt(data?.articleViews ?? 0)}
          description="Documents opened by visitors"
          loading={loading}
        />
        <MetricCard
          label="Searches"
          value={loading ? "" : formatInt(data?.searches ?? 0)}
          description="Searches run in your portals"
          loading={loading}
        />
        <MetricCard
          label="Search CTR"
          value={loading ? "" : formatPct(data?.searchCtrPct ?? null)}
          description="Searches that led to an article"
          loading={loading}
        />
        <MetricCard
          label="Page helpfulness"
          value={loading ? "" : formatPct(data?.helpfulRatePct ?? null)}
          description={
            loading
              ? "Readers who found pages helpful"
              : `${formatInt(data?.helpfulYes ?? 0)} of ${formatInt(
                  (data?.helpfulYes ?? 0) + (data?.helpfulNo ?? 0),
                )} found pages helpful`
          }
          loading={loading}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily activity</CardTitle>
        </CardHeader>
        <CardContent>
          <DailyActivityChart data={data?.daily ?? []} loading={loading} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Most viewed articles</CardTitle>
        </CardHeader>
        <CardContent>
          <TopArticles
            articles={data?.topArticles ?? []}
            portalSlug={projectSlug}
            loading={loading}
          />
        </CardContent>
      </Card>

      {isEmpty ? (
        <p className="text-center text-xs text-muted-foreground">
          No portal traffic recorded yet. Once your published portal gets
          visitors, their activity shows up here.
        </p>
      ) : null}
    </div>
  )
}
