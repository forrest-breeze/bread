import { NextResponse } from 'next/server'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { requireRouteUser } from '@/lib/auth/route-auth'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { buildBreezifyWorkspaceExport } from '@/lib/github/github-hosted-workspace'
import { ReadmePublishError } from '@/lib/github/readme/readme-publish'
import {
  diffReadmeSourcePublish,
  isReadmeFormatSource,
} from '@/lib/github/readme/readme-service'
import {
  HostedWorkspacePublishError,
  resolveHostedWorkspacePublishDiff,
} from '@/lib/github/github-hosted-workspace-publish'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// GET /api/github/hosted-docs/publish/diff
//
// The "files changed" review for a pending workspace publish: every path this
// publish would write or delete, with the text on GitHub today beside the text
// it would become.
//
// Deliberately separate from the publish STATUS endpoint next door. That one is
// polled and must stay cheap — it compares blob SHAs and never downloads file
// bodies. This one downloads them only after the exact status reports pending
// changes, and it caps how many it will fetch. The client warms this response
// so opening the review does not start the expensive work from scratch.
// ---------------------------------------------------------------------------

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie',
}

function privateJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) {
    return privateJson(
      { error: 'Sign in to review workspace changes.', code: 'unauthenticated' },
      401,
    )
  }
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return privateJson(
      { error: 'Choose a workspace first.', code: 'workspace_required' },
      403,
    )
  }
  if (!['owner', 'admin', 'editor'].includes(workspace.role)) {
    return privateJson(
      {
        error:
          'Only workspace owners, admins, and editors can review workspace changes.',
        code: 'insufficient_role',
      },
      403,
    )
  }
  if (!(await isWorkspaceOnPaidTier(workspace.workspace_id))) {
    return privateJson(
      { error: 'GitHub publishing is not enabled for this workspace.', code: 'feature_not_enabled' },
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

    // The review is only reachable from a publish control that already knows
    // publishing is possible, so these are guards rather than user-facing
    // states — the status endpoint owns explaining why publishing is blocked.
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

    if (isReadmeFormatSource(source)) {
      const diff = await diffReadmeSourcePublish(source, admin)
      return privateJson({
        files: diff.files,
        changed_file_count: diff.changedFileCount,
        truncated: diff.truncated,
        compared_commit_sha: diff.comparedCommitSha,
      })
    }

    const targetPath = source.paths[0]!
    const exported = await buildBreezifyWorkspaceExport(admin, {
      workspaceId: workspace.workspace_id,
      targetPath,
      repoId: source.repo_id,
      hostedRootFolderId: source.root_folder_id,
    })

    const diff = await resolveHostedWorkspacePublishDiff({
      source,
      files: exported.files,
      managedPaths: exported.managedPaths,
    })

    return privateJson({
      files: diff.files,
      changed_file_count: diff.changedFileCount,
      truncated: diff.truncated,
      compared_commit_sha: diff.comparedCommitSha,
    })
  } catch (err) {
    if (err instanceof HostedWorkspacePublishError || err instanceof ReadmePublishError) {
      return privateJson({ error: err.message, code: err.code }, err.status)
    }
    console.error('[Breezify] workspace publish diff:', err)
    return privateJson(
      { error: 'Could not build the workspace diff.', code: 'diff_failed' },
      500,
    )
  }
}
