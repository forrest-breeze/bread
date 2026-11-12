import { NextResponse } from 'next/server'
import { buildRedis } from '@/lib/upstash'
import {
  parseAppPrivateKey,
  PRIVATE_KEY_REDIS_KEY,
} from '@/lib/github/github'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PrivateKeyFormat = 'der' | 'missing' | 'invalid'
/** Which of `getAppJWT`'s two sources supplied the key, if either did. */
type PrivateKeySource = 'env' | 'redis' | 'none'

function formatOf(raw: string): PrivateKeyFormat {
  try {
    // We call parseAppPrivateKey for its validation, not its result. The
    // returned KeyObject is discarded so no key bytes can leak out of this
    // function. The thrown Error message (which points ops to the openssl
    // recipe) is swallowed — safe for logs, NOT safe for an unauthenticated
    // response body.
    parseAppPrivateKey(raw)
    return 'der'
  } catch {
    return 'invalid'
  }
}

/**
 * Resolve the key exactly the way `getAppJWT` does: env var first, then the
 * Upstash fallback. Checking only the env var made this probe report
 * `configured: false` on a healthy Upstash-backed deployment — a false alarm
 * that is worse than no probe, because it points ops at the wrong thing.
 */
async function resolvePrivateKey(): Promise<{
  format: PrivateKeyFormat
  source: PrivateKeySource
}> {
  const fromEnv = process.env.GITHUB_APP_PRIVATE_KEY
  if (fromEnv) return { format: formatOf(fromEnv), source: 'env' }

  const redis = buildRedis()
  if (!redis) return { format: 'missing', source: 'none' }
  try {
    const stored = await redis.get<string>(PRIVATE_KEY_REDIS_KEY)
    if (!stored) return { format: 'missing', source: 'none' }
    return { format: formatOf(stored), source: 'redis' }
  } catch {
    // A Redis outage is not a malformed key. /api/health reports Redis health
    // on its own; from here the key is simply unavailable to the runtime.
    return { format: 'missing', source: 'none' }
  }
}

export async function GET(): Promise<NextResponse> {
  const appIdLoaded = Boolean(process.env.GITHUB_APP_ID)
  const webhookSecretLoaded = Boolean(process.env.GITHUB_WEBHOOK_SECRET)
  const { format: privateKeyFormat, source: privateKeySource } =
    await resolvePrivateKey()

  return NextResponse.json({
    configured: appIdLoaded && privateKeyFormat === 'der',
    appIdLoaded,
    privateKeyFormat,
    privateKeySource,
    webhookSecretLoaded,
  })
}
