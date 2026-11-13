"use client"

import { forwardRef, useCallback, useEffect, useRef } from "react"
import { enhanceDocumentTabs } from "@/lib/enhance-document-tabs"
import { cn } from "@/lib/utils"
import { renderDocumentHtml } from "@/lib/render-document-html"
import { renderMathInElement } from "@/components/app/editor/math-extension"
import { mountMermaidInElement } from "@/components/app/editor/mermaid-extension"
import "@/styles/document-blocks.css"

interface KbProseProps {
  content: string
  className?: string
}

/**
 * Read-only document body renderer for the knowledge-base portal. Renders the
 * stored (sanitized) HTML using the shared `.breezify-editor` typography, then
 * upgrades any LaTeX nodes via KaTeX — the consumption-side counterpart to the
 * editor's `RichContentPreview`, minus the bordered ScrollArea chrome so the
 * page itself scrolls.
 */
export const KbProse = forwardRef<HTMLDivElement, KbProseProps>(
  function KbProse({ content, className }, ref) {
    const localRef = useRef<HTMLDivElement | null>(null)

    const setRefs = useCallback(
      (node: HTMLDivElement | null) => {
        localRef.current = node
        if (typeof ref === "function") ref(node)
        else if (ref) ref.current = node
      },
      [ref],
    )

    useEffect(() => {
      if (!localRef.current) return
      void renderMathInElement(localRef.current)
      const cleanupMermaid = mountMermaidInElement(localRef.current)
      const cleanupTabs = enhanceDocumentTabs(localRef.current)
      return () => {
        cleanupTabs()
        cleanupMermaid()
      }
    }, [content])

    return (
      <div
        ref={setRefs}
        data-mermaid-host=""
        className={cn("breezify-editor", className)}
        dangerouslySetInnerHTML={{ __html: renderDocumentHtml(content) }}
      />
    )
  },
)
