import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbeddings, isEmbeddingQuotaError } from '@/lib/embeddings'
import { ingestDocument, textToProseMirrorDoc } from '@/rag/ingest'
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
import { syncGitHubHostedDocs } from './github-hosted-docs'

const MAX_FILE_BYTES = 96 * 1024
const MAX_REPOSITORY_FILES = 2_000
const MAX_REPOSITORY_BYTES = 25 * 1024 * 1024
const MAX_FILES_PER_SYNC = 40
const MAX_BYTES_PER_SYNC = 4 * 1024 * 1024
const FILE_CONCURRENCY = 4

const TEXT_EXTENSIONS = new Set([
  '.astro', '.bash', '.c', '.cc', '.cfg', '.conf', '.cpp', '.cs', '.css',
  '.csv', '.cxx', '.dockerfile', '.fish', '.go', '.graphql', '.gql', '.h',
  '.hcl', '.hh', '.hpp', '.htm', '.html', '.ini', '.java', '.js', '.json',
  '.jsonc', '.jsx', '.kt', '.kts', '.less', '.lua', '.md', '.mdx', '.mjs',
  '.mts', '.php', '.pl', '.proto', '.ps1', '.py', '.rb', '.rs', '.rst',
  '.sass', '.scala', '.scss', '.sh', '.sql', '.svelte', '.swift', '.tf',
  '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.zsh',
])

const TEXT_FILENAMES = new Set([
  'agents.md', 'brewfile', 'changelog', 'changelog.md', 'codeowners',
  'contributing', 'contributing.md', 'dockerfile', 'gemfile', 'justfile',
  'license', 'license.md', 'makefile', 'procfile', 'readme', 'readme.md',
  'requirements.txt', 'security.md', 'turbo.json', 'vercel.json',
])

const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.output', '.pytest_cache', '.terraform', '.turbo',
  '.venv', 'bower_components', 'build', 'coverage', 'dist', 'generated',
  'node_modules', 'out', 'target', 'vendor',
])

const IGNORED_FILENAMES = new Set([
  '.env', '.netrc', '.npmrc', '.pypirc', 'bun.lock', 'bun.lockb',
  'composer.lock', 'credentials.json', 'package-lock.json', 'pnpm-lock.yaml',
  'poetry.lock', 'secrets.json', 'secrets.toml', 'secrets.yaml', 'secrets.yml',
  'terraform.tfstate', 'yarn.lock',
])

const SENSITIVE_EXTENSIONS = new Set([
  '.der', '.jks', '.key', '.keystore', '.p12', '.pem', '.pfx', '.tfstate',
])

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.css': 'css',
  '.go': 'go', '.graphql': 'graphql', '.gql': 'graphql', '.h': 'c',
  '.hpp': 'cpp', '.html': 'html', '.java': 'java', '.js': 'javascript',
  '.json': 'json', '.jsx': 'jsx', '.kt': 'kotlin', '.md': 'markdown',
  '.mdx': 'mdx', '.php': 'php', '.py': 'python', '.rb': 'ruby', '.rs': 'rust',
  '.scss': 'scss', '.sh': 'bash', '.sql': 'sql', '.svelte': 'svelte',
  '.swift': 'swift', '.tf': 'hcl', '.toml': 'toml', '.ts': 'typescript',
  '.tsx': 'tsx', '.vue': 'vue', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
}

export interface RepositorySyncTarget {
  workspaceId: string
  installationId: number
  repoId: number
  repoFullName: string
  /** Branch, tag, or commit to index. Defaults to the repository's default branch. */
  ref?: string
}

export interface RepositoryPushInfo {
  installationId: number
  repoId: number
  repoFullName: string
  ref: string
}

export interface RepositorySyncResult {
  repoFullName: string
  ref: string
  commitSha: string
  /** Active repository-file documents that are currently searchable. */
  indexed: number
  created: number
  updated: number
  unchanged: number
  removed: number
  skipped: number
  failed: number
  /** Files deferred because the embedding provider asked us to slow down. */
  deferred: number
  pending: number
  treeTruncated: boolean
  /** True when an admin stopped this pass before it completed. */
  cancelled: boolean
}

export function repositoryFileSyncStatus(
  result: Pick<RepositorySyncResult, 'pending' | 'deferred' | 'treeTruncated'>,
): 'partial' | 'synced' {
  return result.pending > 0 || result.deferred > 0 || result.treeTruncated
    ? 'partial'
    : 'synced'
}

interface SyncedFileRow {
  path: string
  blob_sha: string | null
  document_id: string | null
  removed_at: string | null
}

interface RepositoryIngestDeps {
  admin?: SupabaseClient
  getToken?: typeof getInstallationToken
  getRepo?: typeof getRepository
  getCommit?: typeof getRepositoryCommit
  getTree?: typeof getRepositoryTree
  getBlob?: typeof getRepositoryBlob
  embedMany?: typeof generateEmbeddings
  indexDocument?: typeof ingestDocument
  isIndexingEnabled?: (target: RepositorySyncTarget) => Promise<boolean>
}

interface RepositoryPushDeps {
  admin?: SupabaseClient
  syncRepository?: typeof syncGitHubRepository
  syncHostedDocs?: typeof syncGitHubHostedDocs
}

interface FileSelection {
  selected: GitHubTreeEntry[]
  selectedPaths: Set<string>
  skipped: number
}

function extensionOf(filePath: string): string {
  const basename = filePath.split('/').at(-1)?.toLowerCase() ?? ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot) : ''
}

/**
 * Conservative repository-file allowlist. Besides excluding dependencies and
 * build output, it deliberately refuses common credential and private-key
 * filenames so connecting a repository cannot turn Bread into a secret index.
 */
export function shouldIndexRepositoryFile(entry: GitHubTreeEntry): boolean {
  if (entry.type !== 'blob') return false
  if (entry.mode !== '100644' && entry.mode !== '100755') return false
  if (!entry.size || entry.size > MAX_FILE_BYTES) return false

  const parts = entry.path.split('/')
  const loweredParts = parts.map((part) => part.toLowerCase())
  if (loweredParts.slice(0, -1).some((part) => IGNORED_DIRECTORIES.has(part))) {
    return false
  }

  const basename = loweredParts.at(-1) ?? ''
  const ext = extensionOf(entry.path)
  if (IGNORED_FILENAMES.has(basename)) return false
  if (basename.startsWith('.env.')) return false
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/.test(basename)) return false
  if (/^(credentials|secrets)\.(json|ya?ml|toml|ini)$/.test(basename)) return false
  if (SENSITIVE_EXTENSIONS.has(ext)) return false
  if (/\.(min\.(js|css)|map)$/.test(basename)) return false

  return TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(basename)
}

function filePriority(entry: GitHubTreeEntry): number {
  const lower = entry.path.toLowerCase()
  const basename = lower.split('/').at(-1) ?? lower
  if (basename.startsWith('readme') || basename === 'agents.md') return 0
  if (lower.startsWith('docs/') || lower.includes('/docs/')) return 1
  if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|gemfile)$/.test(basename)) return 2
  if (/\.(md|mdx|rst)$/.test(lower)) return 3
  if (/(^|\/)(src|app|lib|packages)\//.test(lower)) return 4
  if (/\.(test|spec)\.[^.]+$/.test(lower) || /(^|\/)tests?\//.test(lower)) return 6
  return 5
}

export function selectRepositoryFiles(entries: GitHubTreeEntry[]): FileSelection {
  const blobCount = entries.filter((entry) => entry.type === 'blob').length
  const eligible = entries
    .filter(shouldIndexRepositoryFile)
    .sort((a, b) => filePriority(a) - filePriority(b) || a.path.localeCompare(b.path))
  const selected: GitHubTreeEntry[] = []
  let bytes = 0

  for (const entry of eligible) {
    const size = entry.size ?? 0
    if (selected.length >= MAX_REPOSITORY_FILES) break
    if (bytes + size > MAX_REPOSITORY_BYTES) continue
    selected.push(entry)
    bytes += size
  }

  return {
    selected,
    selectedPaths: new Set(selected.map((entry) => entry.path)),
    skipped: blobCount - selected.length,
  }
}

export function decodeRepositoryBlob(blob: GitHubBlob): string | null {
  if (blob.encoding !== 'base64') return null
  const decoded = Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8')
  if (!decoded.trim() || decoded.includes('\u0000')) return null

  const replacementCharacters = decoded.match(/\uFFFD/g)?.length ?? 0
  if (replacementCharacters > Math.max(2, decoded.length * 0.01)) return null
  return decoded.replace(/\r\n?/g, '\n')
}

function markdownFence(content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

export function compileRepositoryFileContent(args: {
  repoFullName: string
  path: string
  ref: string
  commitSha: string
  blobSha: string
  content: string
}): string {
  const ext = extensionOf(args.path)
  const sourceUrl = repositoryFileUrl(args.repoFullName, args.commitSha, args.path)
  const header = [
    `# ${args.repoFullName}/${args.path}`,
    '',
    `Repository: [${args.repoFullName}](https://github.com/${args.repoFullName})`,
    `File: [\`${args.path}\`](${sourceUrl})`,
    `Ref: \`${args.ref}\``,
    `Revision: \`${args.commitSha}\``,
    `Blob: \`${args.blobSha}\``,
    '',
    '## File content',
    '',
  ]

  if (ext === '.md' || ext === '.mdx' || ext === '.rst') {
    return `${header.join('\n')}${args.content}`
  }

  const fence = markdownFence(args.content)
  const language = LANGUAGE_BY_EXTENSION[ext] ?? ''
  return `${header.join('\n')}${fence}${language}\n${args.content}\n${fence}`
}

function repositoryFileUrl(repoFullName: string, commitSha: string, filePath: string): string {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${repoFullName}/blob/${commitSha}/${encodedPath}`
}

/** Normalize a default-branch push event into a repository sync target. */
export function extractRepositoryPushInfo(
  eventType: string,
  payload: Record<string, unknown>,
): RepositoryPushInfo | null {
  if (eventType !== 'push') return null
  const typed = payload as {
    ref?: string
    after?: string
    deleted?: boolean
    repository?: { id?: number; full_name?: string; default_branch?: string }
    installation?: { id?: number }
  }
  const repo = typed.repository
  const installationId = typed.installation?.id
  const expectedRef = repo?.default_branch ? `refs/heads/${repo.default_branch}` : null
  if (
    typed.deleted || !repo?.id || !repo.full_name || !installationId ||
    !typed.ref || typed.ref !== expectedRef || !typed.after || /^0+$/.test(typed.after)
  ) {
    return null
  }

  return {
    installationId,
    repoId: repo.id,
    repoFullName: repo.full_name,
    ref: typed.after,
  }
}

/** Route a verified default-branch push to the workspace monitoring the repo. */
export async function handleRepositoryPush(
  info: RepositoryPushInfo,
  deps: RepositoryPushDeps = {},
): Promise<void> {
  const admin = deps.admin ?? createAdminClient()
  const [monitoredResult, hostedResult] = await Promise.all([
    admin
      .from('monitored_repos')
      .select('workspace_id, installation_id, repo_id, repo_full_name, file_indexing_enabled')
      .eq('repo_id', info.repoId)
      .eq('installation_id', info.installationId)
      .maybeSingle(),
    admin
      .from('github_hosted_docs_sources')
      .select('*')
      .eq('repo_id', info.repoId)
      .eq('installation_id', info.installationId)
      .maybeSingle(),
  ])
  if (monitoredResult.error) {
    throw new Error(
      `[handleRepositoryPush] monitored repo lookup: ${monitoredResult.error.message}`,
    )
  }
  if (hostedResult.error) {
    throw new Error(
      `[handleRepositoryPush] hosted docs lookup: ${hostedResult.error.message}`,
    )
  }

  // Start the narrow hosted-doc refresh first and keep it independent from
  // full-repository indexing. Repository indexing can be slow (or fail before
  // processing any files), but neither case should prevent linked docs from
  // advancing to the verified push commit.
  const hostedTask = hostedResult.data
    ? Promise.resolve().then(() => {
      const source = hostedResult.data as {
        id: string
        workspace_id: string
        installation_id: number
        repo_id: number
        repo_full_name: string
        paths: string[]
        root_folder_id: string | null
        document_count: number
        last_sync_commit_sha: string | null
        pending_sync_mode: 'merge' | 'replace_bread'
      }
      return (deps.syncHostedDocs ?? syncGitHubHostedDocs)({
        sourceId: source.id,
        workspaceId: source.workspace_id,
        installationId: source.installation_id,
        repoId: source.repo_id,
        repoFullName: source.repo_full_name,
        paths: source.paths,
        ref: info.ref,
        rootFolderId: source.root_folder_id,
        documentCount: source.document_count,
        lastSyncCommitSha: source.last_sync_commit_sha,
        mode: source.pending_sync_mode,
      })
    })
    : Promise.resolve()

  const repositoryTask = monitoredResult.data
    ? Promise.resolve().then(() => {
      const row = monitoredResult.data as {
        workspace_id: string
        installation_id: number
        repo_id: number
        repo_full_name: string
        file_indexing_enabled: boolean
      }
      if (row.file_indexing_enabled === false) return
      return (deps.syncRepository ?? syncGitHubRepository)({
        workspaceId: row.workspace_id,
        installationId: row.installation_id,
        repoId: row.repo_id,
        repoFullName: row.repo_full_name,
        ref: info.ref,
      })
    })
    : Promise.resolve()

  // Wait for both so a rejected repository task cannot cut short the hosted
  // refresh in a serverless after() callback. Preserve the historical error
  // precedence: repository failures surface before hosted-doc failures.
  const [repositoryOutcome, hostedOutcome] = await Promise.allSettled([
    repositoryTask,
    hostedTask,
  ])
  if (repositoryOutcome.status === 'rejected') throw repositoryOutcome.reason
  if (hostedOutcome.status === 'rejected') throw hostedOutcome.reason
}

/**
 * Index a bounded batch of changed files from a repository. Repeated cron or
 * push runs converge large repositories without holding one serverless request
 * open for thousands of GitHub and embedding calls.
 */
export async function syncGitHubRepository(
  target: RepositorySyncTarget,
  deps: RepositoryIngestDeps = {},
): Promise<RepositorySyncResult> {
  const admin = deps.admin ?? createAdminClient()
  const isIndexingEnabled = deps.isIndexingEnabled ?? ((currentTarget) =>
    loadRepositoryIndexingEnabled(admin, currentTarget))
  if (!(await isIndexingEnabled(target))) {
    return cancelledRepositorySyncResult(target)
  }
  await persistRepositorySyncState(admin, target, {
    file_sync_status: 'syncing',
    failed_file_count: 0,
    last_file_sync_error: null,
  }, { indexingEnabled: true })

  try {
    const result = await performGitHubRepositorySync(target, {
      ...deps,
      admin,
      isIndexingEnabled,
    })
    // A per-file failure remains pending and is retried by the next bounded
    // pass. Reserve the repository-level error state for failures that prevent
    // a pass from running at all (permissions, GitHub access, DB failures).
    const cancelled = result.cancelled || !(await isIndexingEnabled(target))
    const fileSyncStatus = cancelled
      ? 'cancelled'
      : repositoryFileSyncStatus(result)
    await persistRepositorySyncState(admin, target, {
      file_sync_status: fileSyncStatus,
      indexed_file_count: result.indexed,
      pending_file_count: result.pending,
      skipped_file_count: result.skipped,
      failed_file_count: result.failed,
      last_file_sync_commit_sha: result.commitSha,
      last_file_sync_at: new Date().toISOString(),
      last_file_sync_error:
        result.failed > 0
          ? `${result.failed} file${result.failed === 1 ? '' : 's'} could not be indexed in this pass and will be retried automatically.`
          : null,
      file_tree_truncated: result.treeTruncated,
    }, { indexingEnabled: !cancelled })
    return { ...result, cancelled }
  } catch (err) {
    if (!(await isIndexingEnabled(target))) {
      await persistRepositorySyncState(admin, target, {
        file_sync_status: 'cancelled',
        last_file_sync_at: new Date().toISOString(),
        last_file_sync_error: null,
      }, { indexingEnabled: false })
      return cancelledRepositorySyncResult(target)
    }
    await persistRepositorySyncState(admin, target, {
      file_sync_status: 'error',
      failed_file_count: 1,
      last_file_sync_at: new Date().toISOString(),
      last_file_sync_error: safeRepositorySyncError(err),
    }, { indexingEnabled: true })
    throw err
  }
}

async function performGitHubRepositorySync(
  target: RepositorySyncTarget,
  deps: RepositoryIngestDeps = {},
): Promise<RepositorySyncResult> {
  const admin = deps.admin ?? createAdminClient()
  const getToken = deps.getToken ?? getInstallationToken
  const getRepo = deps.getRepo ?? getRepository
  const getCommit = deps.getCommit ?? getRepositoryCommit
  const getTree = deps.getTree ?? getRepositoryTree
  const getBlob = deps.getBlob ?? getRepositoryBlob
  const embedMany = deps.embedMany ?? generateEmbeddings
  const indexDocument = deps.indexDocument ?? ingestDocument
  const isIndexingEnabled = deps.isIndexingEnabled ?? ((currentTarget) =>
    loadRepositoryIndexingEnabled(admin, currentTarget))

  const token = await withGitHubRetry(() => getToken(target.installationId))
  const ref = target.ref ?? (await withGitHubRetry(() => getRepo(token, target.repoFullName))).default_branch
  const commit = await withGitHubRetry(() => getCommit(token, target.repoFullName, ref))
  const tree = await withGitHubRetry(() =>
    getTree(token, target.repoFullName, commit.commit.tree.sha),
  )
  const selection = selectRepositoryFiles(tree.tree)

  const { data: existingRaw, error: existingError } = await admin
    .from('github_repo_files')
    .select('path, blob_sha, document_id, removed_at')
    .eq('workspace_id', target.workspaceId)
    .eq('repo_id', target.repoId)
  if (existingError) {
    throw new Error(`[syncGitHubRepository] load file state: ${existingError.message}`)
  }

  const existingRows = (existingRaw ?? []) as SyncedFileRow[]
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]))
  const changed = selection.selected.filter((entry) => {
    const row = existingByPath.get(entry.path)
    return !row || row.blob_sha !== entry.sha || row.removed_at !== null
  })
  const unchanged = selection.selected.length - changed.length
  const batch: GitHubTreeEntry[] = []
  let batchBytes = 0
  for (const entry of changed) {
    const size = entry.size ?? 0
    if (batch.length >= MAX_FILES_PER_SYNC) break
    if (batch.length > 0 && batchBytes + size > MAX_BYTES_PER_SYNC) break
    batch.push(entry)
    batchBytes += size
  }

  let created = 0
  let updated = 0
  let failed = 0
  let deferred = 0
  let embeddingQuotaReached = false
  let cancelled = false

  await mapWithConcurrency(batch, FILE_CONCURRENCY, async (entry) => {
    // Once one worker reaches provider quota, do not make the remaining workers
    // hammer every configured key. These files remain pending and the next
    // push/manual/scheduled sweep resumes them automatically.
    if (embeddingQuotaReached) {
      deferred++
      return
    }

    if (cancelled || !(await isIndexingEnabled(target))) {
      cancelled = true
      return
    }

    try {
      const blob = await withGitHubRetry(() =>
        getBlob(token, target.repoFullName, entry.sha),
      )
      const rawContent = decodeRepositoryBlob(blob)
      const prior = existingByPath.get(entry.path)

      if (!rawContent) {
        // An allowlisted extension can still contain binary data. If this path
        // used to be text, hide the stale document rather than leaving old
        // source searchable under the new blob SHA.
        if (prior?.document_id) {
          const now = new Date().toISOString()
          const { error } = await admin
            .from('documents')
            .update({ deleted_at: now, updated_at: now })
            .eq('id', prior.document_id)
            .eq('workspace_id', target.workspaceId)
          if (error) throw new Error(`binary replacement cleanup: ${error.message}`)
        }
        await upsertFileState(admin, target, entry, commit.sha, null)
        return
      }

      const content = compileRepositoryFileContent({
        repoFullName: target.repoFullName,
        path: entry.path,
        ref,
        commitSha: commit.sha,
        blobSha: entry.sha,
        content: rawContent,
      })
      const sourceMetadata = {
        kind: 'repository_file',
        repo_id: target.repoId,
        repo_full_name: target.repoFullName,
        path: entry.path,
        ref,
        commit_sha: commit.sha,
        blob_sha: entry.sha,
        url: repositoryFileUrl(target.repoFullName, commit.sha, entry.path),
      }
      let documentId = prior?.document_id ?? null
      let didCreate = false
      if (documentId) {
        const { data: updatedDoc, error } = await admin
          .from('documents')
          .update({
            title: `${target.repoFullName}/${entry.path}`,
            content,
            source: 'GitHub',
            author: 'GitHub',
            source_metadata: sourceMetadata,
            deleted_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', documentId)
          .eq('workspace_id', target.workspaceId)
          .select('id')
          .maybeSingle()
        if (error) throw new Error(`document update: ${error.message}`)
        if (!updatedDoc) documentId = null
      }

      if (!documentId) {
        const { data: insertedDoc, error } = await admin
          .from('documents')
          .insert({
            workspace_id: target.workspaceId,
            title: `${target.repoFullName}/${entry.path}`,
            content,
            source: 'GitHub',
            status: 'Draft',
            author: 'GitHub',
            source_metadata: sourceMetadata,
          })
          .select('id')
          .single()
        if (error?.code === '23505') {
          // Another push/sweep won the unique live-file insert race. Point at
          // its document but leave blob_sha null so a later sync performs one
          // clean, non-concurrent index pass.
          const { data: concurrentDoc, error: lookupError } = await admin
            .from('documents')
            .select('id')
            .eq('workspace_id', target.workspaceId)
            .eq('source', 'GitHub')
            .contains('source_metadata', {
              kind: 'repository_file',
              repo_id: target.repoId,
              path: entry.path,
            })
            .is('deleted_at', null)
            .maybeSingle()
          if (lookupError || !concurrentDoc) {
            throw new Error(
              `concurrent document lookup: ${lookupError?.message ?? 'no row returned'}`,
            )
          }
          documentId = (concurrentDoc as { id: string }).id
          const { error: pointerError } = await admin.from('github_repo_files').upsert({
            workspace_id: target.workspaceId,
            repo_id: target.repoId,
            repo_full_name: target.repoFullName,
            path: entry.path,
            blob_sha: null,
            document_id: documentId,
            last_seen_commit_sha: commit.sha,
            removed_at: null,
            last_synced_at: new Date().toISOString(),
          }, { onConflict: 'workspace_id,repo_id,path' })
          if (pointerError) throw new Error(`file pointer insert: ${pointerError.message}`)
          return
        }
        if (error || !insertedDoc) {
          throw new Error(`document insert: ${error?.message ?? 'no row returned'}`)
        }
        documentId = (insertedDoc as { id: string }).id
        didCreate = true

        // Persist the document pointer before the slower chunk-index call. If
        // indexing fails, blob_sha remains null and the next sync retries the
        // same document instead of creating a duplicate.
        const { error: pointerError } = await admin.from('github_repo_files').upsert({
          workspace_id: target.workspaceId,
          repo_id: target.repoId,
          repo_full_name: target.repoFullName,
          path: entry.path,
          blob_sha: null,
          document_id: documentId,
          last_seen_commit_sha: commit.sha,
          removed_at: null,
          last_synced_at: new Date().toISOString(),
        }, { onConflict: 'workspace_id,repo_id,path' })
        if (pointerError) throw new Error(`file pointer insert: ${pointerError.message}`)
      }

      // Chunk ingestion already embeds the full document in retrieval-sized
      // pieces. Reuse those vectors for documents.embedding instead of making
      // a second whole-document Gemini request for every repository file.
      // This halves request pressure for common one-chunk files and keeps the
      // document-level and chunk-level indexes in the same vector space.
      let documentEmbedding: number[] | null = null
      await indexDocument(documentId, textToProseMirrorDoc(content), {
        supabase: admin,
        embedder: async (texts) => {
          const embeddings = await embedMany(texts, 'RETRIEVAL_DOCUMENT')
          documentEmbedding = meanEmbedding(embeddings)
          return embeddings
        },
      })
      if (documentEmbedding) {
        const { error } = await admin
          .from('documents')
          .update({ embedding: documentEmbedding })
          .eq('id', documentId)
          .eq('workspace_id', target.workspaceId)
        if (error) throw new Error(`document embedding update: ${error.message}`)
      }
      await upsertFileState(admin, target, entry, commit.sha, documentId)
      if (didCreate) created++
      else updated++
    } catch (err) {
      if (isEmbeddingQuotaError(err)) {
        embeddingQuotaReached = true
        deferred++
        console.warn(
          '[Bread] GitHub repository indexing paused at embedding quota; remaining files stay pending.',
        )
        return
      }
      failed++
      console.error('[Bread] GitHub repo file ingest failed:', entry.path, err)
    }
  })

  if (!cancelled && !(await isIndexingEnabled(target))) {
    cancelled = true
  }

  let removed = 0
  if (!tree.truncated && !cancelled) {
    const removedRows = existingRows.filter(
      (row) => !selection.selectedPaths.has(row.path) && row.removed_at === null,
    )
    if (removedRows.length > 0) {
      const removedAt = new Date().toISOString()
      const documentIds = removedRows.flatMap((row) => row.document_id ? [row.document_id] : [])
      if (documentIds.length > 0) {
        const { error } = await admin
          .from('documents')
          .update({ deleted_at: removedAt, updated_at: removedAt })
          .eq('workspace_id', target.workspaceId)
          .in('id', documentIds)
        if (error) throw new Error(`[syncGitHubRepository] remove documents: ${error.message}`)
      }
      const { error } = await admin
        .from('github_repo_files')
        .update({ removed_at: removedAt, last_synced_at: removedAt })
        .eq('workspace_id', target.workspaceId)
        .eq('repo_id', target.repoId)
        .in('path', removedRows.map((row) => row.path))
      if (error) throw new Error(`[syncGitHubRepository] remove file state: ${error.message}`)
      removed = removedRows.length
    }
  }

  const telemetry = await loadRepositoryFileTelemetry(
    admin,
    target,
    selection.selected,
    selection.skipped,
  )

  return {
    repoFullName: target.repoFullName,
    ref,
    commitSha: commit.sha,
    indexed: telemetry.indexed,
    created,
    updated,
    unchanged,
    removed,
    skipped: telemetry.skipped,
    failed,
    deferred,
    pending: telemetry.pending,
    treeTruncated: tree.truncated,
    cancelled,
  }
}

/**
 * Produce a stable document-level vector from its retrieval chunks without an
 * additional provider request. Cosine-distance search does not require unit
 * length, so a component-wise mean is sufficient here.
 */
export function meanEmbedding(
  maybeEmbeddings: ReadonlyArray<number[] | null>,
): number[] | null {
  // Embeddings are disabled in the Breeze internal build (all null).
  if (maybeEmbeddings.some((embedding) => embedding === null)) return null
  const embeddings = maybeEmbeddings as number[][]
  const dimensions = embeddings[0]?.length ?? 0
  if (dimensions === 0) return null
  if (embeddings.some((embedding) => embedding.length !== dimensions)) {
    throw new Error('Cannot average embeddings with different dimensions.')
  }

  const mean = new Array<number>(dimensions).fill(0)
  for (const embedding of embeddings) {
    for (let i = 0; i < dimensions; i++) mean[i] += embedding[i]!
  }
  for (let i = 0; i < dimensions; i++) mean[i] /= embeddings.length
  return mean
}

async function loadRepositoryFileTelemetry(
  admin: SupabaseClient,
  target: RepositorySyncTarget,
  selected: GitHubTreeEntry[],
  excludedByRulesOrLimits: number,
): Promise<{ indexed: number; pending: number; skipped: number }> {
  const { data, error } = await admin
    .from('github_repo_files')
    .select('path, blob_sha, document_id, removed_at')
    .eq('workspace_id', target.workspaceId)
    .eq('repo_id', target.repoId)
  if (error) {
    throw new Error(`[syncGitHubRepository] load telemetry: ${error.message}`)
  }

  const rows = (data ?? []) as SyncedFileRow[]
  const activeRows = rows.filter((row) => row.removed_at === null)
  const byPath = new Map(activeRows.map((row) => [row.path, row]))
  const indexed = activeRows.filter(
    (row) => row.document_id !== null && row.blob_sha !== null,
  ).length
  const pending = selected.filter((entry) => {
    const row = byPath.get(entry.path)
    return !row || row.blob_sha !== entry.sha
  }).length
  const skippedAfterFetch = activeRows.filter(
    (row) => row.document_id === null && row.blob_sha !== null,
  ).length

  return {
    indexed,
    pending,
    skipped: excludedByRulesOrLimits + skippedAfterFetch,
  }
}

async function persistRepositorySyncState(
  admin: SupabaseClient,
  target: RepositorySyncTarget,
  patch: Record<string, unknown>,
  options: { indexingEnabled?: boolean } = {},
): Promise<void> {
  let query = admin
    .from('monitored_repos')
    .update(patch)
    .eq('workspace_id', target.workspaceId)
    .eq('repo_id', target.repoId)
  if (options.indexingEnabled !== undefined) {
    query = query.eq('file_indexing_enabled', options.indexingEnabled)
  }
  const { error } = await query
  if (error) {
    // Telemetry must never stop content ingestion. The migration and settings
    // UI are deployed together, but a best-effort write keeps rollout order
    // from dropping repository documents.
    console.error('[Bread] GitHub repository sync state update failed:', error.message)
  }
}

async function loadRepositoryIndexingEnabled(
  admin: SupabaseClient,
  target: RepositorySyncTarget,
): Promise<boolean> {
  const { data, error } = await admin
    .from('monitored_repos')
    .select('file_indexing_enabled')
    .eq('workspace_id', target.workspaceId)
    .eq('repo_id', target.repoId)
    .maybeSingle()
  if (error) {
    console.error(
      '[Bread] GitHub repository cancellation state lookup failed:',
      error.message,
    )
    return true
  }
  return data?.file_indexing_enabled !== false && data !== null
}

function cancelledRepositorySyncResult(
  target: RepositorySyncTarget,
): RepositorySyncResult {
  return {
    repoFullName: target.repoFullName,
    ref: target.ref ?? '',
    commitSha: '',
    indexed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    pending: 0,
    treeTruncated: false,
    cancelled: true,
  }
}

function safeRepositorySyncError(err: unknown): string {
  const status = (err as { status?: number }).status
  if (status === 403) {
    return 'GitHub denied repository contents. Approve the read-only Contents permission, then retry.'
  }
  if (status === 404) {
    return 'The repository or default branch is no longer accessible to the GitHub App.'
  }
  if (status === 409) {
    return 'GitHub could not read the repository tree yet. Retry the sync shortly.'
  }
  return 'Repository indexing failed. Retry from GitHub settings.'
}

async function upsertFileState(
  admin: SupabaseClient,
  target: RepositorySyncTarget,
  entry: GitHubTreeEntry,
  commitSha: string,
  documentId: string | null,
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await admin.from('github_repo_files').upsert({
    workspace_id: target.workspaceId,
    repo_id: target.repoId,
    repo_full_name: target.repoFullName,
    path: entry.path,
    blob_sha: entry.sha,
    document_id: documentId,
    last_seen_commit_sha: commitSha,
    removed_at: null,
    last_synced_at: now,
  }, { onConflict: 'workspace_id,repo_id,path' })
  if (error) throw new Error(`file state upsert: ${error.message}`)
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )
}
