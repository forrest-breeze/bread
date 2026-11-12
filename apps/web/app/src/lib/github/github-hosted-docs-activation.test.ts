import { describe, expect, it, vi } from 'vitest'
import type { GitHubHostedDocsSourceRow } from '@bread/core'
import { resolveGitHubHostedDocsActivation } from './github-hosted-docs-activation'

const source: GitHubHostedDocsSourceRow = {
  id: 'source-1',
  workspace_id: 'workspace-1',
  installation_id: 11,
  repo_full_name: 'example-org/bread-docs',
  repo_id: 1185697075,
  paths: ['docs'],
  root_folder_id: null,
  sync_status: 'disabled',
  document_count: 0,
  conflict_count: 0,
  last_sync_commit_sha: null,
  last_sync_at: null,
  last_sync_error: null,
  pending_pull_request_number: 172,
  pending_pull_request_url: 'https://github.com/example-org/bread-docs/pull/172',
  pending_pull_request_head: 'bread/docs-docs-example',
  publish_pull_request_number: null,
  publish_pull_request_url: null,
  publish_pull_request_head: null,
  publish_last_commit_sha: null,
  publish_operation_id: null,
  publish_operation_started_at: null,
  pending_sync_mode: 'merge',
  created_by: 'user-1',
  created_at: '2026-08-13T00:00:00Z',
  updated_at: '2026-08-13T00:00:00Z',
}

const mergedPullRequest = {
  number: 172,
  html_url: 'https://github.com/example-org/bread-docs/pull/172',
  title: 'docs: Update docs from Bread',
  body: null,
  state: 'closed' as const,
  merged: true,
  merged_at: '2026-08-13T00:10:00Z',
  merge_commit_sha: 'bf962c8',
  head: { ref: 'bread/docs-docs-example' },
  user: null,
  created_at: '2026-08-13T00:00:00Z',
  updated_at: '2026-08-13T00:10:00Z',
}

describe('resolveGitHubHostedDocsActivation', () => {
  it('checks the exact persisted pull request for new links', async () => {
    const getPR = vi.fn().mockResolvedValue(mergedPullRequest)

    await expect(
      resolveGitHubHostedDocsActivation(source, {
        getToken: vi.fn().mockResolvedValue('token'),
        getPR,
      }),
    ).resolves.toEqual({
      state: 'merged',
      pullRequestNumber: 172,
      pullRequestUrl: mergedPullRequest.html_url,
      ref: 'bf962c8',
    })
    expect(getPR).toHaveBeenCalledWith(
      'token',
      'example-org/bread-docs',
      172,
    )
  })

  it('recovers legacy rows by matching their generated branch prefix', async () => {
    const listClosedPRs = vi.fn().mockResolvedValue([
      { ...mergedPullRequest, head: { ref: 'feature/unrelated' } },
      mergedPullRequest,
    ])

    await expect(
      resolveGitHubHostedDocsActivation(
        {
          ...source,
          pending_pull_request_number: null,
          pending_pull_request_url: null,
          pending_pull_request_head: null,
        },
        {
          getToken: vi.fn().mockResolvedValue('token'),
          listClosedPRs,
        },
      ),
    ).resolves.toMatchObject({ state: 'merged', pullRequestNumber: 172 })
  })

  it('reports a pull request that was closed without merging', async () => {
    await expect(
      resolveGitHubHostedDocsActivation(source, {
        getToken: vi.fn().mockResolvedValue('token'),
        getPR: vi.fn().mockResolvedValue({
          ...mergedPullRequest,
          merged: false,
          merged_at: null,
        }),
      }),
    ).resolves.toMatchObject({ state: 'closed', pullRequestNumber: 172 })
  })

  it('continues waiting while the pull request is open', async () => {
    await expect(
      resolveGitHubHostedDocsActivation(source, {
        getToken: vi.fn().mockResolvedValue('token'),
        getPR: vi.fn().mockResolvedValue({
          ...mergedPullRequest,
          state: 'open',
          merged: false,
          merged_at: null,
        }),
      }),
    ).resolves.toEqual({ state: 'waiting' })
  })
})
