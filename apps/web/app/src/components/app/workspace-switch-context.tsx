"use client"

import React, { createContext, useContext, useState } from "react"

interface WorkspaceSwitchContextValue {
  /** True while the active workspace is being switched and its data reloads. */
  isSwitching: boolean
  setSwitching: (switching: boolean) => void
}

const WorkspaceSwitchContext = createContext<WorkspaceSwitchContextValue | null>(null)

/**
 * Broadcasts a transient "switching workspace" flag from the workspace menu
 * (deep in the sidebar) to the main content area, so the app can show a global
 * reload indicator while every workspace-scoped cache revalidates.
 */
export function WorkspaceSwitchProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [isSwitching, setSwitching] = useState(false)

  return (
    <WorkspaceSwitchContext.Provider value={{ isSwitching, setSwitching }}>
      {children}
    </WorkspaceSwitchContext.Provider>
  )
}

export function useWorkspaceSwitch(): WorkspaceSwitchContextValue {
  const ctx = useContext(WorkspaceSwitchContext)
  if (!ctx) {
    throw new Error("useWorkspaceSwitch must be used within a WorkspaceSwitchProvider")
  }
  return ctx
}
