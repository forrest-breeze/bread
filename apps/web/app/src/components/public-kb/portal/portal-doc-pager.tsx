import { ChevronLeft, ChevronRight } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export interface PagerLink {
  label: string
  href: string
}

export interface DocPagerLinks {
  prev: PagerLink | null
  next: PagerLink | null
}

/**
 * Previous / Next document cards shown at the bottom of a docs-template page.
 * Order is derived from the portal sidebar's reading sequence (see
 * PortalDocView). Renders nothing when neither neighbor exists. Card titles
 * clamp to one line, so each card carries a tooltip with the full title.
 */
export function PortalDocPager({ prev, next }: DocPagerLinks): React.ReactElement | null {
  if (!prev && !next) return null
  return (
    <TooltipProvider delay={250}>
      <nav
        aria-label="Document navigation"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        {prev ? (
          <PagerCard link={prev} direction="prev" />
        ) : (
          <span aria-hidden className="hidden sm:block" />
        )}
        {next ? <PagerCard link={next} direction="next" /> : null}
      </nav>
    </TooltipProvider>
  )
}

function PagerCard({
  link,
  direction,
}: {
  link: PagerLink
  direction: "prev" | "next"
}): React.ReactElement {
  const isNext = direction === "next"
  const card = (
    <HoverPrefetchLink
      href={link.href}
      className="group flex flex-col gap-2 rounded-xl border border-border p-5 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={
          isNext
            ? "truncate text-right text-base font-semibold text-foreground"
            : "truncate text-base font-semibold text-foreground"
        }
      >
        {link.label}
      </span>
      <span
        className={
          isNext
            ? "flex items-center justify-end gap-1 text-sm text-muted-foreground"
            : "flex items-center gap-1 text-sm text-muted-foreground"
        }
      >
        {!isNext && <ChevronLeft className="size-4" />}
        {isNext ? "Next" : "Previous"}
        {isNext && <ChevronRight className="size-4" />}
      </span>
    </HoverPrefetchLink>
  )
  return (
    <Tooltip>
      <TooltipTrigger render={card} />
      <TooltipContent side="top">
        {isNext ? "Next" : "Previous"}: {link.label}
      </TooltipContent>
    </Tooltip>
  )
}
