#!/usr/bin/env tsx
// One-time back-fill: populate the `embedding` column on existing kind='topic'
// folders where it is still NULL. New topics get an embedding at insert time
// (see resolveTopicFolders in src/lib/sweep/commit.ts); this catches the rows
// minted before embedding-dedup existed so they participate in dedup too.
//
// Idempotent: re-running only touches rows that are still NULL. Safe to run
// repeatedly (e.g. after a partial run hits a quota error mid-way).
//
//   cd apps/web/app && npm run backfill-topic-embeddings
import { existsSync } from "node:fs"
import { loadEnvFile } from "node:process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, "../.env.local")
if (existsSync(envPath)) loadEnvFile(envPath)

const { createAdminClient } = await import("../src/lib/supabase/admin.js")
const { generateEmbedding } = await import("../src/lib/embeddings.js")

const supabase = createAdminClient()

const { data: rowsRaw, error } = await supabase
  .from("folders")
  .select("id, name, display_name")
  .eq("kind", "topic")
  .is("embedding", null)

if (error) {
  console.error("select failed:", error.message)
  process.exit(1)
}

const rows = (rowsRaw ?? []) as Array<{
  id: string
  name: string
  display_name: string | null
}>

console.log(`found ${rows.length} topic folders without an embedding`)

let ok = 0
let skipped = 0
const errors: Array<{ id: string; name: string; err: string }> = []

for (const row of rows) {
  const text = row.display_name?.trim() || row.name?.trim()
  if (!text) {
    skipped++
    continue
  }
  try {
    const embedding = await generateEmbedding(text, "RETRIEVAL_DOCUMENT")
    const { error: updateError } = await supabase
      .from("folders")
      .update({ embedding })
      .eq("id", row.id)
    if (updateError) throw new Error(updateError.message)
    ok++
    console.log(`ok ${row.id} "${text}"`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errors.push({ id: row.id, name: text, err: msg })
    console.error(`err ${row.id} "${text}": ${msg}`)
  }
}

console.log(`\ndone: ok=${ok} skipped=${skipped} errors=${errors.length} total=${rows.length}`)
if (errors.length > 0) {
  console.log("\nerrors:")
  for (const e of errors) console.log(`  ${e.id} "${e.name}": ${e.err}`)
  process.exit(1)
}
