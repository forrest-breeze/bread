"use client"

import type { RefObject } from "react"
import { cn } from "@/lib/utils"
import { findDocumentHeading, type DocumentHeading } from "@/hooks/use-document-headings"

interface KbReadingTocProps {
  headings: DocumentHeading[]
  activeId: string | null
  containerRef: RefObject<HTMLElement | null>
  className?: string
  variant?: "default" | "docs"
}

/**
 * "On this page" table-of-contents for the document reader. Headings come from
 * the rendered body (see `useDocumentHeadings`); clicking scrolls to the
 * matching node inside the content container.
 */
export function KbReadingToc({
  headings,
  activeId,
  containerRef,
  className,
  variant = "default",
}: KbReadingTocProps): React.ReactElement | null {
  if (headings.length === 0) return null

  const minLevel = Math.min(...headings.map((h) => h.level))

  const scrollTo = (id: string): void => {
    const target = containerRef.current ? findDocumentHeading(containerRef.current, id) : undefined
    target?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const isDocs = variant === "docs"

  return (
    <nav aria-label="On this page" className={cn("text-sm", className)}>
      <p
        className={cn(
          "mb-2 text-xs font-semibold uppercase text-muted-foreground",
          isDocs ? "tracking-[0.08em]" : "tracking-wider",
        )}
      >
        On this page
      </p>
      <ul className="border-l border-border">
        {headings.map((heading) => (
          <li key={heading.id}>
            <button
              type="button"
              onClick={() => scrollTo(heading.id)}
              aria-current={activeId === heading.id ? "location" : undefined}
              style={{
                paddingLeft: `${(heading.level - minLevel) * 12 + 12}px`,
              }}
              className={cn(
                "-ml-px block w-full truncate rounded-r-md border-l py-1 pr-2 text-left text-[13px] leading-snug transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                activeId === heading.id
                  ? isDocs
                    ? "border-foreground bg-transparent font-semibold text-foreground"
                    : "border-primary bg-primary/10 font-medium text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
                isDocs && "py-1.5",
              )}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
