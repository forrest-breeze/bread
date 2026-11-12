"use client"

import { useEffect, useState } from "react"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { formatRelativeTime } from "@/lib/utils"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const TIMER_BUFFER_MS = 50

function formatStableDate(isoDate: string): string {
  const date = new Date(isoDate)
  if (!Number.isFinite(date.getTime())) return isoDate
  return date.toISOString().slice(0, 10)
}

function getNextTickDelayMs(isoDate: string): number {
  const timestamp = new Date(isoDate).getTime()
  if (!Number.isFinite(timestamp)) return MINUTE_MS

  const now = Date.now()
  const diffMs = Math.max(0, now - timestamp)
  let nextBoundaryMs: number

  if (diffMs < MINUTE_MS) {
    nextBoundaryMs = MINUTE_MS
  } else if (diffMs < HOUR_MS) {
    nextBoundaryMs = (Math.floor(diffMs / MINUTE_MS) + 1) * MINUTE_MS
  } else if (diffMs < DAY_MS) {
    nextBoundaryMs = (Math.floor(diffMs / HOUR_MS) + 1) * HOUR_MS
  } else if (diffMs < WEEK_MS) {
    nextBoundaryMs = (Math.floor(diffMs / DAY_MS) + 1) * DAY_MS
  } else {
    nextBoundaryMs = (Math.floor(diffMs / WEEK_MS) + 1) * WEEK_MS
  }

  return Math.max(1_000, timestamp + nextBoundaryMs - now + TIMER_BUFFER_MS)
}

interface RelativeTimeProps {
  isoDate: string
  prefix?: string
  prefixMode?: "always" | "just-now"
  className?: string
  title?: string
}

// Re-renders itself at the next visible label boundary so "just now" advances
// to "1m ago" right after the minute mark without requiring the parent to
// refetch. Keeps the tick local; siblings are not re-rendered on each tick.
export function RelativeTime({
  isoDate,
  prefix,
  prefixMode = "always",
  className,
  title,
}: RelativeTimeProps): React.ReactElement {
  const hasHydrated = useHasHydrated()
  const [, setTick] = useState(0)

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null

    const schedule = (): void => {
      timeout = setTimeout(() => {
        setTick((n) => n + 1)
        schedule()
      }, getNextTickDelayMs(isoDate))
    }

    schedule()
    return () => {
      if (timeout) clearTimeout(timeout)
    }
  }, [isoDate])

  // Keep SSR and the first hydration render byte-identical; Date.now() can
  // cross a visible bucket boundary between them.
  const label = hasHydrated
    ? formatRelativeTime(isoDate)
    : formatStableDate(isoDate)
  const shouldPrefix =
    Boolean(prefix) && (prefixMode === "always" || label === "just now")

  return (
    <span className={className} title={title}>
      {shouldPrefix ? `${prefix} ${label}` : label}
    </span>
  )
}
