/**
 * settings-search — unit tests for keyword path, cosine, highlight, and the
 * full hybrid search. Pure-logic tests (no DOM, no API).
 */

import { describe, it, expect } from "vitest"
import { EMBEDDINGS_ENABLED } from "./embeddings"

import {
  cosineSim,
  findHighlight,
  keywordMatch,
  searchSettingsKeyword,
  MIN_QUERY_LENGTH,
} from "./settings-search"
import { searchSettingsHybrid } from "./settings-search-server"
import { SETTINGS_CATALOG, SETTINGS_SEMANTIC_THRESHOLD } from "./settings-catalog"
import embeddingsJson from "./settings-catalog.embeddings.json"

interface ProbeEmbedding {
  query: string
  embedding: number[]
}
const probeByQuery = new Map<string, number[]>(
  (
    embeddingsJson as unknown as { probes: { entries: ProbeEmbedding[] } }
  ).probes.entries.map((p) => [p.query, p.embedding]),
)

// ---------------------------------------------------------------------------
// cosineSim
// ---------------------------------------------------------------------------

describe("cosineSim", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosineSim([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6)
  })

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSim([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6)
  })

  it("returns -1 for antiparallel vectors", () => {
    expect(cosineSim([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 6)
  })

  it("normalizes — non-unit vectors with same direction return 1", () => {
    expect(cosineSim([2, 0, 0], [5, 0, 0])).toBeCloseTo(1, 6)
  })

  it("returns 0 if either operand is the zero vector (no NaN from /0)", () => {
    expect(cosineSim([0, 0, 0], [1, 1, 1])).toBe(0)
    expect(cosineSim([1, 1, 1], [0, 0, 0])).toBe(0)
  })

  it("returns 0 on length mismatch (defensive — same-mistake-twice contract)", () => {
    expect(cosineSim([1, 0], [1, 0, 0])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// findHighlight
// ---------------------------------------------------------------------------

describe("findHighlight", () => {
  it("locates the query as a contiguous substring (case-insensitive)", () => {
    expect(findHighlight("password", "Change password here")).toEqual([7, 15])
    expect(findHighlight("THEME", "Visual theme, appearance")).toEqual([7, 12])
  })

  it("falls back to the first whitespace-token of the query", () => {
    // "dark theme" doesn't appear contiguously, but "dark" does.
    expect(findHighlight("dark theme", "dark mode is enabled")).toEqual([0, 4])
  })

  it("returns null when neither full query nor first token appears", () => {
    expect(findHighlight("blue", "dark theme settings")).toBeNull()
  })

  it("returns null for an empty query", () => {
    expect(findHighlight("", "anything")).toBeNull()
  })

  it("returns null for a sub-MIN_QUERY_LENGTH token (no spurious 1-char hits)", () => {
    // 'a' is below the floor — would otherwise match almost any text.
    expect(findHighlight("a", "abacus")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// keywordMatch
// ---------------------------------------------------------------------------

describe("keywordMatch", () => {
  const profile = SETTINGS_CATALOG.find((e) => e.id === "profile")!
  const preferences = SETTINGS_CATALOG.find((e) => e.id === "preferences")!

  it("matches when a keyword contains the query (substring of keyword)", () => {
    // 'dar' is a substring of 'dark'
    const m = keywordMatch("dar", preferences)
    expect(m.matched).toBe(true)
  })

  it("matches when the query contains a keyword", () => {
    // 'darkness' contains 'dark'
    const m = keywordMatch("darkness", preferences)
    expect(m.matched).toBe(true)
    expect(m.matchedKeyword).toBe("dark")
  })

  it("is case-insensitive", () => {
    expect(keywordMatch("PASSWORD", profile).matched).toBe(true)
    expect(keywordMatch("password", profile).matched).toBe(true)
  })

  it("returns false when no keyword matches", () => {
    expect(keywordMatch("blue", preferences).matched).toBe(false)
  })

  it("returns false for queries below MIN_QUERY_LENGTH (avoids false positives)", () => {
    expect(keywordMatch("a", preferences).matched).toBe(false)
  })

  it("returns false for empty/whitespace queries", () => {
    expect(keywordMatch("", profile).matched).toBe(false)
    expect(keywordMatch("   ", profile).matched).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// searchSettingsKeyword (client-side, no embedding)
// ---------------------------------------------------------------------------

describe("searchSettingsKeyword", () => {
  it("returns Preferences for 'dark'", () => {
    const matches = searchSettingsKeyword("dark")
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.entry.id).toBe("preferences")
    expect(matches[0]!.score).toBe(0.95)
  })

  it("returns Profile for 'password'", () => {
    const matches = searchSettingsKeyword("password")
    expect(matches[0]!.entry.id).toBe("profile")
  })

  it("returns OpenAPI for 'openapi'", () => {
    const matches = searchSettingsKeyword("openapi")
    expect(matches[0]!.entry.id).toBe("integrations.openapi")
  })

  it("returns multiple matches when more than one entry has the keyword", () => {
    // `api` matches the OpenAPI integration ("api reference") and the
    // Developer settings (API keys).
    const matches = searchSettingsKeyword("api")
    const ids = matches.map((m) => m.entry.id)
    expect(ids.length).toBeGreaterThan(1)
    expect(ids).toContain("integrations.openapi")
  })

  it("returns at most 5 matches", () => {
    const matches = searchSettingsKeyword("api")
    expect(matches.length).toBeLessThanOrEqual(5)
  })

  it("returns [] for empty queries", () => {
    expect(searchSettingsKeyword("")).toEqual([])
    expect(searchSettingsKeyword("   ")).toEqual([])
  })

  it("returns [] for sub-MIN_QUERY_LENGTH queries", () => {
    expect(searchSettingsKeyword("a")).toEqual([])
  })

  it("attaches a highlight span when the matched keyword appears in label or description", () => {
    const matches = searchSettingsKeyword("password")
    const profileMatch = matches.find((m) => m.entry.id === "profile")!
    expect(profileMatch.highlight).toBeDefined()
    expect(profileMatch.highlight!.span[1]).toBeGreaterThan(profileMatch.highlight!.span[0])
  })

  it("does not highlight when the keyword is not present in label or description", () => {
    // To prove no-highlight: 'connections' is a keyword on Integrations but
    // doesn't appear in the entry's label or description.
    const matches = searchSettingsKeyword("connections")
    const integrations = matches.find((m) => m.entry.id === "integrations")!
    expect(integrations).toBeDefined()
    expect(integrations.highlight).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// searchSettingsHybrid
// ---------------------------------------------------------------------------

describe("searchSettingsHybrid", () => {
  it("when no embedding is provided, behaves like searchSettingsKeyword", () => {
    const a = searchSettingsKeyword("dark")
    const b = searchSettingsHybrid("dark", null)
    expect(b.map((m) => m.entry.id)).toEqual(a.map((m) => m.entry.id))
  })

  it("ranks a keyword match above a pure-semantic match on the same query", () => {
    // Synthetic embedding is far from every catalog vector so semantic
    // contribution is small; the keyword path on 'github' still wins.
    const fake = new Array(768).fill(0.01)
    fake[5] = 1
    const matches = searchSettingsHybrid("swagger", fake)
    expect(matches[0]!.entry.id).toBe("integrations.openapi")
    // Keyword hits sit in [0.95, 0.99] — base 0.95 plus a small cosine
    // tiebreaker contribution.
    expect(matches[0]!.score).toBeGreaterThanOrEqual(0.95)
    expect(matches[0]!.score).toBeLessThanOrEqual(0.99)
  })

  // Uses committed real query vectors; embeddings are disabled in the Breeze
  // build (no AI subprocessors) and the GitHub entry it ranked was removed.
  it.skipIf(!EMBEDDINGS_ENABLED)("breaks ties between competing keyword hits using cosine similarity", () => {
    // 'connect github' hits both 'integrations' (via 'connect' keyword)
    // and 'integrations.github' (via 'github' keyword). The more-specific
    // sub-page must win because its embedding is semantically closer to
    // the query than the generic Integrations page.
    const queryEmbedding = probeByQuery.get("connect github")
    expect(queryEmbedding).toBeDefined()
    const matches = searchSettingsHybrid("connect github", queryEmbedding!)
    expect(matches[0]!.entry.id).toBe("integrations.github")
  })

  it("filters out below-threshold matches when both paths are weak", () => {
    // Query that doesn't match any keyword AND has a fake embedding far
    // from every catalog vector. Pure-semantic matches must clear the
    // SETTINGS_SEMANTIC_THRESHOLD floor.
    const farVec = new Array(768).fill(0)
    farVec[0] = 1
    const matches = searchSettingsHybrid("zzqq", farVec)
    for (const m of matches) {
      expect(m.score).toBeGreaterThanOrEqual(SETTINGS_SEMANTIC_THRESHOLD)
    }
  })

  it("returns at most SETTINGS_MATCH_LIMIT (5) entries", () => {
    const fake = new Array(768).fill(0.01)
    const matches = searchSettingsHybrid("api", fake)
    expect(matches.length).toBeLessThanOrEqual(5)
  })

  it("MIN_QUERY_LENGTH is exposed and at least 2", () => {
    expect(MIN_QUERY_LENGTH).toBeGreaterThanOrEqual(2)
  })
})
