import { ArrowRight } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import type { CategoryGridBlock } from "@/lib/portal/schema"
import { PortalIcon } from "./portal-icon"

// Grid of category cards (icon, title, description) linking to a folder, topic,
// or document. Server component; cards are HoverPrefetchLink islands.
//
// `variant="docs"` renders the compact row list used beside the sidebar; the
// default is the 2-col card grid (muted icon at the bottom).
export function CategoryGrid({
  block,
  variant,
}: {
  block: CategoryGridBlock
  variant?: "docs"
}): React.ReactElement | null {
  if (block.items.length === 0) return null

  if (variant === "docs") {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {block.items.map((item) => (
          <HoverPrefetchLink
            key={item.id}
            href={item.href}
            className="group flex min-h-20 items-center gap-4 border-b border-border/70 px-4 py-3.5 transition-colors last:border-b-0 hover:bg-muted/35 sm:px-5"
          >
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-md"
              style={{
                backgroundColor: "color-mix(in srgb, var(--portal-accent) 10%, transparent)",
                color: "var(--portal-accent)",
              }}
            >
              <PortalIcon name={item.icon} className="size-4.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {item.title}
              </span>
              {item.description && (
                <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
                  {item.description}
                </span>
              )}
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground/45 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </HoverPrefetchLink>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      {block.items.map((item) => (
        <HoverPrefetchLink
          key={item.id}
          href={item.href}
          className="group flex min-h-[156px] flex-col justify-end rounded-xl border border-border bg-card p-7 shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-colors hover:border-primary/35 hover:bg-muted/30"
        >
          <PortalIcon
            name={item.icon}
            className="mb-6 size-7 text-muted-foreground/60 transition-colors group-hover:text-foreground"
          />
          <span className="block truncate text-base font-semibold text-foreground">
            {item.title}
          </span>
          {item.description && (
            <span className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">
              {item.description}
            </span>
          )}
        </HoverPrefetchLink>
      ))}
    </div>
  )
}
