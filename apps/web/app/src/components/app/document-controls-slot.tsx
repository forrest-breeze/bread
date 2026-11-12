"use client"

import { createContext, useContext } from "react"
import { createPortal } from "react-dom"

/**
 * Where an open document's controls (save state, version history, GitHub
 * mode) render. The portal builder points this at a "Document" section in its
 * rail, so the editor inside the preview frame carries no toolbar of its own.
 * Outside the builder there is no slot and the editor renders them inline.
 */
const DocumentControlsSlotContext = createContext<HTMLElement | null>(null)

export const DocumentControlsSlotProvider = DocumentControlsSlotContext.Provider

export function DocumentControls({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  const slot = useContext(DocumentControlsSlotContext)
  if (slot) return createPortal(children, slot)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-2">
      {children}
    </div>
  )
}
