import { vi, type Mock } from "vitest"

/**
 * Shared Supabase client test helpers.
 *
 * Most API-route tests need the same three ingredients:
 *   1. A Supabase server client whose `auth.getUser()` is mockable.
 *   2. A fluent query-builder (`.from().select().eq().single()`) that can be
 *      wired to a resolved row, array, or error.
 *   3. A way to mock the `getActiveWorkspace` resolver without re-writing the
 *      same `vi.mock` block in every file.
 *
 * These helpers package those ingredients in one import. They are deliberately
 * generic — each test still decides which rows the query returns.
 */

/**
 * A chainable Supabase query-builder mock. Every method returns the same
 * builder so callers can assert `.eq`/`.order`/`.select` were called with the
 * right arguments. Terminal methods (`single`, `maybeSingle`) and iteration
 * (via `then`) resolve to whatever `setResult` was last called with.
 */
export interface QueryBuilderMock {
  abortSignal: Mock
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
  upsert: Mock
  eq: Mock
  neq: Mock
  is: Mock
  in: Mock
  order: Mock
  limit: Mock
  range: Mock
  match: Mock
  single: Mock
  maybeSingle: Mock
  then: Mock
  setResult: (result: { data?: unknown; error?: unknown; count?: number }) => void
}

export function makeQueryBuilder(): QueryBuilderMock {
  let nextResult: { data?: unknown; error?: unknown; count?: number } = {
    data: null,
    error: null,
  }

  const builder = {} as QueryBuilderMock

  const chain = vi.fn(() => builder)

  builder.abortSignal = chain
  builder.select = chain
  builder.insert = chain
  builder.update = chain
  builder.delete = chain
  builder.upsert = chain
  builder.eq = chain
  builder.neq = chain
  builder.is = chain
  builder.in = chain
  builder.order = chain
  builder.limit = chain
  builder.range = chain
  builder.match = chain
  builder.single = vi.fn(() => Promise.resolve(nextResult))
  builder.maybeSingle = vi.fn(() => Promise.resolve(nextResult))
  // Some code awaits the builder directly (`await supabase.from(...).select(...)`)
  // — PostgREST returns a thenable. Support that by exposing `.then`.
  builder.then = vi.fn(
    (onFulfilled: (v: unknown) => unknown) => Promise.resolve(nextResult).then(onFulfilled),
  )
  builder.setResult = (result) => {
    nextResult = result
  }

  return builder
}

/**
 * Mock-shaped Supabase client: `auth.getUser()` plus a `.from()` that returns
 * a QueryBuilderMock. If you need multiple tables in one test, pass a mapping
 * via `fromTable`.
 */
export interface SupabaseClientMock {
  auth: { getUser: Mock; getClaims: Mock }
  from: Mock
  builder: QueryBuilderMock
  builderFor: (table: string) => QueryBuilderMock
}

export function makeSupabaseClient(): SupabaseClientMock {
  const primary = makeQueryBuilder()
  const byTable = new Map<string, QueryBuilderMock>()

  const from = vi.fn((table: string) => {
    const existing = byTable.get(table)
    if (existing) return existing
    // Lazy-create per-table builders so tests can ask for them up front.
    const b = makeQueryBuilder()
    byTable.set(table, b)
    return b
  })

  // `getClaims` derives from the `getUser` stub so a test that wires either
  // one works against both the old (getUser) and new (requireRouteUser →
  // getClaims) auth gates.
  const getUser = vi.fn()
  const getClaims = vi.fn(async () => {
    const result = (await getUser()) as
      | { data?: { user?: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null }; error?: unknown }
      | undefined
    const user = result?.data?.user
    if (!user) return { data: null, error: result?.error ?? null }
    return {
      data: {
        claims: {
          sub: user.id,
          email: user.email,
          user_metadata: user.user_metadata ?? {},
        },
      },
      error: null,
    }
  })

  return {
    auth: { getUser, getClaims },
    from,
    builder: primary,
    builderFor: (table: string): QueryBuilderMock => {
      // Seed the map on first request so `from(table)` returns the same
      // builder the caller just obtained.
      const existing = byTable.get(table)
      if (existing) return existing
      const b = makeQueryBuilder()
      byTable.set(table, b)
      return b
    },
  }
}
