"use client"

import { useEffect, useState, type ReactElement } from "react"
import { Loader2Icon, Wand2 as Wand2Icon } from "lucide-react"

// ---------------------------------------------------------------------------
// Full-screen branded overlay shown while the "Custom" creation flow generates a
// portal from scratch. Generation is a single async call, so the rotating status
// copy is cosmetic pacing (not real progress) to make the wait feel deliberate.
// ---------------------------------------------------------------------------

const BUILD_STEPS = [
  "Reading your knowledge base…",
  "Designing the layout…",
  "Assembling sections…",
  "Applying your theme…",
  "Almost there…",
] as const

export function PortalBuildLoader({ name }: { name?: string }): ReactElement {
  const [step, setStep] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setStep((current) => (current + 1) % BUILD_STEPS.length)
    }, 2200)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-background/95 backdrop-blur-sm">
      <div className="relative flex size-16 items-center justify-center">
        <Loader2Icon className="absolute inset-0 size-16 animate-spin text-primary/25" />
        <Wand2Icon className="size-7 text-primary" />
      </div>
      <div className="space-y-1 text-center">
        <p className="text-sm font-medium text-foreground">
          Building {name ? `"${name}"` : "your portal"}
        </p>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {BUILD_STEPS[step]}
        </p>
      </div>
    </div>
  )
}
