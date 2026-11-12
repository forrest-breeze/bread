#!/usr/bin/env -S npx tsx
/**
 * BEIR precision eval. Runs every test query through both retrieval modes
 * (vector-only and hybrid+RRF), scores top-K against TREC-format qrels,
 * and reports P@5 / Recall@10 / latency for each mode.
 *
 * Prereq: seed-beir.ts must have populated workspace
 * 33333333-3333-3333-3333-333333333333 with NFCorpus chunks AND written
 * corpus_to_chunk.json (the corpus-id → chunk_id map).
 *
 * Run:
 *   USE_OLLAMA=1 \
 *   BEIR_DATA=/tmp/beir-nfcorpus/nfcorpus \
 *   INTEGRATION_DB_URL=http://127.0.0.1:54321 \
 *   INTEGRATION_DB_SERVICE_KEY=<service_role> \
 *   npx tsx apps/web/app/src/rag/__benchmarks__/eval-beir.ts
 *
 * Output: writes eval-beir-results-<timestamp>.csv and prints summary.
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import { createClient } from "@supabase/supabase-js"

import { generateEmbeddings } from "@/lib/embeddings"
import { retrieveForQuery, type RetrievalMode } from "@/rag/retrieve"

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const BEIR_WORKSPACE_ID = "33333333-3333-3333-3333-333333333333"
const K_TOP = 10 // pull top-10 to compute both P@5 and Recall@10

// --------------------------------------------------------------------------
// Local Ollama embedder — must match what seed-beir.ts used
// --------------------------------------------------------------------------

const OLLAMA_EMBED_URL =
  process.env.OLLAMA_EMBED_URL ?? "http://127.0.0.1:11434/api/embeddings"
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text"

async function embedOneOllama(text: string): Promise<number[]> {
  const res = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  })
  if (!res.ok) {
    throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as { embedding?: number[] }
  if (!json.embedding) throw new Error("empty embedding")
  return json.embedding
}

const useLocal = !!process.env.USE_OLLAMA
const embedQuery = useLocal
  ? embedOneOllama
  : async (text: string) =>
      (await generateEmbeddings([text], "RETRIEVAL_QUERY"))[0]!

// --------------------------------------------------------------------------
// Corpus + qrels loading
// --------------------------------------------------------------------------

interface Query {
  _id: string
  text: string
}

async function loadQueries(dataDir: string): Promise<Query[]> {
  const path = join(dataDir, "queries.jsonl")
  const raw = await readFile(path, "utf8")
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Query)
}

/**
 * qrels/test.tsv schema: query_id<TAB>corpus_id<TAB>score
 * Score 0 = irrelevant, 1 = relevant, 2 = highly relevant.
 * We treat any score >= 1 as a relevant hit.
 */
async function loadQrels(
  dataDir: string,
  split: "test" | "dev" | "train" = "test",
): Promise<Map<string, Set<string>>> {
  const path = join(dataDir, "qrels", `${split}.tsv`)
  const raw = await readFile(path, "utf8")
  const map = new Map<string, Set<string>>()
  for (const line of raw.split("\n").slice(1)) {
    const parts = line.split("\t")
    if (parts.length < 3) continue
    const [qid, cid, scoreStr] = parts as [string, string, string]
    if (parseInt(scoreStr, 10) < 1) continue
    let s = map.get(qid)
    if (!s) {
      s = new Set<string>()
      map.set(qid, s)
    }
    s.add(cid)
  }
  return map
}

async function loadCorpusToChunkMap(
  dataDir: string,
): Promise<Record<string, string>> {
  const path = join(dataDir, "corpus_to_chunk.json")
  const raw = await readFile(path, "utf8")
  return JSON.parse(raw) as Record<string, string>
}

// --------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------

function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k)
  if (topK.length === 0) return 0
  const hits = topK.filter((id) => relevant.has(id)).length
  return hits / k
}

function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return Number.NaN
  const topK = retrieved.slice(0, k)
  const hits = topK.filter((id) => relevant.has(id)).length
  return hits / relevant.size
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

interface Row {
  query_id: string
  query_text: string
  mode: RetrievalMode
  latency_ms: number
  precision_at_5: number
  recall_at_10: number
  retrieved_chunk_ids: string
  relevant_count: number
}

async function runOne(
   
  supabase: any,
  query: Query,
  relevantChunks: Set<string>,
  mode: RetrievalMode,
): Promise<Row> {
  const t0 = performance.now()
  const results = await retrieveForQuery(query.text, BEIR_WORKSPACE_ID, {
    supabase,
    embedder: embedQuery,
    mode,
    k: K_TOP,
  })
  const latency_ms = performance.now() - t0
  const retrievedIds = results.map((r) => r.chunk.id)
  return {
    query_id: query._id,
    query_text: query.text,
    mode,
    latency_ms,
    precision_at_5: precisionAtK(retrievedIds, relevantChunks, 5),
    recall_at_10: recallAtK(retrievedIds, relevantChunks, 10),
    retrieved_chunk_ids: retrievedIds.join("|"),
    relevant_count: relevantChunks.size,
  }
}

function toCsv(rows: Row[]): string {
  const header = [
    "query_id",
    "mode",
    "latency_ms",
    "precision_at_5",
    "recall_at_10",
    "relevant_count",
    "retrieved_chunk_ids",
    "query_text",
  ].join(",")
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`
  const body = rows.map((r) =>
    [
      r.query_id,
      r.mode,
      r.latency_ms.toFixed(1),
      r.precision_at_5.toFixed(3),
      Number.isNaN(r.recall_at_10) ? "" : r.recall_at_10.toFixed(3),
      r.relevant_count,
      escape(r.retrieved_chunk_ids),
      escape(r.query_text),
    ].join(","),
  )
  return [header, ...body].join("\n")
}

function summarize(rows: Row[]): { vector: Aggregate; hybrid: Aggregate } {
  const groups: Record<RetrievalMode, Row[]> = {
    vector: rows.filter((r) => r.mode === "vector"),
    hybrid: rows.filter((r) => r.mode === "hybrid"),
  }
  const stat = (xs: number[]): { mean: number; p50: number; p95: number } => {
    if (xs.length === 0) return { mean: NaN, p50: NaN, p95: NaN }
    const sorted = [...xs].sort((a, b) => a - b)
    return {
      mean: xs.reduce((s, x) => s + x, 0) / xs.length,
      p50: sorted[Math.floor(sorted.length * 0.5)]!,
      p95: sorted[Math.floor(sorted.length * 0.95)]!,
    }
  }
  function aggregate(bucket: Row[]): Aggregate {
    return {
      n: bucket.length,
      p_at_5: stat(bucket.map((r) => r.precision_at_5)),
      r_at_10: stat(bucket.filter((r) => !Number.isNaN(r.recall_at_10)).map((r) => r.recall_at_10)),
      latency_ms: stat(bucket.map((r) => r.latency_ms)),
    }
  }
  return { vector: aggregate(groups.vector), hybrid: aggregate(groups.hybrid) }
}

interface Aggregate {
  n: number
  p_at_5: { mean: number; p50: number; p95: number }
  r_at_10: { mean: number; p50: number; p95: number }
  latency_ms: { mean: number; p50: number; p95: number }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const url = process.env.INTEGRATION_DB_URL
  const key = process.env.INTEGRATION_DB_SERVICE_KEY
  const dataDir = process.env.BEIR_DATA
  if (!url || !key || !dataDir) {
    console.error("Missing env. Set INTEGRATION_DB_URL, INTEGRATION_DB_SERVICE_KEY, BEIR_DATA")
    process.exit(1)
  }

  const supabase = createClient(url, key)
  const queries = await loadQueries(dataDir)
  const qrelsRaw = await loadQrels(dataDir, "test")
  const corpusToChunk = await loadCorpusToChunkMap(dataDir)

  // Map qrels' corpus-ids to our deterministic chunk_ids (same mapping the
  // seeder used). Skip queries whose relevant docs aren't all seeded.
  const qrels = new Map<string, Set<string>>()
  for (const [qid, corpusIds] of qrelsRaw) {
    const chunkIds = new Set<string>()
    for (const cid of corpusIds) {
      const chunkId = corpusToChunk[cid]
      if (chunkId) chunkIds.add(chunkId)
    }
    if (chunkIds.size > 0) qrels.set(qid, chunkIds)
  }

  const queryIds = new Set(qrels.keys())
  const testQueries = queries.filter((q) => queryIds.has(q._id))

  console.log(
    `Eval set: ${testQueries.length} queries with at least one relevant doc in seeded corpus`,
  )
  console.log(
    `Embedder: ${useLocal ? `local Ollama (${OLLAMA_EMBED_MODEL})` : "Gemini"}`,
  )

  const rows: Row[] = []
  for (const [i, q] of testQueries.entries()) {
    const relevant = qrels.get(q._id)!
    for (const mode of ["vector", "hybrid"] as RetrievalMode[]) {
       
      const row = await runOne(supabase, q, relevant, mode)
      rows.push(row)
    }
    if ((i + 1) % 25 === 0) {
      process.stdout.write(`  ${i + 1}/${testQueries.length} queries done\r`)
    }
  }
  console.log("")

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outfile = `eval-beir-results-${stamp}.csv`
  await writeFile(outfile, toCsv(rows), "utf8")
  console.log(`\nWrote ${outfile} (${rows.length} rows)\n`)

  const agg = summarize(rows)
  for (const mode of ["vector", "hybrid"] as RetrievalMode[]) {
    const a = agg[mode]
    console.log(
      `[${mode}] n=${a.n}  ` +
        `P@5=${a.p_at_5.mean.toFixed(3)}  ` +
        `R@10=${a.r_at_10.mean.toFixed(3)}  ` +
        `latency p50=${a.latency_ms.p50.toFixed(0)}ms  p95=${a.latency_ms.p95.toFixed(0)}ms`,
    )
  }
  const lift = (agg.hybrid.p_at_5.mean - agg.vector.p_at_5.mean) * 100
  const recallLift = (agg.hybrid.r_at_10.mean - agg.vector.r_at_10.mean) * 100
  console.log(`\nHybrid - Vector  P@5 lift: ${lift >= 0 ? "+" : ""}${lift.toFixed(2)} pp`)
  console.log(`Hybrid - Vector R@10 lift: ${recallLift >= 0 ? "+" : ""}${recallLift.toFixed(2)} pp`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
