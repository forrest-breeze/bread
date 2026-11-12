/**
 * GET /api/health — base liveness probe.
 *
 * Contract:
 *   200 { ok: true, commit: string }
 *
 * `commit` is resolved from the first present of:
 *   COMMIT_REF            (platform-agnostic / manual override)
 *   VERCEL_GIT_COMMIT_SHA (Vercel)
 *   NETLIFY_COMMIT_REF    (Netlify — our current host)
 *   "unknown"             (fallback so the probe still returns 200 locally)
 *
 * No auth required — the response is booleans + a commit sha. It MUST NOT
 * leak env var *values* beyond the commit sha, and MUST remain 200 so that
 * uptime checkers don't false-alert when env vars are missing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

const pingMock = vi.fn()
vi.mock('@upstash/redis', () => ({
  Redis: class {
    ping = pingMock
  },
}))

import { GET } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
  pingMock.mockReset()
})

function clearAllCommitEnvVars() {
  vi.stubEnv('COMMIT_REF', '')
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
  vi.stubEnv('NETLIFY_COMMIT_REF', '')
}

function clearUpstashEnvVars() {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
}

describe('GET /api/health', () => {
  it('returns 200 with ok:true', async () => {
    clearAllCommitEnvVars()
    clearUpstashEnvVars()
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('includes commit sha from COMMIT_REF when set', async () => {
    clearAllCommitEnvVars()
    clearUpstashEnvVars()
    vi.stubEnv('COMMIT_REF', 'abc1234')
    const body = await (await GET()).json()
    expect(body.commit).toBe('abc1234')
  })

  it('falls back to VERCEL_GIT_COMMIT_SHA when COMMIT_REF is absent', async () => {
    clearAllCommitEnvVars()
    clearUpstashEnvVars()
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'vercel123')
    const body = await (await GET()).json()
    expect(body.commit).toBe('vercel123')
  })

  it('falls back to NETLIFY_COMMIT_REF when no prior vars are set', async () => {
    clearAllCommitEnvVars()
    clearUpstashEnvVars()
    vi.stubEnv('NETLIFY_COMMIT_REF', 'netlify456')
    const body = await (await GET()).json()
    expect(body.commit).toBe('netlify456')
  })

  it('returns "unknown" when no commit env vars are set', async () => {
    clearAllCommitEnvVars()
    clearUpstashEnvVars()
    const body = await (await GET()).json()
    expect(body.commit).toBe('unknown')
  })

  it('prefers COMMIT_REF over platform-specific vars', async () => {
    clearAllCommitEnvVars()
    clearUpstashEnvVars()
    vi.stubEnv('COMMIT_REF', 'override')
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'vercel')
    vi.stubEnv('NETLIFY_COMMIT_REF', 'netlify')
    const body = await (await GET()).json()
    expect(body.commit).toBe('override')
  })

  describe('redis field', () => {
    it('reports "disabled" when UPSTASH env vars are unset', async () => {
      clearAllCommitEnvVars()
      clearUpstashEnvVars()
      const body = await (await GET()).json()
      expect(body.redis).toBe('disabled')
      expect(pingMock).not.toHaveBeenCalled()
    })

    it('reports "ok" when UPSTASH env vars are set and ping succeeds', async () => {
      clearAllCommitEnvVars()
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io')
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fake-token')
      pingMock.mockResolvedValueOnce('PONG')
      const body = await (await GET()).json()
      expect(body.redis).toBe('ok')
    })

    it('reports "degraded" when UPSTASH env vars are set but ping fails', async () => {
      clearAllCommitEnvVars()
      vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io')
      vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fake-token')
      pingMock.mockRejectedValueOnce(new Error('401 Unauthorized'))
      const body = await (await GET()).json()
      expect(body.redis).toBe('degraded')
      expect(body.ok).toBe(true) // probe stays 200 so uptime checkers don't alert
    })
  })
})
