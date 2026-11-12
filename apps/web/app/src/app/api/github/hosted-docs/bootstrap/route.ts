import { type NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import type { GitHubHostedDocsSourceRow } from '@bread/core'
import { requireRouteUser } from '@/lib/auth/route-auth'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import {
  githubHostedDocsBranchPrefix,
  githubHostedDocsPullRequestTitle,
  normalizeBootstrapTargetPath,
} from '@/lib/github/github-hosted-bootstrap'
import { assertBreadHostedDocsFiles } from '@/lib/github/github-hosted-format'
import {
  buildBreadWorkspaceExport,
  MAX_HOSTED_WORKSPACE_BYTES,
  MAX_HOSTED_WORKSPACE_DOCUMENTS,
} from '@/lib/github/github-hosted-workspace'
import {
  createRepositoryBranch,
  createRepositoryFilesCommit,
  createRepositoryPullRequest,
  getInstallationToken,
  getRepository,
  getRepositoryCommit,
  getRepositoryTree,
  listInstallationRepos,
} from '@/lib/github/github'
import { withGitHubRetry } from '@/lib/github/retry'
import { safeJsonBody } from '@/lib/validation'

export const runtime = 'nodejs'

const bodySchema = z.object({
  repo_id: z.number().int().positive(),
  target_path: z.string().trim().min(1).max(512),
  allow_existing: z.boolean().default(false),
})

async function requireAdmin(): Promise<{ userId: string; workspaceId: string } | null> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase)
  if (!user) return null
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace || !['owner', 'admin'].includes(workspace.role)) return null
  return { userId: user.id, workspaceId: workspace.workspace_id }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isWorkspaceOnPaidTier(auth.workspaceId))) {
    return NextResponse.json({ error: 'Integrations require a paid plan.' }, { status: 402 })
  }

  const parsed = await safeJsonBody(request, bodySchema)
  if (!parsed.ok) return parsed.response
  const targetPath = normalizeBootstrapTargetPath(parsed.data.target_path)
  if (!targetPath) {
    return NextResponse.json(
      { error: 'Use a repository folder path such as docs or docs/product.' },
      { status: 400 },
    )
  }

  const admin = createAdminClient()
  let configurationOperationId: string | null = null
  let configurationSourceId: string | null = null
  let previousSource: GitHubHostedDocsSourceRow | null = null
  let preparedSourceId: string | null = null
  let setupPersisted = false
  try {
    const { data: integration, error: integrationError } = await admin
      .from('github_integrations')
      .select('installation_id')
      .eq('workspace_id', auth.workspaceId)
      .maybeSingle()
    if (integrationError) throw integrationError
    if (!integration) {
      return NextResponse.json({ error: 'Connect GitHub before creating its docs folder.' }, { status: 409 })
    }
    const installationId = Number(integration.installation_id)
    const repositories = await withGitHubRetry(() =>
      listInstallationRepos(installationId),
    )
    const availableRepo = repositories.find((row) => row.id === parsed.data.repo_id)
    const repo = availableRepo
      ? {
          repo_id: availableRepo.id,
          repo_full_name: availableRepo.full_name,
          installation_id: installationId,
        }
      : null
    if (!repo) {
      return NextResponse.json(
        { error: 'This GitHub App installation cannot access that repository.' },
        { status: 404 },
      )
    }
    const { data: existingSource, error: existingSourceError } = await admin
      .from('github_hosted_docs_sources')
      .select('*')
      .eq('workspace_id', auth.workspaceId)
      .maybeSingle()
    if (existingSourceError) throw existingSourceError
    let existing = existingSource as GitHubHostedDocsSourceRow | null
    previousSource = existing
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

    const exported = await buildBreadWorkspaceExport(admin, {
      workspaceId: auth.workspaceId,
      targetPath,
    })
    if (exported.restrictedFolderNames.length > 0) {
      return NextResponse.json(
        {
          error:
            `Restricted Bread folders cannot be copied into a repository shared with a broader audience: ` +
            `${exported.restrictedFolderNames.slice(0, 3).join(', ')}` +
            `${exported.restrictedFolderNames.length > 3 ? ', …' : ''}. ` +
            'Use a private repository with the same audience or keep these documents Bread-only.',
          restricted_folders: exported.restrictedFolderNames,
        },
        { status: 409 },
      )
    }
    if (exported.documents.length > MAX_HOSTED_WORKSPACE_DOCUMENTS) {
      return NextResponse.json(
        { error: `The Bread workspace must contain at most ${MAX_HOSTED_WORKSPACE_DOCUMENTS} documents for this operation.` },
        { status: 413 },
      )
    }
    if (exported.totalBytes > MAX_HOSTED_WORKSPACE_BYTES) {
      return NextResponse.json(
        { error: 'This Bread workspace is too large to publish in one GitHub pull request.' },
        { status: 413 },
      )
    }
    const files = exported.files
    assertBreadHostedDocsFiles(files)

    const token = await withGitHubRetry(() => getInstallationToken(repo.installation_id))
    const metadata = await withGitHubRetry(() =>
      getRepository(token, repo.repo_full_name),
    )
    const baseCommit = await withGitHubRetry(() =>
      getRepositoryCommit(token, repo.repo_full_name, metadata.default_branch),
    )
    const tree = await withGitHubRetry(() =>
      getRepositoryTree(token, repo.repo_full_name, baseCommit.commit.tree.sha),
    )
    const targetExists = tree.tree.some(
      (entry) => entry.path === targetPath || entry.path.startsWith(`${targetPath}/`),
    )
    if (targetExists && !parsed.data.allow_existing) {
      return NextResponse.json(
        {
          error:
            `${targetPath} already exists on ${metadata.default_branch}. ` +
            'Choose it as the existing root instead.',
        },
        { status: 409 },
      )
    }
    if (!targetExists && parsed.data.allow_existing) {
      return NextResponse.json(
        {
          error:
            `${targetPath} no longer exists on ${metadata.default_branch}. ` +
            'Create it as a new root instead.',
        },
        { status: 409 },
      )
    }

    const branch = `${githubHostedDocsBranchPrefix(targetPath)}${Date.now().toString(36)}`
    await withGitHubRetry(() =>
      createRepositoryBranch(token, repo.repo_full_name, branch, baseCommit.sha),
    )

    // Persist the selected root before exposing its first authored commit. A
    // check_suite webhook can arrive as soon as GitHub advances the branch;
    // the App check must be able to resolve the root when that happens.
    const preparedSourceValues = {
      workspace_id: auth.workspaceId,
      installation_id: installationId,
      repo_id: repo.repo_id,
      repo_full_name: repo.repo_full_name,
      paths: [targetPath],
      root_folder_id: null,
      sync_status: 'disabled',
      document_count: 0,
      conflict_count: 0,
      last_sync_commit_sha: null,
      last_sync_at: null,
      last_sync_error: null,
      pending_pull_request_number: null,
      pending_pull_request_url: null,
      pending_pull_request_head: branch,
      pending_sync_mode: 'merge',
      publish_pull_request_number: null,
      publish_pull_request_url: null,
      publish_pull_request_head: null,
      publish_last_commit_sha: null,
      created_by: existing?.created_by ?? auth.userId,
    }
    const preparedSourceResult = existing
      ? await admin
          .from('github_hosted_docs_sources')
          .update(preparedSourceValues)
          .eq('id', existing.id)
          .eq('workspace_id', auth.workspaceId)
          .eq('publish_operation_id', configurationOperationId!)
          .select('*')
          .single()
      : await admin
          .from('github_hosted_docs_sources')
          .insert({
            ...preparedSourceValues,
            publish_operation_id: null,
            publish_operation_started_at: null,
          })
          .select('*')
          .single()
    if (preparedSourceResult.error || !preparedSourceResult.data) {
      throw preparedSourceResult.error ?? new Error('No row returned')
    }
    const preparedSource = preparedSourceResult.data as GitHubHostedDocsSourceRow
    preparedSourceId = preparedSource.id

    const commit = await withGitHubRetry(() =>
      createRepositoryFilesCommit(token, repo.repo_full_name, {
        branch,
        baseCommitSha: baseCommit.sha,
        baseTreeSha: baseCommit.commit.tree.sha,
        message: targetExists
          ? `docs: update ${targetPath} from Bread`
          : `docs: create ${targetPath} from Bread`,
        files: files.map(({ path, content }) => ({ path, content })),
        deletePaths: targetExists
          ? tree.tree
              .filter(
                (entry) =>
                  entry.type === 'blob' &&
                  entry.path.startsWith(`${targetPath}/`) &&
                  /\.(?:md|mdx)$/i.test(entry.path) &&
                  !files.some((file) => file.path === entry.path),
              )
              .map((entry) => entry.path)
          : [],
      }),
    )
    const pullRequest = await withGitHubRetry(() =>
      createRepositoryPullRequest(token, repo.repo_full_name, {
        head: branch,
        base: metadata.default_branch,
        title: githubHostedDocsPullRequestTitle(targetPath, targetExists),
        body: [
          targetExists
            ? `Makes the Markdown and MDX tree under \`${targetPath}\` match the current Bread workspace.`
            : `Creates \`${targetPath}\` from the current Bread workspace folder tree.`,
          '',
          'Bread Bot reports `Validate Bread docs` for the pull request commit and future commits while this root is linked.',
          '',
          'Repository administrators can mark `Validate Bread docs` as required in the target branch ruleset. Bread does not request broad repository-administration access.',
          '',
          'Merging this pull request activates the bidirectional GitHub docs root.',
        ].join('\n'),
      }),
    )

    const completedSourceValues = {
      pending_pull_request_number: pullRequest.number,
      pending_pull_request_url: pullRequest.html_url,
      publish_operation_id: null,
      publish_operation_started_at: null,
    }
    const completedSourceResult = existing
      ? await admin
          .from('github_hosted_docs_sources')
          .update(completedSourceValues)
          .eq('id', preparedSource.id)
          .eq('workspace_id', auth.workspaceId)
          .eq('publish_operation_id', configurationOperationId!)
          .select('*')
          .single()
      : await admin
          .from('github_hosted_docs_sources')
          .update(completedSourceValues)
          .eq('id', preparedSource.id)
          .eq('workspace_id', auth.workspaceId)
          .select('*')
          .single()
    if (completedSourceResult.error || !completedSourceResult.data) {
      throw completedSourceResult.error ?? new Error('No row returned')
    }
    const updated = completedSourceResult.data as GitHubHostedDocsSourceRow
    setupPersisted = true

    return NextResponse.json(
      {
        source: updated,
        target_path: targetPath,
        file_count: files.length,
        commit_sha: commit.sha,
        commit_url: commit.html_url,
        pull_request_number: pullRequest.number,
        pull_request_url: pullRequest.html_url,
      },
      { status: 201 },
    )
  } catch (error) {
    if (preparedSourceId && !setupPersisted) {
      try {
        if (previousSource) {
          const { error: restoreError } = await admin
            .from('github_hosted_docs_sources')
            .update({
              installation_id: previousSource.installation_id,
              repo_id: previousSource.repo_id,
              repo_full_name: previousSource.repo_full_name,
              paths: previousSource.paths,
              root_folder_id: previousSource.root_folder_id,
              sync_status: previousSource.sync_status,
              document_count: previousSource.document_count,
              conflict_count: previousSource.conflict_count,
              last_sync_commit_sha: previousSource.last_sync_commit_sha,
              last_sync_at: previousSource.last_sync_at,
              last_sync_error: previousSource.last_sync_error,
              pending_pull_request_number:
                previousSource.pending_pull_request_number,
              pending_pull_request_url: previousSource.pending_pull_request_url,
              pending_pull_request_head: previousSource.pending_pull_request_head,
              pending_sync_mode: previousSource.pending_sync_mode,
              publish_pull_request_number:
                previousSource.publish_pull_request_number,
              publish_pull_request_url: previousSource.publish_pull_request_url,
              publish_pull_request_head: previousSource.publish_pull_request_head,
              publish_last_commit_sha: previousSource.publish_last_commit_sha,
            })
            .eq('id', preparedSourceId)
            .eq('workspace_id', auth.workspaceId)
          if (restoreError) throw restoreError
        } else {
          const { error: deleteError } = await admin
            .from('github_hosted_docs_sources')
            .delete()
            .eq('id', preparedSourceId)
            .eq('workspace_id', auth.workspaceId)
          if (deleteError) throw deleteError
        }
      } catch (rollbackError) {
        console.error('[Bread] hosted docs bootstrap rollback failed:', rollbackError)
      }
    }
    console.error('[Bread] hosted docs bootstrap failed:', error)
    return NextResponse.json(
      {
        error:
          'Could not open the GitHub pull request. Confirm that the GitHub App has Contents and Pull requests write access, then try again.',
      },
      { status: 502 },
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
        console.error('[Bread] hosted docs bootstrap lease release failed:', releaseError)
      }
    }
  }
}
