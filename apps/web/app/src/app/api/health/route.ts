import { NextResponse } from 'next/server'
import { buildRedis } from '@/lib/upstash'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getCommitSha(): string {
  return (
    process.env.COMMIT_REF ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NETLIFY_COMMIT_REF ||
    'unknown'
  )
}

type RedisStatus = 'ok' | 'degraded' | 'disabled'

// Build a fresh Redis instance per call rather than reuse the TokenCache
// singleton: a health check should exercise a clean connection attempt, not
// mask an error with a cached-healthy client. Using buildRedis() keeps both
// code paths in sync on constructor options.
async function getRedisStatus(): Promise<RedisStatus> {
  const redis = buildRedis()
  if (!redis) return 'disabled'
  try {
    await redis.ping()
    return 'ok'
  } catch (err) {
    console.warn('[Bread] /api/health: Upstash ping failed:', err)
    return 'degraded'
  }
}

// No auth — intentional. This is a public liveness probe consumed by uptime
// checkers and cannot block on a Supabase session lookup. The response shape
// is booleans + a commit sha + a tri-state Redis field; no env values leak.
export async function GET(): Promise<NextResponse> {
  const redis = await getRedisStatus()
  return NextResponse.json({ ok: true, commit: getCommitSha(), redis })
}
