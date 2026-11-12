import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { GitHubHostedDocsSourceRow } from '@bread/core'

const mocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  paid: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  listRepos: vi.fn(),
  buildExport: vi.fn(),
  inspect: vi.fn(),
  publish: vi.fn(),
  assertFormat: vi.fn(),
  createBranchName: vi.fn(() => 'bread/docs-docs-workspace-reserved'),
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
vi.mock('@/lib/github/github-hosted-workspace', () => ({
  buildBreadWorkspaceExport: mocks.buildExport,
  MAX_HOSTED_WORKSPACE_BYTES: 8 * 1024 * 1024,
  MAX_HOSTED_WORKSPACE_DOCUMENTS: 500,
}))
vi.mock('@/lib/github/github-hosted-workspace-publish', () => {
  class HostedWorkspacePublishError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
      readonly details: Record<string, unknown> = {},
    ) {
      super(message)
    }
  }
  return {
    createHostedWorkspacePublishBranch: mocks.createBranchName,
    HostedWorkspacePublishError,
    inspectHostedWorkspacePublish: mocks.inspect,
    isHostedWorkspacePublishBranch: (head: string | null) =>
      head?.startsWith('bread/docs-docs-workspace-') === true,
    publishHostedWorkspaceToGitHub: mocks.publish,
  }
})
vi.mock('@/lib/github/github', () => ({ listInstallationRepos: mocks.listRepos }))
vi.mock('@/lib/github/retry', () => ({
  withGitHubRetry: <T>(operation: () => Promise<T>) => operation(),
}))

import { GET, POST } from './route'
import { HostedWorkspacePublishError } from '@/lib/github/github-hosted-workspace-publish'

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

function request(body: unknown = {}): NextRequest {
  return new NextRequest('https://app.example.dev/api/github/hosted-docs/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null })
  chain.then = vi.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve({ error: null }).then(resolve),
  )
  return chain
}

const exported = {
  files: [{
    documentId: '00000000-0000-4000-8000-000000000001',
    path: 'docs/setup.md',
    content: 'content',
  }],
  documents: [{ id: '00000000-0000-4000-8000-000000000001' }],
  managedPaths: ['docs/setup.md'],
  restrictedFolderNames: [],
  totalBytes: 7,
}

describe('/api/github/hosted-docs/publish', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWorkspace.mockResolvedValue({
      workspace_id: 'workspace-1',
      role: 'editor',
    })
    mocks.paid.mockResolvedValue(true)
    mocks.buildExport.mockResolvedValue(exported)
    mocks.listRepos.mockResolvedValue([{ id: 42, full_name: 'acme/docs' }])
    mocks.inspect.mockResolvedValue({
      status: 'up_to_date',
      changedFileCount: 0,
      writtenFileCount: 0,
      deletedFileCount: 0,
      unchangedFileCount: 1,
      comparedCommitSha: 'base-sha',
      comparisonKey: 'comparison-key',
    })
    mocks.publish.mockResolvedValue({
      branch: 'bread/docs-docs-workspace-reserved',
      commitSha: 'publish-sha',
      commitUrl: 'https://github.com/acme/docs/commit/publish-sha',
      pullRequestNumber: 17,
      pullRequestUrl: 'https://github.com/acme/docs/pull/17',
      changedFileCount: 1,
      writtenFileCount: 1,
      deletedFileCount: 0,
      reused: false,
    })
  })

  it('GET returns a private no-store equality result', async () => {
    mocks.from
      .mockReturnValueOnce(selectBuilder(source()))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'private, no-store, max-age=0',
    )
    expect(body).toEqual({
      status: 'up_to_date',
      changed_file_count: 0,
      written_file_count: 0,
      deleted_file_count: 0,
      unchanged_file_count: 1,
      compared_commit_sha: 'base-sha',
      comparison_key: 'comparison-key',
    })
    expect(mocks.inspect).toHaveBeenCalledWith({
      source: expect.objectContaining({ id: 'source-1' }),
      files: exported.files,
      managedPaths: exported.managedPaths,
    })
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('GET reports sync-required while the hosted root is still syncing', async () => {
    mocks.from.mockReturnValueOnce(
      selectBuilder(source({ sync_status: 'syncing' })),
    )

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'sync_required',
      changed_file_count: 0,
      compared_commit_sha: null,
      code: 'hosted_docs_not_synced',
    })
    expect(mocks.buildExport).not.toHaveBeenCalled()
    expect(mocks.inspect).not.toHaveBeenCalled()
  })

  it('GET exports the whole workspace: the repository root is the workspace root', async () => {
    // No container folder is linked any more; a null root_folder_id means
    // every workspace document mirrors below the selected repository path.
    mocks.from
      .mockReturnValueOnce(selectBuilder(source({ root_folder_id: null })))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'up_to_date' })
    expect(mocks.buildExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'workspace-1',
        targetPath: 'docs',
        hostedRootFolderId: null,
      }),
    )
    expect(mocks.inspect).toHaveBeenCalledOnce()
  })

  it('GET applies the same publishing role gate as POST', async () => {
    mocks.getWorkspace.mockResolvedValue({
      workspace_id: 'workspace-1',
      role: 'viewer',
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.code).toBe('insufficient_role')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('GET reports only a current publish lease as blocked', async () => {
    mocks.from.mockReturnValueOnce(
      selectBuilder(
        source({
          publish_operation_id: 'operation-1',
          publish_operation_started_at: new Date().toISOString(),
        }),
      ),
    )

    const response = await GET()
    const body = await response.json()

    expect(body).toMatchObject({
      status: 'blocked',
      code: 'publish_in_progress',
    })
    expect(mocks.inspect).not.toHaveBeenCalled()
  })

  it('GET exposes the exact changed-file counts from the shared inspector', async () => {
    mocks.from
      .mockReturnValueOnce(selectBuilder(source()))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))
    mocks.inspect.mockResolvedValue({
      status: 'changes',
      changedFileCount: 3,
      writtenFileCount: 2,
      deletedFileCount: 1,
      unchangedFileCount: 4,
      comparedCommitSha: 'base-sha',
      comparisonKey: 'comparison-key',
      pullRequestUpToDate: false,
    })

    const response = await GET()
    const body = await response.json()

    expect(body).toEqual({
      status: 'changes',
      changed_file_count: 3,
      written_file_count: 2,
      deleted_file_count: 1,
      unchanged_file_count: 4,
      compared_commit_sha: 'base-sha',
      comparison_key: 'comparison-key',
      pull_request_up_to_date: false,
    })
  })

  it('GET degrades provider failures to an unavailable status', async () => {
    mocks.from
      .mockReturnValueOnce(selectBuilder(source()))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))
    mocks.inspect.mockRejectedValue(new Error('GitHub timeout'))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'unavailable',
      changed_file_count: 0,
      code: 'github_publish_status_unavailable',
    })
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('requires an explicit Bread-wins acknowledgement for conflicts', async () => {
    mocks.from.mockReturnValueOnce(selectBuilder(source({ conflict_count: 2 })))

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({
      code: 'conflict_resolution_required',
      conflict_count: 2,
    })
    expect(mocks.listRepos).not.toHaveBeenCalled()
  })

  it('POST publishes the whole workspace when no container folder is linked', async () => {
    const initial = source({ root_folder_id: null })
    const leased = source({
      root_folder_id: null,
      publish_operation_id: 'lease-from-db',
      publish_operation_started_at: '2026-08-18T12:01:00.000Z',
    })
    const reserved = {
      ...leased,
      publish_pull_request_head: 'bread/docs-docs-workspace-reserved',
    }
    mocks.from
      .mockReturnValueOnce(selectBuilder(initial))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))
      .mockReturnValueOnce(updateBuilder(reserved))
      .mockReturnValueOnce(updateBuilder({ ...reserved, publish_pull_request_number: 17 }))
      .mockReturnValueOnce(updateBuilder())
    mocks.rpc.mockResolvedValue({ data: [leased], error: null })

    const response = await POST(request())

    expect(response.status).toBe(201)
    expect(mocks.buildExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hostedRootFolderId: null }),
    )
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('rejects when another request holds the publish lease', async () => {
    mocks.from
      .mockReturnValueOnce(selectBuilder(source({ conflict_count: 1 })))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))
    mocks.rpc.mockResolvedValue({ data: [], error: null })

    const response = await POST(request({ conflict_resolution: 'bread' }))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.code).toBe('publish_in_progress')
    expect(mocks.rpc).toHaveBeenCalledWith(
      'acquire_github_hosted_docs_publish_lease',
      expect.objectContaining({
        p_source_id: 'source-1',
        p_workspace_id: 'workspace-1',
      }),
    )
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('cross-checks the source against the workspace GitHub installation', async () => {
    mocks.from
      .mockReturnValueOnce(selectBuilder(source()))
      .mockReturnValueOnce(selectBuilder({ installation_id: 99 }))

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.code).toBe('github_integration_mismatch')
    expect(mocks.listRepos).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('reserves a head, publishes once, and persists the provider pointer', async () => {
    const initial = source()
    const leased = source({
      publish_operation_id: 'lease-from-db',
      publish_operation_started_at: '2026-08-18T12:01:00.000Z',
    })
    const reserved = {
      ...leased,
      publish_pull_request_head: 'bread/docs-docs-workspace-reserved',
    }
    const updated = {
      ...reserved,
      publish_pull_request_number: 17,
      publish_pull_request_url: 'https://github.com/acme/docs/pull/17',
      publish_last_commit_sha: 'publish-sha',
    }
    const reservationBuilder = updateBuilder(reserved)
    const pointerBuilder = updateBuilder(updated)
    const releaseBuilder = updateBuilder()
    mocks.from
      .mockReturnValueOnce(selectBuilder(initial))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))
      .mockReturnValueOnce(reservationBuilder)
      .mockReturnValueOnce(pointerBuilder)
      .mockReturnValueOnce(releaseBuilder)
    mocks.rpc.mockResolvedValue({ data: [leased], error: null })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body).toMatchObject({
      pull_request_number: 17,
      branch: 'bread/docs-docs-workspace-reserved',
      changed_file_count: 1,
    })
    expect(mocks.publish).toHaveBeenCalledOnce()
    expect(pointerBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        publish_pull_request_number: 17,
        publish_pull_request_head: 'bread/docs-docs-workspace-reserved',
        publish_last_commit_sha: 'publish-sha',
      }),
    )
    expect(releaseBuilder.update).toHaveBeenCalledWith({
      publish_operation_id: null,
      publish_operation_started_at: null,
    })
  })

  it('passes a unique selected path set to the GitHub commit', async () => {
    const initial = source()
    const leased = source({
      publish_operation_id: 'lease-from-db',
      publish_operation_started_at: '2026-08-18T12:01:00.000Z',
    })
    const reserved = {
      ...leased,
      publish_pull_request_head: 'bread/docs-docs-workspace-reserved',
    }
    mocks.from
      .mockReturnValueOnce(selectBuilder(initial))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))
      .mockReturnValueOnce(updateBuilder(reserved))
      .mockReturnValueOnce(updateBuilder(reserved))
      .mockReturnValueOnce(updateBuilder())
    mocks.rpc.mockResolvedValue({ data: [leased], error: null })

    const response = await POST(request({ paths: ['docs/setup.md'] }))

    expect(response.status).toBe(201)
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedPaths: ['docs/setup.md'],
      }),
    )
  })

  it('rejects duplicate selected paths before any provider or database work', async () => {
    const response = await POST(
      request({ paths: ['docs/setup.md', 'docs/setup.md'] }),
    )

    expect(response.status).toBe(400)
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('clears a recovered reservation when the synchronized root has no changes', async () => {
    const existingHead = 'bread/docs-docs-workspace-recovered'
    const initial = source({ publish_pull_request_head: existingHead })
    const leased = source({
      publish_pull_request_head: existingHead,
      publish_operation_id: 'lease-from-db',
      publish_operation_started_at: '2026-08-18T12:01:00.000Z',
    })
    const cleanupBuilder = updateBuilder()
    const releaseBuilder = updateBuilder()
    mocks.from
      .mockReturnValueOnce(selectBuilder(initial))
      .mockReturnValueOnce(selectBuilder({ installation_id: 7 }))
      .mockReturnValueOnce(cleanupBuilder)
      .mockReturnValueOnce(releaseBuilder)
    mocks.rpc.mockResolvedValue({ data: [leased], error: null })
    mocks.publish.mockRejectedValue(
      new HostedWorkspacePublishError(
        'The GitHub docs root already matches the Bread workspace.',
        409,
        'no_changes',
      ),
    )

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.code).toBe('no_changes')
    expect(cleanupBuilder.update).toHaveBeenCalledWith({
      publish_pull_request_number: null,
      publish_pull_request_url: null,
      publish_pull_request_head: null,
      publish_last_commit_sha: null,
    })
    expect(releaseBuilder.update).toHaveBeenCalledOnce()
  })
})
