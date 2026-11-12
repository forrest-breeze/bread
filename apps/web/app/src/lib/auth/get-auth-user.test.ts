/**
 * `getAuthUser` contract tests.
 *
 * The load-bearing behaviour: a *transient* auth failure (timeout, dropped
 * connection, 5xx) must THROW so it propagates to an error boundary — never
 * return null, which callers read as "logged out" and would bounce a signed-in
 * user to /login. A definitive "no session" answer must return null so the
 * caller can redirect to login.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AuthError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from '@supabase/supabase-js'

const getClaims = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getClaims } }),
}))

import { getAuthUser, AuthCheckError } from './get-auth-user'

beforeEach(() => {
  getClaims.mockReset()
})

afterEach(() => vi.useRealTimers())

describe('getAuthUser', () => {
  it('waits for the original slow claims check without starting another', async () => {
    vi.useFakeTimers()
    getClaims.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ data: { claims: { sub: 'slow', email: 'slow@breeze.com' } }, error: null }), 4000)))
    const pending = getAuthUser()
    await vi.advanceTimersByTimeAsync(4000)
    expect(await pending).toEqual({ id: 'slow', email: 'slow@breeze.com' })
    expect(getClaims).toHaveBeenCalledTimes(1)
  })

  it('does not enqueue another refresh after the full timeout budget', async () => {
    vi.useFakeTimers()
    getClaims.mockImplementation(() => new Promise(() => {}))
    const check = expect(getAuthUser()).rejects.toBeInstanceOf(AuthCheckError)
    await vi.advanceTimersByTimeAsync(6500)
    await check
    expect(getClaims).toHaveBeenCalledTimes(1)
  })

  it.each([409, 429])('does not treat auth %s as a missing session', async (status) => {
    getClaims.mockResolvedValue({ data: null, error: new AuthError('temporarily unavailable', status) })
    await expect(getAuthUser()).rejects.toBeInstanceOf(AuthCheckError)
  })

  it('returns the user on success', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'u1', email: 'u1@breeze.com' } }, error: null })
    expect(await getAuthUser()).toEqual({ id: 'u1', email: 'u1@breeze.com' })
  })

  it('treats a non-Breeze session as signed out', async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: 'u1', email: 'u1@gmail.com' } }, error: null })
    expect(await getAuthUser()).toBeNull()
  })

  it('returns null when there is genuinely no session', async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: new AuthSessionMissingError(),
    })
    expect(await getAuthUser()).toBeNull()
  })

  it('returns null on a definitive 4xx (invalid/expired session)', async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: new AuthError('bad jwt', 401, 'bad_jwt'),
    })
    expect(await getAuthUser()).toBeNull()
  })

  it('throws AuthCheckError on a retryable fetch failure (returned as error)', async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: new AuthRetryableFetchError('service unavailable', 503),
    })
    await expect(getAuthUser()).rejects.toBeInstanceOf(AuthCheckError)
  })

  it('throws AuthCheckError on a 5xx', async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: new AuthError('upstream', 502, 'upstream'),
    })
    await expect(getAuthUser()).rejects.toBeInstanceOf(AuthCheckError)
  })

  it('throws AuthCheckError when the auth call rejects (network)', async () => {
    getClaims.mockRejectedValue(new TypeError('fetch failed'))
    await expect(getAuthUser()).rejects.toBeInstanceOf(AuthCheckError)
  })

  it('retries once and recovers when the first attempt fails transiently', async () => {
    getClaims
      .mockRejectedValueOnce(new AuthRetryableFetchError('blip', 503))
      .mockResolvedValueOnce({ data: { claims: { sub: 'u2', email: 'u2@breeze.com' } }, error: null })
    expect(await getAuthUser()).toEqual({ id: 'u2', email: 'u2@breeze.com' })
    expect(getClaims).toHaveBeenCalledTimes(2)
  })
})
