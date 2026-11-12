import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PortalIcon } from "./portal-icon"
import type { SidebarGroup } from "@/lib/portal/schema"
import { cn } from "@/lib/utils"

// Count the documents reachable inside a section (its own items plus nested
// child groups) for the pill tooltips.
function countSectionDocs(group: SidebarGroup): number {
  let total = group.items.length
  for (const child of group.children ?? []) total += countSectionDocs(child)
  return total
}

/**
 * Horizontal quick-nav of the portal's top-level sections, rendered on folder
 * pages so visitors can hop between sections without scanning the sidebar (and
 * on mobile, where the sidebar rail is hidden entirely). Each pill carries the
 * section's brand glyph; a tooltip surfaces its document count. Renders nothing
 * when there's only one section — nothing to navigate between.
 */
export function PortalSectionNav({
  groups,
  currentId,
}: {
  groups: SidebarGroup[]
  /** The folder id of the page being viewed — its pill renders as active. */
  currentId?: string
}): React.ReactElement | null {
  const sections = groups.filter((group) => group.href)
  if (sections.length < 2) return null

  return (
    <TooltipProvider delay={250}>
      <nav aria-label="Portal sections" className="flex flex-wrap gap-2">
        {sections.map((group) => {
          const active = group.id === currentId
          const docCount = countSectionDocs(group)
          const pill = (
            <HoverPrefetchLink
              href={group.href!}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex max-w-56 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
                active
                  ? "border-transparent text-white"
                  : "border-border bg-card text-muted-foreground hover:border-foreground/25 hover:text-foreground",
              )}
              style={
                active ? { backgroundColor: "var(--portal-accent)" } : undefined
              }
            >
              <PortalIcon name={group.icon} className="size-3.5 shrink-0" />
              <span className="truncate">{group.label}</span>
            </HoverPrefetchLink>
          )
          return (
            <Tooltip key={group.id}>
              <TooltipTrigger render={pill} />
              <TooltipContent side="bottom">
                {group.label} · {docCount} document{docCount === 1 ? "" : "s"}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
    </TooltipProvider>
  )
}
