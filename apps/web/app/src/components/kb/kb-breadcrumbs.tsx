"use client"

import { ChevronRight } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { cn } from "@/lib/utils"

export interface KbBreadcrumbItem {
  label: string
  href?: string
}

interface KbBreadcrumbsProps {
  items: KbBreadcrumbItem[]
  className?: string
}

/**
 * Hierarchical breadcrumb trail for the read portal. The last item is rendered
 * as the current page (non-link); earlier items link when an `href` is given.
 */
export function KbBreadcrumbs({
  items,
  className,
}: KbBreadcrumbsProps): React.ReactElement {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex items-center text-xs text-muted-foreground", className)}
    >
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, index) => {
          const isLast = index === items.length - 1
          return (
            <li
              key={item.href ?? `__current__:${item.label}`}
              className="flex min-w-0 items-center gap-1"
            >
              {item.href && !isLast ? (
                <HoverPrefetchLink
                  href={item.href}
                  className="max-w-[16rem] truncate rounded-sm transition-colors hover:text-foreground"
                >
                  {item.label}
                </HoverPrefetchLink>
              ) : (
                <span
                  className={cn(
                    "max-w-[20rem] truncate",
                    isLast && "font-medium text-foreground",
                  )}
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isLast && (
                <ChevronRight className="size-3 shrink-0 opacity-50" />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
