"use client"

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  FileText,
  Settings,
} from "lucide-react"

import {
  CommandPaletteContext,
  type CommandPaletteCommand,
  type CommandPaletteContextValue,
} from "@/hooks/use-command-palette"
import { CommandPalette } from "@/components/app/command-palette/command-palette"

// ---------------------------------------------------------------------------
// Feature gate — set to false to hide the UI without removing the listener
// ---------------------------------------------------------------------------
const experimentalFeatures = {
  commandPaletteEnabled: true,
} as const

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface CommandPaletteProviderProps {
  readonly children: React.ReactNode
}

export function CommandPaletteProvider({
  children,
}: CommandPaletteProviderProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const router = useRouter()

  // Dynamic commands registered by mounted consumers via `useRegisterCommand`.
  // Stored in insertion order; ids are unique (replacement-on-conflict).
  const [dynamicCommands, setDynamicCommands] = useState<
    readonly CommandPaletteCommand[]
  >([])

  const registerCommand = useCallback(
    (command: CommandPaletteCommand): void => {
      setDynamicCommands((prev) => {
        const existingIndex = prev.findIndex((c) => c.id === command.id)
        if (existingIndex === -1) return [...prev, command]
        const next = prev.slice()
        next[existingIndex] = command
        return next
      })
    },
    [],
  )

  const unregisterCommand = useCallback((id: string): void => {
    setDynamicCommands((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const open = useCallback((): void => setIsOpen(true), [])
  const close = useCallback((): void => setIsOpen(false), [])
  const toggle = useCallback((): void => setIsOpen((prev) => !prev), [])

  // Baseline navigation commands are static aside from `router`; derive them
  // with `useMemo` rather than synchronously calling setState in an effect.
  const navCommands = useMemo<readonly CommandPaletteCommand[]>(
    () => [
      {
        id: "navigate:knowledge",
        title: "Go to Knowledge",
        description: "Browse and search the knowledge base",
        keywords: ["docs", "documents", "wiki", "runbooks", "articles"],
        group: "navigate",
        icon: React.createElement(FileText, { className: "size-4" }),
        perform: () => router.push("/knowledge"),
      },
      {
        id: "navigate:settings",
        title: "Go to Settings",
        description: "Workspace and account settings",
        keywords: ["preferences", "configuration", "account", "profile"],
        group: "navigate",
        icon: React.createElement(Settings, { className: "size-4" }),
        perform: () => router.push("/settings"),
      },
    ],
    [router],
  )

  const commands = useMemo<readonly CommandPaletteCommand[]>(
    () => [...navCommands, ...dynamicCommands],
    [navCommands, dynamicCommands],
  )

  // Global Cmd-K / Ctrl-K listener
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isMac =
        typeof navigator !== "undefined" &&
        /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      const modifierHeld = isMac ? event.metaKey : event.ctrlKey
      if (modifierHeld && event.key === "k") {
        event.preventDefault()
        toggle()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [toggle])

  const contextValue: CommandPaletteContextValue = useMemo(
    () => ({
      isOpen,
      open,
      close,
      toggle,
      commands,
      registerCommand,
      unregisterCommand,
    }),
    [isOpen, open, close, toggle, commands, registerCommand, unregisterCommand],
  )

  return (
    <CommandPaletteContext.Provider value={contextValue}>
      {children}
      {experimentalFeatures.commandPaletteEnabled && (
        <CommandPalette />
      )}
    </CommandPaletteContext.Provider>
  )
}
