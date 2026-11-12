"use client"

import { Search, X, Loader2 } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { SourceLogo } from "@/components/ui/source-logo"
import { useKnowledgeSearch, type KnowledgeSearchHit } from "@/hooks/swr"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"

// ---------------------------------------------------------------------------
// Search input
// ---------------------------------------------------------------------------
interface KbSearchBoxProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

export function KbSearchBox({
  value,
  onChange,
  placeholder = "Search the knowledge base…",
  autoFocus,
  className,
}: KbSearchBoxProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30",
        className,
      )}
    >
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label="Search the knowledge base"
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      {value.length > 0 && (
        <AppTooltip label="Clear search">
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </button>
        </AppTooltip>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------
function snippet(content: string | undefined): string {
  if (!content) return ""
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
}

function ResultRow({ hit }: { hit: KnowledgeSearchHit }): React.ReactElement {
  const preview = snippet(hit.content)
  return (
    <li>
      <HoverPrefetchLink
        href={`/kb/doc/${hit.id}`}
        className="group block rounded-lg border border-transparent px-3 py-2.5 -mx-3 transition-colors hover:border-border hover:bg-card"
      >
        <div className="flex items-center gap-2">
          <SourceLogo
            source={hit.source}
            size={15}
            className="shrink-0 text-muted-foreground"
          />
          <span className="truncate text-sm font-medium text-foreground">
            {hit.title || "Untitled"}
          </span>
        </div>
        {preview.length > 0 && (
          <p className="mt-1 line-clamp-2 pl-[23px] text-[13px] leading-snug text-muted-foreground">
            {preview}
          </p>
        )}
      </HoverPrefetchLink>
    </li>
  )
}

interface KbSearchResultsProps {
  query: string
  className?: string
}

export function KbSearchResults({
  query,
  className,
}: KbSearchResultsProps): React.ReactElement {
  const { data, isLoading, error } = useKnowledgeSearch(query)
  const results = data?.knowledge ?? []

  if (error) {
    return (
      <p className={cn("text-sm text-destructive", className)}>
        Search is unavailable right now. Please try again.
      </p>
    )
  }

  if (isLoading && results.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-sm text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="size-4 animate-spin" />
        Searching…
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        No documents match{" "}
        <span className="font-medium text-foreground">“{query}”</span>.
      </p>
    )
  }

  return (
    <div className={className}>
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {results.length} result{results.length === 1 ? "" : "s"}
      </p>
      <ul className="space-y-0.5">
        {results.map((hit) => (
          <ResultRow key={hit.id} hit={hit} />
        ))}
      </ul>
    </div>
  )
}
