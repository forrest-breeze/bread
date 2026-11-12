import type { SupabaseClient } from "@supabase/supabase-js"
import { generateEmbedding, type Embedding } from "@/lib/embeddings"
import { createAdminClient } from "@/lib/supabase/admin"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AncestorInfo {
  id: string
  node_id: string
  heading_title: string
  heading_depth: number
}

export type RetrievalMode = "hybrid" | "vector"

export interface RetrievalResult {
  chunk: {
    id: string
    content: string
    section_id: string
    chunk_index: number
    /** Cosine distance from the vector lane. `null` when the chunk was
     *  surfaced only by the lexical lane in hybrid mode. The type forces
     *  callers to handle "no vector signal" explicitly — comparing against
     *  a numeric threshold without a null check is a type error. */
    distance: number | null
    /** Fused RRF score. Present in hybrid mode, undefined in vector mode. */
    rrf_score?: number
  }
  section: {
    id: string
    document_id: string
    heading_title: string
    heading_depth: number
    path: string
  }
  ancestors: AncestorInfo[]
}

export interface RetrieveOptions {
  documentId?: string
  k?: number
  supabase?: SupabaseClient
  embedder?: (query: string) => Promise<Embedding>
  /** Retrieval strategy. "vector" calls match_document_section_chunks (the
   *  existing pure-ANN RPC). "hybrid" calls match_document_section_chunks_hybrid,
   *  which fuses pgvector ANN + tsvector full-text via RRF. Default is "vector"
   *  during canary; flip to "hybrid" after staging benchmark confirms the lift. */
  mode?: RetrievalMode
  /** Per-lane candidate count fed into RRF. Only meaningful in hybrid mode.
   *  Default 20 — over-fetching beyond the final k improves fusion signal. */
  laneCount?: number
  /** RRF constant (k in 1 / (k + rank)). Only meaningful in hybrid mode.
   *  Default 60 — the published default; tunable via eval harness. */
  rrfK?: number
  /** Effective caller role for folder role-visibility gating. Passed straight
   *  to the RPC's caller_role arg. null/undefined = unrestricted (the default
   *  for human/RLS paths); a role name restricts results to folders that role
   *  may see. */
  callerRole?: string | null
}

interface MatchRow {
  chunk_id: string
  section_id: string
  document_id: string
  chunk_index: number
  content: string
  distance: number | null
  heading_title: string
  heading_depth: number
  path: string
  ancestors: AncestorInfo[] | null
  rrf_score?: number | null
}

// ---------------------------------------------------------------------------
// retrieveForQuery
// ---------------------------------------------------------------------------

export async function retrieveForQuery(
  query: string,
  workspaceId: string,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult[]> {
  const k = opts.k ?? 8
  const supabase = opts.supabase ?? createAdminClient()
  const embedder =
    opts.embedder ?? ((q: string) => generateEmbedding(q, "RETRIEVAL_QUERY"))
  const queryEmbedding = await embedder(query)
  // Without a query vector (embeddings are disabled in the Breeze internal
  // build) only the hybrid RPC can answer: its full-text lane still runs and
  // its vector lane is skipped.
  const mode: RetrievalMode =
    queryEmbedding === null ? "hybrid" : (opts.mode ?? "vector")

  const callerRole = opts.callerRole ?? null
  const { data, error } =
    mode === "hybrid"
      ? await supabase.rpc("match_document_section_chunks_hybrid", {
          query_text: query,
          query_embedding: queryEmbedding,
          p_workspace_id: workspaceId,
          p_document_id: opts.documentId ?? null,
          p_match_count: k,
          p_lane_count: opts.laneCount ?? 20,
          p_rrf_k: opts.rrfK ?? 60,
          p_caller_role: callerRole,
        })
      : await supabase.rpc("match_document_section_chunks", {
          query_embedding: queryEmbedding,
          p_workspace_id: workspaceId,
          p_document_id: opts.documentId ?? null,
          p_match_count: k,
          p_caller_role: callerRole,
        })

  if (error) {
    throw new Error(`[retrieveForQuery] rpc failed: ${error.message}`)
  }
  const rows = (data ?? []) as MatchRow[]
  if (rows.length === 0) return []

  return rows.map((r) => ({
    chunk: {
      id: r.chunk_id,
      content: r.content,
      section_id: r.section_id,
      chunk_index: r.chunk_index,
      // Hybrid's lexical-only hits return NULL distance. Preserve as null
      // (not NaN, not 0) so the type system forces callers to decide what
      // to do with non-vector hits. NaN comparisons silently return false
      // either direction, which is the bug the type change exists to prevent.
      distance: r.distance ?? null,
      ...(r.rrf_score != null ? { rrf_score: r.rrf_score } : {}),
    },
    section: {
      id: r.section_id,
      document_id: r.document_id,
      heading_title: r.heading_title,
      heading_depth: r.heading_depth,
      path: r.path,
    },
    // The implicit root section has an empty heading_title and is not useful
    // as a breadcrumb label; drop it.
    ancestors: (r.ancestors ?? []).filter((a) => a.heading_title.length > 0),
  }))
}

// ---------------------------------------------------------------------------
// formatForLLM
// Renders the results as a plaintext block the model can consume directly.
// ---------------------------------------------------------------------------

/** ~4 chars per token — good enough for budgeting without tiktoken. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function formatForLLM(
  results: RetrievalResult[],
  budgetTokens = 1500,
): string {
  if (results.length === 0) return ""
  const blocks: string[] = []
  let tokensUsed = 0

  for (const r of results) {
    const titles: string[] = []
    for (const a of r.ancestors) titles.push(a.heading_title)
    if (r.section.heading_title) titles.push(r.section.heading_title)
    const heading = titles.length > 0 ? `# ${titles.join(" / ")}` : "# (untitled)"
    const block = `${heading}\n${r.chunk.content}`
    const tokens = estimateTokens(block)
    if (blocks.length > 0 && tokensUsed + tokens > budgetTokens) break
    blocks.push(block)
    tokensUsed += tokens
  }
  return blocks.join("\n\n")
}
