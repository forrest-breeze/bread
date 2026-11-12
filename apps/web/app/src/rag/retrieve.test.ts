/**
 * retrieveForQuery contract tests.
 *
 * The retrieval seam at `retrieveForQuery` fans out to three production
 * surfaces (REST /api/v1/search, the MCP tool, stdio MCP). Any regression in
 * which RPC gets called, what args it gets, or how rows are mapped will
 * silently break all three. These tests pin:
 *
 *   1. Vector mode (default) — calls match_document_section_chunks with the
 *      existing parameter names (query_embedding, p_workspace_id,
 *      p_document_id, p_match_count).
 *   2. Hybrid mode — calls match_document_section_chunks_hybrid with both
 *      query_text (raw query string) and query_embedding, plus the RRF knobs.
 *   3. Row mapping — rrf_score is only set when the RPC returned it (hybrid);
 *      in vector mode the field must be absent on the result.
 *   4. Lexical-only hits — NULL distance from the hybrid RPC surfaces as NaN
 *      so callers that sort by distance don't silently treat them as nearest.
 *   5. Ancestor filtering — implicit-root ancestors (empty heading_title)
 *      are dropped before return.
 */
import { describe, expect, it, vi } from "vitest"

import { retrieveForQuery, type RetrievalResult } from "./retrieve"

// --------------------------------------------------------------------------
// Test doubles
// --------------------------------------------------------------------------

interface RpcCall {
  name: string
  args: Record<string, unknown>
}

function makeSupabaseStub(rows: unknown[], error: unknown = null) {
  const calls: RpcCall[] = []
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args })
    return { data: rows, error }
  })
   
  return { rpc, calls } as { rpc: any; calls: RpcCall[] }
}

const EMBEDDING = Array.from({ length: 768 }, (_, i) => i / 768)
const embedder = vi.fn(async () => EMBEDDING)

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    chunk_id: "00000000-0000-0000-0000-000000000001",
    section_id: "00000000-0000-0000-0000-000000000011",
    document_id: "00000000-0000-0000-0000-000000000021",
    chunk_index: 0,
    content: "Deployment runbook for auth-gateway.",
    distance: 0.12,
    heading_title: "Auth Gateway Deploy",
    heading_depth: 2,
    path: "root.auth_gateway",
    ancestors: [
      { id: "root-id", node_id: "root", heading_title: "", heading_depth: 0 },
      {
        id: "svc-id",
        node_id: "svc",
        heading_title: "Services",
        heading_depth: 1,
      },
    ],
    ...overrides,
  }
}

// --------------------------------------------------------------------------
// Vector mode (default)
// --------------------------------------------------------------------------

describe("retrieveForQuery — vector mode (default)", () => {
  it("calls match_document_section_chunks with the existing parameter names", async () => {
    const stub = makeSupabaseStub([baseRow()])
    await retrieveForQuery("auth gateway deploy", "ws-1", {
       
      supabase: { rpc: stub.rpc } as any,
      embedder,
    })

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.name).toBe("match_document_section_chunks")
    expect(stub.calls[0]!.args).toEqual({
      query_embedding: EMBEDDING,
      p_workspace_id: "ws-1",
      p_document_id: null,
      p_match_count: 8,
      p_caller_role: null,
    })
  })

  it("forwards documentId and k when provided", async () => {
    const stub = makeSupabaseStub([])
    await retrieveForQuery("q", "ws-1", {
       
      supabase: { rpc: stub.rpc } as any,
      embedder,
      documentId: "doc-42",
      k: 3,
    })
    expect(stub.calls[0]!.args).toMatchObject({
      p_document_id: "doc-42",
      p_match_count: 3,
    })
  })

  it("does not attach rrf_score to the mapped result when the row lacks it", async () => {
    const stub = makeSupabaseStub([baseRow()])
    const result: RetrievalResult[] = await retrieveForQuery("q", "ws-1", {
       
      supabase: { rpc: stub.rpc } as any,
      embedder,
    })
    expect(result).toHaveLength(1)
    expect("rrf_score" in result[0]!.chunk).toBe(false)
  })

  it("drops ancestors with empty heading_title (implicit root)", async () => {
    const stub = makeSupabaseStub([baseRow()])
    const result = await retrieveForQuery("q", "ws-1", {
       
      supabase: { rpc: stub.rpc } as any,
      embedder,
    })
    expect(result[0]!.ancestors).toHaveLength(1)
    expect(result[0]!.ancestors[0]!.heading_title).toBe("Services")
  })
})

// --------------------------------------------------------------------------
// Hybrid mode
// --------------------------------------------------------------------------

describe("retrieveForQuery — hybrid mode", () => {
  it("calls match_document_section_chunks_hybrid with query_text + embedding + RRF knobs", async () => {
    const stub = makeSupabaseStub([baseRow({ rrf_score: 0.0328 })])
    await retrieveForQuery("auth gateway deploy", "ws-1", {
       
      supabase: { rpc: stub.rpc } as any,
      embedder,
      mode: "hybrid",
    })

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.name).toBe("match_document_section_chunks_hybrid")
    expect(stub.calls[0]!.args).toEqual({
      query_text: "auth gateway deploy",
      query_embedding: EMBEDDING,
      p_workspace_id: "ws-1",
      p_document_id: null,
      p_match_count: 8,
      p_lane_count: 20,
      p_rrf_k: 60,
      p_caller_role: null,
    })
  })

  it("overrides laneCount and rrfK via options", async () => {
    const stub = makeSupabaseStub([])
    await retrieveForQuery("q", "ws-1", {
       
      supabase: { rpc: stub.rpc } as any,
      embedder,
      mode: "hybrid",
      laneCount: 50,
      rrfK: 30,
    })
    expect(stub.calls[0]!.args).toMatchObject({
      p_lane_count: 50,
      p_rrf_k: 30,
    })
  })

  it("maps rrf_score through to the result when present", async () => {
    const stub = makeSupabaseStub([baseRow({ rrf_score: 0.0328 })])
    const result = await retrieveForQuery("q", "ws-1", {
       
      supabase: { rpc: stub.rpc } as any,
      embedder,
      mode: "hybrid",
    })
    expect(result[0]!.chunk.rrf_score).toBeCloseTo(0.0328)
  })

  it("preserves NULL distance from lexical-only hits as null (not NaN)", async () => {
    // Why this matters: NaN comparisons silently return false in either
    // direction, so `chunk.distance < 0.5` would skip lex-only hits without
    // any indication. Returning null forces TypeScript callers to decide.
    const stub = makeSupabaseStub([
      baseRow({ distance: null, rrf_score: 0.0164 }),
    ])
    const result = await retrieveForQuery("q", "ws-1", {

      supabase: { rpc: stub.rpc } as any,
      embedder,
      mode: "hybrid",
    })
    expect(result[0]!.chunk.distance).toBeNull()
  })
})

// --------------------------------------------------------------------------
// Error + empty paths
// --------------------------------------------------------------------------

describe("retrieveForQuery — error handling", () => {
  it("throws when the RPC returns an error (vector mode)", async () => {
    const stub = makeSupabaseStub([], { message: "permission denied" })
    await expect(
      retrieveForQuery("q", "ws-1", {
         
        supabase: { rpc: stub.rpc } as any,
        embedder,
      }),
    ).rejects.toThrow(/permission denied/)
  })

  it("throws when the RPC returns an error (hybrid mode)", async () => {
    const stub = makeSupabaseStub([], { message: "bad tsvector" })
    await expect(
      retrieveForQuery("q", "ws-1", {
         
        supabase: { rpc: stub.rpc } as any,
        embedder,
        mode: "hybrid",
      }),
    ).rejects.toThrow(/bad tsvector/)
  })

  it("returns [] on empty rows without touching the mapper", async () => {
    const stub = makeSupabaseStub([])
    const result = await retrieveForQuery("q", "ws-1", {
       
      supabase: { rpc: stub.rpc } as any,
      embedder,
    })
    expect(result).toEqual([])
  })
})
