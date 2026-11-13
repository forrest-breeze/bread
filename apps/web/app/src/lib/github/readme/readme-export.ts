import { createHash } from 'node:crypto'
import {
  mergeReadmeFrontmatter,
  parseReadmeFile,
  serializeOrderFile,
  serializeReadmeFile,
} from './readme-frontmatter'
import {
  basenameWithoutExtension,
  directoryOf,
  joinReadmePath,
  readmeSectionOf,
  README_ORDER_FILE,
  relativeReadmePath,
  slugifySegment,
  type ReadmeDocumentLink,
  type ReadmeFolderLink,
  type ReadmeOrderFileState,
  type ReadmeSyncState,
} from './readme-layout'

/**
 * Workspace -> repository, for the ReadMe format.
 *
 * The plan is computed from blob SHAs alone: a document that still matches
 * what the last sync recorded is not rendered at all, so files nobody edited
 * in Breezify are never rewritten (and keep any MDX the editor cannot express).
 *
 * Pure: no database or network access.
 */

/** GitHub's blob object ID for an exact UTF-8 file body. */
export function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${body.byteLength}\0`).update(body).digest('hex')
}

/** Identity of a Markdown body, ignoring surrounding whitespace. */
export function markdownHash(markdown: string): string {
  return createHash('sha256').update(markdown.replace(/\r\n?/g, '\n').trim()).digest('hex')
}

export interface ReadmeExportFolder {
  id: string
  displayName: string
  parentId: string | null
  sortOrder: number | null
  /** The folder's landing content as Markdown; becomes `index.md`. */
  markdown: string
  link: ReadmeFolderLink | null
}

export interface ReadmeExportDocument {
  id: string
  title: string
  hidden: boolean
  folderId: string | null
  sortOrder: number | null
  publicSlug: string | null
  markdown: string
  /** ISO publication date; written as `date` for changelog entries. */
  publishedDate: string | null
  link: ReadmeDocumentLink | null
  /** A previous repository path to reuse the file name of (detached docs). */
  preferredPath?: string | null
}

export interface ReadmeExportSpec {
  slug: string
  raw: string
  repoPath: string | null
}

export interface ReadmeExportDocumentResult {
  id: string
  path: string
  blobSha: string
  markdownHash: string
  title: string
  hidden: boolean
  frontmatter: Record<string, unknown>
  /** Frontmatter text of the file as planned, for the next comparison. */
  frontmatterRaw: string | null
  written: boolean
}

export interface ReadmeExportFolderResult {
  id: string
  link: ReadmeFolderLink
  indexWritten: boolean
  linkChanged: boolean
}

export interface ReadmeExportSpecResult {
  slug: string
  path: string
  blobSha: string
  written: boolean
}

export interface ReadmeExportPlan {
  writes: Array<{ path: string; content: string }>
  deletes: string[]
  unchangedCount: number
  /** Documents left out because both sides changed and Breezify was not chosen. */
  conflictCount: number
  documents: ReadmeExportDocumentResult[]
  folders: ReadmeExportFolderResult[]
  specs: ReadmeExportSpecResult[]
  orderFiles: Record<string, ReadmeOrderFileState>
  /** Paths Breezify manages once this plan has been applied. */
  managedPaths: string[]
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function extensionOf(path: string, fallback: string): string {
  return /\.(mdx|md)$/i.exec(path)?.[0] ?? fallback
}

function uniqueName(base: string, taken: Set<string>): string {
  let candidate = base
  for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base}-${suffix}`
  taken.add(candidate)
  return candidate
}

function bySortOrder<T extends { sortOrder: number | null; name: string }>(a: T, b: T): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
}

export function planReadmeExport(input: {
  root: string
  folders: ReadmeExportFolder[]
  documents: ReadmeExportDocument[]
  specs: ReadmeExportSpec[]
  /** Repository path -> blob SHA at the commit being compared. */
  tree: ReadonlyMap<string, string>
  state: ReadmeSyncState
  /** Write conflicted documents too, making Breezify's version win. */
  includeConflicts?: boolean
}): ReadmeExportPlan {
  const { root, tree, state } = input
  const full = (relative: string): string => joinReadmePath(root, relative)
  const relative = (path: string | null | undefined): string | null =>
    path ? relativeReadmePath(root, path) : null

  const writes: Array<{ path: string; content: string }> = []
  const desired = new Set<string>()
  let unchangedCount = 0
  let conflictCount = 0

  // --- Folders -> directories ------------------------------------------------
  const folderById = new Map(input.folders.map((folder) => [folder.id, folder]))
  const childFolders = new Map<string | null, ReadmeExportFolder[]>()
  for (const folder of input.folders) {
    const parentId = folder.parentId && folderById.has(folder.parentId) ? folder.parentId : null
    const siblings = childFolders.get(parentId) ?? []
    siblings.push(folder)
    childFolders.set(parentId, siblings)
  }
  const titleNamedCategories = input.folders.some((folder) => {
    const linked = relative(folder.link?.path)
    return Boolean(
      linked && /^docs\/[^/]+$/.test(linked) && /[A-Z ]/.test(linked.slice('docs/'.length)),
    )
  })
  const directoryByFolder = new Map<string, string>()
  const takenDirectories = new Set<string>()
  const assignDirectories = (parentId: string | null, parentDirectory: string | null): void => {
    const siblings = [...(childFolders.get(parentId) ?? [])].sort((a, b) => {
      // Linked folders claim their existing directory names first.
      const linkedOrder = Number(!a.link) - Number(!b.link)
      return linkedOrder || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
    })
    for (const folder of siblings) {
      if (directoryByFolder.has(folder.id)) continue
      const linked = relative(folder.link?.path)
      const linkedSection = linked && !linked.includes('/') ? readmeSectionOf(linked) : null
      let directory: string
      if (parentDirectory === null && linkedSection && linkedSection !== 'docs') {
        directory = linked!
        takenDirectories.add(directory)
      } else {
        const base = parentDirectory ?? 'docs'
        const segment = linked
          ? linked.split('/').at(-1)!
          : parentDirectory === null && titleNamedCategories
            ? folder.displayName.replace(/[\\/\u0000-\u001f]+/g, ' ').trim() ||
              `folder-${folder.id.slice(0, 8)}`
            : slugifySegment(folder.displayName, `folder-${folder.id.slice(0, 8)}`)
        const taken = new Set(
          [...takenDirectories]
            .filter((candidate) => directoryOf(candidate) === base)
            .map((candidate) => candidate.slice(base.length + 1)),
        )
        directory = `${base}/${uniqueName(segment, taken)}`
        takenDirectories.add(directory)
      }
      directoryByFolder.set(folder.id, directory)
      assignDirectories(folder.id, directory)
    }
  }
  assignDirectories(null, null)

  // --- Documents -> files ----------------------------------------------------
  const takenFiles = new Set<string>()
  const pathByDocument = new Map<string, string>()
  const documents = input.documents.filter(
    (document) => document.folderId === null || directoryByFolder.has(document.folderId),
  )
  const ordered = [...documents].sort((a, b) => {
    const linkedOrder = Number(!a.link) - Number(!b.link)
    return (
      linkedOrder ||
      (a.link?.path ?? '').localeCompare(b.link?.path ?? '') ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
    )
  })
  for (const document of ordered) {
    const directory = document.folderId ? directoryByFolder.get(document.folderId)! : 'docs'
    const previous = relative(document.link?.path) ?? relative(document.preferredPath)
    let base = previous
      ? basenameWithoutExtension(previous)
      : slugifySegment(
          document.publicSlug?.split('/').filter(Boolean).at(-1) || document.title,
          `page-${document.id.slice(0, 8)}`,
        )
    if (/^index$/i.test(base) || base === '_order') base = `${base}-page`
    const extension = previous ? extensionOf(previous, '.md') : '.md'
    const taken = new Set(
      [...takenFiles]
        .filter((candidate) => directoryOf(candidate) === directory)
        .map((candidate) => basenameWithoutExtension(candidate)),
    )
    const path = `${directory}/${uniqueName(base, taken)}${extension}`
    takenFiles.add(path)
    pathByDocument.set(document.id, path)
  }

  const documentResults: ReadmeExportDocumentResult[] = []
  for (const document of documents) {
    const path = full(pathByDocument.get(document.id)!)
    const link = document.link
    const hash = markdownHash(document.markdown)
    const treeSha = tree.get(path) ?? null

    if (
      link &&
      link.path === path &&
      treeSha !== null &&
      treeSha === link.blobSha &&
      link.markdownHash === hash &&
      link.title === document.title &&
      link.hidden === document.hidden
    ) {
      desired.add(path)
      unchangedCount++
      continue
    }
    if (link?.conflict && !input.includeConflicts) {
      // Leave both sides as they are until someone decides which one wins.
      desired.add(link.path)
      conflictCount++
      continue
    }

    const section = readmeSectionOf(pathByDocument.get(document.id)!)
    const frontmatter = mergeReadmeFrontmatter({
      previous: link?.frontmatter ?? null,
      title: document.title,
      hidden: document.hidden,
      date: section === 'changelogs' ? document.publishedDate : null,
    })
    // Unchanged frontmatter is written back exactly as the author spelled it.
    const keepRaw =
      typeof link?.frontmatterRaw === 'string' && sameJson(frontmatter, link.frontmatter)
    const content = serializeReadmeFile(
      frontmatter,
      document.markdown,
      keepRaw ? link!.frontmatterRaw : undefined,
    )
    const blobSha = gitBlobSha(content)
    const written = blobSha !== treeSha
    desired.add(path)
    if (written) writes.push({ path, content })
    else unchangedCount++
    documentResults.push({
      id: document.id,
      path,
      blobSha,
      markdownHash: hash,
      title: document.title,
      hidden: document.hidden,
      frontmatter,
      frontmatterRaw: parseReadmeFile(content).rawFrontmatter,
      written,
    })
  }

  // --- Folder landing pages -> index.md --------------------------------------
  const folderResults: ReadmeExportFolderResult[] = []
  for (const folder of input.folders) {
    const directory = directoryByFolder.get(folder.id)
    if (!directory) continue
    const link = folder.link
    const hasLanding = Boolean(folder.markdown.trim()) || Boolean(link?.indexPath)
    const nextLink: ReadmeFolderLink = {
      path: full(directory),
      indexPath: null,
      indexBlobSha: null,
      indexMarkdownHash: null,
      indexTitle: null,
      indexFrontmatter: null,
      indexFrontmatterRaw: null,
    }
    let indexWritten = false
    if (hasLanding) {
      const indexPath = full(`${directory}/index${extensionOf(link?.indexPath ?? '', '.md')}`)
      const hash = markdownHash(folder.markdown)
      const treeSha = tree.get(indexPath) ?? null
      desired.add(indexPath)
      if (
        link &&
        link.indexPath === indexPath &&
        treeSha !== null &&
        treeSha === link.indexBlobSha &&
        link.indexMarkdownHash === hash &&
        link.indexTitle === folder.displayName
      ) {
        unchangedCount++
        Object.assign(nextLink, {
          indexPath,
          indexBlobSha: link.indexBlobSha,
          indexMarkdownHash: link.indexMarkdownHash,
          indexTitle: link.indexTitle,
          indexFrontmatter: link.indexFrontmatter,
          indexFrontmatterRaw: link.indexFrontmatterRaw ?? null,
        })
      } else {
        const frontmatter = mergeReadmeFrontmatter({
          previous: link?.indexFrontmatter ?? null,
          title: folder.displayName,
          hidden: link?.indexFrontmatter?.hidden === true,
        })
        const keepRaw =
          typeof link?.indexFrontmatterRaw === 'string' &&
          sameJson(frontmatter, link.indexFrontmatter)
        const content = serializeReadmeFile(
          frontmatter,
          folder.markdown,
          keepRaw ? link!.indexFrontmatterRaw : undefined,
        )
        const blobSha = gitBlobSha(content)
        indexWritten = blobSha !== treeSha
        if (indexWritten) writes.push({ path: indexPath, content })
        else unchangedCount++
        Object.assign(nextLink, {
          indexPath,
          indexBlobSha: blobSha,
          indexMarkdownHash: hash,
          indexTitle: folder.displayName,
          indexFrontmatter: frontmatter,
          indexFrontmatterRaw: parseReadmeFile(content).rawFrontmatter,
        })
      }
    }
    folderResults.push({
      id: folder.id,
      link: nextLink,
      indexWritten,
      linkChanged: !sameJson(link, nextLink),
    })
  }

  // --- OpenAPI definitions -> reference/<slug>.json|yaml ---------------------
  const specResults: ReadmeExportSpecResult[] = []
  for (const spec of input.specs) {
    const extension = /^\s*[{[]/.test(spec.raw) ? 'json' : 'yaml'
    const path = spec.repoPath ?? full(`reference/${spec.slug}.${extension}`)
    const blobSha = gitBlobSha(spec.raw)
    const written = tree.get(path) !== blobSha
    desired.add(path)
    if (written) writes.push({ path, content: spec.raw })
    else unchangedCount++
    specResults.push({ slug: spec.slug, path, blobSha, written })
  }

  // --- Sidebar order -> _order.yaml ------------------------------------------
  const children = new Map<string, Array<{ name: string; sortOrder: number | null }>>()
  const addChild = (directory: string, name: string, sortOrder: number | null): void => {
    const list = children.get(directory) ?? []
    list.push({ name, sortOrder })
    children.set(directory, list)
  }
  for (const folder of input.folders) {
    const directory = directoryByFolder.get(folder.id)
    // Section roots (reference, recipes, ...) are not listed in any order file.
    if (!directory || !directory.includes('/')) continue
    addChild(directoryOf(directory), directory.split('/').at(-1)!, folder.sortOrder)
  }
  for (const document of documents) {
    const path = pathByDocument.get(document.id)!
    addChild(directoryOf(path), basenameWithoutExtension(path), document.sortOrder)
  }
  // Names that still exist in the repository once this plan is applied. An
  // order file can list things Breezify does not mirror (generated API reference
  // stubs, tag folders); those entries must survive a rewrite.
  const isOrderFile = (path: string): boolean => path.endsWith(`/${README_ORDER_FILE}`)
  const surviving = new Set<string>()
  const addSurvivor = (path: string): void => {
    const segments = path.split('/')
    for (let depth = 1; depth <= segments.length; depth++) {
      const name =
        depth === segments.length ? basenameWithoutExtension(path) : segments[depth - 1]!
      surviving.add([...segments.slice(0, depth - 1), name].join('/'))
    }
  }
  const managed = new Set(state.managed_paths)
  for (const path of tree.keys()) {
    const removed = managed.has(path) && !desired.has(path) && !isOrderFile(path)
    if (!removed) addSurvivor(path)
  }
  for (const write of writes) addSurvivor(write.path)

  const orderFiles: Record<string, ReadmeOrderFileState> = {}
  for (const [directory, entries] of children) {
    // The changelog is a flat, dated feed with no order file.
    if (readmeSectionOf(directory) === 'changelogs') continue
    const path = full(`${directory}/${README_ORDER_FILE}`)
    const treeSha = tree.get(path) ?? null
    const recorded = state.order_files[path]
    const names = new Set(entries.map((entry) => entry.name))
    const wanted = entries
      .filter((entry) => entry.sortOrder !== null)
      .sort(bySortOrder)
      .map((entry) => entry.name)
    if (wanted.length === 0) {
      if (treeSha !== null) {
        desired.add(path)
        if (recorded) orderFiles[path] = recorded
      }
      continue
    }
    desired.add(path)
    const recordedLive = recorded?.entries.filter((entry) => names.has(entry)) ?? null
    if (
      treeSha !== null &&
      recorded &&
      recorded.sha === treeSha &&
      sameJson(recordedLive, wanted)
    ) {
      orderFiles[path] = recorded
      unchangedCount++
      continue
    }
    // Breezify's children take Breezify's order, in the slots they already had;
    // entries Breezify does not mirror keep their place.
    const queue = [...wanted]
    const merged: string[] = []
    for (const entry of recorded?.entries ?? []) {
      if (names.has(entry)) {
        const next = wanted.includes(entry) ? queue.shift() : undefined
        if (next !== undefined) merged.push(next)
      } else if (surviving.has(`${full(directory)}/${entry}`)) {
        merged.push(entry)
      }
    }
    merged.push(...queue)
    const content = serializeOrderFile(merged)
    const blobSha = gitBlobSha(content)
    if (blobSha !== treeSha) writes.push({ path, content })
    else unchangedCount++
    orderFiles[path] = { sha: blobSha, entries: merged }
  }

  const deletes = [...new Set(state.managed_paths)]
    .filter((path) => tree.has(path) && !desired.has(path))
    .sort((a, b) => a.localeCompare(b))
  writes.sort((a, b) => a.path.localeCompare(b.path))

  return {
    writes,
    deletes,
    unchangedCount,
    conflictCount,
    documents: documentResults,
    folders: folderResults,
    specs: specResults,
    orderFiles,
    managedPaths: [...desired].sort((a, b) => a.localeCompare(b)),
  }
}

export class ReadmeExportSelectionError extends Error {
  constructor(readonly paths: string[]) {
    super('The selected files no longer match the current GitHub comparison.')
    this.name = 'ReadmeExportSelectionError'
  }
}

/**
 * Restrict a plan to the chosen paths. Unselected changes stay pending: their
 * documents keep their old link so the next comparison reports them again.
 */
export function selectReadmeExportPlan(
  plan: ReadmeExportPlan,
  selectedPaths: readonly string[] | undefined,
): ReadmeExportPlan {
  if (!selectedPaths) return plan
  const selected = new Set(selectedPaths)
  const changed = new Set([...plan.writes.map((write) => write.path), ...plan.deletes])
  const invalid = [...selected].filter((path) => !changed.has(path))
  if (invalid.length > 0) throw new ReadmeExportSelectionError(invalid)

  const writes = plan.writes.filter((write) => selected.has(write.path))
  const deletes = plan.deletes.filter((path) => selected.has(path))
  const skippedWrites = new Set(
    plan.writes.filter((write) => !selected.has(write.path)).map((write) => write.path),
  )
  const skippedDeletes = plan.deletes.filter((path) => !selected.has(path))
  return {
    ...plan,
    writes,
    deletes,
    unchangedCount:
      plan.unchangedCount + (plan.writes.length - writes.length) + skippedDeletes.length,
    documents: plan.documents.filter((document) => !skippedWrites.has(document.path)),
    folders: plan.folders.map((folder) =>
      folder.indexWritten && folder.link.indexPath && skippedWrites.has(folder.link.indexPath)
        ? { ...folder, indexWritten: false, linkChanged: false }
        : folder,
    ),
    specs: plan.specs.filter((spec) => !skippedWrites.has(spec.path)),
    orderFiles: Object.fromEntries(
      Object.entries(plan.orderFiles).filter(([path]) => !skippedWrites.has(path)),
    ),
    // Files whose deletion was not selected are still there, and still managed.
    managedPaths: [...new Set([...plan.managedPaths, ...skippedDeletes])].sort((a, b) =>
      a.localeCompare(b),
    ),
  }
}
