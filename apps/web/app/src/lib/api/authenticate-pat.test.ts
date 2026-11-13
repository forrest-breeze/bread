/**
 * Tests for authenticatePAT — verifies expiry, revocation, and scope
 * returns in the happy + error paths.
 *
 * Integration surface under test:
 *   - reads token_hash, expires_at, scopes, revoked_at from personal_access_tokens
 *   - 401 when token missing or not found
 *   - 401 when expires_at is in the past
 *   - 401 when revoked_at is set
 *   - returns scopes to caller on success
 *   - still enforces workspace membership via x-breezify-workspace header
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { authenticatePAT } from './authenticate-pat'
import { createAdminClient } from '@/lib/supabase/admin'
import { resetTouchLastUsedCache } from './touch-last-used'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PatRow = {
  user_id: string
  expires_at: string
  scopes: string[]
  revoked_at: string | null
  role?: string | null
}

type MembershipRow = {
  workspace_id: string
  role?: string
}

interface MockOpts {
  patRow: PatRow | null
  patError?: { code?: string; message?: string } | null
  membershipRow?: MembershipRow | null
  membershipError?: { code?: string; message?: string } | null
  /** Result of public.user_is_breeze for the token's owner. */
  isBreeze?: boolean
}

function makeAdminMock({
  patRow,
  patError = null,
  membershipRow = null,
  membershipError = null,
  isBreeze = true,
}: MockOpts) {
  const rpc = vi.fn().mockResolvedValue({ data: isBreeze, error: null })
  const patSingle = vi.fn().mockResolvedValue({ data: patRow, error: patError })
  const membershipSingle = vi.fn().mockResolvedValue({
    data: membershipRow,
    error: membershipError,
  })
  const updateEq = vi.fn().mockResolvedValue({ error: null })

  const from = vi.fn((table: string) => {
    if (table === 'personal_access_tokens') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ single: patSingle })),
        })),
        update: vi.fn(() => ({ eq: updateEq })),
      }
    }
    if (table === 'workspace_members') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              neq: vi.fn(() => ({ single: membershipSingle })),
            })),
          })),
        })),
      }
    }
    throw new Error(`Unexpected table: ${table}`)
  })

  vi.mocked(createAdminClient).mockReturnValue({ from, rpc } as unknown as ReturnType<
    typeof createAdminClient
  >)

  return { patSingle, membershipSingle, updateEq, from, rpc }
}

function makeRequest(authHeader: string, workspace: string): NextRequest {
  const headers = new Headers()
  if (authHeader) headers.set('authorization', authHeader)
  if (workspace) headers.set('x-breezify-workspace', workspace)
  return new NextRequest('http://localhost/api/captures', { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  resetTouchLastUsedCache()
})
afterEach(() => vi.restoreAllMocks())

describe('authenticatePAT — missing token', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const req = makeRequest('', 'ws-slug')
    const { error, data } = await authenticatePAT(req)
    expect(data).toBeUndefined()
    expect(error?.status).toBe(401)
  })

  it('returns 401 when the token has no matching row', async () => {
    makeAdminMock({ patRow: null })
    const { error } = await authenticatePAT(makeRequest('Bearer breezify_pat_x', 'ws-slug'))
    expect(error?.status).toBe(401)
  })
})

describe('authenticatePAT — expiry', () => {
  it('returns 401 Token expired when expires_at is in the past', async () => {
    makeAdminMock({
      patRow: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() - 1_000).toISOString(),
        scopes: ['capture'],
        revoked_at: null,
      },
    })

    const { error, data } = await authenticatePAT(
      makeRequest('Bearer breezify_pat_expired', 'ws-slug'),
    )
    expect(data).toBeUndefined()
    expect(error?.status).toBe(401)
    const body = (await error!.json()) as { error: string }
    expect(body.error).toMatch(/expired/i)
  })

  it('accepts a token whose expires_at is in the future', async () => {
    makeAdminMock({
      patRow: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['capture'],
        revoked_at: null,
      },
      membershipRow: { workspace_id: 'ws-uuid' },
    })

    const { data, error } = await authenticatePAT(
      makeRequest('Bearer breezify_pat_ok', 'ws-slug'),
    )
    expect(error).toBeUndefined()
    expect(data?.userId).toBe('user-1')
    expect(data?.workspaceId).toBe('ws-uuid')
  })
})

describe('authenticatePAT — revocation', () => {
  it('returns 401 Token revoked when revoked_at is set', async () => {
    makeAdminMock({
      patRow: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['capture'],
        revoked_at: new Date(Date.now() - 60_000).toISOString(),
      },
    })

    const { error, data } = await authenticatePAT(
      makeRequest('Bearer breezify_pat_revoked', 'ws-slug'),
    )
    expect(data).toBeUndefined()
    expect(error?.status).toBe(401)
    const body = (await error!.json()) as { error: string }
    expect(body.error).toMatch(/revoked/i)
  })
})

describe('authenticatePAT — scopes', () => {
  it('returns scopes from the row on success', async () => {
    makeAdminMock({
      patRow: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['capture', 'read'],
        revoked_at: null,
      },
      membershipRow: { workspace_id: 'ws-uuid' },
    })

    const { data } = await authenticatePAT(
      makeRequest('Bearer breezify_pat_ok', 'ws-slug'),
    )
    expect(data?.scopes).toEqual(['capture', 'read'])
  })

  it('returns empty scopes array when the row has no scopes', async () => {
    // Defensive: the DB CHECK constraint forbids empty arrays in practice,
    // but if one slips through, authenticatePAT should still return the row's
    // (empty) scope array rather than coalescing to a default.
    makeAdminMock({
      patRow: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: [],
        revoked_at: null,
      },
      membershipRow: { workspace_id: 'ws-uuid' },
    })

    const { data } = await authenticatePAT(
      makeRequest('Bearer breezify_pat_ok', 'ws-slug'),
    )
    expect(data?.scopes).toEqual([])
  })
})

describe('authenticatePAT — effective role (downscope)', () => {
  const future = () => new Date(Date.now() + 86_400_000).toISOString()

  it('inherits the member role when the token has no role downscope', async () => {
    makeAdminMock({
      patRow: { user_id: 'u', expires_at: future(), scopes: ['read'], revoked_at: null, role: null },
      membershipRow: { workspace_id: 'ws', role: 'admin' },
    })
    const { data } = await authenticatePAT(makeRequest('Bearer breezify_pat_ok', 'ws-slug'))
    expect(data?.role).toBe('admin')
  })

  it('downscopes below the member role when the token role is lower', async () => {
    makeAdminMock({
      patRow: { user_id: 'u', expires_at: future(), scopes: ['read'], revoked_at: null, role: 'viewer' },
      membershipRow: { workspace_id: 'ws', role: 'admin' },
    })
    const { data } = await authenticatePAT(makeRequest('Bearer breezify_pat_ok', 'ws-slug'))
    expect(data?.role).toBe('viewer')
  })

  it('never escalates above the member role even if the token role is higher', async () => {
    makeAdminMock({
      patRow: { user_id: 'u', expires_at: future(), scopes: ['read'], revoked_at: null, role: 'admin' },
      membershipRow: { workspace_id: 'ws', role: 'viewer' },
    })
    const { data } = await authenticatePAT(makeRequest('Bearer breezify_pat_ok', 'ws-slug'))
    expect(data?.role).toBe('viewer')
  })
})

describe('authenticatePAT — workspace membership', () => {
  it('returns 400 when x-breezify-workspace header is missing', async () => {
    makeAdminMock({
      patRow: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['capture'],
        revoked_at: null,
      },
    })

    const req = new NextRequest('http://localhost/api/captures', {
      headers: { authorization: 'Bearer breezify_pat_ok' },
    })
    const { error } = await authenticatePAT(req)
    expect(error?.status).toBe(400)
  })

  it('returns 403 when user is not a member of the requested workspace', async () => {
    makeAdminMock({
      patRow: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['capture'],
        revoked_at: null,
      },
      membershipRow: null,
      membershipError: { code: 'PGRST116' },
    })

    const { error } = await authenticatePAT(
      makeRequest('Bearer breezify_pat_ok', 'other-ws'),
    )
    expect(error?.status).toBe(403)
  })
})


describe('authenticatePAT — Breeze accounts only', () => {
  it('returns 403 when the token belongs to a non-Breeze account', async () => {
    const { rpc } = makeAdminMock({
      patRow: {
        user_id: 'user-x',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['read'],
        revoked_at: null,
        role: null,
      },
      membershipRow: { workspace_id: 'ws-1', role: 'editor' },
      isBreeze: false,
    })
    const result = await authenticatePAT(makeRequest('Bearer breezify_sk_x', 'breeze'))
    expect(result.data).toBeUndefined()
    expect(result.error?.status).toBe(403)
    expect(rpc).toHaveBeenCalledWith('user_is_breeze', { p_user_id: 'user-x' })
  })
})
