/**
 * Focused tests for authenticateApiKey — specifically covering the W3 fix
 * from PR #54 review: the fire-and-forget `last_used_at` update must log on
 * failure instead of silently swallowing write errors. A silent swallow
 * would hide transient DB errors and RLS misconfiguration from operators.
 *
 * Scope note — this file intentionally does NOT re-test the broader
 * authenticateApiKey contract (401 / 503 / happy path). Those paths are
 * covered by the consuming route tests under `/api/v1/*`. Keep the scope of
 * this file limited to the error-visibility behavior introduced by W3.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { authenticateApiKey } from './authenticate-api-key'
import { createAdminClient } from '@/lib/supabase/admin'
import { resetTouchLastUsedCache } from './touch-last-used'

const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555'

function makeRequest(authHeader = 'Bearer breezify_sk_valid'): NextRequest {
  const headers = new Headers()
  headers.set('authorization', authHeader)
  return new NextRequest('http://localhost/api/v1/search', {
    headers,
    method: 'POST',
  })
}

function makeAdminMock(updateResult: { error: { message: string } | null }) {
  const keySingle = vi
    .fn()
    .mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null })
  const updateEq = vi.fn().mockResolvedValue(updateResult)
  const from = vi.fn((table: string) => {
    if (table === 'api_keys') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ single: keySingle })),
        })),
        update: vi.fn(() => ({ eq: updateEq })),
      }
    }
    throw new Error(`Unexpected table: ${table}`)
  })
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createAdminClient
  >)
  return { updateEq }
}

describe('authenticateApiKey — last_used_at error visibility (W3)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    resetTouchLastUsedCache()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('stays silent on console.error when the last_used_at update succeeds', async () => {
    makeAdminMock({ error: null })
    await authenticateApiKey(makeRequest())

    // Drain the microtask queue so the fire-and-forget .then() callback runs.
    await Promise.resolve()
    await Promise.resolve()

    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs once with "[Breezify] api_keys last_used_at update failed:" when the update errors', async () => {
    const mock = makeAdminMock({
      error: { message: 'permission denied for table api_keys' },
    })
    await authenticateApiKey(makeRequest())

    // Drain the microtask queue — the write error flows through the logged
    // .then() callback asynchronously.
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.updateEq).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const firstArg = errorSpy.mock.calls[0][0]
    expect(typeof firstArg).toBe('string')
    expect(firstArg as string).toContain(
      '[Breezify] api_keys last_used_at update failed:',
    )
  })
})

// ---------------------------------------------------------------------------
// Role / scopes / lifecycle (role-scoped API keys)
// ---------------------------------------------------------------------------

function makeRowMock(keyRow: Record<string, unknown> | null) {
  const single = vi
    .fn()
    .mockResolvedValue({ data: keyRow, error: keyRow ? null : { message: 'no row' } })
  const from = vi.fn(() => ({
    select: vi.fn(() => ({ eq: vi.fn(() => ({ single })) })),
    update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
  }))
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createAdminClient
  >)
}

describe('authenticateApiKey — role, scopes, and lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the stored role and scopes on the happy path', async () => {
    makeRowMock({
      workspace_id: WORKSPACE_ID,
      role: 'editor',
      scopes: ['read', 'capture'],
      expires_at: null,
      revoked_at: null,
    })
    const result = await authenticateApiKey(makeRequest())
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({
      workspaceId: WORKSPACE_ID,
      role: 'editor',
      scopes: ['read', 'capture'],
    })
  })

  it('rejects a revoked key with 401', async () => {
    makeRowMock({
      workspace_id: WORKSPACE_ID,
      role: 'viewer',
      scopes: ['read'],
      expires_at: null,
      revoked_at: '2020-01-01T00:00:00.000Z',
    })
    const result = await authenticateApiKey(makeRequest())
    expect(result.data).toBeUndefined()
    expect(result.error?.status).toBe(401)
  })

  it('rejects an expired key with 401', async () => {
    makeRowMock({
      workspace_id: WORKSPACE_ID,
      role: 'viewer',
      scopes: ['read'],
      expires_at: '2020-01-01T00:00:00.000Z',
      revoked_at: null,
    })
    const result = await authenticateApiKey(makeRequest())
    expect(result.data).toBeUndefined()
    expect(result.error?.status).toBe(401)
  })

  it('treats a null expires_at as never-expiring (legacy keys keep working)', async () => {
    makeRowMock({
      workspace_id: WORKSPACE_ID,
      role: 'viewer',
      scopes: ['read'],
      expires_at: null,
      revoked_at: null,
    })
    const result = await authenticateApiKey(makeRequest())
    expect(result.error).toBeUndefined()
    expect(result.data?.workspaceId).toBe(WORKSPACE_ID)
  })
})
