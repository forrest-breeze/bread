"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { canPreload, prefetchRouteFull, runWhenIdle } from "@/lib/preload"

/**
 * Fully prefetch a short list of routes once the browser is idle. Used for the
 * pages a reader is most likely to open next (the next doc, the first docs in
 * a folder they just opened). Keep the list small: each entry is a real server
 * render.
 */
export function useIdleRoutePrefetch(hrefs: string[], enabled = true): void {
  const router = useRouter()
  // Stable dependency: the list is tiny, and callers rebuild it every render.
  const key = hrefs.join("\n")

  useEffect(() => {
    if (!enabled || !key || !canPreload()) return
    return runWhenIdle(() => {
      for (const href of key.split("\n")) prefetchRouteFull(router, href)
    })
  }, [enabled, key, router])
}

// ---------------------------------------------------------------------------
// Bulk preload: fetch a whole navigation list ahead of time, so the section
// behaves like one already-loaded page.
// ---------------------------------------------------------------------------

/** Most pages one pass will preload. Each one is a real server render. */
export const BULK_PRELOAD_LIMIT = 60
/** Pages requested per step, and the pause between steps. */
const BULK_BATCH_SIZE = 4
const BULK_BATCH_GAP_MS = 250
/** Let the page the reader actually asked for settle first. */
const BULK_START_DELAY_MS = 1500
/**
 * Next keeps a fully prefetched page for 5 minutes. A pass is repeated only
 * once the previous one is about to expire, and only when the reader
 * navigates (no timers, so an idle tab costs nothing).
 */
const BULK_REFRESH_MS = 4.5 * 60_000

// Per tab. The list is rendered by more than one component per page (desktop
// rail and mobile menu) and is rebuilt on every navigation; this keeps those
// from starting duplicate passes.
let lastBulkPass: { key: string; at: number } | null = null
let bulkPassInProgress: string | null = null

/** Test helper. */
export function resetBulkRoutePrefetch(): void {
  lastBulkPass = null
  bulkPassInProgress = null
}

/**
 * Fully prefetch up to BULK_PRELOAD_LIMIT routes in the order given, a few at
 * a time while the browser is idle. Pass the routes nearest the reader first.
 * `listKey` identifies the list independent of that ordering, so re-ordering
 * it on each navigation does not restart a pass that is still fresh.
 */
export function useBulkRoutePrefetch(
  hrefs: string[],
  listKey: string,
  enabled = true,
): void {
  const router = useRouter()
  const ordered = hrefs.slice(0, BULK_PRELOAD_LIMIT).join("\n")

  useEffect(() => {
    if (!enabled || !ordered || !canPreload()) return
    if (bulkPassInProgress === listKey) return
    if (
      lastBulkPass &&
      lastBulkPass.key === listKey &&
      Date.now() - lastBulkPass.at < BULK_REFRESH_MS
    ) {
      return
    }

    const list = ordered.split("\n")
    let index = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelIdle: () => void = () => undefined
    bulkPassInProgress = listKey

    const step = (): void => {
      cancelIdle = runWhenIdle(() => {
        for (const href of list.slice(index, index + BULK_BATCH_SIZE)) {
          prefetchRouteFull(router, href)
        }
        index += BULK_BATCH_SIZE
        if (index < list.length) {
          timer = setTimeout(step, BULK_BATCH_GAP_MS)
        } else {
          lastBulkPass = { key: listKey, at: Date.now() }
          bulkPassInProgress = null
        }
      })
    }
    timer = setTimeout(step, BULK_START_DELAY_MS)

    return () => {
      // Navigating away mid-pass: stop here. The next page starts a new pass,
      // and the pages already fetched are cache hits, so nothing is repeated.
      if (timer) clearTimeout(timer)
      cancelIdle()
      if (bulkPassInProgress === listKey) bulkPassInProgress = null
    }
  }, [enabled, listKey, ordered, router])
}
