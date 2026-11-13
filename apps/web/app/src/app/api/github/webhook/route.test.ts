/**
 * Chunk 5 — GitHub webhook POST handler tests
 *
 * Tests the thin request-handling layer:
 *   - Signature verification gates access
 *   - Missing secret returns 500
 *   - Invalid JSON returns 400
 *   - Valid PR events return 200 and dispatch via after()
 *   - Non-PR events return 200 silently
 *
 * This file only tests the route handler's
 * request validation and dispatch behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'

import { __resetLoggedMisconfigsForTest } from '@/lib/env/webhook-secrets'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

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

vi.mock('@/lib/github/github', () => ({
  verifyGitHubSignature: vi.fn(),
}))

vi.mock('@/lib/github/github-repo-ingest', () => ({
  extractRepositoryPushInfo: vi.fn().mockReturnValue(null),
  handleRepositoryPush: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/github/github-docs-check', () => ({
  extractGitHubDocsCheckInfo: vi.fn().mockReturnValue(null),
  handleGitHubDocsCheck: vi.fn().mockResolvedValue(undefined),
}))

const { clearInstallationToken } = vi.hoisted(() => ({
  clearInstallationToken: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/github/token-cache-factory', () => ({
  getTokenCache: vi.fn(() => ({ clear: clearInstallationToken })),
}))

import { verifyGitHubSignature } from '@/lib/github/github'
import {
  extractRepositoryPushInfo,
  handleRepositoryPush,
} from '@/lib/github/github-repo-ingest'
import {
  extractGitHubDocsCheckInfo,
  handleGitHubDocsCheck,
} from '@/lib/github/github-docs-check'
import { POST } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  afterCallbacks.length = 0
  __resetLoggedMisconfigsForTest()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'test-webhook-secret'

function makeWebhookRequest(
  body: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('https://app.example.dev/api/github/webhook', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=valid',
      'x-github-event': 'pull_request',
      ...headers,
    },
  })
}

function makeValidSignature(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf-8').digest('hex')}`
}

const validPayload = JSON.stringify({
  action: 'opened',
  pull_request: { number: 42, title: 'Test PR', user: { login: 'alice' } },
  repository: { id: 123, full_name: 'acme/repo' },
  installation: { id: 456 },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/github/webhook', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', WEBHOOK_SECRET)
    vi.mocked(verifyGitHubSignature).mockReset()
    vi.mocked(extractRepositoryPushInfo).mockReset().mockReturnValue(null)
    vi.mocked(handleRepositoryPush).mockReset().mockResolvedValue(undefined)
    vi.mocked(extractGitHubDocsCheckInfo).mockReset().mockReturnValue(null)
    vi.mocked(handleGitHubDocsCheck).mockReset().mockResolvedValue({
      status: 'ignored',
      reason: 'unlinked',
    })
    clearInstallationToken.mockReset().mockResolvedValue(undefined)
  })

  it('I-G1: returns 500 when GITHUB_WEBHOOK_SECRET is not set', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')

    const res = await POST(makeWebhookRequest(validPayload))

    expect(res.status).toBe(500)
  })

  it('I-G2: 500 body uses uniform "Server misconfigured: webhook secret missing"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')

    const res = await POST(makeWebhookRequest(validPayload))

    await expect(res.json()).resolves.toEqual({
      error: 'Server misconfigured: webhook secret missing',
    })
  })

  it('I-G3: secret assertion runs before signature verification', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')

    await POST(makeWebhookRequest(validPayload))

    expect(verifyGitHubSignature).not.toHaveBeenCalled()
  })

  it('returns 401 when signature verification fails', async () => {
    vi.mocked(verifyGitHubSignature).mockReturnValue(false)

    const res = await POST(makeWebhookRequest(validPayload))

    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON body', async () => {
    vi.mocked(verifyGitHubSignature).mockReturnValue(true)

    const res = await POST(makeWebhookRequest('not json {{{'))

    expect(res.status).toBe(400)
  })

  it('returns 200 and ignores non-PR events', async () => {
    vi.mocked(verifyGitHubSignature).mockReturnValue(true)

    const res = await POST(makeWebhookRequest(
      JSON.stringify({ action: 'completed', check_run: {} }),
      { 'x-github-event': 'check_run' },
    ))

    expect(res.status).toBe(200)
    expect(afterCallbacks).toHaveLength(0)
  })

  it('dispatches a Breezify docs check for requested check suites', async () => {
    vi.mocked(verifyGitHubSignature).mockReturnValue(true)
    const checkInfo = {
      installationId: 456,
      repoId: 123,
      repoFullName: 'acme/repo',
      headSha: 'a'.repeat(40),
    }
    vi.mocked(extractGitHubDocsCheckInfo).mockReturnValue(checkInfo)
    const payload = JSON.stringify({
      action: 'requested',
      check_suite: { head_sha: checkInfo.headSha },
      repository: { id: 123, full_name: 'acme/repo' },
      installation: { id: 456 },
    })

    const res = await POST(makeWebhookRequest(payload, {
      'x-github-event': 'check_suite',
    }))

    expect(res.status).toBe(200)
    expect(afterCallbacks).toHaveLength(1)
    await afterCallbacks[0]()
    expect(handleGitHubDocsCheck).toHaveBeenCalledWith(checkInfo)
  })

  it('clears cached installation tokens when new permissions are accepted', async () => {
    vi.mocked(verifyGitHubSignature).mockReturnValue(true)
    const payload = JSON.stringify({
      action: 'new_permissions_accepted',
      installation: { id: 456 },
    })

    const res = await POST(makeWebhookRequest(payload, {
      'x-github-event': 'installation',
    }))

    expect(res.status).toBe(200)
    expect(afterCallbacks).toHaveLength(1)
    await afterCallbacks[0]()
    expect(clearInstallationToken).toHaveBeenCalledWith(456)
  })

  it('clears cached installation tokens when selected repositories change', async () => {
    vi.mocked(verifyGitHubSignature).mockReturnValue(true)
    const payload = JSON.stringify({
      action: 'added',
      installation: { id: 456 },
      repositories_added: [{ id: 123, full_name: 'acme/repo' }],
      repositories_removed: [],
    })

    const res = await POST(makeWebhookRequest(payload, {
      'x-github-event': 'installation_repositories',
    }))

    expect(res.status).toBe(200)
    expect(afterCallbacks).toHaveLength(1)
    await afterCallbacks[0]()
    expect(clearInstallationToken).toHaveBeenCalledWith(456)
  })

  it('returns 200 and dispatches default-branch push events via after()', async () => {
    vi.mocked(verifyGitHubSignature).mockReturnValue(true)
    const pushInfo = {
      repoId: 123,
      repoFullName: 'acme/repo',
      installationId: 456,
      ref: 'abc123',
    }
    vi.mocked(extractRepositoryPushInfo).mockReturnValue(pushInfo)
    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'abc123',
      repository: { id: 123, full_name: 'acme/repo', default_branch: 'main' },
      installation: { id: 456 },
    })

    const res = await POST(makeWebhookRequest(payload, { 'x-github-event': 'push' }))

    expect(res.status).toBe(200)
    expect(afterCallbacks).toHaveLength(1)
    await afterCallbacks[0]()
    expect(handleRepositoryPush).toHaveBeenCalledWith(pushInfo)
  })

  it('passes rawBody, signature header, and secret to verifyGitHubSignature', async () => {
    vi.mocked(verifyGitHubSignature).mockReturnValue(false)

    const sig = makeValidSignature(validPayload, WEBHOOK_SECRET)
    const req = makeWebhookRequest(validPayload, { 'x-hub-signature-256': sig })
    await POST(req)

    expect(verifyGitHubSignature).toHaveBeenCalledWith(
      validPayload,
      sig,
      WEBHOOK_SECRET,
    )
  })

})

// ---------------------------------------------------------------------------
// Fixture helper (avoid importing from the mocked module)
// ---------------------------------------------------------------------------
