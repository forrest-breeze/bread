/**
 * UpstashTokenCache — TokenCache backed by Upstash Redis over HTTP.
 *
 * This adapter is the primary backend for the GitHub App installation-token
 * cache in production: every Netlify Lambda container shares the same Redis,
 * so a token fetched by one container is reusable by the next cold start
 * inside the same (~1 hour) expiry window.
 *
 * Contract: see token-cache.ts. Notable behaviours:
 *  - set writes JSON-stringified `{ token, expiresAt }` with an EX seconds
 *    TTL derived from (expiresAt - now). Upstash auto-evicts on expiry;
 *    the SAFETY_MARGIN_MS check is still applied on read for belt-and-braces.
 *  - set refuses when the effective TTL is ≤ SAFETY_MARGIN_MS (one round-trip
 *    saved; matches in-memory semantics).
 *  - get returns null on any Redis error, JSON parse error, or stale entry.
 *  - clear(id) issues a single DEL; clear() SCANs by KEY_PREFIX and deletes
 *    every match. Backend errors become warns, never throws — contract §3.
 */
import type { Redis } from "@upstash/redis";

import {
  KEY_PREFIX,
  SAFETY_MARGIN_MS,
  tokenCacheKey,
  type CachedToken,
  type TokenCache,
} from "./token-cache";

export class UpstashTokenCache implements TokenCache {
  constructor(private readonly redis: Redis) {}

  async get(installationId: number): Promise<CachedToken | null> {
    const key = tokenCacheKey(installationId);
    let raw: string | null;
    try {
      raw = await this.redis.get<string>(key);
    } catch (err) {
      console.warn("[Breezify] UpstashTokenCache.get failed:", err);
      return null;
    }
    if (!raw) return null;

    let parsed: CachedToken;
    try {
      parsed = JSON.parse(raw) as CachedToken;
    } catch (err) {
      console.warn("[Breezify] UpstashTokenCache.get parse failed:", err);
      return null;
    }

    if (!parsed?.token || typeof parsed.expiresAt !== "number") return null;
    if (parsed.expiresAt - Date.now() <= SAFETY_MARGIN_MS) return null;
    return parsed;
  }

  async set(
    installationId: number,
    token: string,
    expiresAtMs: number,
  ): Promise<void> {
    const ttlMs = expiresAtMs - Date.now();
    if (ttlMs <= SAFETY_MARGIN_MS) return;

    const key = tokenCacheKey(installationId);
    const value = JSON.stringify({ token, expiresAt: expiresAtMs });
    const ex = Math.floor(ttlMs / 1000);

    try {
      await this.redis.set(key, value, { ex });
    } catch (err) {
      console.warn("[Breezify] UpstashTokenCache.set failed:", err);
    }
  }

  async clear(installationId?: number): Promise<void> {
    try {
      if (installationId !== undefined) {
        await this.redis.del(tokenCacheKey(installationId));
        return;
      }
      let cursor: string | number = "0";
      do {
        const result: [string | number, string[]] = await this.redis.scan(
          cursor,
          { match: `${KEY_PREFIX}*`, count: 100 },
        );
        const [next, keys] = result;
        if (keys.length > 0) await this.redis.del(...keys);
        cursor = next;
        // Upstash's REST SDK returns the terminating cursor as either the
        // string "0" or the number 0 depending on transport/version — compare
        // against both to avoid an infinite loop on the numeric form.
      } while (cursor !== "0" && cursor !== 0);
    } catch (err) {
      console.warn("[Breezify] UpstashTokenCache.clear failed:", err);
    }
  }
}
