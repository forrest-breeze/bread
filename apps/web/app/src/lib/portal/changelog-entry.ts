import type { PublicDocSummary } from "@/lib/public-kb"
import { resolveFeedDate } from "@/lib/documents/published-date"

export interface ChangelogNeighbor {
  title: string
  href: string
}

export interface ChangelogNeighbors {
  /** The entry published after this one (up the feed). */
  newer: ChangelogNeighbor | null
  /** The entry published before this one (down the feed). */
  older: ChangelogNeighbor | null
}

function entryTime(doc: PublicDocSummary): number {
  // The publication date wins over `updated_at`: editing a release note is a
  // modification, not a re-release, and must not move it up the feed.
  const date = resolveFeedDate({
    publishedAt: doc.published_at,
    updatedAt: doc.updated_at,
  })
  if (!date) return 0
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime()
}

/**
 * Feed order for a changelog: newest first, undated entries last. Mirrors the
 * grouping in ArticleList's changelog variant (and drops READMEs the same way
 * the feed does) so an entry's neighbors match the list a reader came from.
 */
export function sortChangelogDocs<T extends PublicDocSummary>(docs: T[]): T[] {
  return [...docs].sort(
    (left, right) => entryTime(right) - entryTime(left),
  )
}

/** Adjacent releases in feed order, or nulls when the doc isn't in the feed. */
export function changelogNeighbors(
  docs: PublicDocSummary[],
  currentDocId: string,
  hrefFor: (doc: PublicDocSummary) => string,
): ChangelogNeighbors {
  const ordered = sortChangelogDocs(docs)
  const index = ordered.findIndex((doc) => doc.id === currentDocId)
  if (index === -1) return { newer: null, older: null }
  const newer = index > 0 ? ordered[index - 1] : null
  const older = index < ordered.length - 1 ? ordered[index + 1] : null
  return {
    newer: newer ? { title: newer.title || "Untitled", href: hrefFor(newer) } : null,
    older: older ? { title: older.title || "Untitled", href: hrefFor(older) } : null,
  }
}
