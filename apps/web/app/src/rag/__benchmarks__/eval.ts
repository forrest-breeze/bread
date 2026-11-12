#!/usr/bin/env -S npx tsx
/**
 * Retrieval eval harness.
 *
 * Reads a frozen query corpus, runs `retrieveForQuery` in both vector-only
 * and hybrid modes against a real Supabase, and emits a per-query CSV with
 * precision@5, latency, and the retrieved chunk ids for manual inspection.
 *
 * Usage:
 *   INTEGRATION_DB_URL=...  \
 *   INTEGRATION_DB_SERVICE_KEY=... \
 *   EVAL_WORKSPACE_ID=... \
 *   npx tsx apps/web/app/src/rag/__benchmarks__/eval.ts
 *
 * Output: writes eval-results-<timestamp>.csv to the working directory.
 *
 * The corpus at apps/web/app/src/rag/__benchmarks__/eval/queries.json has
 * per-query `relevant_chunk_ids` (hand-labeled). If a query's labels are
 * empty, P@5 is reported as NaN and the query is excluded from aggregate
 * precision. This lets the corpus ship with placeholder queries that later
 * get labeled without blocking the harness.
 */
import { readFile, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"

import { createClient } from "@supabase/supabase-js"

import { generateEmbedding } from "@/lib/embeddings"
import { retrieveForQuery, formatForLLM, type RetrievalMode } from "@/rag/retrieve"

// --------------------------------------------------------------------------
// Corpus loading
// --------------------------------------------------------------------------

interface EvalQuery {
  id: string
  category: "lexical" | "semantic" | "ambiguous" | "heading"
  query: string
  /** Hand-labeled chunk ids relevant to the query. Empty array => unlabeled. */
  relevant_chunk_ids: string[]
}

async function loadCorpus(): Promise<EvalQuery[]> {
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, "eval", "queries.json")
  const raw = await readFile(path, "utf8")
  return JSON.parse(raw) as EvalQuery[]
}

// --------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------

/** Precision at k: fraction of top-k chunks that are in the relevant set. */
function precisionAtK(
  retrievedChunkIds: string[],
  relevantChunkIds: string[],
  k: number,
): number {
  if (relevantChunkIds.length === 0) return Number.NaN
  const topK = retrievedChunkIds.slice(0, k)
  const relevantSet = new Set(relevantChunkIds)
  const hits = topK.filter((id) => relevantSet.has(id)).length
  return hits / k
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

interface Row {
  query_id: string
  category: string
  query: string
  mode: RetrievalMode
  latency_ms: number
  retrieved_chunk_ids: string
  precision_at_5: number
  format_bytes: number
}

async function runOne(
   
  supabase: any,
  q: EvalQuery,
  mode: RetrievalMode,
): Promise<Row> {
  const t0 = performance.now()
  const results = await retrieveForQuery(q.query, process.env.EVAL_WORKSPACE_ID!, {
    supabase,
    embedder: (text) => generateEmbedding(text, "RETRIEVAL_QUERY"),
    mode,
    k: 8,
  })
  const latency_ms = performance.now() - t0
  const retrievedIds = results.map((r) => r.chunk.id)
  const formatted = formatForLLM(results, 1500)
  return {
    query_id: q.id,
    category: q.category,
    query: q.query,
    mode,
    latency_ms,
    retrieved_chunk_ids: retrievedIds.join("|"),
    precision_at_5: precisionAtK(retrievedIds, q.relevant_chunk_ids, 5),
    format_bytes: Buffer.byteLength(formatted, "utf8"),
  }
}

function toCsv(rows: Row[]): string {
  const header = [
    "query_id",
    "category",
    "mode",
    "latency_ms",
    "precision_at_5",
    "format_bytes",
    "retrieved_chunk_ids",
    "query",
  ].join(",")
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`
  const body = rows.map((r) =>
    [
      r.query_id,
      r.category,
      r.mode,
      r.latency_ms.toFixed(1),
      Number.isNaN(r.precision_at_5) ? "" : r.precision_at_5.toFixed(3),
      r.format_bytes,
      escape(r.retrieved_chunk_ids),
      escape(r.query),
    ].join(","),
  )
  return [header, ...body].join("\n")
}

function summarize(rows: Row[]): void {
  const byMode = new Map<RetrievalMode, Row[]>()
  for (const r of rows) {
    const bucket = byMode.get(r.mode) ?? []
    bucket.push(r)
    byMode.set(r.mode, bucket)
  }
  for (const [mode, bucket] of byMode) {
    const labeled = bucket.filter((r) => !Number.isNaN(r.precision_at_5))
    const meanP5 =
      labeled.length === 0
        ? Number.NaN
        : labeled.reduce((s, r) => s + r.precision_at_5, 0) / labeled.length
    const latencies = bucket.map((r) => r.latency_ms).sort((a, b) => a - b)
    const p50 = latencies[Math.floor(latencies.length * 0.5)]
    const p95 = latencies[Math.floor(latencies.length * 0.95)]
    console.log(
      `[${mode}] n=${bucket.length} (labeled=${labeled.length}) ` +
        `P@5=${Number.isNaN(meanP5) ? "n/a" : meanP5.toFixed(3)} ` +
        `p50=${p50?.toFixed(0)}ms p95=${p95?.toFixed(0)}ms`,
    )
  }
}

async function main(): Promise<void> {
  const url = process.env.INTEGRATION_DB_URL
  const key = process.env.INTEGRATION_DB_SERVICE_KEY
  const ws = process.env.EVAL_WORKSPACE_ID
  if (!url || !key || !ws) {
    console.error(
      "Missing env. Set INTEGRATION_DB_URL, INTEGRATION_DB_SERVICE_KEY, EVAL_WORKSPACE_ID.",
    )
    process.exit(1)
  }
  const supabase = createClient(url, key)
  const corpus = await loadCorpus()

  const rows: Row[] = []
  for (const q of corpus) {
    for (const mode of ["vector", "hybrid"] as RetrievalMode[]) {
       
      const row = await runOne(supabase, q, mode)
      rows.push(row)
      console.log(
        `  ${q.id.padEnd(10)} ${mode.padEnd(7)} ` +
          `lat=${row.latency_ms.toFixed(0)}ms P@5=${
            Number.isNaN(row.precision_at_5) ? "n/a" : row.precision_at_5.toFixed(3)
          }`,
      )
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outfile = `eval-results-${stamp}.csv`
  await writeFile(outfile, toCsv(rows), "utf8")
  console.log(`\nWrote ${outfile}\n`)
  summarize(rows)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
