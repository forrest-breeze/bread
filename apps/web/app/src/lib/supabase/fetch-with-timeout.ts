/**
 * Hard floor under every network call a server-side Supabase client makes
 * (GoTrue auth AND PostgREST queries).
 *
 * Why this must exist: supabase-js attaches the session's access token to
 * every DB query via `auth.getSession()`, which runs inside the per-session
 * process lock (see process-lock.ts). Neither auth-js nor postgrest-js puts a
 * timeout on its fetch, so a single black-holed request never settles, never
 * releases the lock, and wedges every subsequent auth check and DB query for
 * that session until the process restarts. The `withTimeout` wrappers higher
 * up (get-auth-user, route-auth) abandon their *await* but cannot release the
 * *lock* — only settling the underlying promise does, which is what aborting
 * at the socket level guarantees.
 *
 * 15s is a backstop, not a budget: the interactive paths already fail fast at
 * 3s via `withTimeout`. This only exists so nothing can hang forever.
 */
const SUPABASE_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS);
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
  signal.throwIfAborted();
  // PostgREST owns HTTP retries; another retry loop here would multiply them.
  return fetch(input, { ...init, signal });
}
