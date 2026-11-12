/**
 * Tests for getInstallationTokenCached — wraps getInstallationTokenRaw with
 * an in-memory TTL cache keyed by installationId. A GitHub App installation
 * token is valid for ~1h; the cache reuses it until it's within 60s of
 * expiry, then re-fetches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./github', () => ({
  getInstallationTokenRaw: vi.fn(),
}))

import {
  getInstallationTokenCached,
  __resetInstallationTokenCacheForTests,
} from './installation-token'
import { getInstallationTokenRaw } from './github'

beforeEach(() => {
  vi.clearAllMocks()
  __resetInstallationTokenCacheForTests()
})

describe('getInstallationTokenCached', () => {
  it('fetches a fresh token on cache miss', async () => {
    vi.mocked(getInstallationTokenRaw).mockResolvedValue({
      token: 'tok-abc',
      expiresAt: Date.now() + 3_600_000,
    })

    const token = await getInstallationTokenCached(42)

    expect(token).toBe('tok-abc')
    expect(getInstallationTokenRaw).toHaveBeenCalledTimes(1)
    expect(getInstallationTokenRaw).toHaveBeenCalledWith(42)
  })

  it('returns the cached token on subsequent calls within TTL', async () => {
    vi.mocked(getInstallationTokenRaw).mockResolvedValue({
      token: 'tok-abc',
      expiresAt: Date.now() + 3_600_000,
    })

    await getInstallationTokenCached(42)
    const second = await getInstallationTokenCached(42)
    const third = await getInstallationTokenCached(42)

    expect(second).toBe('tok-abc')
    expect(third).toBe('tok-abc')
    // One sign + one GitHub call for three logical requests.
    expect(getInstallationTokenRaw).toHaveBeenCalledTimes(1)
  })

  it('re-fetches when the cached token is within the 60-second safety margin', async () => {
    // First call: token expires in 30s — within safety margin.
    vi.mocked(getInstallationTokenRaw).mockResolvedValueOnce({
      token: 'tok-expiring',
      expiresAt: Date.now() + 30_000,
    })
    await getInstallationTokenCached(42)

    // Second call must NOT reuse the about-to-expire token.
    vi.mocked(getInstallationTokenRaw).mockResolvedValueOnce({
      token: 'tok-refreshed',
      expiresAt: Date.now() + 3_600_000,
    })
    const refreshed = await getInstallationTokenCached(42)

    expect(refreshed).toBe('tok-refreshed')
    expect(getInstallationTokenRaw).toHaveBeenCalledTimes(2)
  })

  it('re-fetches when the cached token has already expired', async () => {
    vi.mocked(getInstallationTokenRaw).mockResolvedValueOnce({
      token: 'tok-old',
      expiresAt: Date.now() - 1_000,
    })
    await getInstallationTokenCached(42)

    vi.mocked(getInstallationTokenRaw).mockResolvedValueOnce({
      token: 'tok-new',
      expiresAt: Date.now() + 3_600_000,
    })
    const fresh = await getInstallationTokenCached(42)

    expect(fresh).toBe('tok-new')
    expect(getInstallationTokenRaw).toHaveBeenCalledTimes(2)
  })

  it('caches per installationId — distinct ids do not collide', async () => {
    vi.mocked(getInstallationTokenRaw).mockImplementation(async (id) =>
      id === 1
        ? { token: 'tok-1', expiresAt: Date.now() + 3_600_000 }
        : { token: 'tok-2', expiresAt: Date.now() + 3_600_000 },
    )

    const a = await getInstallationTokenCached(1)
    const b = await getInstallationTokenCached(2)
    const aAgain = await getInstallationTokenCached(1)

    expect(a).toBe('tok-1')
    expect(b).toBe('tok-2')
    expect(aAgain).toBe('tok-1')
    expect(getInstallationTokenRaw).toHaveBeenCalledTimes(2)
  })

  it('propagates errors from getInstallationTokenRaw without caching', async () => {
    vi.mocked(getInstallationTokenRaw).mockRejectedValueOnce(
      new Error('GitHub 503'),
    )

    await expect(getInstallationTokenCached(42)).rejects.toThrow('GitHub 503')

    // Next call should retry (nothing was cached).
    vi.mocked(getInstallationTokenRaw).mockResolvedValueOnce({
      token: 'tok-recovered',
      expiresAt: Date.now() + 3_600_000,
    })
    const recovered = await getInstallationTokenCached(42)
    expect(recovered).toBe('tok-recovered')
    expect(getInstallationTokenRaw).toHaveBeenCalledTimes(2)
  })
})
