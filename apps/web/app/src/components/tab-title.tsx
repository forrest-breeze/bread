"use client"

import { useEffect } from "react"

export function TabTitle({ title }: { title: string }): null {
  useEffect(() => {
    if (typeof document === "undefined") return
    const trimmed = title.trim()
    if (!trimmed) return
    document.title = trimmed
  }, [title])
  return null
}
