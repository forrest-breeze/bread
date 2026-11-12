"use client"

import { useCallback, useEffect, useRef } from "react"

interface UseHoverIntentOptions {
  /** Milliseconds to wait before firing onIntent. Defaults to 80. */
  delayMs?: number
  /** Callback fired when the user hovers long enough. */
  onIntent: () => void
}

interface UseHoverIntentReturn {
  onMouseEnter: () => void
  onMouseLeave: () => void
}

/**
 * Fires `onIntent` after the cursor has rested on an element for at least
 * `delayMs` milliseconds. If the cursor leaves before the timer fires the
 * intent is cancelled. The timer is cleared on unmount.
 */
export function useHoverIntent({
  delayMs = 80,
  onIntent,
}: UseHoverIntentOptions): UseHoverIntentReturn {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onIntentRef = useRef(onIntent)

  // Keep the ref current so the timeout callback always calls the latest
  // version of onIntent without needing it in the dep array.
  useEffect(() => {
    onIntentRef.current = onIntent
  }, [onIntent])

  // Clear any pending timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  const onMouseEnter = useCallback(() => {
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      onIntentRef.current()
    }, delayMs)
  }, [delayMs])

  const onMouseLeave = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  return { onMouseEnter, onMouseLeave }
}
