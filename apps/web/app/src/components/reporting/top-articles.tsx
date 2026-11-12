import { ArrowUpRight } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import type { PortalTopArticle } from "@/lib/portal/analytics-types"

interface TopArticlesProps {
  articles: PortalTopArticle[]
  /** When viewing a single portal, link each article to its public page. */
  portalSlug?: string | null
  loading?: boolean
}

export function TopArticles({
  articles,
  portalSlug,
  loading,
}: TopArticlesProps): React.ReactElement {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    )
  }

  if (articles.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No article views in this period yet.
      </p>
    )
  }

  return (
    <ol className="divide-y divide-border/60">
      {articles.map((article, index) => {
        const href = portalSlug
          ? `/p/${portalSlug}/doc/${article.slug ?? article.documentId}`
          : null
        return (
          <li
            key={article.documentId}
            className="flex items-center gap-3 py-2.5"
          >
            <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex max-w-full items-center gap-1 truncate text-sm font-medium text-foreground hover:text-primary"
                >
                  <span className="truncate">{article.title}</span>
                  <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              ) : (
                <span className="block truncate text-sm font-medium text-foreground">
                  {article.title}
                </span>
              )}
            </div>
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {article.views.toLocaleString()}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
