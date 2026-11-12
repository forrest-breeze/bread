"use client"

import { createContext, useContext, useEffect } from "react"
import type React from "react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandPaletteCommand {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly keywords?: readonly string[]
  readonly group?: "navigate" | "create" | "workspace" | "settings"
  readonly icon?: React.ReactNode
  readonly shortcut?: readonly string[] // e.g. ["⌘", "K"]
  readonly perform: () => void | Promise<void>
}

export interface CommandPaletteContextValue {
  readonly isOpen: boolean
  readonly open: () => void
  readonly close: () => void
  readonly toggle: () => void
  readonly commands: readonly CommandPaletteCommand[]
  readonly registerCommand: (command: CommandPaletteCommand) => void
  readonly unregisterCommand: (id: string) => void
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const CommandPaletteContext =
  createContext<CommandPaletteContextValue | null>(null)

// ---------------------------------------------------------------------------
// useCommandPalette — primary consumer hook
// ---------------------------------------------------------------------------

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext)
  if (!ctx) {
    throw new Error(
      "useCommandPalette must be used inside <CommandPaletteProvider>"
    )
  }
  return ctx
}

// ---------------------------------------------------------------------------
// useRegisterCommand — register a dynamic command while a component is mounted.
//
// Callers should pass a memoized `command` (e.g. via `useMemo`) so the effect
// doesn't re-register on every parent render. Re-registration with the same id
// replaces the prior registration in the provider.
// ---------------------------------------------------------------------------

export function useRegisterCommand(command: CommandPaletteCommand): void {
  const { registerCommand, unregisterCommand } = useCommandPalette()

  useEffect(() => {
    registerCommand(command)
    return () => unregisterCommand(command.id)
  }, [registerCommand, unregisterCommand, command])
}
