import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { GitHubHostedDocsSourceRow } from '@bread/core'

const mocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  paid: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  listRepos: vi.fn(),
  getToken: vi.fn(),
  getRepository: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  getBlob: vi.fn(),
  syncDocs: vi.fn(),
  afterCallbacks: [] as Array<() => void | Promise<void>>,
  assertFormat: vi.fn(),
  buildExport: vi.fn(),
  linkDocuments: vi.fn(),
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return {
    ...actual,
    after: vi.fn((callback: () => void | Promise<void>) => {
      mocks.afterCallbacks.push(callback)
    }),
  }
})

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
vi.mock('@/lib/github/github-hosted-docs', () => ({
  normalizeHostedDocsPaths: (paths: string[]) => paths,
  syncGitHubHostedDocs: mocks.syncDocs,
}))
vi.mock('@/lib/github/github-hosted-docs-activation', () => ({
  resolveGitHubHostedDocsActivation: vi.fn(),
}))
vi.mock('@/lib/github/github', () => ({
  getInstallationToken: mocks.getToken,
  getRepository: mocks.getRepository,
  getRepositoryBlob: mocks.getBlob,
  getRepositoryCommit: mocks.getCommit,
  getPullRequest: vi.fn(),
  getRepositoryTree: mocks.getTree,
  listInstallationRepos: mocks.listRepos,
}))
vi.mock('@/lib/github/retry', () => ({
  withGitHubRetry: <T>(operation: () => Promise<T>) => operation(),
}))
vi.mock('@/lib/github/github-hosted-workspace-publish', () => ({
  isHostedWorkspacePublishBranch: vi.fn(() => true),
}))
vi.mock('@/lib/github/github-hosted-workspace', () => ({
  buildBreadWorkspaceExport: mocks.buildExport,
  linkBreadWorkspaceDocuments: mocks.linkDocuments,
  MAX_HOSTED_WORKSPACE_BYTES: 8 * 1024 * 1024,
  MAX_HOSTED_WORKSPACE_DOCUMENTS: 500,
}))
vi.mock('@/lib/github/github-hosted-format', () => {
  class BreadDocsFormatError extends Error {
    issues: unknown[] = []
  }
  return {
    assertBreadHostedDocsFiles: mocks.assertFormat,
    BreadDocsFormatError,
    BREAD_HOSTED_DOC_MAX_BYTES: 256 * 1024,
  }
})

import { GET, PUT } from './route'

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

function request(mode: 'merge' | 'github_wins' = 'merge'): NextRequest {
  return new NextRequest('https://app.example.dev/api/github/hosted-docs', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: 42, root_path: 'docs', mode }),
  })
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
  for (const method of ['update', 'eq', 'is', 'select']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.single = vi.fn().mockResolvedValue({ data, error: null })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null })
  chain.then = vi.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve({ error: null }).then(resolve),
  )
  return chain
}

let fromQueue: Array<Record<string, any>> = []

describe('PUT /api/github/hosted-docs reconfiguration safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.afterCallbacks.length = 0
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
      tree: [{
        path: 'docs',
        mode: '040000',
        type: 'tree',
        sha: 'docs-tree',
        url: 'https://api.github.test/trees/docs-tree',
      }],
    })
    mocks.syncDocs.mockResolvedValue(undefined)
  })

  it('returns 409 before provider mutation when the existing source lease is contended', async () => {
    fromQueue = [
      selectBuilder({ installation_id: 7 }),
      selectBuilder(source()),
    ]
    mocks.rpc.mockResolvedValue({ data: [], error: null })

    const response = await PUT(request())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.code).toBe('hosted_docs_operation_in_progress')
    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(mocks.afterCallbacks).toHaveLength(0)
    expect(mocks.syncDocs).not.toHaveBeenCalled()
  })

  it('rejects an open workspace publish PR and releases the configuration lease', async () => {
    const leased = source({
      publish_pull_request_number: 17,
      publish_pull_request_url: 'https://github.com/acme/docs/pull/17',
      publish_pull_request_head: 'bread/docs-docs-workspace-open',
      publish_last_commit_sha: 'publish-sha',
      publish_operation_id: 'lease-from-db',
      publish_operation_started_at: '2026-08-18T12:01:00.000Z',
    })
    const releaseBuilder = updateBuilder()
    fromQueue = [
      selectBuilder({ installation_id: 7 }),
      selectBuilder(source()),
      releaseBuilder,
    ]
    mocks.rpc.mockResolvedValue({ data: [leased], error: null })

    const response = await PUT(request())
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
    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(mocks.afterCallbacks).toHaveLength(0)
    expect(mocks.syncDocs).not.toHaveBeenCalled()
  })

  it('activates an existing root without a pull request and schedules its initial sync', async () => {
    const leased = source({
      publish_operation_id: 'lease-from-db',
      publish_operation_started_at: '2026-08-18T12:01:00.000Z',
    })
    const updated = source({
      sync_status: 'pending',
      pending_pull_request_number: null,
      pending_pull_request_url: null,
      pending_pull_request_head: null,
    })
    const sourceUpdateBuilder = updateBuilder(updated)
    const releaseBuilder = updateBuilder()
    fromQueue = [
      selectBuilder({ installation_id: 7 }),
      selectBuilder(source()),
      sourceUpdateBuilder,
      releaseBuilder,
    ]
    mocks.rpc.mockResolvedValue({ data: [leased], error: null })

    const response = await PUT(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ source: updated })
    expect(body.pull_request_number).toBeUndefined()
    expect(sourceUpdateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sync_status: 'pending',
        pending_pull_request_number: null,
        pending_pull_request_url: null,
        pending_pull_request_head: null,
        publish_pull_request_number: null,
        publish_pull_request_url: null,
        publish_pull_request_head: null,
        publish_last_commit_sha: null,
        publish_operation_id: null,
        publish_operation_started_at: null,
      }),
    )
    const operationId = mocks.rpc.mock.calls[0]?.[1]?.p_operation_id
    expect(operationId).toEqual(expect.any(String))
    expect(sourceUpdateBuilder.eq).toHaveBeenCalledWith(
      'publish_operation_id',
      operationId,
    )
    expect(mocks.afterCallbacks).toHaveLength(1)
    expect(mocks.syncDocs).not.toHaveBeenCalled()

    await mocks.afterCallbacks[0]!()

    expect(mocks.syncDocs).toHaveBeenCalledOnce()
    expect(mocks.syncDocs).toHaveBeenCalledWith({
      sourceId: 'source-1',
      workspaceId: 'workspace-1',
      installationId: 7,
      repoId: 42,
      repoFullName: 'acme/docs',
      paths: ['docs'],
      rootFolderId: 'folder-1',
      documentCount: 1,
      lastSyncCommitSha: 'base-sha',
      mode: 'merge',
      ref: 'base-sha',
      force: true,
    })
  })

  it('re-links the whole workspace when GitHub wins on the same root', async () => {
    // "Use GitHub" makes the repository the source of truth below the root,
    // which is the workspace root. Every workspace document is (re)attached to
    // a repository path first, so the replace sync can update the matches in
    // place and remove the rest, and no container folder is recorded.
    const leased = source({
      publish_operation_id: 'lease-from-db',
      publish_operation_started_at: '2026-08-18T12:01:00.000Z',
    })
    const updated = source({
      sync_status: 'pending',
      root_folder_id: null,
      pending_sync_mode: 'replace_bread',
    })
    const sourceUpdateBuilder = updateBuilder(updated)
    fromQueue = [
      selectBuilder({ installation_id: 7 }),
      selectBuilder(source()),
      sourceUpdateBuilder,
      updateBuilder(),
    ]
    mocks.rpc.mockResolvedValue({ data: [leased], error: null })
    const exported = {
      files: [],
      documents: [],
      managedPaths: [],
      restrictedFolderNames: [],
      totalBytes: 0,
    }
    mocks.buildExport.mockResolvedValue(exported)
    mocks.linkDocuments.mockResolvedValue(undefined)

    const response = await PUT(request('github_wins'))

    expect(response.status).toBe(200)
    expect(mocks.buildExport).toHaveBeenCalledWith(
      expect.anything(),
      { workspaceId: 'workspace-1', targetPath: 'docs' },
    )
    expect(mocks.linkDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'workspace-1',
        repoId: 42,
        repoFullName: 'acme/docs',
        exported,
      }),
    )
    expect(sourceUpdateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        root_folder_id: null,
        pending_sync_mode: 'replace_bread',
        sync_status: 'pending',
      }),
    )

    await mocks.afterCallbacks[0]!()

    expect(mocks.syncDocs).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'replace_bread', force: true }),
    )
  })

  it('serves lightweight sync status without scanning linked documents', async () => {
    const syncingSource = source({
      sync_status: 'syncing',
      document_count: 82,
      updated_at: new Date().toISOString(),
    })
    fromQueue = [selectBuilder(syncingSource)]

    const response = await GET(
      new NextRequest(
        'https://app.example.dev/api/github/hosted-docs?summary=1',
      ),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      source: syncingSource,
      linked_folder: null,
      linked_path_count: 82,
      linked_document_count: 82,
    })
    expect(mocks.from).toHaveBeenCalledOnce()
  })

  it('locks the editors and immediately schedules a narrow sync for a newer GitHub commit', async () => {
    const current = source()
    const pending = source({
      sync_status: 'pending',
      updated_at: '2026-08-18T12:01:00.000Z',
    })
    const reservationBuilder = updateBuilder(pending)
    fromQueue = [selectBuilder(current), reservationBuilder]
    mocks.getCommit.mockResolvedValueOnce({
      sha: 'remote-sha',
      commit: { tree: { sha: 'remote-tree' } },
    })

    const response = await GET(
      new NextRequest(
        'https://app.example.dev/api/github/hosted-docs?summary=1',
      ),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.source).toEqual(pending)
    expect(reservationBuilder.update).toHaveBeenCalledWith({
      sync_status: 'pending',
      last_sync_error: null,
    })
    expect(reservationBuilder.eq).toHaveBeenCalledWith('sync_status', 'synced')
    expect(reservationBuilder.eq).toHaveBeenCalledWith(
      'last_sync_commit_sha',
      'base-sha',
    )
    expect(mocks.getTree).not.toHaveBeenCalled()
    expect(mocks.getBlob).not.toHaveBeenCalled()
    expect(mocks.afterCallbacks).toHaveLength(1)
    expect(mocks.syncDocs).not.toHaveBeenCalled()

    await mocks.afterCallbacks[0]!()

    expect(mocks.syncDocs).toHaveBeenCalledWith({
      sourceId: 'source-1',
      workspaceId: 'workspace-1',
      installationId: 7,
      repoId: 42,
      repoFullName: 'acme/docs',
      paths: ['docs'],
      rootFolderId: 'folder-1',
      documentCount: 1,
      lastSyncCommitSha: 'base-sha',
      mode: 'merge',
      ref: 'remote-sha',
    })
  })

  it('atomically resumes a hosted docs sync whose heartbeat stopped', async () => {
    const stalled = source({
      sync_status: 'syncing',
      updated_at: '2026-08-18T12:00:00.000Z',
    })
    const resumed = source({
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    })
    const recoveryBuilder = updateBuilder(resumed)
    fromQueue = [selectBuilder(stalled), recoveryBuilder]

    const response = await GET(
      new NextRequest(
        'https://app.example.dev/api/github/hosted-docs?summary=1',
      ),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.source).toEqual(resumed)
    expect(recoveryBuilder.update).toHaveBeenCalledWith({
      sync_status: 'pending',
      last_sync_error: null,
    })
    expect(recoveryBuilder.eq).toHaveBeenCalledWith('sync_status', 'syncing')
    expect(recoveryBuilder.eq).toHaveBeenCalledWith(
      'updated_at',
      stalled.updated_at,
    )
    expect(mocks.afterCallbacks).toHaveLength(1)
    expect(mocks.syncDocs).not.toHaveBeenCalled()

    await mocks.afterCallbacks[0]!()

    expect(mocks.syncDocs).toHaveBeenCalledWith({
      sourceId: 'source-1',
      workspaceId: 'workspace-1',
      installationId: 7,
      repoId: 42,
      repoFullName: 'acme/docs',
      paths: ['docs'],
      rootFolderId: 'folder-1',
      documentCount: 1,
      lastSyncCommitSha: 'base-sha',
      mode: 'merge',
    })
  })
})
