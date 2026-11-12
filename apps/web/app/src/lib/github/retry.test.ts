/**
 * Tests for withGitHubRetry — exponential-backoff wrapper for GitHub API
 * calls. Retries on 502/503/504 and secondary-rate-limit 403s. Tests use
 * vi.useFakeTimers() so the backoff sleeps don't actually delay the run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withGitHubRetry, GitHubApiError } from './retry'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function flushTimers(): Promise<void> {
  // Advance fake timers and microtasks until no more are queued.
  await vi.runAllTimersAsync()
}

describe('withGitHubRetry', () => {
  it('returns the value on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withGitHubRetry(fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 503 and returns the second attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new GitHubApiError('503 boom', 503))
      .mockResolvedValueOnce('recovered')

    const promise = withGitHubRetry(fn)
    await flushTimers()
    const result = await promise

    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on 502 and 504 as well', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new GitHubApiError('502', 502))
      .mockRejectedValueOnce(new GitHubApiError('504', 504))
      .mockResolvedValueOnce('ok')

    const promise = withGitHubRetry(fn)
    await flushTimers()
    const result = await promise

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry on 400 / 401 / 404', async () => {
    const err = new GitHubApiError('404 not found', 404)
    const fn = vi.fn().mockRejectedValue(err)

    await expect(withGitHubRetry(fn)).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on secondary-rate-limit 403s', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new GitHubApiError(
          'GitHub API responded 403: You have exceeded a secondary rate limit',
          403,
        ),
      )
      .mockResolvedValueOnce('ok')

    const promise = withGitHubRetry(fn)
    await flushTimers()
    const result = await promise

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not retry on non-secondary 403s', async () => {
    const err = new GitHubApiError('Forbidden — not a rate limit', 403)
    const fn = vi.fn().mockRejectedValue(err)

    await expect(withGitHubRetry(fn)).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after MAX_ATTEMPTS retries and rethrows the last error', async () => {
    const err = new GitHubApiError('503', 503)
    const fn = vi.fn().mockRejectedValue(err)

    // Attach the rejection assertion eagerly so the promise has a handler
    // before fake timers advance — otherwise Vitest flags the intermediate
    // rejection as "unhandled".
    const assertion = expect(withGitHubRetry(fn)).rejects.toBe(err)
    await flushTimers()
    await assertion

    // 4 attempts total: initial + 3 retries
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('does not retry on errors without a status (unknown shape)', async () => {
    const err = new Error('random network blip')
    const fn = vi.fn().mockRejectedValue(err)

    await expect(withGitHubRetry(fn)).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('GitHubApiError', () => {
  it('stores status alongside the message', () => {
    const err = new GitHubApiError('boom', 503)
    expect(err.status).toBe(503)
    expect(err.message).toBe('boom')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('GitHubApiError')
  })
})
