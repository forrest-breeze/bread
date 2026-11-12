/**
 * /api/folders/[id] — folder body editing (content field).
 *
 * Covers the Notion/Confluence-style editable folder body added in
 * `fix/ux-surface-parity`:
 *   - PATCH accepts `content` and persists it
 *   - GET returns `content` in the folder payload
 *   - PATCH rejects oversize content (mirrors documents 2 MB cap)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }))

type SupabaseMock = {
  auth: { getUser: typeof mockGetUser }
  from: ReturnType<typeof vi.fn>
}

type AdminMock = {
  from: ReturnType<typeof vi.fn>
  rpc: ReturnType<typeof vi.fn>
}

let supabaseMock: SupabaseMock
let adminMock: AdminMock

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminMock),
}))

vi.mock('@/lib/db/workspace', () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock('@/lib/embeddings', () => ({
  generateEmbedding: vi.fn(async () => new Array(768).fill(0)),
}))

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn,
}))

// `after()` runs outside a request scope in unit tests; stub it to a no-op
// while keeping NextResponse / NextRequest real.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: vi.fn((cb: () => unknown) => { void cb }) }
})

import { getActiveWorkspace } from '@/lib/db/workspace'
import { revalidateTag } from 'next/cache'
import { GET, PATCH, DELETE } from './route'

// Minimal chainable PostgREST builder mock. maybeSingle/single resolve to the
// configured rows; every filter/mutation method returns the same chain so call
// order doesn't matter; awaiting the chain (upsert/update without single)
// resolves to a no-op result.
function chain(opts: { maybeSingle?: unknown; single?: unknown } = {}): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'update', 'upsert', 'insert', 'delete', 'eq', 'neq', 'in', 'is', 'order']) {
    c[m] = vi.fn(() => c)
  }
  c.maybeSingle = vi.fn(async () => ({ data: opts.maybeSingle ?? null, error: null }))
  c.single = vi.fn(async () => ({ data: opts.single ?? null, error: null }))
  c.then = (resolve: (v: { data: unknown; error: null }) => void) =>
    resolve({ data: null, error: null })
  return c
}

function writeChain(): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const method of ['eq', 'is']) {
    c[method] = vi.fn(() => c)
  }
  c.then = (resolve: (value: { data: null; error: null }) => void) =>
    resolve({ data: null, error: null })
  return c
}

function mockAuth(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'u@example.com' } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: 'wm-1',
    workspace_id: 'ws-1',
    role: 'admin',
  })
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://app.example.dev/api/folders/550e8400-e29b-41d4-a716-446655440000', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeGetRequest(): NextRequest {
  return new NextRequest('https://app.example.dev/api/folders/550e8400-e29b-41d4-a716-446655440000', {
    method: 'GET',
  })
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const folderRouteParams = { params: Promise.resolve({ id: VALID_UUID }) }

beforeEach(() => {
  supabaseMock = {
    auth: { getUser: mockGetUser },
    from: vi.fn(),
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('PATCH /api/folders/[id] — removed page content', () => {
  it.each(['<p>Folder page</p>', ''])('rejects content writes without touching folders', async (content) => {
    mockAuth()
    const res = await PATCH(makePatchRequest({ content }), folderRouteParams)
    expect(res.status).toBe(400)
    expect(supabaseMock.from).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/folders/[id] — input validation', () => {
  it('rejects non-uuid params id with 400', async () => {
    mockAuth()
    const res = await PATCH(
      makePatchRequest({ name: 'Renamed' }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    )
    expect(res.status).toBe(400)
  })

  it('rejects malformed JSON with 400', async () => {
    mockAuth()
    const req = new NextRequest('https://app.example.dev/api/folders/550e8400-e29b-41d4-a716-446655440000', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    const res = await PATCH(req, folderRouteParams)
    expect(res.status).toBe(400)
  })

  it('rejects name over 120 chars with 400', async () => {
    mockAuth()
    const res = await PATCH(
      makePatchRequest({ name: 'x'.repeat(121) }),
      folderRouteParams,
    )
    expect(res.status).toBe(400)
  })

  it('rejects unknown visibility with 400', async () => {
    mockAuth()
    const res = await PATCH(
      makePatchRequest({ visibility: 'private' }),
      folderRouteParams,
    )
    expect(res.status).toBe(400)
  })

  it('rejects visibility=role without required_role with 400', async () => {
    mockAuth()
    const res = await PATCH(
      makePatchRequest({ visibility: 'role' }),
      folderRouteParams,
    )
    expect(res.status).toBe(400)
  })

  it('rejects unknown required_role with 400', async () => {
    mockAuth()
    const res = await PATCH(
      makePatchRequest({ visibility: 'role', required_role: 'wizard' }),
      folderRouteParams,
    )
    expect(res.status).toBe(400)
  })

  it('rejects setting parent_folder_id to itself with 400', async () => {
    mockAuth()
    const res = await PATCH(
      makePatchRequest({ parent_folder_id: VALID_UUID }),
      folderRouteParams,
    )
    expect(res.status).toBe(400)
  })
})

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

function mockTopicFolderLoad(folder: { id: string; name: string }): void {
  const loadChain = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: folder.id, kind: 'topic', name: folder.name },
      error: null,
    }),
  }
  supabaseMock.from.mockReturnValue({ select: vi.fn().mockReturnValue(loadChain) })
}

describe('PATCH /api/folders/[id] — topic management (admin-gated)', () => {
  it('returns 403 when a non-admin renames a topic', async () => {
    mockAuthRole('editor')
    mockTopicFolderLoad({ id: 'topic-1', name: 'deploy' })

    const res = await PATCH(makePatchRequest({ name: 'deployment' }), folderRouteParams)
    expect(res.status).toBe(403)
  })

  it('rejects a topic PATCH with no name (rename is the only topic edit)', async () => {
    mockAuthRole('admin')
    mockTopicFolderLoad({ id: 'topic-1', name: 'deploy' })

    const res = await PATCH(makePatchRequest({ visibility: 'workspace' }), folderRouteParams)
    expect(res.status).toBe(400)
  })

  it('renames a topic: updates name+display_name and writes the old name as an alias', async () => {
    mockAuthRole('admin')
    mockTopicFolderLoad({ id: 'topic-1', name: 'deploy' })

    const aliasChain = chain()
    adminMock = {
      from: vi.fn((table: string) => {
        if (table === 'folders') {
          return chain({
            maybeSingle: null, // no name collision
            single: {
              id: 'topic-1',
              name: 'deployment',
              display_name: 'Deployment',
              kind: 'topic',
              parent_folder_id: null,
              visibility: 'workspace',
              required_role: null,
              created_at: '2026-06-01T00:00:00Z',
              updated_at: '2026-06-04T00:00:00Z',
            },
          })
        }
        return aliasChain
      }),
      rpc: vi.fn(),
    }

    const res = await PATCH(makePatchRequest({ name: 'Deployment' }), folderRouteParams)
    const payload = await res.json()

    expect(res.status).toBe(200)
    expect(payload.name).toBe('deployment')
    expect(payload.display_name).toBe('Deployment')
    expect(adminMock.rpc).not.toHaveBeenCalled()
    // Old name recorded as an alias pointing back at the renamed folder.
    expect(aliasChain.upsert).toHaveBeenCalledWith(
      {
        workspace_id: 'ws-1',
        alias_name: 'deploy',
        canonical_folder_id: 'topic-1',
      },
      { onConflict: 'workspace_id,alias_name' },
    )
  })

  it('treats a rename that collides with an existing topic as a merge', async () => {
    mockAuthRole('admin')
    mockTopicFolderLoad({ id: 'topic-1', name: 'deploy' })

    adminMock = {
      from: vi.fn(() =>
        // Collision lookup finds an existing topic named "deployment".
        chain({ maybeSingle: { id: 'target-1' } }),
      ),
      rpc: vi.fn(async () => ({
        data: {
          target_id: 'target-1',
          sources_merged: 1,
          memberships_repointed: 3,
          pins_repointed: 0,
          topic_pages_deleted: 1,
          aliases_written: 1,
        },
        error: null,
      })),
    }

    const res = await PATCH(makePatchRequest({ name: 'Deployment' }), folderRouteParams)
    const payload = await res.json()

    expect(res.status).toBe(200)
    expect(payload.merged).toBe(true)
    expect(payload.target_id).toBe('target-1')
    expect(adminMock.rpc).toHaveBeenCalledWith('merge_topic_folders', {
      p_workspace_id: 'ws-1',
      p_source_ids: ['topic-1'],
      p_target_id: 'target-1',
    })
  })
})

describe('DELETE /api/folders/[id] — topic guard', () => {
  it('returns 403 when a non-admin deletes a topic', async () => {
    mockAuthRole('editor')
    const loadChain = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { kind: 'topic' }, error: null }),
    }
    supabaseMock.from.mockReturnValue({ select: vi.fn().mockReturnValue(loadChain) })

    const res = await DELETE(makeGetRequest(), folderRouteParams)
    expect(res.status).toBe(403)
  })

  it('uses the admin client to delete topic pages, unfile documents, and delete the topic', async () => {
    mockAuthRole('admin')
    const loadChain = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { kind: 'topic' }, error: null }),
    }
    supabaseMock.from.mockReturnValue({ select: vi.fn().mockReturnValue(loadChain) })

    const documentDeleteChain = writeChain()
    const documentUpdateChain = writeChain()
    const folderDeleteChain = writeChain()
    const documentsBuilder = {
      delete: vi.fn(() => documentDeleteChain),
      update: vi.fn(() => documentUpdateChain),
    }
    const foldersBuilder = {
      delete: vi.fn(() => folderDeleteChain),
    }
    adminMock = {
      from: vi.fn((table: string) =>
        table === 'documents' ? documentsBuilder : foldersBuilder,
      ),
      rpc: vi.fn(),
    }

    const res = await DELETE(makeGetRequest(), folderRouteParams)
    const payload = await res.json()

    expect(res.status).toBe(200)
    expect(payload.success).toBe(true)
    expect(adminMock.from).toHaveBeenCalledWith('documents')
    expect(adminMock.from).toHaveBeenCalledWith('folders')
    expect(documentsBuilder.delete).toHaveBeenCalled()
    expect(documentsBuilder.update).toHaveBeenCalledWith({ folder_id: null })
    expect(folderDeleteChain.eq).toHaveBeenCalledWith('id', VALID_UUID)
    expect(folderDeleteChain.eq).toHaveBeenCalledWith('workspace_id', 'ws-1')
    expect(folderDeleteChain.eq).toHaveBeenCalledWith('kind', 'topic')
    expect(documentDeleteChain.eq).toHaveBeenCalledWith('document_type', 'topic_page')
    expect(documentUpdateChain.is).toHaveBeenCalledWith('deleted_at', null)
  })
})

describe('DELETE /api/folders/[id] — user folder subtree cascade', () => {
  it('deletes the whole subtree and moves contained documents to trash', async () => {
    mockAuthRole('editor')

    const kindChain = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { kind: 'user' }, error: null }),
    }

    // Subtree walk: the root has one child, the child has none.
    const subtreeResults = [
      { data: [{ id: 'child-1' }], error: null },
      { data: [], error: null },
    ]
    let subtreeCall = 0

    const docsUpdateChain: Record<string, unknown> = {}
    for (const m of ['in', 'eq', 'is']) docsUpdateChain[m] = vi.fn(() => docsUpdateChain)
    docsUpdateChain.then = (resolve: (v: { data: null; error: null }) => void) =>
      resolve({ data: null, error: null })

    const foldersDeleteChain: Record<string, unknown> = {}
    for (const m of ['in', 'eq']) foldersDeleteChain[m] = vi.fn(() => foldersDeleteChain)
    foldersDeleteChain.then = (resolve: (v: { data: null; error: null }) => void) =>
      resolve({ data: null, error: null })

    const foldersBuilder = {
      select: vi.fn((cols: string) => {
        if (cols === 'kind') return kindChain
        const result =
          subtreeResults[Math.min(subtreeCall++, subtreeResults.length - 1)]
        const c: Record<string, unknown> = {}
        c.eq = vi.fn(() => c)
        c.in = vi.fn(() => c)
        c.then = (resolve: (v: unknown) => void) => resolve(result)
        return c
      }),
      delete: vi.fn(() => foldersDeleteChain),
    }
    const documentsBuilder = {
      update: vi.fn(() => docsUpdateChain),
    }
    supabaseMock.from.mockImplementation((table: string) =>
      table === 'folders' ? foldersBuilder : documentsBuilder,
    )

    const res = await DELETE(makeGetRequest(), folderRouteParams)
    const payload = await res.json()

    expect(res.status).toBe(200)
    expect(payload.success).toBe(true)
    // Documents across the whole subtree are soft-deleted, not unfiled.
    expect(documentsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    )
    expect(docsUpdateChain.in).toHaveBeenCalledWith('folder_id', [VALID_UUID, 'child-1'])
    expect(docsUpdateChain.is).toHaveBeenCalledWith('deleted_at', null)
    // The delete targets the full subtree, so children are not re-rooted.
    expect(foldersDeleteChain.in).toHaveBeenCalledWith('id', [VALID_UUID, 'child-1'])
    expect(foldersDeleteChain.eq).toHaveBeenCalledWith('workspace_id', 'ws-1')
    expect(revalidateTag).toHaveBeenCalledWith('public-kb', { expire: 0 })
  })
})

describe('GET /api/folders/[id] — content in payload', () => {
  it('returns 500 when the folder detail query fails', async () => {
    mockAuth()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const folderSelectChain = {
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'column folders.content does not exist' },
        }),
      }

      supabaseMock.from.mockImplementation((table: string) => {
        if (table === 'folders') {
          return { select: vi.fn().mockReturnValue(folderSelectChain) }
        }
        return { select: vi.fn() }
      })

      const res = await GET(makeGetRequest(), folderRouteParams)
      const payload = await res.json()

      expect(res.status).toBe(500)
      expect(payload.error).toBe('Failed to fetch folder')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('includes content field in the folder response', async () => {
    mockAuth()

    const folderRow = {
      id: 'folder-1',
      name: 'Benchmarks',
      display_name: 'Benchmarks',
      kind: 'user',
      parent_folder_id: null,
      visibility: 'workspace',
      required_role: null,
      content: '<p>Team benchmark notes live here.</p>',
      last_seen_at: '2026-04-20T00:00:00Z',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    }

    // Main folder select
    const folderSelectChain = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: folderRow, error: null }),
    }
    // folder_stats (children)
    const statsSelectChain = {
      eq: vi.fn().mockReturnThis(),
      order: vi.fn(),
    }
    statsSelectChain.order
      .mockReturnValueOnce(statsSelectChain)
      .mockResolvedValueOnce({ data: [], error: null })
    // documents — `.is('deleted_at', null)` hides soft-deleted docs
    // (migration 20260602000000_document_trash).
    const docsSelectChain = {
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }

    supabaseMock.from.mockImplementation((table: string) => {
      if (table === 'folders') {
        return { select: vi.fn().mockReturnValue(folderSelectChain) }
      }
      if (table === 'folder_stats') {
        return { select: vi.fn().mockReturnValue(statsSelectChain) }
      }
      if (table === 'documents') {
        return { select: vi.fn().mockReturnValue(docsSelectChain) }
      }
      return { select: vi.fn() }
    })

    const res = await GET(makeGetRequest(), folderRouteParams)
    const payload = await res.json()

    expect(res.status).toBe(200)
    expect(payload.folder.content).toBe('<p>Team benchmark notes live here.</p>')
  })
})
