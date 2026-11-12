/**
 * Chunk 6 — GitHub integrations CRUD route tests
 *
 * Tests the authenticated route that manages the GitHub App integration
 * for the caller's workspace:
 *
 *   GET    — returns the integration row (if any)
 *   DELETE — removes the integration and cascading data
 *
 * All external dependencies are mocked:
 *   - Supabase server client (auth)
 *   - Supabase admin client (DB reads/writes)
 *   - getActiveWorkspace (workspace resolution)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { GitHubIntegrationRow } from '@bread/core'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { mockGetUser } = vi.hoisted(() => {
  const mockGetUser = vi.fn()
  return { mockGetUser }
})

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

import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { GET, DELETE } from './route'

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseIntegration: GitHubIntegrationRow = {
  id: 'int-1',
  workspace_id: 'ws-1',
  github_account_login: 'acmecorp',
  github_account_type: 'Organization',
  installation_id: 12345678,
  installed_by: 'user-1',
  created_at: '2026-03-28T00:00:00Z',
  updated_at: '2026-03-28T00:00:00Z',
}

function mockAuth(role: string = 'admin'): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: 'wm-1',
    workspace_id: 'ws-1',
    role,
  })
}

function makeRequest(method: string = 'GET'): NextRequest {
  return new NextRequest('https://app.example.dev/api/github/integrations', { method })
}

// ---------------------------------------------------------------------------
// Admin mock factory
// ---------------------------------------------------------------------------

function makeAdminMock({
  integration = baseIntegration as GitHubIntegrationRow | null,
  selectError = null as null | { message: string },
  deleteError = null as null | { message: string },
} = {}) {
  const maybeSingleFn = vi.fn().mockResolvedValue({
    data: integration,
    error: selectError,
  })
  const selectEqFn = vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn })
  const selectFn = vi.fn().mockReturnValue({ eq: selectEqFn })

  const deleteEqFn = vi.fn().mockResolvedValue({ error: deleteError })
  const deleteFn = vi.fn().mockReturnValue({ eq: deleteEqFn })

  const fromFn = vi.fn().mockReturnValue({
    select: selectFn,
    delete: deleteFn,
  })

  return {
    client: { from: fromFn },
    mocks: { fromFn, selectFn, selectEqFn, maybeSingleFn, deleteFn, deleteEqFn },
  }
}

// ===========================================================================
// GET /api/github/integrations
// ===========================================================================

describe('GET /api/github/integrations', () => {
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('allows any workspace member to read status', async () => {
    mockAuth('member')
    const { client } = makeAdminMock({ integration: null })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.integration).toBeNull()
  })

  it('returns null integration when none exists for the workspace', async () => {
    mockAuth()
    const { client } = makeAdminMock({ integration: null })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.integration).toBeNull()
  })

  it('returns the integration for the workspace', async () => {
    mockAuth()
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.integration.github_account_login).toBe('acmecorp')
    expect(body.integration.installation_id).toBe(12345678)
  })

  it('queries the correct table and workspace_id', async () => {
    mockAuth()
    const { client, mocks } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    await GET(makeRequest())

    expect(mocks.fromFn).toHaveBeenCalledWith('github_integrations')
    expect(mocks.selectEqFn).toHaveBeenCalledWith('workspace_id', 'ws-1')
  })

  it('returns 500 on database error', async () => {
    mockAuth()
    const { client } = makeAdminMock({ selectError: { message: 'connection failed' } })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(makeRequest())

    expect(res.status).toBe(500)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('GET /api/github/integrations'),
      expect.anything(),
    )
    consoleSpy.mockRestore()
  })

  it('allows owner role access', async () => {
    mockAuth('owner')
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
  })
})

// ===========================================================================
// DELETE /api/github/integrations
// ===========================================================================

describe('DELETE /api/github/integrations', () => {
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const res = await DELETE(makeRequest('DELETE'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when user is not admin/owner', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: 'wm-1',
      workspace_id: 'ws-1',
      role: 'member',
    })

    const res = await DELETE(makeRequest('DELETE'))
    expect(res.status).toBe(401)
  })

  it('deletes the integration and returns ok', async () => {
    mockAuth()
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const res = await DELETE(makeRequest('DELETE'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
  })

  it('deletes from the correct table for the workspace', async () => {
    mockAuth()
    const { client, mocks } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    await DELETE(makeRequest('DELETE'))

    expect(mocks.fromFn).toHaveBeenNthCalledWith(1, 'github_hosted_docs_sources')
    expect(mocks.fromFn).toHaveBeenNthCalledWith(2, 'github_integrations')
    expect(mocks.deleteEqFn).toHaveBeenCalledTimes(2)
    expect(mocks.deleteEqFn).toHaveBeenCalledWith('workspace_id', 'ws-1')
  })

  it('returns 500 on database error', async () => {
    mockAuth()
    const { client } = makeAdminMock({ deleteError: { message: 'fk constraint' } })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await DELETE(makeRequest('DELETE'))

    expect(res.status).toBe(500)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('DELETE /api/github/integrations'),
      expect.anything(),
    )
    consoleSpy.mockRestore()
  })
})
