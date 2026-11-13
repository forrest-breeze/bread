import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { createAdminClient } from '@/lib/supabase/admin'
import { syncReadmeSource } from './readme-service'

/**
 * Pushes to a branch other than the repository default.
 *
 * Default-branch pushes are routed by `handleRepositoryPush`. A ReadMe-format
 * link may instead follow another branch (ReadMe maps one branch to each docs
 * version), and those pushes are handled here.
 */

export interface HostedBranchPushInfo {
  installationId: number
  repoId: number
  repoFullName: string
  branch: string
  /** Commit the branch now points at. */
  after: string
}

export function extractHostedBranchPush(
  eventType: string,
  payload: Record<string, unknown>,
): HostedBranchPushInfo | null {
  if (eventType !== 'push') return null
  const typed = payload as {
    ref?: unknown
    after?: unknown
    deleted?: unknown
    repository?: { id?: unknown; full_name?: unknown; default_branch?: unknown }
    installation?: { id?: unknown }
  }
  const repository = typed.repository
  const installationId = typed.installation?.id
  if (
    typed.deleted === true ||
    typeof typed.ref !== 'string' ||
    !typed.ref.startsWith('refs/heads/') ||
    typeof typed.after !== 'string' ||
    /^0+$/.test(typed.after) ||
    typeof repository?.id !== 'number' ||
    typeof repository.full_name !== 'string' ||
    typeof installationId !== 'number'
  ) {
    return null
  }
  const branch = typed.ref.slice('refs/heads/'.length)
  // The default branch has its own handler.
  if (!branch || branch === repository.default_branch) return null
  return {
    installationId,
    repoId: repository.id,
    repoFullName: repository.full_name,
    branch,
    after: typed.after,
  }
}

export async function handleHostedBranchPush(
  info: HostedBranchPushInfo,
  deps: { admin?: SupabaseClient; syncSource?: typeof syncReadmeSource } = {},
): Promise<void> {
  const admin = deps.admin ?? createAdminClient()
  const { data, error } = await admin
    .from('github_hosted_docs_sources')
    .select('*')
    .eq('repo_id', info.repoId)
    .eq('installation_id', info.installationId)
    .eq('format', 'readme')
    .eq('branch', info.branch)
    .maybeSingle()
  if (error) throw new Error(`[handleHostedBranchPush] source lookup: ${error.message}`)
  const source = data as GitHubHostedDocsSourceRow | null
  if (!source || source.sync_status === 'disabled') return
  await (deps.syncSource ?? syncReadmeSource)(source, { ref: info.after }, admin)
}
