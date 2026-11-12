"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

interface UseUnsavedChangesGuardOptions {
  /** When true, in-app link navigation is intercepted and a prompt is shown. */
  enabled: boolean
  /**
   * Persist current changes to the server. Navigation proceeds once this
   * resolves, unless it resolves to `false` (e.g. the save failed), in which
   * case the prompt is dismissed and the user stays on the document.
   */
  onSave: () => Promise<boolean | void> | boolean | void
  /** Abandon current changes (clear draft + dirty flag) before navigation. */
  onDiscard: () => void
}

export interface UnsavedChangesGuard {
  /** Whether the "save before you go" prompt is open. */
  promptOpen: boolean
  /** Save, then navigate to the pending destination. */
  confirmLeave: () => Promise<void>
  /** Discard changes, then navigate to the pending destination. */
  discardLeave: () => void
  /** Dismiss the prompt and stay on the document. */
  cancelLeave: () => void
}

/**
 * Guards against losing unsaved edits when leaving the current document via an
 * in-app link (sidebar, folder views, search results). Next.js App Router has
 * no navigation-blocking API, so we intercept clicks on internal anchors in the
 * capture phase, stash the destination, and surface a confirmation prompt.
 *
 * Programmatic `router.push` calls (command palette, search-on-enter) bypass
 * this interceptor by design — those paths are covered by the editor's draft
 * fallback, which preserves work to localStorage on unmount so it can be
 * restored on the next visit. Tab close / refresh is handled separately by the
 * editor's `beforeunload` listener.
 */
export function useUnsavedChangesGuard({
  enabled,
  onSave,
  onDiscard,
}: UseUnsavedChangesGuardOptions): UnsavedChangesGuard {
  const router = useRouter()
  const [promptOpen, setPromptOpen] = useState(false)
  const pendingUrlRef = useRef<string | null>(null)

  // Keep callbacks fresh without re-installing the listener on every render.
  const onSaveRef = useRef(onSave)
  const onDiscardRef = useRef(onDiscard)
  /* eslint-disable react-hooks/refs */
  onSaveRef.current = onSave
  onDiscardRef.current = onDiscard
  /* eslint-enable react-hooks/refs */

  useEffect(() => {
    if (!enabled) return

    const handleClick = (event: MouseEvent): void => {
      if (event.defaultPrevented) return
      // Let modified clicks (open-in-new-tab, etc.) and non-primary buttons through.
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }

      const anchor = (event.target as HTMLElement | null)?.closest("a")
      if (!anchor) return

      const href = anchor.getAttribute("href")
      if (!href || href.startsWith("#")) return
      if (anchor.target && anchor.target !== "_self") return
      if (anchor.hasAttribute("download")) return

      let url: URL
      try {
        url = new URL(anchor.href, window.location.href)
      } catch {
        return
      }
      if (url.origin !== window.location.origin) return

      const current = window.location.pathname + window.location.search
      const next = url.pathname + url.search
      if (next === current) return

      // Intercept: hold the destination and prompt before leaving.
      event.preventDefault()
      event.stopPropagation()
      pendingUrlRef.current = url.pathname + url.search + url.hash
      setPromptOpen(true)
    }

    document.addEventListener("click", handleClick, true)
    return () => document.removeEventListener("click", handleClick, true)
  }, [enabled])

  const navigatePending = useCallback((): void => {
    const dest = pendingUrlRef.current
    pendingUrlRef.current = null
    setPromptOpen(false)
    if (dest) router.push(dest)
  }, [router])

  const confirmLeave = useCallback(async (): Promise<void> => {
    const result = await onSaveRef.current()
    if (result === false) {
      // Save failed — stay put so the user can see the error and retry.
      pendingUrlRef.current = null
      setPromptOpen(false)
      return
    }
    navigatePending()
  }, [navigatePending])

  const discardLeave = useCallback((): void => {
    onDiscardRef.current()
    navigatePending()
  }, [navigatePending])

  const cancelLeave = useCallback((): void => {
    pendingUrlRef.current = null
    setPromptOpen(false)
  }, [])

  return { promptOpen, confirmLeave, discardLeave, cancelLeave }
}
