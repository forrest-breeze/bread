import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestFromText } from '@/rag/ingest'
import { syncGitHubHostedDocs } from './github-hosted-docs'

vi.mock('@/rag/ingest', () => ({
  ingestFromText: vi.fn().mockResolvedValue(undefined),
  updateDocumentEmbedding: vi.fn().mockResolvedValue(undefined),
}))

const workspaceId = '22222222-2222-4222-8222-222222222222'
const documentId = '11111111-1111-4111-8111-111111111111'
const sourceId = '33333333-3333-4333-8333-333333333333'
const path = 'docs/bread-docs/setup.md'
const repoId = 1185697075
const priorBlobSha = 'old-blob-sha'
const incomingBlobSha = 'new-blob-sha'
const incomingCommitSha = 'new-commit-sha'
const incomingDate = '2026-08-20T00:00:00.000Z'
const existingUpdatedAt = '2026-07-01T09:30:00.000Z'
const priorTitle = 'Old title'
const priorGitHubContent = 'Old body.'
const incomingTitle = 'New title'
const incomingContent = 'New body.'

const rawIncomingDocument = [
  '---',
  `title: ${JSON.stringify(incomingTitle)}`,
  `bread_document_id: ${JSON.stringify(documentId)}`,
  'date: "2026-08-20T00:00:00Z"',
  '---',
  '',
  `# ${incomingTitle}`,
  '',
  incomingContent,
].join('\n')

type QueryOperation = 'select' | 'insert' | 'update'

interface QueryRecord {
  table: string
  operation: QueryOperation | null
  payload?: unknown
  selected?: string
  selectOptions?: Record<string, unknown>
  single?: 'maybe' | 'one'
  filters: Array<{ method: string; column: string; value: unknown }>
}

interface AdminFixture {
  admin: SupabaseClient
  queries: QueryRecord[]
  rpc: ReturnType<typeof vi.fn>
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function hasFilter(
  query: QueryRecord,
  method: string,
  column: string,
  value?: unknown,
): boolean {
  return query.filters.some(
    (filter) =>
      filter.method === method &&
      filter.column === column &&
      (arguments.length < 4 || JSON.stringify(filter.value) === JSON.stringify(value)),
  )
}

interface FolderRowFixture {
  id: string
  parent_folder_id: string | null
}

interface CheckpointRowFixture {
  path: string
  folderId: string | null
}

function makeAdmin(
  currentContent: string,
  options: {
    folderId?: string | null
    /** Rows for the workspace folder-ancestry lookup (`id, parent_folder_id`). */
    folders?: FolderRowFixture[]
    /** Established canonical rows; defaults to the top-level fixture document. */
    checkpointRows?: CheckpointRowFixture[]
  } = {},
): AdminFixture {
  const queries: QueryRecord[] = []

  class QueryBuilder implements PromiseLike<unknown> {
    readonly record: QueryRecord

    constructor(table: string) {
      this.record = { table, operation: null, filters: [] }
      queries.push(this.record)
    }

    select(columns: string, options?: Record<string, unknown>): this {
      if (!this.record.operation) this.record.operation = 'select'
      this.record.selected = columns
      this.record.selectOptions = options
      return this
    }

    insert(payload: unknown): this {
      this.record.operation = 'insert'
      this.record.payload = payload
      return this
    }

    update(payload: unknown): this {
      this.record.operation = 'update'
      this.record.payload = payload
      return this
    }

    eq(column: string, value: unknown): this {
      this.record.filters.push({ method: 'eq', column, value })
      return this
    }

    contains(column: string, value: unknown): this {
      this.record.filters.push({ method: 'contains', column, value })
      return this
    }

    in(column: string, value: unknown): this {
      this.record.filters.push({ method: 'in', column, value })
      return this
    }

    is(column: string, value: unknown): this {
      this.record.filters.push({ method: 'is', column, value })
      return this
    }

    not(column: string, operator: string, value: unknown): this {
      this.record.filters.push({
        method: 'not',
        column,
        value: { operator, value },
      })
      return this
    }

    order(column: string, value: unknown): this {
      this.record.filters.push({ method: 'order', column, value })
      return this
    }

    range(from: number, to: number): this {
      this.record.filters.push({ method: 'range', column: '', value: [from, to] })
      return this
    }

    limit(value: number): this {
      this.record.filters.push({ method: 'limit', column: '', value })
      return this
    }

    maybeSingle(): this {
      this.record.single = 'maybe'
      return this
    }

    single(): this {
      this.record.single = 'one'
      return this
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(resolveQuery(this.record)).then(onfulfilled, onrejected)
    }
  }

  const canonicalMetadata = {
    canonical_repo_path: path,
    github_hosted_content_hash: hash(priorGitHubContent),
    github_hosted_checkpoint_blob_sha: priorBlobSha,
    github_hosted_checkpoint_mode: 'merge',
    repo_id: repoId,
    repo_full_name: 'bread/bread',
    path,
    commit_sha: 'old-commit-sha',
  }

  function resolveQuery(record: QueryRecord): unknown {
    if (record.table === 'github_hosted_docs_sources') {
      return { data: null, error: null }
    }

    if (record.table === 'folders') {
      if (record.operation === 'insert') {
        return { data: { id: 'new-folder-id' }, error: null }
      }
      if (record.operation === 'select' && record.selected === 'id, parent_folder_id') {
        return { data: options.folders ?? [], error: null }
      }
      return { data: null, error: null }
    }

    if (record.table === 'github_repo_files') {
      return record.operation === 'select'
        ? { data: { id: 'repo-file-state-id' }, error: null }
        : { data: null, error: null }
    }

    if (record.table !== 'documents') {
      throw new Error(`Unexpected table in test Supabase client: ${record.table}`)
    }

    if (record.operation === 'update') {
      return { data: null, error: null }
    }

    if (record.operation === 'insert') {
      return { data: { id: 'new-document-id' }, error: null }
    }

    if (record.selected === 'source_metadata, deleted_at, folder_id') {
      return {
        data: options.checkpointRows
          ? options.checkpointRows.map((row) => ({
            source_metadata: {
              ...canonicalMetadata,
              canonical_repo_path: row.path,
              path: row.path,
            },
            deleted_at: null,
            folder_id: row.folderId,
          }))
          : [{
            source_metadata: canonicalMetadata,
            deleted_at: null,
            folder_id: 'root-folder-id',
          }],
        error: null,
      }
    }

    if (record.selected === 'id, source_metadata') {
      return {
        data: {
          id: 'repository-companion-id',
          source_metadata: {
            kind: 'repository_file',
            repo_id: repoId,
            path,
          },
        },
        error: null,
      }
    }

    if (record.selected === 'id' && record.selectOptions?.head === true) {
      return {
        data: null,
        count: currentContent === priorGitHubContent ? 0 : 1,
        error: null,
      }
    }

    const documentColumns =
      'id, title, content, status, source_metadata, deleted_at, updated_at'
    if (
      record.selected?.startsWith(documentColumns) &&
      hasFilter(record, 'contains', 'source_metadata', {
        canonical_repo_path: path,
      })
    ) {
      return {
        data: [{
          id: documentId,
          title: priorTitle,
          content: currentContent,
          status: 'Published',
          source_metadata: canonicalMetadata,
          deleted_at: null,
          updated_at: existingUpdatedAt,
          folder_id: options.folderId ?? null,
        }],
        error: null,
      }
    }

    if (record.selected?.startsWith(documentColumns)) {
      return { data: record.single === 'maybe' ? null : [], error: null }
    }

    // No OpenAPI specs in these fixtures, so no generated pages exist.
    if (
      record.selected === 'id, title, content, status, folder_id, sort_order, source_metadata' &&
      hasFilter(record, 'contains', 'source_metadata', {
        kind: 'github_hosted_openapi_operation',
        repo_id: repoId,
      })
    ) {
      return { data: [], error: null }
    }

    throw new Error(
      `Unexpected documents query in test Supabase client: ${JSON.stringify(record)}`,
    )
  }

  const rpc = vi.fn().mockResolvedValue({
    data: [{
      applied: true,
      snapshot_created: true,
      head_changed: true,
      stale: false,
    }],
    error: null,
  })

  return {
    admin: {
      from: (table: string) => new QueryBuilder(table),
      rpc,
    } as unknown as SupabaseClient,
    queries,
    rpc,
  }
}

function syncDeps(
  admin: SupabaseClient,
  raw: string = rawIncomingDocument,
  docPath: string = path,
) {
  return {
    admin,
    getToken: vi.fn().mockResolvedValue('installation-token'),
    getCommit: vi.fn().mockResolvedValue({
      sha: incomingCommitSha,
      commit: { tree: { sha: 'tree-sha' } },
    }),
    getTree: vi.fn().mockResolvedValue({
      sha: 'tree-sha',
      truncated: false,
      tree: [{
        path: docPath,
        mode: '100644',
        type: 'blob' as const,
        sha: incomingBlobSha,
        size: Buffer.byteLength(raw),
        url: `https://api.github.test/blobs/${incomingBlobSha}`,
      }],
    }),
    getBlob: vi.fn().mockResolvedValue({
      sha: incomingBlobSha,
      size: Buffer.byteLength(raw),
      encoding: 'base64',
      content: Buffer.from(raw).toString('base64'),
    }),
  }
}

const target = {
  sourceId,
  workspaceId,
  installationId: 42,
  repoId,
  repoFullName: 'bread/bread',
  paths: ['docs/bread-docs'],
  ref: 'main',
  lastSyncCommitSha: 'old-commit-sha',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('syncGitHubHostedDocs atomic document updates', () => {
  it('waits for bounded indexing work before completing the sync', async () => {
    const fixture = makeAdmin(priorGitHubContent)
    let releaseIngest!: () => void
    vi.mocked(ingestFromText).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseIngest = resolve
      }),
    )

    let settled = false
    const sync = syncGitHubHostedDocs(target, syncDeps(fixture.admin))
      .finally(() => {
        settled = true
      })

    await vi.waitFor(() => expect(ingestFromText).toHaveBeenCalledOnce())
    expect(settled).toBe(false)

    releaseIngest()
    await expect(sync).resolves.toMatchObject({ updated: 1, created: 0 })
    expect(settled).toBe(true)
  })

  it('routes a clean GitHub change through the snapshotting RPC', async () => {
    const fixture = makeAdmin(priorGitHubContent)

    await expect(
      syncGitHubHostedDocs(target, syncDeps(fixture.admin)),
    ).resolves.toMatchObject({ updated: 1, created: 0, commitSha: incomingCommitSha })

    expect(fixture.rpc).toHaveBeenCalledOnce()
    expect(fixture.rpc).toHaveBeenCalledWith(
      'apply_github_hosted_document_update',
      {
        p_document_id: documentId,
        p_workspace_id: workspaceId,
        p_expected_title: priorTitle,
        p_expected_content: priorGitHubContent,
        p_title: incomingTitle,
        p_content: incomingContent,
        p_source_metadata_patch: {
          canonical_repo_path: path,
          bread_document_id: documentId,
          github_hosted_sync: true,
          github_hosted_conflict: false,
          github_hosted_content_hash: hash(incomingContent),
          github_hosted_pending_content_hash: null,
          github_hosted_pending_commit_sha: null,
          github_hosted_checkpoint_blob_sha: incomingBlobSha,
          github_hosted_checkpoint_mode: 'merge',
          published_date: incomingDate,
          repo_id: repoId,
          repo_full_name: 'bread/bread',
          path,
          ref: 'main',
          commit_sha: incomingCommitSha,
        },
        // A plain last-modified now: the entry's feed position comes from
        // published_date above, so this no longer has to carry the date.
        p_updated_at: expect.any(String),
        p_require_conflict: false,
      },
    )

    const directCuratedUpdates = fixture.queries.filter(
      (query) =>
        query.table === 'documents' &&
        query.operation === 'update' &&
        hasFilter(query, 'eq', 'id', documentId),
    )
    expect(directCuratedUpdates).toEqual([])
  })

  it('keeps a merge conflict metadata-only and does not call the RPC', async () => {
    const fixture = makeAdmin('Bread-authored edit.')

    await expect(
      syncGitHubHostedDocs(target, syncDeps(fixture.admin)),
    ).resolves.toMatchObject({ updated: 0, created: 0 })

    expect(fixture.rpc).not.toHaveBeenCalled()
    const [conflictUpdate] = fixture.queries.filter(
      (query) =>
        query.table === 'documents' &&
        query.operation === 'update' &&
        hasFilter(query, 'eq', 'id', documentId),
    )
    expect(conflictUpdate?.payload).toEqual({
      source_metadata: expect.objectContaining({
        canonical_repo_path: path,
        github_hosted_conflict: true,
        github_hosted_pending_content_hash: hash(incomingContent),
        github_hosted_pending_commit_sha: incomingCommitSha,
      }),
    })
    expect(conflictUpdate?.payload).not.toHaveProperty('title')
    expect(conflictUpdate?.payload).not.toHaveProperty('content')
  })
})

// ---------------------------------------------------------------------------
// The repository owns an entry's date. A declared `date:` is stored as the
// document's publication date, which is what dated feeds (changelog, blog)
// order and label by — so `updated_at` goes back to meaning last-modified and
// editing an entry can no longer move it up the feed.
// ---------------------------------------------------------------------------
describe('syncGitHubHostedDocs publication date', () => {
  it('stores a declared date as the publication date', async () => {
    const fixture = makeAdmin(priorGitHubContent)

    await syncGitHubHostedDocs(target, syncDeps(fixture.admin))

    expect(fixture.rpc).toHaveBeenCalledWith(
      'apply_github_hosted_document_update',
      expect.objectContaining({
        p_source_metadata_patch: expect.objectContaining({
          published_date: incomingDate,
        }),
      }),
    )
  })

  it('leaves any stored date alone when the file declares none', async () => {
    const fixture = makeAdmin(priorGitHubContent)
    const withoutDate = [
      '---',
      `title: ${JSON.stringify(incomingTitle)}`,
      `bread_document_id: ${JSON.stringify(documentId)}`,
      '---',
      '',
      `# ${incomingTitle}`,
      '',
      incomingContent,
    ].join('\n')

    await syncGitHubHostedDocs(target, syncDeps(fixture.admin, withoutDate))

    const patch = fixture.rpc.mock.calls[0]?.[1] as {
      p_source_metadata_patch: Record<string, unknown>
    }
    // Absent rather than null: writing null would erase a date the repository
    // simply did not restate on this pass.
    expect(patch.p_source_metadata_patch).not.toHaveProperty('published_date')
  })

  it('records updated_at as a plain last-modified, not the entry date', async () => {
    const fixture = makeAdmin(priorGitHubContent)
    const before = Date.now()

    await syncGitHubHostedDocs(target, syncDeps(fixture.admin))

    const call = fixture.rpc.mock.calls[0]?.[1] as { p_updated_at: string }
    expect(new Date(call.p_updated_at).getTime()).toBeGreaterThanOrEqual(before)
    expect(call.p_updated_at).not.toBe(incomingDate)
  })
})

// ---------------------------------------------------------------------------
// The selected repository root IS the workspace root. Nothing is nested under
// a connector-owned "<Repo> Docs" folder: a top-level file is folderless and a
// top-level directory becomes a top-level folder. Directory folders mirror the
// repository tree in every mode; "Use GitHub" additionally makes each
// document's placement follow the repository, while merge leaves a document
// where Bread put it.
// ---------------------------------------------------------------------------
describe('syncGitHubHostedDocs workspace-root placement', () => {
  const folderMoves = (fixture: AdminFixture) =>
    fixture.queries.filter(
      (query) =>
        query.table === 'documents' &&
        query.operation === 'update' &&
        hasFilter(query, 'eq', 'id', documentId) &&
        typeof query.payload === 'object' &&
        query.payload !== null &&
        'folder_id' in query.payload,
    )

  it('moves a matched top-level file out of its legacy container when GitHub wins', async () => {
    const fixture = makeAdmin(priorGitHubContent, { folderId: 'legacy-docs-wrapper' })

    await expect(
      syncGitHubHostedDocs(
        { ...target, mode: 'replace_bread', force: true },
        syncDeps(fixture.admin),
      ),
    ).resolves.toMatchObject({ updated: 1, moved: 1, rootFolderId: null })

    expect(folderMoves(fixture).map((query) => query.payload)).toEqual([
      { folder_id: null },
    ])
    expect(fixture.rpc).toHaveBeenCalledOnce()
    // No "<Repo> Docs" container is looked up or created any more.
    expect(
      fixture.queries.filter(
        (query) =>
          query.table === 'folders' && hasFilter(query, 'eq', 'display_name'),
      ),
    ).toEqual([])
  })

  it('keeps Bread placement during merge', async () => {
    const fixture = makeAdmin(priorGitHubContent, { folderId: 'legacy-docs-wrapper' })

    await expect(
      syncGitHubHostedDocs(target, syncDeps(fixture.admin)),
    ).resolves.toMatchObject({ updated: 1, moved: 0 })

    expect(folderMoves(fixture)).toEqual([])
  })

  it('lifts an established top-level directory folder out of a legacy container during merge', async () => {
    // `guides/` was imported while a "<Repo> Docs" container still wrapped the
    // tree. With the root as the workspace root, the directory folder belongs
    // at the top level in every mode, not only when GitHub wins.
    const guidePath = 'docs/bread-docs/guides/setup.md'
    const fixture = makeAdmin(priorGitHubContent, {
      folders: [
        { id: 'legacy-docs-wrapper', parent_folder_id: null },
        { id: 'guides-folder-id', parent_folder_id: 'legacy-docs-wrapper' },
      ],
      checkpointRows: [{ path: guidePath, folderId: 'guides-folder-id' }],
    })

    await expect(
      syncGitHubHostedDocs(
        target,
        syncDeps(fixture.admin, rawIncomingDocument, guidePath),
      ),
    ).resolves.toMatchObject({ moved: 1, rootFolderId: null })

    const reparents = fixture.queries.filter(
      (query) => query.table === 'folders' && query.operation === 'update',
    )
    expect(reparents).toHaveLength(1)
    expect(reparents[0]?.payload).toEqual({ parent_folder_id: null })
    expect(hasFilter(reparents[0]!, 'eq', 'id', 'guides-folder-id')).toBe(true)
    // The established folder is reused rather than recreated at the root.
    expect(
      fixture.queries.filter(
        (query) => query.table === 'folders' && query.operation === 'insert',
      ),
    ).toEqual([])
  })

  it('creates a top-level directory folder at the workspace root for a new file', async () => {
    const fixture = makeAdmin(priorGitHubContent)
    const newDocumentId = '44444444-4444-4444-8444-444444444444'
    const newPath = 'docs/bread-docs/guides/first-guide.md'
    const raw = [
      '---',
      'title: "First guide"',
      `bread_document_id: ${JSON.stringify(newDocumentId)}`,
      '---',
      '',
      '# First guide',
      '',
      'Start here.',
    ].join('\n')

    await expect(
      syncGitHubHostedDocs(target, syncDeps(fixture.admin, raw, newPath)),
    ).resolves.toMatchObject({ created: 1, updated: 0, rootFolderId: null })

    const [folderInsert] = fixture.queries.filter(
      (query) => query.table === 'folders' && query.operation === 'insert',
    )
    expect(folderInsert?.payload).toEqual(
      expect.objectContaining({
        parent_folder_id: null,
        display_name: 'Guides',
        name: `github-hosted-docs-${repoId}-guides`,
        visibility: 'workspace',
      }),
    )
    const [documentInsert] = fixture.queries.filter(
      (query) =>
        query.table === 'documents' &&
        query.operation === 'insert' &&
        typeof query.payload === 'object' &&
        query.payload !== null &&
        'folder_id' in query.payload,
    )
    expect(documentInsert?.payload).toEqual(
      expect.objectContaining({
        title: 'First guide',
        folder_id: 'new-folder-id',
        source_metadata: expect.objectContaining({
          canonical_repo_path: newPath,
          bread_document_id: newDocumentId,
        }),
      }),
    )
  })
})
