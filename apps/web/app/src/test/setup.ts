import { vi } from 'vitest'
import '@testing-library/jest-dom'

// Mock next/headers — required for any import chain that reaches @/lib/supabase/server
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    get: vi.fn(),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
  })),
  headers: vi.fn(() => new Headers()),
}))

// `unstable_cache` requires Next's incremental-cache request context, which
// does not exist in the unit-test environment (it throws "incrementalCache
// missing"). Caching is a Next-runtime concern, not business logic, so stub it
// as a pass-through that just invokes the wrapped function. revalidateTag /
// revalidatePath become no-ops.
vi.mock('next/cache', () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}))

// `import "server-only"` throws unconditionally when evaluated outside a
// Next.js server context. Stub it so tests can transitively import
// server-only modules (e.g.,
// `@/lib/settings-search-server`) without each test having to mock the
// downstream module just to bypass the guard.
vi.mock('server-only', () => ({}))

// ---------------------------------------------------------------------------
// getClaims migration shim.
//
// API routes authenticate via `requireRouteUser` (locally-verified JWT claims,
// see @/lib/auth/route-auth) instead of `supabase.auth.getUser()`. The route
// test suites predate that and stub `auth.getUser` on their mock clients. This
// shim derives the same outcome `requireRouteUser` would produce from that
// existing stub, so each suite keeps testing its own route logic without
// re-wiring 37 mock clients. The real helper has dedicated unit tests in
// src/lib/auth/route-auth.test.ts (which vi.unmock this module).
// ---------------------------------------------------------------------------
interface ShimUser {
  id: string
  email?: string
  user_metadata?: Record<string, unknown>
}
interface ShimClient {
  auth: {
    getUser: () => Promise<{ data?: { user?: ShimUser | null } } | undefined>
  }
}
vi.mock('@/lib/auth/route-auth', async () => {
  const { NextResponse } = await import('next/server')
  return {
    requireRouteUser: vi.fn(async (supabase: ShimClient) => {
      const result = await supabase.auth.getUser()
      const user = result?.data?.user ?? null
      if (!user) {
        return {
          user: null,
          response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        }
      }
      return {
        user: {
          id: user.id,
          email: user.email,
          user_metadata: user.user_metadata ?? {},
        },
        response: null,
      }
    }),
  }
})
