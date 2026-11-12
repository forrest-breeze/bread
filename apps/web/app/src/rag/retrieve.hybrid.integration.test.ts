/**
 * Integration test for the hybrid RRF RPC against a real Postgres with the
 * 20260425090000 / 20260425090100 / 20260425090500 migrations applied AND
 * the seed at supabase/tests/fixtures/hybrid_rrf_seed.sql loaded.
 *
 * Gated on `INTEGRATION_DB_URL` + `INTEGRATION_DB_SERVICE_KEY` env vars so
 * CI runs this only when a disposable Postgres is wired up. Skips silently
 * when unset.
 *
 * Local run (after `npx supabase start`):
 *   PGURL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *   psql "$PGURL" -f supabase/migrations/20260425090000_chunk_tsvector.sql
 *   psql "$PGURL" -f supabase/migrations/20260425090100_chunk_tsvector_index.sql
 *   psql "$PGURL" -f supabase/migrations/20260425090500_match_document_section_chunks_hybrid.sql
 *   psql "$PGURL" -f supabase/tests/fixtures/hybrid_rrf_seed.sql
 *   INTEGRATION_DB_URL=http://127.0.0.1:54321 \
 *   INTEGRATION_DB_SERVICE_KEY=$(npx supabase status -o env | grep SERVICE_ROLE | cut -d= -f2 | tr -d '"') \
 *   npx vitest run src/rag/retrieve.hybrid.integration.test.ts
 *
 * What this test proves:
 *   1. The RRF RPC runs end-to-end against real Postgres (no SQL syntax bugs).
 *   2. A chunk that wins both lanes outranks chunks that win only one lane.
 *   3. Workspace scoping works — chunks from a different workspace never leak
 *      into the result set, even when their vector + lexical signals would
 *      otherwise rank them at the top.
 */
import { createClient } from "@supabase/supabase-js"
import { describe, expect, it } from "vitest"

import { retrieveForQuery } from "./retrieve"

const INTEGRATION_DB_URL = process.env.INTEGRATION_DB_URL
const INTEGRATION_DB_KEY = process.env.INTEGRATION_DB_SERVICE_KEY

const suite =
  INTEGRATION_DB_URL && INTEGRATION_DB_KEY ? describe : describe.skip

// Workspace UUIDs match supabase/tests/fixtures/hybrid_rrf_seed.sql.
const WS_TEST_1 = "11111111-1111-1111-1111-111111111111"
const WS_TEST_2 = "22222222-2222-2222-2222-222222222222"

// Chunk UUIDs from the seed.
const CHUNK_DOUBLY_HIT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1"
const CHUNK_LEX_ONLY = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2"
const CHUNK_VEC_ONLY = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3"
const CHUNK_OTHER_WS = "ffffffff-ffff-ffff-ffff-fffffffffff4"

suite("retrieveForQuery — hybrid RRF integration", () => {
  it("fuses vector + lexical lanes and ranks the doubly-matched chunk first", async () => {
    const supabase = createClient(INTEGRATION_DB_URL!, INTEGRATION_DB_KEY!)

    // Deterministic 768-dim one-hot embedder. Matches the seed: chunks with
    // embedding[97] = 1 are designed to top the vector lane for queries that
    // start with 'a' (charCodeAt(0) === 97).
    const embedder = async (text: string): Promise<number[]> => {
      const v = new Array<number>(768).fill(0)
      const idx = Math.abs(text.charCodeAt(0) % 768)
      v[idx] = 1
      return v
    }

    const results = await retrieveForQuery("auth gateway deploy", WS_TEST_1, {
       
      supabase: supabase as any,
      embedder,
      mode: "hybrid",
      k: 8,
    })

    // 1. We got results.
    expect(results.length).toBeGreaterThan(0)

    // 2. The doubly-hit chunk ranks first (it tops both lanes; RRF score is
    //    1/(60+1) + 1/(60+1) ~= 0.0328 — strictly higher than any chunk
    //    that's only in one lane).
    expect(results[0]!.chunk.id).toBe(CHUNK_DOUBLY_HIT)
    expect(results[0]!.chunk.rrf_score).toBeDefined()
    expect(results[0]!.chunk.rrf_score!).toBeGreaterThan(0)

    // 3. Workspace scoping: the cross-workspace chunk in ws-test-2 has the
    //    same strong vector + lexical signal as the doubly-hit chunk, but
    //    must NEVER appear in ws-test-1's results.
    const returnedIds = results.map((r) => r.chunk.id)
    expect(returnedIds).not.toContain(CHUNK_OTHER_WS)

    // 4. The other ws-test-1 chunks (lex-only, vec-only) are present in the
    //    result set, just at lower ranks than the doubly-hit chunk.
    expect(returnedIds).toContain(CHUNK_LEX_ONLY)
    expect(returnedIds).toContain(CHUNK_VEC_ONLY)
  })

  it("returns chunks from ws-test-2 only when called with ws-test-2's id", async () => {
    const supabase = createClient(INTEGRATION_DB_URL!, INTEGRATION_DB_KEY!)
    const embedder = async (): Promise<number[]> => {
      const v = new Array<number>(768).fill(0)
      v[97] = 1
      return v
    }

    const results = await retrieveForQuery("auth gateway deploy", WS_TEST_2, {
       
      supabase: supabase as any,
      embedder,
      mode: "hybrid",
      k: 8,
    })

    // The cross-workspace chunk should be present here (and only here).
    const returnedIds = results.map((r) => r.chunk.id)
    expect(returnedIds).toContain(CHUNK_OTHER_WS)
    expect(returnedIds).not.toContain(CHUNK_DOUBLY_HIT)
  })
})
