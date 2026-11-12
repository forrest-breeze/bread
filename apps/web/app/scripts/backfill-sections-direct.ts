#!/usr/bin/env tsx
import { existsSync } from "node:fs"
import { loadEnvFile } from "node:process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, "../.env.local")
if (existsSync(envPath)) loadEnvFile(envPath)

const { createAdminClient } = await import("../src/lib/supabase/admin.js")
const { ingestDocument, textToProseMirrorDoc } = await import("../src/rag/ingest.js")

const supabase = createAdminClient()

const { data: docsRaw, error } = await supabase
  .from("documents")
  .select("id, title, content, document_section!left(id)")
  .eq("status", "Published")
  .is("document_section.id", null)

if (error) {
  console.error("select failed:", error.message)
  process.exit(1)
}

const docs = (docsRaw ?? []) as Array<{
  id: string
  title: string
  content: string | null
  document_section: { id: string }[]
}>

console.log(`found ${docs.length} docs without sections`)

let ok = 0
let skipped = 0
const errors: Array<{ id: string; title: string; err: string }> = []

for (const doc of docs) {
  if (!doc.content || doc.content.trim().length === 0) {
    skipped++
    continue
  }
  try {
    const pm = textToProseMirrorDoc(doc.content)
    const result = await ingestDocument(doc.id, pm)
    ok++
    console.log(`ok ${doc.id} "${doc.title}" -> ${result.sectionCount}s/${result.chunkCount}c`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errors.push({ id: doc.id, title: doc.title, err: msg })
    console.error(`err ${doc.id} "${doc.title}": ${msg}`)
  }
}

console.log(`\ndone: ok=${ok} skipped=${skipped} errors=${errors.length} total=${docs.length}`)
if (errors.length > 0) {
  console.log("\nerrors:")
  for (const e of errors) console.log(`  ${e.id} "${e.title}": ${e.err}`)
}
