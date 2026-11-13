/**
 * The repository layout used by ReadMe's GitHub integration, and how it maps
 * onto a Breezify workspace.
 *
 *   <root>/docs/_order.yaml                 order of the guide categories
 *   <root>/docs/<category>/_order.yaml      order of the pages in a category
 *   <root>/docs/<category>/<page>.md        a page
 *   <root>/docs/<category>/<page>/index.md  a page that has child pages
 *   <root>/reference/<spec>.json|.yaml      OpenAPI definitions
 *   <root>/reference/**.md                  reference pages (API stubs are skipped)
 *   <root>/recipes/, custom_pages/, changelogs/
 *
 * Guide categories become top-level Breezify folders and loose pages in `docs/`
 * become folderless documents, so a workspace that was never linked exports to
 * `docs/` naturally. Every other section is one top-level folder.
 *
 * Everything in this file is pure.
 */

export const README_SECTIONS = [
  'docs',
  'reference',
  'recipes',
  'custom_pages',
  'changelogs',
] as const
export type ReadmeSection = (typeof README_SECTIONS)[number]

export const README_SECTION_TITLES: Record<ReadmeSection, string> = {
  docs: 'Guides',
  reference: 'API Reference',
  recipes: 'Recipes',
  custom_pages: 'Custom Pages',
  changelogs: 'Changelog',
}

export const README_ORDER_FILE = '_order.yaml'
export const README_FOLDER_KIND = 'github_readme_folder'
export const README_MAX_PAGES = 1000
export const README_MAX_PAGE_BYTES = 512 * 1024
/** ReadMe's sidebar nests five levels; allow some slack for the section root. */
export const README_MAX_DEPTH = 8

/** `paths[0]` value stored for a project at the repository root. */
export const README_REPOSITORY_ROOT = '.'

export interface ReadmeTreeFile {
  path: string
  sha: string
  size: number
}

export interface ReadmeTreeEntryLike {
  path: string
  type: string
  sha: string
  size?: number
}

/** Normalize a user-supplied project root. '' is the repository root. */
export function normalizeReadmeRoot(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '' || trimmed === README_REPOSITORY_ROOT) return ''
  if (trimmed.length > 512) return null
  const segments = trimmed.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git' ||
        !/^[A-Za-z0-9._ -]+$/.test(segment),
    )
  ) {
    return null
  }
  return segments.join('/')
}

export function storedReadmeRoot(root: string): string {
  return root === '' ? README_REPOSITORY_ROOT : root
}

export function readmeRootFromPaths(paths: readonly string[] | null | undefined): string {
  return normalizeReadmeRoot(paths?.[0] ?? '') ?? ''
}

export function joinReadmePath(root: string, relative: string): string {
  return root ? `${root}/${relative}` : relative
}

/** Path relative to the project root, or null when it is outside the root. */
export function relativeReadmePath(root: string, path: string): string | null {
  if (!root) return path
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
}

export function readmeSectionOf(relativePath: string): ReadmeSection | null {
  const first = relativePath.split('/')[0] as ReadmeSection
  return README_SECTIONS.includes(first) ? first : null
}

export function isReadmePagePath(relativePath: string): boolean {
  return /\.(?:md|mdx)$/i.test(relativePath) && readmeSectionOf(relativePath) !== null
}

export function basenameWithoutExtension(path: string): string {
  const name = path.split('/').at(-1) ?? ''
  return name.replace(/\.(?:md|mdx|json|ya?ml)$/i, '')
}

export function directoryOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export function isIndexPage(relativePath: string): boolean {
  return /^index$/i.test(basenameWithoutExtension(relativePath))
}

export interface ReadmeTreeClassification {
  /** Markdown/MDX pages inside a section, including `index` pages. */
  pages: ReadmeTreeFile[]
  orderFiles: ReadmeTreeFile[]
  /** JSON/YAML files under `reference/` that may be OpenAPI definitions. */
  specCandidates: ReadmeTreeFile[]
}

export function classifyReadmeTree(
  entries: readonly ReadmeTreeEntryLike[],
  root: string,
): ReadmeTreeClassification {
  const result: ReadmeTreeClassification = { pages: [], orderFiles: [], specCandidates: [] }
  for (const entry of entries) {
    if (entry.type !== 'blob') continue
    const relative = relativeReadmePath(root, entry.path)
    if (relative === null) continue
    const section = readmeSectionOf(relative)
    if (!section) continue
    const segments = relative.split('/')
    if (segments.length > README_MAX_DEPTH + 1) continue
    if (segments.some((segment) => segment.startsWith('.'))) continue
    const file = { path: entry.path, sha: entry.sha, size: entry.size ?? 0 }
    const name = segments.at(-1)!
    if (name === README_ORDER_FILE) {
      result.orderFiles.push(file)
    } else if (/\.(?:md|mdx)$/i.test(name)) {
      result.pages.push(file)
    } else if (section === 'reference' && /\.(?:json|ya?ml)$/i.test(name)) {
      result.specCandidates.push(file)
    }
  }
  const byPath = (a: ReadmeTreeFile, b: ReadmeTreeFile): number => a.path.localeCompare(b.path)
  result.pages.sort(byPath)
  result.orderFiles.sort(byPath)
  result.specCandidates.sort(byPath)
  return result
}

/**
 * The directory whose folder holds a page's siblings. `docs` itself has no
 * folder (its children sit at the workspace root), so it maps to null. For an
 * `index` page this is the directory the page describes.
 */
export function folderDirectoryOf(relativeDirectory: string): string | null {
  return relativeDirectory === 'docs' || relativeDirectory === '' ? null : relativeDirectory
}

/** The directory whose folder contains this directory's folder. */
export function parentFolderDirectory(relativeDirectory: string): string | null {
  return folderDirectoryOf(directoryOf(relativeDirectory))
}

/**
 * Every directory that needs a Breezify folder, parents before children.
 * Directories are relative to the project root.
 */
export function readmeFolderDirectories(relativePagePaths: readonly string[]): string[] {
  const directories = new Set<string>()
  for (const path of relativePagePaths) {
    const segments = path.split('/').slice(0, -1)
    for (let depth = 1; depth <= segments.length; depth++) {
      const directory = segments.slice(0, depth).join('/')
      if (folderDirectoryOf(directory) !== null) directories.add(directory)
    }
  }
  return [...directories].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  )
}

export function prettifySegment(segment: string): string {
  // ReadMe names category folders after the category title; keep those as-is.
  if (/[A-Z ]/.test(segment)) return segment.trim()
  return segment
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

export function directoryDisplayName(relativeDirectory: string): string {
  if (!relativeDirectory.includes('/')) {
    const section = readmeSectionOf(relativeDirectory)
    if (section) return README_SECTION_TITLES[section]
  }
  return prettifySegment(relativeDirectory.split('/').at(-1) ?? relativeDirectory)
}

export function slugifySegment(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .replace(/[-.]+$/g, '')
  return slug || fallback
}

// ---------------------------------------------------------------------------
// State recorded on the source row and on each linked document / folder.
// ---------------------------------------------------------------------------

export interface ReadmeOrderFileState {
  sha: string
  entries: string[]
}

export interface ReadmeSkippedFile {
  path: string
  reason: string
  /** Blob that was skipped, so an unchanged file is not fetched again. */
  sha?: string
  /** True when the file is deliberately ignored rather than broken. */
  quiet?: boolean
}

export interface ReadmeSyncState {
  format: 'readme'
  root: string
  /** `_order.yaml` files keyed by repository path. */
  order_files: Record<string, ReadmeOrderFileState>
  /** Repository paths Breezify created or imported and may update or delete. */
  managed_paths: string[]
  /** Files that were seen but not imported, for display in Settings. */
  skipped: ReadmeSkippedFile[]
}

export function readReadmeSyncState(value: unknown, root: string): ReadmeSyncState {
  const empty: ReadmeSyncState = {
    format: 'readme',
    root,
    order_files: {},
    managed_paths: [],
    skipped: [],
  }
  if (typeof value !== 'object' || value === null) return empty
  const raw = value as Record<string, unknown>
  if (raw.format !== 'readme' || raw.root !== root) return empty
  const orderFiles: Record<string, ReadmeOrderFileState> = {}
  if (typeof raw.order_files === 'object' && raw.order_files !== null) {
    for (const [path, entry] of Object.entries(raw.order_files as Record<string, unknown>)) {
      const state = entry as { sha?: unknown; entries?: unknown }
      if (typeof state?.sha !== 'string' || !Array.isArray(state.entries)) continue
      orderFiles[path] = {
        sha: state.sha,
        entries: state.entries.filter((item): item is string => typeof item === 'string'),
      }
    }
  }
  return {
    format: 'readme',
    root,
    order_files: orderFiles,
    managed_paths: Array.isArray(raw.managed_paths)
      ? raw.managed_paths.filter((item): item is string => typeof item === 'string')
      : [],
    skipped: Array.isArray(raw.skipped)
      ? raw.skipped.flatMap((item) => {
          const entry = item as {
            path?: unknown
            reason?: unknown
            sha?: unknown
            quiet?: unknown
          }
          return typeof entry?.path === 'string' && typeof entry.reason === 'string'
            ? [{
                path: entry.path,
                reason: entry.reason,
                ...(typeof entry.sha === 'string' ? { sha: entry.sha } : {}),
                ...(entry.quiet === true ? { quiet: true } : {}),
              }]
            : []
        })
      : [],
  }
}

/** The link between a Breezify document and its repository file. */
export interface ReadmeDocumentLink {
  /** Repository path of the file. */
  path: string
  blobSha: string | null
  /** Hash of the Markdown Breezify held when it last matched the repository. */
  markdownHash: string | null
  title: string | null
  hidden: boolean
  frontmatter: Record<string, unknown> | null
  /** The frontmatter text as it is in the repository file. */
  frontmatterRaw: string | null
  conflict: boolean
}

export function readReadmeDocumentLink(
  metadata: Record<string, unknown> | null | undefined,
  repoId: number,
): ReadmeDocumentLink | null {
  if (!metadata) return null
  if (metadata.github_hosted_sync !== true) return null
  if (metadata.repo_format !== 'readme' || Number(metadata.repo_id) !== repoId) return null
  if (typeof metadata.canonical_repo_path !== 'string') return null
  const frontmatter = metadata.readme_frontmatter
  return {
    path: metadata.canonical_repo_path,
    blobSha:
      typeof metadata.github_hosted_checkpoint_blob_sha === 'string'
        ? metadata.github_hosted_checkpoint_blob_sha
        : null,
    markdownHash:
      typeof metadata.readme_markdown_hash === 'string' ? metadata.readme_markdown_hash : null,
    title: typeof metadata.readme_title === 'string' ? metadata.readme_title : null,
    hidden: metadata.readme_hidden === true,
    frontmatter:
      typeof frontmatter === 'object' && frontmatter !== null && !Array.isArray(frontmatter)
        ? (frontmatter as Record<string, unknown>)
        : null,
    frontmatterRaw:
      typeof metadata.readme_frontmatter_raw === 'string' ? metadata.readme_frontmatter_raw : null,
    conflict: metadata.github_hosted_conflict === true,
  }
}

/** The link between a Breezify folder and its repository directory. */
export interface ReadmeFolderLink {
  /** Repository path of the directory. */
  path: string
  indexPath: string | null
  indexBlobSha: string | null
  indexMarkdownHash: string | null
  indexTitle: string | null
  indexFrontmatter: Record<string, unknown> | null
  indexFrontmatterRaw?: string | null
}

export function readReadmeFolderLink(
  metadata: Record<string, unknown> | null | undefined,
  repoId: number,
): ReadmeFolderLink | null {
  if (!metadata) return null
  if (metadata.kind !== README_FOLDER_KIND || Number(metadata.repo_id) !== repoId) return null
  if (typeof metadata.path !== 'string') return null
  const frontmatter = metadata.index_frontmatter
  const string = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    path: metadata.path,
    indexPath: string(metadata.index_path),
    indexBlobSha: string(metadata.index_blob_sha),
    indexMarkdownHash: string(metadata.index_markdown_hash),
    indexTitle: string(metadata.index_title),
    indexFrontmatter:
      typeof frontmatter === 'object' && frontmatter !== null && !Array.isArray(frontmatter)
        ? (frontmatter as Record<string, unknown>)
        : null,
    indexFrontmatterRaw: string(metadata.index_frontmatter_raw),
  }
}

export function readmeFolderMetadata(repoId: number, link: ReadmeFolderLink): Record<string, unknown> {
  return {
    kind: README_FOLDER_KIND,
    repo_id: repoId,
    path: link.path,
    index_path: link.indexPath,
    index_blob_sha: link.indexBlobSha,
    index_markdown_hash: link.indexMarkdownHash,
    index_title: link.indexTitle,
    index_frontmatter: link.indexFrontmatter,
    index_frontmatter_raw: link.indexFrontmatterRaw ?? null,
  }
}
