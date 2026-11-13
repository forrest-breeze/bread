import { createAdminClient } from '@/lib/supabase/admin'
import { isBusinessTierForWorkspace } from '@/lib/db/subscription'
import { syncGitHubRepository } from './github-repo-ingest'
import { syncGitHubHostedDocs } from './github-hosted-docs'
import { syncReadmeSource } from './readme/readme-service'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'

export interface GitHubSweepResult {
  /** Number of repositories and hosted-docs links refreshed this run. */
  synced: number
  errors: number
}

/** The columns of `monitored_repos` the sweep needs. */
interface MonitoredRepoLite {
  id?: string
  workspace_id: string
  installation_id: number
  repo_full_name: string
  repo_id: number
  file_indexing_enabled?: boolean
}

// ---------------------------------------------------------------------------
// runGitHubSweep
//
// Keeps a workspace's connected repositories and GitHub-hosted docs links in
// sync with GitHub. It is the fallback for missed push webhooks:
//   1. Reads monitored_repos and github_hosted_docs_sources.
//   2. Refreshes hosted docs links, then advances the repository-file index.
//
// Shared by the cron endpoint (GET /api/github/sweep) and the manual trigger
// (POST /api/github/sweep/manual). With no workspaceId it sweeps every
// Business/Enterprise workspace; with one it scopes to that single workspace
// (manual button) and is not plan-gated.
// ---------------------------------------------------------------------------

export async function runGitHubSweep(
  workspaceId?: string,
): Promise<GitHubSweepResult | { error: string }> {
  const admin = createAdminClient()

  // 1. Resolve monitored repos (optionally workspace-scoped).
  let repoQuery = admin
    .from('monitored_repos')
    .select(`
      id, workspace_id, installation_id, repo_full_name, repo_id,
      file_indexing_enabled
    `)

  if (workspaceId) {
    repoQuery = repoQuery.eq('workspace_id', workspaceId)
  }

  const { data: repoRows, error: reposError } = await repoQuery

  if (reposError) {
    console.error(
      '[Breezify] GitHub sweep: failed to fetch monitored repos:',
      reposError.message,
    )
    return { error: 'Service temporarily unavailable' }
  }

  let repos = (repoRows ?? []) as MonitoredRepoLite[]

  let hostedQuery = admin
    .from('github_hosted_docs_sources')
    .select('*')
  if (workspaceId) hostedQuery = hostedQuery.eq('workspace_id', workspaceId)
  const { data: hostedRows, error: hostedError } = await hostedQuery
  if (hostedError) {
    console.error(
      '[Breezify] GitHub sweep: failed to fetch hosted docs links:',
      hostedError.message,
    )
    return { error: 'Service temporarily unavailable' }
  }
  let hostedSources = (hostedRows ?? []) as GitHubHostedDocsSourceRow[]

  // Cron path (no workspaceId): only sweep workspaces on a Business/Enterprise
  // plan. Without this the sweep enumerated every repo on every tick regardless
  // of plan, which is the bulk of the scheduled DB + GitHub-API load. The manual
  // path (workspaceId
  // set) is left ungated — it's already reachable only from gated settings UI.
  if (!workspaceId && (repos.length > 0 || hostedSources.length > 0)) {
    const uniqueWorkspaceIds = [
      ...new Set([
        ...repos.map((repo) => repo.workspace_id),
        ...hostedSources.map((source) => source.workspace_id),
      ]),
    ]
    const allowed = new Set<string>()
    for (const wsId of uniqueWorkspaceIds) {
      if (await isBusinessTierForWorkspace(wsId)) allowed.add(wsId)
    }
    repos = repos.filter((r) => allowed.has(r.workspace_id))
    hostedSources = hostedSources.filter((source) => allowed.has(source.workspace_id))
  }

  if (repos.length === 0 && hostedSources.length === 0) {
    return { synced: 0, errors: 0 }
  }

  // Start linked documentation independently before the full-repository pass.
  // Repository indexing can take substantially longer, so awaiting it first
  // would otherwise delay (or indefinitely suppress) the narrow docs refresh.
  const hostedSyncErrorsPromise = syncHostedDocsSources(hostedSources)

  // 2. Advance the repository-file index in bounded batches. Large repos
  //    converge over successive hourly runs; per-repo failures never abort the
  //    rest of the sweep.
  let repoSyncErrors = 0
  for (const repo of repos.filter((row) => row.file_indexing_enabled !== false)) {
    try {
      const result = await syncGitHubRepository({
        workspaceId: repo.workspace_id,
        installationId: repo.installation_id,
        repoId: repo.repo_id,
        repoFullName: repo.repo_full_name,
      })
      repoSyncErrors += result.failed
    } catch (err) {
      console.error(
        '[Breezify] GitHub sweep: repository sync failed for',
        repo.repo_full_name,
        ':',
        err,
      )
      repoSyncErrors++
    }
  }

  repoSyncErrors += await hostedSyncErrorsPromise

  return { synced: repos.length + hostedSources.length, errors: repoSyncErrors }
}

/**
 * Refresh linked documentation in its own sequential lane. Calling this before
 * repository indexing lets these narrow pulls continue while a large repo is
 * still being indexed without increasing concurrency among hosted sources.
 */
async function syncHostedDocsSources(
  sources: GitHubHostedDocsSourceRow[],
): Promise<number> {
  let errors = 0
  for (const source of sources) {
    if (source.paths.length === 0 || source.sync_status === 'disabled') continue
    try {
      if (source.format === 'readme') {
        await syncReadmeSource(source)
        continue
      }
      await syncGitHubHostedDocs({
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
      })
    } catch (err) {
      console.error(
        '[Breezify] GitHub sweep: hosted docs link failed for',
        source.repo_full_name,
        ':',
        err,
      )
      errors++
    }
  }
  return errors
}
