"use client"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useWorkspace, useWorkspaceUsage } from "@/hooks/swr"

function formatDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exp = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  )
  const value = bytes / Math.pow(1024, exp)
  return `${value.toFixed(value >= 10 || exp === 0 ? 0 : 1)} ${units[exp]}`
}

interface UsageStat {
  readonly label: string
  readonly value: string
  readonly hint?: string
}

export default function UsagePage(): React.ReactElement {
  const { data: workspace } = useWorkspace()
  const isAdmin =
    workspace?.user_role === "admin" || workspace?.user_role === "owner"
  const { data: usage, isLoading } = useWorkspaceUsage({ enabled: isAdmin })

  const periodStart = formatDate(usage?.periodStart ?? null)
  const periodEnd = formatDate(usage?.periodEnd ?? null)
  const periodLabel =
    periodStart && periodEnd
      ? `${periodStart} – ${periodEnd}`
      : "Current period"

  const stats: readonly UsageStat[] = usage
    ? [
        {
          label: "Compute operations",
          value: usage.compute.opsSuccess.toLocaleString(),
          hint:
            usage.compute.opsError > 0
              ? `${usage.compute.opsError.toLocaleString()} failed`
              : "Includes scheduled integration checks and AI work",
        },
        {
          label: "Tokens in",
          value: usage.compute.tokensInput.toLocaleString(),
        },
        {
          label: "Tokens out",
          value: usage.compute.tokensOutput.toLocaleString(),
        },
        {
          label: "Media storage",
          value: `${formatBytes(usage.storage.mediaBytes)} / ${formatBytes(usage.storage.mediaLimitBytes)}`,
          hint: "S3/R2 media used and storage limit",
        },
        {
          label: "Active members",
          value: (usage.members?.count ?? 0).toLocaleString(),
        },
      ]
    : []

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Operational counts for your workspace. These do not affect billing today.
        </p>
      </div>

      {!isAdmin ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Only workspace admins can view usage.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Usage this period</CardTitle>
            <CardDescription>{periodLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading && !usage ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="space-y-2 rounded-xl border bg-muted/10 p-4">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-6 w-16" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {stats.map((stat) => (
                  <div
                    key={stat.label}
                    className="space-y-1 rounded-xl border bg-muted/10 p-4"
                  >
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                    <p className="text-lg font-semibold tabular-nums">
                      {stat.value}
                    </p>
                    {stat.hint && (
                      <p className="text-[11px] text-muted-foreground">{stat.hint}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
