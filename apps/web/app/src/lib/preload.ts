import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types"
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime"

// ---------------------------------------------------------------------------
// Client-side preloading helpers.
//
// Every page in this app is dynamic. Next's default prefetch for a dynamic
// route only fetches down to the nearest loading.tsx boundary, so a click
// still waits on the server render behind a skeleton. A FULL prefetch fetches
// the complete page payload ahead of time, so the navigation swaps in finished
// content with no loading state.
// ---------------------------------------------------------------------------

interface NetworkInformationLike {
  saveData?: boolean
  effectiveType?: string
}

/** False for visitors on Data Saver or a very slow connection. */
export function canPreload(): boolean {
  if (typeof navigator === "undefined") return false
  const connection = (navigator as Navigator & {
    connection?: NetworkInformationLike
  }).connection
  if (connection?.saveData) return false
  if (connection?.effectiveType && /(^|-)2g$/.test(connection.effectiveType)) {
    return false
  }
  return true
}

/** Prefetch a route's complete payload (not just its loading shell). */
export function prefetchRouteFull(
  router: Pick<AppRouterInstance, "prefetch">,
  href: string,
): void {
  if (!href || !href.startsWith("/")) return
  try {
    router.prefetch(href, { kind: PrefetchKind.FULL })
  } catch {
    // Prefetching is best-effort; navigation still works without it.
  }
}

/** Run `callback` when the browser is idle. Returns a cancel function. */
export function runWhenIdle(callback: () => void, timeoutMs = 2000): () => void {
  if (typeof window === "undefined") return () => undefined
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: timeoutMs })
    return () => window.cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(callback, 200)
  return () => window.clearTimeout(handle)
}
