"use client"

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { createPortal } from "react-dom"
import { useSWRConfig } from "swr"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useProfile } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"

// ---------------------------------------------------------------------------
// First-visit tutorial. Nothing to set up: everyone already lands in the
// Breeze workspace. A welcome modal offers a short spotlight tour of the
// sidebar. Finishing or skipping stamps profiles.onboarding_completed_at, so
// it shows once; "Take the tour" in the workspace menu replays it.
//
// Spotlight targets are elements marked with data-tour="<id>". A step whose
// target is not on screen (mobile sheet closed, sub-nav hidden) renders as a
// centered card instead, so the tour never dead-ends.
// ---------------------------------------------------------------------------

export interface TourStep {
  target: string
  title: string
  body: string
  /** Navigate here before looking for the target. */
  path?: string
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: "search",
    title: "Search",
    body: "Find any doc by title or content. Press ⌘K anywhere for the command palette.",
  },
  {
    target: "knowledge",
    title: "Knowledge",
    body: "Every doc lives here, organized in folders. Open one to read or edit it in place.",
    path: "/knowledge",
  },
  {
    target: "changes",
    title: "Changes",
    body: "Your edits collect here. Review the diff, then publish when it looks right.",
    path: "/knowledge",
  },
  {
    target: "analytics",
    title: "Analytics",
    body: "See what readers open and search for on the published docs.",
  },
  {
    target: "integrations",
    title: "Integrations",
    body: "Pull in sources like OpenAPI specs. Optional, and nothing you need to do today.",
  },
  {
    target: "settings",
    title: "Settings",
    body: "Your profile, preferences and workspace members. Replay this tour any time from the workspace menu.",
  },
]

type Phase = "idle" | "welcome" | "touring"

interface ProductTourContextValue {
  /** Replay from the welcome modal. */
  start: () => void
}

const ProductTourContext = createContext<ProductTourContextValue | null>(null)

export function useProductTour(): ProductTourContextValue {
  return useContext(ProductTourContext) ?? { start: () => {} }
}

async function markTourComplete(): Promise<void> {
  try {
    await fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tutorial_completed: true }),
    })
  } catch (err) {
    // Worst case the welcome modal shows again next visit.
    console.warn("[Bread] could not save tutorial completion:", err)
  }
}

export function ProductTourProvider({ children }: { children: React.ReactNode }) {
  const hasHydrated = useHasHydrated()
  const { data: profile } = useProfile()
  const { mutate } = useSWRConfig()
  const [phase, setPhase] = useState<Phase>("idle")
  const [stepIndex, setStepIndex] = useState(0)
  // Set once the user has acted on the auto-opened modal, so it can't reopen
  // this session even if saving completion fails.
  const [dismissed, setDismissed] = useState(false)

  // Auto-open for users who have never finished or skipped it.
  const autoWelcome =
    hasHydrated && !dismissed && phase === "idle" && profile?.onboarding_completed_at === null

  const finish = useCallback(() => {
    setDismissed(true)
    setPhase("idle")
    setStepIndex(0)
    if (profile && profile.onboarding_completed_at === null) {
      const now = new Date().toISOString()
      void mutate(
        "/api/profile",
        { ...profile, onboarding_completed_at: now },
        { revalidate: false },
      )
      void markTourComplete()
    }
  }, [mutate, profile])

  const start = useCallback(() => {
    setDismissed(true)
    setStepIndex(0)
    setPhase("welcome")
  }, [])

  return (
    <ProductTourContext.Provider value={{ start }}>
      {children}
      <WelcomeDialog
        open={phase === "welcome" || autoWelcome}
        onSkip={finish}
        onStart={() => {
          setDismissed(true)
          setStepIndex(0)
          setPhase("touring")
        }}
      />
      {phase === "touring" && (
        <TourSpotlight
          // Remount per step so the target lookup starts fresh.
          key={stepIndex}
          steps={TOUR_STEPS}
          index={stepIndex}
          onIndexChange={setStepIndex}
          onClose={finish}
        />
      )}
    </ProductTourContext.Provider>
  )
}

function WelcomeDialog({
  open,
  onSkip,
  onStart,
}: {
  open: boolean
  onSkip: () => void
  onStart: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onSkip() }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Welcome to Bread</DialogTitle>
          <DialogDescription>
            This is where Breeze docs are written, reviewed and published. You&apos;re
            already in the Breeze workspace, so there&apos;s nothing to set up.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Want a quick look around? It takes under a minute.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onSkip}>
            Skip
          </Button>
          <Button onClick={onStart} autoFocus>
            Show me around
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const CARD_WIDTH = 300
const GAP = 12
const MARGIN = 16
/** How long to wait for a target to mount (e.g. after navigating). */
const TARGET_WAIT_MS = 1500

function findVisibleTarget(id: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(id)}"]`)
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return node
  }
  return null
}

function TourSpotlight({
  steps,
  index,
  onIndexChange,
  onClose,
}: {
  steps: TourStep[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const step = steps[index]!
  const isLast = index === steps.length - 1
  const router = useRouter()
  const pathname = usePathname()
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [searching, setSearching] = useState(true)
  const cardRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const [cardHeight, setCardHeight] = useState(160)

  useEffect(() => {
    if (step.path && pathname !== step.path && !pathname.startsWith(step.path + "/")) {
      router.push(step.path)
    }
  }, [step.path, pathname, router])

  // Locate the target, polling briefly while it mounts, then keep the
  // spotlight in place on resize and scroll.
  useEffect(() => {
    let cancelled = false
    let target: HTMLElement | null = null

    const measure = () => {
      if (!target || !target.isConnected) target = findVisibleTarget(step.target)
      setRect(target ? target.getBoundingClientRect() : null)
    }

    const startedAt = Date.now()
    const poll = window.setInterval(() => {
      if (cancelled) return
      target = findVisibleTarget(step.target)
      if (target || Date.now() - startedAt > TARGET_WAIT_MS) {
        window.clearInterval(poll)
        measure()
        setSearching(false)
      }
    }, 100)

    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      cancelled = true
      window.clearInterval(poll)
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [step.target, pathname])

  useLayoutEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight)
  }, [index, rect, searching])

  useEffect(() => {
    if (!searching) nextRef.current?.focus()
  }, [searching, index])

  const goNext = useCallback(() => {
    if (isLast) onClose()
    else onIndexChange(index + 1)
  }, [index, isLast, onClose, onIndexChange])

  const goBack = useCallback(() => {
    if (index > 0) onIndexChange(index - 1)
  }, [index, onIndexChange])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose() }
      else if (e.key === "ArrowRight") { e.preventDefault(); goNext() }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goBack() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [goNext, goBack, onClose])

  if (typeof document === "undefined") return null

  const viewportW = window.innerWidth
  const viewportH = window.innerHeight
  const cardWidth = Math.min(CARD_WIDTH, viewportW - MARGIN * 2)

  let cardStyle: React.CSSProperties
  if (rect) {
    // Sidebar targets sit on the left, so prefer the right side; flip below
    // when there is no room.
    const fitsRight = rect.right + GAP + cardWidth + MARGIN <= viewportW
    if (fitsRight) {
      cardStyle = {
        left: rect.right + GAP,
        top: Math.min(Math.max(rect.top + rect.height / 2 - cardHeight / 2, MARGIN), viewportH - cardHeight - MARGIN),
      }
    } else {
      cardStyle = {
        left: Math.min(Math.max(rect.left, MARGIN), viewportW - cardWidth - MARGIN),
        top: Math.min(rect.bottom + GAP, viewportH - cardHeight - MARGIN),
      }
    }
  } else {
    cardStyle = {
      left: (viewportW - cardWidth) / 2,
      top: Math.max((viewportH - cardHeight) / 2, MARGIN),
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60]" data-testid="product-tour">
      {/* Clicks on the dimmed area are swallowed so the page can't change
          underneath the tour; Esc or Skip closes it. */}
      {rect ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed rounded-lg ring-2 ring-primary transition-all duration-200"
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)",
          }}
        />
      ) : (
        <div aria-hidden="true" className="fixed inset-0 bg-black/45" />
      )}
      <div className="fixed inset-0" onClick={(e) => e.stopPropagation()} />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-tour-title"
        aria-describedby="product-tour-body"
        className="fixed rounded-xl bg-background p-4 text-sm shadow-lg ring-1 ring-foreground/10"
        style={{ ...cardStyle, width: cardWidth, visibility: searching ? "hidden" : "visible" }}
      >
        <p className="text-[11px] font-medium text-muted-foreground tabular-nums">
          {index + 1} of {steps.length}
        </p>
        <h2 id="product-tour-title" className="mt-1 text-base font-medium leading-tight">
          {step.title}
        </h2>
        <p id="product-tour-body" className="mt-1.5 text-muted-foreground">
          {step.body}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Skip tour
          </Button>
          <div className="flex-1" />
          {index > 0 && (
            <Button variant="outline" size="sm" onClick={goBack}>
              Back
            </Button>
          )}
          <Button ref={nextRef} size="sm" onClick={goNext}>
            {isLast ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
