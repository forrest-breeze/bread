/**
 * Token cache factory + two-tier composition.
 *
 * getTokenCache() is the single entry point every caller should use. It
 * returns a lazily-constructed, process-wide singleton TokenCache chosen by
 * environment variables:
 *
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN present
 *     → TieredTokenCache(local = InMemoryTokenCache, shared = UpstashTokenCache)
 *   either env var missing
 *     → InMemoryTokenCache (per-container fallback, zero ceremony)
 *
 * TieredTokenCache layers the two so a warm Lambda serving repeated requests
 * pays at most one Upstash round-trip per installation per hour. The local
 * mirror is populated on write and write-through-on-read, so subsequent gets
 * land locally.
 *
 * Swapping the shared backend to Supabase (or anything else implementing
 * TokenCache) is a one-file change inside this factory. See
 * docs/engineering/infrastructure/github-token-cache.md for the full swap procedure.
 */
import { buildRedis } from "@/lib/upstash";

import { InMemoryTokenCache } from "./in-memory-token-cache";
import { UpstashTokenCache } from "./upstash-token-cache";
import type { CachedToken, TokenCache } from "./token-cache";

export class TieredTokenCache implements TokenCache {
  constructor(
    private readonly local: TokenCache,
    private readonly shared: TokenCache,
  ) {}

  async get(installationId: number): Promise<CachedToken | null> {
    const localHit = await this.safeGet(this.local, installationId);
    if (localHit) return localHit;

    const sharedHit = await this.safeGet(this.shared, installationId);
    if (sharedHit) {
      await this.safeSet(
        this.local,
        installationId,
        sharedHit.token,
        sharedHit.expiresAt,
      );
    }
    return sharedHit;
  }

  async set(
    installationId: number,
    token: string,
    expiresAtMs: number,
  ): Promise<void> {
    await Promise.all([
      this.safeSet(this.local, installationId, token, expiresAtMs),
      this.safeSet(this.shared, installationId, token, expiresAtMs),
    ]);
  }

  async clear(installationId?: number): Promise<void> {
    await Promise.all([
      this.safeClear(this.local, installationId),
      this.safeClear(this.shared, installationId),
    ]);
  }

  private async safeGet(
    tier: TokenCache,
    installationId: number,
  ): Promise<CachedToken | null> {
    try {
      return await tier.get(installationId);
    } catch (err) {
      console.warn("[Breezify] TieredTokenCache.get tier failed:", err);
      return null;
    }
  }

  private async safeSet(
    tier: TokenCache,
    installationId: number,
    token: string,
    expiresAtMs: number,
  ): Promise<void> {
    try {
      await tier.set(installationId, token, expiresAtMs);
    } catch (err) {
      console.warn("[Breezify] TieredTokenCache.set tier failed:", err);
    }
  }

  private async safeClear(
    tier: TokenCache,
    installationId?: number,
  ): Promise<void> {
    try {
      await tier.clear(installationId);
    } catch (err) {
      console.warn("[Breezify] TieredTokenCache.clear tier failed:", err);
    }
  }
}

let singleton: TokenCache | null = null;

export function getTokenCache(): TokenCache {
  if (singleton) return singleton;

  const redis = buildRedis();
  if (redis) {
    singleton = new TieredTokenCache(
      new InMemoryTokenCache(),
      new UpstashTokenCache(redis),
    );
  } else {
    singleton = new InMemoryTokenCache();
  }
  return singleton;
}

// Test seams — kept as named exports so vitest can reach them, but guarded so
// a production import can't mutate the singleton. The `__` prefix signals
// intent; the NODE_ENV check enforces it.
function assertNotProd(fn: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[Breezify] ${fn} is a test-only seam and must not be called in production`);
  }
}

/** Test seam: replace the singleton with a supplied instance. */
export function __setTokenCacheForTests(cache: TokenCache): void {
  assertNotProd("__setTokenCacheForTests");
  singleton = cache;
}

/** Test seam: discard the singleton so the next getTokenCache() re-reads env. */
export function __resetTokenCacheForTests(): void {
  assertNotProd("__resetTokenCacheForTests");
  singleton = null;
}
