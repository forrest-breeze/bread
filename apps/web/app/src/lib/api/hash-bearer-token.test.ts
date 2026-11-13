/**
 * Tests for hashBearerToken — the single source of truth for mapping an
 * Authorization: Bearer header to the SHA-256 hex digest used in the
 * `api_keys.key_hash` lookup. Shared by `authenticateApiKey` (REST) and
 * `authenticateMcp` (MCP streamable-HTTP).
 *
 * The helper is pure — no DB, no IO — so the tests are pure too.
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { NextRequest } from 'next/server'
import { hashBearerToken } from './hash-bearer-token'

function req(authHeader?: string): NextRequest {
  const headers = new Headers()
  if (authHeader !== undefined) headers.set('authorization', authHeader)
  return new NextRequest('http://localhost/api/any', { headers })
}

function sha256Hex(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

describe('hashBearerToken — null paths', () => {
  it('returns null when Authorization header is absent', () => {
    expect(hashBearerToken(req())).toBeNull()
  })

  it('returns null when the header does not start with "Bearer "', () => {
    expect(hashBearerToken(req('Basic dXNlcjpwYXNz'))).toBeNull()
    expect(hashBearerToken(req('Token abc123'))).toBeNull()
    expect(hashBearerToken(req('abc123'))).toBeNull() // no scheme at all
  })

  it('returns null when the bearer token is empty', () => {
    expect(hashBearerToken(req('Bearer '))).toBeNull()
    expect(hashBearerToken(req('Bearer   '))).toBeNull() // whitespace only
  })
})

describe('hashBearerToken — hashing', () => {
  it('returns the SHA-256 hex digest of the token when present', () => {
    const token = 'breezify_sk_ABCDEFGHIJKLMNOPQRSTUVWX'
    const hash = hashBearerToken(req(`Bearer ${token}`))
    expect(hash).toBe(sha256Hex(token))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts a case-insensitive "bearer" prefix', () => {
    // Per RFC 7235 the auth scheme is case-insensitive. We do not want to lock
    // callers out because they capitalised differently than usual.
    const token = 'breezify_sk_case_test'
    const upper = hashBearerToken(req(`BEARER ${token}`))
    const lower = hashBearerToken(req(`bearer ${token}`))
    const mixed = hashBearerToken(req(`BeArEr ${token}`))
    const expected = sha256Hex(token)
    expect(upper).toBe(expected)
    expect(lower).toBe(expected)
    expect(mixed).toBe(expected)
  })

  it('is deterministic across invocations on the same token', () => {
    const token = 'breezify_sk_determinism_check'
    expect(hashBearerToken(req(`Bearer ${token}`))).toBe(
      hashBearerToken(req(`Bearer ${token}`)),
    )
  })

  it('produces different hashes for different tokens', () => {
    const a = hashBearerToken(req('Bearer breezify_sk_alpha'))
    const b = hashBearerToken(req('Bearer breezify_sk_beta'))
    expect(a).not.toBe(b)
  })

  it('trims incidental whitespace after "Bearer " but hashes the token itself', () => {
    // Some HTTP clients send "Bearer \t<token>" with multiple whitespace chars.
    // The helper's regex matches \s+, so the parsed token should be the raw
    // value without leading whitespace.
    const token = 'breezify_sk_tabtest'
    const hash = hashBearerToken(req(`Bearer \t${token}`))
    expect(hash).toBe(sha256Hex(token))
  })
})
