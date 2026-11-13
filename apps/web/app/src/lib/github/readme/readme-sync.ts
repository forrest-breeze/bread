import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import {
  getInstallationToken,
  getRepository,
  getRepositoryBlob,
  getRepositoryCommit,
  getRepositoryTree,
  type GitHubBlob,
} from '../github'
import { withGitHubRetry } from '../retry'
import { markdownHash } from './readme-export'
import {
  frontmatterDate,
  frontmatterHidden,
  frontmatterSlug,
  frontmatterTitle,
  isApiReferenceStub,
  isReadmeConfigPage,
  parseOrderFile,
  parseReadmeFile,
} from './readme-frontmatter'
import {
  basenameWithoutExtension,
  classifyReadmeTree,
  directoryDisplayName,
  directoryOf,
  folderDirectoryOf,
  isIndexPage,
  joinReadmePath,
  parentFolderDirectory,
  prettifySegment,
  readmeFolderDirectories,
  readmeFolderMetadata,
  readmeSectionOf,
  readReadmeDocumentLink,
  readReadmeFolderLink,
  readReadmeSyncState,
  relativeReadmePath,
  README_MAX_PAGE_BYTES,
  README_MAX_PAGES,
  README_ORDER_FILE,
  slugifySegment,
  type ReadmeDocumentLink,
  type ReadmeFolderLink,
  type ReadmeOrderFileState,
  type ReadmeSkippedFile,
  type ReadmeSyncState,
  type ReadmeTreeFile,
} from './readme-layout'
import { readmeBodyToMarkdown } from './readme-markdown'
import type { ReadmeStore, ReadmeStoreDocument, ReadmeStoreFolder } from './readme-store'

/**
 * Repository -> workspace, for the ReadMe format.
 *
 * Only blobs that changed since the last sync are downloaded: a page whose
 * blob SHA still matches its document's checkpoint is left alone. When both
 * sides changed a page, Breezify's copy is kept and the document is flagged as a
 * conflict; nothing is overwritten silently.
 */

const FETCH_CONCURRENCY = 6
const WRITE_CONCURRENCY = 6
const MAX_SPEC_BYTES = 2 * 1024 * 1024
const MAX_SKIPPED_RECORDED = 400

export type ReadmeSyncMode = 'merge' | 'replace_breezify'

export interface ReadmeSyncTarget {
  installationId: number
  repoId: number
  repoFullName: string
  /** Project root inside the repository; '' is the repository root. */
  root: string
  /** Configured branch; null follows the repository default branch. */
  branch: string | null
  /** Exact commit or branch to read; defaults to the configured branch. */
  ref?: string
  lastSyncCommitSha: string | null
  syncState: unknown
  mode: ReadmeSyncMode
  force?: boolean
}

export interface ReadmeSyncResult {
  repoFullName: string
  ref: string
  commitSha: string
  documentCount: number
  created: number
  updated: number
  removed: number
  /** Documents kept on Breezify's version because both sides changed. */
  preserved: number
  moved: number
  skipped: ReadmeSkippedFile[]
}

export interface ReadmeSyncDeps {
  store: ReadmeStore
  /** Editor content (HTML or Markdown) -> canonical Markdown. */
  toMarkdown: (content: string | null | undefined) => string
  getToken?: typeof getInstallationToken
  getRepo?: typeof getRepository
  getCommit?: typeof getRepositoryCommit
  getTree?: typeof getRepositoryTree
  getBlob?: typeof getRepositoryBlob
  retry?: <T>(operation: () => Promise<T>) => Promise<T>
}

export class ReadmeSyncError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ReadmeSyncError'
  }
}

interface ParsedPage {
  file: ReadmeTreeFile
  relative: string
  /** Directory relative to the project root. */
  directory: string
  index: boolean
  title: string
  hidden: boolean
  frontmatter: Record<string, unknown>
  frontmatterRaw: string | null
  markdown: string
  date: string | null
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++
      output[index] = await fn(values[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  )
  return output
}

function decodeTextBlob(blob: GitHubBlob): string | null {
  if (blob.encoding !== 'base64') return null
  const decoded = Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8')
  if (decoded.includes('\u0000')) return null
  const replacements = decoded.match(/�/g)?.length ?? 0
  if (replacements > Math.max(2, decoded.length * 0.01)) return null
  return decoded.replace(/\r\n?/g, '\n')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Parse JSON or YAML; returns null when the text is neither. */
export function parseSpecDocument(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = /^\s*[{[]/.test(raw)
      ? JSON.parse(raw)
      : yaml.load(raw, { schema: yaml.CORE_SCHEMA })
  } catch {
    return null
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

export function isOpenApiDocument(document: Record<string, unknown> | null): boolean {
  if (!document) return false
  return typeof document.openapi === 'string' || typeof document.swagger === 'string'
}

/** `reference/Payments API.yaml` -> `payments-api`. */
export function specSlugForPath(path: string): string {
  return slugifySegment(basenameWithoutExtension(path).replace(/\./g, '-'), 'api').slice(0, 63)
}

function documentMetadata(input: {
  target: ReadmeSyncTarget
  ref: string
  commitSha: string
  page: ParsedPage
  markdownHashValue: string
}): Record<string, unknown> {
  const { page } = input
  return {
    kind: 'github_hosted_document',
    repo_format: 'readme',
    canonical_repo_path: page.file.path,
    github_hosted_sync: true,
    github_hosted_conflict: false,
    github_hosted_content_hash: sha256(page.markdown),
    github_hosted_pending_content_hash: null,
    github_hosted_pending_commit_sha: null,
    github_hosted_pending_path: null,
    github_hosted_checkpoint_blob_sha: page.file.sha,
    github_hosted_checkpoint_mode: input.target.mode,
    readme_markdown_hash: input.markdownHashValue,
    readme_title: page.title,
    readme_hidden: page.hidden,
    readme_frontmatter: page.frontmatter,
    readme_frontmatter_raw: page.frontmatterRaw,
    ...(page.date ? { published_date: page.date } : {}),
    repo_id: input.target.repoId,
    repo_full_name: input.target.repoFullName,
    path: page.file.path,
    ref: input.ref,
    commit_sha: input.commitSha,
  }
}

export async function syncReadmeRepository(
  target: ReadmeSyncTarget,
  deps: ReadmeSyncDeps,
): Promise<ReadmeSyncResult> {
  const { store, toMarkdown } = deps
  const getToken = deps.getToken ?? getInstallationToken
  const getRepo = deps.getRepo ?? getRepository
  const getCommit = deps.getCommit ?? getRepositoryCommit
  const getTree = deps.getTree ?? getRepositoryTree
  const getBlob = deps.getBlob ?? getRepositoryBlob
  const retry = deps.retry ?? withGitHubRetry
  const { root, repoId } = target
  const full = (relative: string): string => joinReadmePath(root, relative)

  await store.updateSource({ sync_status: 'syncing', last_sync_error: null })

  const token = await retry(() => getToken(target.installationId))
  const ref =
    target.ref ??
    target.branch ??
    (await retry(() => getRepo(token, target.repoFullName))).default_branch
  const commit = await retry(() => getCommit(token, target.repoFullName, ref))
  const tree = await retry(() => getTree(token, target.repoFullName, commit.commit.tree.sha))
  if (tree.truncated) {
    throw new ReadmeSyncError(
      'The repository file tree is too large to sync.',
      'repository_tree_truncated',
    )
  }
  const classification = classifyReadmeTree(tree.tree, root)
  if (classification.pages.length > README_MAX_PAGES) {
    throw new ReadmeSyncError(
      `The repository has more than ${README_MAX_PAGES} pages.`,
      'too_many_pages',
    )
  }

  const state = readReadmeSyncState(target.syncState, root)
  const force = target.force === true || target.mode === 'replace_breezify'
  if (!force && target.lastSyncCommitSha === commit.sha && state.managed_paths.length > 0) {
    await store.updateSource({
      sync_status: 'synced',
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
      pending_sync_mode: 'merge',
    })
    return {
      repoFullName: target.repoFullName,
      ref,
      commitSha: commit.sha,
      documentCount: 0,
      created: 0,
      updated: 0,
      removed: 0,
      preserved: 0,
      moved: 0,
      skipped: state.skipped,
    }
  }

  const fetchText = async (file: ReadmeTreeFile): Promise<string | null> =>
    decodeTextBlob(await retry(() => getBlob(token, target.repoFullName, file.sha)))

  const [folders, documents, publicSlugs, specs, deletedLinks] = await Promise.all([
    store.listFolders(),
    store.listDocuments(),
    store.listPublicSlugs(),
    store.listSpecs(),
    store.listDeletedLinks(),
  ])
  // Documents deleted in Breezify whose file is still in the repository. Until
  // that deletion is published the file must not be imported again, or any
  // unrelated push would bring the document back.
  const deletedInBreezify = new Map(deletedLinks.map((link) => [link.path, link.blobSha]))
  const previouslyManaged = new Set(state.managed_paths)
  const usedSlugs = new Set(publicSlugs)

  const linkByDocument = new Map<string, ReadmeDocumentLink>()
  const documentByPath = new Map<string, ReadmeStoreDocument>()
  const pendingByPath = new Map<string, ReadmeStoreDocument>()
  for (const document of documents) {
    const candidate = readReadmeDocumentLink(document.metadata, repoId)
    // A link that points outside the current project root (the root was
    // changed) is ignored rather than treated as a deleted file: the document
    // stays, and the next publish writes it under the new root.
    const link =
      candidate && readmeSectionOf(relativeReadmePath(root, candidate.path) ?? '') !== null
        ? candidate
        : null
    if (link) {
      linkByDocument.set(document.id, link)
      if (!documentByPath.has(link.path)) documentByPath.set(link.path, document)
      continue
    }
    const pending = document.metadata?.github_hosted_pending_path
    if (typeof pending === 'string' && Number(document.metadata?.repo_id) === repoId) {
      pendingByPath.set(pending, document)
    }
  }
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  const folderLinks = new Map<string, ReadmeFolderLink>()
  const folderByDirectory = new Map<string, ReadmeStoreFolder>()
  for (const folder of folders) {
    const link = readReadmeFolderLink(folder.metadata, repoId)
    if (!link) continue
    folderLinks.set(folder.id, link)
    if (!folderByDirectory.has(link.path)) folderByDirectory.set(link.path, folder)
  }

  const skipped: ReadmeSkippedFile[] = []
  const previouslySkipped = new Map(
    state.skipped.filter((entry) => entry.sha).map((entry) => [entry.path, entry]),
  )
  let created = 0
  let updated = 0
  let removed = 0
  let moved = 0

  // --- Pages: decide which blobs to read -------------------------------------
  const activePaths = new Set<string>()
  /** Paths that could not be read; their documents must not be removed. */
  const protectedPaths = new Set<string>()
  /** Files whose deletion in Breezify has not been published yet. */
  const awaitingDeletion = new Set<string>()
  const honorBreezifyDeletions = target.mode !== 'replace_breezify'
  const pagesToRead: ReadmeTreeFile[] = []
  for (const file of classification.pages) {
    const relative = relativeReadmePath(root, file.path)!
    const carried = previouslySkipped.get(file.path)
    if (!force && carried && carried.sha === file.sha) {
      skipped.push(carried)
      if (!carried.quiet) protectedPaths.add(file.path)
      continue
    }
    if (isIndexPage(relative)) {
      const folder = folderByDirectory.get(directoryOf(file.path))
      const link = folder ? folderLinks.get(folder.id) : undefined
      if (!force && link?.indexPath === file.path && link.indexBlobSha === file.sha) {
        activePaths.add(file.path)
        continue
      }
      // The folder this landing page belonged to was deleted in Breezify.
      if (honorBreezifyDeletions && !folder && previouslyManaged.has(file.path)) {
        awaitingDeletion.add(file.path)
        continue
      }
    } else {
      const document = documentByPath.get(file.path)
      const link = document ? linkByDocument.get(document.id) : undefined
      if (!force && link && link.blobSha === file.sha) {
        activePaths.add(file.path)
        continue
      }
      // Deleted in Breezify: either the trashed document still points at this
      // exact blob, or the document is gone entirely (trash emptied) while
      // the file was one Breezify had imported. A file that changed on GitHub
      // after it was trashed is imported again instead.
      const trashedBlob = deletedInBreezify.get(file.path)
      if (
        honorBreezifyDeletions &&
        !document &&
        (trashedBlob === file.sha ||
          (trashedBlob === undefined && previouslyManaged.has(file.path)))
      ) {
        awaitingDeletion.add(file.path)
        continue
      }
    }
    pagesToRead.push(file)
  }

  const readPages = (
    await mapWithConcurrency(pagesToRead, FETCH_CONCURRENCY, async (file) => {
      const relative = relativeReadmePath(root, file.path)!
      const skip = (reason: string, quiet = false): null => {
        skipped.push({ path: file.path, sha: file.sha, reason, ...(quiet ? { quiet } : {}) })
        if (!quiet) protectedPaths.add(file.path)
        return null
      }
      if (file.size > README_MAX_PAGE_BYTES) {
        return skip(`exceeds the ${README_MAX_PAGE_BYTES}-byte page limit`)
      }
      const raw = await fetchText(file)
      if (raw === null) return skip('must be valid UTF-8 text')
      const parsed = parseReadmeFile(raw)
      if (parsed.error) return skip(parsed.error)
      if (isApiReferenceStub(parsed.frontmatter)) {
        return skip('API reference page generated from the OpenAPI definition', true)
      }
      if (isReadmeConfigPage(parsed.frontmatter)) {
        return skip('ReadMe API reference setting, not a page', true)
      }
      const index = isIndexPage(relative)
      const directory = directoryOf(relative)
      if (index && folderDirectoryOf(directory) === null) {
        return skip('the guides root has no landing page in Breezify', true)
      }
      const page: ParsedPage = {
        file,
        relative,
        directory,
        index,
        title:
          frontmatterTitle(parsed.frontmatter) ||
          (index
            ? directoryDisplayName(directory)
            : prettifySegment(basenameWithoutExtension(relative))),
        hidden: frontmatterHidden(parsed.frontmatter),
        frontmatter: parsed.frontmatter,
        frontmatterRaw: parsed.rawFrontmatter,
        markdown: readmeBodyToMarkdown(parsed.body),
        date: frontmatterDate(parsed.frontmatter),
      }
      activePaths.add(file.path)
      return page
    })
  ).filter((page): page is ParsedPage => page !== null)

  // An index.md with no body only matters as the title of a directory that
  // holds pages. ReadMe generates one for every tag of an OpenAPI definition;
  // those directories contain nothing but generated stubs, so mirroring them
  // would fill the workspace with empty folders.
  const directoriesWithPages = new Set<string>()
  for (const path of activePaths) {
    const relative = relativeReadmePath(root, path)!
    if (isIndexPage(relative)) continue
    const segments = relative.split('/').slice(0, -1)
    for (let depth = 1; depth <= segments.length; depth++) {
      directoriesWithPages.add(segments.slice(0, depth).join('/'))
    }
  }
  const parsedPages = readPages.filter((page) => {
    if (!page.index || page.markdown.trim() || directoriesWithPages.has(page.directory)) {
      return true
    }
    activePaths.delete(page.file.path)
    skipped.push({
      path: page.file.path,
      sha: page.file.sha,
      reason: 'landing page of a directory with no pages to sync',
      quiet: true,
    })
    return false
  })

  // --- Folders ---------------------------------------------------------------
  const activeRelative = [...activePaths].map((path) => relativeReadmePath(root, path)!)
  const directories = readmeFolderDirectories(activeRelative)
  const indexByDirectory = new Map(
    parsedPages.filter((page) => page.index).map((page) => [page.directory, page]),
  )
  const activeIndexDirectories = new Set(
    activeRelative.filter(isIndexPage).map((relative) => directoryOf(relative)),
  )

  // --- Order files -----------------------------------------------------------
  const orderFiles: Record<string, ReadmeOrderFileState> = {}
  const orderChanged = new Set<string>()
  // Only directories Breezify mirrors have an order Breezify can own. Order files
  // elsewhere (for example inside the API reference tree ReadMe generates) are
  // left alone: never read, never rewritten, never deleted.
  const mirrored = new Set([full('docs'), ...directories.map((directory) => full(directory))])
  const mirroredOrderFiles = classification.orderFiles.filter((file) =>
    mirrored.has(directoryOf(file.path)),
  )
  await mapWithConcurrency(mirroredOrderFiles, FETCH_CONCURRENCY, async (file) => {
    const directory = directoryOf(file.path)
    const recorded = state.order_files[file.path]
    if (!force && recorded && recorded.sha === file.sha) {
      orderFiles[file.path] = recorded
      return
    }
    const raw = file.size > README_MAX_PAGE_BYTES ? null : await fetchText(file)
    const entries = raw === null ? null : parseOrderFile(raw)
    if (entries === null) {
      skipped.push({
        path: file.path,
        sha: file.sha,
        reason: 'must be a YAML list of page slugs',
      })
      return
    }
    orderFiles[file.path] = { sha: file.sha, entries }
    orderChanged.add(directory)
  })
  for (const path of Object.keys(state.order_files)) {
    // A deleted order file changes the order of its directory too.
    if (!classification.orderFiles.some((file) => file.path === path)) {
      orderChanged.add(directoryOf(path))
    }
  }
  const orderIndex = (directory: string, name: string): number | null => {
    const entries = orderFiles[`${directory}/${README_ORDER_FILE}`]?.entries
    if (!entries) return null
    const index = entries.indexOf(name)
    return index === -1 ? null : index
  }

  const assignedFolders = new Set<string>()
  const folderIdByDirectory = new Map<string, string>()

  for (const directory of directories) {
    const path = full(directory)
    const parentDirectory = parentFolderDirectory(directory)
    const parentId = parentDirectory ? folderIdByDirectory.get(parentDirectory) ?? null : null
    const isSectionRoot = !directory.includes('/')
    const wantedOrder = isSectionRoot
      ? null
      : orderIndex(full(directoryOf(directory)), directory.split('/').at(-1)!)
    const index = indexByDirectory.get(directory)

    let folder = folderByDirectory.get(path) ?? null
    if (!folder) {
      // A folder created in Breezify and published from there has no recorded
      // path yet; recognize it by the documents that already live in it.
      const candidates = new Set<string>()
      for (const [documentPath, document] of [...documentByPath, ...pendingByPath]) {
        if (directoryOf(documentPath) === path && document.folderId) {
          candidates.add(document.folderId)
        }
      }
      const [candidate] = [...candidates]
      if (candidates.size === 1 && folderById.has(candidate!) && !assignedFolders.has(candidate!)) {
        folder = folderById.get(candidate!)!
      }
    }

    if (!folder) {
      const link: ReadmeFolderLink = {
        path,
        indexPath: index?.file.path ?? null,
        indexBlobSha: index?.file.sha ?? null,
        indexMarkdownHash: index ? markdownHash(toMarkdown(index.markdown)) : null,
        indexTitle: index?.title ?? null,
        indexFrontmatter: index?.frontmatter ?? null,
        indexFrontmatterRaw: index?.frontmatterRaw ?? null,
      }
      const id = await store.createFolder({
        name: `readme-${repoId}-${createHash('sha1').update(path).digest('hex').slice(0, 20)}`,
        displayName: index?.title ?? directoryDisplayName(directory),
        parentId,
        sortOrder: wantedOrder,
        content: index?.markdown ?? null,
        metadata: readmeFolderMetadata(repoId, link),
      })
      folderIdByDirectory.set(directory, id)
      assignedFolders.add(id)
      continue
    }

    assignedFolders.add(folder.id)
    folderIdByDirectory.set(directory, folder.id)
    const link = folderLinks.get(folder.id) ?? null
    const patch: Parameters<ReadmeStore['updateFolder']>[1] = {}
    const nextLink: ReadmeFolderLink = link
      ? { ...link, path }
      : {
          path,
          indexPath: null,
          indexBlobSha: null,
          indexMarkdownHash: null,
          indexTitle: null,
          indexFrontmatter: null,
          indexFrontmatterRaw: null,
        }

    const currentHash = markdownHash(toMarkdown(folder.content))
    if (index) {
      const incomingHash = markdownHash(toMarkdown(index.markdown))
      const edited = link?.indexMarkdownHash
        ? currentHash !== link.indexMarkdownHash ||
          (link.indexTitle !== null && folder.displayName !== link.indexTitle)
        : Boolean(folder.content?.trim())
      const converged = currentHash === incomingHash
      // When the landing page was edited on both sides, Breezify's copy stays and
      // is written back on the next publish; the link keeps the old checkpoint
      // so that publish sees the difference.
      if (target.mode === 'replace_breezify' || !edited || converged) {
        if (!converged) patch.content = index.markdown
        if (folder.displayName !== index.title && (target.mode === 'replace_breezify' || !edited)) {
          patch.displayName = index.title
        }
        Object.assign(nextLink, {
          indexPath: index.file.path,
          indexBlobSha: index.file.sha,
          indexMarkdownHash: incomingHash,
          indexTitle: patch.displayName ?? folder.displayName,
          indexFrontmatter: index.frontmatter,
          indexFrontmatterRaw: index.frontmatterRaw,
        })
      }
    } else if (link?.indexPath && !activeIndexDirectories.has(directory)) {
      // index.md was deleted on GitHub.
      if (link.indexMarkdownHash === currentHash && folder.content) patch.content = null
      Object.assign(nextLink, {
        indexPath: null,
        indexBlobSha: null,
        indexMarkdownHash: null,
        indexTitle: null,
        indexFrontmatter: null,
        indexFrontmatterRaw: null,
      })
    }

    if (target.mode === 'replace_breezify' && folder.parentId !== parentId) {
      patch.parentId = parentId
      moved++
    }
    if (
      !isSectionRoot &&
      (orderChanged.has(full(directoryOf(directory))) || !link) &&
      folder.sortOrder !== wantedOrder
    ) {
      patch.sortOrder = wantedOrder
    }
    if (JSON.stringify(link) !== JSON.stringify(nextLink)) {
      patch.metadata = { ...(folder.metadata ?? {}), ...readmeFolderMetadata(repoId, nextLink) }
    }
    if (Object.keys(patch).length > 0) {
      await store.updateFolder(folder.id, patch)
      if (patch.content !== undefined || patch.displayName !== undefined) updated++
    }
  }

  const folderIdForPage = (relative: string): string | null => {
    const directory = folderDirectoryOf(directoryOf(relative))
    return directory ? folderIdByDirectory.get(directory) ?? null : null
  }

  // --- Documents -------------------------------------------------------------
  const pages = parsedPages.filter((page) => !page.index)
  const stale = new Map<string, ReadmeStoreDocument>()
  for (const [path, document] of documentByPath) {
    if (!activePaths.has(path) && !protectedPaths.has(path)) stale.set(path, document)
  }
  // A file that moved keeps its document: match it by identical content first,
  // then by an unambiguous file name.
  const renamed = new Map<string, ReadmeStoreDocument>()
  const unmatched = pages.filter(
    (page) => !documentByPath.has(page.file.path) && !pendingByPath.has(page.file.path),
  )
  for (const strategy of ['blob', 'name'] as const) {
    for (const page of unmatched) {
      if (renamed.has(page.file.path)) continue
      const candidates = [...stale].filter(([path, document]) =>
        strategy === 'blob'
          ? linkByDocument.get(document.id)?.blobSha === page.file.sha
          : basenameWithoutExtension(path) === basenameWithoutExtension(page.file.path),
      )
      if (candidates.length !== 1) continue
      const [path, document] = candidates[0]!
      stale.delete(path)
      renamed.set(page.file.path, document)
    }
  }

  let preserved = 0
  const uniqueSlug = (page: ParsedPage): string => {
    const base = slugifySegment(
      frontmatterSlug(page.frontmatter) ?? basenameWithoutExtension(page.relative),
      'page',
    )
    const section = readmeSectionOf(page.relative) ?? 'docs'
    const candidates = [
      base,
      `${section.replace(/_/g, '-')}-${base}`,
      `${base}-${sha256(page.file.path).slice(0, 6)}`,
    ]
    const slug =
      candidates.find((candidate) => !usedSlugs.has(candidate)) ??
      `${base}-${sha256(`${page.file.path}:${page.file.sha}`).slice(0, 12)}`
    usedSlugs.add(slug)
    return slug
  }

  const syncPage = async (page: ParsedPage): Promise<void> => {
    const path = page.file.path
    const incomingHash = markdownHash(toMarkdown(page.markdown))
    const metadata = documentMetadata({
      target,
      ref,
      commitSha: commit.sha,
      page,
      markdownHashValue: incomingHash,
    })
    const wasRenamed = renamed.has(path)
    const pending = pendingByPath.get(path)
    const existing = documentByPath.get(path) ?? renamed.get(path) ?? pending ?? null
    const folderId = folderIdForPage(page.relative)
    const sortOrder = orderIndex(full(page.directory), basenameWithoutExtension(page.relative))
    const status = page.hidden ? 'Draft' : 'Published'

    if (!existing) {
      const id = await store.insertDocument({
        title: page.title,
        content: page.markdown,
        status,
        folderId,
        sortOrder,
        publicSlug: uniqueSlug(page),
        metadata,
      })
      created++
      await store.refreshIndex(id, page.markdown)
      return
    }

    const link = linkByDocument.get(existing.id) ?? null
    const currentHash = markdownHash(toMarkdown(existing.content))
    const unedited =
      link !== null &&
      link.markdownHash === currentHash &&
      (link.title === null || link.title === existing.title)
    const converged = currentHash === incomingHash && existing.title === page.title
    if (target.mode !== 'replace_breezify' && link !== null && !unedited && !converged) {
      await store.updateDocument(existing.id, {
        // A file that moved on GitHub keeps its document pointed at it, so
        // resolving the conflict later writes to the right place.
        ...(wasRenamed && existing.folderId !== folderId ? { folderId } : {}),
        metadata: {
          ...(existing.metadata ?? {}),
          ...(wasRenamed ? { canonical_repo_path: path, path } : {}),
          github_hosted_conflict: true,
          github_hosted_pending_content_hash: sha256(page.markdown),
          github_hosted_pending_commit_sha: commit.sha,
        },
      })
      preserved++
      return
    }

    const patch: Parameters<ReadmeStore['updateDocument']>[1] = {}
    if (link === null || link.hidden !== page.hidden || target.mode === 'replace_breezify') {
      if (existing.status !== status) patch.status = status
    }
    const relocate = wasRenamed || link === null || target.mode === 'replace_breezify'
    if (relocate && !pending && existing.folderId !== folderId) {
      patch.folderId = folderId
      moved++
    }
    if (
      (relocate || orderChanged.has(full(page.directory))) &&
      !pending &&
      existing.sortOrder !== sortOrder
    ) {
      patch.sortOrder = sortOrder
    }

    if (converged) {
      // Same content on both sides (for example our own publish coming back).
      await store.updateDocument(existing.id, {
        ...patch,
        metadata: {
          ...(existing.metadata ?? {}),
          ...metadata,
          // Keep the stored representation's own hash for the editor.
          github_hosted_content_hash: sha256(existing.content),
        },
      })
      return
    }
    await store.applyDocumentContent({
      id: existing.id,
      expectedTitle: existing.title,
      expectedContent: existing.content,
      title: page.title,
      content: page.markdown,
      metadataPatch: metadata,
    })
    // Applying repository content publishes the document as a side effect.
    // Visibility is decided here instead: GitHub's `hidden` when it changed,
    // otherwise whatever the document already was. Without this, editing a
    // hidden page on GitHub would make it public.
    const intendedStatus = patch.status ?? existing.status ?? status
    await store.updateDocument(existing.id, { ...patch, status: intendedStatus })
    updated++
    await store.refreshIndex(existing.id, page.markdown)
  }
  for (let start = 0; start < pages.length; start += WRITE_CONCURRENCY * 4) {
    await mapWithConcurrency(pages.slice(start, start + WRITE_CONCURRENCY * 4), WRITE_CONCURRENCY, syncPage)
    // Heartbeat: lets status polls tell a slow sync from an interrupted one.
    await store.updateSource({ sync_status: 'syncing' })
  }

  // Pages whose own blob is unchanged still follow a changed order file.
  const parsedPaths = new Set(parsedPages.map((page) => page.file.path))
  const reorder: Array<{ id: string; sortOrder: number | null }> = []
  for (const path of activePaths) {
    if (parsedPaths.has(path)) continue
    const relative = relativeReadmePath(root, path)!
    if (isIndexPage(relative) || !orderChanged.has(directoryOf(path))) continue
    const document = documentByPath.get(path)
    if (!document) continue
    const sortOrder = orderIndex(directoryOf(path), basenameWithoutExtension(relative))
    if (document.sortOrder !== sortOrder) reorder.push({ id: document.id, sortOrder })
  }
  await mapWithConcurrency(reorder, WRITE_CONCURRENCY, (entry) =>
    store.updateDocument(entry.id, { sortOrder: entry.sortOrder }),
  )

  // --- Pages removed from the repository -------------------------------------
  const removable: ReadmeStoreDocument[] = []
  for (const document of stale.values()) {
    const link = linkByDocument.get(document.id)!
    const unedited =
      link.markdownHash === markdownHash(toMarkdown(document.content)) &&
      (link.title === null || link.title === document.title)
    if (target.mode === 'replace_breezify' || unedited) {
      removable.push(document)
      continue
    }
    // Edited in Breezify, deleted on GitHub: keep the document and say so.
    await store.updateDocument(document.id, {
      metadata: {
        ...(document.metadata ?? {}),
        kind: 'github_hosted_detached_document',
        github_hosted_sync: false,
        github_hosted_conflict: true,
        github_hosted_detached_reason: 'source_removed',
        github_hosted_detached_at: new Date().toISOString(),
      },
    })
    preserved++
  }
  if (removable.length > 0) {
    // Clear the link first: a soft-deleted document that is still linked means
    // "deleted in Breezify, not published yet", which this is not.
    await mapWithConcurrency(removable, WRITE_CONCURRENCY, (document) =>
      store.updateDocument(document.id, {
        metadata: { ...(document.metadata ?? {}), github_hosted_sync: false },
      }),
    )
    await store.softDeleteDocuments(removable.map((document) => document.id))
    removed += removable.length
  }

  // --- OpenAPI definitions in reference/ -------------------------------------
  const specByPath = new Map(
    specs.filter((spec) => spec.repoPath).map((spec) => [spec.repoPath!, spec]),
  )
  const specPaths = new Set<string>()
  const claimedSlugs = new Map<string, string>()
  let operationCount = 0
  for (const file of classification.specCandidates) {
    const known = specByPath.get(file.path)
    if (known && !force && known.repoBlobSha === file.sha) {
      specPaths.add(file.path)
      claimedSlugs.set(known.slug, file.path)
      operationCount += known.operationCount
      continue
    }
    const carried = previouslySkipped.get(file.path)
    if (!force && carried && carried.sha === file.sha) {
      skipped.push(carried)
      continue
    }
    // The source was removed in Breezify and that removal is not on GitHub yet.
    if (honorBreezifyDeletions && !known && previouslyManaged.has(file.path)) {
      awaitingDeletion.add(file.path)
      continue
    }
    const skip = (reason: string, quiet = false): void => {
      skipped.push({ path: file.path, sha: file.sha, reason, ...(quiet ? { quiet } : {}) })
    }
    if (file.size > MAX_SPEC_BYTES) {
      skip(`exceeds the ${MAX_SPEC_BYTES}-byte OpenAPI definition limit`)
      continue
    }
    const raw = await fetchText(file)
    const parsed = raw === null ? null : parseSpecDocument(raw)
    if (raw === null || !isOpenApiDocument(parsed)) {
      skip('not an OpenAPI or Swagger definition', true)
      continue
    }
    // A definition that was already uploaded (CI or Settings) under another
    // name is the same API: link the file to that source instead of creating
    // a second copy of the reference.
    const title = (parsed!.info as { title?: unknown } | undefined)?.title
    const uploaded = specs.filter(
      (spec) =>
        !spec.repoPath &&
        !claimedSlugs.has(spec.slug) &&
        typeof title === 'string' &&
        spec.title.trim().toLowerCase() === title.trim().toLowerCase(),
    )
    const slug =
      known?.slug ?? (uploaded.length === 1 ? uploaded[0]!.slug : specSlugForPath(file.path))
    const claimed = claimedSlugs.get(slug)
    if (claimed && claimed !== file.path) {
      skip(`uses the same name as ${claimed}; rename one of the files`)
      continue
    }
    claimedSlugs.set(slug, file.path)
    const outcome = await store.syncSpec({
      slug,
      raw,
      repoPath: file.path,
      repoBlobSha: file.sha,
      syncedBy: `github:${target.repoFullName}@${commit.sha.slice(0, 7)}`,
    })
    if (!outcome.ok) {
      skip(outcome.issue ?? 'is not a valid OpenAPI definition')
      continue
    }
    specPaths.add(file.path)
    created += outcome.created
    updated += outcome.updated
    removed += outcome.removed
    operationCount += outcome.operationCount
  }
  const referenceRoot = `${full('reference')}/`
  const treePaths = new Set(classification.specCandidates.map((file) => file.path))
  for (const spec of specs) {
    // The definition was deleted from the repository.
    if (spec.repoPath?.startsWith(referenceRoot) && !treePaths.has(spec.repoPath)) {
      removed += (await store.removeSpec(spec.slug)).removed
    }
  }

  // --- Folders whose directory is gone ---------------------------------------
  const [finalFolders, finalDocuments] = await Promise.all([
    store.listFolders(),
    store.listDocuments(),
  ])
  const activeDirectories = new Set(directories.map((directory) => full(directory)))
  const occupied = new Set<string>()
  for (const document of finalDocuments) {
    if (document.folderId) occupied.add(document.folderId)
  }
  const remaining = new Map(finalFolders.map((folder) => [folder.id, folder]))
  for (let pass = 0; pass < 16; pass++) {
    const parents = new Set(
      [...remaining.values()].map((folder) => folder.parentId).filter(Boolean) as string[],
    )
    const empty = [...remaining.values()].filter((folder) => {
      const link = readReadmeFolderLink(folder.metadata, repoId)
      return (
        link !== null &&
        !activeDirectories.has(link.path) &&
        !occupied.has(folder.id) &&
        !parents.has(folder.id)
      )
    })
    if (empty.length === 0) break
    for (const folder of empty) {
      await store.deleteFolder(folder.id)
      remaining.delete(folder.id)
    }
  }

  const conflictCount = finalDocuments.filter(
    (document) =>
      Number(document.metadata?.repo_id) === repoId &&
      document.metadata?.github_hosted_conflict === true,
  ).length
  const documentCount =
    [...activePaths].filter((path) => !isIndexPage(path)).length + operationCount
  const visibleSkipped = skipped.sort((a, b) => a.path.localeCompare(b.path))
  const nextState: ReadmeSyncState = {
    format: 'readme',
    root,
    order_files: orderFiles,
    managed_paths: [
      ...activePaths,
      ...awaitingDeletion,
      ...Object.keys(orderFiles),
      ...specPaths,
    ].sort((a, b) => a.localeCompare(b)),
    skipped: visibleSkipped.slice(0, MAX_SKIPPED_RECORDED),
  }
  await store.updateSource({
    sync_status: 'synced',
    sync_state: nextState,
    document_count: documentCount,
    conflict_count: conflictCount,
    last_sync_commit_sha: commit.sha,
    last_sync_at: new Date().toISOString(),
    last_sync_error: null,
    pending_sync_mode: 'merge',
  })

  return {
    repoFullName: target.repoFullName,
    ref,
    commitSha: commit.sha,
    documentCount,
    created,
    updated,
    removed,
    preserved: Math.max(conflictCount, preserved),
    moved,
    skipped: visibleSkipped,
  }
}
