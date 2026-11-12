"use client"

import { useSyncExternalStore } from "react"
import { Menu } from "lucide-react"
import { cn } from "@/lib/utils"

// Below `lg` the docs navigation rail is hidden. The header's menu button and
// the rail share this tiny store so the rail can open as a drawer without the
// (server-rendered) header having to know what the current page's nav holds.
// `railCount` lets the button render only on views that actually have a rail.

interface MobileNavState {
  open: boolean
  railCount: number
}

let state: MobileNavState = { open: false, railCount: 0 }
const listeners = new Set<() => void>()

function setState(next: Partial<MobileNavState>): void {
  state = { ...state, ...next }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const SERVER_STATE: MobileNavState = { open: false, railCount: 0 }

export function useMobileNav(): MobileNavState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE)
}

export function setMobileNavOpen(open: boolean): void {
  if (state.open !== open) setState({ open })
}

/** Called by a navigation rail on mount; returns its unregister function. */
export function registerMobileNavRail(): () => void {
  setState({ railCount: state.railCount + 1 })
  return () => {
    const railCount = Math.max(0, state.railCount - 1)
    setState(railCount === 0 ? { railCount, open: false } : { railCount })
  }
}

export function PortalMobileNavButton({
  className,
}: {
  className?: string
}): React.ReactElement | null {
  const { open, railCount } = useMobileNav()
  if (railCount === 0) return null
  return (
    <button
      type="button"
      aria-label={open ? "Close navigation" : "Open navigation"}
      aria-expanded={open}
      onClick={() => setMobileNavOpen(!open)}
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden",
        className,
      )}
    >
      <Menu className="size-5" aria-hidden="true" />
    </button>
  )
}
