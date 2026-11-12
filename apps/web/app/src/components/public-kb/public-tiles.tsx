import { ArrowRight } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { SourceLogo } from "@/components/ui/source-logo"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PortalIcon } from "@/components/public-kb/portal/portal-icon"
import { formatKbEditedLabel } from "@/components/kb/kb-date"

// Absolute date for tooltips over the relative "Edited …" labels.
function absoluteDateLabel(value: string | null | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

// Server-safe presentational leaves shared across the public KB pages. They
// render plain links (HoverPrefetchLink is a client island) so the pages
// themselves stay server components.

export function PublicSectionHeading({
  icon,
  label,
  count,
  id,
}: {
  icon: React.ReactNode
  label: string
  count?: number
  id?: string
}): React.ReactElement {
  return (
    <h2
      id={id}
      className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
    >
      {icon}
      {label}
      {typeof count === "number" && (
        <span className="text-muted-foreground/50">{count}</span>
      )}
    </h2>
  )
}

export function PublicFolderTile({
  href,
  kind,
  name,
  count,
  updatedAt,
  icon,
}: {
  href: string
  kind: "user" | "topic" | "system"
  name: string
  /** Optional doc count — omitted on portal surfaces, where counts proved misleading. */
  count?: number
  updatedAt?: string | null
  /** Layout-resolved icon name; falls back to the kind's default. */
  icon?: string
}): React.ReactElement {
  // Mirror the home's category cards: resolve the folder's authored icon (same
  // source the sidebar/home use), defaulting topics to `hash` and folders to
  // `folder` so inner pages share the root's iconography instead of one generic
  // glyph.
  const resolvedIcon = icon ?? (kind === "topic" ? "hash" : "folder")
  const editedLabel = formatKbEditedLabel(updatedAt)

  return (
    <HoverPrefetchLink
      href={href}
      className="group flex min-h-[104px] flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-colors hover:border-primary/35 hover:bg-muted/30"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-md"
          style={{
            backgroundColor: "color-mix(in srgb, var(--portal-accent) 10%, transparent)",
            color: "var(--portal-accent)",
          }}
        >
          <PortalIcon name={resolvedIcon} className="size-4.5" />
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-foreground">{name}</span>
        {(typeof count === "number" || editedLabel) && (
          <span className="truncate text-xs text-muted-foreground">
            {typeof count === "number" && (
              <>
                {count} document{count === 1 ? "" : "s"}
              </>
            )}
            {editedLabel && (
              <span className="text-muted-foreground/60">
                {typeof count === "number" ? " · " : ""}
                {editedLabel}
              </span>
            )}
          </span>
        )}
      </div>
    </HoverPrefetchLink>
  )
}

export function PublicDocList({
  items,
}: {
  items: Array<{
    id: string
    href: string
    title: string
    source: string | null
    updatedAt?: string | null
  }>
}): React.ReactElement {
  return (
    <TooltipProvider delay={250}>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/80 bg-card shadow-sm">
        {items.map((item) => {
          const editedLabel = formatKbEditedLabel(item.updatedAt)
          const editedDate = absoluteDateLabel(item.updatedAt)
          return (
            <li key={item.id}>
              <HoverPrefetchLink
                href={item.href}
                className="group flex items-center gap-3 bg-card px-4 py-2.5 transition-colors hover:bg-muted/50"
              >
                <SourceLogo
                  source={item.source}
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {item.title || "Untitled"}
                </span>
                {editedLabel &&
                  (editedDate ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="shrink-0 text-[11px] text-muted-foreground/70">
                            {editedLabel}
                          </span>
                        }
                      />
                      <TooltipContent side="left">
                        Last edited {editedDate}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted-foreground/70">
                      {editedLabel}
                    </span>
                  ))}
              </HoverPrefetchLink>
            </li>
          )
        })}
      </ul>
    </TooltipProvider>
  )
}
