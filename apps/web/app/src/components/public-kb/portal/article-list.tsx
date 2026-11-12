import { ArrowRight } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { PortalIcon } from "./portal-icon"
import type { ArticleItem, ArticleListBlock } from "@/lib/portal/schema"

// A titled list of article links (e.g. "Trending Articles") inside a bordered
// card. Server component; rows are HoverPrefetchLink islands.
//
// The "changelog" variant renders the same items as a dated release feed:
// entries sorted newest-first and grouped under month headers, each row
// carrying its entry date. Items without a parseable date sort last under an
// "Earlier" group.
export function ArticleList({
  block,
}: {
  block: ArticleListBlock
}): React.ReactElement | null {
  if (block.items.length === 0) return null
  if (block.variant === "changelog") return <ChangelogList block={block} />

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      {block.title && (
        <div className="flex items-center gap-2 border-b border-border/70 px-5 py-4 text-sm font-medium text-muted-foreground">
          <PortalIcon name="file-text" className="size-4 text-muted-foreground/50" />
          <span>{block.title}</span>
        </div>
      )}
      <ul>
        {block.items.map((item) => (
          <li key={item.id} className="border-b border-border/50 last:border-b-0">
            <HoverPrefetchLink
              href={item.href}
              className="group flex items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-muted/35"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground/85">
                {item.title}
              </span>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
            </HoverPrefetchLink>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Fixed locale + UTC so server and client render identical strings.
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

function parseEntryDate(item: ArticleItem): Date | null {
  if (!item.date) return null
  const parsed = new Date(item.date)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function groupEntriesByMonth(
  items: ArticleItem[],
): Array<{ label: string; entries: Array<{ item: ArticleItem; date: Date | null }> }> {
  const dated = items
    .map((item) => ({ item, date: parseEntryDate(item) }))
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))

  const groups: Array<{
    label: string
    entries: Array<{ item: ArticleItem; date: Date | null }>
  }> = []
  for (const entry of dated) {
    const label = entry.date ? MONTH_FORMAT.format(entry.date) : "Earlier"
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }
  return groups
}

function ChangelogList({ block }: { block: ArticleListBlock }): React.ReactElement {
  const groups = groupEntriesByMonth(block.items)

  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.label}>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {group.label}
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
            <ul>
              {group.entries.map(({ item, date }) => (
                <li key={item.id} className="border-b border-border/50 last:border-b-0">
                  <HoverPrefetchLink
                    href={item.href}
                    className="group flex items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-muted/35"
                  >
                    <span className="flex min-w-0 flex-1 items-baseline gap-3">
                      {date && (
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
                          {DAY_FORMAT.format(date)}
                        </span>
                      )}
                      <span className="min-w-0 truncate text-sm text-foreground/85">
                        {item.title}
                      </span>
                    </span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
                  </HoverPrefetchLink>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}
    </div>
  )
}
