import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@bread/core'
import {
  getInstallationToken,
  getRepository,
  getRepositoryBranchReference,
  getRepositoryCommit,
  getRepositoryTree,
} from '../github'
import { withGitHubRetry } from '../retry'
import {
  classifyReadmeTree,
  normalizeReadmeRoot,
  README_MAX_PAGES,
  storedReadmeRoot,
} from './readme-layout'

/**
 * Link a workspace to a repository that uses the ReadMe layout.
 *
 * Unlike the Bread format there is nothing to validate file by file: pages
 * that cannot be read are skipped and reported by the sync. Linking only
 * checks that the repository, branch and root exist and are within limits.
 */

export interface ReadmeLinkInput {
  workspaceId: string
  userId: string
  installationId: number
  repository: { id: number; full_name: string }
  /** Project root in the repository; '' or '.' for the repository root. */
  rootPath: string
  /** Branch to sync; empty for the repository default branch. */
  branch: string | null
  publishMode: 'direct' | 'pull_request'
  /** 'github_wins' replaces linked Bread content with the repository's. */
  mode: 'merge' | 'github_wins'
  existing: GitHubHostedDocsSourceRow | null
  /** Lease held on the existing row by the caller, when there is one. */
  leaseOperationId: string | null
}

export type ReadmeLinkOutcome =
  | { ok: true; source: GitHubHostedDocsSourceRow; commitSha: string }
  | { ok: false; status: number; error: string; code: string }

export function isValidBranchName(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 255 &&
    !/[\u0000- \u007f~^:?*[\\]/.test(branch) &&
    !/(^\/|\/$|\/\/|\.\.|@\{|\.lock$|^-)/.test(branch)
  )
}

export async function linkReadmeRepository(
  admin: SupabaseClient,
  input: ReadmeLinkInput,
): Promise<ReadmeLinkOutcome> {
  const root = normalizeReadmeRoot(input.rootPath)
  if (root === null) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_root',
      error: 'Choose a valid folder, or leave it empty to use the repository root.',
    }
  }
  const requestedBranch = input.branch?.trim() || null
  if (requestedBranch && !isValidBranchName(requestedBranch)) {
    return { ok: false, status: 400, code: 'invalid_branch', error: 'Enter a valid branch name.' }
  }

  const repoFullName = input.repository.full_name
  const token = await withGitHubRetry(() => getInstallationToken(input.installationId))
  const metadata = await withGitHubRetry(() => getRepository(token, repoFullName))
  // Storing null keeps following the default branch if it is ever renamed.
  const branch =
    requestedBranch && requestedBranch !== metadata.default_branch ? requestedBranch : null
  const effectiveBranch = branch ?? metadata.default_branch
  if (branch) {
    const reference = await withGitHubRetry(() =>
      getRepositoryBranchReference(token, repoFullName, branch),
    )
    if (!reference) {
      return {
        ok: false,
        status: 409,
        code: 'branch_not_found',
        error: `Branch ${branch} does not exist in ${repoFullName}.`,
      }
    }
  }
  const commit = await withGitHubRetry(() =>
    getRepositoryCommit(token, repoFullName, effectiveBranch),
  )
  const tree = await withGitHubRetry(() =>
    getRepositoryTree(token, repoFullName, commit.commit.tree.sha),
  )
  if (tree.truncated) {
    return {
      ok: false,
      status: 413,
      code: 'repository_tree_truncated',
      error: 'This repository is too large to sync.',
    }
  }
  if (root && !tree.tree.some((entry) => entry.type === 'tree' && entry.path === root)) {
    return {
      ok: false,
      status: 409,
      code: 'root_not_found',
      error: `Folder ${root} does not exist on ${effectiveBranch}.`,
    }
  }
  const classification = classifyReadmeTree(tree.tree, root)
  if (classification.pages.length > README_MAX_PAGES) {
    return {
      ok: false,
      status: 413,
      code: 'too_many_pages',
      error: `A ReadMe-format repository supports at most ${README_MAX_PAGES} pages.`,
    }
  }

  const existing = input.existing
  const paths = [storedReadmeRoot(root)]
  const sameTarget =
    existing?.format === 'readme' &&
    existing.repo_id === input.repository.id &&
    existing.paths[0] === paths[0] &&
    (existing.branch ?? null) === branch
  const values = {
    workspace_id: input.workspaceId,
    installation_id: input.installationId,
    repo_full_name: repoFullName,
    repo_id: input.repository.id,
    paths,
    root_folder_id: null,
    format: 'readme',
    publish_mode: input.publishMode,
    branch,
    sync_status: 'pending',
    conflict_count: sameTarget ? existing.conflict_count : 0,
    last_sync_error: null,
    // A different repository, root or branch starts from a clean slate.
    ...(sameTarget ? {} : { sync_state: {}, last_sync_commit_sha: null, document_count: 0 }),
    pending_pull_request_number: null,
    pending_pull_request_url: null,
    pending_pull_request_head: null,
    pending_sync_mode: input.mode === 'github_wins' ? 'replace_bread' : 'merge',
    publish_pull_request_number: null,
    publish_pull_request_url: null,
    publish_pull_request_head: null,
    publish_last_commit_sha: null,
    publish_operation_id: null,
    publish_operation_started_at: null,
    created_by: existing?.created_by ?? input.userId,
  }
  const result = existing
    ? await admin
        .from('github_hosted_docs_sources')
        .update(values)
        .eq('id', existing.id)
        .eq('workspace_id', input.workspaceId)
        .eq('publish_operation_id', input.leaseOperationId!)
        .select('*')
        .single()
    : await admin.from('github_hosted_docs_sources').insert(values).select('*').single()
  if (result.error || !result.data) {
    throw result.error ?? new Error('No hosted docs source returned')
  }
  return {
    ok: true,
    source: result.data as GitHubHostedDocsSourceRow,
    commitSha: commit.sha,
  }
}
