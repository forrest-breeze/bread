"use client"

import { useEffect, useState } from "react"

/**
 * Palette nav primitive: bounded arrow-key cycling, Enter activation, and
 * "last input wins" mouse-vs-keyboard mode tracking. Designed for command-
 * palette and combobox UIs where keyboard and pointer input must coexist.
 *
 * Returns `activeIndex = -1` when items is empty (no-selection sentinel) and
 * a non-negative integer clamped to `[0, items.length - 1]` otherwise.
 *
 * Selection-on-query-change reset is the consumer's responsibility — call
 * `setActiveIndex(0)` from a useEffect keyed on the query string. The hook
 * intentionally does not auto-reset on items reference change because parents
 * routinely pass freshly-built arrays each render; an in-hook reset would
 * either churn the selection (resetting on every parent render) or require a
 * deep-equal compare (expensive and surprising).
 */

type InputMode = "mouse" | "keyboard"

export interface UsePaletteNavigationOptions<T> {
  onActivate?: (item: T, index: number) => void
}

export interface UsePaletteNavigationResult {
  activeIndex: number
  setActiveIndex: (index: number) => void
  inputMode: InputMode
  onKeyDown: (event: React.KeyboardEvent) => void
}

export function usePaletteNavigation<T>(
  items: readonly T[],
  options?: UsePaletteNavigationOptions<T>,
): UsePaletteNavigationResult {
  const [rawIndex, setRawIndex] = useState(0)
  const [inputMode, setInputMode] = useState<InputMode>("keyboard")

  const len = items.length
  const activeIndex =
    len === 0 ? -1 : Math.min(Math.max(rawIndex, 0), len - 1)

  // Document-level mousemove listener: any pointer movement flips the mode to
  // 'mouse' so consumers can hide the keyboard focus ring while the cursor is
  // active. The first nav key after that flips it back. Idempotent setState
  // calls bail out via React's bail-out optimization, so the constant
  // mousemove firing is cheap.
  useEffect(() => {
    const handler = (): void => {
      setInputMode((prev) => (prev === "mouse" ? prev : "mouse"))
    }
    document.addEventListener("mousemove", handler, { passive: true })
    return () => document.removeEventListener("mousemove", handler)
  }, [])

  const setActiveIndex = (index: number): void => {
    setRawIndex(index)
  }

  const onActivate = options?.onActivate

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      if (len === 0) return
      event.preventDefault()
      setInputMode("keyboard")
      setRawIndex((prev) => {
        const safe = Math.min(Math.max(prev, 0), len - 1)
        return (safe + 1) % len
      })
      return
    }
    if (event.key === "ArrowUp") {
      if (len === 0) return
      event.preventDefault()
      setInputMode("keyboard")
      setRawIndex((prev) => {
        const safe = Math.min(Math.max(prev, 0), len - 1)
        return (safe - 1 + len) % len
      })
      return
    }
    if (event.key === "Enter") {
      if (len === 0) return
      event.preventDefault()
      setInputMode("keyboard")
      const safeIndex = Math.min(Math.max(rawIndex, 0), len - 1)
      onActivate?.(items[safeIndex] as T, safeIndex)
      return
    }
    // Tab, Escape, printable characters, etc. fall through untouched.
  }

  return { activeIndex, setActiveIndex, inputMode, onKeyDown }
}
