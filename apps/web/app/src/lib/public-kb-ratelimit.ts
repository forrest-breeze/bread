import "server-only"

import { buildRedis } from "@/lib/upstash"

/**
 * Fixed-window per-key rate limit for public KB compute paths (search).
 *
 * Backed by Upstash Redis when configured; degrades to "allow" when Redis is
 * absent so the public site still works in environments without Upstash. Fail
 * open on Redis errors — availability of a public read site outranks strict
 * limiting, and the browse/read paths are cacheable and cheap regardless.
 */
export async function checkPublicRateLimit(
  key: string,
  limit = 30,
  windowSeconds = 60,
): Promise<boolean> {
  const redis = buildRedis()
  if (!redis) return true

  try {
    const redisKey = `pubkb:rl:${key}`
    const count = await redis.incr(redisKey)
    if (count === 1) {
      await redis.expire(redisKey, windowSeconds)
    }
    return count <= limit
  } catch {
    return true
  }
}
