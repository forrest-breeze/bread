#!/usr/bin/env -S npx tsx
/**
 * BEIR seeder: loads NFCorpus (medical abstracts with TREC-style relevance
 * judgments) into the local Supabase so the precision eval can measure
 * P@5 / Recall@10 for vector-only vs hybrid+RRF retrieval against ground
 * truth labels.
 *
 * Why NFCorpus:
 *   - 3,633 docs (small enough to embed via Gemini in minutes)
 *   - 323 test queries with TREC-format qrels (relevance scores 1-2)
 *   - Mix of lexical (drug/condition names) and semantic (concept) queries
 *
 * Run:
 *   1) Download dataset:
 *        curl -sL -o /tmp/nfcorpus.zip \
 *          https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip
 *        unzip -q -o /tmp/nfcorpus.zip -d /tmp/beir-nfcorpus
 *
 *   2) Run seeder:
 *        BEIR_DATA=/tmp/beir-nfcorpus/nfcorpus \
 *        INTEGRATION_DB_URL=http://127.0.0.1:54321 \
 *        INTEGRATION_DB_SERVICE_KEY=<service_role_key> \
 *        FREE_GEMINI_API_KEY_1=<key> \
 *        npx tsx apps/web/app/src/rag/__benchmarks__/seed-beir.ts
 *
 * Idempotent: if the test workspace already has 3,633 chunks, exits early.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import { createClient } from "@supabase/supabase-js"

import { generateEmbeddings } from "@/lib/embeddings"

// --------------------------------------------------------------------------
// Local embedder (Ollama). When OLLAMA_EMBED_URL is set we use the local
// HTTP API (free, no quota) instead of Gemini. The model must produce
// 768-dim vectors to match the embedding column type.
// --------------------------------------------------------------------------

const OLLAMA_EMBED_URL =
  process.env.OLLAMA_EMBED_URL ?? "http://127.0.0.1:11434/api/embeddings"
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text"

async function embedLocalOllama(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (const text of texts) {
    const res = await fetch(OLLAMA_EMBED_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
    })
    if (!res.ok) {
      throw new Error(
        `ollama embed failed: ${res.status} ${await res.text()}`,
      )
    }
    const json = (await res.json()) as { embedding?: number[] }
    if (!json.embedding || json.embedding.length === 0) {
      throw new Error(`ollama returned empty embedding for: ${text.slice(0, 60)}`)
    }
    out.push(json.embedding)
  }
  return out
}

const useLocal = !!process.env.USE_OLLAMA
const embedFn = useLocal
  ? embedLocalOllama
  : (texts: string[]) => generateEmbeddings(texts, "RETRIEVAL_DOCUMENT")

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// Stable workspace UUID for the BEIR test corpus. Distinct from the small
// 4-chunk fixture's UUIDs so both can coexist without conflict.
const BEIR_WORKSPACE_ID = "33333333-3333-3333-3333-333333333333"
const BEIR_WORKSPACE_SLUG = "beir-nfcorpus"

// Gemini's free-tier embed quota is 100 req/min and embedMany makes one
// API call per input. Local Ollama has no quota. The throttle below only
// runs when USE_OLLAMA is unset.
const EMBED_BATCH = 40
const EMBED_SLEEP_MS = useLocal ? 0 : 35_000
const INSERT_BATCH = 500

// Corpus cap: full NFCorpus is 3633 docs. Set CORPUS_LIMIT=-1 (or omit
// when USE_OLLAMA=1) for the full corpus; default 500 if running through
// quota-limited Gemini.
const DEFAULT_CORPUS_LIMIT = useLocal ? -1 : 500

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface CorpusDoc {
  _id: string
  title: string
  text: string
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * UUID v5-style derivation from an input string. We just hash the string
 * to bytes and format as a UUID. Deterministic so re-seeds produce stable
 * IDs (the qrels use the corpus-id which we map to chunk_id one-way).
 */
async function deterministicUuid(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode("beir-nfcorpus:" + input)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const bytes = new Uint8Array(hash).slice(0, 16)
  // Set version 4 + variant bits so it's a valid UUID
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function loadCorpus(dataDir: string): Promise<CorpusDoc[]> {
  const path = join(dataDir, "corpus.jsonl")
  const raw = await readFile(path, "utf8")
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusDoc)
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const url = process.env.INTEGRATION_DB_URL
  const key = process.env.INTEGRATION_DB_SERVICE_KEY
  const dataDir = process.env.BEIR_DATA
  if (!url || !key || !dataDir) {
    console.error(
      "Missing env. Set INTEGRATION_DB_URL, INTEGRATION_DB_SERVICE_KEY, BEIR_DATA",
    )
    process.exit(1)
  }
  const supabase = createClient(url, key)
  const corpusLimit = process.env.CORPUS_LIMIT
    ? parseInt(process.env.CORPUS_LIMIT, 10)
    : DEFAULT_CORPUS_LIMIT
  const fullCorpus = await loadCorpus(dataDir)
  // Deterministic prefix slice — re-runs seed the same docs.
  const corpus =
    corpusLimit > 0 ? fullCorpus.slice(0, corpusLimit) : fullCorpus
  console.log(
    `Loaded ${corpus.length} corpus documents (out of ${fullCorpus.length} available; limit=${corpusLimit})`,
  )

  // ------------------------------------------------------------------------
  // Idempotency check: already seeded?
  // ------------------------------------------------------------------------
  const { count: existing } = await supabase
    .from("document_section_chunk")
    .select("id", { count: "exact", head: true })
    .in(
      "section_id",
      (
        await supabase
          .from("document_section")
          .select("id")
          .in(
            "document_id",
            (
              await supabase
                .from("documents")
                .select("id")
                .eq("workspace_id", BEIR_WORKSPACE_ID)
            ).data?.map((d) => d.id) ?? [],
          )
      ).data?.map((s) => s.id) ?? [],
    )
  if (existing && existing >= corpus.length) {
    console.log(`Workspace already has ${existing} chunks — nothing to do.`)
    return
  }

  // ------------------------------------------------------------------------
  // Workspace
  // ------------------------------------------------------------------------
  const { error: wsError } = await supabase
    .from("workspaces")
    .upsert(
      [
        {
          id: BEIR_WORKSPACE_ID,
          name: "BEIR NFCorpus",
          slug: BEIR_WORKSPACE_SLUG,
        },
      ],
      { onConflict: "id" },
    )
  if (wsError) throw new Error(`workspace upsert failed: ${wsError.message}`)

  // ------------------------------------------------------------------------
  // Pre-compute deterministic UUIDs so qrels can map corpus-id → chunk_id
  // ------------------------------------------------------------------------
  console.log("Computing deterministic UUIDs...")
  const records = await Promise.all(
    corpus.map(async (doc) => {
      const docId = await deterministicUuid(`doc:${doc._id}`)
      const sectionId = await deterministicUuid(`sec:${doc._id}`)
      const chunkId = await deterministicUuid(`chunk:${doc._id}`)
      const content = `${doc.title}\n\n${doc.text}`.trim()
      return {
        beirId: doc._id,
        docId,
        sectionId,
        chunkId,
        title: doc.title || `(untitled ${doc._id})`,
        content,
      }
    }),
  )

  // ------------------------------------------------------------------------
  // Insert documents + sections in batches (no embeddings needed)
  // ------------------------------------------------------------------------
  console.log("Inserting documents...")
  for (const batch of chunkArray(records, INSERT_BATCH)) {
    const { error } = await supabase.from("documents").upsert(
      batch.map((r) => ({
        id: r.docId,
        workspace_id: BEIR_WORKSPACE_ID,
        title: r.title,
        content: r.content,
        document_type: "source",
      })),
      { onConflict: "id" },
    )
    if (error) throw new Error(`documents upsert failed: ${error.message}`)
  }

  console.log("Inserting sections...")
  for (const batch of chunkArray(records, INSERT_BATCH)) {
    const { error } = await supabase.from("document_section").upsert(
      batch.map((r, i) => ({
        id: r.sectionId,
        document_id: r.docId,
        node_id: `sec-${r.beirId}`,
        heading_title: r.title,
        heading_depth: 1,
        sequence_number: i,
        // ltree label must be alphanumeric/underscore. Use a hash-prefix.
        path: `nfcorpus.${r.sectionId.replace(/-/g, "_")}`,
      })),
      { onConflict: "id" },
    )
    if (error) throw new Error(`sections upsert failed: ${error.message}`)
  }

  // ------------------------------------------------------------------------
  // Streaming embed → insert. Process one batch at a time so peak memory is
  // bounded and a mid-run failure (DB hiccup, OOM, network blip) leaves the
  // already-inserted chunks behind for resume. Re-running the seeder on the
  // same data is a no-op via `on conflict do nothing` checks below.
  // ------------------------------------------------------------------------
  console.log(
    `Streaming embed+insert: ${records.length} chunks (batch=${EMBED_BATCH}, embedder=${useLocal ? "ollama" : "gemini"})...`,
  )
  const tEmbedStart = performance.now()

  // Resume support: skip records whose chunk row already exists.
  const { data: existingChunkRows } = await supabase
    .from("document_section_chunk")
    .select("id")
    .in(
      "id",
      records.map((r) => r.chunkId),
    )
  const existingChunkIds = new Set(
    (existingChunkRows ?? []).map((r) => r.id as string),
  )
  const todo = records.filter((r) => !existingChunkIds.has(r.chunkId))
  console.log(
    `  ${existingChunkIds.size} chunks already present; ${todo.length} remaining`,
  )

  const totalBatches = Math.ceil(todo.length / EMBED_BATCH)
  for (const [i, batch] of chunkArray(todo, EMBED_BATCH).entries()) {
    const batchStart = performance.now()
    const inputs = batch.map((r) => r.content.slice(0, 8000))
    const embeddings = await embedFn(inputs)
    if (embeddings.length !== batch.length) {
      throw new Error(
        `batch ${i}: embed count mismatch ${embeddings.length} vs ${batch.length}`,
      )
    }
    const rows = batch.map((r, j) => ({
      id: r.chunkId,
      section_id: r.sectionId,
      chunk_index: 0,
      content: r.content,
      content_hash: `nfcorpus-${r.beirId}`,
      embedding: embeddings[j]!,
      token_count: Math.ceil(r.content.length / 4),
    }))
    const { error } = await supabase
      .from("document_section_chunk")
      .upsert(rows, { onConflict: "id" })
    if (error) throw new Error(`chunks upsert failed: ${error.message}`)

    const elapsed = performance.now() - batchStart
    process.stdout.write(
      `  batch ${i + 1}/${totalBatches} (${batch.length} docs, ${elapsed.toFixed(0)}ms)\r`,
    )
    if (EMBED_SLEEP_MS > 0 && i + 1 < totalBatches) {
      await new Promise((r) => setTimeout(r, EMBED_SLEEP_MS))
    }
  }
  console.log(
    `\nDone in ${((performance.now() - tEmbedStart) / 1000).toFixed(1)}s`,
  )

  // Persist the corpus-id → chunk_id mapping so the eval script can
  // resolve qrels.
  const map = Object.fromEntries(records.map((r) => [r.beirId, r.chunkId]))
  const mapPath = join(dataDir, "corpus_to_chunk.json")
  await readFile(mapPath, "utf8").catch(() => null)
  const { writeFile } = await import("node:fs/promises")
  await writeFile(mapPath, JSON.stringify(map, null, 2), "utf8")
  console.log(`Wrote ${mapPath}`)

  console.log(`\nDone. Workspace: ${BEIR_WORKSPACE_ID}`)
  console.log(`Inserted ${records.length} documents/sections/chunks.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
