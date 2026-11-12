"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import {
  registerMobileNavRail,
  setMobileNavOpen,
  useMobileNav,
} from "./portal-mobile-nav"

// How long the scrollbar thumb lingers after the last scroll event.
const SCROLLBAR_HIDE_DELAY_MS = 600

// Docs navigation and table-of-contents rail. Pinned under the sticky header (including page navigation) and sized to the
// viewport so it scrolls independently of the page (overscroll-contain stops
// scroll chaining into the main view). The thumb is only painted while the
// rail is actively scrolling — see `.portal-rail-scroll` in index.css.
//
// Below `lg` the navigation rail is hidden and instead opens as a slide-in
// drawer from the header's menu button (see portal-mobile-nav).
export function PortalSidebarRail({
  children,
  className,
  variant = "navigation",
}: {
  children: React.ReactNode
  className?: string
  variant?: "navigation" | "toc"
}): React.ReactElement {
  const ref = useRef<HTMLElement>(null)
  const isNavigation = variant === "navigation"
  const { open } = useMobileNav()
  const drawerOpen = isNavigation && open

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onScroll = (): void => {
      el.dataset.scrolling = ""
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        delete el.dataset.scrolling
      }, SCROLLBAR_HIDE_DELAY_MS)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      el.removeEventListener("scroll", onScroll)
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!isNavigation) return
    return registerMobileNavRail()
  }, [isNavigation])

  // Close on Escape, and when the viewport grows into the desktop layout.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMobileNavOpen(false)
    }
    const desktop = window.matchMedia("(min-width: 1024px)")
    const onDesktop = (): void => {
      if (desktop.matches) setMobileNavOpen(false)
    }
    document.addEventListener("keydown", onKey)
    desktop.addEventListener("change", onDesktop)
    return () => {
      document.removeEventListener("keydown", onKey)
      desktop.removeEventListener("change", onDesktop)
    }
  }, [drawerOpen])

  return (
    <>
      {drawerOpen ? (
        <div
          aria-hidden="true"
          data-testid="portal-mobile-nav-backdrop"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      <aside
        ref={ref}
        data-mobile-nav-open={drawerOpen ? "" : undefined}
        // Following a link inside the drawer should reveal the new page.
        onClick={
          drawerOpen
            ? (e) => {
                if ((e.target as HTMLElement).closest("a")) setMobileNavOpen(false)
              }
            : undefined
        }
        className={cn(
          "portal-rail-scroll hidden sticky top-[var(--portal-header-height,4rem)] h-[calc(100dvh-var(--portal-header-height,4rem))] self-start overflow-y-auto overscroll-contain border-border/70 px-6",
          isNavigation
            ? "border-r bg-muted/15 py-8 lg:row-span-2 lg:block"
            : "min-w-0 border-l py-14 xl:row-span-2 xl:block",
          drawerOpen &&
            "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:block max-lg:h-dvh max-lg:w-[85%] max-lg:max-w-xs max-lg:bg-background max-lg:shadow-2xl",
          className,
        )}
      >
        {children}
      </aside>
    </>
  )
}
