"use client"

import React, { use } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useImportJob } from "@/hooks/swr"

interface PageProps {
  params: Promise<{ id: string }>
}

export default function ImportJobDetailPage({ params }: PageProps): React.JSX.Element {
  const { id } = use(params)
  const { data, isLoading, mutate } = useImportJob(id, {
    refreshInterval: (latest) => {
      const status = latest?.job?.status
      return status === "pending" || status === "running" ? 2000 : 0
    },
  })

  const job = data?.job
  const items = data?.items ?? []

  async function cancel(): Promise<void> {
    if (!confirm("Cancel this import? Already-imported docs stay in Bread.")) return
    await fetch(`/api/import/jobs/${id}/cancel`, { method: "POST" })
    await mutate()
  }

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <Link
          href="/settings/workspace/import"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Import
        </Link>
      </div>

      {isLoading || !job ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base capitalize">
                  {job.source} import
                </CardTitle>
                <Badge variant="outline">{job.status}</Badge>
              </div>
              <CardDescription>
                Created {new Date(job.created_at).toLocaleString()}
                {job.completed_at &&
                  ` · finished ${new Date(job.completed_at).toLocaleString()}`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ProgressBar
                processed={job.processed_items}
                total={job.total_items}
              />
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                <Stat label="Total" value={job.total_items} />
                <Stat label="Succeeded" value={job.succeeded_items} />
                <Stat label="Failed" value={job.failed_items} />
                <Stat label="Skipped" value={job.skipped_items} />
              </div>
              {job.error_message && (
                <p className="text-sm text-destructive">{job.error_message}</p>
              )}
              {(job.status === "pending" || job.status === "running") && (
                <Button variant="outline" onClick={cancel}>
                  Cancel
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Items</CardTitle>
            </CardHeader>
            <CardContent>
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No items processed yet.
                </p>
              ) : (
                <div className="space-y-1">
                  {items.map((it) => (
                    <div
                      key={it.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">
                          {it.title || it.source_ref}
                        </div>
                        {it.error_message && (
                          <div className="truncate text-xs text-destructive">
                            {it.error_message}
                          </div>
                        )}
                      </div>
                      <Badge variant="outline">{it.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function ProgressBar({
  processed,
  total,
}: {
  processed: number
  total: number
}): React.JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {processed} / {total}
        </span>
        <span>{pct}%</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-foreground transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-muted-foreground">{label}</div>
    </div>
  )
}
