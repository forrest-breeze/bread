import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { generateEmbedding, generateEmbeddings, type Embedding } from "@/lib/embeddings"
import { stripMediaTagsToText } from "@/lib/storage/media-refs"
import { createAdminClient } from "@/lib/supabase/admin"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProseMirrorMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface ProseMirrorNode {
  type: string
  attrs?: Record<string, unknown>
  content?: ProseMirrorNode[]
  text?: string
  marks?: ProseMirrorMark[]
}

export interface ProseMirrorDoc {
  type: "doc"
  content?: ProseMirrorNode[]
}

export interface ChunkPlan {
  chunkIndex: number
  content: string
  contentHash: string
  tokenCount: number
}

export interface SectionPlan {
  nodeId: string
  parentNodeId: string | null
  headingTitle: string
  headingDepth: number
  sequenceNumber: number
  path: string
  chunks: ChunkPlan[]
}

export interface IngestOptions {
  supabase?: SupabaseClient
  embedder?: (texts: string[]) => Promise<Embedding[]>
  idGenerator?: () => string
  maxCharsPerChunk?: number
  /** Recompute vectors even when the stored chunk hash still matches. */
  forceReembed?: boolean
}

export interface IngestResult {
  sectionCount: number
  chunkCount: number
  sectionsDeleted: number
  chunksDeleted: number
  chunksEmbedded: number
  durationMs: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The implicit-root section's node_id. Always the first label in an ltree
 * path so queries can anchor on "root.*" and `subpath()` works consistently.
 * Length (4) cannot collide with the 8-char IDs produced by generateNodeId().
 */
export const ROOT_NODE_ID = "root"

const DEFAULT_MAX_CHARS = 1800
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateNodeId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < 8; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  return out
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

const BLOCK_TYPES: ReadonlySet<string> = new Set([
  "doc",
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
])

export function nodeToText(node: ProseMirrorNode): string {
  if (node.type === "text") return node.text ?? ""
  if (node.type === "hardBreak") return "\n"
  if (node.type === "mermaidDiagram") {
    const source = node.attrs?.source
    return typeof source === "string" ? source.trim() : ""
  }
  if (!node.content || node.content.length === 0) return ""
  const parts = node.content.map(nodeToText)
  if (BLOCK_TYPES.has(node.type)) {
    return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()
  }
  return parts.join("")
}

function headingTitleText(node: ProseMirrorNode): string {
  return nodeToText(node).replace(/\s+/g, " ").trim()
}

function headingLevel(node: ProseMirrorNode): number {
  const raw = node.attrs?.level
  const lvl = typeof raw === "number" ? raw : Number(raw ?? 1)
  if (!Number.isFinite(lvl)) return 1
  return Math.max(1, Math.min(6, Math.floor(lvl)))
}

function readNodeId(node: ProseMirrorNode): string | null {
  const raw = node.attrs?.nodeId
  return typeof raw === "string" && raw.length > 0 ? raw : null
}

// ---------------------------------------------------------------------------
// Section tree folding
// ---------------------------------------------------------------------------

interface FlatGroup {
  heading: ProseMirrorNode | null
  depth: number
  nodes: ProseMirrorNode[]
  sequence: number
}

export function groupTopLevelNodes(doc: ProseMirrorDoc): FlatGroup[] {
  const groups: FlatGroup[] = []
  const initial: FlatGroup = {
    heading: null,
    depth: 0,
    nodes: [],
    sequence: 0,
  }
  groups.push(initial)
  let current = initial
  let seq = 0
  for (const node of doc.content ?? []) {
    if (node.type === "heading") {
      seq += 1
      current = {
        heading: node,
        depth: headingLevel(node),
        nodes: [],
        sequence: seq,
      }
      groups.push(current)
    } else {
      current.nodes.push(node)
    }
  }
  return groups
}

export interface FoldedSection {
  nodeId: string
  parentNodeId: string | null
  headingTitle: string
  headingDepth: number
  sequenceNumber: number
  nodes: ProseMirrorNode[]
  pathLabels: string[]
}

export function buildSectionsFromDoc(
  doc: ProseMirrorDoc,
  idGenerator: () => string = generateNodeId,
): FoldedSection[] {
  const groups = groupTopLevelNodes(doc)
  const usedIds = new Set<string>([ROOT_NODE_ID])

  const root: FoldedSection = {
    nodeId: ROOT_NODE_ID,
    parentNodeId: null,
    headingTitle: "",
    headingDepth: 0,
    sequenceNumber: 0,
    nodes: [],
    pathLabels: [ROOT_NODE_ID],
  }

  const out: FoldedSection[] = [root]
  const stack: FoldedSection[] = [root]

  for (const group of groups) {
    if (group.heading === null) {
      // Pre-heading content (only ever the first group) collapses into root.
      root.nodes.push(...group.nodes)
      continue
    }

    const depth = group.depth
    let nodeId = readNodeId(group.heading) ?? idGenerator()
    while (usedIds.has(nodeId)) nodeId = idGenerator()
    usedIds.add(nodeId)

    // Pop ancestors whose depth >= this one. Root (depth 0) never pops.
    while (stack.length > 1 && stack[stack.length - 1].headingDepth >= depth) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    const section: FoldedSection = {
      nodeId,
      parentNodeId: parent.nodeId,
      headingTitle: headingTitleText(group.heading),
      headingDepth: depth,
      sequenceNumber: group.sequence,
      nodes: group.nodes,
      pathLabels: [...parent.pathLabels, nodeId],
    }
    out.push(section)
    stack.push(section)
  }
  return out
}

// ---------------------------------------------------------------------------
// Chunking
// Atomic at the node level — never splits inside a codeBlock, table,
// blockquote, or listItem. Concatenates adjacent nodes until the next one
// would push the buffer past max; if a single node exceeds max, it becomes
// its own chunk.
// ---------------------------------------------------------------------------

export function chunkSectionNodes(
  nodes: ProseMirrorNode[],
  opts: { maxChars?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const chunks: string[] = []
  let buf = ""

  for (const node of nodes) {
    const text = nodeToText(node).trim()
    if (text.length === 0) continue

    const sep = buf.length === 0 ? "" : "\n\n"
    const projected = buf.length + sep.length + text.length

    if (buf.length > 0 && projected > maxChars) {
      chunks.push(buf)
      buf = text
    } else {
      buf = `${buf}${sep}${text}`
    }
  }
  if (buf.length > 0) chunks.push(buf)
  return chunks
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

// ---------------------------------------------------------------------------
// Plain-text / Markdown → ProseMirror
// Minimal converter for content that wasn't authored in the editor (API
// captures, capture buffer promotions, topic-page generator, agent writes).
// We only look for ATX-style `#` headings — paragraph, list, and code-fence
// fidelity is not needed for retrieval since the chunker walks flat text
// anyway. The headings matter because they drive section structure, which is
// what lets the retrieval result surface a useful breadcrumb in
// `formatForLLM`.
// ---------------------------------------------------------------------------

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function textToProseMirrorDoc(text: string): ProseMirrorDoc {
  // Strip binary media tags before this body becomes embedded text. The
  // fallback can contain `<img>` / `<video>` references to `/api/media/<id>`;
  // preserve only their descriptive labels so URLs never enter vector text.
  const stripped = stripMediaTagsToText(text ?? "");
  const normalized = stripped.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const nodes: ProseMirrorNode[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    const joined = paragraphLines.join("\n").trim();
    paragraphLines = [];
    if (joined.length === 0) return;
    nodes.push({
      type: "paragraph",
      content: [{ type: "text", text: joined }],
    });
  };

  for (const line of lines) {
    const headingMatch = line.match(HEADING_LINE);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const title = headingMatch[2];
      nodes.push({
        type: "heading",
        attrs: { level },
        content: [{ type: "text", text: title }],
      });
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    paragraphLines.push(line);
  }
  flushParagraph();

  return { type: "doc", content: nodes };
}

/** Awaitable ingest entry point for callers that must bound indexing work. */
export async function ingestFromText(
  documentId: string,
  text: string,
): Promise<void> {
  if (!text || text.trim().length === 0) return;
  const doc = textToProseMirrorDoc(text);
  await ingestDocument(documentId, doc);
}

/**
 * Fire-and-forget ingest entry point for user-visible write paths. Errors are
 * logged because indexing failure must not break the write that triggered it.
 */
export function fireIngestFromText(documentId: string, text: string): void {
  void ingestFromText(documentId, text).catch((err) => {
    console.error("[Bread] fireIngestFromText failed:", err);
  });
}

/** Awaitable document-vector refresh for callers that bound background work. */
export async function updateDocumentEmbedding(
  documentId: string,
  workspaceId: string,
  content: string,
): Promise<void> {
  if (!content || content.trim().length === 0) return;
  const embedding = await generateEmbedding(content, "RETRIEVAL_DOCUMENT");
  const admin = createAdminClient();
  const { error } = await admin
    .from("documents")
    .update({ embedding })
    .eq("id", documentId)
    .eq("workspace_id", workspaceId);
  if (error) throw error;
}

/**
 * Fire-and-forget refresh of `documents.embedding`. Safe alongside section
 * ingestion because the two paths write different tables/columns.
 */
export function fireDocumentEmbeddingUpdate(
  documentId: string,
  workspaceId: string,
  content: string,
): void {
  void updateDocumentEmbedding(documentId, workspaceId, content).catch((err) => {
    console.error("[Bread] Document embedding regeneration failed:", err);
  });
}

// ---------------------------------------------------------------------------
// Full ingestion plan (pure)
// ---------------------------------------------------------------------------

export function planIngestion(
  doc: ProseMirrorDoc,
  opts: { maxCharsPerChunk?: number; idGenerator?: () => string } = {},
): SectionPlan[] {
  const sections = buildSectionsFromDoc(doc, opts.idGenerator ?? generateNodeId)
  return sections.map((s) => ({
    nodeId: s.nodeId,
    parentNodeId: s.parentNodeId,
    headingTitle: s.headingTitle,
    headingDepth: s.headingDepth,
    sequenceNumber: s.sequenceNumber,
    path: s.pathLabels.join("."),
    chunks: chunkSectionNodes(s.nodes, { maxChars: opts.maxCharsPerChunk }).map(
      (content, i) => ({
        chunkIndex: i,
        content,
        contentHash: hashContent(content),
        tokenCount: Math.ceil(content.length / 4),
      }),
    ),
  }))
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

interface ExistingSectionRow {
  id: string
  node_id: string
}

interface ExistingChunkRow {
  id: string
  section_id: string
  chunk_index: number
  content_hash: string
}

interface UpsertedSectionRow {
  id: string
  node_id: string
}

export async function ingestDocument(
  documentId: string,
  tiptapDoc: ProseMirrorDoc,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const started = Date.now()
  const supabase = opts.supabase ?? createAdminClient()
  const embedder =
    opts.embedder ??
    ((texts: string[]): Promise<Embedding[]> =>
      generateEmbeddings(texts, "RETRIEVAL_DOCUMENT"))

  const plans = planIngestion(tiptapDoc, {
    maxCharsPerChunk: opts.maxCharsPerChunk,
    idGenerator: opts.idGenerator,
  })

  // -- Load existing state --------------------------------------------------
  const { data: existingSectionsRaw, error: sErr } = await supabase
    .from("document_section")
    .select("id, node_id")
    .eq("document_id", documentId)
  if (sErr) throw new Error(`[ingestDocument] load sections: ${sErr.message}`)
  const existingSections = (existingSectionsRaw ?? []) as ExistingSectionRow[]

  const existingSectionIdByNodeId = new Map<string, string>()
  const nodeIdBySectionId = new Map<string, string>()
  for (const row of existingSections) {
    existingSectionIdByNodeId.set(row.node_id, row.id)
    nodeIdBySectionId.set(row.id, row.node_id)
  }

  let existingChunks: ExistingChunkRow[] = []
  if (existingSectionIdByNodeId.size > 0) {
    const { data, error } = await supabase
      .from("document_section_chunk")
      .select("id, section_id, chunk_index, content_hash")
      .in("section_id", [...existingSectionIdByNodeId.values()])
    if (error) throw new Error(`[ingestDocument] load chunks: ${error.message}`)
    existingChunks = (data ?? []) as ExistingChunkRow[]
  }

  const existingChunkByKey = new Map<string, { id: string; content_hash: string }>()
  for (const c of existingChunks) {
    const nodeId = nodeIdBySectionId.get(c.section_id)
    if (!nodeId) continue
    existingChunkByKey.set(`${nodeId}:${c.chunk_index}`, {
      id: c.id,
      content_hash: c.content_hash,
    })
  }

  // -- Decide which chunks need (re-)embedding ------------------------------
  const chunksToEmbed: Array<{
    nodeId: string
    chunkIndex: number
    content: string
    contentHash: string
    tokenCount: number
  }> = []
  for (const plan of plans) {
    for (const chunk of plan.chunks) {
      const key = `${plan.nodeId}:${chunk.chunkIndex}`
      const existing = existingChunkByKey.get(key)
      if (
        opts.forceReembed ||
        !existing ||
        existing.content_hash !== chunk.contentHash
      ) {
        chunksToEmbed.push({
          nodeId: plan.nodeId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          contentHash: chunk.contentHash,
          tokenCount: chunk.tokenCount,
        })
      }
    }
  }

  // -- Embed first (slowest op, cheap to retry if DB writes fail after) -----
  let embeddings: Embedding[] = []
  if (chunksToEmbed.length > 0) {
    embeddings = await embedder(chunksToEmbed.map((c) => c.content))
    if (embeddings.length !== chunksToEmbed.length) {
      throw new Error(
        `[ingestDocument] embedder returned ${embeddings.length} vectors for ${chunksToEmbed.length} inputs`,
      )
    }
  }

  // -- Upsert sections (single pass; parent/ancestor queries use ltree path)
  const now = new Date().toISOString()
  const sectionRows = plans.map((p) => ({
    document_id: documentId,
    node_id: p.nodeId,
    heading_title: p.headingTitle,
    heading_depth: p.headingDepth,
    sequence_number: p.sequenceNumber,
    path: p.path,
    updated_at: now,
  }))

  const { data: upsertedRaw, error: upSecErr } = await supabase
    .from("document_section")
    .upsert(sectionRows, { onConflict: "document_id,node_id" })
    .select("id, node_id")
  if (upSecErr) throw new Error(`[ingestDocument] upsert sections: ${upSecErr.message}`)
  const upserted = (upsertedRaw ?? []) as UpsertedSectionRow[]

  const sectionIdByNodeId = new Map<string, string>()
  for (const row of upserted) sectionIdByNodeId.set(row.node_id, row.id)

  // -- Upsert chunks -------------------------------------------------------
  if (chunksToEmbed.length > 0) {
    const chunkRows = chunksToEmbed.map((c, i) => {
      const sectionId = sectionIdByNodeId.get(c.nodeId)
      if (!sectionId) {
        throw new Error(`[ingestDocument] no section id for node ${c.nodeId}`)
      }
      return {
        section_id: sectionId,
        chunk_index: c.chunkIndex,
        content: c.content,
        content_hash: c.contentHash,
        embedding: embeddings[i],
        token_count: c.tokenCount,
      }
    })
    const { error } = await supabase
      .from("document_section_chunk")
      .upsert(chunkRows, { onConflict: "section_id,chunk_index" })
    if (error) throw new Error(`[ingestDocument] upsert chunks: ${error.message}`)
  }

  // -- Delete sections that vanished (chunks cascade) ----------------------
  const plannedNodeIds = new Set(plans.map((p) => p.nodeId))
  const sectionsToDelete: string[] = []
  for (const [nodeId, id] of existingSectionIdByNodeId) {
    if (!plannedNodeIds.has(nodeId)) sectionsToDelete.push(id)
  }
  let sectionsDeleted = 0
  if (sectionsToDelete.length > 0) {
    const { error } = await supabase
      .from("document_section")
      .delete()
      .in("id", sectionsToDelete)
    if (error) throw new Error(`[ingestDocument] delete sections: ${error.message}`)
    sectionsDeleted = sectionsToDelete.length
  }

  // -- Delete chunks whose index is beyond the new plan --------------------
  const chunksToDelete: string[] = []
  const planByNodeId = new Map(plans.map((p) => [p.nodeId, p]))
  for (const existing of existingChunks) {
    const nodeId = nodeIdBySectionId.get(existing.section_id)
    if (!nodeId || !plannedNodeIds.has(nodeId)) continue
    const plan = planByNodeId.get(nodeId)
    if (!plan) continue
    if (existing.chunk_index >= plan.chunks.length) {
      chunksToDelete.push(existing.id)
    }
  }
  let chunksDeleted = 0
  if (chunksToDelete.length > 0) {
    const { error } = await supabase
      .from("document_section_chunk")
      .delete()
      .in("id", chunksToDelete)
    if (error) throw new Error(`[ingestDocument] delete chunks: ${error.message}`)
    chunksDeleted = chunksToDelete.length
  }

  return {
    sectionCount: plans.length,
    chunkCount: plans.reduce((acc, p) => acc + p.chunks.length, 0),
    sectionsDeleted,
    chunksDeleted,
    chunksEmbedded: chunksToEmbed.length,
    durationMs: Date.now() - started,
  }
}
