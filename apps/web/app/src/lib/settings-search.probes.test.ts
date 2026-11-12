/**
 * settings-search — fixture-based regression suite.
 *
 * For every probe in `SETTINGS_PROBES`, runs `searchSettingsHybrid` against
 * the pre-computed query embedding from `settings-catalog.embeddings.json`
 * and asserts the top match equals the probe's `expectedId`. Catches:
 *
 *   - Catalog edits that break a previously-passing probe (regression).
 *   - Threshold tuning errors that drop relevant entries.
 *   - Hybrid scoring bugs that flip the wrong entry to the top.
 *
 * Runs offline — query embeddings ship inside the JSON, so the test does
 * not need a Gemini API key at runtime.
 */

import { describe, it, expect } from "vitest"
import { EMBEDDINGS_ENABLED } from "./embeddings"

import { searchSettingsHybrid } from "./settings-search-server"
import { SETTINGS_PROBES } from "./settings-catalog.fixtures"
import embeddingsJson from "./settings-catalog.embeddings.json"

interface PersistedProbeEntry {
  query: string
  embedding: number[]
}
interface PersistedEmbeddings {
  probes: { entries: PersistedProbeEntry[] }
}

const persisted = embeddingsJson as unknown as PersistedEmbeddings
const probeEmbeddingByQuery = new Map<string, number[]>(
  persisted.probes.entries.map((p) => [p.query, p.embedding]),
)

describe("settings-search — probe fixtures", () => {
  for (const probe of SETTINGS_PROBES) {
    it(`"${probe.query}" → ${probe.expectedId} (${probe.expectedPath})`, () => {
      const queryEmbedding = probeEmbeddingByQuery.get(probe.query)
      // Embeddings are disabled in the Breeze build; probes added since then
      // have no stored vector and run on the keyword path alone.
      if (EMBEDDINGS_ENABLED) {
        expect(
          queryEmbedding,
          `no pre-computed embedding for "${probe.query}" — run npm run regen-settings-embeddings`,
        ).toBeDefined()
      }
      const matches = searchSettingsHybrid(probe.query, queryEmbedding ?? null)
      expect(matches.length).toBeGreaterThan(0)
      expect(
        matches[0]!.entry.id,
        `"${probe.query}" expected ${probe.expectedId}, got ${matches[0]!.entry.id} (full top-3: ${matches
          .slice(0, 3)
          .map((m) => `${m.entry.id}@${m.score.toFixed(2)}`)
          .join(", ")})`,
      ).toBe(probe.expectedId)
    })
  }
})

describe("settings-search — keyword vs semantic path classification", () => {
  it("probes labelled `keyword` actually win via the keyword path (score = 0.95)", () => {
    const failures: string[] = []
    for (const probe of SETTINGS_PROBES) {
      if (probe.expectedPath !== "keyword") continue
      const queryEmbedding = probeEmbeddingByQuery.get(probe.query) ?? null
      const matches = searchSettingsHybrid(probe.query, queryEmbedding)
      const top = matches[0]
      if (!top || top.score < 0.94) {
        failures.push(
          `${probe.query} → top score ${top?.score.toFixed(3) ?? "none"}`,
        )
      }
    }
    expect(failures, `keyword-path probes scoring below 0.95: ${failures.join(", ")}`).toHaveLength(0)
  })

  it("probes labelled `semantic` win above threshold without a keyword hit", () => {
    for (const probe of SETTINGS_PROBES) {
      if (probe.expectedPath !== "semantic") continue
      const queryEmbedding = probeEmbeddingByQuery.get(probe.query) ?? null
      const matches = searchSettingsHybrid(probe.query, queryEmbedding)
      expect(matches.length, `semantic probe "${probe.query}" returned no matches`).toBeGreaterThan(0)
      expect(matches[0]!.entry.id).toBe(probe.expectedId)
    }
  })
})
