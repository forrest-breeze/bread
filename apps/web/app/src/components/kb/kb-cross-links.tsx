"use client"

import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { SourceLogo } from "@/components/ui/source-logo"
import { cn } from "@/lib/utils"
import type { DocumentLinkEntry, DocumentLinkStrength } from "@/lib/types"

interface KbCrossLinksProps {
  outbound: DocumentLinkEntry[]
  inbound: DocumentLinkEntry[]
  /** Builds the link target for a referenced document. Defaults to the
   *  authenticated reader; the public site overrides it with /p/<slug>/doc. */
  hrefForDoc?: (id: string) => string
  className?: string
}

const defaultHrefForDoc = (id: string): string => `/kb/doc/${id}`

const OUTBOUND_GROUPS: ReadonlyArray<{
  strength: DocumentLinkStrength
  label: string
}> = [
  { strength: "supersedes", label: "Supersedes" },
  { strength: "duplicate_of", label: "Duplicates" },
  { strength: "related", label: "Related" },
]

function LinkRow({
  entry,
  hrefForDoc,
}: {
  entry: DocumentLinkEntry
  hrefForDoc: (id: string) => string
}): React.ReactElement {
  return (
    <li>
      <HoverPrefetchLink
        href={hrefForDoc(entry.id)}
        className="group -mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-muted"
      >
        <SourceLogo
          source={entry.source}
          size={14}
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate text-muted-foreground group-hover:text-foreground">
          {entry.title || "Untitled"}
        </span>
      </HoverPrefetchLink>
    </li>
  )
}

/**
 * Renders a document's sweep-discovered connections: outbound relationships
 * (supersedes / duplicates / related) and inbound backlinks ("referenced by").
 * Returns null when the document has no visible connections.
 */
export function KbCrossLinks({
  outbound,
  inbound,
  hrefForDoc = defaultHrefForDoc,
  className,
}: KbCrossLinksProps): React.ReactElement | null {
  const groups: Array<{
    key: string
    label: string
    entries: DocumentLinkEntry[]
  }> = OUTBOUND_GROUPS.map((group) => ({
    key: group.strength as string,
    label: group.label,
    entries: outbound.filter((entry) => entry.strength === group.strength),
  })).filter((group) => group.entries.length > 0)

  if (inbound.length > 0) {
    groups.push({ key: "inbound", label: "Referenced by", entries: inbound })
  }

  if (groups.length === 0) return null

  return (
    <nav aria-label="Connections" className={cn("text-sm", className)}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Connections
      </p>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.key}>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {group.label}
            </p>
            <ul>
              {group.entries.map((entry) => (
                <LinkRow
                  key={`${group.key}-${entry.id}`}
                  entry={entry}
                  hrefForDoc={hrefForDoc}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}
