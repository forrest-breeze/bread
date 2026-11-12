import "server-only"

import { createAdminClient } from "@/lib/supabase/admin"

// Credential audit timestamp (`last_used_at`) was written on EVERY authenticated
// API-key / PAT / MCP request — one UPDATE (plus MVCC dead-tuple + autovacuum
// churn) per call from polling CLIs and MCP agents. The exact write time is not
// load-bearing; a coarse "used within the last few minutes" is enough. Throttle
// to at most one write per credential per window using an in-process timestamp
// cache, so a burst of machine requests collapses to a single write.
//
// The cache is per warm serverless instance: a cold start re-writes on first
// use, which is acceptable (still bounded to ~once/window/instance). Keyed by
// the already-hashed credential, never the raw token. Fire-and-forget — the
// write is best-effort and never blocks the auth outcome.
const TOUCH_WINDOW_MS = 5 * 60 * 1000

const lastTouched = new Map<string, number>()

export function touchLastUsed(
  table: "api_keys" | "personal_access_tokens",
  column: "key_hash" | "token_hash",
  hash: string,
): void {
  const now = Date.now()
  const cacheKey = `${table}:${hash}`
  const prev = lastTouched.get(cacheKey)
  if (prev !== undefined && now - prev < TOUCH_WINDOW_MS) return

  // Guard against unbounded growth from credential churn over a long-lived
  // instance — a coarse reset is fine, it only costs one extra write per key.
  if (lastTouched.size > 10_000) lastTouched.clear()
  lastTouched.set(cacheKey, now)

  const admin = createAdminClient()
  void admin
    .from(table)
    .update({ last_used_at: new Date(now).toISOString() })
    .eq(column, hash)
    .then(({ error }) => {
      if (error) {
        console.error(`[Bread] ${table} last_used_at update failed:`, error)
      }
    })
}

/** Test-only: clear the in-process throttle so cases don't leak state. */
export function resetTouchLastUsedCache(): void {
  lastTouched.clear()
}
