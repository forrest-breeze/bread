import "server-only"

/**
 * Settings search — server-only hybrid (keyword + cosine).
 *
 * Imports the committed catalog embeddings JSON, which is large enough
 * (~230 KB across 10 vectors × 768 dims) that we don't want it in the
 * client bundle. The keyword path lives in the sibling `settings-search.ts`
 * file which any "use client" component can import freely.
 */

import {
  SETTINGS_CATALOG,
  SETTINGS_MATCH_LIMIT,
  SETTINGS_SEMANTIC_THRESHOLD,
} from "./settings-catalog"
import {
  KEYWORD_HIT_SCORE,
  KEYWORD_TIEBREAKER_WEIGHT,
  MIN_QUERY_LENGTH,
  cosineSim,
  keywordMatch,
  resolveHighlight,
  type SettingsMatch,
} from "./settings-search"
import embeddingsJson from "./settings-catalog.embeddings.json"

interface PersistedCatalogEmbedding {
  id: string
  embedding: number[]
}

interface PersistedEmbeddings {
  catalog: { entries: PersistedCatalogEmbedding[] }
}

const persisted = embeddingsJson as unknown as PersistedEmbeddings

// Build the (id → embedding) lookup once at module load.
const CATALOG_EMBEDDINGS: ReadonlyMap<string, number[]> = (() => {
  const m = new Map<string, number[]>()
  for (const e of persisted.catalog.entries) {
    m.set(e.id, e.embedding)
  }
  return m
})()

/**
 * Server-side hybrid search — keyword path + semantic cosine. Pass
 * `queryEmbedding=null` to degrade to keyword-only (e.g., when the
 * Gemini embed call failed).
 */
export function searchSettingsHybrid(
  query: string,
  queryEmbedding: number[] | null,
): SettingsMatch[] {
  const q = query.trim().toLowerCase()
  if (q.length < MIN_QUERY_LENGTH) return []

  const matches: SettingsMatch[] = []
  for (const entry of SETTINGS_CATALOG) {
    const { matched, matchedKeyword } = keywordMatch(q, entry)
    let cosine = 0
    if (queryEmbedding) {
      const catalogEmbedding = CATALOG_EMBEDDINGS.get(entry.id)
      if (catalogEmbedding) {
        cosine = cosineSim(queryEmbedding, catalogEmbedding)
      }
    }
    const score = matched
      ? KEYWORD_HIT_SCORE + KEYWORD_TIEBREAKER_WEIGHT * Math.max(0, cosine)
      : cosine
    // Keyword hits always pass (score ≥ 0.95). Pure-semantic hits must clear
    // a higher bar so off-topic queries don't pull in loosely-related entries.
    if (!matched && score < SETTINGS_SEMANTIC_THRESHOLD) continue

    matches.push({
      entry,
      score,
      matchedKeyword,
      highlight: resolveHighlight(q, entry),
    })
  }

  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const ai = SETTINGS_CATALOG.findIndex((e) => e.id === a.entry.id)
    const bi = SETTINGS_CATALOG.findIndex((e) => e.id === b.entry.id)
    return ai - bi
  })

  return matches.slice(0, SETTINGS_MATCH_LIMIT)
}
