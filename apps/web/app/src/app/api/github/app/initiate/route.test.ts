/**
 * Chunk 4 — GitHub App install initiate route tests
 *
 * Tests the authenticated redirect flow that sends users to GitHub's
 * App installation page with a signed state parameter for CSRF protection.
 *
 * All external dependencies are mocked:
 *   - Supabase server client (for auth)
 *   - Workspace resolution (for role checks)
 *   - Environment variables
 *
 * State signing is tested with real crypto: the test decodes the state
 * from the redirect URL and verifies the HMAC signature.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac, timingSafeEqual } from 'crypto'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/db/workspace', () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock('@/lib/db/subscription', () => ({
  isWorkspaceOnPaidTier: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { GET } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSupabaseMock(user: { id: string } | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
  }
}

function getRedirectUrl(response: Response): URL {
  return new URL(response.headers.get('Location')!)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/github/app/initiate', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example.com')
    vi.stubEnv('GITHUB_APP_SLUG', 'breezify-dev')
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-webhook-secret')
    vi.mocked(isWorkspaceOnPaidTier).mockResolvedValue(true)
  })

  it('redirects to the GitHub App install page for an admin user', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ id: 'user-1' }) as unknown as Awaited<ReturnType<typeof createClient>>)
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: 'membership-1', workspace_id: 'ws-1', role: 'admin',
    })

    const res = await GET(new NextRequest('https://app.example.dev/api/github/app/initiate'))
    const location = getRedirectUrl(res)

    expect(location.origin + location.pathname).toBe(
      'https://github.com/apps/breezify-dev/installations/new',
    )
    expect(location.searchParams.has('state')).toBe(true)
  })

  it('includes workspace and user data in the HMAC-signed state', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ id: 'user-1' }) as unknown as Awaited<ReturnType<typeof createClient>>)
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: 'membership-1', workspace_id: 'ws-1', role: 'owner',
    })

    const res = await GET(new NextRequest('https://app.example.dev/api/github/app/initiate'))
    const location = getRedirectUrl(res)
    const state = location.searchParams.get('state')!

    // Split at last dot: payload.signature
    const dotIndex = state.lastIndexOf('.')
    expect(dotIndex).toBeGreaterThan(0)

    const payload = state.slice(0, dotIndex)
    const sig = state.slice(dotIndex + 1)

    // Verify HMAC matches
    const expectedSig = createHmac('sha256', 'test-webhook-secret')
      .update(payload)
      .digest('hex')
    expect(
      timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig)),
    ).toBe(true)

    // Verify payload content
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      workspaceId: string
      userId: string
      exp: number
    }
    expect(decoded.workspaceId).toBe('ws-1')
    expect(decoded.userId).toBe('user-1')
    // exp should be ~15 minutes in the future
    expect(decoded.exp).toBeGreaterThan(Date.now())
    expect(decoded.exp).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 1000)
  })

  it('redirects with error=unauthorized when there is no user session', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock(null) as unknown as Awaited<ReturnType<typeof createClient>>)

    const res = await GET(new NextRequest('https://app.example.dev/api/github/app/initiate'))
    const location = getRedirectUrl(res)

    expect(location.searchParams.get('error')).toBe('unauthorized')
    expect(location.pathname).toBe('/settings/integrations/github')
  })

  it('redirects with error=unauthorized when the user is not admin or owner', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ id: 'user-1' }) as unknown as Awaited<ReturnType<typeof createClient>>)
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: 'membership-1', workspace_id: 'ws-1', role: 'viewer',
    })

    const res = await GET(new NextRequest('https://app.example.dev/api/github/app/initiate'))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('unauthorized')
  })

  it('redirects with error=unauthorized when the user has no workspace', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ id: 'user-1' }) as unknown as Awaited<ReturnType<typeof createClient>>)
    vi.mocked(getActiveWorkspace).mockResolvedValue(null)

    const res = await GET(new NextRequest('https://app.example.dev/api/github/app/initiate'))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('unauthorized')
  })

  it('redirects with error=payment_required when the workspace is free', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ id: 'user-1' }) as unknown as Awaited<ReturnType<typeof createClient>>)
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: 'membership-1', workspace_id: 'ws-1', role: 'admin',
    })
    vi.mocked(isWorkspaceOnPaidTier).mockResolvedValue(false)

    const res = await GET(new NextRequest('https://app.example.dev/api/github/app/initiate'))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('payment_required')
  })

  it('redirects with error=server_misconfigured when GITHUB_APP_SLUG is missing', async () => {
    vi.stubEnv('GITHUB_APP_SLUG', '')
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ id: 'user-1' }) as unknown as Awaited<ReturnType<typeof createClient>>)
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: 'membership-1', workspace_id: 'ws-1', role: 'admin',
    })

    const res = await GET(new NextRequest('https://app.example.dev/api/github/app/initiate'))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('server_misconfigured')
  })

  it('redirects with error=server_misconfigured when GITHUB_WEBHOOK_SECRET is missing', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')
    vi.mocked(createClient).mockResolvedValue(makeSupabaseMock({ id: 'user-1' }) as unknown as Awaited<ReturnType<typeof createClient>>)
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: 'membership-1', workspace_id: 'ws-1', role: 'admin',
    })

    const res = await GET(new NextRequest('https://app.example.dev/api/github/app/initiate'))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('server_misconfigured')
  })
})
