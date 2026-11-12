"use client"

import { useCallback, useRef, useState, useEffect, type RefCallback } from "react"

interface UseResizableOptions {
  initialWidth: number
  minWidth?: number
  maxWidth?: number
  onWidthChange?: (width: number) => void
}

export function useResizable({
  initialWidth,
  minWidth = 200,
  maxWidth = 500,
  onWidthChange,
}: UseResizableOptions): {
  handleRef: RefCallback<HTMLDivElement>
  isDragging: boolean
} {
  const [handleElement, setHandleElement] = useState<HTMLDivElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const handleRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setHandleElement(node)
  }, [])

  // Store mutable values in refs to avoid stale closures
  const stateRef = useRef({
    startX: 0,
    startWidth: initialWidth,
    minWidth,
    maxWidth,
    onWidthChange,
  })

  // Keep ref in sync with latest props
  useEffect(() => {
    stateRef.current.minWidth = minWidth
    stateRef.current.maxWidth = maxWidth
    stateRef.current.onWidthChange = onWidthChange
  })

  // Keep startWidth in sync when not dragging
  useEffect(() => {
    if (!isDragging) {
      stateRef.current.startWidth = initialWidth
    }
  }, [initialWidth, isDragging])

  useEffect(() => {
    const handle = handleElement
    if (!handle) return

    const onMouseMove = (e: MouseEvent) => {
      const { startX, startWidth, minWidth: min, maxWidth: max, onWidthChange: cb } = stateRef.current
      const delta = e.clientX - startX
      const newWidth = Math.min(max, Math.max(min, startWidth + delta))
      cb?.(newWidth)
    }

    const onMouseUp = () => {
      setIsDragging(false)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      stateRef.current.startX = e.clientX
      setIsDragging(true)
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
      document.addEventListener("mousemove", onMouseMove)
      document.addEventListener("mouseup", onMouseUp)
    }

    handle.addEventListener("mousedown", onMouseDown)
    return () => {
      handle.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
  }, [handleElement])

  return { handleRef, isDragging }
}
