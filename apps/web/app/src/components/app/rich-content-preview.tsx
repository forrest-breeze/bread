"use client"

import { useEffect, useRef } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { enhanceDocumentTabs } from "@/lib/enhance-document-tabs"
import { cn } from "@/lib/utils"
import { renderMathInElement } from "@/components/app/editor/math-extension"
import { mountMermaidInElement } from "@/components/app/editor/mermaid-extension"
import { renderDocumentHtml } from "@/lib/render-document-html"
import "@/styles/document-blocks.css"

interface RichContentPreviewProps {
  content: string
  className?: string
}

export function RichContentPreview({
  content,
  className,
}: RichContentPreviewProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containerRef.current) {
      void renderMathInElement(containerRef.current)
      const cleanupMermaid = mountMermaidInElement(containerRef.current)
      const cleanupTabs = enhanceDocumentTabs(containerRef.current)
      return () => {
        cleanupTabs()
        cleanupMermaid()
      }
    }
  }, [content])

  return (
    <ScrollArea className={cn("h-72 rounded border bg-muted/10", className)}>
      <div
        ref={containerRef}
        data-mermaid-host=""
        className="breezify-editor min-h-0 px-4 py-3"
        dangerouslySetInnerHTML={{ __html: renderDocumentHtml(content) }}
      />
    </ScrollArea>
  )
}
