"use client"

import React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { ComponentPropsWithoutRef } from "react"
import { useHoverIntent } from "@/hooks/use-hover-intent"
import { prefetchRouteFull } from "@/lib/preload"

type NextLinkProps = ComponentPropsWithoutRef<typeof Link>

interface HoverPrefetchLinkProps extends NextLinkProps {
  /**
   * Milliseconds of hover before triggering a prefetch. Defaults to 80.
   */
  intentDelayMs?: number
  /**
   * Set to true to suppress hover-intent prefetch for this link. The link
   * still renders and works normally — only the prefetch-on-hover is
   * disabled. Useful as an escape hatch when a specific link should not
   * kick off a background fetch.
   */
  disableHoverPrefetch?: boolean
  /**
   * By default `prefetch={false}` is forwarded to `<Link>` so that
   * Next.js does not prefetch on viewport entry (we handle prefetch on
   * hover instead). Set this to `true` to re-enable viewport-based
   * prefetch in addition to hover-intent prefetch.
   */
  keepViewportPrefetch?: boolean
}

/**
 * A drop-in replacement for Next.js `<Link>` that prefetches the destination
 * route when the user hovers with intent (i.e. after a short pause), rather
 * than waiting until the route enters the viewport.
 *
 * Usage is identical to `<Link>` with two optional extra props:
 *   - `intentDelayMs` — hover dwell time before prefetch fires (default 80ms)
 *   - `disableHoverPrefetch` — opt-out on a per-link basis
 *   - `keepViewportPrefetch` — re-enable Next's built-in viewport prefetch
 */
export function HoverPrefetchLink({
  href,
  intentDelayMs = 80,
  disableHoverPrefetch = false,
  keepViewportPrefetch = false,
  onTouchStart: externalTouchStart,
  onMouseEnter: externalMouseEnter,
  onMouseLeave: externalMouseLeave,
  children,
  className,
  ...rest
}: HoverPrefetchLinkProps): React.ReactElement {
  const router = useRouter()

  const hrefString = typeof href === "string" ? href : href.pathname ?? ""

  const { onMouseEnter: hoverEnter, onMouseLeave: hoverLeave } =
    useHoverIntent({
      delayMs: intentDelayMs,
      onIntent: () => {
        // Full prefetch: fetch the finished page, not just its loading
        // shell, so the click swaps content in with no loading state.
        if (!disableHoverPrefetch) {
          prefetchRouteFull(router, hrefString)
        }
      },
    })

  const handleMouseEnter = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!disableHoverPrefetch) {
      hoverEnter()
    }
    if (typeof externalMouseEnter === "function") {
      externalMouseEnter(e)
    }
  }

  const handleMouseLeave = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!disableHoverPrefetch) {
      hoverLeave()
    }
    if (typeof externalMouseLeave === "function") {
      externalMouseLeave(e)
    }
  }

  // Touch devices have no hover: start the prefetch on touchstart, which
  // lands ~100ms or more before the click that follows it.
  const handleTouchStart = (e: React.TouchEvent<HTMLAnchorElement>) => {
    if (!disableHoverPrefetch) prefetchRouteFull(router, hrefString)
    if (typeof externalTouchStart === "function") externalTouchStart(e)
  }

  return (
    <Link
      href={href}
      prefetch={keepViewportPrefetch ? undefined : false}
      onTouchStart={handleTouchStart}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={className}
      {...rest}
    >
      {children}
    </Link>
  )
}
