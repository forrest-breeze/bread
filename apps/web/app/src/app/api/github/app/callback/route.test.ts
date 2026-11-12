/**
 * Chunk 4 — GitHub App install callback route tests
 *
 * Tests the unauthenticated callback that GitHub redirects to after a user
 * installs the App. Responsibilities:
 *
 *   1. Verify the HMAC-signed state parameter (CSRF protection)
 *   2. Fetch installation account details from GitHub's API
 *   3. Upsert a row in github_integrations
 *   4. Redirect to the settings page with a success or error indicator
 *
 * All external dependencies are mocked:
 *   - getInstallationDetails (GitHub API)
 *   - Supabase admin client (DB writes)
 *   - Environment variables
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}))

vi.mock('@/lib/github/github', () => ({
  getInstallationDetails: vi.fn(),
}))

const { clearInstallationToken } = vi.hoisted(() => ({
  clearInstallationToken: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/github/token-cache-factory', () => ({
  getTokenCache: vi.fn(() => ({ clear: clearInstallationToken })),
}))

import { createAdminClient } from '@/lib/supabase/admin'
import { getInstallationDetails } from '@/lib/github/github'
import { GET } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'test-webhook-secret'

/** Build a valid HMAC-signed state parameter. */
function createSignedState(
  payload: Record<string, unknown>,
  secret: string = WEBHOOK_SECRET,
): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(encoded).digest('hex')
  return `${encoded}.${sig}`
}

function makeCallbackUrl(params: Record<string, string>): string {
  const url = new URL('https://app.example.dev/api/github/app/callback')
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

function getRedirectUrl(response: Response): URL {
  return new URL(response.headers.get('Location')!)
}

function makeAdminMock({
  upsertError = null as null | { message: string },
  membershipRole = 'admin' as string | null,
} = {}) {
  const upsertFn = vi.fn().mockResolvedValue({ error: upsertError })

  // workspace_members: .select().eq().eq().overrideTypes().single()
  const membershipSingleFn = vi.fn().mockResolvedValue({
    data: membershipRole ? { role: membershipRole } : null,
    error: membershipRole ? null : { message: 'not found' },
  })

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'workspace_members') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockReturnValue({
                overrideTypes: membershipSingleFn,
              }),
            }),
          }),
        }),
      }
    }
    // github_integrations
    return { upsert: upsertFn }
  })

  return { client: { from: fromFn }, mocks: { fromFn, upsertFn, membershipSingleFn } }
}

function validState(): string {
  return createSignedState({ workspaceId: 'ws-1', userId: 'user-1' })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/github/app/callback', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.dev')
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', WEBHOOK_SECRET)
    clearInstallationToken.mockReset().mockResolvedValue(undefined)
  })

  // ---- Error / missing params ----

  it('redirects with error=access_denied when GitHub sends an error param', async () => {
    const res = await GET(new NextRequest(makeCallbackUrl({ error: 'some_github_error' })))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.pathname).toBe('/settings/integrations/github')
  })

  it('redirects with error=invalid_request when installation_id is missing', async () => {
    const res = await GET(new NextRequest(makeCallbackUrl({ state: validState() })))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('invalid_request')
  })

  it('redirects with error=invalid_request when state is missing', async () => {
    const res = await GET(new NextRequest(makeCallbackUrl({ installation_id: '12345678' })))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('invalid_request')
  })

  // ---- Configuration ----

  it('redirects with error=server_misconfigured when GITHUB_WEBHOOK_SECRET is empty', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')
    const url = makeCallbackUrl({ installation_id: '12345678', state: 'some.state' })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('server_misconfigured')
  })

  // ---- State verification ----

  it('redirects with error=invalid_state when the signature does not match', async () => {
    const badState = createSignedState({ workspaceId: 'ws-1', userId: 'user-1' }, 'wrong-secret')
    const url = makeCallbackUrl({ installation_id: '12345678', state: badState })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('invalid_state')
  })

  it('redirects with error=invalid_state when state has no dot separator', async () => {
    const url = makeCallbackUrl({ installation_id: '12345678', state: 'nodot' })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('invalid_state')
  })

  it('redirects with error=invalid_state when state payload is missing workspaceId', async () => {
    const badState = createSignedState({ userId: 'user-1' })
    const url = makeCallbackUrl({ installation_id: '12345678', state: badState })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('invalid_state')
  })

  it('redirects with error=invalid_state when the state token has expired', async () => {
    const expiredState = createSignedState({
      workspaceId: 'ws-1',
      userId: 'user-1',
      exp: Date.now() - 1000, // expired 1 second ago
    })
    const url = makeCallbackUrl({ installation_id: '12345678', state: expiredState })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('invalid_state')
  })

  it('redirects with error=invalid_request when installation_id is not a number', async () => {
    const url = makeCallbackUrl({ installation_id: 'abc', state: validState() })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('invalid_request')
  })

  // ---- TOCTOU admin re-verification ----

  it('redirects with error=unauthorized when user role was downgraded since initiation', async () => {
    vi.mocked(getInstallationDetails).mockResolvedValue({
      id: 12345678,
      account: { login: 'acmecorp', type: 'Organization' },
    })
    const { client } = makeAdminMock({ membershipRole: 'member' })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const url = makeCallbackUrl({ installation_id: '12345678', state: validState() })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)

    expect(location.searchParams.get('error')).toBe('unauthorized')
  })

  it('redirects with error=unauthorized when user is no longer a workspace member', async () => {
    vi.mocked(getInstallationDetails).mockResolvedValue({
      id: 12345678,
      account: { login: 'acmecorp', type: 'Organization' },
    })
    const { client } = makeAdminMock({ membershipRole: null })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const url = makeCallbackUrl({ installation_id: '12345678', state: validState() })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)

    expect(location.searchParams.get('error')).toBe('unauthorized')
  })

  it('redirects with error=unauthorized when state has no userId', async () => {
    vi.mocked(getInstallationDetails).mockResolvedValue({
      id: 12345678,
      account: { login: 'acmecorp', type: 'Organization' },
    })
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    // State without userId
    const stateNoUser = createSignedState({ workspaceId: 'ws-1' })
    const url = makeCallbackUrl({ installation_id: '12345678', state: stateNoUser })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)

    expect(location.searchParams.get('error')).toBe('unauthorized')
  })

  it('allows owner role through the admin re-verification check', async () => {
    vi.mocked(getInstallationDetails).mockResolvedValue({
      id: 12345678,
      account: { login: 'acmecorp', type: 'Organization' },
    })
    const { client } = makeAdminMock({ membershipRole: 'owner' })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const url = makeCallbackUrl({ installation_id: '12345678', state: validState() })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)

    expect(location.searchParams.get('connected')).toBe('1')
  })

  // ---- Happy path ----

  it('upserts github_integrations and redirects with connected=1', async () => {
    vi.mocked(getInstallationDetails).mockResolvedValue({
      id: 12345678,
      account: { login: 'acmecorp', type: 'Organization' },
    })
    const { client, mocks } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const url = makeCallbackUrl({
      installation_id: '12345678',
      state: validState(),
      setup_action: 'install',
    })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)

    expect(location.searchParams.get('connected')).toBe('1')
    expect(location.pathname).toBe('/settings/integrations/github')

    // Verify upsert was called with the right data
    expect(mocks.fromFn).toHaveBeenCalledWith('github_integrations')
    expect(mocks.upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'ws-1',
        installation_id: 12345678,
        github_account_login: 'acmecorp',
        github_account_type: 'Organization',
        installed_by: 'user-1',
      }),
      { onConflict: 'installation_id' },
    )
    expect(clearInstallationToken).toHaveBeenCalledWith(12345678)
  })

  it('passes the installation_id as a number to getInstallationDetails', async () => {
    vi.mocked(getInstallationDetails).mockResolvedValue({
      id: 12345678,
      account: { login: 'acmecorp', type: 'Organization' },
    })
    const { client } = makeAdminMock()
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const url = makeCallbackUrl({ installation_id: '12345678', state: validState() })
    await GET(new NextRequest(url))

    expect(getInstallationDetails).toHaveBeenCalledWith(12345678)
  })

  // ---- Error handling ----

  it('redirects with error=github_api_error when getInstallationDetails fails', async () => {
    vi.mocked(getInstallationDetails).mockRejectedValue(new Error('API responded 404'))

    const url = makeCallbackUrl({ installation_id: '12345678', state: validState() })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('github_api_error')
  })

  it('redirects with error=db_error when the upsert fails', async () => {
    vi.mocked(getInstallationDetails).mockResolvedValue({
      id: 12345678,
      account: { login: 'acmecorp', type: 'Organization' },
    })
    const { client } = makeAdminMock({ upsertError: { message: 'unique violation' } })
    vi.mocked(createAdminClient).mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>)

    const url = makeCallbackUrl({ installation_id: '12345678', state: validState() })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.searchParams.get('error')).toBe('db_error')
  })

  // ---- Development redirect ----

  it('uses request origin as redirect base in development mode', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const url = makeCallbackUrl({ error: 'some_error' })
    const res = await GET(new NextRequest(url))
    const location = getRedirectUrl(res)
    expect(location.origin).toBe(new URL(url).origin)
  })
})
