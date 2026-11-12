"use client"

import { createContext, useContext } from "react"

/**
 * Set by the portal builder while a document is open in its preview frame:
 * closes the editor and returns to the rendered portal. Null elsewhere (the
 * standalone Knowledge editor), where no close control is shown.
 */
const PortalEditorExitContext = createContext<(() => void) | null>(null)

export const PortalEditorExitProvider = PortalEditorExitContext.Provider

export function usePortalEditorExit(): (() => void) | null {
  return useContext(PortalEditorExitContext)
}
