import {
  llmsTxtOneLine,
  renderLlmsTxt,
  type LlmsTxtDocument,
  type LlmsTxtSection,
} from "@bread/core"
import type {
  PublicDocSummary,
  PublicFolderSummary,
  PublicTaxonomy,
} from "@/lib/public-kb"

// ---------------------------------------------------------------------------
// Portal llms.txt generation.
//
// Every published portal exposes two machine-readable files at its public mount
// (see llms-txt-request.ts for how the URLs are routed):
//
//   <portal>/llms.txt       index: one link per published document, grouped by
//                           folder, each with the document's preview as a note
//   <portal>/llms-full.txt  the same documents with their full markdown bodies
//                           inlined, capped so one enormous KB can't produce an
//                           unbounded response
//
// These builders are PURE — the route feeds them already-scoped data from
// lib/public-kb.ts (the single visibility guard) and they only shape text. They
// must never fetch: a builder that reads would bypass the portal-visibility
// contract that the caller established.
// ---------------------------------------------------------------------------

/** Hard caps for llms-full.txt so a huge KB degrades instead of timing out. */
export const PORTAL_LLMS_FULL_MAX_DOCS = 250
export const PORTAL_LLMS_FULL_MAX_CHARS = 800_000

export interface PortalLlmsIdentity {
  /** Portal display name (branding.name). */
  name: string
  /** Portal tagline, used as the llms.txt summary. */
  tagline?: string
  /**
   * Absolute public base URL of the portal with no trailing slash — the mount a
   * visitor actually uses (`https://docs.acme.com`, `https://acme.com/help`,
   * `https://app.example.com/p/acme/help`). Every emitted link hangs off it.
   */
  portalUrl: string
}

export interface PortalLlmsIndexInput extends PortalLlmsIdentity {
  taxonomy: PublicTaxonomy
  documents: PublicDocSummary[]
}

/** A document body prepared for llms-full.txt. */
export interface PortalLlmsFullDoc {
  title: string
  url: string
  /** Folder trail, e.g. "Guides / Setup". Empty for portal-root documents. */
  section: string
  markdown: string
  updatedAt?: string
}

export interface PortalLlmsFullInput extends PortalLlmsIdentity {
  docs: PortalLlmsFullDoc[]
  /** Total published documents before capping, when more than were included. */
  omittedCount?: number
}

const UNFILED_HEADING = "Other documents"

function trimmedBase(portalUrl: string): string {
  return portalUrl.replace(/\/+$/, "")
}

/**
 * Public URL for a document reference. Slugs may be hierarchical
 * (`guides/setup/install`), so segments are encoded individually — encoding the
 * whole ref would turn its separators into `%2F` and break the route.
 */
export function portalDocUrl(portalUrl: string, ref: string): string {
  const encoded = ref
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")
  return `${trimmedBase(portalUrl)}/doc/${encoded}`
}

function docRef(doc: PublicDocSummary): string {
  return doc.slug?.trim() || doc.id
}

/** Every folder the taxonomy knows about, keyed by id. */
function folderIndex(taxonomy: PublicTaxonomy): Map<string, PublicFolderSummary> {
  const folders = taxonomy.allFolders ?? taxonomy.rootFolders
  return new Map(folders.map((folder) => [folder.id, folder]))
}

/** "Guides / Setup" — the folder trail, so a flat file keeps its hierarchy. */
function folderPath(
  folder: PublicFolderSummary,
  folders: Map<string, PublicFolderSummary>,
): string {
  const trail: string[] = []
  let cursor: PublicFolderSummary | undefined = folder
  let guard = 0
  while (cursor && guard < 16) {
    trail.unshift(cursor.display_name)
    cursor = cursor.parent_folder_id
      ? folders.get(cursor.parent_folder_id)
      : undefined
    guard += 1
  }
  return trail.join(" / ")
}

function byFolderThenTitle(a: PublicDocSummary, b: PublicDocSummary): number {
  const orderA = a.sort_order ?? Number.MAX_SAFE_INTEGER
  const orderB = b.sort_order ?? Number.MAX_SAFE_INTEGER
  if (orderA !== orderB) return orderA - orderB
  return a.title.localeCompare(b.title)
}

function byFolderOrder(
  a: PublicFolderSummary,
  b: PublicFolderSummary,
): number {
  const orderA = a.sort_order ?? Number.MAX_SAFE_INTEGER
  const orderB = b.sort_order ?? Number.MAX_SAFE_INTEGER
  if (orderA !== orderB) return orderA - orderB
  return a.display_name.localeCompare(b.display_name)
}

/**
 * Group documents by folder, in taxonomy order, with portal-root documents last
 * under "Other documents". Folders the taxonomy doesn't expose (a document whose
 * folder is outside the project scope's visible set) fall into the same bucket
 * rather than leaking a folder name.
 */
export function groupPortalDocuments<T extends PublicDocSummary>(
  taxonomy: PublicTaxonomy,
  documents: T[],
): Array<{ heading: string; docs: T[] }> {
  const folders = folderIndex(taxonomy)
  const byFolder = new Map<string, T[]>()
  const unfiled: T[] = []

  for (const doc of documents) {
    const folderId = doc.folder_id ?? null
    if (!folderId || !folders.has(folderId)) {
      unfiled.push(doc)
      continue
    }
    const bucket = byFolder.get(folderId)
    if (bucket) bucket.push(doc)
    else byFolder.set(folderId, [doc])
  }

  const groups: Array<{ heading: string; docs: T[] }> = []
  for (const folder of Array.from(folders.values()).sort(byFolderOrder)) {
    const docs = byFolder.get(folder.id)
    if (!docs || docs.length === 0) continue
    groups.push({
      heading: folderPath(folder, folders),
      docs: docs.slice().sort(byFolderThenTitle),
    })
  }
  if (unfiled.length > 0) {
    groups.push({
      heading: UNFILED_HEADING,
      docs: unfiled.slice().sort(byFolderThenTitle),
    })
  }
  return groups
}

function buildPortalLlmsDocument(
  input: PortalLlmsIndexInput,
): LlmsTxtDocument {
  const portalUrl = trimmedBase(input.portalUrl)
  const groups = groupPortalDocuments(input.taxonomy, input.documents)

  const sections: LlmsTxtSection[] = groups.map((group) => ({
    heading: group.heading,
    links: group.docs.map((doc) => ({
      title: doc.title || "Untitled",
      url: portalDocUrl(portalUrl, docRef(doc)),
      ...(doc.description ? { note: llmsTxtOneLine(doc.description) } : {}),
    })),
  }))

  const total = input.documents.length
  return {
    title: input.name,
    summary: input.tagline?.trim() || `${input.name} knowledge base`,
    details: [
      `${total === 1 ? "1 published document" : `${total} published documents`}, maintained in Bread and published at ${portalUrl}.`,
    ],
    sections: [
      ...sections,
      {
        heading: "Optional",
        links: [
          {
            title: "Full text of every document",
            url: `${portalUrl}/llms-full.txt`,
            note: "one file, all published documents as markdown",
          },
        ],
      },
    ],
  }
}

export function buildPortalLlmsTxt(input: PortalLlmsIndexInput): string {
  return renderLlmsTxt(buildPortalLlmsDocument(input))
}

/**
 * Select the documents that fit inside llms-full.txt's caps, preserving the
 * grouped order so the file reads like the portal's own table of contents.
 */
export function selectPortalLlmsFullDocs<T extends { markdown: string }>(
  docs: T[],
  maxDocs = PORTAL_LLMS_FULL_MAX_DOCS,
  maxChars = PORTAL_LLMS_FULL_MAX_CHARS,
): { included: T[]; omittedCount: number } {
  const included: T[] = []
  let chars = 0
  for (const doc of docs) {
    if (included.length >= maxDocs) break
    // Always take the first document, even if it alone blows the budget — an
    // empty file is worse than an oversized one.
    if (included.length > 0 && chars + doc.markdown.length > maxChars) break
    included.push(doc)
    chars += doc.markdown.length
  }
  return { included, omittedCount: docs.length - included.length }
}

export function buildPortalLlmsFullTxt(input: PortalLlmsFullInput): string {
  const portalUrl = trimmedBase(input.portalUrl)
  const header = [
    `# ${llmsTxtOneLine(input.name) || "Knowledge base"}`,
    `> ${llmsTxtOneLine(input.tagline || `${input.name} knowledge base`)}`,
    `Every published document from ${portalUrl}, as markdown. Maintained in Bread.`,
  ]
  if (input.omittedCount && input.omittedCount > 0) {
    header.push(
      `Truncated: ${input.omittedCount} further ${
        input.omittedCount === 1 ? "document is" : "documents are"
      } omitted from this file. See ${portalUrl}/llms.txt for the complete index.`,
    )
  }

  const bodies = input.docs.map((doc) => {
    const meta = [`URL: ${doc.url}`]
    if (doc.section) meta.push(`Section: ${doc.section}`)
    if (doc.updatedAt) meta.push(`Updated: ${doc.updatedAt}`)
    const markdown = doc.markdown.trim()
    return [
      `## ${llmsTxtOneLine(doc.title) || "Untitled"}`,
      meta.join("\n"),
      markdown || "_This document has no content yet._",
    ].join("\n\n")
  })

  return `${[header.join("\n\n"), ...bodies].join("\n\n---\n\n")}\n`
}
