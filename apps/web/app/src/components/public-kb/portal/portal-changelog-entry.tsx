import { ChevronLeft, ChevronRight } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { PublicProse } from "@/components/public-kb/public-prose"
import { PortalDocumentScrollReset } from "@/components/public-kb/portal/portal-document-scroll-reset"
import type { ChangelogNeighbor, ChangelogNeighbors } from "@/lib/portal/changelog-entry"

// Fixed locale + UTC so the server and client render identical strings (same
// contract as the changelog feed's date formatting).
const ENTRY_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
})

interface PortalChangelogEntryProps {
  documentId: string
  title: string
  /** Pre-sanitized HTML body (server-rendered via renderPublicHtml). */
  html: string
  /** Raw ISO timestamp of the release; omitted or unparseable hides the date. */
  date?: string
  /** Where the feed this entry belongs to lives, and what it is called. */
  feedHref: string
  feedLabel: string
  neighbors: ChangelogNeighbors
}

/**
 * A single changelog release. Deliberately unlike the docs reader: no docs
 * rail, no reading ToC, no reading-order pager — a changelog is a feed, so the
 * entry carries only its date, its body, and the releases on either side of it.
 * The date sits in a sticky left column on wide screens, the way a dated feed
 * reads, and stacks above the title on narrow ones.
 */
export function PortalChangelogEntry({
  documentId,
  title,
  html,
  date,
  feedHref,
  feedLabel,
  neighbors,
}: PortalChangelogEntryProps): React.ReactElement {
  const parsed = date ? new Date(date) : null
  const published = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null

  return (
    <article className="mx-auto w-full max-w-[62rem] px-6 py-12 sm:px-8 lg:py-16">
      <PortalDocumentScrollReset documentId={documentId} />
      <HoverPrefetchLink
        href={feedHref}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {feedLabel}
      </HoverPrefetchLink>

      <div className="mt-8 lg:grid lg:grid-cols-[9.5rem_minmax(0,1fr)] lg:gap-12">
        <div className="lg:sticky lg:top-24 lg:self-start">
          {published ? (
            <time
              dateTime={published.toISOString()}
              className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground"
            >
              {ENTRY_DATE_FORMAT.format(published)}
            </time>
          ) : null}
        </div>

        <div className="min-w-0">
          <h1 className="text-[32px] font-semibold leading-[1.15] tracking-tight text-foreground">
            {title || "Untitled"}
          </h1>
          <PublicProse html={html} className="mt-8" />

          {neighbors.newer || neighbors.older ? (
            <nav
              aria-label="Changelog navigation"
              className="mt-16 grid gap-3 border-t border-border/70 pt-6 sm:grid-cols-2"
            >
              {neighbors.newer ? (
                <NeighborCard link={neighbors.newer} direction="newer" />
              ) : (
                <span aria-hidden className="hidden sm:block" />
              )}
              {neighbors.older ? (
                <NeighborCard link={neighbors.older} direction="older" />
              ) : null}
            </nav>
          ) : null}
        </div>
      </div>
    </article>
  )
}

function NeighborCard({
  link,
  direction,
}: {
  link: ChangelogNeighbor
  direction: "newer" | "older"
}): React.ReactElement {
  const older = direction === "older"
  return (
    <HoverPrefetchLink
      href={link.href}
      className={`group flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/35 ${
        older ? "sm:items-end sm:text-right" : ""
      }`}
    >
      <span className="flex items-center gap-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {older ? null : <ChevronLeft className="size-3" />}
        {older ? "Older" : "Newer"}
        {older ? <ChevronRight className="size-3" /> : null}
      </span>
      <span className="line-clamp-1 text-sm font-medium text-foreground/85 transition-colors group-hover:text-foreground">
        {link.title}
      </span>
    </HoverPrefetchLink>
  )
}
