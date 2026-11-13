import { after, type NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import type { GitHubHostedDocsSourceRow } from '@bread/core'
import { requireRouteUser } from '@/lib/auth/route-auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import {
  normalizeHostedDocsPaths,
  syncGitHubHostedDocs,
} from '@/lib/github/github-hosted-docs'
import { resolveGitHubHostedDocsActivation } from '@/lib/github/github-hosted-docs-activation'
import {
  getInstallationToken,
  getRepository,
  getRepositoryBlob,
  getRepositoryCommit,
  getPullRequest,
  getRepositoryTree,
  listInstallationRepos,
} from '@/lib/github/github'
import { withGitHubRetry } from '@/lib/github/retry'
import { isHostedWorkspacePublishBranch } from '@/lib/github/github-hosted-workspace-publish'
import {
  buildBreadWorkspaceExport,
  linkBreadWorkspaceDocuments,
  MAX_HOSTED_WORKSPACE_BYTES,
  MAX_HOSTED_WORKSPACE_DOCUMENTS,
} from '@/lib/github/github-hosted-workspace'
import {
  assertBreadHostedDocsFiles,
  BreadDocsFormatError,
  BREAD_HOSTED_DOC_MAX_BYTES,
} from '@/lib/github/github-hosted-format'
import { safeJsonBody } from '@/lib/validation'
import { linkReadmeRepository } from '@/lib/github/readme/readme-link'
import {
  isReadmeFormatSource,
  reconcileReadmePublishPullRequest,
  syncReadmeSource,
} from '@/lib/github/readme/readme-service'

export const runtime = 'nodejs'
// Hosted-docs syncs run after the response via `after()`, inside this
// function's lifetime. 300s is the Vercel Hobby ceiling (Pro allows up to 800);
// raise it on Pro if large repositories time out.
export const maxDuration = 300

const putBodySchema = z.object({
  repo_id: z.number().int().positive(),
  // Empty means the repository root, which only the readme format accepts.
  root_path: z.string().trim().max(1024),
  mode: z.enum(['merge', 'github_wins']),
  // 'readme' links a repository in the layout ReadMe's GitHub integration
  // uses. The remaining fields apply to that format only.
  format: z.enum(['bread', 'readme']).optional(),
  publish_mode: z.enum(['direct', 'pull_request']).optional(),
  branch: z.string().trim().max(255).nullish(),
})

const HOSTED_DOCS_STALE_SYNC_MS = 5 * 60 * 1000

async function requireMember(): Promise<{
  userId: string
  workspaceId: string
  role: string
} | null> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) return null
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) return null
  return {
    userId: user.id,
    workspaceId: workspace.workspace_id,
    role: workspace.role,
  }
}

async function requireAdmin(): Promise<{
  userId: string
  workspaceId: string
} | null> {
  const member = await requireMember()
  if (!member || (member.role !== 'admin' && member.role !== 'owner')) return null
  return { userId: member.userId, workspaceId: member.workspaceId }
}

function hostedTarget(source: GitHubHostedDocsSourceRow) {
  return {
    source,
    sourceId: source.id,
    workspaceId: source.workspace_id,
    installationId: source.installation_id,
    repoId: source.repo_id,
    repoFullName: source.repo_full_name,
    paths: source.paths,
    rootFolderId: source.root_folder_id,
    documentCount: source.document_count,
    lastSyncCommitSha: source.last_sync_commit_sha,
    mode: source.pending_sync_mode,
  }
}

type HostedDocsTarget = Parameters<typeof syncGitHubHostedDocs>[0] & {
  source: GitHubHostedDocsSourceRow
}

async function dispatchHostedDocsSync(
  target: HostedDocsTarget,
  _origin: string,
): Promise<void> {
  // Vercel: run inline under `after()` (see maxDuration above). The Netlify
  // background-function dispatch this used to have was removed.
  const { source, ...breadTarget } = target
  if (isReadmeFormatSource(source)) {
    await syncReadmeSource(source, {
      ref: target.ref,
      force: target.force,
      mode: target.mode,
    })
    return
  }
  await syncGitHubHostedDocs(breadTarget)
}

function scheduleHostedDocsSync(
  target: HostedDocsTarget,
  origin: string,
  failureLabel: string,
): void {
  after(async () => {
    try {
      await dispatchHostedDocsSync(target, origin)
    } catch (syncError) {
      console.error(`[Bread] ${failureLabel}:`, syncError)
    }
  })
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++
      output[index] = await fn(values[index]!)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  )
  return output
}

async function reconcileWaitingPullRequest(
  admin: ReturnType<typeof createAdminClient>,
  source: GitHubHostedDocsSourceRow,
  origin: string,
): Promise<GitHubHostedDocsSourceRow> {
  if (source.sync_status !== 'disabled') return source
  try {
    const activation = await resolveGitHubHostedDocsActivation(source)
    if (activation.state === 'waiting') return source

    if (activation.state === 'closed') {
      const lastSyncError =
        `Pull request #${activation.pullRequestNumber} was closed without merging. ` +
        'Disable this link to choose or create a root again.'
      const { data, error } = await admin
        .from('github_hosted_docs_sources')
        .update({
          sync_status: 'error',
          last_sync_error: lastSyncError,
          pending_pull_request_number: activation.pullRequestNumber,
          pending_pull_request_url: activation.pullRequestUrl,
        })
        .eq('id', source.id)
        .eq('workspace_id', source.workspace_id)
        .eq('sync_status', 'disabled')
        .select('*')
        .maybeSingle()
      if (error) throw error
      if (!data) return source
      return data as GitHubHostedDocsSourceRow
    }

    const { data, error } = await admin
      .from('github_hosted_docs_sources')
      .update({
        sync_status: 'pending',
        last_sync_error: null,
        pending_pull_request_number: activation.pullRequestNumber,
        pending_pull_request_url: activation.pullRequestUrl,
      })
      .eq('id', source.id)
      .eq('workspace_id', source.workspace_id)
      .eq('sync_status', 'disabled')
      .select('*')
      .maybeSingle()
    if (error) throw error
    if (!data) return { ...source, sync_status: 'pending' }
    const pendingSource = data as GitHubHostedDocsSourceRow
    scheduleHostedDocsSync(
      {
        ...hostedTarget(pendingSource),
        ref: activation.ref ?? undefined,
        force: true,
      },
      origin,
      'merged hosted docs PR sync failed',
    )
    return pendingSource
  } catch (error) {
    // Keep the settings endpoint available when GitHub is temporarily down.
    // The waiting-state poll will retry this reconciliation on its next pass.
    console.error('[Bread] hosted docs PR reconciliation failed:', error)
    return source
  }
}

async function resumeStalledHostedDocsSync(
  admin: ReturnType<typeof createAdminClient>,
  source: GitHubHostedDocsSourceRow,
  origin: string,
): Promise<GitHubHostedDocsSourceRow> {
  if (source.sync_status !== 'pending' && source.sync_status !== 'syncing') {
    return source
  }
  const lastHeartbeat = new Date(source.updated_at).getTime()
  if (
    !Number.isFinite(lastHeartbeat) ||
    Date.now() - lastHeartbeat < HOSTED_DOCS_STALE_SYNC_MS
  ) {
    return source
  }

  try {
    // Compare both state and heartbeat so simultaneous editor/settings polls
    // cannot schedule duplicate recovery runs.
    const { data, error } = await admin
      .from('github_hosted_docs_sources')
      .update({
        sync_status: 'pending',
        last_sync_error: null,
      })
      .eq('id', source.id)
      .eq('workspace_id', source.workspace_id)
      .eq('sync_status', source.sync_status)
      .eq('updated_at', source.updated_at)
      .select('*')
      .maybeSingle()
    if (error) throw error
    if (!data) return source

    const pendingSource = data as GitHubHostedDocsSourceRow
    scheduleHostedDocsSync(
      hostedTarget(pendingSource),
      origin,
      'stalled hosted docs recovery failed',
    )
    return pendingSource
  } catch (error) {
    console.error('[Bread] stalled hosted docs recovery could not start:', error)
    return source
  }
}

/**
 * Verify the repository head before an editor is allowed to mount. When the
 * default branch moved, reserve the shared source row immediately and start
 * only the hosted-docs reconciliation. The old publish-status path merely
 * reported `sync_required` and then waited for the much broader GitHub sweep.
 */
async function reconcileLatestDefaultBranchCommit(
  admin: ReturnType<typeof createAdminClient>,
  source: GitHubHostedDocsSourceRow,
  origin: string,
): Promise<GitHubHostedDocsSourceRow> {
  if (source.sync_status !== 'synced') return source

  try {
    const token = await withGitHubRetry(() =>
      getInstallationToken(source.installation_id),
    )
    const repository = await withGitHubRetry(() =>
      getRepository(token, source.repo_full_name),
    )
    if (repository.id !== source.repo_id) {
      throw new Error('The configured GitHub repository no longer matches this source.')
    }
    const commit = await withGitHubRetry(() =>
      getRepositoryCommit(
        token,
        source.repo_full_name,
        source.branch ?? repository.default_branch,
      ),
    )
    if (source.last_sync_commit_sha === commit.sha) return source

    let reservation = admin
      .from('github_hosted_docs_sources')
      .update({
        sync_status: 'pending',
        last_sync_error: null,
      })
      .eq('id', source.id)
      .eq('workspace_id', source.workspace_id)
      .eq('sync_status', 'synced')
    reservation = source.last_sync_commit_sha
      ? reservation.eq('last_sync_commit_sha', source.last_sync_commit_sha)
      : reservation.is('last_sync_commit_sha', null)
    const { data, error } = await reservation.select('*').maybeSingle()
    if (error) throw error

    // A concurrent request may have acquired the reservation first. Return a
    // pending view either way so this response never remounts an editor while
    // the winning request reconciles the shared document tree.
    const pendingSource = (data as GitHubHostedDocsSourceRow | null) ?? {
      ...source,
      sync_status: 'pending',
      last_sync_error: null,
    }
    if (data) {
      scheduleHostedDocsSync(
        {
          ...hostedTarget(pendingSource),
          ref: commit.sha,
        },
        origin,
        'latest hosted docs sync failed',
      )
    }
    return pendingSource
  } catch (error) {
    // A transient provider failure must not strand the workspace in a false
    // lock. The publish-status control will surface its own retry state.
    console.error('[Bread] hosted docs head check failed:', error)
    return source
  }
}

async function reconcileWorkspacePublishPullRequest(
  admin: ReturnType<typeof createAdminClient>,
  source: GitHubHostedDocsSourceRow,
): Promise<GitHubHostedDocsSourceRow> {
  const targetPath = source.paths[0]
  if (
    source.sync_status === 'disabled' ||
    !targetPath ||
    !source.publish_pull_request_number ||
    !isHostedWorkspacePublishBranch(
      source.publish_pull_request_head,
      targetPath,
    )
  ) {
    return source
  }

  try {
    const token = await withGitHubRetry(() =>
      getInstallationToken(source.installation_id),
    )
    const pullRequest = await withGitHubRetry(() =>
      getPullRequest(
        token,
        source.repo_full_name,
        source.publish_pull_request_number!,
      ),
    )
    if (pullRequest.state === 'open') return source
    if (pullRequest.merged || pullRequest.merged_at) {
      const mergedAt = pullRequest.merged_at
        ? Date.parse(pullRequest.merged_at)
        : Number.NaN
      const syncedAt = source.last_sync_at
        ? Date.parse(source.last_sync_at)
        : Number.NaN
      if (
        source.sync_status !== 'synced' ||
        Number.isNaN(syncedAt) ||
        (!Number.isNaN(mergedAt) && syncedAt < mergedAt)
      ) {
        return source
      }
    }

    const { data, error } = await admin
      .from('github_hosted_docs_sources')
      .update({
        publish_pull_request_number: null,
        publish_pull_request_url: null,
        publish_pull_request_head: null,
        publish_last_commit_sha: null,
      })
      .eq('id', source.id)
      .eq('workspace_id', source.workspace_id)
      .eq('publish_pull_request_number', pullRequest.number)
      .select('*')
      .maybeSingle()
    if (error) throw error
    return (data as GitHubHostedDocsSourceRow | null) ?? source
  } catch (error) {
    // Preserve the last-known PR pointer during transient GitHub failures. A
    // later settings poll can safely reconcile it again.
    console.error('[Bread] workspace publish PR reconciliation failed:', error)
    return source
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireMember()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  try {
    const { data, error } = await admin
      .from('github_hosted_docs_sources')
      .select('*')
      .eq('workspace_id', auth.workspaceId)
      .maybeSingle()
    if (error) throw error
    let source = (data as GitHubHostedDocsSourceRow | null) ?? null
    if (!source || source.paths.length === 0) {
      return NextResponse.json({
        source: null,
        linked_folder: null,
        linked_path_count: 0,
        linked_document_count: 0,
      })
    }
    const origin = request.nextUrl.origin
    source = await reconcileWaitingPullRequest(admin, source, origin)
    source = await resumeStalledHostedDocsSync(admin, source, origin)
    source = await reconcileWorkspacePublishPullRequest(admin, source)
    if (isReadmeFormatSource(source)) {
      source = await reconcileReadmePublishPullRequest(source, admin)
    }

    // Every editor and settings poll only needs the persisted source state.
    // Verify the provider head on this lightweight path so a newer GitHub
    // commit acquires the shared editor lock and starts reconciliation without
    // waiting for repository indexing or the scheduled sweep.
    if (request.nextUrl.searchParams.get('summary') === '1') {
      source = await reconcileLatestDefaultBranchCommit(admin, source, origin)
      return NextResponse.json({
        source,
        linked_folder: null,
        linked_path_count: source.document_count,
        linked_document_count: source.document_count,
      })
    }

    const [folderResult, documentsResult] = await Promise.all([
      source.root_folder_id
        ? admin
            .from('folders')
            .select('id, display_name, visibility, required_role')
            .eq('id', source.root_folder_id)
            .eq('workspace_id', auth.workspaceId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      admin
        .from('documents')
        .select('id, source_metadata')
        .eq('workspace_id', auth.workspaceId)
        .contains('source_metadata', { repo_id: source.repo_id })
        .is('deleted_at', null),
    ])
    if (folderResult.error) throw folderResult.error
    if (documentsResult.error) throw documentsResult.error

    const linkedDocuments = (documentsResult.data ?? []).filter((document) => {
      const metadata = document.source_metadata as Record<string, unknown> | null
      const path = typeof metadata?.canonical_repo_path === 'string'
        ? metadata.canonical_repo_path
        : null
      return Boolean(
        path && source.paths.some(
          (root) => path === root || path.startsWith(`${root}/`),
        ),
      )
    })
    const linkedPaths = new Set(
      linkedDocuments.map((document) =>
        (document.source_metadata as Record<string, unknown>).canonical_repo_path,
      ),
    )
    return NextResponse.json({
      source,
      linked_folder: folderResult.data ?? null,
      linked_path_count: linkedPaths.size,
      linked_document_count: linkedDocuments.length,
    })
  } catch (err) {
    console.error('[Bread] GET /api/github/hosted-docs failed:', err)
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isWorkspaceOnPaidTier(auth.workspaceId))) {
    return NextResponse.json({ error: 'Integrations require a paid plan.' }, { status: 402 })
  }
  const parsed = await safeJsonBody(request, putBodySchema)
  if (!parsed.ok) return parsed.response
  const readmeFormat = parsed.data.format === 'readme'
  const paths = readmeFormat ? [] : normalizeHostedDocsPaths([parsed.data.root_path])
  if (!readmeFormat && paths.length !== 1) {
    return NextResponse.json({ error: 'Choose one repository root folder.' }, { status: 400 })
  }

  const admin = createAdminClient()
  let configurationOperationId: string | null = null
  let configurationSourceId: string | null = null
  try {
    const { data: integration, error: integrationError } = await admin
      .from('github_integrations')
      .select('installation_id')
      .eq('workspace_id', auth.workspaceId)
      .maybeSingle()
    if (integrationError) throw integrationError
    if (!integration) {
      return NextResponse.json({ error: 'Connect GitHub before linking docs.' }, { status: 409 })
    }
    const installationId = Number(integration.installation_id)
    const availableRepos = await withGitHubRetry(() =>
      listInstallationRepos(installationId),
    )
    const availableRepo = availableRepos.find((repo) => repo.id === parsed.data.repo_id)
    if (!availableRepo) {
      return NextResponse.json(
        { error: 'This GitHub App installation cannot access that repository.' },
        { status: 404 },
      )
    }

    const { data: existingData, error: existingError } = await admin
      .from('github_hosted_docs_sources')
      .select('*')
      .eq('workspace_id', auth.workspaceId)
      .maybeSingle()
    if (existingError) throw existingError
    let existing = existingData as GitHubHostedDocsSourceRow | null
    if (existing) {
      configurationOperationId = randomUUID()
      const { data: leaseRows, error: leaseError } = await admin.rpc(
        'acquire_github_hosted_docs_publish_lease',
        {
          p_source_id: existing.id,
          p_workspace_id: auth.workspaceId,
          p_operation_id: configurationOperationId,
        },
      )
      if (leaseError) throw leaseError
      const leasedSource = (
        Array.isArray(leaseRows) ? leaseRows[0] : leaseRows
      ) as GitHubHostedDocsSourceRow | null
      if (!leasedSource) {
        configurationOperationId = null
        return NextResponse.json(
          {
            error: 'Another workspace publish or GitHub configuration change is in progress.',
            code: 'hosted_docs_operation_in_progress',
          },
          { status: 409 },
        )
      }
      configurationSourceId = leasedSource.id
      existing = leasedSource
      if (
        existing.publish_pull_request_number !== null ||
        existing.publish_pull_request_head !== null
      ) {
        return NextResponse.json(
          {
            error:
              'Finish or close the current workspace publish pull request before changing the GitHub docs root.',
            code: 'workspace_publish_pull_request_open',
            pull_request_number: existing.publish_pull_request_number,
            pull_request_url: existing.publish_pull_request_url,
          },
          { status: 409 },
        )
      }
    }
    if (readmeFormat) {
      const linked = await linkReadmeRepository(admin, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        installationId,
        repository: { id: availableRepo.id, full_name: availableRepo.full_name },
        rootPath: parsed.data.root_path,
        branch: parsed.data.branch ?? null,
        // Direct commits are what ReadMe's own integration does.
        publishMode: parsed.data.publish_mode ?? 'direct',
        mode: parsed.data.mode,
        existing,
        leaseOperationId: configurationOperationId,
      })
      if (!linked.ok) {
        return NextResponse.json(
          { error: linked.error, code: linked.code },
          { status: linked.status },
        )
      }
      // The link update cleared the lease along with the other publish state.
      configurationOperationId = null
      scheduleHostedDocsSync(
        { ...hostedTarget(linked.source), ref: linked.commitSha, force: true },
        request.nextUrl.origin,
        'initial readme-format sync failed',
      )
      return NextResponse.json({ source: linked.source })
    }

    const sameRoot =
      existing?.format !== 'readme' &&
      existing?.repo_id === availableRepo.id &&
      existing.paths[0] === paths[0]
    // A new root links the whole workspace to repository paths. "Use GitHub"
    // does so again even for the same root, so every Bread document is
    // accounted for before the sync makes GitHub the source of truth: matches
    // take GitHub's content and placement, and the rest are removed.
    const relinkWorkspace = !sameRoot || parsed.data.mode === 'github_wins'

    const token = await withGitHubRetry(() => getInstallationToken(installationId))
    const metadata = await withGitHubRetry(() =>
      getRepository(token, availableRepo.full_name),
    )
    const commit = await withGitHubRetry(() =>
      getRepositoryCommit(token, availableRepo.full_name, metadata.default_branch),
    )
    const tree = await withGitHubRetry(() =>
      getRepositoryTree(token, availableRepo.full_name, commit.commit.tree.sha),
    )
    const folders = new Set(
      tree.tree.filter((entry) => entry.type === 'tree').map((entry) => entry.path),
    )
    const missing = paths.filter((path) => !folders.has(path))
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Folder no longer exists on ${metadata.default_branch}: ${missing[0]}` },
        { status: 409 },
      )
    }

    const documentEntries = tree.tree.filter(
      (entry) =>
        entry.type === 'blob' &&
        entry.path.startsWith(`${paths[0]}/`) &&
        /\.(?:md|mdx)$/i.test(entry.path),
    )
    if (documentEntries.length > MAX_HOSTED_WORKSPACE_DOCUMENTS) {
      return NextResponse.json(
        { error: `This root supports at most ${MAX_HOSTED_WORKSPACE_DOCUMENTS} Bread documents.` },
        { status: 413 },
      )
    }
    const oversized = documentEntries.find(
      (entry) => (entry.size ?? 0) > BREAD_HOSTED_DOC_MAX_BYTES,
    )
    if (oversized) {
      return NextResponse.json(
        { error: `${oversized.path} exceeds the ${BREAD_HOSTED_DOC_MAX_BYTES}-byte Bread document limit.` },
        { status: 422 },
      )
    }
    const repositoryFiles = await mapWithConcurrency(
      documentEntries,
      6,
      async (entry) => {
        const blob = await withGitHubRetry(() =>
          getRepositoryBlob(token, availableRepo.full_name, entry.sha),
        )
        return {
          path: entry.path,
          content:
            blob.encoding === 'base64'
              ? Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8')
              : '\u0000',
        }
      },
    )
    try {
      assertBreadHostedDocsFiles(repositoryFiles)
    } catch (error) {
      if (!(error instanceof BreadDocsFormatError)) throw error
      return NextResponse.json(
        {
          error:
            'The selected folder does not follow the Bread document format. ' +
            error.issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join('; '),
          format_errors: error.issues,
        },
        { status: 422 },
      )
    }

    if (relinkWorkspace) {
      const exported = await buildBreadWorkspaceExport(admin, {
        workspaceId: auth.workspaceId,
        targetPath: paths[0]!,
      })
      if (exported.restrictedFolderNames.length > 0) {
        return NextResponse.json(
          {
            error:
              'Restricted Bread folders cannot be linked to a GitHub repository. ' +
              'Keep those documents Bread-only before configuring this root.',
            restricted_folders: exported.restrictedFolderNames,
          },
          { status: 409 },
        )
      }
      if (exported.documents.length > MAX_HOSTED_WORKSPACE_DOCUMENTS) {
        return NextResponse.json(
          { error: `This root supports at most ${MAX_HOSTED_WORKSPACE_DOCUMENTS} Bread documents.` },
          { status: 413 },
        )
      }
      if (exported.totalBytes > MAX_HOSTED_WORKSPACE_BYTES) {
        return NextResponse.json(
          { error: 'The Bread workspace is too large to link to one GitHub root.' },
          { status: 413 },
        )
      }
      await linkBreadWorkspaceDocuments(admin, {
        workspaceId: auth.workspaceId,
        repoId: availableRepo.id,
        repoFullName: availableRepo.full_name,
        ref: metadata.default_branch,
        commitSha: commit.sha,
        exported,
      })
    }

    const sourceValues = {
      workspace_id: auth.workspaceId,
      installation_id: installationId,
      repo_full_name: availableRepo.full_name,
      repo_id: availableRepo.id,
      paths,
      // The repository root is the workspace root; no container folder.
      root_folder_id: null,
      // Switching back from the readme format resets its settings.
      format: 'bread',
      publish_mode: 'pull_request',
      branch: null,
      sync_state: {},
      sync_status: 'pending',
      conflict_count: 0,
      last_sync_error: null,
      pending_pull_request_number: null,
      pending_pull_request_url: null,
      pending_pull_request_head: null,
      pending_sync_mode: parsed.data.mode === 'github_wins' ? 'replace_bread' : 'merge',
      publish_pull_request_number: null,
      publish_pull_request_url: null,
      publish_pull_request_head: null,
      publish_last_commit_sha: null,
      publish_operation_id: null,
      publish_operation_started_at: null,
      created_by: existing?.created_by ?? auth.userId,
    }
    const sourceResult = existing
      ? await admin
          .from('github_hosted_docs_sources')
          .update(sourceValues)
          .eq('id', existing.id)
          .eq('workspace_id', auth.workspaceId)
          .eq('publish_operation_id', configurationOperationId!)
          .select('*')
          .single()
      : await admin
          .from('github_hosted_docs_sources')
          .insert(sourceValues)
          .select('*')
          .single()
    if (sourceResult.error || !sourceResult.data) {
      throw sourceResult.error ?? new Error('No row returned')
    }
    const updated = sourceResult.data as GitHubHostedDocsSourceRow

    scheduleHostedDocsSync(
      {
        ...hostedTarget(updated),
        ref: commit.sha,
        force: true,
      },
      request.nextUrl.origin,
      'initial hosted docs sync failed',
    )

    return NextResponse.json({ source: updated })
  } catch (err) {
    console.error('[Bread] PUT /api/github/hosted-docs failed:', err)
    return NextResponse.json(
      {
        error:
          'Could not link the docs root. Confirm that the GitHub App can read repository contents, then try again.',
      },
      { status: 500 },
    )
  } finally {
    if (configurationOperationId && configurationSourceId) {
      const { error: releaseError } = await admin
        .from('github_hosted_docs_sources')
        .update({
          publish_operation_id: null,
          publish_operation_started_at: null,
        })
        .eq('id', configurationSourceId)
        .eq('workspace_id', auth.workspaceId)
        .eq('publish_operation_id', configurationOperationId)
      if (releaseError) {
        console.error('[Bread] hosted docs configuration lease release failed:', releaseError)
      }
    }
  }
}

export async function DELETE(_request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  try {
    const { error } = await admin
      .from('github_hosted_docs_sources')
      .delete()
      .eq('workspace_id', auth.workspaceId)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[Bread] DELETE /api/github/hosted-docs failed:', err)
    return NextResponse.json({ error: 'Could not disable the hosted docs link.' }, { status: 500 })
  }
}
