/**
 * Shared Upstash Redis client factory.
 *
 * Single source of truth for how a Redis client is constructed from env vars.
 * Every caller — TokenCache factory, /api/health, future adapters — should
 * use this so constructor options stay in sync and env-var shape is consistent.
 *
 * Returns null when either required env var is absent; callers decide how to
 * degrade (null → InMemoryTokenCache fallback, null → redis status "disabled").
 */
import { Redis } from "@upstash/redis";

export function buildRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}
