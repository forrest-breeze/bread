import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetchWithTimeout } from './fetch-with-timeout'
import { supabaseSecretKey, supabaseUrl } from './env'

// Server-only client using service-role key. Never expose this to the client.
//
// Memoized as a module-level singleton. The service-role client is stateless
// (persistSession / autoRefreshToken off), so it is safe to share across
// requests, and reusing one instance avoids constructing a fresh client — and a
// fresh fetch/keep-alive path — on every call. Hot paths (per-search telemetry,
// per-request credential touches, the ingest fan-out) previously built a new
// client per call, multiplying socket churn against an already-saturated pool.
let cached: SupabaseClient | null = null

export function createAdminClient(): SupabaseClient {
  if (cached) return cached

  const url = supabaseUrl()
  const secretKey = supabaseSecretKey()

  if (!url || !secretKey) {
    throw new Error('Missing env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY')
  }

  cached = createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    // Abort any call at the socket after 15s — a hung admin query must fail,
    // not pin a route handler forever. See fetch-with-timeout.ts.
    global: {
      fetch: fetchWithTimeout,
    },
  })
  return cached
}
