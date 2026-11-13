import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import {
  createRepositoryBranch,
  createRepositoryFilesCommit,
  createRepositoryPullRequest,
  findOpenRepositoryPullRequest,
  getInstallationToken,
  getRepository,
  getRepositoryBlob,
  getRepositoryBranchReference,
  getRepositoryCommit,
  getRepositoryTree,
  type GitHubRepositoryCommit,
} from '../github'
import { GitHubApiError, withGitHubRetry } from '../retry'
import {
  planReadmeExport,
  ReadmeExportSelectionError,
  selectReadmeExportPlan,
  type ReadmeExportDocument,
  type ReadmeExportFolder,
  type ReadmeExportPlan,
  type ReadmeExportSpec,
} from './readme-export'
import {
  readmeFolderMetadata,
  readmeSectionOf,
  readReadmeDocumentLink,
  readReadmeFolderLink,
  readReadmeSyncState,
  relativeReadmePath,
  type ReadmeSyncState,
} from './readme-layout'
import { parseSpecDocument } from './readme-sync'
import type { ReadmeStore, ReadmeStoreDocument } from './readme-store'

/**
 * Workspace -> repository, for the ReadMe format.
 *
 * `direct` commits straight to the synced branch, which is how ReadMe's own
 * GitHub integration behaves. `pull_request` collects the same changes on a
 * Bread-owned branch for repositories whose branch is protected.
 */

export type ReadmePublishMode = 'direct' | 'pull_request'

export interface ReadmePublishSource {
  installationId: number
  repoId: number
  repoFullName: string
  root: string
  branch: string | null
  lastSyncCommitSha: string | null
  syncState: unknown
  publishMode: ReadmePublishMode
  publishPullRequestNumber: number | null
  publishPullRequestHead: string | null
}

export interface ReadmePublishDeps {
  store: ReadmeStore
  toMarkdown: (content: string | null | undefined) => string
  getToken?: typeof getInstallationToken
  getRepo?: typeof getRepository
  getCommit?: typeof getRepositoryCommit
  getTree?: typeof getRepositoryTree
  getBlob?: typeof getRepositoryBlob
  getBranchReference?: typeof getRepositoryBranchReference
  createBranch?: typeof createRepositoryBranch
  createFilesCommit?: typeof createRepositoryFilesCommit
  createPullRequest?: typeof createRepositoryPullRequest
  findOpenPullRequest?: typeof findOpenRepositoryPullRequest
  retry?: <T>(operation: () => Promise<T>) => Promise<T>
  now?: () => number
}

export class ReadmePublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ReadmePublishError'
  }
}

export const README_PUBLISH_BRANCH_PREFIX = 'bread/readme-sync-'
export const README_DIFF_MAX_FILES = 60
export const README_DIFF_MAX_BYTES = 256_000

export function isReadmePublishBranch(head: string | null | undefined): boolean {
  return Boolean(head && head.startsWith(README_PUBLISH_BRANCH_PREFIX))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** The spec in the format its repository file uses (JSON or YAML). */
export function specFileContent(raw: string, repoPath: string | null): string {
  if (!repoPath) return raw
  const rawIsJson = /^\s*[{[]/.test(raw)
  const fileIsJson = /\.json$/i.test(repoPath)
  if (rawIsJson === fileIsJson) return raw
  const parsed = parseSpecDocument(raw)
  if (!parsed) return raw
  return fileIsJson
    ? `${JSON.stringify(parsed, null, 2)}\n`
    : yaml.dump(parsed, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true })
}

export async function loadReadmeExportInput(
  store: ReadmeStore,
  repoId: number,
  toMarkdown: (content: string | null | undefined) => string,
): Promise<{
  folders: ReadmeExportFolder[]
  documents: ReadmeExportDocument[]
  specs: ReadmeExportSpec[]
  storeDocuments: ReadmeStoreDocument[]
}> {
  const [folders, documents, specs] = await Promise.all([
    store.listFolders(),
    store.listDocuments(),
    store.listSpecs(),
  ])
  // Role-restricted folders stay in Bread: nothing under them is written to
  // GitHub. The exception is a folder that mirrors a repository directory,
  // whose content is in the repository already.
  const exported = folders.filter(
    (folder) => !folder.restricted || readReadmeFolderLink(folder.metadata, repoId) !== null,
  )
  return {
    storeDocuments: documents,
    folders: exported.map((folder) => ({
      id: folder.id,
      displayName: folder.displayName,
      parentId: folder.parentId,
      sortOrder: folder.sortOrder,
      markdown: toMarkdown(folder.content),
      link: readReadmeFolderLink(folder.metadata, repoId),
    })),
    documents: documents.map((document) => {
      const metadata = document.metadata
      const sameRepository = Number(metadata?.repo_id) === repoId
      const pending = metadata?.github_hosted_pending_path
      const previous = metadata?.canonical_repo_path
      return {
        id: document.id,
        title: document.title.trim() || 'Untitled',
        hidden: document.status !== 'Published',
        folderId: document.folderId,
        sortOrder: document.sortOrder,
        publicSlug: document.publicSlug,
        markdown: toMarkdown(document.content),
        publishedDate:
          typeof metadata?.published_date === 'string' ? metadata.published_date : null,
        link: readReadmeDocumentLink(metadata, repoId),
        preferredPath: !sameRepository
          ? null
          : typeof pending === 'string'
            ? pending
            : typeof previous === 'string'
              ? previous
              : null,
      }
    }),
    specs: specs
      .filter((spec) => spec.specRaw)
      .map((spec) => ({
        slug: spec.slug,
        raw: specFileContent(spec.specRaw!, spec.repoPath),
        repoPath: spec.repoPath,
      })),
  }
}

interface Comparison {
  token: string
  branch: string
  head: GitHubRepositoryCommit
  /** Commit and tree the plan is computed against and committed onto. */
  base: GitHubRepositoryCommit
  tree: Map<string, string>
  sizes: Map<string, number>
  /** Open publish pull request this plan would extend. */
  pullRequest: { number: number; url: string; branch: string } | null
  plan: ReadmeExportPlan
  storeDocuments: ReadmeStoreDocument[]
  state: ReadmeSyncState
}

function resolveDeps(deps: ReadmePublishDeps) {
  return {
    getToken: deps.getToken ?? getInstallationToken,
    getRepo: deps.getRepo ?? getRepository,
    getCommit: deps.getCommit ?? getRepositoryCommit,
    getTree: deps.getTree ?? getRepositoryTree,
    getBlob: deps.getBlob ?? getRepositoryBlob,
    getBranchReference: deps.getBranchReference ?? getRepositoryBranchReference,
    createBranch: deps.createBranch ?? createRepositoryBranch,
    createFilesCommit: deps.createFilesCommit ?? createRepositoryFilesCommit,
    createPullRequest: deps.createPullRequest ?? createRepositoryPullRequest,
    findOpenPullRequest: deps.findOpenPullRequest ?? findOpenRepositoryPullRequest,
    retry: deps.retry ?? withGitHubRetry,
    now: deps.now ?? Date.now,
  }
}

async function resolveComparison(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
  options: { includeConflicts?: boolean; selectedPaths?: string[] } = {},
): Promise<Comparison> {
  const github = resolveDeps(deps)
  const { retry } = github
  const token = await retry(() => github.getToken(source.installationId))
  const repository = await retry(() => github.getRepo(token, source.repoFullName))
  if (repository.id !== source.repoId) {
    throw new ReadmePublishError(
      'The configured GitHub repository no longer matches this workspace link.',
      409,
      'repository_mismatch',
    )
  }
  const branch = source.branch ?? repository.default_branch
  const head = await retry(() => github.getCommit(token, source.repoFullName, branch))
  if (!source.lastSyncCommitSha || source.lastSyncCommitSha !== head.sha) {
    throw new ReadmePublishError(
      'GitHub has changes that Bread has not synchronized yet. Sync before publishing.',
      409,
      'github_sync_required',
      {
        last_synced_commit_sha: source.lastSyncCommitSha,
        current_commit_sha: head.sha,
      },
    )
  }
  const headTree = await retry(() =>
    github.getTree(token, source.repoFullName, head.commit.tree.sha),
  )
  if (headTree.truncated) {
    throw new ReadmePublishError(
      'The repository file tree is too large to publish safely.',
      409,
      'repository_tree_truncated',
    )
  }

  let base = head
  let baseTree = headTree
  let pullRequest: Comparison['pullRequest'] = null
  const state = readReadmeSyncState(source.syncState, source.root)
  let managedPaths = state.managed_paths
  if (source.publishMode === 'pull_request' && isReadmePublishBranch(source.publishPullRequestHead)) {
    const prBranch = source.publishPullRequestHead!
    const [open, reference] = await Promise.all([
      retry(() =>
        github.findOpenPullRequest(token, source.repoFullName, { head: prBranch, base: branch }),
      ),
      retry(() => github.getBranchReference(token, source.repoFullName, prBranch)),
    ])
    if (open && reference) {
      pullRequest = { number: open.number, url: open.html_url, branch: prBranch }
      if (reference.object.sha !== head.sha) {
        base = await retry(() =>
          github.getCommit(token, source.repoFullName, reference.object.sha),
        )
        baseTree = await retry(() =>
          github.getTree(token, source.repoFullName, base.commit.tree.sha),
        )
        // Files an earlier publish added on this branch are Bread's to remove.
        const onBranchOnly = baseTree.tree.filter(
          (entry) =>
            entry.type === 'blob' &&
            !headTree.tree.some((other) => other.path === entry.path) &&
            readmeSectionOf(relativeReadmePath(source.root, entry.path) ?? '') !== null,
        )
        managedPaths = [...managedPaths, ...onBranchOnly.map((entry) => entry.path)]
      }
    }
  }

  const tree = new Map<string, string>()
  const sizes = new Map<string, number>()
  for (const entry of baseTree.tree) {
    if (entry.type !== 'blob') continue
    tree.set(entry.path, entry.sha)
    sizes.set(entry.path, entry.size ?? 0)
  }
  const exported = await loadReadmeExportInput(deps.store, source.repoId, deps.toMarkdown)
  const complete = planReadmeExport({
    root: source.root,
    folders: exported.folders,
    documents: exported.documents,
    specs: exported.specs,
    tree,
    state: { ...state, managed_paths: managedPaths },
    includeConflicts: options.includeConflicts,
  })
  let plan: ReadmeExportPlan
  try {
    plan = selectReadmeExportPlan(complete, options.selectedPaths)
  } catch (error) {
    if (!(error instanceof ReadmeExportSelectionError)) throw error
    throw new ReadmePublishError(
      'The selected files no longer match the current GitHub comparison. Refresh the Changes view and try again.',
      409,
      'selected_paths_changed',
      { paths: error.paths },
    )
  }
  return {
    token,
    branch,
    head,
    base,
    tree,
    sizes,
    pullRequest,
    plan,
    storeDocuments: exported.storeDocuments,
    state,
  }
}

export interface ReadmePublishInspection {
  status: 'up_to_date' | 'changes' | 'sync_required' | 'blocked'
  changedFileCount: number
  writtenFileCount: number
  deletedFileCount: number
  unchangedFileCount: number
  conflictCount: number
  comparedCommitSha: string | null
  comparisonKey: string | null
  pullRequestUpToDate?: boolean
  code?: string
  message?: string
}

function comparisonKey(plan: ReadmeExportPlan, commitSha: string): string {
  const hash = createHash('sha256').update(commitSha)
  for (const write of plan.writes) {
    hash.update('\0write\0').update(write.path).update('\0').update(sha256(write.content))
  }
  for (const path of plan.deletes) hash.update('\0delete\0').update(path)
  return hash.digest('hex')
}

export async function inspectReadmePublish(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
): Promise<ReadmePublishInspection> {
  try {
    const comparison = await resolveComparison(source, deps)
    const { plan } = comparison
    const changed = plan.writes.length + plan.deletes.length
    return {
      status: changed === 0 ? 'up_to_date' : 'changes',
      changedFileCount: changed,
      writtenFileCount: plan.writes.length,
      deletedFileCount: plan.deletes.length,
      unchangedFileCount: plan.unchangedCount,
      conflictCount: plan.conflictCount,
      comparedCommitSha: comparison.base.sha,
      comparisonKey: comparisonKey(plan, comparison.base.sha),
      pullRequestUpToDate: comparison.pullRequest ? changed === 0 : undefined,
    }
  } catch (error) {
    if (!(error instanceof ReadmePublishError)) throw error
    const current = error.details.current_commit_sha
    return {
      status: error.code === 'github_sync_required' ? 'sync_required' : 'blocked',
      changedFileCount: 0,
      writtenFileCount: 0,
      deletedFileCount: 0,
      unchangedFileCount: 0,
      conflictCount: 0,
      comparedCommitSha: typeof current === 'string' ? current : null,
      comparisonKey: null,
      code: error.code,
      message: error.message,
    }
  }
}

export interface ReadmePublishDiffFile {
  path: string
  status: 'added' | 'modified' | 'removed'
  previous: string
  next: string
  bodyOmitted?: boolean
  previousBlobSha?: string
}

export async function diffReadmePublish(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
): Promise<{
  files: ReadmePublishDiffFile[]
  changedFileCount: number
  truncated: boolean
  comparedCommitSha: string
}> {
  const comparison = await resolveComparison(source, deps)
  const github = resolveDeps(deps)
  const { plan, tree, sizes, token } = comparison
  const files: ReadmePublishDiffFile[] = [
    ...plan.writes.map((write) => ({
      path: write.path,
      status: tree.has(write.path) ? ('modified' as const) : ('added' as const),
      previous: '',
      next: write.content,
      previousBlobSha: tree.get(write.path),
    })),
    ...plan.deletes.map((path) => ({
      path,
      status: 'removed' as const,
      previous: '',
      next: '',
      previousBlobSha: tree.get(path),
    })),
  ].sort((a, b) => a.path.localeCompare(b.path))
  const visible = files.slice(0, README_DIFF_MAX_FILES)
  await Promise.all(
    visible.map(async (file) => {
      if (file.status === 'added' || !file.previousBlobSha) return
      if ((sizes.get(file.path) ?? 0) > README_DIFF_MAX_BYTES) {
        file.bodyOmitted = true
        return
      }
      try {
        const blob = await github.retry(() =>
          github.getBlob(token, source.repoFullName, file.previousBlobSha!),
        )
        file.previous = Buffer.from(blob.content, 'base64').toString('utf8')
      } catch {
        file.bodyOmitted = true
      }
    }),
  )
  return {
    files: visible,
    changedFileCount: files.length,
    truncated: files.length > visible.length,
    comparedCommitSha: comparison.base.sha,
  }
}

export interface ReadmePublishResult {
  mode: ReadmePublishMode
  branch: string
  commitSha: string
  commitUrl: string
  pullRequestNumber: number | null
  pullRequestUrl: string | null
  changedFileCount: number
  writtenFileCount: number
  deletedFileCount: number
}

function commitMessage(plan: ReadmeExportPlan, message: string | undefined): string {
  const paths = [...plan.writes.map((write) => write.path), ...plan.deletes]
  const subject =
    message?.trim().split('\n')[0]?.slice(0, 120) ||
    (paths.length === 1
      ? `docs: update ${paths[0]} from Bread`
      : `docs: sync ${paths.length} files from Bread`)
  const listed = [
    ...plan.writes.slice(0, 20).map((write) => `- ${write.path}`),
    ...plan.deletes.slice(0, 20).map((path) => `- ${path} (removed)`),
  ]
  return paths.length > 1 ? `${subject}\n\n${listed.join('\n')}` : subject
}

function mapCommitError(error: unknown, branch: string): never {
  if (error instanceof GitHubApiError) {
    const text = error.message
    if (/protected|rule violations|GH006|GH013|required status|pull request is required/i.test(text)) {
      throw new ReadmePublishError(
        `GitHub rejected the push: ${branch} is protected. Allow the Bread GitHub App to bypass the branch rules, or switch publishing to pull requests in Settings.`,
        409,
        'branch_protected',
        { branch },
      )
    }
    if (error.status === 422 && /fast.?forward/i.test(text)) {
      throw new ReadmePublishError(
        'GitHub received new commits while publishing. Sync and try again.',
        409,
        'github_sync_required',
      )
    }
    if (error.status === 403 || error.status === 404) {
      throw new ReadmePublishError(
        'The Bread GitHub App cannot write to this repository. It needs read and write access to Contents.',
        409,
        'github_write_denied',
      )
    }
  }
  throw error
}

/** Record that the workspace now matches what was just committed. */
async function recordPublishedPlan(
  store: ReadmeStore,
  input: {
    source: ReadmePublishSource
    comparison: Comparison
    commitSha: string
  },
): Promise<void> {
  const { source, comparison, commitSha } = input
  const { plan, storeDocuments, state, branch } = comparison
  const documentById = new Map(storeDocuments.map((document) => [document.id, document]))

  for (const result of plan.documents) {
    const document = documentById.get(result.id)
    if (!document) continue
    await store.updateDocument(result.id, {
      metadata: {
        ...(document.metadata ?? {}),
        kind: 'github_hosted_document',
        repo_format: 'readme',
        canonical_repo_path: result.path,
        path: result.path,
        github_hosted_sync: true,
        github_hosted_conflict: false,
        github_hosted_pending_content_hash: null,
        github_hosted_pending_commit_sha: null,
        github_hosted_pending_path: null,
        github_hosted_detached_reason: null,
        github_hosted_content_hash: sha256(document.content),
        github_hosted_checkpoint_blob_sha: result.blobSha,
        readme_markdown_hash: result.markdownHash,
        readme_title: result.title,
        readme_hidden: result.hidden,
        readme_frontmatter: result.frontmatter,
        readme_frontmatter_raw: result.frontmatterRaw,
        repo_id: source.repoId,
        repo_full_name: source.repoFullName,
        ref: branch,
        commit_sha: commitSha,
      },
    })
  }
  const folders = await store.listFolders()
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  for (const result of plan.folders) {
    if (!result.linkChanged) continue
    const folder = folderById.get(result.id)
    if (!folder) continue
    await store.updateFolder(result.id, {
      metadata: {
        ...(folder.metadata ?? {}),
        ...readmeFolderMetadata(source.repoId, result.link),
      },
    })
  }
  for (const spec of plan.specs) {
    await store.setSpecRepository(spec.slug, { repoPath: spec.path, repoBlobSha: spec.blobSha })
  }
  if (plan.deletes.length > 0) await store.clearDeletedLinks(plan.deletes)

  const deleted = new Set(plan.deletes)
  const orderFiles = Object.fromEntries(
    Object.entries({ ...state.order_files, ...plan.orderFiles }).filter(
      ([path]) => !deleted.has(path),
    ),
  )
  const remaining = await store.listDocuments()
  const nextState: ReadmeSyncState = {
    ...state,
    order_files: orderFiles,
    managed_paths: plan.managedPaths,
  }
  await store.updateSource({
    sync_state: nextState,
    last_sync_commit_sha: commitSha,
    last_sync_at: new Date().toISOString(),
    conflict_count: remaining.filter(
      (document) =>
        Number(document.metadata?.repo_id) === source.repoId &&
        document.metadata?.github_hosted_conflict === true,
    ).length,
  })
}

export async function publishReadmeWorkspace(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
  options: {
    includeConflicts?: boolean
    selectedPaths?: string[]
    message?: string
  } = {},
): Promise<ReadmePublishResult> {
  const github = resolveDeps(deps)
  const comparison = await resolveComparison(source, deps, options)
  const { plan, token, branch, base, head } = comparison
  const changed = plan.writes.length + plan.deletes.length
  if (changed === 0) {
    throw new ReadmePublishError(
      'GitHub already matches the Bread workspace.',
      409,
      'no_changes',
    )
  }
  const message = commitMessage(plan, options.message)

  if (source.publishMode === 'direct') {
    const commit = await github
      .retry(() =>
        github.createFilesCommit(token, source.repoFullName, {
          branch,
          baseCommitSha: head.sha,
          baseTreeSha: head.commit.tree.sha,
          message,
          files: plan.writes,
          deletePaths: plan.deletes,
        }),
      )
      .catch((error: unknown) => mapCommitError(error, branch))
    await recordPublishedPlan(deps.store, { source, comparison, commitSha: commit.sha })
    return {
      mode: 'direct',
      branch,
      commitSha: commit.sha,
      commitUrl: commit.html_url,
      pullRequestNumber: null,
      pullRequestUrl: null,
      changedFileCount: changed,
      writtenFileCount: plan.writes.length,
      deletedFileCount: plan.deletes.length,
    }
  }

  const prBranch =
    comparison.pullRequest?.branch ?? `${README_PUBLISH_BRANCH_PREFIX}${github.now().toString(36)}`
  if (!comparison.pullRequest) {
    await github.retry(() =>
      github.createBranch(token, source.repoFullName, prBranch, head.sha),
    )
  }
  const commit = await github
    .retry(() =>
      github.createFilesCommit(token, source.repoFullName, {
        branch: prBranch,
        baseCommitSha: base.sha,
        baseTreeSha: base.commit.tree.sha,
        message,
        files: plan.writes,
        deletePaths: plan.deletes,
      }),
    )
    .catch((error: unknown) => mapCommitError(error, prBranch))
  const pullRequest: { number: number; url: string; branch: string } =
    comparison.pullRequest ??
    (await github
      .retry(() =>
        github.createPullRequest(token, source.repoFullName, {
          head: prBranch,
          base: branch,
          title: 'docs: sync from Bread',
          body: [
            'Publishes the current Bread workspace to this repository.',
            '',
            `${plan.writes.length} file${plan.writes.length === 1 ? '' : 's'} written; ${plan.deletes.length} deleted.`,
            '',
            'Merge this pull request to make the changes live. Bread picks the merge up automatically.',
          ].join('\n'),
        }),
      )
      .then((created) => ({ number: created.number, url: created.html_url, branch: prBranch })))

  // Until the pull request merges nothing is linked. Remember where each new
  // document was written so the merge links it instead of importing a copy.
  const documentById = new Map(
    comparison.storeDocuments.map((document) => [document.id, document]),
  )
  for (const result of plan.documents) {
    const document = documentById.get(result.id)
    if (!document || readReadmeDocumentLink(document.metadata, source.repoId)) continue
    await deps.store.updateDocument(result.id, {
      metadata: {
        ...(document.metadata ?? {}),
        github_hosted_pending_path: result.path,
        repo_id: source.repoId,
      },
    })
  }
  await deps.store.updateSource({
    publish_pull_request_number: pullRequest.number,
    publish_pull_request_url: pullRequest.url,
    publish_pull_request_head: prBranch,
    publish_last_commit_sha: commit.sha,
  })
  return {
    mode: 'pull_request',
    branch: prBranch,
    commitSha: commit.sha,
    commitUrl: commit.html_url,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    changedFileCount: changed,
    writtenFileCount: plan.writes.length,
    deletedFileCount: plan.deletes.length,
  }
}

/**
 * Commit one OpenAPI definition to the synced branch right after it was
 * uploaded (CI or Settings), the way ReadMe writes an uploaded definition back
 * to the repository. Touches a single Bread-owned path, so it does not need
 * the workspace to be fully synchronized first.
 */
export async function commitReadmeSpecFile(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
  input: { slug: string; raw: string | null; repoPath: string | null },
): Promise<{ committed: boolean; path: string | null; commitSha: string | null }> {
  if (source.publishMode !== 'direct') return { committed: false, path: null, commitSha: null }
  const github = resolveDeps(deps)
  const { retry } = github
  const token = await retry(() => github.getToken(source.installationId))
  const repository = await retry(() => github.getRepo(token, source.repoFullName))
  if (repository.id !== source.repoId) return { committed: false, path: null, commitSha: null }
  const branch = source.branch ?? repository.default_branch
  const head = await retry(() => github.getCommit(token, source.repoFullName, branch))
  const tree = await retry(() => github.getTree(token, source.repoFullName, head.commit.tree.sha))
  const blobByPath = new Map(
    tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]),
  )

  const removing = input.raw === null
  const [planned] = planReadmeExport({
    root: source.root,
    folders: [],
    documents: [],
    specs: removing ? [] : [{
      slug: input.slug,
      raw: specFileContent(input.raw!, input.repoPath),
      repoPath: input.repoPath,
    }],
    tree: blobByPath,
    state: readReadmeSyncState(null, source.root),
  }).specs
  const path = removing ? input.repoPath : planned!.path
  if (!path) return { committed: false, path: null, commitSha: null }
  if (removing ? !blobByPath.has(path) : !planned!.written) {
    if (!removing) {
      await deps.store.setSpecRepository(input.slug, {
        repoPath: path,
        repoBlobSha: planned!.blobSha,
      })
    }
    return { committed: false, path, commitSha: null }
  }

  const commit = await retry(() =>
    github.createFilesCommit(token, source.repoFullName, {
      branch,
      baseCommitSha: head.sha,
      baseTreeSha: head.commit.tree.sha,
      message: removing
        ? `docs: remove OpenAPI definition ${input.slug}`
        : `docs: update OpenAPI definition ${input.slug}`,
      files: removing
        ? []
        : [{ path, content: specFileContent(input.raw!, input.repoPath) }],
      deletePaths: removing ? [path] : [],
    }),
  ).catch((error: unknown) => mapCommitError(error, branch))

  if (!removing) {
    await deps.store.setSpecRepository(input.slug, {
      repoPath: path,
      repoBlobSha: planned!.blobSha,
    })
  }
  // Only advance the sync checkpoint when nothing else was waiting to be
  // pulled; otherwise the push webhook reconciles the rest.
  if (source.lastSyncCommitSha === head.sha) {
    const state = readReadmeSyncState(source.syncState, source.root)
    const managed = new Set(state.managed_paths)
    if (removing) managed.delete(path)
    else managed.add(path)
    await deps.store.updateSource({
      last_sync_commit_sha: commit.sha,
      sync_state: { ...state, managed_paths: [...managed].sort((a, b) => a.localeCompare(b)) },
    })
  }
  return { committed: true, path, commitSha: commit.sha }
}
