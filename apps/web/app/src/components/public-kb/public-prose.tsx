"use client"

import { forwardRef, useCallback, useEffect, useRef } from "react"
import { enhanceCodeGroups } from "@/lib/enhance-code-groups"
import { enhanceDocumentTabs } from "@/lib/enhance-document-tabs"
import { cn } from "@/lib/utils"
import { renderMathInElement } from "@/components/app/editor/math-extension"
import { mountMermaidInElement } from "@/components/app/editor/mermaid-extension"
import { CodeCopyButtons } from "@/components/public-kb/code-copy-buttons"
import "@/styles/document-blocks.css"

interface PublicProseProps {
  /** ALREADY server-sanitized HTML (see `renderPublicHtml`). Not re-sanitized. */
  html: string
  className?: string
}

/**
 * Public document-body display island. The HTML is sanitized server-side
 * (jsdom + Shiki highlighting) before it reaches this component, so it renders
 * identically during SSR and hydration (good for SEO) and only adds client
 * behaviour after mount: KaTeX math rendering and copy buttons on code blocks.
 * Styled with the roomier docs reading scale (`portal-docs-prose`); a forwarded
 * ref lets the reader attach a TOC. Pass `className` to compose extra layout.
 */
export const PublicProse = forwardRef<HTMLDivElement, PublicProseProps>(
  function PublicProse({ html, className }, ref) {
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
      const cleanupCodeGroups = enhanceCodeGroups(localRef.current)
      return () => {
        cleanupCodeGroups()
        cleanupTabs()
        cleanupMermaid()
      }
    }, [html])

    return (
      <>
        <div
          ref={setRefs}
          data-mermaid-host=""
          className={cn("portal-docs-prose", className)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <CodeCopyButtons containerRef={localRef} htmlKey={html} />
      </>
    )
  },
)
