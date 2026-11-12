/**
 * /api/documents POST — oversize guard + auth/workspace regression guards.
 *
 * Covers plan `docs/plans/knowledge-file-upload-errors.md` §5.3 A1–A4.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockGetUser, mockRevalidateTag } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockRevalidateTag: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidateTag: mockRevalidateTag,
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/db/workspace', () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock('@/lib/db/documents', () => ({
  createWorkspaceDocument: vi.fn(),
}))

vi.mock('@/lib/posthog-server', () => ({
  getPostHogClient: vi.fn(() => ({
    capture: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}))

import { getActiveWorkspace } from '@/lib/db/workspace'
import { createWorkspaceDocument } from '@/lib/db/documents'
import { POST } from './route'

function makeRequest(body: Record<string, unknown> | string): NextRequest {
  return new NextRequest('https://app.example.dev/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function mockAuth(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'u@example.com', user_metadata: {} } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: 'wm-1',
    workspace_id: 'ws-1',
    role: 'admin',
  })
}

beforeEach(() => {
  vi.mocked(createWorkspaceDocument).mockResolvedValue({
    id: 'doc-1',
    title: 'a.md',
    folder_id: null,
  } as unknown as Awaited<ReturnType<typeof createWorkspaceDocument>>)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/documents', () => {
  it('A1: returns 413 with oversize code for content over 2 MB', async () => {
    mockAuth()
    const oversize = 'x'.repeat(2 * 1024 * 1024 + 1)

    const res = await POST(makeRequest({ title: 'huge.md', content: oversize }))
    const body = await res.json()

    expect(res.status).toBe(413)
    expect(body.code).toBe('oversize')
    expect(typeof body.error).toBe('string')
    expect(createWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('A2: returns 201 for content under 2 MB (regression)', async () => {
    mockAuth()
    const content = 'x'.repeat(1024 * 1024)

    const res = await POST(makeRequest({ title: 'small.md', content }))

    expect(res.status).toBe(201)
    expect(createWorkspaceDocument).toHaveBeenCalledTimes(1)
    expect(mockRevalidateTag).toHaveBeenCalledWith('public-kb', { expire: 0 })
  })

  it('A3: returns 401 when unauthenticated (regression)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })

    const res = await POST(makeRequest({ title: 'a.md', content: 'hi' }))

    expect(res.status).toBe(401)
    expect(createWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('A4: returns 404 when no workspace (regression)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'u@example.com', user_metadata: {} } },
    })
    vi.mocked(getActiveWorkspace).mockResolvedValue(null)

    const res = await POST(makeRequest({ title: 'a.md', content: 'hi' }))

    expect(res.status).toBe(404)
    expect(createWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON', async () => {
    mockAuth()
    const res = await POST(makeRequest('{not json'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid JSON')
    expect(createWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('returns 400 for title over 500 chars', async () => {
    mockAuth()
    const res = await POST(makeRequest({ title: 'x'.repeat(501) }))
    expect(res.status).toBe(400)
    expect(createWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('returns 400 for non-string content', async () => {
    mockAuth()
    const res = await POST(makeRequest({ title: 'a.md', content: 42 as unknown as string }))
    expect(res.status).toBe(400)
    expect(createWorkspaceDocument).not.toHaveBeenCalled()
  })
})
