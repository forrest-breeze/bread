/**
 * TokenCache — pluggable cache contract for GitHub App installation tokens.
 *
 * The abstraction exists so the backing store can change (in-memory, Upstash
 * Redis, Supabase, …) without any caller touching the swap. Full design +
 * swap procedure in docs/engineering/infrastructure/github-token-cache.md.
 *
 * Contract invariants every implementation MUST honour:
 *   1. `get` applies the SAFETY_MARGIN_MS check. Callers must not pre-subtract.
 *   2. `get` returns a fully-valid CachedToken or null. No stale-but-usable state.
 *   3. No method ever throws. Backend errors produce null (get) or silent
 *      no-ops (set / clear) plus a console.warn log.
 *   4. `set` refuses (no-op) when the effective TTL is already ≤ 0.
 *   5. `installationId` is assumed to be a positive GitHub-assigned integer —
 *      cache implementations do not re-validate.
 */

export interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface TokenCache {
  get(installationId: number): Promise<CachedToken | null>;
  set(installationId: number, token: string, expiresAtMs: number): Promise<void>;
  clear(installationId?: number): Promise<void>;
}

export const SAFETY_MARGIN_MS = 60_000;
export const KEY_PREFIX = "gh:inst-token:";

export function tokenCacheKey(installationId: number): string {
  return `${KEY_PREFIX}${installationId}`;
}
