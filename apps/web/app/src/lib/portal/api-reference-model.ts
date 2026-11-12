import type {
  PublicDocSummary,
  PublicDocWithContent,
  PublicFolderSummary,
  PublicTaxonomy,
} from "@/lib/public-kb"

export const API_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const

export type ApiHttpMethod = (typeof API_HTTP_METHODS)[number]

export interface ApiReferenceSection {
  id: string
  anchorId: string
  /** Public slug used to address this endpoint's own page; falls back to `id`. */
  slug: string
  title: string
  folderId: string | null
  groupLabel: string
  method: ApiHttpMethod | null
  path: string | null
  html: string
  examplesHtml?: string
}

const METHOD_PATTERN = API_HTTP_METHODS.join("|")
const TITLE_OPERATION_RE = new RegExp(
  `^(${METHOD_PATTERN})(?:\\s+|\\s*[:—–-]\\s*)(.*)$`,
)
const CONTENT_OPERATION_RE = new RegExp(
  `(?:^|\\n)\\s*(?:#{1,6}\\s+|[-*]\\s+)?(${METHOD_PATTERN})\\s+(\\/[^\\s\u0060<]+)`,
  "m",
)
const PATH_RE = /\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%/{\}-]*/

export function parseApiOperation(
  title: string,
  content = "",
): { method: ApiHttpMethod | null; path: string | null } {
  const titleMatch = TITLE_OPERATION_RE.exec(title.trim())
  if (titleMatch) {
    const method = titleMatch[1] as ApiHttpMethod
    const path = PATH_RE.exec(titleMatch[2] ?? "")?.[0] ?? null
    return { method, path }
  }

  // Visual editing saves HTML; imports may still contain Markdown.
  // Preserve block boundaries and unwrap inline formatting for method badges.
  const operationText = content
    .replace(/<\/(?:h[1-6]|p|div|li|pre)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
  const contentMatch = CONTENT_OPERATION_RE.exec(operationText)
  return contentMatch
    ? {
        method: contentMatch[1] as ApiHttpMethod,
        path: contentMatch[2] ?? null,
      }
    : { method: null, path: null }
}

function folderSortValue(folder: PublicFolderSummary | undefined): number {
  return folder?.sort_order ?? Number.MAX_SAFE_INTEGER
}

function compareDocuments(
  left: PublicDocSummary,
  right: PublicDocSummary,
  folders: Map<string, PublicFolderSummary>,
): number {
  const leftFolder = left.folder_id ? folders.get(left.folder_id) : undefined
  const rightFolder = right.folder_id ? folders.get(right.folder_id) : undefined
  const folderOrder = folderSortValue(leftFolder) - folderSortValue(rightFolder)
  if (folderOrder !== 0) return folderOrder
  const folderName = (leftFolder?.display_name ?? "").localeCompare(
    rightFolder?.display_name ?? "",
  )
  if (folderName !== 0) return folderName
  const documentOrder =
    (left.sort_order ?? Number.MAX_SAFE_INTEGER) -
    (right.sort_order ?? Number.MAX_SAFE_INTEGER)
  if (documentOrder !== 0) return documentOrder
  return left.title.localeCompare(right.title)
}

/**
 * Resolve the endpoint a request addresses. `null` selects the first endpoint,
 * which is what the reference's own root URL renders; an unknown ref resolves to
 * nothing so the route can 404 instead of silently serving the wrong endpoint.
 */
export function findApiReferenceSection<
  Section extends { id: string; slug: string },
>(sections: Section[], ref: string | null | undefined): Section | null {
  if (!ref) return sections[0] ?? null
  return (
    sections.find(
      (section) => section.slug === ref || section.id === ref,
    ) ?? null
  )
}

/**
 * Reference order: folder order first, then position within the folder. Split
 * out from section building so a route can find the first (or a named) endpoint
 * without rendering every document's HTML.
 */
export function sortApiReferenceDocuments<Doc extends PublicDocSummary>(
  documents: Doc[],
  taxonomy: PublicTaxonomy,
): Doc[] {
  const folders = new Map(
    (taxonomy.allFolders ?? taxonomy.rootFolders).map((folder) => [
      folder.id,
      folder,
    ]),
  )
  return [...documents].sort((left, right) =>
    compareDocuments(left, right, folders),
  )
}

export function buildApiReferenceSections(
  documents: PublicDocWithContent[],
  taxonomy: PublicTaxonomy,
  renderHtml: (content: string) => string,
): ApiReferenceSection[] {
  const folders = new Map(
    (taxonomy.allFolders ?? taxonomy.rootFolders).map((folder) => [
      folder.id,
      folder,
    ]),
  )

  return sortApiReferenceDocuments(documents, taxonomy)
    .map((document) => {
      const folder = document.folder_id
        ? folders.get(document.folder_id)
        : undefined
      const operation = parseApiOperation(document.title, document.content)
      return {
        id: document.id,
        anchorId: `api-doc-${document.id}`,
        slug: document.slug || document.id,
        title: document.title || "Untitled",
        folderId: document.folder_id ?? null,
        groupLabel: folder?.display_name || "Overview",
        method: operation.method,
        path: operation.path,
        html: renderHtml(document.content),
      }
    })
}
