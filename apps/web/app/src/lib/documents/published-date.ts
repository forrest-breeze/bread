/**
 * Publication date for a document, stored in `documents.source_metadata`.
 *
 * Dated feeds — changelog pages — need "when this was published",
 * which is NOT `updated_at`. Fixing a typo in a release note legitimately
 * changes when the row was last touched; it must not move the entry to the top
 * of the feed or re-date it.
 *
 * It lives in the metadata jsonb rather than in its own column because only
 * dated documents have one. `source_metadata` is already the sparse
 * per-document bag for exactly this kind of field (`blog_cover` sits beside
 * it), so a date here costs nothing for the documents that don't have one.
 */

export const PUBLISHED_DATE_KEY = "published_date"

/**
 * Coerce a value into the ISO form stored and emitted everywhere else. Postgres
 * hands timestamps back as "2026-08-17 17:00:00+00", which is not the shape the
 * GitHub frontmatter validator accepts, so normalizing at the boundary keeps a
 * file Breezify writes parseable by Breezify.
 */
export function normalizePublishedDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** The stored publication date as an ISO string, or null when unset/invalid. */
export function readPublishedDate(sourceMetadata: unknown): string | null {
  if (typeof sourceMetadata !== "object" || sourceMetadata === null) return null
  const raw = (sourceMetadata as Record<string, unknown>)[PUBLISHED_DATE_KEY]
  return normalizePublishedDate(raw)
}

/**
 * The date a dated feed should use: the explicit publication date when the
 * document has one, otherwise `updated_at`. The fallback is what lets existing
 * documents keep working before anything has written a publication date.
 */
export function resolveFeedDate(input: {
  publishedAt?: string | null
  updatedAt?: string | null
}): string | null {
  return (
    normalizePublishedDate(input.publishedAt) ??
    normalizePublishedDate(input.updatedAt)
  )
}
