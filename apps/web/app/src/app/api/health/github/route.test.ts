/**
 * GET /api/health/github — GitHub App env-var health probe.
 *
 * Contract:
 *   200 {
 *     configured: boolean,                        // appId and a parseable key
 *     appIdLoaded: boolean,
 *     privateKeyFormat: 'der' | 'missing' | 'invalid',
 *     privateKeySource: 'env' | 'redis' | 'none',
 *     webhookSecretLoaded: boolean,
 *   }
 *
 * BOOLEANS + the format enum ONLY. The response MUST NOT:
 *   - include key bytes, fingerprints, or any substring of GITHUB_APP_PRIVATE_KEY
 *   - include the error message produced by parseAppPrivateKey (those are
 *     safe for ops to see in logs but not for an unauthenticated endpoint)
 *
 * The privateKeyFormat enum resolves by calling the shared parseAppPrivateKey
 * helper from @/lib/github/github. 'der' means the helper returned a KeyObject.
 * 'missing' means neither source held a key. 'invalid' means any throw.
 *
 * The probe follows the same env-then-Upstash order as getAppJWT, so an
 * Upstash-backed deployment reads as configured.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { createPrivateKey, generateKeyPairSync } from 'crypto'

const mocks = vi.hoisted(() => ({ buildRedis: vi.fn(() => null as unknown) }))
vi.mock('@/lib/upstash', () => ({ buildRedis: mocks.buildRedis }))

import { GET } from './route'

let validDerB64: string
let rawPem: string
let oldFormatB64: string

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  rawPem = privateKey
  const der = createPrivateKey(privateKey).export({ type: 'pkcs1', format: 'der' })
  validDerB64 = Buffer.from(der).toString('base64')
  oldFormatB64 = Buffer.from(rawPem, 'utf-8').toString('base64')
})

afterEach(() => {
  vi.unstubAllEnvs()
  mocks.buildRedis.mockReturnValue(null)
})

function clearAllGithubEnvVars() {
  vi.stubEnv('GITHUB_APP_ID', '')
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '')
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')
}

describe('GET /api/health/github', () => {
  it('returns configured:true with privateKeyFormat:"der" for a valid DER key', async () => {
    vi.stubEnv('GITHUB_APP_ID', '3216214')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', validDerB64)
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'whsec')

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      configured: true,
      appIdLoaded: true,
      privateKeyFormat: 'der',
      privateKeySource: 'env',
      webhookSecretLoaded: true,
    })
  })

  it('reports a key served from the Upstash fallback as configured', async () => {
    clearAllGithubEnvVars()
    vi.stubEnv('GITHUB_APP_ID', '3216214')
    mocks.buildRedis.mockReturnValue({
      get: vi.fn(async () => validDerB64),
    })

    const body = await (await GET()).json()
    expect(body.privateKeySource).toBe('redis')
    expect(body.privateKeyFormat).toBe('der')
    expect(body.configured).toBe(true)
  })

  it('prefers the env var over Upstash, matching getAppJWT', async () => {
    vi.stubEnv('GITHUB_APP_ID', '3216214')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', validDerB64)
    const get = vi.fn(async () => validDerB64)
    mocks.buildRedis.mockReturnValue({ get })

    const body = await (await GET()).json()
    expect(body.privateKeySource).toBe('env')
    expect(get).not.toHaveBeenCalled()
  })

  it('reports an empty Upstash key and a Redis outage as missing', async () => {
    clearAllGithubEnvVars()
    vi.stubEnv('GITHUB_APP_ID', '3216214')

    mocks.buildRedis.mockReturnValue({ get: vi.fn(async () => null) })
    const empty = await (await GET()).json()
    expect(empty).toMatchObject({
      privateKeyFormat: 'missing',
      privateKeySource: 'none',
      configured: false,
    })

    mocks.buildRedis.mockReturnValue({
      get: vi.fn(async () => {
        throw new Error('upstash unreachable')
      }),
    })
    const down = await (await GET()).json()
    expect(down).toMatchObject({
      privateKeyFormat: 'missing',
      privateKeySource: 'none',
      configured: false,
    })
  })

  it('returns privateKeyFormat:"missing" when GITHUB_APP_PRIVATE_KEY is absent', async () => {
    clearAllGithubEnvVars()
    vi.stubEnv('GITHUB_APP_ID', '3216214')

    const body = await (await GET()).json()
    expect(body.privateKeyFormat).toBe('missing')
    expect(body.configured).toBe(false)
  })

  it('returns privateKeyFormat:"invalid" for raw PEM text (old mistake)', async () => {
    vi.stubEnv('GITHUB_APP_ID', '3216214')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', rawPem)

    const body = await (await GET()).json()
    expect(body.privateKeyFormat).toBe('invalid')
    expect(body.configured).toBe(false)
  })

  it('returns privateKeyFormat:"invalid" for base64-encoded PEM text (pre-migration mistake)', async () => {
    vi.stubEnv('GITHUB_APP_ID', '3216214')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', oldFormatB64)

    const body = await (await GET()).json()
    expect(body.privateKeyFormat).toBe('invalid')
    expect(body.configured).toBe(false)
  })

  it('returns privateKeyFormat:"invalid" for unparseable base64 garbage', async () => {
    vi.stubEnv('GITHUB_APP_ID', '3216214')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', Buffer.from('not a real key').toString('base64'))

    const body = await (await GET()).json()
    expect(body.privateKeyFormat).toBe('invalid')
    expect(body.configured).toBe(false)
  })

  it('returns appIdLoaded:false when GITHUB_APP_ID is missing', async () => {
    clearAllGithubEnvVars()
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', validDerB64)

    const body = await (await GET()).json()
    expect(body.appIdLoaded).toBe(false)
    expect(body.privateKeyFormat).toBe('der')
    expect(body.configured).toBe(false)
  })

  it('does NOT leak key bytes or error messages in the response', async () => {
    vi.stubEnv('GITHUB_APP_ID', '3216214')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', rawPem) // triggers raw-PEM detection branch

    const res = await GET()
    const rawBody = await res.text()
    // No fragment of the key should appear in the response.
    expect(rawBody).not.toContain('BEGIN')
    expect(rawBody).not.toContain('PRIVATE KEY')
    expect(rawBody).not.toContain(rawPem.slice(30, 80))
    // The helpful openssl-recipe string from parseAppPrivateKey is for ops
    // logs only — it must NOT leak to unauthenticated callers.
    expect(rawBody).not.toContain('openssl')
    expect(rawBody).not.toContain('PKCS')
  })
})
