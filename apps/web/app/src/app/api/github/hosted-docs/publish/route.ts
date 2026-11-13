import { type NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import type { GitHubHostedDocsSourceRow } from '@bread/core'
import { z } from 'zod'
import { requireRouteUser } from '@/lib/auth/route-auth'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import {
  assertBreadHostedDocsFiles,
  BreadDocsFormatError,
  BREAD_HOSTED_DOC_MAX_BYTES,
} from '@/lib/github/github-hosted-format'
import {
  buildBreadWorkspaceExport,
  MAX_HOSTED_WORKSPACE_BYTES,
  MAX_HOSTED_WORKSPACE_DOCUMENTS,
} from '@/lib/github/github-hosted-workspace'
import {
  createHostedWorkspacePublishBranch,
  HostedWorkspacePublishError,
  inspectHostedWorkspacePublish,
  isHostedWorkspacePublishBranch,
  publishHostedWorkspaceToGitHub,
} from '@/lib/github/github-hosted-workspace-publish'
import { listInstallationRepos } from '@/lib/github/github'
import { ReadmePublishError } from '@/lib/github/readme/readme-publish'
import {
  inspectReadmeSourcePublish,
  isReadmeFormatSource,
  publishReadmeSource,
} from '@/lib/github/readme/readme-service'
import { withGitHubRetry } from '@/lib/github/retry'

export const runtime = 'nodejs'

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie',
}
const PUBLISH_LEASE_DURATION_MS = 10 * 60 * 1000

interface PublishStatusPayload {
  status:
    | 'up_to_date'
    | 'changes'
    | 'sync_required'
    | 'blocked'
    | 'unavailable'
  changed_file_count: number
  written_file_count: number
  deleted_file_count: number
  unchanged_file_count: number
  compared_commit_sha: string | null
  comparison_key: string | null
  pull_request_up_to_date?: boolean
  code?: string
  message?: string
}

function privateJson(
  body: Record<string, unknown> | PublishStatusPayload,
  status = 200,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  })
}

function emptyPublishStatus(
  status: PublishStatusPayload['status'],
  code: string,
  message: string,
): PublishStatusPayload {
  return {
    status,
    changed_file_count: 0,
    written_file_count: 0,
    deleted_file_count: 0,
    unchanged_file_count: 0,
    compared_commit_sha: null,
    comparison_key: null,
    code,
    message,
  }
}

function hasActivePublishLease(source: GitHubHostedDocsSourceRow): boolean {
  if (!source.publish_operation_id || !source.publish_operation_started_at) {
    return false
  }
  const startedAt = Date.parse(source.publish_operation_started_at)
  return (
    Number.isFinite(startedAt) &&
    startedAt >= Date.now() - PUBLISH_LEASE_DURATION_MS
  )
}

const bodySchema = z
  .object({
    conflict_resolution: z.literal('bread').optional(),
    paths: z
      .array(z.string().trim().min(1).max(1024))
      .min(1)
      .max(60)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.paths && new Set(value.paths).size !== value.paths.length) {
      context.addIssue({
        code: 'custom',
        path: ['paths'],
        message: 'Selected paths must be unique.',
      })
    }
  })

async function parseBody(request: NextRequest): Promise<
  | { ok: true; data: z.infer<typeof bodySchema> }
  | { ok: false; response: NextResponse }
> {
  const text = await request.text()
  let raw: unknown = {}
  if (text.trim()) {
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      return {
        ok: false,
        response: NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }),
      }
    }
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Invalid request body', issues: parsed.error.flatten() },
        { status: 400 },
      ),
    }
  }
  return { ok: true, data: parsed.data }
}

/** Read-only equality check against the tree a publish would update. */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) {
    return privateJson(
      { error: 'Sign in to inspect workspace publishing.', code: 'unauthenticated' },
      401,
    )
  }
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return privateJson(
      { error: 'Choose a workspace before inspecting publishing.', code: 'workspace_required' },
      403,
    )
  }
  if (!['owner', 'admin', 'editor'].includes(workspace.role)) {
    return privateJson(
      {
        error: 'Only workspace owners, admins, and editors can inspect publishing.',
        code: 'insufficient_role',
      },
      403,
    )
  }
  if (!(await isWorkspaceOnPaidTier(workspace.workspace_id))) {
    return privateJson(
      { error: 'GitHub publishing requires a paid plan.', code: 'paid_plan_required' },
      402,
    )
  }

  const admin = createAdminClient()
  try {
    const { data, error } = await admin
      .from('github_hosted_docs_sources')
      .select('*')
      .eq('workspace_id', workspace.workspace_id)
      .maybeSingle()
    if (error) throw error
    const source = data as GitHubHostedDocsSourceRow | null
    if (!source || source.paths.length !== 1) {
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'hosted_docs_not_configured',
          'Configure one linked GitHub-hosted docs folder before publishing.',
        ),
      )
    }
    if (source.sync_status === 'disabled') {
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'activation_pending',
          'Merge the GitHub activation pull request before publishing workspace changes.',
        ),
      )
    }
    if (source.sync_status === 'error') {
      return privateJson(
        emptyPublishStatus(
          'unavailable',
          'hosted_docs_sync_error',
          source.last_sync_error ??
            'Resolve the GitHub-hosted docs sync error before publishing.',
        ),
      )
    }
    if (source.sync_status !== 'synced') {
      return privateJson(
        emptyPublishStatus(
          'sync_required',
          'hosted_docs_not_synced',
          'Wait for the GitHub-hosted docs root to finish syncing successfully.',
        ),
      )
    }
    if (hasActivePublishLease(source)) {
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'publish_in_progress',
          'Another workspace publish is already in progress.',
        ),
      )
    }

    const { data: integration, error: integrationError } = await admin
      .from('github_integrations')
      .select('installation_id')
      .eq('workspace_id', workspace.workspace_id)
      .maybeSingle()
    if (integrationError) throw integrationError
    if (
      !integration ||
      Number(integration.installation_id) !== source.installation_id
    ) {
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'github_integration_mismatch',
          'Reconnect the workspace GitHub App before publishing.',
        ),
      )
    }

    if (isReadmeFormatSource(source)) {
      const inspected = await inspectReadmeSourcePublish(source, admin)
      return privateJson({
        status: inspected.status,
        changed_file_count: inspected.changedFileCount,
        written_file_count: inspected.writtenFileCount,
        deleted_file_count: inspected.deletedFileCount,
        unchanged_file_count: inspected.unchangedFileCount,
        compared_commit_sha: inspected.comparedCommitSha,
        comparison_key: inspected.comparisonKey,
        pull_request_up_to_date: inspected.pullRequestUpToDate,
        code: inspected.code,
        message: inspected.message,
      })
    }

    const targetPath = source.paths[0]!
    const exported = await buildBreadWorkspaceExport(admin, {
      workspaceId: workspace.workspace_id,
      targetPath,
      repoId: source.repo_id,
      hostedRootFolderId: source.root_folder_id,
    })
    if (exported.restrictedFolderNames.length > 0) {
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'restricted_folders',
          'Restricted folders cannot be published to the workspace GitHub docs root.',
        ),
      )
    }
    if (exported.documents.length > MAX_HOSTED_WORKSPACE_DOCUMENTS) {
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'too_many_documents',
          `A workspace publish supports at most ${MAX_HOSTED_WORKSPACE_DOCUMENTS} documents.`,
        ),
      )
    }
    if (exported.totalBytes > MAX_HOSTED_WORKSPACE_BYTES) {
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'workspace_too_large',
          'The workspace is too large to publish in one GitHub pull request.',
        ),
      )
    }
    const oversizedFile = exported.files.find(
      (file) =>
        /\.(?:md|mdx)$/i.test(file.path) &&
        Buffer.byteLength(file.content, 'utf8') > BREAD_HOSTED_DOC_MAX_BYTES,
    )
    if (oversizedFile) {
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'document_too_large',
          `${oversizedFile.path} exceeds the per-document GitHub sync limit.`,
        ),
      )
    }
    try {
      assertBreadHostedDocsFiles(exported.files)
    } catch (formatError) {
      if (!(formatError instanceof BreadDocsFormatError)) throw formatError
      return privateJson(
        emptyPublishStatus(
          'blocked',
          'invalid_workspace_export',
          'The workspace export does not follow the Bread GitHub docs format.',
        ),
      )
    }

    const inspected = await inspectHostedWorkspacePublish({
      source,
      files: exported.files,
      managedPaths: exported.managedPaths,
    })
    return privateJson({
      status: inspected.status,
      changed_file_count: inspected.changedFileCount,
      written_file_count: inspected.writtenFileCount,
      deleted_file_count: inspected.deletedFileCount,
      unchanged_file_count: inspected.unchangedFileCount,
      compared_commit_sha: inspected.comparedCommitSha,
      comparison_key: inspected.comparisonKey,
      pull_request_up_to_date: inspected.pullRequestUpToDate,
      code: inspected.code,
      message: inspected.message,
    })
  } catch (error) {
    console.error('[Bread] hosted workspace publish inspection failed:', error)
    return privateJson(
      emptyPublishStatus(
        'unavailable',
        'github_publish_status_unavailable',
        'Could not compare the Bread workspace with GitHub right now.',
      ),
    )
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to publish workspace changes.', code: 'unauthenticated' },
      { status: 401 },
    )
  }
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json(
      { error: 'Choose a workspace before publishing.', code: 'workspace_required' },
      { status: 403 },
    )
  }
  if (!['owner', 'admin', 'editor'].includes(workspace.role)) {
    return NextResponse.json(
      {
        error: 'Only workspace owners, admins, and editors can publish changes.',
        code: 'insufficient_role',
      },
      { status: 403 },
    )
  }
  if (!(await isWorkspaceOnPaidTier(workspace.workspace_id))) {
    return NextResponse.json(
      { error: 'GitHub publishing requires a paid plan.', code: 'paid_plan_required' },
      { status: 402 },
    )
  }
  const parsedBody = await parseBody(request)
  if (!parsedBody.ok) return parsedBody.response

  const admin = createAdminClient()
  let reservedHead: string | null = null
  let reservedSourceId: string | null = null
  let leaseOperationId: string | null = null
  let leaseSourceId: string | null = null
  try {
    const { data, error } = await admin
      .from('github_hosted_docs_sources')
      .select('*')
      .eq('workspace_id', workspace.workspace_id)
      .maybeSingle()
    if (error) throw error
    const source = data as GitHubHostedDocsSourceRow | null
    if (!source || source.paths.length !== 1) {
      return NextResponse.json(
        {
          error: 'Configure one linked GitHub-hosted docs folder before publishing.',
          code: 'hosted_docs_not_configured',
        },
        { status: 409 },
      )
    }
    if (source.sync_status === 'disabled') {
      return NextResponse.json(
        {
          error:
            'Merge the GitHub activation pull request before publishing workspace changes.',
          code: 'activation_pending',
          pull_request_number: source.pending_pull_request_number,
          pull_request_url: source.pending_pull_request_url,
        },
        { status: 409 },
      )
    }
    if (source.sync_status !== 'synced') {
      return NextResponse.json(
        {
          error: 'Wait for the GitHub-hosted docs root to finish syncing successfully.',
          code: 'hosted_docs_not_synced',
        },
        { status: 409 },
      )
    }
    if (
      source.conflict_count > 0 &&
      parsedBody.data.conflict_resolution !== 'bread'
    ) {
      return NextResponse.json(
        {
          error:
            'This workspace has GitHub conflicts. Confirm that Bread should win before publishing.',
          code: 'conflict_resolution_required',
          conflict_count: source.conflict_count,
        },
        { status: 409 },
      )
    }

    const { data: integration, error: integrationError } = await admin
      .from('github_integrations')
      .select('installation_id')
      .eq('workspace_id', workspace.workspace_id)
      .maybeSingle()
    if (integrationError) throw integrationError
    if (
      !integration ||
      Number(integration.installation_id) !== source.installation_id
    ) {
      return NextResponse.json(
        {
          error: 'Reconnect the workspace GitHub App before publishing.',
          code: 'github_integration_mismatch',
        },
        { status: 409 },
      )
    }
    const repositories = await withGitHubRetry(() =>
      listInstallationRepos(source.installation_id),
    )
    const verifiedRepository = repositories.find(
      (repository) =>
        repository.id === source.repo_id &&
        repository.full_name === source.repo_full_name,
    )
    if (!verifiedRepository) {
      return NextResponse.json(
        {
          error: 'The GitHub App can no longer access the configured repository.',
          code: 'github_repository_unavailable',
        },
        { status: 409 },
      )
    }

    if (isReadmeFormatSource(source)) {
      leaseOperationId = randomUUID()
      const { data: leaseRows, error: leaseError } = await admin.rpc(
        'acquire_github_hosted_docs_publish_lease',
        {
          p_source_id: source.id,
          p_workspace_id: workspace.workspace_id,
          p_operation_id: leaseOperationId,
        },
      )
      if (leaseError) throw leaseError
      const leased = (
        Array.isArray(leaseRows) ? leaseRows[0] : leaseRows
      ) as GitHubHostedDocsSourceRow | null
      if (!leased) {
        leaseOperationId = null
        return NextResponse.json(
          {
            error: 'Another workspace publish is already in progress.',
            code: 'publish_in_progress',
          },
          { status: 409 },
        )
      }
      leaseSourceId = leased.id
      if (leased.sync_status !== 'synced' || !isReadmeFormatSource(leased)) {
        return NextResponse.json(
          {
            error: 'The GitHub link changed while publishing started. Try again after sync.',
            code: 'hosted_docs_not_synced',
          },
          { status: 409 },
        )
      }
      const published = await publishReadmeSource(
        leased,
        {
          includeConflicts: parsedBody.data.conflict_resolution === 'bread',
          selectedPaths: parsedBody.data.paths,
        },
        admin,
      )
      const { data: refreshed } = await admin
        .from('github_hosted_docs_sources')
        .select('*')
        .eq('id', leased.id)
        .eq('workspace_id', workspace.workspace_id)
        .maybeSingle()
      return NextResponse.json(
        {
          source: {
            ...((refreshed as GitHubHostedDocsSourceRow | null) ?? leased),
            publish_operation_id: null,
            publish_operation_started_at: null,
          },
          publish_mode: published.mode,
          pull_request_number: published.pullRequestNumber,
          pull_request_url: published.pullRequestUrl,
          branch: published.branch,
          head: published.branch,
          commit_sha: published.commitSha,
          commit_url: published.commitUrl,
          file_count: published.changedFileCount,
          changed_file_count: published.changedFileCount,
          written_file_count: published.writtenFileCount,
          deleted_file_count: published.deletedFileCount,
          reused: false,
        },
        { status: 201 },
      )
    }

    const targetPath = source.paths[0]!
    const exported = await buildBreadWorkspaceExport(admin, {
      workspaceId: workspace.workspace_id,
      targetPath,
      repoId: source.repo_id,
      hostedRootFolderId: source.root_folder_id,
    })
    if (exported.restrictedFolderNames.length > 0) {
      return NextResponse.json(
        {
          error:
            'Restricted folders cannot be published to the workspace GitHub docs root.',
          code: 'restricted_folders',
          restricted_folders: exported.restrictedFolderNames,
        },
        { status: 409 },
      )
    }
    if (exported.documents.length > MAX_HOSTED_WORKSPACE_DOCUMENTS) {
      return NextResponse.json(
        {
          error: `A workspace publish supports at most ${MAX_HOSTED_WORKSPACE_DOCUMENTS} documents.`,
          code: 'too_many_documents',
          document_count: exported.documents.length,
          maximum_document_count: MAX_HOSTED_WORKSPACE_DOCUMENTS,
        },
        { status: 413 },
      )
    }
    if (exported.totalBytes > MAX_HOSTED_WORKSPACE_BYTES) {
      return NextResponse.json(
        {
          error: 'The workspace is too large to publish in one GitHub pull request.',
          code: 'workspace_too_large',
          total_bytes: exported.totalBytes,
          maximum_bytes: MAX_HOSTED_WORKSPACE_BYTES,
        },
        { status: 413 },
      )
    }
    const oversizedFile = exported.files.find(
      (file) =>
        /\.(?:md|mdx)$/i.test(file.path) &&
        Buffer.byteLength(file.content, 'utf8') > BREAD_HOSTED_DOC_MAX_BYTES,
    )
    if (oversizedFile) {
      return NextResponse.json(
        {
          error: `${oversizedFile.path} exceeds the per-document GitHub sync limit.`,
          code: 'document_too_large',
          path: oversizedFile.path,
          maximum_bytes: BREAD_HOSTED_DOC_MAX_BYTES,
        },
        { status: 413 },
      )
    }
    try {
      assertBreadHostedDocsFiles(exported.files)
    } catch (formatError) {
      if (!(formatError instanceof BreadDocsFormatError)) throw formatError
      return NextResponse.json(
        {
          error: 'The workspace export does not follow the Bread GitHub docs format.',
          code: 'invalid_workspace_export',
          format_errors: formatError.issues,
        },
        { status: 422 },
      )
    }

    leaseOperationId = randomUUID()
    const { data: leaseRows, error: leaseError } = await admin.rpc(
      'acquire_github_hosted_docs_publish_lease',
      {
        p_source_id: source.id,
        p_workspace_id: workspace.workspace_id,
        p_operation_id: leaseOperationId,
      },
    )
    if (leaseError) throw leaseError
    const leasedSource = (
      Array.isArray(leaseRows) ? leaseRows[0] : leaseRows
    ) as GitHubHostedDocsSourceRow | null
    if (!leasedSource) {
      leaseOperationId = null
      return NextResponse.json(
        {
          error: 'Another workspace publish is already in progress.',
          code: 'publish_in_progress',
        },
        { status: 409 },
      )
    }
    leaseSourceId = leasedSource.id
    const sourceConfigurationChanged =
      leasedSource.installation_id !== source.installation_id ||
      leasedSource.repo_id !== source.repo_id ||
      leasedSource.repo_full_name !== source.repo_full_name ||
      leasedSource.root_folder_id !== source.root_folder_id ||
      leasedSource.last_sync_commit_sha !== source.last_sync_commit_sha ||
      leasedSource.paths.length !== source.paths.length ||
      leasedSource.paths.some((path, index) => path !== source.paths[index])
    if (sourceConfigurationChanged) {
      return NextResponse.json(
        {
          error: 'The GitHub-hosted docs configuration changed while publishing started. Try again.',
          code: 'hosted_docs_configuration_changed',
        },
        { status: 409 },
      )
    }
    if (leasedSource.sync_status !== 'synced') {
      return NextResponse.json(
        {
          error: 'The GitHub-hosted docs root changed while publishing started. Try again after sync.',
          code: 'hosted_docs_not_synced',
        },
        { status: 409 },
      )
    }
    if (
      leasedSource.conflict_count > 0 &&
      parsedBody.data.conflict_resolution !== 'bread'
    ) {
      return NextResponse.json(
        {
          error: 'GitHub conflicts appeared while publishing started. Confirm that Bread should win.',
          code: 'conflict_resolution_required',
          conflict_count: leasedSource.conflict_count,
        },
        { status: 409 },
      )
    }

    let publishSource = leasedSource
    if (!leasedSource.publish_pull_request_head) {
      const candidateHead = createHostedWorkspacePublishBranch(targetPath)
      const { data: reservedData, error: reservationError } = await admin
        .from('github_hosted_docs_sources')
        .update({
          publish_pull_request_head: candidateHead,
          publish_pull_request_number: null,
          publish_pull_request_url: null,
          publish_last_commit_sha: null,
        })
        .eq('id', leasedSource.id)
        .eq('workspace_id', workspace.workspace_id)
        .eq('publish_operation_id', leaseOperationId)
        .is('publish_pull_request_head', null)
        .select('*')
        .maybeSingle()
      if (reservationError) throw reservationError
      if (!reservedData) {
        return NextResponse.json(
          {
            error: 'Another workspace publish is already starting. Try again in a moment.',
            code: 'publish_in_progress',
          },
          { status: 409 },
        )
      }
      publishSource = reservedData as GitHubHostedDocsSourceRow
    } else if (
      !isHostedWorkspacePublishBranch(
        leasedSource.publish_pull_request_head,
        targetPath,
      )
    ) {
      return NextResponse.json(
        {
          error: 'The saved workspace publish branch is invalid.',
          code: 'invalid_publish_state',
        },
        { status: 409 },
      )
    }
    reservedHead = publishSource.publish_pull_request_head
    reservedSourceId = publishSource.id

    const published = await publishHostedWorkspaceToGitHub({
      source: publishSource,
      files: exported.files,
      managedPaths: exported.managedPaths,
      selectedPaths: parsedBody.data.paths,
    })
    const { data: updatedData, error: updateError } = await admin
      .from('github_hosted_docs_sources')
      .update({
        publish_pull_request_number: published.pullRequestNumber,
        publish_pull_request_url: published.pullRequestUrl,
        publish_pull_request_head: published.branch,
        publish_last_commit_sha: published.commitSha,
      })
      .eq('id', publishSource.id)
      .eq('workspace_id', workspace.workspace_id)
      .eq('publish_operation_id', leaseOperationId)
      .eq('publish_pull_request_head', publishSource.publish_pull_request_head!)
      .select('*')
      .maybeSingle()
    if (updateError || !updatedData) {
      // The PR is live and the reserved head makes a retry recoverable. Do not
      // turn a successful provider write into a user-visible failure.
      console.error(
        '[Bread] workspace publish pointer persistence failed:',
        updateError ?? new Error('No hosted docs source returned after publish'),
      )
    }
    const responseSource =
      (updatedData as GitHubHostedDocsSourceRow | null) ?? {
        ...publishSource,
        publish_pull_request_number: published.pullRequestNumber,
        publish_pull_request_url: published.pullRequestUrl,
        publish_pull_request_head: published.branch,
        publish_last_commit_sha: published.commitSha,
      }

    return NextResponse.json(
      {
        source: {
          ...responseSource,
          publish_operation_id: null,
          publish_operation_started_at: null,
        },
        pull_request_number: published.pullRequestNumber,
        pull_request_url: published.pullRequestUrl,
        branch: published.branch,
        head: published.branch,
        commit_sha: published.commitSha,
        commit_url: published.commitUrl,
        file_count: parsedBody.data.paths?.length ?? exported.files.length,
        changed_file_count: published.changedFileCount,
        written_file_count: published.writtenFileCount,
        deleted_file_count: published.deletedFileCount,
        reused: published.reused,
      },
      { status: published.reused ? 200 : 201 },
    )
  } catch (error) {
    if (error instanceof HostedWorkspacePublishError) {
      if (
        error.code === 'no_changes' &&
        reservedSourceId &&
        reservedHead
      ) {
        const { error: clearError } = await admin
          .from('github_hosted_docs_sources')
          .update({
            publish_pull_request_number: null,
            publish_pull_request_url: null,
            publish_pull_request_head: null,
            publish_last_commit_sha: null,
          })
          .eq('id', reservedSourceId)
          .eq('workspace_id', workspace.workspace_id)
          .eq('publish_pull_request_head', reservedHead)
        if (clearError) {
          console.error('[Bread] no-change publish reservation cleanup failed:', clearError)
        }
      }
      return NextResponse.json(
        { error: error.message, code: error.code, ...error.details },
        { status: error.status },
      )
    }
    if (error instanceof ReadmePublishError) {
      return NextResponse.json(
        { error: error.message, code: error.code, ...error.details },
        { status: error.status },
      )
    }
    console.error('[Bread] hosted workspace publish failed:', error)
    return NextResponse.json(
      {
        error:
          'Could not publish the workspace to GitHub. Confirm the GitHub App still has Contents and Pull requests write access.',
        code: 'github_publish_failed',
      },
      { status: 502 },
    )
  } finally {
    if (leaseOperationId && leaseSourceId) {
      const { error: releaseError } = await admin
        .from('github_hosted_docs_sources')
        .update({
          publish_operation_id: null,
          publish_operation_started_at: null,
        })
        .eq('id', leaseSourceId)
        .eq('workspace_id', workspace.workspace_id)
        .eq('publish_operation_id', leaseOperationId)
      if (releaseError) {
        console.error('[Bread] workspace publish lease release failed:', releaseError)
      }
    }
  }
}
