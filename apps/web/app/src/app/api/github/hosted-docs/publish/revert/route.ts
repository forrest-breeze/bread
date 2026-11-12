import { type NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
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
} from '@/lib/github/github-hosted-format'
import { buildBreadWorkspaceExport } from '@/lib/github/github-hosted-workspace'
import {
  HostedWorkspacePublishError,
  resolveHostedWorkspacePublishDiff,
} from '@/lib/github/github-hosted-workspace-publish'
import {
  HostedWorkspaceRevertError,
  revertHostedWorkspaceChanges,
} from '@/lib/github/github-hosted-workspace-revert'

export const runtime = 'nodejs'

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie',
}

const bodySchema = z
  .object({
    paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(60),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.paths).size !== value.paths.length) {
      context.addIssue({
        code: 'custom',
        path: ['paths'],
        message: 'Selected paths must be unique.',
      })
    }
  })

function privateJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) {
    return privateJson(
      { error: 'Sign in to revert workspace changes.', code: 'unauthenticated' },
      401,
    )
  }
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return privateJson(
      { error: 'Choose a workspace before reverting changes.', code: 'workspace_required' },
      403,
    )
  }
  if (!['owner', 'admin', 'editor'].includes(workspace.role)) {
    return privateJson(
      {
        error: 'Only workspace owners, admins, and editors can revert changes.',
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

  const parsedBody = bodySchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!parsedBody.success) {
    return privateJson(
      { error: 'Invalid request body', issues: parsedBody.error.flatten() },
      400,
    )
  }

  const admin = createAdminClient()
  let leaseOperationId: string | null = null
  let leaseSourceId: string | null = null
  try {
    const { data, error } = await admin
      .from('github_hosted_docs_sources')
      .select('*')
      .eq('workspace_id', workspace.workspace_id)
      .maybeSingle()
    if (error) throw error
    let source = data as GitHubHostedDocsSourceRow | null
    if (
      !source ||
      source.paths.length !== 1 ||
      source.sync_status !== 'synced'
    ) {
      return privateJson(
        {
          error: 'Workspace publishing is not ready.',
          code: 'hosted_docs_not_ready',
        },
        409,
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
      return privateJson(
        {
          error: 'Another workspace publish or revert is already in progress.',
          code: 'publish_in_progress',
        },
        409,
      )
    }
    leaseSourceId = leasedSource.id
    source = leasedSource
    if (
      source.paths.length !== 1 ||
      source.sync_status !== 'synced'
    ) {
      return privateJson(
        {
          error: 'The GitHub-hosted docs configuration changed while the revert started.',
          code: 'hosted_docs_configuration_changed',
        },
        409,
      )
    }

    const exported = await buildBreadWorkspaceExport(admin, {
      workspaceId: workspace.workspace_id,
      targetPath: source.paths[0]!,
      repoId: source.repo_id,
      hostedRootFolderId: source.root_folder_id,
    })
    assertBreadHostedDocsFiles(exported.files)
    const diff = await resolveHostedWorkspacePublishDiff({
      source,
      files: exported.files,
      managedPaths: exported.managedPaths,
    })
    if (!diff.comparedCommitSha) {
      throw new HostedWorkspaceRevertError(
        'GitHub comparison changed before the revert started. Refresh and try again.',
        409,
        'comparison_changed',
      )
    }
    const reverted = await revertHostedWorkspaceChanges(admin, {
      workspaceId: workspace.workspace_id,
      source,
      exportedFiles: exported.files,
      diffFiles: diff.files,
      selectedPaths: parsedBody.data.paths,
      comparedCommitSha: diff.comparedCommitSha,
    })

    return privateJson({
      reverted_paths: reverted.revertedPaths,
      reverted_document_ids: reverted.documentIds,
    })
  } catch (error) {
    if (
      error instanceof HostedWorkspacePublishError ||
      error instanceof HostedWorkspaceRevertError
    ) {
      return privateJson(
        { error: error.message, code: error.code, ...error.details },
        error.status,
      )
    }
    if (error instanceof BreadDocsFormatError) {
      return privateJson(
        {
          error: 'The workspace export cannot be safely reverted.',
          code: 'invalid_workspace_export',
          format_errors: error.issues,
        },
        422,
      )
    }
    console.error('[Bread] workspace publish revert:', error)
    return privateJson(
      { error: 'Could not revert the selected workspace changes.', code: 'revert_failed' },
      500,
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
        console.error('[Bread] workspace revert lease release failed:', releaseError)
      }
    }
  }
}
