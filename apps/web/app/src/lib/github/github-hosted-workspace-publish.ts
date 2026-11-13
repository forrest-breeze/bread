import { createHash } from 'crypto'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
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
  type GitHubCreatedPullRequest,
  type GitHubReference,
  type GitHubRepository,
  type GitHubRepositoryCommit,
  type GitHubRepositoryTree,
} from './github'
import {
  githubHostedDocsBranchPrefix,
  normalizeBootstrapTargetPath,
  type GitHubBootstrapFile,
} from './github-hosted-bootstrap'
import { withGitHubRetry } from './retry'

type PublishSource = Pick<
  GitHubHostedDocsSourceRow,
  | 'installation_id'
  | 'repo_id'
  | 'repo_full_name'
  | 'paths'
  | 'last_sync_commit_sha'
  | 'publish_pull_request_number'
  | 'publish_pull_request_url'
  | 'publish_pull_request_head'
  | 'publish_last_commit_sha'
>

export interface HostedWorkspacePublishPlan {
  files: Array<{ path: string; content: string }>
  deletePaths: string[]
  unchangedFileCount: number
}

function selectHostedWorkspacePublishPlan(
  plan: HostedWorkspacePublishPlan,
  selectedPaths: string[] | undefined,
): HostedWorkspacePublishPlan {
  if (!selectedPaths) return plan

  const selected = new Set(selectedPaths)
  const changed = new Set([
    ...plan.files.map((file) => file.path),
    ...plan.deletePaths,
  ])
  const invalid = [...selected].filter((path) => !changed.has(path))
  if (invalid.length > 0) {
    throw new HostedWorkspacePublishError(
      'The selected files no longer match the current GitHub comparison. Refresh the Changes view and try again.',
      409,
      'selected_paths_changed',
      { paths: invalid },
    )
  }

  const files = plan.files.filter((file) => selected.has(file.path))
  const deletePaths = plan.deletePaths.filter((path) => selected.has(path))
  return {
    files,
    deletePaths,
    unchangedFileCount:
      plan.unchangedFileCount +
      (plan.files.length - files.length) +
      (plan.deletePaths.length - deletePaths.length),
  }
}

export interface HostedWorkspacePublishResult {
  branch: string
  commitSha: string
  commitUrl: string
  pullRequestNumber: number
  pullRequestUrl: string
  changedFileCount: number
  writtenFileCount: number
  deletedFileCount: number
  reused: boolean
}

export type HostedWorkspacePublishStatus =
  | 'up_to_date'
  | 'changes'
  | 'sync_required'
  | 'blocked'

export interface HostedWorkspacePublishInspection {
  status: HostedWorkspacePublishStatus
  changedFileCount: number
  writtenFileCount: number
  deletedFileCount: number
  unchangedFileCount: number
  comparedCommitSha: string | null
  comparisonKey: string | null
  pullRequestUpToDate?: boolean
  code?: string
  message?: string
}

export class HostedWorkspacePublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'HostedWorkspacePublishError'
  }
}

interface PublishDependencies {
  getToken?: typeof getInstallationToken
  getRepo?: typeof getRepository
  getBranchReference?: typeof getRepositoryBranchReference
  getCommit?: typeof getRepositoryCommit
  getTree?: typeof getRepositoryTree
  createBranch?: typeof createRepositoryBranch
  createFilesCommit?: typeof createRepositoryFilesCommit
  createPullRequest?: typeof createRepositoryPullRequest
  findOpenPullRequest?: typeof findOpenRepositoryPullRequest
  retry?: <T>(operation: () => Promise<T>) => Promise<T>
  now?: () => number
}

interface ReservedPublishBranch {
  pullRequest: GitHubCreatedPullRequest | null
  branch: string
  branchReference: GitHubReference | null
}

type ResolvedPublishDependencies = Required<PublishDependencies>

interface HostedWorkspacePublishComparison {
  deps: ResolvedPublishDependencies
  targetPath: string
  token: string
  repository: GitHubRepository
  defaultCommit: GitHubRepositoryCommit
  defaultTree: GitHubRepositoryTree
  reserved: ReservedPublishBranch | null
  usesReservedBranch: boolean
  commitBeforePublish: GitHubRepositoryCommit
  treeBeforePublish: GitHubRepositoryTree
  plan: HostedWorkspacePublishPlan
}

/** GitHub's blob object ID for an exact UTF-8 file body. */
export function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf8')
  return createHash('sha1')
    .update(`blob ${body.byteLength}\0`)
    .update(body)
    .digest('hex')
}

function hostedWorkspaceComparisonKey(
  plan: HostedWorkspacePublishPlan,
  comparedCommitSha: string,
): string {
  const hash = createHash('sha256').update(comparedCommitSha)
  for (const file of plan.files) {
    hash.update('\0write\0').update(file.path).update('\0')
    hash.update(gitBlobSha(file.content))
  }
  for (const path of plan.deletePaths) {
    hash.update('\0delete\0').update(path)
  }
  return hash.digest('hex')
}

function isManagedWorkspacePath(path: string, targetPath: string): boolean {
  return (
    (path.startsWith(`${targetPath}/`) && /\.(?:md|mdx)$/i.test(path)) ||
    path === `${targetPath}/.gitkeep`
  )
}

/**
 * Compare the deterministic Breezify export to a repository tree without
 * downloading file bodies. Git tree blob SHAs use the same object hash as
 * gitBlobSha, so identical files never produce a no-op commit.
 */
export function planHostedWorkspacePublish(input: {
  targetPath: string
  files: GitHubBootstrapFile[]
  managedPaths: string[]
  tree: GitHubRepositoryTree
}): HostedWorkspacePublishPlan {
  const targetPath = normalizeBootstrapTargetPath(input.targetPath)
  if (!targetPath) {
    throw new HostedWorkspacePublishError(
      'The configured GitHub docs root is invalid.',
      409,
      'invalid_root',
    )
  }
  if (input.tree.truncated) {
    throw new HostedWorkspacePublishError(
      'The repository file tree is too large to safely publish the workspace.',
      409,
      'repository_tree_truncated',
    )
  }

  const desiredPaths = new Set<string>()
  const managedPaths = new Set(
    input.managedPaths.filter((path) => isManagedWorkspacePath(path, targetPath)),
  )
  for (const file of input.files) {
    if (!isManagedWorkspacePath(file.path, targetPath)) {
      throw new HostedWorkspacePublishError(
        `The workspace export produced an unexpected path: ${file.path}`,
        422,
        'invalid_export_path',
      )
    }
    if (desiredPaths.has(file.path)) {
      throw new HostedWorkspacePublishError(
        `The workspace export produced the same path twice: ${file.path}`,
        422,
        'duplicate_export_path',
      )
    }
    desiredPaths.add(file.path)
  }

  const blobsByPath = new Map(
    input.tree.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => [entry.path, entry.sha]),
  )
  const files = input.files
    .filter((file) => blobsByPath.get(file.path) !== gitBlobSha(file.content))
    .map(({ path, content }) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const deletePaths = input.tree.tree
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        (managedPaths.has(entry.path) || entry.path === `${targetPath}/.gitkeep`) &&
        !desiredPaths.has(entry.path),
    )
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b))

  return {
    files,
    deletePaths,
    unchangedFileCount: input.files.length - files.length,
  }
}

export function githubHostedWorkspacePublishBranchPrefix(
  targetPath: string,
): string {
  return `${githubHostedDocsBranchPrefix(targetPath)}workspace-`
}

export function isHostedWorkspacePublishBranch(
  head: string | null,
  targetPath: string,
): boolean {
  return Boolean(
    head &&
      head.startsWith(githubHostedWorkspacePublishBranchPrefix(targetPath)),
  )
}

export function createHostedWorkspacePublishBranch(
  targetPath: string,
  now: number = Date.now(),
): string {
  return `${githubHostedWorkspacePublishBranchPrefix(targetPath)}${now.toString(36)}`
}

async function resolveReservedPublishBranch(
  source: PublishSource,
  targetPath: string,
  base: string,
  token: string,
  deps: Required<
    Pick<
      PublishDependencies,
      'findOpenPullRequest' | 'getBranchReference' | 'retry'
    >
  >,
  options: { includeUnopenedBranchReference?: boolean } = {},
): Promise<ReservedPublishBranch | null> {
  const branch = source.publish_pull_request_head
  if (!branch || !isHostedWorkspacePublishBranch(branch, targetPath)) {
    return null
  }

  const pullRequest = await deps.retry(() =>
    deps.findOpenPullRequest(token, source.repo_full_name, {
      head: branch,
      base,
    }),
  )
  if (
    pullRequest &&
    source.publish_pull_request_number !== null &&
    pullRequest.number !== source.publish_pull_request_number
  ) {
    throw new HostedWorkspacePublishError(
      'The saved workspace pull request no longer matches its branch.',
      409,
      'publish_pull_request_mismatch',
    )
  }
  const branchReference =
    pullRequest || options.includeUnopenedBranchReference !== false
      ? await deps.retry(() =>
          deps.getBranchReference(token, source.repo_full_name, branch),
        )
      : null
  return { pullRequest, branch, branchReference }
}

function resolvePublishDependencies(
  injected: PublishDependencies,
): ResolvedPublishDependencies {
  return {
    getToken: injected.getToken ?? getInstallationToken,
    getRepo: injected.getRepo ?? getRepository,
    getBranchReference:
      injected.getBranchReference ?? getRepositoryBranchReference,
    getCommit: injected.getCommit ?? getRepositoryCommit,
    getTree: injected.getTree ?? getRepositoryTree,
    createBranch: injected.createBranch ?? createRepositoryBranch,
    createFilesCommit:
      injected.createFilesCommit ?? createRepositoryFilesCommit,
    createPullRequest:
      injected.createPullRequest ?? createRepositoryPullRequest,
    findOpenPullRequest:
      injected.findOpenPullRequest ?? findOpenRepositoryPullRequest,
    retry: injected.retry ?? withGitHubRetry,
    now: injected.now ?? Date.now,
  }
}

async function resolveHostedWorkspacePublishComparison(
  input: {
    source: PublishSource
    files: GitHubBootstrapFile[]
    managedPaths: string[]
  },
  injected: PublishDependencies,
  options: { compareOpenPullRequestOnly?: boolean } = {},
): Promise<HostedWorkspacePublishComparison> {
  const targetPath = normalizeBootstrapTargetPath(input.source.paths[0] ?? '')
  if (!targetPath || input.source.paths.length !== 1) {
    throw new HostedWorkspacePublishError(
      'Configure one active GitHub docs root before publishing.',
      409,
      'invalid_root',
    )
  }

  const deps = resolvePublishDependencies(injected)
  const token = await deps.retry(() =>
    deps.getToken(input.source.installation_id),
  )
  const repository: GitHubRepository = await deps.retry(() =>
    deps.getRepo(token, input.source.repo_full_name),
  )
  if (repository.id !== input.source.repo_id) {
    throw new HostedWorkspacePublishError(
      'The configured GitHub repository no longer matches this workspace link.',
      409,
      'repository_mismatch',
    )
  }
  // The default-branch commit and reserved PR lookup are independent once the
  // repository is known. Resolve both during the same network round trip.
  const [defaultCommitResult, reservedResult] = await Promise.allSettled([
    deps.retry(() =>
      deps.getCommit(
        token,
        input.source.repo_full_name,
        repository.default_branch,
      ),
    ),
    resolveReservedPublishBranch(
      input.source,
      targetPath,
      repository.default_branch,
      token,
      deps,
      {
        includeUnopenedBranchReference: !options.compareOpenPullRequestOnly,
      },
    ),
  ])
  if (defaultCommitResult.status === 'rejected') {
    throw defaultCommitResult.reason
  }
  const defaultCommit = defaultCommitResult.value
  if (
    !input.source.last_sync_commit_sha ||
    input.source.last_sync_commit_sha !== defaultCommit.sha
  ) {
    throw new HostedWorkspacePublishError(
      'GitHub has changes that Breezify has not synchronized yet. Sync the docs root before publishing.',
      409,
      'github_sync_required',
      {
        last_synced_commit_sha: input.source.last_sync_commit_sha,
        current_commit_sha: defaultCommit.sha,
      },
    )
  }
  if (reservedResult.status === 'rejected') throw reservedResult.reason
  const reserved = reservedResult.value

  if (input.source.publish_pull_request_number && !reserved?.pullRequest) {
    throw new HostedWorkspacePublishError(
      'The saved workspace pull request is no longer open. Refresh GitHub status before publishing again.',
      409,
      'publish_pull_request_closed',
    )
  }
  if (reserved?.pullRequest && !reserved.branchReference) {
    throw new HostedWorkspacePublishError(
      'The open workspace pull request branch is no longer available. Refresh GitHub status before publishing again.',
      409,
      'publish_branch_missing',
      {
        pull_request_number: reserved.pullRequest.number,
        pull_request_url: reserved.pullRequest.html_url,
        branch: reserved.branch,
      },
    )
  }

  const comparedBranchReference =
    options.compareOpenPullRequestOnly && !reserved?.pullRequest
      ? null
      : (reserved?.branchReference ?? null)
  // Fetch the default tree and an open publish branch's commit in parallel.
  // The branch tree itself is requested only when it differs from the default.
  const [defaultTreeResult, comparedCommitResult] = await Promise.allSettled([
    deps.retry(() =>
      deps.getTree(
        token,
        input.source.repo_full_name,
        defaultCommit.commit.tree.sha,
      ),
    ),
    comparedBranchReference
      ? deps.retry(() =>
          deps.getCommit(
            token,
            input.source.repo_full_name,
            comparedBranchReference.object.sha,
          ),
        )
      : Promise.resolve(null),
  ])
  if (defaultTreeResult.status === 'rejected') throw defaultTreeResult.reason
  const defaultTree = defaultTreeResult.value
  if (defaultTree.truncated) {
    throw new HostedWorkspacePublishError(
      'The repository file tree is too large to safely publish the workspace.',
      409,
      'repository_tree_truncated',
    )
  }
  if (comparedCommitResult.status === 'rejected') {
    throw comparedCommitResult.reason
  }
  const comparedCommit = comparedCommitResult.value

  const usesReservedBranch = Boolean(comparedBranchReference)
  let commitBeforePublish: GitHubRepositoryCommit
  let treeBeforePublish: GitHubRepositoryTree
  if (comparedBranchReference && comparedCommit) {
    commitBeforePublish = comparedCommit
    treeBeforePublish =
      commitBeforePublish.commit.tree.sha === defaultCommit.commit.tree.sha
        ? defaultTree
        : await deps.retry(() =>
            deps.getTree(
              token,
              input.source.repo_full_name,
              commitBeforePublish.commit.tree.sha,
            ),
          )
  } else {
    commitBeforePublish = defaultCommit
    treeBeforePublish = defaultTree
  }

  const defaultBlobPaths = new Set(
    defaultTree.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => entry.path),
  )
  // New files created by an earlier commit on this dedicated Breezify branch do
  // not have default-branch repository companions yet. They are nevertheless
  // safe to delete on an update, provided the reviewer-SHA guard passes.
  const branchOnlyPaths = usesReservedBranch
    ? treeBeforePublish.tree
        .filter(
          (entry) =>
            entry.type === 'blob' && !defaultBlobPaths.has(entry.path),
        )
        .map((entry) => entry.path)
    : []
  const plan = planHostedWorkspacePublish({
    targetPath,
    files: input.files,
    managedPaths: [...input.managedPaths, ...branchOnlyPaths],
    tree: treeBeforePublish,
  })

  return {
    deps,
    targetPath,
    token,
    repository,
    defaultCommit,
    defaultTree,
    reserved,
    usesReservedBranch,
    commitBeforePublish,
    treeBeforePublish,
    plan,
  }
}

function assertHostedWorkspacePublishBranchIsSafe(
  source: PublishSource,
  comparison: HostedWorkspacePublishComparison,
): void {
  const { plan, reserved, targetPath } = comparison
  const hasChanges = plan.files.length > 0 || plan.deletePaths.length > 0
  if (
    hasChanges &&
    comparison.usesReservedBranch &&
    reserved?.branchReference &&
    source.publish_last_commit_sha &&
    reserved.branchReference.object.sha !== source.publish_last_commit_sha
  ) {
    throw new HostedWorkspacePublishError(
      'The open workspace pull request branch has commits that Breezify did not create. Review those commits before publishing again.',
      409,
      'publish_branch_changed',
      {
        pull_request_number: reserved.pullRequest?.number ?? null,
        pull_request_url: reserved.pullRequest?.html_url ?? null,
        branch: reserved.branch,
      },
    )
  }
  if (reserved?.pullRequest && !source.publish_last_commit_sha && hasChanges) {
    throw new HostedWorkspacePublishError(
      'The recovered workspace pull request branch changed before Breezify could record its commit. Review it before publishing again.',
      409,
      'publish_branch_changed',
      {
        pull_request_number: reserved.pullRequest.number,
        pull_request_url: reserved.pullRequest.html_url,
        branch: reserved.branch,
      },
    )
  }
  if (
    hasChanges &&
    comparison.usesReservedBranch &&
    reserved?.branchReference &&
    !source.publish_last_commit_sha &&
    !reserved.pullRequest &&
    reserved.branchReference.object.sha !== comparison.defaultCommit.sha
  ) {
    throw new HostedWorkspacePublishError(
      'The reserved workspace publish branch changed before Breezify could finish publishing.',
      409,
      'publish_branch_changed',
      { branch: reserved.branch, target_path: targetPath },
    )
  }
}

/** Inspect the same commit/tree and safety guards used by a subsequent publish. */
export async function inspectHostedWorkspacePublish(
  input: {
    source: PublishSource
    files: GitHubBootstrapFile[]
    managedPaths: string[]
  },
  injected: PublishDependencies = {},
): Promise<HostedWorkspacePublishInspection> {
  try {
    const comparison = await resolveHostedWorkspacePublishComparison(
      input,
      injected,
      { compareOpenPullRequestOnly: true },
    )
    const { plan, reserved, commitBeforePublish } = comparison
    const writtenFileCount = plan.files.length
    const deletedFileCount = plan.deletePaths.length
    const changedFileCount = writtenFileCount + deletedFileCount
    const comparisonKey = hostedWorkspaceComparisonKey(
      plan,
      commitBeforePublish.sha,
    )

    try {
      assertHostedWorkspacePublishBranchIsSafe(input.source, comparison)
    } catch (error) {
      if (!(error instanceof HostedWorkspacePublishError)) throw error
      return {
        status: 'blocked',
        changedFileCount,
        writtenFileCount,
        deletedFileCount,
        unchangedFileCount: plan.unchangedFileCount,
        comparedCommitSha: commitBeforePublish.sha,
        comparisonKey,
        pullRequestUpToDate: reserved?.pullRequest ? false : undefined,
        code: error.code,
        message: error.message,
      }
    }

    return {
      status: changedFileCount === 0 ? 'up_to_date' : 'changes',
      changedFileCount,
      writtenFileCount,
      deletedFileCount,
      unchangedFileCount: plan.unchangedFileCount,
      comparedCommitSha: commitBeforePublish.sha,
      comparisonKey,
      pullRequestUpToDate: reserved?.pullRequest
        ? changedFileCount === 0
        : undefined,
    }
  } catch (error) {
    if (!(error instanceof HostedWorkspacePublishError)) throw error
    const currentCommitSha = error.details.current_commit_sha
    return {
      status:
        error.code === 'github_sync_required' ? 'sync_required' : 'blocked',
      changedFileCount: 0,
      writtenFileCount: 0,
      deletedFileCount: 0,
      unchangedFileCount: 0,
      comparedCommitSha:
        typeof currentCommitSha === 'string' ? currentCommitSha : null,
      comparisonKey: null,
      code: error.code,
      message: error.message,
    }
  }
}

function workspacePullRequestBody(
  targetPath: string,
  writtenFileCount: number,
  deletedFileCount: number,
): string {
  return [
    `Makes the Markdown and MDX tree under \`${targetPath}\` match the current Breezify workspace.`,
    '',
    `${writtenFileCount} file${writtenFileCount === 1 ? '' : 's'} written; ` +
      `${deletedFileCount} deleted.`,
    '',
    'Merge this pull request to publish the workspace changes to the linked GitHub docs root.',
  ].join('\n')
}

/** Publish the complete deterministic workspace export in one commit and PR. */
export async function publishHostedWorkspaceToGitHub(
  input: {
    source: PublishSource
    files: GitHubBootstrapFile[]
    managedPaths: string[]
    /** When set, create a commit containing only these currently changed paths. */
    selectedPaths?: string[]
  },
  injected: PublishDependencies = {},
): Promise<HostedWorkspacePublishResult> {
  const comparison = await resolveHostedWorkspacePublishComparison(
    input,
    injected,
  )
  const {
    deps,
    targetPath,
    token,
    repository,
    defaultCommit,
    reserved,
    commitBeforePublish,
    plan: completePlan,
  } = comparison
  const plan = selectHostedWorkspacePublishPlan(
    completePlan,
    input.selectedPaths,
  )
  const branch =
    reserved?.branch ?? createHostedWorkspacePublishBranch(targetPath, deps.now())
  const hasChanges = plan.files.length > 0 || plan.deletePaths.length > 0
  assertHostedWorkspacePublishBranchIsSafe(input.source, comparison)
  if (reserved?.pullRequest && !hasChanges) {
    return {
      branch,
      commitSha: commitBeforePublish.sha,
      commitUrl: `https://github.com/${input.source.repo_full_name}/commit/${commitBeforePublish.sha}`,
      pullRequestNumber: reserved.pullRequest.number,
      pullRequestUrl: reserved.pullRequest.html_url,
      changedFileCount: 0,
      writtenFileCount: 0,
      deletedFileCount: 0,
      reused: true,
    }
  }
  if (!hasChanges) {
    if (
      reserved?.branchReference &&
      reserved.branchReference.object.sha !== defaultCommit.sha
    ) {
      const pullRequest = await deps.retry(() =>
        deps.createPullRequest(token, input.source.repo_full_name, {
          head: branch,
          base: repository.default_branch,
          title: `docs: Publish Breezify workspace to ${targetPath}`,
          body: workspacePullRequestBody(targetPath, 0, 0),
        }),
      )
      return {
        branch,
        commitSha: commitBeforePublish.sha,
        commitUrl: `https://github.com/${input.source.repo_full_name}/commit/${commitBeforePublish.sha}`,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.html_url,
        changedFileCount: 0,
        writtenFileCount: 0,
        deletedFileCount: 0,
        reused: false,
      }
    }
    throw new HostedWorkspacePublishError(
      'The GitHub docs root already matches the Breezify workspace.',
      409,
      'no_changes',
    )
  }

  if (!reserved?.branchReference) {
    await deps.retry(() =>
      deps.createBranch(
        token,
        input.source.repo_full_name,
        branch,
        commitBeforePublish.sha,
      ),
    )
  }
  const commit = await deps.retry(() =>
    deps.createFilesCommit(token, input.source.repo_full_name, {
      branch,
      baseCommitSha: commitBeforePublish.sha,
      baseTreeSha: commitBeforePublish.commit.tree.sha,
      message: `docs: publish Breezify workspace to ${targetPath}`,
      files: plan.files,
      deletePaths: plan.deletePaths,
    }),
  )

  const pullRequest = reserved?.pullRequest ??
    (await deps.retry(() =>
      deps.createPullRequest(token, input.source.repo_full_name, {
        head: branch,
        base: repository.default_branch,
        title: `docs: Publish Breezify workspace to ${targetPath}`,
        body: workspacePullRequestBody(
          targetPath,
          plan.files.length,
          plan.deletePaths.length,
        ),
      }),
    ))

  return {
    branch,
    commitSha: commit.sha,
    commitUrl: commit.html_url,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.html_url,
    changedFileCount: plan.files.length + plan.deletePaths.length,
    writtenFileCount: plan.files.length,
    deletedFileCount: plan.deletePaths.length,
    reused: Boolean(reserved?.pullRequest),
  }
}

// ---------------------------------------------------------------------------
// Publish preview ("files changed").
//
// planHostedWorkspacePublish deliberately compares by blob SHA and never
// downloads file bodies — that is what keeps the status check cheap enough to
// poll. A reviewable diff needs the OLD bodies too, so this fetches them, but
// only for paths the plan already says changed, and under hard caps: a request
// that would need hundreds of blobs returns what it has plus `truncated`.
// ---------------------------------------------------------------------------

/** Most changed files whose bodies are fetched for one preview. */
export const PUBLISH_DIFF_MAX_FILES = 60
/** Files larger than this are listed without a body — diffing them is noise. */
export const PUBLISH_DIFF_MAX_BYTES = 256_000

export type PublishDiffFileStatus = 'added' | 'modified' | 'removed'

export interface PublishDiffFile {
  path: string
  status: PublishDiffFileStatus
  /** Content on GitHub today; empty for an added file. */
  previous: string
  /** Content this publish would write; empty for a removed file. */
  next: string
  /** True when the body was withheld (too large, or unreadable). */
  bodyOmitted?: boolean
  /** Blob currently being compared, used by explicit GitHub-side reverts. */
  previousBlobSha?: string
}

export interface HostedWorkspacePublishDiff {
  files: PublishDiffFile[]
  changedFileCount: number
  /** True when more files changed than PUBLISH_DIFF_MAX_FILES. */
  truncated: boolean
  comparedCommitSha: string | null
}

export async function resolveHostedWorkspacePublishDiff(
  input: {
    source: PublishSource
    files: GitHubBootstrapFile[]
    managedPaths: string[]
  },
  injected: PublishDependencies & { getBlob?: typeof getRepositoryBlob } = {},
): Promise<HostedWorkspacePublishDiff> {
  const comparison = await resolveHostedWorkspacePublishComparison(
    input,
    injected,
    { compareOpenPullRequestOnly: true },
  )
  const { plan, treeBeforePublish, commitBeforePublish, token, repository } =
    comparison
  const getBlob = injected.getBlob ?? getRepositoryBlob
  const retry = injected.retry ?? withGitHubRetry

  const blobShaByPath = new Map(
    treeBeforePublish.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => [entry.path, { sha: entry.sha, size: entry.size ?? 0 }]),
  )

  const changedFileCount = plan.files.length + plan.deletePaths.length
  const written: PublishDiffFile[] = plan.files.map((file) => ({
    path: file.path,
    status: blobShaByPath.has(file.path)
      ? ('modified' as const)
      : ('added' as const),
    previous: '',
    next: file.content,
    previousBlobSha: blobShaByPath.get(file.path)?.sha,
  }))
  const removed: PublishDiffFile[] = plan.deletePaths.map((path) => ({
    path,
    status: 'removed' as const,
    previous: '',
    next: '',
    previousBlobSha: blobShaByPath.get(path)?.sha,
  }))

  // Sorted for a stable review order, then capped before any network work so
  // the cap bounds API calls, not just the response size.
  const ordered = [...written, ...removed].sort((a, b) =>
    a.path.localeCompare(b.path),
  )
  const visible = ordered.slice(0, PUBLISH_DIFF_MAX_FILES)

  await Promise.all(
    visible.map(async (file) => {
      // An added file has no previous body to fetch.
      if (file.status === 'added') return
      const blob = blobShaByPath.get(file.path)
      if (!blob) return
      if (blob.size > PUBLISH_DIFF_MAX_BYTES) {
        file.bodyOmitted = true
        return
      }
      try {
        const fetched = await retry(() =>
          getBlob(token, repository.full_name, blob.sha),
        )
        file.previous = Buffer.from(fetched.content, 'base64').toString('utf8')
      } catch {
        // One unreadable blob must not fail the whole preview — the file still
        // appears in the list, just without its before-text.
        file.bodyOmitted = true
      }
    }),
  )

  return {
    files: visible,
    changedFileCount,
    truncated: ordered.length > visible.length,
    comparedCommitSha: commitBeforePublish.sha,
  }
}
