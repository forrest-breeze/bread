import type { GitHubHostedDocsSourceRow } from '@bread/core'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  paid: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  buildExport: vi.fn(),
  listRepos: vi.fn(),
  getToken: vi.fn(),
  getRepository: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  createBranch: vi.fn(),
  createFilesCommit: vi.fn(),
  createPullRequest: vi.fn(),
}))

vi.mock('@/lib/auth/route-auth', () => ({
  requireRouteUser: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}))
vi.mock('@/lib/db/workspace', () => ({ getActiveWorkspace: mocks.getWorkspace }))
vi.mock('@/lib/db/subscription', () => ({ isWorkspaceOnPaidTier: mocks.paid }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ from: mocks.from, rpc: mocks.rpc })),
}))
vi.mock('@/lib/github/github-hosted-bootstrap', () => ({
  githubHostedDocsBranchPrefix: () => 'bread/docs-docs-',
  githubHostedDocsPullRequestTitle: () => 'Create docs from Bread',
  normalizeBootstrapTargetPath: (path: string) => path,
}))
vi.mock('@/lib/github/github-hosted-format', () => ({
  assertBreadHostedDocsFiles: vi.fn(),
}))
vi.mock('@/lib/github/github-hosted-workspace', () => ({
  buildBreadWorkspaceExport: mocks.buildExport,
  MAX_HOSTED_WORKSPACE_BYTES: 8 * 1024 * 1024,
  MAX_HOSTED_WORKSPACE_DOCUMENTS: 500,
}))
vi.mock('@/lib/github/github', () => ({
  createRepositoryBranch: mocks.createBranch,
  createRepositoryFilesCommit: mocks.createFilesCommit,
  createRepositoryPullRequest: mocks.createPullRequest,
  getInstallationToken: mocks.getToken,
  getRepository: mocks.getRepository,
  getRepositoryCommit: mocks.getCommit,
  getRepositoryTree: mocks.getTree,
  listInstallationRepos: mocks.listRepos,
}))
vi.mock('@/lib/github/retry', () => ({
  withGitHubRetry: <T>(operation: () => Promise<T>) => operation(),
}))

import { POST } from './route'

function source(
  overrides: Partial<GitHubHostedDocsSourceRow> = {},
): GitHubHostedDocsSourceRow {
  return {
    id: 'source-1',
    workspace_id: 'workspace-1',
    installation_id: 7,
    repo_full_name: 'acme/docs',
    repo_id: 42,
    paths: ['docs'],
    root_folder_id: 'folder-1',
    sync_status: 'synced',
    document_count: 1,
    conflict_count: 0,
    last_sync_commit_sha: 'base-sha',
    last_sync_at: '2026-08-18T12:00:00.000Z',
    last_sync_error: null,
    pending_pull_request_number: null,
    pending_pull_request_url: null,
    pending_pull_request_head: null,
    publish_pull_request_number: null,
    publish_pull_request_url: null,
    publish_pull_request_head: null,
    publish_last_commit_sha: null,
    publish_operation_id: null,
    publish_operation_started_at: null,
    pending_sync_mode: 'merge',
    created_by: 'user-1',
    created_at: '2026-08-18T12:00:00.000Z',
    updated_at: '2026-08-18T12:00:00.000Z',
    ...overrides,
  }
}

function request(): NextRequest {
  return new NextRequest(
    'https://app.example.dev/api/github/hosted-docs/bootstrap',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo_id: 42,
        target_path: 'docs',
        allow_existing: true,
      }),
    },
  )
}

function selectBuilder(data: unknown) {
  const chain: Record<string, any> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null })
  return chain
}

function updateBuilder(data: unknown = null) {
  const chain: Record<string, any> = {}
  for (const method of ['update', 'eq', 'select']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.single = vi.fn().mockResolvedValue({ data, error: null })
  chain.then = vi.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve({ error: null }).then(resolve),
  )
  return chain
}

function insertBuilder(data: unknown) {
  const chain: Record<string, any> = {}
  for (const method of ['insert', 'select']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.single = vi.fn().mockResolvedValue({ data, error: null })
  return chain
}

let fromQueue: Array<Record<string, any>> = []

describe('POST /api/github/hosted-docs/bootstrap reconfiguration safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fromQueue = []
    mocks.from.mockImplementation(() => {
      const next = fromQueue.shift()
      if (!next) throw new Error('Unexpected Supabase table access')
      return next
    })
    mocks.getWorkspace.mockResolvedValue({
      workspace_id: 'workspace-1',
      role: 'admin',
    })
    mocks.paid.mockResolvedValue(true)
    mocks.listRepos.mockResolvedValue([{ id: 42, full_name: 'acme/docs' }])
    mocks.buildExport.mockResolvedValue({
      files: [{ path: 'docs/readme.md', content: '# Readme\n' }],
      documents: [{ id: 'document-1' }],
      restrictedFolderNames: [],
      totalBytes: 9,
    })
    mocks.getToken.mockResolvedValue('token')
    mocks.getRepository.mockResolvedValue({
      id: 42,
      full_name: 'acme/docs',
      default_branch: 'main',
      private: true,
    })
    mocks.getCommit.mockResolvedValue({
      sha: 'base-sha',
      commit: { tree: { sha: 'base-tree' } },
    })
    mocks.getTree.mockResolvedValue({
      sha: 'base-tree',
      truncated: false,
      tree: [{ path: 'docs', mode: '040000', type: 'tree', sha: 'docs-tree' }],
    })
    mocks.createBranch.mockResolvedValue({
      ref: 'refs/heads/bread/docs-docs-test',
      object: { type: 'commit', sha: 'base-sha' },
    })
    mocks.createFilesCommit.mockResolvedValue({
      sha: 'bootstrap-sha',
      html_url: 'https://github.com/acme/docs/commit/bootstrap-sha',
    })
    mocks.createPullRequest.mockResolvedValue({
      number: 18,
      html_url: 'https://github.com/acme/docs/pull/18',
      state: 'open',
      title: 'Create docs from Bread',
    })
  })

  it('rejects an existing publish PR and releases the configuration lease', async () => {
    const releaseBuilder = updateBuilder()
    fromQueue = [
      selectBuilder({ installation_id: 7 }),
      selectBuilder(source()),
      releaseBuilder,
    ]
    mocks.rpc.mockResolvedValue({
      data: [
        source({
          publish_pull_request_number: 17,
          publish_pull_request_url: 'https://github.com/acme/docs/pull/17',
          publish_pull_request_head: 'bread/docs-docs-workspace-open',
          publish_operation_id: 'lease-from-db',
          publish_operation_started_at: '2026-08-18T12:01:00.000Z',
        }),
      ],
      error: null,
    })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({
      code: 'workspace_publish_pull_request_open',
      pull_request_number: 17,
      pull_request_url: 'https://github.com/acme/docs/pull/17',
    })
    expect(releaseBuilder.update).toHaveBeenCalledWith({
      publish_operation_id: null,
      publish_operation_started_at: null,
    })
    const operationId = mocks.rpc.mock.calls[0]?.[1]?.p_operation_id
    expect(releaseBuilder.eq).toHaveBeenCalledWith(
      'publish_operation_id',
      operationId,
    )
    expect(mocks.buildExport).not.toHaveBeenCalled()
    expect(mocks.createBranch).not.toHaveBeenCalled()
  })

  it('persists a check-visible source before commit and adds PR metadata afterward', async () => {
    const provisional = source({
      root_folder_id: null,
      sync_status: 'disabled',
      document_count: 0,
      last_sync_commit_sha: null,
      last_sync_at: null,
      pending_pull_request_number: null,
      pending_pull_request_url: null,
      pending_pull_request_head: 'bread/docs-docs-test',
    })
    const updated = source({
      root_folder_id: null,
      sync_status: 'disabled',
      document_count: 0,
      last_sync_commit_sha: null,
      last_sync_at: null,
      pending_pull_request_number: 18,
      pending_pull_request_url: 'https://github.com/acme/docs/pull/18',
      pending_pull_request_head: 'bread/docs-docs-test',
    })
    const provisionalSourceBuilder = updateBuilder(provisional)
    const finalSourceBuilder = updateBuilder(updated)
    fromQueue = [
      selectBuilder({ installation_id: 7 }),
      selectBuilder(source()),
      provisionalSourceBuilder,
      finalSourceBuilder,
      updateBuilder(),
    ]
    mocks.rpc.mockResolvedValue({
      data: [
        source({
          publish_operation_id: 'lease-from-db',
          publish_operation_started_at: '2026-08-18T12:01:00.000Z',
        }),
      ],
      error: null,
    })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.pull_request_number).toBe(18)
    expect(provisionalSourceBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sync_status: 'disabled',
        pending_pull_request_number: null,
        pending_pull_request_url: null,
        pending_pull_request_head: expect.stringMatching(
          /^bread\/docs-docs-/,
        ),
        publish_pull_request_number: null,
        publish_pull_request_url: null,
        publish_pull_request_head: null,
        publish_last_commit_sha: null,
      }),
    )
    const operationId = mocks.rpc.mock.calls[0]?.[1]?.p_operation_id
    expect(operationId).toEqual(expect.any(String))
    expect(provisionalSourceBuilder.eq).toHaveBeenCalledWith(
      'publish_operation_id',
      operationId,
    )
    expect(finalSourceBuilder.update).toHaveBeenCalledWith({
      pending_pull_request_number: 18,
      pending_pull_request_url: 'https://github.com/acme/docs/pull/18',
      publish_operation_id: null,
      publish_operation_started_at: null,
    })
    expect(finalSourceBuilder.eq).toHaveBeenCalledWith(
      'publish_operation_id',
      operationId,
    )
    expect(mocks.createBranch).toHaveBeenCalledOnce()
    expect(mocks.createFilesCommit).toHaveBeenCalledOnce()
    expect(mocks.createPullRequest).toHaveBeenCalledOnce()
    expect(
      provisionalSourceBuilder.single.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      mocks.createFilesCommit.mock.invocationCallOrder[0]!,
    )
    expect(
      mocks.createPullRequest.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      finalSourceBuilder.update.mock.invocationCallOrder[0]!,
    )
    const commitInput = mocks.createFilesCommit.mock.calls[0]?.[2]
    expect(commitInput.files).toEqual([
      { path: 'docs/readme.md', content: '# Readme\n' },
    ])
    expect(
      commitInput.files.some((file: { path: string }) =>
        file.path.startsWith('.github/'),
      ),
    ).toBe(false)
  })

  it('inserts a new check-visible source before authoring its first commit', async () => {
    const provisional = source({
      root_folder_id: null,
      sync_status: 'disabled',
      document_count: 0,
      last_sync_commit_sha: null,
      last_sync_at: null,
      pending_pull_request_number: null,
      pending_pull_request_url: null,
      pending_pull_request_head: 'bread/docs-docs-test',
    })
    const updated = source({
      root_folder_id: null,
      sync_status: 'disabled',
      document_count: 0,
      last_sync_commit_sha: null,
      last_sync_at: null,
      pending_pull_request_number: 18,
      pending_pull_request_url: 'https://github.com/acme/docs/pull/18',
      pending_pull_request_head: 'bread/docs-docs-test',
    })
    const provisionalSourceBuilder = insertBuilder(provisional)
    const finalSourceBuilder = updateBuilder(updated)
    fromQueue = [
      selectBuilder({ installation_id: 7 }),
      selectBuilder(null),
      provisionalSourceBuilder,
      finalSourceBuilder,
    ]

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body).toMatchObject({
      source: updated,
      pull_request_number: 18,
      pull_request_url: 'https://github.com/acme/docs/pull/18',
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(provisionalSourceBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'workspace-1',
        repo_id: 42,
        paths: ['docs'],
        sync_status: 'disabled',
        pending_pull_request_number: null,
        pending_pull_request_url: null,
        pending_pull_request_head: expect.stringMatching(
          /^bread\/docs-docs-/,
        ),
        publish_operation_id: null,
        publish_operation_started_at: null,
      }),
    )
    expect(finalSourceBuilder.update).toHaveBeenCalledWith({
      pending_pull_request_number: 18,
      pending_pull_request_url: 'https://github.com/acme/docs/pull/18',
      publish_operation_id: null,
      publish_operation_started_at: null,
    })
    expect(finalSourceBuilder.eq).toHaveBeenCalledWith('id', 'source-1')
    expect(
      provisionalSourceBuilder.single.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      mocks.createFilesCommit.mock.invocationCallOrder[0]!,
    )
    expect(
      mocks.createPullRequest.mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      finalSourceBuilder.update.mock.invocationCallOrder[0]!,
    )
  })
})
