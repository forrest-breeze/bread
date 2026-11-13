/**
 * getInstallationTokenCached — swap-ready installation-token cache front-end.
 *
 * Delegates storage to the TokenCache implementation returned by
 * getTokenCache(), so the backing store (in-memory, Upstash, Supabase, ...)
 * is configurable via env vars without touching callers. See
 * docs/engineering/infrastructure/github-token-cache.md for the swap procedure.
 */
import { getInstallationTokenRaw } from "./github";
import {
  __resetTokenCacheForTests,
  getTokenCache,
} from "./token-cache-factory";

export async function getInstallationTokenCached(
  installationId: number,
): Promise<string> {
  const cache = getTokenCache();
  const hit = await cache.get(installationId);
  if (hit) return hit.token;

  const { token, expiresAt } = await getInstallationTokenRaw(installationId);
  await cache.set(installationId, token, expiresAt);
  return token;
}

/** Test-only: drops the cache singleton so the next call re-reads env + state. */
export function __resetInstallationTokenCacheForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[Breezify] __resetInstallationTokenCacheForTests is a test-only seam and must not be called in production",
    );
  }
  __resetTokenCacheForTests();
}
