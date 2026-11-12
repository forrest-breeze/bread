"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { LoadingBar } from "@/components/ui/loading-bar"

// A navigation that never settles (cancelled, failed) must not leave the bar up.
const MAX_PENDING_MS = 10_000

/**
 * Thin progress bar for in-portal navigation.
 *
 * The portal deliberately has no loading skeleton: when a reader clicks a
 * link, the page they are on (header, sidebar, article) stays exactly as it is
 * until the next page is ready, then swaps in one step. Links are prefetched
 * on hover, so that is usually immediate. When it is not, this bar is the only
 * loading feedback, and it stays hidden for the first 200ms so quick
 * navigations show nothing at all.
 */
export function PortalNavProgress(): React.ReactElement | null {
  const pathname = usePathname()
  const pathnameRef = useRef(pathname)
  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  // The pathname a pending navigation started from; pending while unchanged.
  const [pendingFrom, setPendingFrom] = useState<string | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    // Capture phase: Next's <Link> calls preventDefault on the click itself.
    const onClick = (event: MouseEvent): void => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      const anchor = (event.target as Element | null)?.closest?.("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.target && anchor.target !== "_self") return
      if (anchor.hasAttribute("download")) return
      let url: URL
      try {
        url = new URL(anchor.href, window.location.href)
      } catch {
        return
      }
      // Other sites leave the page; same-page links (hash, current doc) don't
      // navigate at all.
      if (url.origin !== window.location.origin) return
      if (url.pathname === window.location.pathname) return

      setPendingFrom(pathnameRef.current)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setPendingFrom(null), MAX_PENDING_MS)
    }
    document.addEventListener("click", onClick, true)
    return () => {
      document.removeEventListener("click", onClick, true)
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (pendingFrom === null || pendingFrom !== pathname) return null
  return (
    <LoadingBar
      label="Loading page"
      className="delayed-reveal pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 rounded-none bg-transparent"
    />
  )
}
