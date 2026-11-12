/**
 * Settings search — client-safe primitives.
 *
 * This file holds the keyword path, cosine helper, and highlight resolver.
 * It is safe to import from "use client" components — no server-only deps,
 * no embedding JSON. The full hybrid search (keyword + cosine over the
 * committed catalog embeddings) lives in `settings-search-server.ts` so
 * the client bundle never picks up the ~230 KB of vectors.
 */

import {
  SETTINGS_CATALOG,
  SETTINGS_MATCH_LIMIT,
  type SettingsEntry,
} from "./settings-catalog"

/**
 * Keyword-path score. Tied keyword hits are broken by cosine similarity
 * in the hybrid search; this constant is the floor.
 */
export const KEYWORD_HIT_SCORE = 0.95

/**
 * Tiebreaker weight for keyword hits in the hybrid path. Pure keyword
 * (no embedding) caps at KEYWORD_HIT_SCORE; with cosine, score sits in
 * [KEYWORD_HIT_SCORE, KEYWORD_HIT_SCORE + KEYWORD_TIEBREAKER_WEIGHT].
 */
export const KEYWORD_TIEBREAKER_WEIGHT = 0.04

/**
 * Minimum query length for either keyword OR semantic matching. Below
 * this, a single character would pseudo-match almost every entry; above
 * this, the noise floor is acceptable.
 */
export const MIN_QUERY_LENGTH = 2

export interface SettingsMatch {
  entry: SettingsEntry
  score: number
  /** Which keyword triggered the keyword-path hit, if any. */
  matchedKeyword?: string
  /** Where to render `<mark>` if the match has a visible substring. */
  highlight?: {
    field: "label" | "description"
    span: [number, number]
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity. Returns 0 (not NaN) when either operand is the zero
 * vector or when lengths don't match — defensive against malformed input.
 */
export function cosineSim(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---------------------------------------------------------------------------
// Highlight
// ---------------------------------------------------------------------------

/**
 * Locate `query` (or its first whitespace-separated token) in `text` and
 * return [start, end) for the first hit. Case-insensitive. Returns null
 * when `text` doesn't contain a usable substring of the query.
 *
 * Skips tokens shorter than `MIN_QUERY_LENGTH` to avoid false positives
 * (a one-character query would otherwise highlight nearly every label).
 */
export function findHighlight(
  query: string,
  text: string,
): [number, number] | null {
  const q = query.trim().toLowerCase()
  if (q.length < MIN_QUERY_LENGTH) return null
  const lowerText = text.toLowerCase()

  const fullIdx = lowerText.indexOf(q)
  if (fullIdx >= 0) return [fullIdx, fullIdx + q.length]

  const firstToken = q.split(/\s+/)[0] ?? ""
  if (firstToken.length < MIN_QUERY_LENGTH) return null
  const tokenIdx = lowerText.indexOf(firstToken)
  if (tokenIdx >= 0) return [tokenIdx, tokenIdx + firstToken.length]

  return null
}

// ---------------------------------------------------------------------------
// Keyword path
// ---------------------------------------------------------------------------

/**
 * Test whether `query` substring-matches any keyword on `entry`. The match
 * is bidirectional — either the keyword contains the query (typing-prefix
 * case) or the query contains the keyword (suffix-or-extension case).
 */
export function keywordMatch(
  query: string,
  entry: SettingsEntry,
): { matched: boolean; matchedKeyword?: string } {
  const q = query.trim().toLowerCase()
  if (q.length < MIN_QUERY_LENGTH) return { matched: false }

  for (const keyword of entry.keywords) {
    const k = keyword.toLowerCase()
    if (k.includes(q) || q.includes(k)) {
      return { matched: true, matchedKeyword: keyword }
    }
  }
  return { matched: false }
}

// ---------------------------------------------------------------------------
// Highlight resolution
// ---------------------------------------------------------------------------

/**
 * Decide where (if anywhere) to render `<mark>` for a matched entry. We
 * prefer label highlights over description highlights when both contain
 * the query — the label is what the user reads first. The matched keyword
 * itself isn't displayed, so we don't try to highlight it directly.
 */
export function resolveHighlight(
  query: string,
  entry: SettingsEntry,
): SettingsMatch["highlight"] {
  const labelSpan = findHighlight(query, entry.label)
  if (labelSpan) return { field: "label", span: labelSpan }
  const descSpan = findHighlight(query, entry.description)
  if (descSpan) return { field: "description", span: descSpan }
  return undefined
}

// ---------------------------------------------------------------------------
// Public client-safe search API
// ---------------------------------------------------------------------------

/**
 * Client-safe keyword-only search. Synchronous, no embeddings needed.
 * Use on every keystroke for instant feedback before the server returns.
 */
export function searchSettingsKeyword(query: string): SettingsMatch[] {
  const q = query.trim().toLowerCase()
  if (q.length < MIN_QUERY_LENGTH) return []

  const matches: SettingsMatch[] = []
  for (const entry of SETTINGS_CATALOG) {
    const { matched, matchedKeyword } = keywordMatch(q, entry)
    if (!matched) continue
    matches.push({
      entry,
      score: KEYWORD_HIT_SCORE,
      matchedKeyword,
      highlight: resolveHighlight(q, entry),
    })
  }

  // All keyword hits share the same score (KEYWORD_HIT_SCORE). Sort by
  // entry order so ties are stable and predictable rather than insertion-
  // order-dependent. The server-side hybrid breaks these same ties using
  // cosine, so client output is a strict subset of server output.
  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const ai = SETTINGS_CATALOG.findIndex((e) => e.id === a.entry.id)
    const bi = SETTINGS_CATALOG.findIndex((e) => e.id === b.entry.id)
    return ai - bi
  })

  return matches.slice(0, SETTINGS_MATCH_LIMIT)
}
