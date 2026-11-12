/**
 * InMemoryTokenCache — per-container Map-backed TokenCache.
 *
 * This is the fallback implementation used when no external cache backend is
 * configured (see token-cache-factory.ts). It is also used as the Tier-2
 * layer inside TieredTokenCache so that within a single warm Lambda we never
 * pay an outbound network hop for a token we just fetched.
 *
 * Contract: see token-cache.ts. Summary of behaviour:
 *  - get: returns null on miss; returns null + deletes on entries inside the
 *    SAFETY_MARGIN_MS window (lazy eviction, no timers).
 *  - set: no-op when expiresAtMs - now <= SAFETY_MARGIN_MS.
 *  - clear(id): removes one entry; clear(): removes every entry.
 *  - Never throws.
 */
import {
  SAFETY_MARGIN_MS,
  type CachedToken,
  type TokenCache,
} from "./token-cache";

export class InMemoryTokenCache implements TokenCache {
  private readonly store = new Map<number, CachedToken>();

  async get(installationId: number): Promise<CachedToken | null> {
    const entry = this.store.get(installationId);
    if (!entry) return null;

    if (entry.expiresAt - Date.now() <= SAFETY_MARGIN_MS) {
      this.store.delete(installationId);
      return null;
    }

    return entry;
  }

  async set(
    installationId: number,
    token: string,
    expiresAtMs: number,
  ): Promise<void> {
    if (expiresAtMs - Date.now() <= SAFETY_MARGIN_MS) return;
    this.store.set(installationId, { token, expiresAt: expiresAtMs });
  }

  async clear(installationId?: number): Promise<void> {
    if (installationId === undefined) {
      this.store.clear();
      return;
    }
    this.store.delete(installationId);
  }
}
