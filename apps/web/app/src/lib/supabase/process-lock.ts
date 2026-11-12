// In-process async mutex used to serialize Supabase auth token refreshes on the
// server.
//
// Why this exists: @supabase/auth-js only installs a real lock in the browser
// (via the Web Locks API). On the server it falls back to a no-op, and
// @supabase/ssr builds a fresh client for every middleware pass and every API
// route. So when the dashboard fires several workspace-scoped requests in
// parallel against an expired access token, each client tries to refresh the
// SAME refresh token at the same moment. GoTrue rejects concurrent refreshes
// with `409 conflict: Too many concurrent token refresh requests on the same
// session`, `auth.getUser()` then returns no user, the routes 401, and the
// client retries — a self-sustaining storm that pins the UI on its loading
// state.
//
// Passing this lock to `createServerClient({ auth: { lock } })` serializes the
// refreshes within the Node process: the first request refreshes and rotates
// the token, the rest queue and reuse the result via GoTrue's refresh-token
// reuse window instead of racing.
//
// The lock is keyed on the session's auth cookies (see `sessionLockKey`), NOT
// on the project-wide storage key auth-js would otherwise use. That keeps the
// serialization scoped to a single session: concurrent requests from different
// users never block each other, which matters in production where one process
// serves many users.

// Matches @supabase/auth-js's `LockFunc`. Declared structurally to avoid a
// type-only dependency on the auth-js internals.
type LockFunc = <R>(
  name: string,
  acquireTimeout: number,
  fn: () => Promise<R>,
) => Promise<R>

// Per-key promise chain. Each entry is the tail of the queue for that key; a
// new caller chains onto it and becomes the new tail. Entries are removed once
// their queue drains so the map does not grow without bound.
const tails = new Map<string, Promise<void>>()

/**
 * Hard cap on how long one holder may block its session's queue. Every
 * Supabase call on the server passes through this lock (supabase-js resolves
 * the access token via `auth.getSession()` before each REST request), so a
 * holder whose promise never settles would wedge ALL auth checks and DB
 * queries for the session until the process restarts. The capped holder keeps
 * running in the background and only its own caller still awaits it; the
 * queue moves on. The 15s socket abort in fetch-with-timeout.ts should settle
 * holders long before this fires — this is the last line of defense.
 */
const HOLD_CAP_MS = 20_000

async function runExclusive<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const previous = tails.get(key) ?? Promise.resolve()

  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })

  // Our turn comes after the previous holder releases. Later callers will await
  // `tail`, keeping the queue ordered.
  const tail = previous.then(() => done)
  tails.set(key, tail)
  // Drop the map entry once this link settles and nobody chained after it —
  // hooked here (not in the finally) so cleanup also happens when a capped
  // holder's fn() never settles.
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key)
    }
  })

  // Wait for our turn regardless of whether the predecessor resolved or threw.
  await previous.catch(() => {})

  const capTimer = setTimeout(() => {
    console.warn(
      "[Bread] process-lock: holder exceeded HOLD_CAP_MS, releasing queue for session lock"
    )
    release()
  }, HOLD_CAP_MS)

  try {
    return await fn()
  } finally {
    clearTimeout(capTimer)
    release()
  }
}

/**
 * Builds a lock key from the Supabase auth cookies so only concurrent requests
 * for the *same* session serialize. Returns `null` when there is no session
 * (nothing to refresh, so nothing to serialize).
 */
export function sessionLockKey(
  cookies: { name: string; value: string }[],
): string | null {
  const authCookies = cookies
    .filter((c) => c.name.includes("-auth-token"))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (authCookies.length === 0) return null
  return authCookies.map((c) => `${c.name}=${c.value}`).join("&")
}

/**
 * Returns a `LockFunc` for `createServerClient({ auth: { lock } })`. When a
 * session key is present, refreshes for that session are serialized through the
 * in-process queue; otherwise the lock is a passthrough (preserving auth-js's
 * default no-op behavior for unauthenticated requests).
 */
export function createSessionRefreshLock(key: string | null): LockFunc {
  if (!key) {
    return (_name, _acquireTimeout, fn) => fn()
  }
  return (_name, _acquireTimeout, fn) => runExclusive(key, fn)
}
