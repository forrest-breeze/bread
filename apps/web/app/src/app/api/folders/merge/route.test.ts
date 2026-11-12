/**
 * POST /api/folders/merge — admin-gated atomic topic merge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }))

type AdminMock = {
  from: ReturnType<typeof vi.fn>
  rpc: ReturnType<typeof vi.fn>
}

let adminMock: AdminMock

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminMock),
}))

vi.mock('@/lib/db/workspace', () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: vi.fn((cb: () => unknown) => { void cb }) }
})

import { getActiveWorkspace } from '@/lib/db/workspace'
import { POST } from './route'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const TARGET = '33333333-3333-4333-8333-333333333333'

function chain(opts: { resolve?: unknown } = {}): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in']) c[m] = vi.fn(() => c)
  c.then = (resolve: (v: { data: unknown; error: null }) => void) =>
    resolve({ data: opts.resolve ?? null, error: null })
  return c
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('https://app.example.dev/api/folders/merge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function mockAuthRole(role: string): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'u@example.com' } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: 'wm-1',
    workspace_id: 'ws-1',
    role,
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
}

beforeEach(() => {
  vi.clearAllMocks()
  adminMock = { from: vi.fn(), rpc: vi.fn() }
})

describe('POST /api/folders/merge', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ source_ids: [S1], target_id: TARGET }))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-admin', async () => {
    mockAuthRole('editor')
    const res = await POST(makeRequest({ source_ids: [S1], target_id: TARGET }))
    expect(res.status).toBe(403)
  })

  it('returns 400 when target_id is also a source', async () => {
    mockAuthRole('admin')
    const res = await POST(makeRequest({ source_ids: [S1, TARGET], target_id: TARGET }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when a folder is not a topic in the workspace', async () => {
    mockAuthRole('admin')
    // Pre-check finds only 2 of the 3 ids as topics.
    adminMock.from.mockReturnValue(chain({ resolve: [{ id: S1 }, { id: TARGET }] }))
    const res = await POST(makeRequest({ source_ids: [S1, S2], target_id: TARGET }))
    expect(res.status).toBe(400)
    expect(adminMock.rpc).not.toHaveBeenCalled()
  })

  it('merges via the RPC and returns the result', async () => {
    mockAuthRole('admin')
    adminMock.from.mockReturnValue(
      chain({ resolve: [{ id: S1 }, { id: S2 }, { id: TARGET }] }),
    )
    adminMock.rpc.mockResolvedValue({
      data: {
        target_id: TARGET,
        sources_merged: 2,
        memberships_repointed: 5,
        pins_repointed: 1,
        topic_pages_deleted: 2,
        aliases_written: 2,
      },
      error: null,
    })

    const res = await POST(makeRequest({ source_ids: [S1, S2], target_id: TARGET }))
    const payload = await res.json()

    expect(res.status).toBe(200)
    expect(payload.target_id).toBe(TARGET)
    expect(payload.sources_merged).toBe(2)
    expect(adminMock.rpc).toHaveBeenCalledWith('merge_topic_folders', {
      p_workspace_id: 'ws-1',
      p_source_ids: [S1, S2],
      p_target_id: TARGET,
    })
  })

  it('returns 500 when the merge RPC errors', async () => {
    mockAuthRole('admin')
    adminMock.from.mockReturnValue(
      chain({ resolve: [{ id: S1 }, { id: TARGET }] }),
    )
    adminMock.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })

    const res = await POST(makeRequest({ source_ids: [S1], target_id: TARGET }))
    expect(res.status).toBe(500)
  })
})
