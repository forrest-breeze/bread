import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  paid: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  buildExport: vi.fn(),
  resolveDiff: vi.fn(),
  revert: vi.fn(),
}))

vi.mock('@/lib/auth/route-auth', () => ({
  requireRouteUser: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}))
vi.mock('@/lib/db/workspace', () => ({ getActiveWorkspace: mocks.workspace }))
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
    assertBreadHostedDocsFiles: vi.fn(),
    BreadDocsFormatError,
  }
})
vi.mock('@/lib/github/github-hosted-workspace', () => ({
  buildBreadWorkspaceExport: mocks.buildExport,
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
    HostedWorkspacePublishError,
    resolveHostedWorkspacePublishDiff: mocks.resolveDiff,
  }
})
vi.mock('@/lib/github/github-hosted-workspace-revert', () => {
  class HostedWorkspaceRevertError extends Error {
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
    HostedWorkspaceRevertError,
    revertHostedWorkspaceChanges: mocks.revert,
  }
})

import { POST } from './route'

function request(paths: string[]): NextRequest {
  return new NextRequest(
    'https://app.example.dev/api/github/hosted-docs/publish/revert',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths }),
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

function updateBuilder() {
  const chain: Record<string, any> = {}
  chain.update = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.then = vi.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve({ error: null }).then(resolve),
  )
  return chain
}

const source = {
  id: 'source-1',
  workspace_id: 'workspace-1',
  repo_id: 42,
  repo_full_name: 'acme/docs',
  paths: ['docs'],
  root_folder_id: 'folder-1',
  sync_status: 'synced',
  publish_operation_id: null,
}

const exported = {
  files: [{
    documentId: '11111111-1111-4111-8111-111111111111',
    path: 'docs/setup.md',
    content: 'new',
  }],
  managedPaths: ['docs/setup.md'],
}

describe('/api/github/hosted-docs/publish/revert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.workspace.mockResolvedValue({
      workspace_id: 'workspace-1',
      role: 'editor',
    })
    mocks.paid.mockResolvedValue(true)
    mocks.from
      .mockReturnValueOnce(selectBuilder(source))
      .mockReturnValueOnce(updateBuilder())
    mocks.rpc.mockResolvedValue({
      data: [{
        ...source,
        publish_operation_id: 'operation-1',
        publish_operation_started_at: '2026-08-29T12:00:00.000Z',
      }],
      error: null,
    })
    mocks.buildExport.mockResolvedValue(exported)
    mocks.resolveDiff.mockResolvedValue({
      files: [{
        path: 'docs/setup.md',
        status: 'modified',
        previous: 'old',
        next: 'new',
        previousBlobSha: 'blob-old',
      }],
      changedFileCount: 1,
      truncated: false,
      comparedCommitSha: 'commit-1',
    })
    mocks.revert.mockResolvedValue({
      revertedPaths: ['docs/setup.md'],
      documentIds: ['11111111-1111-4111-8111-111111111111'],
    })
  })

  it('reverts only the selected current diff paths', async () => {
    const response = await POST(request(['docs/setup.md']))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.revert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'workspace-1',
        selectedPaths: ['docs/setup.md'],
        comparedCommitSha: 'commit-1',
      }),
    )
    expect(body).toEqual({
      reverted_paths: ['docs/setup.md'],
      reverted_document_ids: ['11111111-1111-4111-8111-111111111111'],
    })
  })

  it('applies the same editor role gate before using the admin client', async () => {
    mocks.workspace.mockResolvedValue({
      workspace_id: 'workspace-1',
      role: 'viewer',
    })

    const response = await POST(request(['docs/setup.md']))

    expect(response.status).toBe(403)
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.revert).not.toHaveBeenCalled()
  })

  it('does not race an active commit or revert lease', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null })

    const response = await POST(request(['docs/setup.md']))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.code).toBe('publish_in_progress')
    expect(mocks.revert).not.toHaveBeenCalled()
  })

  it('rejects duplicate paths before reading the hosted source', async () => {
    const response = await POST(
      request(['docs/setup.md', 'docs/setup.md']),
    )

    expect(response.status).toBe(400)
    expect(mocks.from).not.toHaveBeenCalled()
  })
})
