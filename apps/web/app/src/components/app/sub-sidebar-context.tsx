"use client"

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react"
import { usePathname } from "next/navigation"

const STORAGE_KEY = "sub-sidebar-width"
const STORAGE_EVENT = "sub-sidebar-width-change"
const DEFAULT_WIDTH = 260
const MAX_WIDTH_RATIO = 0.75

interface SubSidebarContextValue {
  isOpen: boolean
  width: number
  setWidth: (width: number) => void
  toggle: () => void
  close: () => void
  activeSection: string | null
}

const SubSidebarContext = createContext<SubSidebarContextValue | null>(null)

function deriveSection(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean)
  const section = segments[0] ?? null
  if (section === "settings") {
    return segments[1] === "integrations" ? null : "settings"
  }
  if (section === "knowledge" || section === "kb") return "knowledge"
  if (section === "reporting") return "reporting"
  return null
}

function parseStoredWidth(stored: string | null): number {
  if (!stored) return DEFAULT_WIDTH

  const parsed = Number(stored)
  const maxWidth =
    typeof window === "undefined"
      ? 1200
      : Math.max(200, Math.floor(window.innerWidth * MAX_WIDTH_RATIO))
  if (!Number.isNaN(parsed) && parsed >= 200) {
    return Math.min(parsed, maxWidth)
  }

  return DEFAULT_WIDTH
}

function getWidthSnapshot(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH
  return parseStoredWidth(window.localStorage.getItem(STORAGE_KEY))
}

function subscribeToWidth(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange)
  window.addEventListener(STORAGE_EVENT, onStoreChange)

  return () => {
    window.removeEventListener("storage", onStoreChange)
    window.removeEventListener(STORAGE_EVENT, onStoreChange)
  }
}

export function SubSidebarProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const activeSection = deriveSection(pathname)

  const width = useSyncExternalStore(
    subscribeToWidth,
    getWidthSnapshot,
    () => DEFAULT_WIDTH
  )

  // Track which section was manually collapsed — resets automatically when section changes
  const [collapsedSection, setCollapsedSection] = useState<string | null>(null)

  const isManuallyCollapsed = collapsedSection !== null && collapsedSection === activeSection

  const setWidth = useCallback((w: number) => {
    window.localStorage.setItem(STORAGE_KEY, String(w))
    window.dispatchEvent(new Event(STORAGE_EVENT))
  }, [])

  const toggle = useCallback(() => {
    setCollapsedSection((prev) => prev !== null ? null : activeSection)
  }, [activeSection])

  const close = useCallback(() => {
    setCollapsedSection(activeSection)
  }, [activeSection])

  const isOpen = activeSection !== null && !isManuallyCollapsed

  const value = useMemo<SubSidebarContextValue>(
    () => ({ isOpen, width, setWidth, toggle, close, activeSection }),
    [isOpen, width, setWidth, toggle, close, activeSection]
  )

  return (
    <SubSidebarContext value={value}>
      {children}
    </SubSidebarContext>
  )
}

export function useSubSidebar(): SubSidebarContextValue {
  const ctx = useContext(SubSidebarContext)
  if (!ctx) {
    throw new Error("useSubSidebar must be used within SubSidebarProvider")
  }
  return ctx
}
