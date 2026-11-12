/**
 * Settings catalog — drift guard.
 *
 * Recomputes the per-source SHA-256 of the catalog and probe fixtures and
 * asserts equality against the committed `settings-catalog.embeddings.json`.
 * If a contributor edits the catalog (or fixtures) without rerunning
 * `npm run regen-settings-embeddings`, this test fails CI with a clear
 * remediation message.
 *
 * The hash deliberately covers ONLY the embedding-source strings (label,
 * description, keywords) — changes to `href` or `breadcrumb` don't move
 * the embedding and shouldn't force a regeneration.
 */

import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"

import {
  SETTINGS_CATALOG,
  getEmbeddingSource,
} from "./settings-catalog"
import { SETTINGS_PROBES } from "./settings-catalog.fixtures"
import embeddingsJson from "./settings-catalog.embeddings.json"
import { EMBEDDINGS_ENABLED } from "./embeddings"

interface PersistedCatalogEntry {
  id: string
  embedding: number[]
}
interface PersistedProbeEntry {
  query: string
  embedding: number[]
}
interface PersistedEmbeddings {
  version: number
  model: string
  dim: number
  catalog: { sourceHash: string; entries: PersistedCatalogEntry[] }
  probes: { sourceHash: string; entries: PersistedProbeEntry[] }
}

const persisted = embeddingsJson as unknown as PersistedEmbeddings

// Mirrors the regen script — hash via JSON.stringify so encoding is
// identical across runtimes and immune to whitespace mangling.
function hashStrings(strings: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(strings)).digest("hex")
}

const REGEN_HINT =
  "settings catalog drift — run `npm run regen-settings-embeddings` from apps/web/app and commit the regenerated JSON"

// Embeddings are disabled in the Breeze internal build (no AI subprocessors),
// so settings search is keyword-only and the committed vectors are unused. The
// regen script was removed with the Gemini dependency; re-enable this guard
// together with embeddings.
describe.skipIf(!EMBEDDINGS_ENABLED)("settings-catalog drift guard", () => {
  it("catalog sourceHash matches the committed embeddings JSON", () => {
    const sources = SETTINGS_CATALOG.map((e) => getEmbeddingSource(e))
    const recomputed = hashStrings(sources)
    expect(
      recomputed,
      `${REGEN_HINT}\nexpected catalog hash ${persisted.catalog.sourceHash}, got ${recomputed}`,
    ).toBe(persisted.catalog.sourceHash)
  })

  it("probe sourceHash matches the committed embeddings JSON", () => {
    const queries = SETTINGS_PROBES.map((p) => p.query)
    const recomputed = hashStrings(queries)
    expect(
      recomputed,
      `${REGEN_HINT}\nexpected probe hash ${persisted.probes.sourceHash}, got ${recomputed}`,
    ).toBe(persisted.probes.sourceHash)
  })

  it("catalog entry IDs are aligned with the persisted entries (same order)", () => {
    expect(persisted.catalog.entries.length).toBe(SETTINGS_CATALOG.length)
    SETTINGS_CATALOG.forEach((entry, i) => {
      expect(persisted.catalog.entries[i]!.id).toBe(entry.id)
    })
  })

  it("probe queries are aligned with the persisted entries (same order)", () => {
    expect(persisted.probes.entries.length).toBe(SETTINGS_PROBES.length)
    SETTINGS_PROBES.forEach((probe, i) => {
      expect(persisted.probes.entries[i]!.query).toBe(probe.query)
    })
  })

  it("every embedding is the expected 768-dim vector", () => {
    expect(persisted.dim).toBe(768)
    for (const e of persisted.catalog.entries) {
      expect(e.embedding.length).toBe(768)
    }
    for (const e of persisted.probes.entries) {
      expect(e.embedding.length).toBe(768)
    }
  })

  it("no embedding is identically zero (sanity check against a regen failure)", () => {
    const hasNonZero = (v: number[]): boolean => v.some((x) => x !== 0)
    for (const e of persisted.catalog.entries) {
      expect(hasNonZero(e.embedding), `catalog ${e.id} embedding is all zeros`).toBe(true)
    }
    for (const e of persisted.probes.entries) {
      expect(hasNonZero(e.embedding), `probe "${e.query}" embedding is all zeros`).toBe(true)
    }
  })

  it("model field matches the embedder used at regen time", () => {
    expect(persisted.model).toBe("gemini-embedding-001")
  })
})

describe("settings-catalog content invariants", () => {
  it("entry ids are unique", () => {
    const ids = SETTINGS_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("hrefs are unique (no duplicate destinations)", () => {
    const hrefs = SETTINGS_CATALOG.map((e) => e.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it("every entry has at least 3 keywords (insufficient haystack hurts keyword path)", () => {
    for (const e of SETTINGS_CATALOG) {
      expect(e.keywords.length, `entry ${e.id} has only ${e.keywords.length} keywords`).toBeGreaterThanOrEqual(3)
    }
  })

  it("every probe references a real catalog id", () => {
    const ids = new Set(SETTINGS_CATALOG.map((e) => e.id))
    for (const p of SETTINGS_PROBES) {
      expect(ids.has(p.expectedId), `probe "${p.query}" expects unknown id "${p.expectedId}"`).toBe(true)
    }
  })
})
