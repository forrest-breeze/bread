/**
 * Chunk 6 — GitHub monitored repos CRUD route tests
 *
 * Tests the authenticated routes for managing monitored repositories:
 *
 *   GET    — lists monitored repos for the workspace
 *   POST   — adds a repo to monitored_repos
 *   PATCH  — cancels or resumes source-file indexing
 *   DELETE — removes a repo from monitored_repos
 *
 * All external dependencies are mocked:
 *   - Supabase server client (auth)
 *   - Supabase admin client (DB reads/writes)
 *   - getActiveWorkspace (workspace resolution)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { MonitoredRepoRow } from '@bread/core'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { mockGetUser } = vi.hoisted(() => {
  const mockGetUser = vi.fn()
  return { mockGetUser }
})

// Capture after() callbacks instead of running them, so the POST handler's
// background backfill never executes during route tests.
const afterCallbacks: Array<() => Promise<void>> = []

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return {
    ...actual,
    after: vi.fn((fn: () => Promise<void>) => {
      afterCallbacks.push(fn)
    }),
  }
})

// Backfill is exercised by run-sweep.test.ts; stub it here so the POST route is
// tested in isolation.
vi.mock('@/lib/github/run-sweep', () => ({
  backfillMonitoredRepo: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/github/github-repo-ingest', () => ({
  syncGitHubRepository: vi.fn().mockResolvedValue({ failed: 0 }),
}))

vi.mock('@/lib/github/github-repo-cleanup', () => ({
  deactivateGitHubRepositoryIndex: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}))

vi.mock('@/lib/db/workspace', () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock('@/lib/db/subscription', () => ({
  isWorkspaceOnPaidTier: vi.fn(),
}))

vi.mock('@/lib/github/github', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('mock-token'),
}))

import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { getInstallationToken } from '@/lib/github/github'
import { deactivateGitHubRepositoryIndex } from '@/lib/github/github-repo-cleanup'
import { syncGitHubRepository } from '@/lib/github/github-repo-ingest'
import { GET, POST, PATCH, DELETE } from './route'

afterEach(() => {
  vi.clearAllMocks()
  afterCallbacks.length = 0
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseMonitoredRepo: MonitoredRepoRow = {
  id: 'mr-1',
  workspace_id: 'ws-1',
  installation_id: 12345678,
  repo_full_name: 'acmecorp/api-service',
  repo_id: 987654321,
  created_by: 'user-1',
  created_at: '2026-03-28T00:00:00Z',
  file_sync_status: 'pending',
  file_indexing_enabled: true,
  indexed_file_count: 0,
  pending_file_count: 0,
  skipped_file_count: 0,
  failed_file_count: 0,
  last_file_sync_commit_sha: null,
  last_file_sync_at: null,
  last_file_sync_error: null,
  file_tree_truncated: false,
}

function mockAuth(role: string = 'admin'): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: 'wm-1',
    workspace_id: 'ws-1',
    role,
  })
  vi.mocked(isWorkspaceOnPaidTier).mockResolvedValue(true)
}

function makeRequest(
  method: string = 'GET',
  body?: Record<string, unknown>,
): NextRequest {
  const init: Record<string, unknown> = { method }
  if (body) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  return new NextRequest('https://app.example.dev/api/github/repos', init as never)
}

// ---------------------------------------------------------------------------
// Admin mock factory
// ---------------------------------------------------------------------------

function makeAdminMock({
  repos = [baseMonitoredRepo] as MonitoredRepoRow[],
  selectError = null as null | { message: string },
  insertData = baseMonitoredRepo as MonitoredRepoRow | null,
  insertError = null as null | { message: string },
  deleteError = null as null | { message: string },
  updateData = baseMonitoredRepo as MonitoredRepoRow | null,
  updateError = null as null | { message: string },
  integrationResult = { data: { installation_id: 12345678 }, error: null } as {
    data: { installation_id: number } | null
    error: null | { message: string }
  },
} = {}) {
  // SELECT chain for monitored_repos: .select().eq().order()
  const orderFn = vi.fn().mockResolvedValue({ data: repos, error: selectError })
  const selectEqFn = vi.fn().mockReturnValue({ order: orderFn })
  const selectFn = vi.fn().mockReturnValue({ eq: selectEqFn })

  // INSERT chain: .insert().select().single()
  const insertSingleFn = vi.fn().mockResolvedValue({
    data: insertData,
    error: insertError,
  })
  const insertSelectFn = vi.fn().mockReturnValue({ single: insertSingleFn })
  const insertFn = vi.fn().mockReturnValue({ select: insertSelectFn })

  // DELETE chain: .delete().eq().eq()
  const deleteEq2Fn = vi.fn().mockResolvedValue({ error: deleteError })
  const deleteEq1Fn = vi.fn().mockReturnValue({ eq: deleteEq2Fn })
  const deleteFn = vi.fn().mockReturnValue({ eq: deleteEq1Fn })

  // UPDATE chain: .update().eq().eq().select().maybeSingle()
  const updateMaybeSingleFn = vi.fn().mockResolvedValue({
    data: updateData,
    error: updateError,
  })
  const updateSelectFn = vi.fn().mockReturnValue({ maybeSingle: updateMaybeSingleFn })
  const updateEq2Fn = vi.fn().mockReturnValue({ select: updateSelectFn })
  const updateEq1Fn = vi.fn().mockReturnValue({ eq: updateEq2Fn })
  const updateFn = vi.fn().mockReturnValue({ eq: updateEq1Fn })

  // github_integrations lookup: .select().eq().single().overrideTypes()
  const integrationOverrideTypesFn = vi.fn().mockResolvedValue(integrationResult)
  const integrationSingleFn = vi.fn().mockReturnValue({ overrideTypes: integrationOverrideTypesFn })
  const integrationEqFn = vi.fn().mockReturnValue({ single: integrationSingleFn })
  const integrationSelectFn = vi.fn().mockReturnValue({ eq: integrationEqFn })

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'github_integrations') {
      return { select: integrationSelectFn }
    }
    return {
      select: selectFn,
      insert: insertFn,
      update: updateFn,
      delete: deleteFn,
    }
  })

  return {
    client: { from: fromFn },
    mocks: {
      fromFn,
      selectFn,
      selectEqFn,
      orderFn,
      insertFn,
      insertSingleFn,
      updateFn,
      updateEq1Fn,
      updateEq2Fn,
      updateMaybeSingleFn,
      deleteFn,
      deleteEq1Fn,
      deleteEq2Fn,
      integrationOverrideTypesFn,
    },
  }
}

// ===========================================================================
// PATCH /api/github/repos
// ===========================================================================

describe('PATCH /api/github/repos', () => {
  it('cancels file indexing without deleting the repository monitor', async () => {
    mockAuth()
    const cancelledRepo = {
      ...baseMonitoredRepo,
      file_sync_status: 'cancelled' as const,
      file_indexing_enabled: false,
    }
    const { client, mocks } = makeAdminMock({ updateData: cancelledRepo })
    vi.mocked(createAdminClient).mockReturnValue(
      client as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await PATCH(makeRequest('PATCH', {
      repo_id: 987654321,
      action: 'cancel_indexing',
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.repo.file_sync_status).toBe('cancelled')
    expect(mocks.updateFn).toHaveBeenCalledWith(expect.objectContaining({
      file_indexing_enabled: false,
      file_sync_status: 'cancelled',
    }))
    expect(afterCallbacks).toHaveLength(0)
  })

  it('resumes indexing in a background task', async () => {
    mockAuth()
    const { client, mocks } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(
      client as unknown as ReturnType<typeof createAdminClient>,
    )

    const res = await PATCH(makeRequest('PATCH', {
      repo_id: 987654321,
      action: 'resume_indexing',
    }))

    expect(res.status).toBe(200)
    expect(mocks.updateFn).toHaveBeenCalledWith(expect.objectContaining({
      file_indexing_enabled: true,
      file_sync_status: 'pending',
    }))
    expect(afterCallbacks).toHaveLength(1)
    await afterCallbacks[0]()
    expect(syncGitHubRepository).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 987654321,
      repoFullName: 'acmecorp/api-service',
    }))
  })
})

// ===========================================================================
// GET /api/github/repos
// ===========================================================================

describe('GET /api/github/repos', () => {
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when user is not admin/owner', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: 'wm-1',
      workspace_id: 'ws-1',
      role: 'member',
    })

    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns empty array when no repos are monitored', async () => {
    mockAuth()
    const { client } = makeAdminMock({ repos: [] })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.repos).toEqual([])
  })

  it('returns monitored repos for the workspace', async () => {
    mockAuth()
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.repos).toHaveLength(1)
    expect(body.repos[0].repo_full_name).toBe('acmecorp/api-service')
  })

  it('queries the correct table and workspace_id', async () => {
    mockAuth()
    const { client, mocks } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    await GET(makeRequest())

    expect(mocks.fromFn).toHaveBeenCalledWith('monitored_repos')
    expect(mocks.selectEqFn).toHaveBeenCalledWith('workspace_id', 'ws-1')
  })

  it('returns 500 on database error', async () => {
    mockAuth()
    const { client } = makeAdminMock({ selectError: { message: 'timeout' } })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(makeRequest())

    expect(res.status).toBe(500)
    consoleSpy.mockRestore()
  })
})

// ===========================================================================
// POST /api/github/repos
// ===========================================================================

describe('POST /api/github/repos', () => {
  const validBody = {
    repo_full_name: 'acmecorp/api-service',
  }

  beforeEach(() => {
    // Mock global fetch for GitHub API
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 987654321, default_branch: 'main' }),
    })
  })

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const res = await POST(makeRequest('POST', validBody))
    expect(res.status).toBe(401)
  })

  it('returns 400 when repo_full_name is missing', async () => {
    mockAuth()
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)
    const res = await POST(makeRequest('POST', {}))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { fieldErrors?: Record<string, string[]> } }
    expect(body.issues?.fieldErrors?.repo_full_name).toBeDefined()
  })

  it('returns 402 when the workspace is free', async () => {
    mockAuth()
    vi.mocked(isWorkspaceOnPaidTier).mockResolvedValue(false)

    const res = await POST(makeRequest('POST', validBody))
    const body = await res.json()

    expect(res.status).toBe(402)
    expect(body.error).toContain('paid plan')
  })

  it('returns 400 when repo_full_name is in wrong format', async () => {
    mockAuth()
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)
    const res = await POST(makeRequest('POST', { repo_full_name: 'invalid-repo' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { fieldErrors?: Record<string, string[]> } }
    expect(body.issues?.fieldErrors?.repo_full_name).toBeDefined()
  })

  it('returns 400 when workspace has no GitHub integration', async () => {
    mockAuth()
    const { client } = makeAdminMock({
      integrationResult: { data: null, error: { message: 'not found' } },
    })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await POST(makeRequest('POST', validBody))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('No GitHub integration')
  })

  it('returns 404 when repository is not found on GitHub', async () => {
    mockAuth()
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    })

    const res = await POST(makeRequest('POST', validBody))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toContain('not found')
  })

  it('inserts the repo and returns the created row', async () => {
    mockAuth()
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await POST(makeRequest('POST', validBody))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.repo.repo_full_name).toBe('acmecorp/api-service')
    expect(getInstallationToken).toHaveBeenCalledWith(12345678)
  })

  it('resolves installation_id from github_integrations, not from client', async () => {
    mockAuth()
    const { client, mocks } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    await POST(makeRequest('POST', validBody))

    expect(mocks.fromFn).toHaveBeenCalledWith('github_integrations')
    expect(mocks.fromFn).toHaveBeenCalledWith('monitored_repos')
    expect(mocks.insertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'ws-1',
        created_by: 'user-1',
        installation_id: 12345678,
        repo_full_name: 'acmecorp/api-service',
        repo_id: 987654321,
      }),
    )
  })

  it('returns 500 when insert fails', async () => {
    mockAuth()
    const { client } = makeAdminMock({
      insertData: null,
      insertError: { message: 'unique constraint' },
    })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(makeRequest('POST', validBody))

    expect(res.status).toBe(500)
    consoleSpy.mockRestore()
  })
})

// ===========================================================================
// DELETE /api/github/repos
// ===========================================================================

describe('DELETE /api/github/repos', () => {
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const res = await DELETE(
      new NextRequest('https://app.example.dev/api/github/repos?repo_id=987654321', {
        method: 'DELETE',
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when repo_id query param is missing', async () => {
    mockAuth()
    const res = await DELETE(makeRequest('DELETE'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { fieldErrors?: Record<string, string[]> } }
    expect(body.issues?.fieldErrors?.repo_id).toBeDefined()
  })

  it('returns 400 when repo_id is not a number', async () => {
    mockAuth()
    const res = await DELETE(
      new NextRequest('https://app.example.dev/api/github/repos?repo_id=abc', {
        method: 'DELETE',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('deletes the repo by workspace_id and repo_id', async () => {
    mockAuth()
    const { client, mocks } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await DELETE(
      new NextRequest('https://app.example.dev/api/github/repos?repo_id=987654321', {
        method: 'DELETE',
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(deactivateGitHubRepositoryIndex).toHaveBeenCalledWith(
      client,
      'ws-1',
      987654321,
    )
    expect(mocks.fromFn).toHaveBeenCalledWith('monitored_repos')
    expect(mocks.deleteEq1Fn).toHaveBeenCalledWith('workspace_id', 'ws-1')
    expect(mocks.deleteEq2Fn).toHaveBeenCalledWith('repo_id', 987654321)
  })

  it('returns 500 on database error', async () => {
    mockAuth()
    const { client } = makeAdminMock({ deleteError: { message: 'fk constraint' } })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await DELETE(
      new NextRequest('https://app.example.dev/api/github/repos?repo_id=987654321', {
        method: 'DELETE',
      }),
    )

    expect(res.status).toBe(500)
    consoleSpy.mockRestore()
  })

  it('keeps the monitor row when index cleanup fails', async () => {
    mockAuth()
    const { client, mocks } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)
    vi.mocked(deactivateGitHubRepositoryIndex).mockRejectedValueOnce(
      new Error('cleanup failed'),
    )

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await DELETE(
      new NextRequest('https://app.example.dev/api/github/repos?repo_id=987654321', {
        method: 'DELETE',
      }),
    )

    expect(res.status).toBe(500)
    expect(mocks.deleteFn).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
