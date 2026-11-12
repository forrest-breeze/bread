import type { GitHubHostedDocsSourceRow } from '@bread/core'
import {
  getInstallationToken,
  getPullRequest,
  listRecentClosedPullRequests,
  type GitHubPR,
} from './github'
import { githubHostedDocsBranchPrefix } from './github-hosted-bootstrap'
import { withGitHubRetry } from './retry'

export type GitHubHostedDocsActivation =
  | { state: 'waiting' }
  | {
      state: 'merged'
      pullRequestNumber: number
      pullRequestUrl: string | null
      ref: string | null
    }
  | {
      state: 'closed'
      pullRequestNumber: number
      pullRequestUrl: string | null
    }

interface ActivationDeps {
  getToken?: typeof getInstallationToken
  getPR?: typeof getPullRequest
  listClosedPRs?: typeof listRecentClosedPullRequests
}

function pullRequestActivation(pr: GitHubPR): GitHubHostedDocsActivation {
  if (pr.state !== 'closed') return { state: 'waiting' }
  const pullRequestUrl = pr.html_url ?? null
  if (pr.merged || pr.merged_at) {
    return {
      state: 'merged',
      pullRequestNumber: pr.number,
      pullRequestUrl,
      ref: pr.merge_commit_sha ?? null,
    }
  }
  return {
    state: 'closed',
    pullRequestNumber: pr.number,
    pullRequestUrl,
  }
}

/**
 * Resolve the PR that gates a Bread-authored docs root. New links use their
 * persisted PR number. Rows created before that metadata existed recover by
 * matching Bread's generated branch prefix among recently closed PRs.
 */
export async function resolveGitHubHostedDocsActivation(
  source: GitHubHostedDocsSourceRow,
  deps: ActivationDeps = {},
): Promise<GitHubHostedDocsActivation> {
  if (source.sync_status !== 'disabled') return { state: 'waiting' }
  const getToken = deps.getToken ?? getInstallationToken
  const getPR = deps.getPR ?? getPullRequest
  const listClosedPRs = deps.listClosedPRs ?? listRecentClosedPullRequests
  const token = await withGitHubRetry(() => getToken(source.installation_id))

  if (source.pending_pull_request_number) {
    const pullRequest = await withGitHubRetry(() =>
      getPR(token, source.repo_full_name, source.pending_pull_request_number!),
    )
    return pullRequestActivation(pullRequest)
  }

  const rootPath = source.paths[0]
  if (!rootPath) return { state: 'waiting' }
  const branchPrefix = githubHostedDocsBranchPrefix(rootPath)
  const earliestUpdate = Date.parse(source.created_at) - 5 * 60_000
  const pullRequests = await withGitHubRetry(() =>
    listClosedPRs(token, source.repo_full_name, 50),
  )
  const match = pullRequests.find((pullRequest) => {
    const updatedAt = Date.parse(pullRequest.updated_at)
    return (
      pullRequest.head?.ref.startsWith(branchPrefix) === true &&
      (Number.isNaN(updatedAt) || updatedAt >= earliestUpdate)
    )
  })
  return match ? pullRequestActivation(match) : { state: 'waiting' }
}
