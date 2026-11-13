/**
 * Chunk 2 — github.ts helper tests
 *
 * Test strategy:
 *   - verifyGitHubSignature: pure function, no mocks needed
 *   - getInstallationToken: mocks fetch + env vars; verifies JWT structure
 *   - API helpers: mock fetch per-test; verify URL, headers, and pagination
 *
 * A real RSA-2048 key pair is generated once in beforeAll for JWT signing
 * tests. This ensures getInstallationToken is tested with real crypto, not
 * a hand-rolled approximation.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createHmac, createPrivateKey, generateKeyPairSync } from 'crypto'
import {
  verifyGitHubSignature,
  getInstallationToken,
  getInstallationDetails,
  getPullRequest,
  listRecentClosedPullRequests,
  getPRComments,
  getPRReviews,
  getPRReviewComments,
  getRepository,
  getRepositoryBlob,
  getRepositoryCommit,
  getRepositoryFile,
  getRepositoryTree,
  createRepositoryBranch,
  createOrUpdateRepositoryFile,
  createRepositoryFilesCommit,
  createRepositoryPullRequest,
  findOpenRepositoryPullRequest,
  listRepositoryFileCommits,
  parseAppPrivateKey,
  type GitHubPR,
  type GitHubIssueComment,
  type GitHubReview,
  type GitHubReviewComment,
} from './github'
import { __resetInstallationTokenCacheForTests } from './installation-token'

// ---------------------------------------------------------------------------
// Test RSA key pair — generated once, used across getInstallationToken tests
// ---------------------------------------------------------------------------
let testPrivateKeyPem: string
let testPrivateKeyB64: string

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  testPrivateKeyPem = privateKey
  // Encode to PKCS#1 DER + base64, matching the runtime env-var format.
  const der = createPrivateKey(privateKey).export({ type: 'pkcs1', format: 'der' })
  testPrivateKeyB64 = Buffer.from(der).toString('base64')
})

beforeEach(() => {
  // Installation-token cache is a module-level singleton — clear it so each
  // test starts with a cold cache (otherwise earlier-test fetches would be
  // reused and fail assertions about fetch calls/env-var errors).
  __resetInstallationTokenCacheForTests()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidSignature(body: string, secret: string): string {
  const hmac = createHmac('sha256', secret)
  hmac.update(body, 'utf-8')
  return `sha256=${hmac.digest('hex')}`
}

function mockJsonResponse<T>(data: T, headers: Record<string, string> = {}, status = 200) {
  const text = JSON.stringify(data)
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(text),
  })
}

// Decode a base64url segment (no padding) to a plain object
function decodeJwtPart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    part.length + ((4 - (part.length % 4)) % 4),
    '=',
  )
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// verifyGitHubSignature
// ---------------------------------------------------------------------------

describe('verifyGitHubSignature', () => {
  const secret = 'test-webhook-secret'
  const body = '{"action":"opened","pull_request":{"number":42}}'

  it('returns true for a correct HMAC-SHA256 signature', () => {
    const sig = makeValidSignature(body, secret)
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true)
  })

  it('returns false when the body has been tampered with', () => {
    const sig = makeValidSignature(body, secret)
    const tamperedBody = body.replace('"opened"', '"closed"')
    expect(verifyGitHubSignature(tamperedBody, sig, secret)).toBe(false)
  })

  it('returns false when the wrong secret is used', () => {
    const sig = makeValidSignature(body, 'wrong-secret')
    expect(verifyGitHubSignature(body, sig, secret)).toBe(false)
  })

  it('returns false for a malformed header without the sha256= prefix', () => {
    const hmac = createHmac('sha256', secret).update(body).digest('hex')
    // No "sha256=" prefix
    expect(verifyGitHubSignature(body, hmac, secret)).toBe(false)
  })

  it('returns false for an empty signature header', () => {
    expect(verifyGitHubSignature(body, '', secret)).toBe(false)
  })

  it('returns false for a hex string of wrong length (32 vs 64 chars)', () => {
    // Only 32 hex chars — decodes to 16 bytes, not 32 (SHA-256 output is 32 bytes)
    expect(verifyGitHubSignature(body, 'sha256=' + 'a'.repeat(32), secret)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getInstallationToken
// ---------------------------------------------------------------------------

describe('getInstallationToken', () => {
  const INSTALLATION_ID = 99887766
  const APP_ID = '123456'

  it('generates a JWT and exchanges it for an installation access token', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)

    const mockFetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ token: 'ghs_test_installation_token' }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const token = await getInstallationToken(INSTALLATION_ID)

    expect(token).toBe('ghs_test_installation_token')
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('sends the request to the correct GitHub endpoint', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)

    const mockFetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ token: 'ghs_tok' }),
    )
    vi.stubGlobal('fetch', mockFetch)

    await getInstallationToken(INSTALLATION_ID)

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    )
  })

  it('sends a JWT with correct iss, iat, and exp claims', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)

    const mockFetch = vi.fn().mockResolvedValue(
      mockJsonResponse({ token: 'ghs_tok' }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const before = Math.floor(Date.now() / 1000)
    await getInstallationToken(INSTALLATION_ID)
    const after = Math.floor(Date.now() / 1000)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const authHeader = (init.headers as Record<string, string>)['Authorization']
    expect(authHeader).toMatch(/^Bearer /)

    const jwt = authHeader.replace('Bearer ', '')
    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)

    const header = decodeJwtPart(parts[0])
    expect(header.alg).toBe('RS256')
    expect(header.typ).toBe('JWT')

    const payload = decodeJwtPart(parts[1])
    expect(payload.iss).toBe(APP_ID)
    // iat should be now minus 60 seconds (clock-skew buffer)
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60)
    expect(payload.iat).toBeLessThanOrEqual(after - 60 + 1)
    // exp should be iat + 540 (9 minutes)
    expect(payload.exp).toBe((payload.iat as number) + 540)
  })

  it('throws when GITHUB_APP_ID is not set', async () => {
    // Stub both — empty string is falsy, triggering the guard.
    // Explicit stubs prevent ambient env vars from leaking into the test.
    vi.stubEnv('GITHUB_APP_ID', '')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)

    await expect(getInstallationToken(INSTALLATION_ID)).rejects.toThrow(
      /GITHUB_APP_ID/,
    )
  })

  it('throws when GITHUB_APP_PRIVATE_KEY is not set', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '')

    await expect(getInstallationToken(INSTALLATION_ID)).rejects.toThrow(
      /GITHUB_APP_PRIVATE_KEY/,
    )
  })

  // ---------------------------------------------------------------------------
  // Private-key format regressions
  //
  // The env var format was migrated from "base64 of PEM text" to "base64 of
  // PKCS#1 DER bytes". If ops ever re-sets the old format (or pastes raw PEM),
  // the failure must be a clear, actionable error — not a low-level OpenSSL
  // stack trace. These tests lock in that contract.
  // ---------------------------------------------------------------------------

  it('throws a descriptive error when GITHUB_APP_PRIVATE_KEY is base64-encoded PEM text (old format)', async () => {
    // Old format: someone sets the env var to `base64(<pem file contents>)`.
    // base64-decoded bytes start with ASCII "-----" which is unambiguous.
    const oldFormatB64 = Buffer.from(testPrivateKeyPem, 'utf-8').toString('base64')
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', oldFormatB64)

    await expect(getInstallationToken(INSTALLATION_ID)).rejects.toThrow(/PKCS#1 DER/)
  })

  it('throws a descriptive error when GITHUB_APP_PRIVATE_KEY contains raw PEM text (not base64)', async () => {
    // Someone pastes the `.pem` file contents directly with no base64 step.
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyPem)

    await expect(getInstallationToken(INSTALLATION_ID)).rejects.toThrow(/PKCS#1 DER/)
  })

  it('throws a descriptive error when GITHUB_APP_PRIVATE_KEY is not parseable as DER', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    // Base64-decodes to 15 bytes of garbage, not DER, not PEM.
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', Buffer.from('not a real key').toString('base64'))

    await expect(getInstallationToken(INSTALLATION_ID)).rejects.toThrow(/PKCS#1 DER/)
  })

  it('throws when GitHub API returns a non-200 status', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse({ message: 'Unauthorized' }, {}, 401)),
    )

    await expect(getInstallationToken(INSTALLATION_ID)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// parseAppPrivateKey — direct decoder contract
//
// The env-var path above (`getInstallationToken`) integration-covers the
// same three failure branches. These cases hit `parseAppPrivateKey`
// directly so the decoder's public error-message contract is locked at
// the exact API boundary — a refactor that swallows the "PKCS#1 DER"
// hint or drops the openssl recipe fails HERE, loudly, instead of only
// in the wrapper. This is the regression net against anyone re-setting
// the pre-migration env-var format (base64-of-PEM) in production.
// ---------------------------------------------------------------------------

describe('parseAppPrivateKey', () => {
  it('returns a private RSA KeyObject for base64-encoded PKCS#1 DER', () => {
    const key = parseAppPrivateKey(testPrivateKeyB64)
    expect(key.type).toBe('private')
    expect(key.asymmetricKeyType).toBe('rsa')
  })

  it('rejects base64-encoded PEM text (pre-migration format) with PKCS#1 DER guidance', () => {
    // The old-format mistake: `base64 key.pem`. Decoded bytes start with the
    // ASCII header "-----", which is unambiguous and trapped before the DER
    // parser runs. Ops must see the DER recipe in the thrown message — this
    // is the whole point of the regression net.
    const oldFormatB64 = Buffer.from(testPrivateKeyPem, 'utf-8').toString('base64')
    expect(() => parseAppPrivateKey(oldFormatB64)).toThrow(
      /pre-migration format.*Expected base64-encoded PKCS#1 DER.*openssl rsa -in key\.pem -outform DER \| base64/,
    )
  })

  it('rejects raw PEM text (no base64 wrapper) with PKCS#1 DER guidance', () => {
    // The other common mistake: paste the `.pem` contents directly. The
    // BEGIN/END armor is detected before `Buffer.from(..., 'base64')` would
    // silently produce nonsense.
    expect(() => parseAppPrivateKey(testPrivateKeyPem)).toThrow(
      /raw PEM text.*Expected base64-encoded PKCS#1 DER.*openssl rsa -in key\.pem -outform DER \| base64/,
    )
  })

  it('wraps a low-level DER parse failure with a PKCS#1 DER pointer', () => {
    // Valid base64, but the decoded bytes are not DER. Exercises the
    // catch-all branch — ops must still get the openssl recipe, not an
    // opaque "DECODER routines::unsupported" from OpenSSL.
    const garbageB64 = Buffer.from('not a real key').toString('base64')
    expect(() => parseAppPrivateKey(garbageB64)).toThrow(
      /could not be parsed as PKCS#1 DER.*openssl rsa -in key\.pem -outform DER \| base64/,
    )
  })
})

// ---------------------------------------------------------------------------
// getInstallationDetails
// ---------------------------------------------------------------------------

describe('getInstallationDetails', () => {
  const INSTALLATION_ID = 99887766
  const APP_ID = '123456'

  it('fetches the installation from the correct endpoint using JWT auth', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)

    const installationData = {
      id: INSTALLATION_ID,
      account: { login: 'acmecorp', type: 'Organization' },
    }
    const mockFetch = vi.fn().mockResolvedValue(mockJsonResponse(installationData))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getInstallationDetails(INSTALLATION_ID)

    expect(result).toEqual(installationData)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}`)
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toMatch(/^Bearer /)
    expect(headers['Accept']).toBe('application/vnd.github+json')
  })

  it('returns account details for a personal (User) installation', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)

    const installationData = {
      id: INSTALLATION_ID,
      account: { login: 'ben-li', type: 'User' },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(installationData)))

    const result = await getInstallationDetails(INSTALLATION_ID)

    expect(result.account.login).toBe('ben-li')
    expect(result.account.type).toBe('User')
  })

  it('throws when GITHUB_APP_ID is not set', async () => {
    vi.stubEnv('GITHUB_APP_ID', '')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)

    await expect(getInstallationDetails(INSTALLATION_ID)).rejects.toThrow(/GITHUB_APP_ID/)
  })

  it('throws when GITHUB_APP_PRIVATE_KEY is not set', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '')

    await expect(getInstallationDetails(INSTALLATION_ID)).rejects.toThrow(/GITHUB_APP_PRIVATE_KEY/)
  })

  it('throws on a non-200 response', async () => {
    vi.stubEnv('GITHUB_APP_ID', APP_ID)
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', testPrivateKeyB64)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({}, {}, 404)))

    await expect(getInstallationDetails(INSTALLATION_ID)).rejects.toThrow(/404/)
  })
})

// ---------------------------------------------------------------------------
// getPullRequest
// ---------------------------------------------------------------------------

describe('getPullRequest', () => {
  const TOKEN = 'ghs_test'
  const REPO = 'acmecorp/api-service'
  const PR_NUM = 42

  const fakePR: GitHubPR = {
    number: PR_NUM,
    title: 'feat: add GitHub capture',
    body: 'This PR adds GitHub PR capture.',
    state: 'open',
    merged: false,
    user: { login: 'ben-li', type: 'User' },
    created_at: '2026-03-27T00:00:00Z',
    updated_at: '2026-03-27T01:00:00Z',
  }

  it('fetches the PR from the correct endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockJsonResponse(fakePR))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getPullRequest(TOKEN, REPO, PR_NUM)

    expect(result).toEqual(fakePR)
    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toBe(`https://api.github.com/repos/${REPO}/pulls/${PR_NUM}`)
  })

  it('sends the correct Accept and authorization headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockJsonResponse(fakePR))
    vi.stubGlobal('fetch', mockFetch)

    await getPullRequest(TOKEN, REPO, PR_NUM)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect(headers['Accept']).toBe('application/vnd.github+json')
  })

  it('throws on a non-200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse({ message: 'Not Found' }, {}, 404)),
    )
    await expect(getPullRequest(TOKEN, REPO, PR_NUM)).rejects.toThrow()
  })

  it('surfaces the GitHub response body in the error message so retry can detect secondary rate limits', async () => {
    // withGitHubRetry's isSecondaryRateLimit check scans the error message
    // for "secondary rate limit". If the throw path strips the body, real
    // 403 rate-limit responses get classified as non-retryable.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(
          { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' },
          {},
          403,
        ),
      ),
    )
    await expect(getPullRequest(TOKEN, REPO, PR_NUM)).rejects.toThrow(/secondary rate limit/i)
  })
})

describe('listRecentClosedPullRequests', () => {
  it('lists a bounded page ordered by latest activity', async () => {
    const pullRequests = [{
      number: 172,
      title: 'docs: Update docs from Breezify',
      body: null,
      state: 'closed' as const,
      merged: true,
      user: null,
      created_at: '2026-08-13T00:00:00Z',
      updated_at: '2026-08-13T01:00:00Z',
      head: { ref: 'breezify/docs-docs-example' },
    }]
    const mockFetch = vi.fn().mockResolvedValue(mockJsonResponse(pullRequests))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      listRecentClosedPullRequests('ghs_test', 'acmecorp/api-service', 25),
    ).resolves.toEqual(pullRequests)

    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toContain('/pulls?state=closed')
    expect(url).toContain('sort=updated')
    expect(url).toContain('direction=desc')
    expect(url).toContain('per_page=25')
  })
})

// ---------------------------------------------------------------------------
// getPRComments
// ---------------------------------------------------------------------------

describe('getPRComments', () => {
  const TOKEN = 'ghs_test'
  const REPO = 'acmecorp/api-service'
  const PR_NUM = 42

  const makeComment = (id: number): GitHubIssueComment => ({
    id,
    body: `Comment ${id}`,
    user: { login: 'user', type: 'User' },
    created_at: '2026-03-27T00:00:00Z',
  })

  it('returns all comments from a single page', async () => {
    const comments = [makeComment(1), makeComment(2), makeComment(3)]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(comments)))

    const result = await getPRComments(TOKEN, REPO, PR_NUM)

    expect(result).toHaveLength(3)
    expect(result[0].id).toBe(1)
  })

  it('follows Link header pagination to aggregate results', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeComment(i + 1))
    const page2 = Array.from({ length: 30 }, (_, i) => makeComment(i + 101))

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        mockJsonResponse(page1, {
          Link: '<https://api.github.com/repos/acmecorp/api-service/issues/42/comments?page=2&per_page=100>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse(page2))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getPRComments(TOKEN, REPO, PR_NUM)

    expect(result).toHaveLength(130)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    // Second call must use the URL from the Link header, not a reconstructed one
    const [secondUrl] = mockFetch.mock.calls[1] as [string]
    expect(secondUrl).toContain('page=2')
  })

  it('stops pagination when the Link header has no rel="next" (last page)', async () => {
    const comments = [makeComment(1), makeComment(2)]
    // A Link header with only rel="last" — no further pages
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(comments, {
          Link: '<https://api.github.com/repos/acmecorp/api-service/issues/42/comments?page=1>; rel="last"',
        }),
      ),
    )

    const result = await getPRComments(TOKEN, REPO, PR_NUM)

    expect(result).toHaveLength(2)
  })

  it('throws on a non-200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse({}, {}, 403)),
    )
    await expect(getPRComments(TOKEN, REPO, PR_NUM)).rejects.toThrow()
  })

  it('logs a warning and throws when the rate limit is exhausted (remaining = 0)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({}, { 'X-RateLimit-Remaining': '0' }, 403),
      ),
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(getPRComments(TOKEN, REPO, PR_NUM)).rejects.toThrow()

    expect(errorSpy).toHaveBeenCalledWith(
      '[Breezify] GitHub API rate limit exhausted for:',
      expect.stringContaining('issues'),
    )
  })
})

// ---------------------------------------------------------------------------
// getPRReviews
// ---------------------------------------------------------------------------

describe('getPRReviews', () => {
  const TOKEN = 'ghs_test'
  const REPO = 'acmecorp/api-service'
  const PR_NUM = 42

  const makeReview = (id: number): GitHubReview => ({
    id,
    body: `Review ${id}`,
    state: 'APPROVED',
    user: { login: 'reviewer', type: 'User' },
    submitted_at: '2026-03-27T00:00:00Z',
  })

  it('returns all reviews from a single page', async () => {
    const reviews = [makeReview(1), makeReview(2)]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(reviews)))

    const result = await getPRReviews(TOKEN, REPO, PR_NUM)

    expect(result).toHaveLength(2)
    expect(result[0].state).toBe('APPROVED')
  })

  it('follows Link header pagination', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeReview(i + 1))
    const page2 = [makeReview(101)]

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        mockJsonResponse(page1, {
          Link: '<https://api.github.com/repos/acmecorp/api-service/pulls/42/reviews?page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse(page2))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getPRReviews(TOKEN, REPO, PR_NUM)

    expect(result).toHaveLength(101)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// getPRReviewComments
// ---------------------------------------------------------------------------

describe('getPRReviewComments', () => {
  const TOKEN = 'ghs_test'
  const REPO = 'acmecorp/api-service'
  const PR_NUM = 42

  const makeReviewComment = (id: number): GitHubReviewComment => ({
    id,
    body: `Inline comment ${id}`,
    path: 'src/index.ts',
    line: 10 + id,
    original_line: 10 + id,
    user: { login: 'reviewer', type: 'User' },
    created_at: '2026-03-27T00:00:00Z',
  })

  it('returns all review comments from a single page', async () => {
    const comments = [makeReviewComment(1), makeReviewComment(2)]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(comments)))

    const result = await getPRReviewComments(TOKEN, REPO, PR_NUM)

    expect(result).toHaveLength(2)
    expect(result[0].path).toBe('src/index.ts')
  })

  it('follows Link header pagination', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeReviewComment(i + 1))
    const page2 = Array.from({ length: 5 }, (_, i) => makeReviewComment(i + 101))

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        mockJsonResponse(page1, {
          Link: '<https://api.github.com/repos/acmecorp/api-service/pulls/42/comments?page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse(page2))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getPRReviewComments(TOKEN, REPO, PR_NUM)

    expect(result).toHaveLength(105)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Repository tree/blob helpers
// ---------------------------------------------------------------------------

describe('repository content helpers', () => {
  const TOKEN = 'ghs_test'
  const REPO = 'acmecorp/api-service'

  it('resolves repository metadata and a branch ref', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        id: 7,
        full_name: REPO,
        default_branch: 'main',
        private: true,
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        sha: 'commit-sha',
        commit: { tree: { sha: 'tree-sha' } },
      }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(getRepository(TOKEN, REPO)).resolves.toMatchObject({
      default_branch: 'main',
    })
    await expect(getRepositoryCommit(TOKEN, REPO, 'feature/docs')).resolves.toMatchObject({
      sha: 'commit-sha',
    })
    expect(mockFetch.mock.calls[1]?.[0]).toContain('/commits/feature%2Fdocs')
  })

  it('requests a recursive tree and decodes blob payload metadata', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        sha: 'tree-sha',
        truncated: false,
        tree: [{
          path: 'src/index.ts',
          mode: '100644',
          type: 'blob',
          sha: 'blob-sha',
          size: 10,
          url: 'https://api.github.com/blob',
        }],
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        sha: 'blob-sha',
        size: 10,
        encoding: 'base64',
        content: 'aGVsbG8=',
      }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(getRepositoryTree(TOKEN, REPO, 'tree-sha')).resolves.toMatchObject({
      truncated: false,
    })
    await expect(getRepositoryBlob(TOKEN, REPO, 'blob-sha')).resolves.toMatchObject({
      encoding: 'base64',
    })
    expect(mockFetch.mock.calls[0]?.[0]).toContain('?recursive=1')
  })

  it('reads and commits an exact file body on a feature branch', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        type: 'file',
        encoding: 'base64',
        size: 5,
        name: 'intro.md',
        path: 'docs/intro.md',
        sha: 'old-blob',
        content: 'aGVsbG8=',
        html_url: 'https://github.test/file',
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        content: { path: 'docs/intro.md', sha: 'new-blob' },
        commit: { sha: 'new-commit', html_url: 'https://github.test/commit' },
      }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      getRepositoryFile(TOKEN, REPO, 'docs/intro.md', 'feature/docs'),
    ).resolves.toMatchObject({ sha: 'old-blob' })
    await expect(
      createOrUpdateRepositoryFile(TOKEN, REPO, {
        path: 'docs/intro.md',
        branch: 'feature/docs',
        message: 'docs: update intro',
        content: 'updated\n',
        currentBlobSha: 'old-blob',
      }),
    ).resolves.toMatchObject({ commit: { sha: 'new-commit' } })

    const writeBody = JSON.parse(
      mockFetch.mock.calls[1]?.[1]?.body as string,
    ) as Record<string, unknown>
    expect(writeBody).toMatchObject({
      branch: 'feature/docs',
      message: 'docs: update intro',
      sha: 'old-blob',
      content: Buffer.from('updated\n').toString('base64'),
    })
  })

  it('creates an idempotent feature branch and pull request', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({}, {}, 404))
      .mockResolvedValueOnce(mockJsonResponse({
        ref: 'refs/heads/breezify/intro',
        object: { type: 'commit', sha: 'base-commit' },
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        number: 17,
        html_url: 'https://github.test/pull/17',
        state: 'open',
        title: 'Update intro',
      }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      createRepositoryBranch(TOKEN, REPO, 'breezify/intro', 'base-commit'),
    ).resolves.toMatchObject({ object: { sha: 'base-commit' } })
    await expect(
      createRepositoryPullRequest(TOKEN, REPO, {
        head: 'breezify/intro',
        base: 'main',
        title: 'Update intro',
        body: 'Docs update',
      }),
    ).resolves.toMatchObject({ number: 17 })

    expect(JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string)).toEqual({
      ref: 'refs/heads/breezify/intro',
      sha: 'base-commit',
    })
  })

  it('creates, replaces, and removes files as one non-force commit', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({ sha: 'blob-one' }))
      .mockResolvedValueOnce(mockJsonResponse({ sha: 'blob-two' }))
      .mockResolvedValueOnce(mockJsonResponse({ sha: 'new-tree' }))
      .mockResolvedValueOnce(mockJsonResponse({
        sha: 'new-commit',
        html_url: 'https://github.test/commit/new-commit',
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: 'new-commit' },
      }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      createRepositoryFilesCommit(TOKEN, REPO, {
        branch: 'main',
        baseCommitSha: 'base-commit',
        baseTreeSha: 'base-tree',
        message: 'docs: initialize from Breezify',
        files: [
          { path: 'docs/intro.md', content: '# Intro\n' },
          { path: 'docs/setup.md', content: '# Setup\n' },
        ],
        deletePaths: ['docs/obsolete.md'],
      }),
    ).resolves.toMatchObject({ sha: 'new-commit' })

    expect(JSON.parse(mockFetch.mock.calls[2]?.[1]?.body as string)).toEqual({
      base_tree: 'base-tree',
      tree: [
        { path: 'docs/intro.md', mode: '100644', type: 'blob', sha: 'blob-one' },
        { path: 'docs/setup.md', mode: '100644', type: 'blob', sha: 'blob-two' },
        { path: 'docs/obsolete.md', mode: '100644', type: 'blob', sha: null },
      ],
    })
    expect(JSON.parse(mockFetch.mock.calls[4]?.[1]?.body as string)).toEqual({
      sha: 'new-commit',
      force: false,
    })
  })

  it('bounds concurrent GitHub blob writes for large workspace commits', async () => {
    let activeBlobWrites = 0
    let maximumBlobWrites = 0
    let blobNumber = 0
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/git/blobs')) {
        activeBlobWrites += 1
        maximumBlobWrites = Math.max(maximumBlobWrites, activeBlobWrites)
        const currentBlob = ++blobNumber
        await new Promise((resolve) => setTimeout(resolve, 2))
        activeBlobWrites -= 1
        return mockJsonResponse({ sha: `blob-${currentBlob}` })
      }
      if (url.endsWith('/git/trees')) {
        return mockJsonResponse({ sha: 'new-tree' })
      }
      if (url.endsWith('/git/commits')) {
        return mockJsonResponse({
          sha: 'new-commit',
          html_url: 'https://github.test/commit/new-commit',
        })
      }
      return mockJsonResponse({
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: 'new-commit' },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    await createRepositoryFilesCommit(TOKEN, REPO, {
      branch: 'main',
      baseCommitSha: 'base-commit',
      baseTreeSha: 'base-tree',
      message: 'docs: publish a large workspace',
      files: Array.from({ length: 24 }, (_, index) => ({
        path: `docs/page-${index}.md`,
        content: `# Page ${index}\n`,
      })),
    })

    expect(maximumBlobWrites).toBeGreaterThan(1)
    expect(maximumBlobWrites).toBeLessThanOrEqual(8)
  })

  it('finds an existing open pull request for a retry-safe publish', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(mockJsonResponse([{
      number: 17,
      html_url: 'https://github.test/pull/17',
      state: 'open',
      title: 'Update intro',
    }]))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      findOpenRepositoryPullRequest(TOKEN, REPO, {
        head: 'breezify/intro',
        base: 'main',
      }),
    ).resolves.toMatchObject({ number: 17 })

    expect(mockFetch.mock.calls[0]?.[0]).toContain(
      'head=acmecorp%3Abreezify%2Fintro',
    )
    expect(mockFetch.mock.calls[0]?.[0]).toContain('base=main')
  })

  it('maps paginated file commit history to the shared history shape', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockJsonResponse(
        [{
          sha: 'abc1234',
          html_url: 'https://github.test/commit/abc1234',
          commit: {
            message: 'docs: update intro\n\nMore detail',
            author: { name: 'Ada', date: '2026-08-05T12:00:00Z' },
            committer: null,
          },
          author: { login: 'ada', avatar_url: 'https://github.test/ada.png' },
        }],
        {
          Link: '<https://api.github.com/next>; rel="next"',
        },
      ),
    )
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      listRepositoryFileCommits(TOKEN, REPO, {
        path: 'docs/intro.md',
        branch: 'main',
      }),
    ).resolves.toEqual({
      hasMore: true,
      commits: [{
        sha: 'abc1234',
        html_url: 'https://github.test/commit/abc1234',
        message: 'docs: update intro\n\nMore detail',
        authored_at: '2026-08-05T12:00:00Z',
        author_name: 'Ada',
        author_login: 'ada',
        author_avatar_url: 'https://github.test/ada.png',
      }],
    })
  })
})
