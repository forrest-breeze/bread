"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { Moon, Sun } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PortalTheme } from "@/lib/portal/schema"
import {
  createPortalPreviewThemeMessage,
  createPortalPreviewThemeReadyMessage,
  isPortalPreviewThemeMessage,
  type PortalPreviewThemeMode,
} from "@/lib/portal/preview-theme-message"

type PortalThemeMode = PortalPreviewThemeMode

const STORAGE_KEY = "bread-public-portal-theme"
const STORAGE_EVENT = "bread-public-portal-theme-change"

function initialMode(appearance: PortalTheme["appearance"]): PortalThemeMode {
  return appearance === "dark" ? "dark" : "light"
}

function getThemeSnapshot(appearance: PortalTheme["appearance"]): PortalThemeMode {
  if (typeof window === "undefined") return initialMode(appearance)

  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === "light" || stored === "dark") return stored

  if (appearance === "dark" || appearance === "light") return appearance
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function subscribeToTheme(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange)
  window.addEventListener(STORAGE_EVENT, onStoreChange)
  return () => {
    window.removeEventListener("storage", onStoreChange)
    window.removeEventListener(STORAGE_EVENT, onStoreChange)
  }
}

function applyPortalTheme(mode: PortalThemeMode): void {
  const root = document.querySelector<HTMLElement>("[data-portal-root]")
  root?.classList.toggle("dark", mode === "dark")
  root?.classList.toggle("light", mode === "light")
}

function ThemeToggleButton({
  mode,
  onToggle,
}: {
  mode: PortalThemeMode
  onToggle: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      data-portal-theme-toggle=""
      aria-label={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={mode === "dark"}
      onClick={onToggle}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
        "bg-muted text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {mode === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  )
}

function PersistedPortalThemeToggle({
  appearance,
}: {
  appearance: PortalTheme["appearance"]
}): React.ReactElement {
  const mode = useSyncExternalStore(
    subscribeToTheme,
    () => getThemeSnapshot(appearance),
    () => initialMode(appearance),
  )

  useEffect(() => {
    applyPortalTheme(mode)
  }, [mode])

  function toggleTheme(): void {
    const next = mode === "dark" ? "light" : "dark"
    window.localStorage.setItem(STORAGE_KEY, next)
    window.dispatchEvent(new Event(STORAGE_EVENT))
    applyPortalTheme(next)
  }

  return <ThemeToggleButton mode={mode} onToggle={toggleTheme} />
}

function PreviewPortalThemeToggle({
  initialMode,
}: {
  initialMode: PortalPreviewThemeMode
}): React.ReactElement {
  const [mode, setMode] = useState<PortalThemeMode>(initialMode)

  useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return
      if (!isPortalPreviewThemeMessage(event.data)) return
      setMode(event.data.mode)
    }

    window.addEventListener("message", handleMessage)
    // The editor may have changed appearance while the iframe was loading. Ask
    // it to replay the current mode after this listener is ready.
    window.parent.postMessage(
      createPortalPreviewThemeReadyMessage(),
      window.location.origin,
    )
    return () => window.removeEventListener("message", handleMessage)
  }, [])

  useEffect(() => {
    applyPortalTheme(mode)
  }, [mode])

  function toggleTheme(): void {
    const next = mode === "dark" ? "light" : "dark"
    setMode(next)
    applyPortalTheme(next)
    window.parent.postMessage(
      createPortalPreviewThemeMessage(next),
      window.location.origin,
    )
  }

  return <ThemeToggleButton mode={mode} onToggle={toggleTheme} />
}

/** Theme owned by the caller (the builder's frame), not storage or a parent window. */
export interface PortalThemeControl {
  mode: PortalThemeMode
  onChange: (mode: PortalThemeMode) => void
}

export function PortalThemeToggle({
  appearance,
  previewMode,
  control,
}: {
  appearance: PortalTheme["appearance"]
  previewMode?: PortalPreviewThemeMode
  control?: PortalThemeControl
}): React.ReactElement {
  if (control) {
    return (
      <ThemeToggleButton
        mode={control.mode}
        onToggle={() =>
          control.onChange(control.mode === "dark" ? "light" : "dark")
        }
      />
    )
  }

  if (previewMode) {
    return <PreviewPortalThemeToggle initialMode={previewMode} />
  }

  return (
    <PersistedPortalThemeToggle appearance={appearance} />
  )
}
