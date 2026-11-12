import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  ingestFromText,
  updateDocumentEmbedding,
} from '@/rag/ingest'
import {
  getInstallationToken,
  getRepository,
  getRepositoryBlob,
  getRepositoryCommit,
  getRepositoryTree,
  type GitHubBlob,
  type GitHubTreeEntry,
} from './github'
import { withGitHubRetry } from './retry'
import { portalDocumentToMarkdown } from '@/lib/portal/portal-doc-markdown'
import {
  assertBreadHostedDocsFiles,
  BreadDocsFormatError,
} from './github-hosted-format'
import { applyGitHubHostedDocumentUpdate } from './github-hosted-document-update'
import {
  isHostedOpenApiFile,
  MAX_OPENAPI_SPEC_BYTES,
  OPENAPI_OPERATION_KIND,
  openApiFolderName,
  parseHostedOpenApiSpec,
  type GeneratedOpenApiSpec,
} from './github-hosted-openapi'

const MAX_HOSTED_DOC_BYTES = 256 * 1024
const MAX_HOSTED_DOCS = 500
const FETCH_CONCURRENCY = 6
export const DOCUMENT_SYNC_CONCURRENCY = 6

export async function refreshHostedDocumentIndex(
  documentId: string,
  workspaceId: string,
  content: string,
): Promise<void> {
  const results = await Promise.allSettled([
    ingestFromText(documentId, content),
    updateDocumentEmbedding(documentId, workspaceId, content),
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      // Indexing remains best-effort, but hosted sync must await each bounded
      // batch. Fire-and-forget work accumulated across a large repository and
      // could terminate the serverless worker before it recorded completion.
      console.error('[Bread] hosted document indexing failed:', result.reason)
    }
  }
}

export interface GitHubHostedDocsTarget {
  sourceId: string
  workspaceId: string
  installationId: number
  repoId: number
  repoFullName: string
  paths: string[]
  ref?: string
  /**
   * Retained for older callers. The selected repository root always maps to
   * the workspace root, so this no longer influences where documents land.
   */
  rootFolderId?: string | null
  documentCount?: number
  lastSyncCommitSha?: string | null
  mode?: GitHubHostedDocsSyncMode
  force?: boolean
}

export type GitHubHostedDocsSyncMode = 'merge' | 'replace_bread'

export interface GitHubHostedDocsSyncResult {
  repoFullName: string
  ref: string
  commitSha: string
  documentCount: number
  created: number
  updated: number
  removed: number
  preserved: number
  /** Documents and folders moved to mirror the repository tree (replace mode). */
  moved: number
  /** Always null: the repository root is the workspace root. */
  rootFolderId: null
}

interface HostedDocsDeps {
  admin?: SupabaseClient
  getToken?: typeof getInstallationToken
  getRepo?: typeof getRepository
  getCommit?: typeof getRepositoryCommit
  getTree?: typeof getRepositoryTree
  getBlob?: typeof getRepositoryBlob
}

export interface ParsedHostedDoc {
  path: string
  title: string
  content: string
  publicSlug: string
  relativeDirectory: string
  breadDocumentId: string | null
  /**
   * Optional `date` frontmatter, as an ISO string. Dated feeds (changelog
   * pages) order by the document's `updated_at`, so a file that declares its
   * own date keeps it across syncs instead of jumping to the sync clock.
   */
  date: string | null
  repositoryContent: string
  blobSha: string
}

interface ExistingDocument {
  id: string
  title: string
  content: string
  status?: string | null
  source_metadata: Record<string, unknown> | null
  deleted_at: string | null
  /** Carried so a sync can preserve it when the file declares no date. */
  updated_at?: string | null
  folder_id?: string | null
}

interface HostedDocsCheckpointRow {
  source_metadata: Record<string, unknown> | null
  deleted_at: string | null
  folder_id: string | null
}

export interface HostedCanonicalFolderRow {
  canonicalPath: string
  folderId: string | null
  deletedAt: string | null
}

export function hasCompleteHostedCanonicalPaths(input: {
  roots: string[]
  expectedPaths: string[]
  documents: HostedCanonicalFolderRow[]
}): boolean {
  const inSelectedRoots = (path: string): boolean =>
    input.roots.some((root) => path.startsWith(`${root}/`))
  const expected = new Set(input.expectedPaths.filter(inSelectedRoots))
  const liveCanonicalPaths = new Set(
    input.documents
      .filter(
        (document) =>
          document.deletedAt === null && inSelectedRoots(document.canonicalPath),
      )
      .map((document) => document.canonicalPath),
  )
  return (
    expected.size === liveCanonicalPaths.size &&
    [...expected].every((path) => liveCanonicalPaths.has(path))
  )
}

export interface HostedFolderParentRow {
  id: string
  parentFolderId: string | null
}

export interface HostedDirectoryResolution {
  parentFolderId: string | null
  existingPrefix: string
  missingSegments: string[]
}

export interface HostedDocsFileCheckpoint {
  blobSha: string | null
  mode: GitHubHostedDocsSyncMode | null
  deletedAt: string | null
  appliedCommitSha?: string | null
  pendingCommitSha?: string | null
  conflict?: boolean
}

export function inferHostedDirectoryFolders(input: {
  roots: string[]
  documents: HostedCanonicalFolderRow[]
  folders: HostedFolderParentRow[]
}): Map<string, string> {
  const folderById = new Map(input.folders.map((folder) => [folder.id, folder]))
  const candidates = new Map<string, Set<string>>()

  for (const document of input.documents) {
    if (document.deletedAt !== null || !document.folderId) continue
    let folderId: string | null = document.folderId
    if (!folderById.has(folderId)) continue
    const root = input.roots
      .filter((candidate) => document.canonicalPath.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (!root) continue
    const relativeDirectory = document.canonicalPath
      .slice(root.length + 1)
      .split('/')
      .slice(0, -1)
    for (let index = relativeDirectory.length - 1; index >= 0 && folderId; index--) {
      const folder = folderById.get(folderId)
      if (!folder) break
      const directory = relativeDirectory.slice(0, index + 1).join('/')
      const folderCandidates = candidates.get(directory) ?? new Set<string>()
      folderCandidates.add(folderId)
      candidates.set(directory, folderCandidates)
      folderId = folder.parentFolderId
    }
  }

  const inferred = new Map<string, string>()
  for (const [directory, folderIds] of candidates) {
    if (folderIds.size !== 1) continue
    inferred.set(directory, folderIds.values().next().value!)
  }
  return inferred
}

/**
 * The Bread folder a repository file belongs to. The selected root is the
 * workspace root, so a top-level file is folderless and every other file
 * lives in the folder established for its directory.
 */
export function hostedDocumentFolderId(input: {
  relativeDirectory: string
  cache: ReadonlyMap<string, string>
}): string | null {
  if (!input.relativeDirectory) return null
  const folderId = input.cache.get(input.relativeDirectory)
  if (!folderId) {
    throw new Error(`hosted directory was not resolved: ${input.relativeDirectory}`)
  }
  return folderId
}

export interface HostedFolderMove {
  folderId: string
  parentFolderId: string | null
}

/**
 * Folder moves that make the established directory folders mirror the
 * repository tree: a directory's folder sits under its parent directory's
 * folder, and a top-level directory's folder sits at the workspace root.
 * Folders already in place, folders whose parent directory has no resolved
 * folder, and moves that would create a cycle are left alone.
 */
export function hostedFolderReparents(input: {
  cache: ReadonlyMap<string, string>
  folders: HostedFolderParentRow[]
}): HostedFolderMove[] {
  const parentById = new Map(
    input.folders.map((folder) => [folder.id, folder.parentFolderId]),
  )
  const isAncestorOrSelf = (candidate: string, folderId: string): boolean => {
    let cursor: string | null = candidate
    let guard = 0
    while (cursor && guard < 64) {
      if (cursor === folderId) return true
      cursor = parentById.get(cursor) ?? null
      guard += 1
    }
    return false
  }
  const moves: HostedFolderMove[] = []
  const seen = new Set<string>()
  for (const [directory, folderId] of input.cache) {
    if (seen.has(folderId)) continue
    const parentDirectory = directory.split('/').slice(0, -1).join('/')
    const expectedParent = parentDirectory
      ? input.cache.get(parentDirectory) ?? null
      : null
    if (parentDirectory && expectedParent === null) continue
    if (!parentById.has(folderId)) continue
    if ((parentById.get(folderId) ?? null) === expectedParent) continue
    if (expectedParent && isAncestorOrSelf(expectedParent, folderId)) continue
    seen.add(folderId)
    moves.push({ folderId, parentFolderId: expectedParent })
  }
  return moves
}

export function resolveHostedDirectory(input: {
  relativeDirectory: string
  rootFolderId: string | null
  cache: ReadonlyMap<string, string>
}): HostedDirectoryResolution {
  const segments = input.relativeDirectory.split('/').filter(Boolean)
  for (let depth = segments.length; depth > 0; depth--) {
    const existingPrefix = segments.slice(0, depth).join('/')
    const folderId = input.cache.get(existingPrefix)
    if (folderId) {
      return {
        parentFolderId: folderId,
        existingPrefix,
        missingSegments: segments.slice(depth),
      }
    }
  }
  return {
    parentFolderId: input.rootFolderId,
    existingPrefix: '',
    missingSegments: segments,
  }
}

export function hostedContentHash(content: unknown): string {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content ?? null)
  return createHash('sha256').update(serialized).digest('hex')
}

export function hasEquivalentHostedContent(current: unknown, incoming: string): boolean {
  if (typeof current !== 'string') return false
  return portalDocumentToMarkdown(current) === portalDocumentToMarkdown(incoming)
}

export function shouldApplyGitHubHostedContent(input: {
  mode: GitHubHostedDocsSyncMode
  currentContent: unknown
  incomingContent: string
  sourceMetadata: Record<string, unknown> | null
}): boolean {
  if (input.mode === 'replace_bread') return true
  const currentHash = hostedContentHash(input.currentContent)
  const incomingHash = hostedContentHash(input.incomingContent)
  if (currentHash === incomingHash) return true
  // Bread's editor persists authored content as HTML while the GitHub mirror
  // is Markdown. Treat matching rendered Markdown as convergence so a merged
  // Bread-authored PR clears the pending local-edit state instead of creating
  // a false conflict.
  if (hasEquivalentHostedContent(input.currentContent, input.incomingContent)) {
    return true
  }
  return input.sourceMetadata?.github_hosted_content_hash === currentHash
}

export function shouldDeleteStaleHostedDocument(input: {
  mode: GitHubHostedDocsSyncMode
  currentContent: unknown
  sourceMetadata: Record<string, unknown> | null
}): boolean {
  if (input.mode === 'replace_bread') return true
  return input.sourceMetadata?.github_hosted_content_hash ===
    hostedContentHash(input.currentContent)
}

export function shouldRefreshHostedDocumentIndex(input: {
  priorStatus: string | null | undefined
  currentContent: unknown
  incomingContent: string
}): boolean {
  return (
    input.priorStatus !== 'Published' ||
    hostedContentHash(input.currentContent) !== hostedContentHash(input.incomingContent)
  )
}

export function shouldSkipGitHubHostedDoc(input: {
  mode: GitHubHostedDocsSyncMode
  force: boolean | undefined
  currentBlobSha: string
  currentCommitSha: string
  lastSyncCommitSha: string | null | undefined
  checkpoints: HostedDocsFileCheckpoint[]
}): boolean {
  return (
    !input.force &&
    input.checkpoints.length > 0 &&
    input.checkpoints.every((checkpoint) => {
      if (checkpoint.deletedAt !== null) return false
      const explicitCheckpointMatches =
        checkpoint.blobSha === input.currentBlobSha &&
        checkpoint.mode === input.mode &&
        (
          input.mode === 'merge' ||
          checkpoint.appliedCommitSha === input.currentCommitSha
        )
      const legacyCheckpointMatches =
        checkpoint.blobSha === null &&
        checkpoint.mode === null &&
        input.lastSyncCommitSha !== input.currentCommitSha &&
        (
          checkpoint.appliedCommitSha === input.currentCommitSha ||
          (
            input.mode === 'merge' &&
            checkpoint.conflict === true &&
            checkpoint.pendingCommitSha === input.currentCommitSha
          )
        )
      return explicitCheckpointMatches || legacyCheckpointMatches
    })
  )
}

function decodeHostedDocsBlob(blob: GitHubBlob): string | null {
  if (blob.encoding !== 'base64') return null
  const decoded = Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8')
  if (!decoded.trim() || decoded.includes('\u0000')) return null
  const replacements = decoded.match(/\uFFFD/g)?.length ?? 0
  if (replacements > Math.max(2, decoded.length * 0.01)) return null
  return decoded.replace(/\r\n?/g, '\n')
}

export function normalizeHostedDocsPaths(paths: string[]): string[] {
  const normalized = paths
    .map((value) => value.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .filter((value) => {
      const segments = value.split('/')
      return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    })
    .sort((a, b) => a.localeCompare(b))

  // Selecting a parent already includes all descendants, so collapse redundant
  // child selections before persisting them.
  const roots: string[] = []
  for (const path of [...new Set(normalized)]) {
    if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) {
      roots.push(path)
    }
  }
  return roots
}

export function isHostedDocsFile(entry: GitHubTreeEntry, roots: string[]): boolean {
  if (entry.type !== 'blob') return false
  const lower = entry.path.toLowerCase()
  if (!lower.endsWith('.md') && !lower.endsWith('.mdx')) return false
  return roots.some((root) => entry.path.startsWith(`${root}/`))
}

function stripJsxOutsideCode(line: string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part) => part.startsWith('`') ? part : part.replace(/<\/?[A-Za-z][^>]*?>/g, ''))
    .join('')
}

export function mdxToHostedMarkdown(body: string): string {
  const noSvg = body.replace(/<svg[\s\S]*?<\/svg>/gi, '')
  const lines = noSvg.split(/\r?\n/)
  const output: string[] = []
  let inFence = false
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.test(line)
    if (fence) inFence = !inFence
    if (inFence || fence) {
      output.push(line)
      continue
    }
    if (/^\s*(import|export)\s/.test(line)) continue
    output.push(stripJsxOutsideCode(line))
  }
  return output
    .join('\n')
    .replace(/^\s*#\s+.+?(\r?\n)/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim())
    if (!field) continue
    let value = field[2]!.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    data[field[1]!] = value
  }
  return { data, body: raw.slice(match[0].length) }
}

export function repositoryFileToHostedMarkdown(raw: string): string {
  return mdxToHostedMarkdown(parseFrontmatter(raw).body)
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.(mdx|md)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '')
}

function titleCase(value: string): string {
  return value
    .replace(/\.(mdx|md)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function closestRoot(filePath: string, roots: string[]): string {
  return roots
    .filter((root) => filePath.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0]!
}

/**
 * The optional `date` frontmatter, normalized to ISO. A file that declares a
 * date owns its document's PUBLICATION date (stored in source_metadata), which
 * is what a dated feed orders by — so the repository stays the source of truth
 * for where an entry sits, and editing the document later cannot move it.
 * An absent or unparseable value leaves any stored date untouched.
 */
export function hostedDocDate(value: string | undefined): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

export function parseGitHubHostedDocument(
  path: string,
  raw: string,
  roots: string[],
  repoId: number,
  blobSha: string,
): ParsedHostedDoc {
  const root = closestRoot(path, roots)
  const relativePath = path.slice(root.length + 1)
  const { data } = parseFrontmatter(raw)
  const fallbackTitle = titleCase(relativePath.split('/').at(-1) ?? 'Document')
  const requestedSlug = data.public_slug?.trim().replace(/^\/+|\/+$/g, '')
  return {
    path,
    title: (data.title || data.sidebar_label || fallbackTitle).trim(),
    content: repositoryFileToHostedMarkdown(raw),
    // Canonical Bread imports keep their established authored slugs because
    // they are updated in place. Connector-created rows use a repo-scoped slug
    // so two repositories can both contain `intro.mdx` without colliding.
    publicSlug: `github-${repoId}-${slugify(requestedSlug || path)}`,
    relativeDirectory: relativePath.split('/').slice(0, -1).join('/'),
    breadDocumentId: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      data.bread_document_id ?? '',
    )
      ? data.bread_document_id!
      : null,
    date: hostedDocDate(data.date),
    repositoryContent: raw,
    blobSha,
  }
}

function hostedDocsRootName(repoId: number): string {
  return `github-hosted-docs-${repoId}`
}

async function findOrCreateFolder(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    name: string
    displayName: string
    parentId: string | null
    visibility?: string
    requiredRole?: string | null
  },
): Promise<string> {
  const { data: existing, error: lookupError } = await admin
    .from('folders')
    .select('id, display_name, parent_folder_id')
    .eq('workspace_id', input.workspaceId)
    .eq('kind', 'user')
    .eq('name', input.name)
    .maybeSingle()
  if (lookupError) throw new Error(`folder lookup: ${lookupError.message}`)
  if (existing) {
    const row = existing as { id: string; display_name: string; parent_folder_id: string | null }
    if (row.display_name !== input.displayName || row.parent_folder_id !== input.parentId) {
      const { error } = await admin
        .from('folders')
        .update({ display_name: input.displayName, parent_folder_id: input.parentId })
        .eq('id', row.id)
        .eq('workspace_id', input.workspaceId)
      if (error) throw new Error(`folder update: ${error.message}`)
    }
    return row.id
  }

  const { data, error } = await admin
    .from('folders')
    .insert({
      workspace_id: input.workspaceId,
      kind: 'user',
      name: input.name,
      display_name: input.displayName,
      visibility: input.visibility ?? 'workspace',
      required_role: input.requiredRole ?? null,
      parent_folder_id: input.parentId,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`folder insert: ${error?.message ?? 'no row returned'}`)
  return (data as { id: string }).id
}

interface HostedParentAccessRow {
  visibility?: unknown
  required_role?: unknown
}

async function ensureDirectory(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    repoId: number
    relativeDirectory: string
  },
  cache: Map<string, string>,
): Promise<string | null> {
  if (!input.relativeDirectory) return null
  const resolution = resolveHostedDirectory({
    relativeDirectory: input.relativeDirectory,
    rootFolderId: null,
    cache,
  })
  if (resolution.missingSegments.length === 0) return resolution.parentFolderId
  // A new suffix belongs to the deepest established directory, so inherit its
  // access policy. A new top-level directory sits at the workspace root with
  // workspace-wide access.
  let parentFolder: HostedParentAccessRow | null = null
  if (resolution.parentFolderId) {
    const { data, error: parentFolderError } = await admin
      .from('folders')
      .select('visibility, required_role')
      .eq('id', resolution.parentFolderId)
      .eq('workspace_id', input.workspaceId)
      .maybeSingle()
    if (parentFolderError) {
      throw new Error(`hosted parent access lookup: ${parentFolderError.message}`)
    }
    parentFolder = (data ?? null) as HostedParentAccessRow | null
  }
  let parentId: string | null = resolution.parentFolderId
  let accumulated = resolution.existingPrefix
  for (const segment of resolution.missingSegments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    const folderId = await findOrCreateFolder(admin, {
      workspaceId: input.workspaceId,
      name: `${hostedDocsRootName(input.repoId)}-${slugify(accumulated)}`,
      displayName: titleCase(segment),
      parentId,
      visibility:
        typeof parentFolder?.visibility === 'string'
          ? parentFolder.visibility
          : 'workspace',
      requiredRole:
        typeof parentFolder?.required_role === 'string'
          ? parentFolder.required_role
          : null,
    })
    cache.set(accumulated, folderId)
    parentId = folderId
  }
  return parentId
}

/**
 * Keep one lightweight repository-file record for each linked docs file so the
 * existing versioned draft/commit/PR editor can operate without indexing the
 * entire repository. This deliberately skips chunking and embeddings. If the
 * repository is monitored later, its normal indexer adopts and fully indexes
 * the same document.
 */
async function ensureRepositoryCompanion(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    repoId: number
    repoFullName: string
    ref: string
    commitSha: string
    doc: ParsedHostedDoc
  },
): Promise<string> {
  const sourceMetadata = {
    kind: 'repository_file',
    repo_id: input.repoId,
    repo_full_name: input.repoFullName,
    path: input.doc.path,
    ref: input.ref,
    commit_sha: input.commitSha,
    blob_sha: input.doc.blobSha,
    hosted_docs_companion: true,
  }
  const { data: existing, error: existingError } = await admin
    .from('documents')
    .select('id, source_metadata')
    .eq('workspace_id', input.workspaceId)
    .eq('source', 'GitHub')
    .contains('source_metadata', {
      kind: 'repository_file',
      repo_id: input.repoId,
      path: input.doc.path,
    })
    .is('deleted_at', null)
    .maybeSingle()
  if (existingError) {
    throw new Error(`hosted repository companion lookup: ${existingError.message}`)
  }

  let documentId = (existing as { id?: string } | null)?.id ?? null
  if (documentId) {
    const priorMetadata = (
      existing as { source_metadata?: Record<string, unknown> | null }
    ).source_metadata
    const { error } = await admin
      .from('documents')
      .update({
        title: `${input.repoFullName}/${input.doc.path}`,
        content: input.doc.repositoryContent,
        source_metadata: { ...(priorMetadata ?? {}), ...sourceMetadata },
        deleted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', documentId)
      .eq('workspace_id', input.workspaceId)
    if (error) throw new Error(`hosted repository companion update: ${error.message}`)
  } else {
    const { data: inserted, error } = await admin
      .from('documents')
      .insert({
        workspace_id: input.workspaceId,
        title: `${input.repoFullName}/${input.doc.path}`,
        content: input.doc.repositoryContent,
        source: 'GitHub',
        status: 'Draft',
        author: 'GitHub',
        source_metadata: sourceMetadata,
      })
      .select('id')
      .single()
    if (error?.code === '23505') {
      const { data: raced, error: racedError } = await admin
        .from('documents')
        .select('id')
        .eq('workspace_id', input.workspaceId)
        .eq('source', 'GitHub')
        .contains('source_metadata', {
          kind: 'repository_file',
          repo_id: input.repoId,
          path: input.doc.path,
        })
        .is('deleted_at', null)
        .maybeSingle()
      if (racedError || !raced) {
        throw new Error(
          `hosted repository companion race: ${racedError?.message ?? 'no row returned'}`,
        )
      }
      documentId = (raced as { id: string }).id
    } else if (error || !inserted) {
      throw new Error(
        `hosted repository companion insert: ${error?.message ?? 'no row returned'}`,
      )
    } else {
      documentId = (inserted as { id: string }).id
    }
  }

  const { data: fileState, error: fileStateError } = await admin
    .from('github_repo_files')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .eq('repo_id', input.repoId)
    .eq('path', input.doc.path)
    .maybeSingle()
  if (fileStateError) {
    throw new Error(`hosted repository file lookup: ${fileStateError.message}`)
  }
  const filePatch = {
    repo_full_name: input.repoFullName,
    document_id: documentId,
    last_seen_commit_sha: input.commitSha,
    removed_at: null,
    last_synced_at: new Date().toISOString(),
  }
  const fileResult = fileState
    ? await admin.from('github_repo_files').update(filePatch).eq('id', fileState.id)
    : await admin.from('github_repo_files').insert({
      workspace_id: input.workspaceId,
      repo_id: input.repoId,
      path: input.doc.path,
      blob_sha: null,
      ...filePatch,
    })
  if (fileResult.error) {
    throw new Error(`hosted repository file pointer: ${fileResult.error.message}`)
  }
  return documentId!
}

async function persistStatus(
  admin: SupabaseClient,
  sourceId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from('github_hosted_docs_sources')
    .update(patch)
    .eq('id', sourceId)
  if (error) console.error('[Bread] hosted docs status update failed:', error.message)
}

function safeHostedDocsError(err: unknown): string {
  if (err instanceof BreadDocsFormatError) {
    const issue = err.issues[0]
    return issue
      ? `GitHub docs format check failed: ${issue.path}: ${issue.message}.`
      : 'GitHub docs format check failed.'
  }
  const status = (err as { status?: number }).status
  if (status === 403 || status === 404) {
    return 'GitHub can no longer read the selected documentation folders.'
  }
  return 'Hosted documentation sync failed. Retry from GitHub settings.'
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  async function worker(): Promise<void> {
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

async function hasCompleteLiveHostedCanonicalPaths(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    repoId: number
    roots: string[]
    expectedPaths: string[]
  },
): Promise<boolean> {
  const expectedPaths = [...new Set(input.expectedPaths)]
  const documents: HostedCanonicalFolderRow[] = []
  const pageSize = 500
  let offset = 0
  while (true) {
    const { data, error } = await admin
      .from('documents')
      .select('id, source_metadata, deleted_at, folder_id')
      .eq('workspace_id', input.workspaceId)
      .contains('source_metadata', { repo_id: input.repoId })
      .not('source_metadata->>canonical_repo_path', 'is', null)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) {
      throw new Error(`hosted document integrity lookup: ${error.message}`)
    }
    const rows = (data ?? []) as HostedDocsCheckpointRow[]
    documents.push(...rows.flatMap((row): HostedCanonicalFolderRow[] => {
      const canonicalPath = row.source_metadata?.canonical_repo_path
      return typeof canonicalPath === 'string'
        ? [{
          canonicalPath,
          folderId: row.folder_id,
          deletedAt: row.deleted_at,
        }]
        : []
    }))
    if (rows.length < pageSize) break
    offset += rows.length
  }
  return hasCompleteHostedCanonicalPaths({
    roots: input.roots,
    expectedPaths,
    documents,
  })
}

async function hasLiveOpenApiSpecs(
  admin: SupabaseClient,
  input: { workspaceId: string; repoId: number; specPaths: string[] },
): Promise<boolean> {
  if (input.specPaths.length === 0) return true
  const { data, error } = await admin
    .from('documents')
    .select('source_metadata')
    .eq('workspace_id', input.workspaceId)
    .contains('source_metadata', { kind: OPENAPI_OPERATION_KIND, repo_id: input.repoId })
    .in('source_metadata->>path', input.specPaths)
    .is('deleted_at', null)
  if (error) throw new Error(`hosted OpenAPI integrity lookup: ${error.message}`)
  const live = new Set(
    (data ?? []).map((row) => (row.source_metadata as Record<string, unknown> | null)?.path),
  )
  return input.specPaths.every((path) => live.has(path))
}

export async function loadHostedOpenApiSpecs(input: {
  entries: GitHubTreeEntry[]
  repoId: number
  fetchRaw: (entry: GitHubTreeEntry) => Promise<string | null>
}): Promise<GeneratedOpenApiSpec[]> {
  const results = await mapWithConcurrency(
    input.entries,
    FETCH_CONCURRENCY,
    async (entry) => {
      const raw = await input.fetchRaw(entry)
      if (!raw) {
        return {
          spec: null,
          issues: [{ path: entry.path, message: 'must be valid non-empty UTF-8 text' }],
        }
      }
      return parseHostedOpenApiSpec({ specPath: entry.path, raw, repoId: input.repoId })
    },
  )
  const issues = results.flatMap((result) => result.issues)
  if (issues.length > 0) throw new BreadDocsFormatError(issues)
  return results.flatMap((result) => (result.spec ? [result.spec] : []))
}

interface OpenApiDocumentRow {
  id: string
  title: string
  content: string
  status?: string | null
  folder_id: string | null
  sort_order: number | null
  source_metadata: Record<string, unknown> | null
}

export async function upsertOpenApiFolder(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    name: string
    displayName: string
    parentId: string | null
    sortOrder: number | null
  },
): Promise<string> {
  const { data: existing, error: lookupError } = await admin
    .from('folders')
    .select('id, display_name, parent_folder_id, sort_order')
    .eq('workspace_id', input.workspaceId)
    .eq('kind', 'user')
    .eq('name', input.name)
    .maybeSingle()
  if (lookupError) throw new Error(`OpenAPI folder lookup: ${lookupError.message}`)
  if (existing) {
    const row = existing as {
      id: string
      display_name: string
      parent_folder_id: string | null
      sort_order: number | null
    }
    if (
      row.display_name !== input.displayName ||
      row.parent_folder_id !== input.parentId ||
      (row.sort_order ?? null) !== input.sortOrder
    ) {
      const { error } = await admin
        .from('folders')
        .update({
          display_name: input.displayName,
          parent_folder_id: input.parentId,
          sort_order: input.sortOrder,
        })
        .eq('id', row.id)
        .eq('workspace_id', input.workspaceId)
      if (error) throw new Error(`OpenAPI folder update: ${error.message}`)
    }
    return row.id
  }

  // New folders inherit the access policy of the directory they sit in.
  let visibility = 'workspace'
  let requiredRole: string | null = null
  if (input.parentId) {
    const { data, error } = await admin
      .from('folders')
      .select('visibility, required_role')
      .eq('id', input.parentId)
      .eq('workspace_id', input.workspaceId)
      .maybeSingle()
    if (error) throw new Error(`OpenAPI parent access lookup: ${error.message}`)
    const parent = (data ?? null) as HostedParentAccessRow | null
    if (typeof parent?.visibility === 'string') visibility = parent.visibility
    if (typeof parent?.required_role === 'string') requiredRole = parent.required_role
  }
  const { data, error } = await admin
    .from('folders')
    .insert({
      workspace_id: input.workspaceId,
      kind: 'user',
      name: input.name,
      display_name: input.displayName,
      visibility,
      required_role: requiredRole,
      parent_folder_id: input.parentId,
      sort_order: input.sortOrder,
    })
    .select('id')
    .single()
  if (error || !data) {
    throw new Error(`OpenAPI folder insert: ${error?.message ?? 'no row returned'}`)
  }
  return (data as { id: string }).id
}

/**
 * Mirror parsed OpenAPI specs into generated, GitHub-owned reference pages:
 * one folder per spec (named after `info.title`), one subfolder per tag, one
 * page per operation. The repository is authoritative, so Bread edits to these
 * pages are overwritten (with a version snapshot) on the next sync, and pages
 * whose operation or spec disappeared are removed.
 */
async function syncHostedOpenApiSpecs(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    repoId: number
    repoFullName: string
    ref: string
    commitSha: string
    roots: string[]
    specs: GeneratedOpenApiSpec[]
    directoryCache: Map<string, string>
  },
): Promise<{ created: number; updated: number; removed: number; documentCount: number }> {
  let created = 0
  let updated = 0
  const staleIds: string[] = []

  const { data: existingData, error: existingError } = await admin
    .from('documents')
    .select('id, title, content, status, folder_id, sort_order, source_metadata')
    .eq('workspace_id', input.workspaceId)
    .contains('source_metadata', { kind: OPENAPI_OPERATION_KIND, repo_id: input.repoId })
    .is('deleted_at', null)
  if (existingError) throw new Error(`OpenAPI document lookup: ${existingError.message}`)
  const existingBySpec = new Map<string, Map<string, OpenApiDocumentRow>>()
  for (const row of (existingData ?? []) as OpenApiDocumentRow[]) {
    const specPath = row.source_metadata?.path
    const key = row.source_metadata?.openapi_operation_key
    if (typeof specPath !== 'string' || typeof key !== 'string') {
      staleIds.push(row.id)
      continue
    }
    const byKey = existingBySpec.get(specPath) ?? new Map<string, OpenApiDocumentRow>()
    // A duplicate row for the same operation is left over from an interrupted
    // sync; keep the first and remove the rest.
    if (byKey.has(key)) staleIds.push(row.id)
    else byKey.set(key, row)
    existingBySpec.set(specPath, byKey)
  }

  const activeSpecPaths = new Set(input.specs.map((spec) => spec.specPath))
  for (const [specPath, rows] of existingBySpec) {
    if (!activeSpecPaths.has(specPath)) staleIds.push(...[...rows.values()].map((row) => row.id))
  }

  for (const spec of input.specs) {
    const root = closestRoot(spec.specPath, input.roots)
    const relativeDirectory = spec.specPath
      .slice(root.length + 1)
      .split('/')
      .slice(0, -1)
      .join('/')
    const parentId = await ensureDirectory(admin, {
      workspaceId: input.workspaceId,
      repoId: input.repoId,
      relativeDirectory,
    }, input.directoryCache)
    const specFolderId = await upsertOpenApiFolder(admin, {
      workspaceId: input.workspaceId,
      name: openApiFolderName(input.repoId, spec.specPath),
      displayName: spec.title,
      parentId,
      sortOrder: null,
    })
    const tagFolderIds = new Map<string, string>()
    for (const operation of spec.operations) {
      if (tagFolderIds.has(operation.tag)) continue
      tagFolderIds.set(operation.tag, await upsertOpenApiFolder(admin, {
        workspaceId: input.workspaceId,
        name: openApiFolderName(input.repoId, spec.specPath, operation.tag),
        displayName: operation.tag,
        parentId: specFolderId,
        sortOrder: operation.tagOrder,
      }))
    }

    const existing = existingBySpec.get(spec.specPath) ?? new Map<string, OpenApiDocumentRow>()
    const activeKeys = new Set(spec.operations.map((operation) => operation.key))
    for (const [key, row] of existing) {
      if (!activeKeys.has(key)) staleIds.push(row.id)
    }

    const syncOperation = async (
      operation: GeneratedOpenApiSpec['operations'][number],
    ): Promise<void> => {
      const folderId = tagFolderIds.get(operation.tag)!
      const contentHash = hostedContentHash(operation.content)
      const metadata = {
        kind: OPENAPI_OPERATION_KIND,
        repo_id: input.repoId,
        repo_full_name: input.repoFullName,
        path: spec.specPath,
        openapi_operation_key: operation.key,
        openapi_spec_title: spec.title,
        openapi_spec_version: spec.version,
        ref: input.ref,
        commit_sha: input.commitSha,
        github_hosted_content_hash: contentHash,
      }
      const row = existing.get(operation.key)
      if (!row) {
        const { data: inserted, error } = await admin
          .from('documents')
          .insert({
            workspace_id: input.workspaceId,
            title: operation.title,
            content: operation.content,
            document_type: 'page',
            public_slug: operation.publicSlug,
            folder_id: folderId,
            sort_order: operation.order,
            source: 'docs',
            status: 'Published',
            author: 'GitHub',
            source_metadata: metadata,
          })
          .select('id')
          .single()
        if (error || !inserted) {
          throw new Error(`OpenAPI document insert: ${error?.message ?? 'no row returned'}`)
        }
        created++
        await refreshHostedDocumentIndex(
          (inserted as { id: string }).id,
          input.workspaceId,
          operation.content,
        )
        return
      }

      if (row.folder_id !== folderId || (row.sort_order ?? null) !== operation.order) {
        const { error } = await admin
          .from('documents')
          .update({ folder_id: folderId, sort_order: operation.order })
          .eq('id', row.id)
          .eq('workspace_id', input.workspaceId)
        if (error) throw new Error(`OpenAPI document move: ${error.message}`)
      }
      const contentChanged = !hasEquivalentHostedContent(row.content, operation.content)
      if (!contentChanged && row.title === operation.title) {
        if (row.source_metadata?.commit_sha !== input.commitSha) {
          const { error } = await admin
            .from('documents')
            .update({ source_metadata: { ...(row.source_metadata ?? {}), ...metadata } })
            .eq('id', row.id)
            .eq('workspace_id', input.workspaceId)
          if (error) throw new Error(`OpenAPI document metadata: ${error.message}`)
        }
        return
      }
      await applyGitHubHostedDocumentUpdate(admin, {
        documentId: row.id,
        workspaceId: input.workspaceId,
        expectedTitle: row.title,
        expectedContent: row.content,
        title: operation.title,
        content: operation.content,
        sourceMetadataPatch: metadata,
        updatedAt: new Date().toISOString(),
      })
      updated++
      if (shouldRefreshHostedDocumentIndex({
        priorStatus: row.status,
        currentContent: row.content,
        incomingContent: operation.content,
      })) {
        await refreshHostedDocumentIndex(row.id, input.workspaceId, operation.content)
      }
    }
    for (
      let batchStart = 0;
      batchStart < spec.operations.length;
      batchStart += DOCUMENT_SYNC_CONCURRENCY
    ) {
      await mapWithConcurrency(
        spec.operations.slice(batchStart, batchStart + DOCUMENT_SYNC_CONCURRENCY),
        DOCUMENT_SYNC_CONCURRENCY,
        syncOperation,
      )
    }
  }

  const uniqueStaleIds = [...new Set(staleIds)]
  if (uniqueStaleIds.length > 0) {
    const now = new Date().toISOString()
    const { error } = await admin
      .from('documents')
      .update({ deleted_at: now, updated_at: now })
      .eq('workspace_id', input.workspaceId)
      .in('id', uniqueStaleIds)
    if (error) throw new Error(`OpenAPI stale document cleanup: ${error.message}`)
  }

  return {
    created,
    updated,
    removed: uniqueStaleIds.length,
    documentCount: input.specs.reduce((total, spec) => total + spec.operations.length, 0),
  }
}

/** Mirror selected GitHub Markdown/MDX directories into curated Bread docs. */
export async function syncGitHubHostedDocs(
  target: GitHubHostedDocsTarget,
  deps: HostedDocsDeps = {},
): Promise<GitHubHostedDocsSyncResult> {
  const paths = normalizeHostedDocsPaths(target.paths)
  const mode = target.mode ?? 'merge'
  if (paths.length === 0) throw new Error('At least one hosted docs folder is required.')

  const admin = deps.admin ?? createAdminClient()
  await persistStatus(admin, target.sourceId, {
    sync_status: 'syncing',
    last_sync_error: null,
  })

  try {
    const getToken = deps.getToken ?? getInstallationToken
    const getRepo = deps.getRepo ?? getRepository
    const getCommit = deps.getCommit ?? getRepositoryCommit
    const getTree = deps.getTree ?? getRepositoryTree
    const getBlob = deps.getBlob ?? getRepositoryBlob
    const token = await withGitHubRetry(() => getToken(target.installationId))
    const ref = target.ref ?? (await withGitHubRetry(() => getRepo(token, target.repoFullName))).default_branch
    const commit = await withGitHubRetry(() => getCommit(token, target.repoFullName, ref))
    const tree = await withGitHubRetry(() => getTree(token, target.repoFullName, commit.commit.tree.sha))
    const entries = tree.tree.filter((entry) => isHostedDocsFile(entry, paths))
    const specEntries = tree.tree.filter((entry) => isHostedOpenApiFile(entry, paths))
    if (entries.length > MAX_HOSTED_DOCS) {
      throw new Error(`Hosted docs source exceeds the ${MAX_HOSTED_DOCS}-document limit.`)
    }
    const oversizedEntry = entries.find(
      (entry) => (entry.size ?? 0) > MAX_HOSTED_DOC_BYTES,
    )
    if (oversizedEntry) {
      throw new BreadDocsFormatError([{
        path: oversizedEntry.path,
        message: `exceeds the ${MAX_HOSTED_DOC_BYTES}-byte Bread sync limit`,
      }])
    }
    const oversizedSpec = specEntries.find(
      (entry) => (entry.size ?? 0) > MAX_OPENAPI_SPEC_BYTES,
    )
    if (oversizedSpec) {
      throw new BreadDocsFormatError([{
        path: oversizedSpec.path,
        message: `exceeds the ${MAX_OPENAPI_SPEC_BYTES}-byte OpenAPI spec limit`,
      }])
    }
    if (
      !target.force &&
      mode === 'merge' &&
      target.lastSyncCommitSha === commit.sha &&
      await hasCompleteLiveHostedCanonicalPaths(admin, {
        workspaceId: target.workspaceId,
        repoId: target.repoId,
        roots: paths,
        expectedPaths: entries.map((entry) => entry.path),
      }) &&
      await hasLiveOpenApiSpecs(admin, {
        workspaceId: target.workspaceId,
        repoId: target.repoId,
        specPaths: specEntries.map((entry) => entry.path),
      })
    ) {
      await persistStatus(admin, target.sourceId, {
        sync_status: 'synced',
        // Generated OpenAPI pages are counted on a full sync; keep that total.
        document_count: Math.max(entries.length, target.documentCount ?? 0),
        last_sync_at: new Date().toISOString(),
        last_sync_error: null,
        pending_pull_request_number: null,
        pending_pull_request_url: null,
        pending_pull_request_head: null,
        pending_sync_mode: 'merge',
      })
      return {
        repoFullName: target.repoFullName,
        ref,
        commitSha: commit.sha,
        documentCount: Math.max(entries.length, target.documentCount ?? 0),
        created: 0,
        updated: 0,
        removed: 0,
        preserved: 0,
        moved: 0,
        rootFolderId: null,
      }
    }

    // The selected repository root is the workspace root: top-level files are
    // folderless documents and top-level directories are top-level folders.
    // No connector-owned container folder is created.
    const repositoryFiles = await mapWithConcurrency(
      entries,
      FETCH_CONCURRENCY,
      async (entry) => {
        const blob = await withGitHubRetry(() =>
          getBlob(token, target.repoFullName, entry.sha),
        )
        const raw = decodeHostedDocsBlob(blob)
        if (!raw) {
          throw new BreadDocsFormatError([{
            path: entry.path,
            message: 'must be valid non-empty UTF-8 text',
          }])
        }
        return { entry, raw }
      },
    )
    assertBreadHostedDocsFiles(
      repositoryFiles.map(({ entry, raw }) => ({ path: entry.path, content: raw })),
    )
    const parsedDocs = repositoryFiles.map(({ entry, raw }) =>
      parseGitHubHostedDocument(entry.path, raw, paths, target.repoId, entry.sha),
    )
    // Specs are validated before any write so a broken spec fails the sync the
    // same way a malformed Markdown file does, leaving the workspace untouched.
    const openApiSpecs = await loadHostedOpenApiSpecs({
      entries: specEntries,
      repoId: target.repoId,
      fetchRaw: async (entry) =>
        decodeHostedDocsBlob(
          await withGitHubRetry(() => getBlob(token, target.repoFullName, entry.sha)),
        ),
    })

    // Load canonical rows in bounded batches so long paths cannot produce an
    // oversized PostgREST URL. The same preload drives two independent pieces
    // of state: per-row resume checkpoints and the established Bread folder
    // ancestry used for new sibling files. Force bypasses checkpoint skipping,
    // but must still reuse the canonical taxonomy.
    const checkpointsByPath = new Map<string, HostedDocsFileCheckpoint[]>()
    const checkpointPathBatches: string[][] = []
    for (let index = 0; index < entries.length; index += 50) {
      checkpointPathBatches.push(entries.slice(index, index + 50).map((entry) => entry.path))
    }
    const checkpointResults = await mapWithConcurrency(
      checkpointPathBatches,
      FETCH_CONCURRENCY,
      async (checkpointPaths) => {
        const { data, error } = await admin
          .from('documents')
          .select('source_metadata, deleted_at, folder_id')
          .eq('workspace_id', target.workspaceId)
          .in('source_metadata->>canonical_repo_path', checkpointPaths)
        if (error) {
          throw new Error(`hosted document checkpoint lookup: ${error.message}`)
        }
        return (data ?? []) as HostedDocsCheckpointRow[]
      },
    )
    const canonicalFolderRows: HostedCanonicalFolderRow[] = []
    for (const row of checkpointResults.flat()) {
      const path = row.source_metadata?.canonical_repo_path
      if (typeof path !== 'string') continue
      canonicalFolderRows.push({
        canonicalPath: path,
        folderId: row.folder_id,
        deletedAt: row.deleted_at,
      })
      const checkpoints = checkpointsByPath.get(path) ?? []
      const explicitBlobSha = row.source_metadata?.github_hosted_checkpoint_blob_sha
      const explicitMode = row.source_metadata?.github_hosted_checkpoint_mode
      const hasExplicitMode = explicitMode === 'merge' || explicitMode === 'replace_bread'
      checkpoints.push({
        blobSha: typeof explicitBlobSha === 'string' ? explicitBlobSha : null,
        mode: hasExplicitMode ? explicitMode : null,
        deletedAt: row.deleted_at,
        appliedCommitSha:
          typeof row.source_metadata?.commit_sha === 'string'
            ? row.source_metadata.commit_sha
            : null,
        pendingCommitSha:
          typeof row.source_metadata?.github_hosted_pending_commit_sha === 'string'
            ? row.source_metadata.github_hosted_pending_commit_sha
            : null,
        conflict: row.source_metadata?.github_hosted_conflict === true,
      })
      checkpointsByPath.set(path, checkpoints)
    }
    const { data: folderRows, error: folderRowsError } = await admin
      .from('folders')
      .select('id, parent_folder_id')
      .eq('workspace_id', target.workspaceId)
      .eq('kind', 'user')
    if (folderRowsError) {
      throw new Error(`hosted folder ancestry lookup: ${folderRowsError.message}`)
    }
    const directoryCache = inferHostedDirectoryFolders({
      roots: paths,
      documents: canonicalFolderRows,
      folders: (folderRows ?? []).map((folder) => ({
        id: folder.id as string,
        parentFolderId: folder.parent_folder_id as string | null,
      })),
    })

    // Resolve folder ancestry before document writes. Directories at one depth
    // can be created together, but every parent depth completes first so the
    // shared cache is deterministic and document reconciliation can then run
    // with bounded concurrency without folder races.
    const directoryDepths = new Map<number, Set<string>>()
    for (const relativeDirectory of parsedDocs
      .map((doc) => doc.relativeDirectory)
      .filter(Boolean)) {
      const segments = relativeDirectory.split('/')
      for (let index = 1; index <= segments.length; index++) {
        const prefix = segments.slice(0, index).join('/')
        if (directoryCache.has(prefix)) continue
        const directories = directoryDepths.get(index) ?? new Set<string>()
        directories.add(prefix)
        directoryDepths.set(index, directories)
      }
    }
    for (const depth of [...directoryDepths.keys()].sort((a, b) => a - b)) {
      await mapWithConcurrency(
        [...(directoryDepths.get(depth) ?? [])],
        DOCUMENT_SYNC_CONCURRENCY,
        (relativeDirectory) =>
          ensureDirectory(admin, {
            workspaceId: target.workspaceId,
            repoId: target.repoId,
            relativeDirectory,
          }, directoryCache),
      )
    }

    let created = 0
    let updated = 0
    let preserved = 0
    let moved = 0

    // The folder tree mirrors the repository in every mode: an established
    // directory folder moves under its parent directory's folder, or to the
    // workspace root for a top-level directory. This is what lifts a tree out
    // of a legacy "<Repo> Docs" container once the root is the workspace root.
    // Merge still keeps each document's own Bread placement; only "Use
    // GitHub" moves documents into their directory folders.
    const reparents = hostedFolderReparents({
      cache: directoryCache,
      folders: (folderRows ?? []).map((folder) => ({
        id: folder.id as string,
        parentFolderId: folder.parent_folder_id as string | null,
      })),
    })
    await mapWithConcurrency(
      reparents,
      DOCUMENT_SYNC_CONCURRENCY,
      async (move) => {
        const { error } = await admin
          .from('folders')
          .update({ parent_folder_id: move.parentFolderId })
          .eq('id', move.folderId)
          .eq('workspace_id', target.workspaceId)
        if (error) throw new Error(`hosted folder move: ${error.message}`)
        moved++
      },
    )
    // Stale cleanup remains authoritative for the complete repository tree,
    // including files whose reconciliation was resumed from a checkpoint.
    const activePaths = new Set(entries.map((entry) => entry.path))
    const syncDocument = async (doc: ParsedHostedDoc): Promise<void> => {
      if (shouldSkipGitHubHostedDoc({
        mode,
        force: target.force,
        currentBlobSha: doc.blobSha,
        currentCommitSha: commit.sha,
        lastSyncCommitSha: target.lastSyncCommitSha,
        checkpoints: checkpointsByPath.get(doc.path) ?? [],
      })) {
        return
      }

      // Preserve the established Bread taxonomy when a human-run canonical
      // import already owns this file (including mirror rows used by several
      // portal projects). Otherwise create a generic hosted-document row under
      // the source's mirrored folder tree. The companion and canonical lookup
      // are independent, so run them together to remove another round-trip
      // from the critical path.
      const [, canonicalResult] = await Promise.all([
        ensureRepositoryCompanion(admin, {
          workspaceId: target.workspaceId,
          repoId: target.repoId,
          repoFullName: target.repoFullName,
          ref,
          commitSha: commit.sha,
          doc,
        }),
        admin
          .from('documents')
          .select('id, title, content, status, source_metadata, deleted_at, updated_at, folder_id')
          .eq('workspace_id', target.workspaceId)
          .contains('source_metadata', { canonical_repo_path: doc.path }),
      ])
      const { data: canonicalRows, error: canonicalError } = canonicalResult
      if (canonicalError) throw new Error(`canonical doc lookup: ${canonicalError.message}`)

      let rows = (canonicalRows ?? []) as ExistingDocument[]
      // Bread-first bootstrap writes the original document UUID into each new
      // Markdown file. Use it only inside this workspace when no canonical path
      // link exists yet; this makes bootstrap reconciliation retry-safe without
      // ever matching on mutable titles or folder names.
      if (rows.length === 0 && doc.breadDocumentId) {
        const { data: bootstrapRow, error: bootstrapError } = await admin
          .from('documents')
          .select('id, title, content, status, source_metadata, deleted_at, updated_at, folder_id')
          .eq('id', doc.breadDocumentId)
          .eq('workspace_id', target.workspaceId)
          .is('deleted_at', null)
          .maybeSingle()
        if (bootstrapError) {
          throw new Error(`bootstrap doc lookup: ${bootstrapError.message}`)
        }
        if (bootstrapRow) rows = [bootstrapRow as ExistingDocument]
      }
      if (rows.length === 0) {
        const { data: hostedRows, error: hostedError } = await admin
          .from('documents')
          .select('id, title, content, status, source_metadata, deleted_at, updated_at, folder_id')
          .eq('workspace_id', target.workspaceId)
          .contains('source_metadata', {
            kind: 'github_hosted_document',
            repo_id: target.repoId,
            path: doc.path,
          })
        if (hostedError) throw new Error(`hosted doc lookup: ${hostedError.message}`)
        rows = (hostedRows ?? []) as ExistingDocument[]
      }

      if (rows.length > 0) {
        for (const row of rows) {
          const incomingHash = hostedContentHash(doc.content)
          const applyGitHubContent = shouldApplyGitHubHostedContent({
            mode,
            currentContent: row.content,
            incomingContent: doc.content,
            sourceMetadata: row.source_metadata,
          })
          if (!applyGitHubContent) {
            const { error } = await admin
              .from('documents')
              .update({
                source_metadata: {
                  ...(row.source_metadata ?? {}),
                  canonical_repo_path: doc.path,
                  ...(doc.breadDocumentId
                    ? { bread_document_id: doc.breadDocumentId }
                    : {}),
                  github_hosted_sync: true,
                  github_hosted_conflict: true,
                  github_hosted_pending_content_hash: incomingHash,
                  github_hosted_pending_commit_sha: commit.sha,
                  github_hosted_checkpoint_blob_sha: doc.blobSha,
                  github_hosted_checkpoint_mode: mode,
                  repo_id: target.repoId,
                  repo_full_name: target.repoFullName,
                  path: doc.path,
                },
              })
              .eq('id', row.id)
              .eq('workspace_id', target.workspaceId)
            if (error) throw new Error(`document conflict marker: ${error.message}`)
            preserved++
            continue
          }

          // GitHub owns placement in replace mode: the document moves to the
          // folder for its repository directory (or the workspace root).
          if (mode === 'replace_bread') {
            const targetFolderId = hostedDocumentFolderId({
              relativeDirectory: doc.relativeDirectory,
              cache: directoryCache,
            })
            if ((row.folder_id ?? null) !== targetFolderId) {
              const { error } = await admin
                .from('documents')
                .update({ folder_id: targetFolderId })
                .eq('id', row.id)
                .eq('workspace_id', target.workspaceId)
              if (error) throw new Error(`hosted document move: ${error.message}`)
              moved++
            }
          }

          await applyGitHubHostedDocumentUpdate(admin, {
            documentId: row.id,
            workspaceId: target.workspaceId,
            expectedTitle: row.title,
            expectedContent: row.content,
            title: doc.title,
            content: doc.content,
            sourceMetadataPatch: {
              canonical_repo_path: doc.path,
              ...(doc.breadDocumentId
                ? { bread_document_id: doc.breadDocumentId }
                : {}),
              github_hosted_sync: true,
              github_hosted_conflict: false,
              github_hosted_content_hash: incomingHash,
              github_hosted_pending_content_hash: null,
              github_hosted_pending_commit_sha: null,
              github_hosted_checkpoint_blob_sha: doc.blobSha,
              github_hosted_checkpoint_mode: mode,
              // The repository is the source of truth for an entry's date, so
              // a declared date is carried into the workspace here. Absent one,
              // any previously stored date is left alone rather than cleared.
              ...(doc.date ? { published_date: doc.date } : {}),
              repo_id: target.repoId,
              repo_full_name: target.repoFullName,
              path: doc.path,
              ref,
              commit_sha: commit.sha,
            },
            // The content genuinely changed, so `updated_at` records that and
            // nothing more. A dated feed's position comes from the publication
            // date stored in source_metadata above, which is why re-stamping
            // this no longer disturbs a changelog's order.
            updatedAt: new Date().toISOString(),
          })
          updated++
          if (shouldRefreshHostedDocumentIndex({
            priorStatus: row.status,
            currentContent: row.content,
            incomingContent: doc.content,
          })) {
            await refreshHostedDocumentIndex(
              row.id,
              target.workspaceId,
              doc.content,
            )
          }
        }
        return
      }

      const folderId = hostedDocumentFolderId({
        relativeDirectory: doc.relativeDirectory,
        cache: directoryCache,
      })
      const { data: inserted, error } = await admin
        .from('documents')
        .insert({
          workspace_id: target.workspaceId,
          title: doc.title,
          content: doc.content,
          document_type: 'page',
          public_slug: doc.publicSlug,
          folder_id: folderId,
          source: 'docs',
          status: 'Published',
          author: 'GitHub',
          source_metadata: {
            kind: 'github_hosted_document',
            canonical_repo_path: doc.path,
            ...(doc.breadDocumentId
              ? { bread_document_id: doc.breadDocumentId }
              : {}),
            // The repository owns an entry's date; dated feeds read this
            // rather than `updated_at`, which stays a plain last-modified.
            ...(doc.date ? { published_date: doc.date } : {}),
            github_hosted_sync: true,
            repo_id: target.repoId,
            repo_full_name: target.repoFullName,
            path: doc.path,
            ref,
            commit_sha: commit.sha,
            github_hosted_content_hash: hostedContentHash(doc.content),
            github_hosted_conflict: false,
            github_hosted_checkpoint_blob_sha: doc.blobSha,
            github_hosted_checkpoint_mode: mode,
          },
        })
        .select('id')
        .single()
      if (error || !inserted) throw new Error(`document insert: ${error?.message ?? 'no row returned'}`)
      const documentId = (inserted as { id: string }).id
      created++
      await refreshHostedDocumentIndex(
        documentId,
        target.workspaceId,
        doc.content,
      )
    }
    for (
      let batchStart = 0;
      batchStart < parsedDocs.length;
      batchStart += DOCUMENT_SYNC_CONCURRENCY
    ) {
      await mapWithConcurrency(
        parsedDocs.slice(batchStart, batchStart + DOCUMENT_SYNC_CONCURRENCY),
        DOCUMENT_SYNC_CONCURRENCY,
        syncDocument,
      )
      // Refresh updated_at after each bounded batch. Besides exposing real
      // liveness to status polls, this lets an interrupted serverless task be
      // distinguished from a slow but active reconciliation.
      await persistStatus(admin, target.sourceId, { sync_status: 'syncing' })
    }

    const { data: priorHosted, error: priorError } = await admin
      .from('documents')
      .select('id, title, content, status, source_metadata, deleted_at, updated_at')
      .eq('workspace_id', target.workspaceId)
      .contains('source_metadata', {
        kind: 'github_hosted_document',
        repo_id: target.repoId,
      })
      .is('deleted_at', null)
    if (priorError) throw new Error(`stale hosted doc lookup: ${priorError.message}`)
    const staleIds: string[] = []
    for (const rawRow of priorHosted ?? []) {
      const row = rawRow as ExistingDocument
      const metadata = row.source_metadata
      const path = typeof metadata?.path === 'string' ? metadata.path : null
      if (!path || activePaths.has(path)) continue
      const safelyRemovable = shouldDeleteStaleHostedDocument({
        mode,
        currentContent: row.content,
        sourceMetadata: metadata,
      })
      if (safelyRemovable) {
        staleIds.push(row.id)
        continue
      }
      const { error } = await admin
        .from('documents')
        .update({
          source_metadata: {
            ...(metadata ?? {}),
            kind: 'github_hosted_detached_document',
            github_hosted_sync: false,
            github_hosted_conflict: true,
            github_hosted_checkpoint_blob_sha: null,
            github_hosted_checkpoint_mode: null,
            github_hosted_detached_reason: 'source_removed',
            github_hosted_detached_at: new Date().toISOString(),
          },
        })
        .eq('id', row.id)
        .eq('workspace_id', target.workspaceId)
      if (error) throw new Error(`stale hosted doc preservation: ${error.message}`)
      preserved++
    }
    if (staleIds.length > 0) {
      const now = new Date().toISOString()
      const { error } = await admin
        .from('documents')
        .update({ deleted_at: now, updated_at: now })
        .eq('workspace_id', target.workspaceId)
        .in('id', staleIds)
      if (error) throw new Error(`stale hosted doc cleanup: ${error.message}`)
    }

    const { count: conflictCount, error: conflictCountError } = await admin
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', target.workspaceId)
      .contains('source_metadata', {
        repo_id: target.repoId,
        github_hosted_conflict: true,
      })
      .is('deleted_at', null)
    if (conflictCountError) {
      throw new Error(`hosted conflict count: ${conflictCountError.message}`)
    }

    const openApi = await syncHostedOpenApiSpecs(admin, {
      workspaceId: target.workspaceId,
      repoId: target.repoId,
      repoFullName: target.repoFullName,
      ref,
      commitSha: commit.sha,
      roots: paths,
      specs: openApiSpecs,
      directoryCache,
    })
    created += openApi.created
    updated += openApi.updated

    const documentCount = entries.length + openApi.documentCount
    const totalPreserved = conflictCount ?? preserved
    await persistStatus(admin, target.sourceId, {
      root_folder_id: null,
      sync_status: 'synced',
      document_count: documentCount,
      conflict_count: totalPreserved,
      last_sync_commit_sha: commit.sha,
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
      pending_pull_request_number: null,
      pending_pull_request_url: null,
      pending_pull_request_head: null,
      pending_sync_mode: 'merge',
    })
    return {
      repoFullName: target.repoFullName,
      ref,
      commitSha: commit.sha,
      documentCount,
      created,
      updated,
      removed: staleIds.length + openApi.removed,
      preserved: totalPreserved,
      moved,
      rootFolderId: null,
    }
  } catch (err) {
    await persistStatus(admin, target.sourceId, {
      sync_status: 'error',
      last_sync_at: new Date().toISOString(),
      last_sync_error: safeHostedDocsError(err),
    })
    throw err
  }
}
