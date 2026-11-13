import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { createAdminClient } from '@/lib/supabase/admin'
import { portalDocumentToMarkdown } from '@/lib/portal/portal-doc-markdown'
import { getInstallationToken, getPullRequest } from '../github'
import { withGitHubRetry } from '../retry'
import { readmeRootFromPaths } from './readme-layout'
import {
  commitReadmeSpecFile,
  diffReadmePublish,
  inspectReadmePublish,
  isReadmePublishBranch,
  publishReadmeWorkspace,
  ReadmePublishError,
  type ReadmePublishDeps,
  type ReadmePublishSource,
} from './readme-publish'
import { createSupabaseReadmeStore } from './readme-store-supabase'
import {
  ReadmeSyncError,
  syncReadmeRepository,
  type ReadmeSyncMode,
  type ReadmeSyncResult,
} from './readme-sync'

/**
 * Server wiring for the ReadMe-format GitHub sync: binds the pure sync and
 * publish logic to the workspace database and the GitHub App installation.
 */

const STALE_SYNC_MS = 5 * 60 * 1000

export function isReadmeFormatSource(
  source: Pick<GitHubHostedDocsSourceRow, 'format'> | null | undefined,
): boolean {
  return source?.format === 'readme'
}

function publishSource(source: GitHubHostedDocsSourceRow): ReadmePublishSource {
  return {
    installationId: source.installation_id,
    repoId: source.repo_id,
    repoFullName: source.repo_full_name,
    root: readmeRootFromPaths(source.paths),
    branch: source.branch ?? null,
    lastSyncCommitSha: source.last_sync_commit_sha,
    syncState: source.sync_state ?? null,
    publishMode: source.publish_mode === 'direct' ? 'direct' : 'pull_request',
    publishPullRequestNumber: source.publish_pull_request_number,
    publishPullRequestHead: source.publish_pull_request_head,
  }
}

function publishDeps(admin: SupabaseClient, source: GitHubHostedDocsSourceRow): ReadmePublishDeps {
  return {
    store: createSupabaseReadmeStore(admin, {
      workspaceId: source.workspace_id,
      sourceId: source.id,
      repoId: source.repo_id,
    }),
    toMarkdown: portalDocumentToMarkdown,
  }
}

function safeSyncError(error: unknown): string {
  if (error instanceof ReadmeSyncError) return error.message
  const status = (error as { status?: number }).status
  if (status === 403 || status === 404) {
    return 'GitHub can no longer read the linked repository or branch.'
  }
  return 'GitHub sync failed. Retry from GitHub settings.'
}

export interface ReadmeSourceSyncOptions {
  /** Exact commit or branch to read; defaults to the configured branch. */
  ref?: string
  force?: boolean
  mode?: ReadmeSyncMode
}

/**
 * Pull the repository into the workspace. Returns null when another sync of
 * the same source is already running.
 */
export async function syncReadmeSource(
  source: GitHubHostedDocsSourceRow,
  options: ReadmeSourceSyncOptions = {},
  admin: SupabaseClient = createAdminClient(),
): Promise<ReadmeSyncResult | null> {
  // Claim the source so a webhook and a status poll cannot reconcile the same
  // workspace at once: first if nothing is syncing, otherwise only by taking
  // over a sync whose heartbeat went stale.
  const claim = () =>
    admin
      .from('github_hosted_docs_sources')
      .update({ sync_status: 'syncing', last_sync_error: null })
      .eq('id', source.id)
      .eq('workspace_id', source.workspace_id)
  const idle = await claim().neq('sync_status', 'syncing').select('*').maybeSingle()
  if (idle.error) throw new Error(`readme sync claim: ${idle.error.message}`)
  let claimed = idle.data as GitHubHostedDocsSourceRow | null
  if (!claimed) {
    const staleBefore = new Date(Date.now() - STALE_SYNC_MS).toISOString()
    const stale = await claim()
      .eq('sync_status', 'syncing')
      .lt('updated_at', staleBefore)
      .select('*')
      .maybeSingle()
    if (stale.error) throw new Error(`readme sync claim: ${stale.error.message}`)
    claimed = stale.data as GitHubHostedDocsSourceRow | null
  }
  if (!claimed) return null
  const current = claimed

  const deps = publishDeps(admin, current)
  try {
    const result = await syncReadmeRepository(
      {
        installationId: current.installation_id,
        repoId: current.repo_id,
        repoFullName: current.repo_full_name,
        root: readmeRootFromPaths(current.paths),
        branch: current.branch ?? null,
        ref: options.ref,
        lastSyncCommitSha: current.last_sync_commit_sha,
        syncState: current.sync_state ?? null,
        mode: options.mode ?? current.pending_sync_mode ?? 'merge',
        force: options.force,
      },
      deps,
    )
    await reconcileReadmePublishPullRequest(current, admin)
    return result
  } catch (error) {
    await deps.store
      .updateSource({
        sync_status: 'error',
        last_sync_at: new Date().toISOString(),
        last_sync_error: safeSyncError(error),
      })
      .catch((statusError: unknown) => {
        console.error('[Breezify] readme sync status update failed:', statusError)
      })
    throw error
  }
}

/** Forget the publish pull request once it has been merged or closed. */
export async function reconcileReadmePublishPullRequest(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
): Promise<GitHubHostedDocsSourceRow> {
  if (
    !source.publish_pull_request_number ||
    !isReadmePublishBranch(source.publish_pull_request_head)
  ) {
    return source
  }
  try {
    const token = await withGitHubRetry(() => getInstallationToken(source.installation_id))
    const pullRequest = await withGitHubRetry(() =>
      getPullRequest(token, source.repo_full_name, source.publish_pull_request_number!),
    )
    if (pullRequest.state === 'open') return source
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
    // Keep the pointer through a transient GitHub failure; the next poll or
    // sync reconciles it again.
    console.error('[Breezify] readme publish PR reconciliation failed:', error)
    return source
  }
}

export function inspectReadmeSourcePublish(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
) {
  return inspectReadmePublish(publishSource(source), publishDeps(admin, source))
}

export function diffReadmeSourcePublish(
  source: GitHubHostedDocsSourceRow,
  admin: SupabaseClient = createAdminClient(),
) {
  return diffReadmePublish(publishSource(source), publishDeps(admin, source))
}

export function publishReadmeSource(
  source: GitHubHostedDocsSourceRow,
  options: { includeConflicts?: boolean; selectedPaths?: string[]; message?: string },
  admin: SupabaseClient = createAdminClient(),
) {
  return publishReadmeWorkspace(publishSource(source), publishDeps(admin, source), options)
}

async function linkedReadmeSource(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<GitHubHostedDocsSourceRow | null> {
  const { data, error } = await admin
    .from('github_hosted_docs_sources')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`readme source lookup: ${error.message}`)
  const source = data as GitHubHostedDocsSourceRow | null
  if (!source || !isReadmeFormatSource(source) || source.sync_status === 'disabled') return null
  return source
}

export interface OpenApiRepositoryOutcome {
  /** True when a commit was made on the synced branch. */
  committed: boolean
  path: string | null
  commit_sha: string | null
  /** Why the definition was not committed, when it was not. */
  reason?: 'pull_request_mode' | 'unchanged' | 'failed'
  message?: string
}

/**
 * After an OpenAPI definition was uploaded (CI or Settings), write it to
 * `reference/` in the linked ReadMe-format repository. This is what keeps the
 * existing upload integration and the GitHub sync on one source of truth.
 *
 * Never throws: the upload already succeeded, so a GitHub failure is reported
 * in the result instead of failing the request.
 */
export async function writeOpenApiSourceToLinkedRepository(
  admin: SupabaseClient,
  workspaceId: string,
  slug: string,
): Promise<OpenApiRepositoryOutcome | null> {
  try {
    const source = await linkedReadmeSource(admin, workspaceId)
    if (!source) return null
    if (source.publish_mode !== 'direct') {
      return { committed: false, path: null, commit_sha: null, reason: 'pull_request_mode' }
    }
    const { data, error } = await admin
      .from('openapi_sources')
      .select('spec_raw, repo_path')
      .eq('workspace_id', workspaceId)
      .eq('slug', slug)
      .maybeSingle()
    if (error) throw new Error(`OpenAPI source lookup: ${error.message}`)
    const row = data as { spec_raw: string | null; repo_path: string | null } | null
    if (!row?.spec_raw) return null
    const outcome = await commitReadmeSpecFile(publishSource(source), publishDeps(admin, source), {
      slug,
      raw: row.spec_raw,
      repoPath: row.repo_path,
    })
    return {
      committed: outcome.committed,
      path: outcome.path,
      commit_sha: outcome.commitSha,
      ...(outcome.committed ? {} : { reason: 'unchanged' as const }),
    }
  } catch (error) {
    console.error('[Breezify] OpenAPI definition push to GitHub failed:', error)
    return {
      committed: false,
      path: null,
      commit_sha: null,
      reason: 'failed',
      message:
        error instanceof ReadmePublishError
          ? error.message
          : 'The definition was published, but could not be written to the linked GitHub repository.',
    }
  }
}

/** Look up where a definition lives in the repository before it is deleted. */
export async function openApiSourceRepositoryPath(
  admin: SupabaseClient,
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from('openapi_sources')
      .select('repo_path')
      .eq('workspace_id', workspaceId)
      .eq('slug', slug)
      .maybeSingle()
    if (error) return null
    return (data as { repo_path: string | null } | null)?.repo_path ?? null
  } catch {
    // Best effort: removing the source must not fail on this lookup.
    return null
  }
}

/** After an OpenAPI source was removed, delete its file from the repository. */
export async function removeOpenApiSourceFromLinkedRepository(
  admin: SupabaseClient,
  workspaceId: string,
  input: { slug: string; repoPath: string | null },
): Promise<OpenApiRepositoryOutcome | null> {
  if (!input.repoPath) return null
  try {
    const source = await linkedReadmeSource(admin, workspaceId)
    if (!source) return null
    if (source.publish_mode !== 'direct') {
      return { committed: false, path: input.repoPath, commit_sha: null, reason: 'pull_request_mode' }
    }
    const outcome = await commitReadmeSpecFile(publishSource(source), publishDeps(admin, source), {
      slug: input.slug,
      raw: null,
      repoPath: input.repoPath,
    })
    return {
      committed: outcome.committed,
      path: outcome.path,
      commit_sha: outcome.commitSha,
      ...(outcome.committed ? {} : { reason: 'unchanged' as const }),
    }
  } catch (error) {
    console.error('[Breezify] OpenAPI definition removal from GitHub failed:', error)
    return {
      committed: false,
      path: input.repoPath,
      commit_sha: null,
      reason: 'failed',
      message:
        error instanceof ReadmePublishError
          ? error.message
          : 'The definition was removed, but its file could not be deleted from the linked GitHub repository.',
    }
  }
}
