import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Thrown by {@link withTimeout} when the wrapped promise outlasts the budget. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`)
    this.name = "TimeoutError"
  }
}

/**
 * Rejects with {@link TimeoutError} if `promise` hasn't settled within `ms`.
 *
 * Server renders must never block indefinitely on a downstream call: a hung
 * Supabase request will run until the hosting platform's function execution
 * limit, at which point the platform kills the function and serves its own
 * uncatchable crash page (no React error boundary runs). Racing the call
 * against a short timeout converts that hang into a fast, *catchable* throw so
 * the nearest `error.tsx` boundary can render a branded, recoverable page.
 *
 * Note: this abandons the await; it does not abort the underlying request. The
 * dangling promise settles in the background and is GC'd after the render has
 * already produced its (error) response.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  const diffWeek = Math.floor(diffDay / 7)
  return `${diffWeek}w ago`
}

export function formatRelativeDate(value: string | null): string {
  if (!value) return ""
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ""
  const diffMs = Date.now() - parsed.getTime()
  const day = 1000 * 60 * 60 * 24
  if (diffMs < day) return "today"
  if (diffMs < 2 * day) return "yesterday"
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} days ago`
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
}
