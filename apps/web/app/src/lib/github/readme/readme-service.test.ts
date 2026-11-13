import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@bread/core'

const mocks = vi.hoisted(() => ({
  syncReadmeRepository: vi.fn(),
  commitReadmeSpecFile: vi.fn(),
  updateSource: vi.fn(),
  getPullRequest: vi.fn(),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/portal/portal-doc-markdown', () => ({
  portalDocumentToMarkdown: (content: string | null | undefined) => content ?? '',
}))
vi.mock('./readme-store-supabase', () => ({
  createSupabaseReadmeStore: () => ({ updateSource: mocks.updateSource }),
}))
vi.mock('./readme-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./readme-sync')>()),
  syncReadmeRepository: mocks.syncReadmeRepository,
}))
vi.mock('./readme-publish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./readme-publish')>()),
  commitReadmeSpecFile: mocks.commitReadmeSpecFile,
}))
vi.mock('../github', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('token'),
  getPullRequest: mocks.getPullRequest,
}))
vi.mock('../retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../retry')>()),
  withGitHubRetry: <T>(operation: () => Promise<T>) => operation(),
}))

import { ReadmePublishError } from './readme-publish'
import {
  isReadmeFormatSource,
  openApiSourceRepositoryPath,
  reconcileReadmePublishPullRequest,
  removeOpenApiSourceFromLinkedRepository,
  syncReadmeSource,
  writeOpenApiSourceToLinkedRepository,
} from './readme-service'
import { ReadmeSyncError } from './readme-sync'

function source(overrides: Partial<GitHubHostedDocsSourceRow> = {}): GitHubHostedDocsSourceRow {
  return {
    id: 'source-1',
    workspace_id: 'ws-1',
    installation_id: 11,
    repo_full_name: 'acme/docs',
    repo_id: 7,
    paths: ['.'],
    root_folder_id: null,
    sync_status: 'synced',
    document_count: 0,
    conflict_count: 0,
    last_sync_commit_sha: 'sha-1',
    last_sync_at: null,
    last_sync_error: null,
    pending_pull_request_number: null,
    pending_pull_request_url: null,
    pending_pull_request_head: null,
    publish_pull_request_number: null,
    publish_pull_request_url: null,
    publish_pull_request_head: null,
    publish_last_commit_sha: null,
    publish_operation_id: null,
    publish_operation_started_at: null,
    pending_sync_mode: 'merge',
    format: 'readme',
    publish_mode: 'direct',
    branch: null,
    sync_state: {},
    created_by: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

/** Admin client whose every query resolves to the row configured per table. */
function fakeAdmin(rows: Record<string, unknown>) {
  const calls: Array<{ table: string; update?: Record<string, unknown>; filters: string[] }> = []
  const admin = {
    from: (table: string) => {
      const call: { table: string; update?: Record<string, unknown>; filters: string[] } = { table, filters: [] }
      calls.push(call)
      const filter = (operator: string) => (column: string) => {
        call.filters.push(`${column}.${operator}`)
        return query
      }
      const query = {
        select: () => query,
        update: (values: Record<string, unknown>) => { call.update = values; return query },
        eq: filter('eq'),
        neq: filter('neq'),
        lt: filter('lt'),
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      }
      return query
    },
  } as unknown as SupabaseClient
  return { admin, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateSource.mockResolvedValue(undefined)
})

describe('syncReadmeSource', () => {
  it('claims the source, then syncs the configured root and branch at the given commit', async () => {
    const row = source({ paths: ['site'], branch: 'v2.0', pending_sync_mode: 'replace_bread' })
    const { admin, calls } = fakeAdmin({ github_hosted_docs_sources: row })
    mocks.syncReadmeRepository.mockResolvedValue({ commitSha: 'sha-2' })
    await expect(syncReadmeSource(row, { ref: 'sha-2' }, admin)).resolves.toEqual({ commitSha: 'sha-2' })
    // Only a source that is not already syncing (or whose sync went stale) is claimed.
    expect(calls[0]).toMatchObject({ update: { sync_status: 'syncing' } })
    expect(calls[0]!.filters).toContain('sync_status.neq')
    expect(mocks.syncReadmeRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 7,
        repoFullName: 'acme/docs',
        root: 'site',
        branch: 'v2.0',
        ref: 'sha-2',
        lastSyncCommitSha: 'sha-1',
        mode: 'replace_bread',
      }),
      expect.anything(),
    )
  })

  it('does nothing when another sync already holds the source', async () => {
    const { admin, calls } = fakeAdmin({})
    await expect(syncReadmeSource(source(), {}, admin)).resolves.toBeNull()
    expect(mocks.syncReadmeRepository).not.toHaveBeenCalled()
    // It only takes over a sync whose heartbeat is stale.
    expect(calls[1]!.filters).toEqual(expect.arrayContaining(['sync_status.eq', 'updated_at.lt']))
  })

  it('records a readable error and rethrows when the sync fails', async () => {
    const { admin } = fakeAdmin({ github_hosted_docs_sources: source() })
    const failure = new ReadmeSyncError('The repository has more than 1000 pages.', 'too_many_pages')
    mocks.syncReadmeRepository.mockRejectedValue(failure)
    await expect(syncReadmeSource(source(), {}, admin)).rejects.toBe(failure)
    expect(mocks.updateSource).toHaveBeenCalledWith(
      expect.objectContaining({ sync_status: 'error', last_sync_error: 'The repository has more than 1000 pages.' }),
    )

    mocks.syncReadmeRepository.mockRejectedValue(Object.assign(new Error('GitHub API responded 404 for https://api.github.com/x'), { status: 404 }))
    await expect(syncReadmeSource(source(), {}, admin)).rejects.toThrow()
    // Raw provider errors are not shown to users.
    expect(mocks.updateSource).toHaveBeenLastCalledWith(
      expect.objectContaining({ last_sync_error: 'GitHub can no longer read the linked repository or branch.' }),
    )
  })
})

describe('reconcileReadmePublishPullRequest', () => {
  const withPullRequest = source({
    publish_mode: 'pull_request',
    publish_pull_request_number: 5,
    publish_pull_request_head: 'bread/readme-sync-abc',
  })

  it('keeps the pointer while the pull request is open', async () => {
    mocks.getPullRequest.mockResolvedValue({ number: 5, state: 'open' })
    const { admin, calls } = fakeAdmin({})
    expect(await reconcileReadmePublishPullRequest(withPullRequest, admin)).toBe(withPullRequest)
    expect(calls).toEqual([])
  })

  it('clears the pointer once the pull request is merged or closed', async () => {
    mocks.getPullRequest.mockResolvedValue({ number: 5, state: 'closed' })
    const cleared = source({ publish_mode: 'pull_request' })
    const { admin, calls } = fakeAdmin({ github_hosted_docs_sources: cleared })
    expect(await reconcileReadmePublishPullRequest(withPullRequest, admin)).toBe(cleared)
    expect(calls[0]!.update).toEqual({
      publish_pull_request_number: null,
      publish_pull_request_url: null,
      publish_pull_request_head: null,
      publish_last_commit_sha: null,
    })
  })

  it('ignores pull requests it did not open and survives GitHub being down', async () => {
    const foreign = source({ publish_pull_request_number: 5, publish_pull_request_head: 'bread/docs-docs-workspace-abc' })
    expect(await reconcileReadmePublishPullRequest(foreign, fakeAdmin({}).admin)).toBe(foreign)
    expect(mocks.getPullRequest).not.toHaveBeenCalled()

    mocks.getPullRequest.mockRejectedValue(new Error('503'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await reconcileReadmePublishPullRequest(withPullRequest, fakeAdmin({}).admin)).toBe(withPullRequest)
    logged.mockRestore()
  })
})

describe('OpenAPI definitions and the linked repository', () => {
  const spec = { spec_raw: '{"openapi":"3.1.0"}', repo_path: 'reference/openapi.json' }

  it('does nothing unless a ReadMe-format repository is linked', async () => {
    expect(await writeOpenApiSourceToLinkedRepository(fakeAdmin({}).admin, 'ws-1', 'payments-api')).toBeNull()
    const bread = fakeAdmin({ github_hosted_docs_sources: source({ format: 'bread' }), openapi_sources: spec })
    expect(await writeOpenApiSourceToLinkedRepository(bread.admin, 'ws-1', 'payments-api')).toBeNull()
    expect(mocks.commitReadmeSpecFile).not.toHaveBeenCalled()
    expect(isReadmeFormatSource(source({ format: 'bread' }))).toBe(false)
    expect(isReadmeFormatSource(null)).toBe(false)
  })

  it('commits an uploaded definition to the file its source is linked to', async () => {
    const { admin } = fakeAdmin({ github_hosted_docs_sources: source(), openapi_sources: spec })
    mocks.commitReadmeSpecFile.mockResolvedValue({ committed: true, path: 'reference/openapi.json', commitSha: 'sha-9' })
    expect(await writeOpenApiSourceToLinkedRepository(admin, 'ws-1', 'payments-api')).toEqual({
      committed: true,
      path: 'reference/openapi.json',
      commit_sha: 'sha-9',
    })
    expect(mocks.commitReadmeSpecFile).toHaveBeenCalledWith(
      expect.objectContaining({ publishMode: 'direct', root: '', repoFullName: 'acme/docs' }),
      expect.anything(),
      { slug: 'payments-api', raw: spec.spec_raw, repoPath: 'reference/openapi.json' },
    )
  })

  it('leaves the file for the next publish in pull request mode', async () => {
    const { admin } = fakeAdmin({ github_hosted_docs_sources: source({ publish_mode: 'pull_request' }), openapi_sources: spec })
    expect(await writeOpenApiSourceToLinkedRepository(admin, 'ws-1', 'payments-api')).toMatchObject({
      committed: false,
      reason: 'pull_request_mode',
    })
    expect(mocks.commitReadmeSpecFile).not.toHaveBeenCalled()
  })

  it('reports a GitHub failure instead of failing the upload', async () => {
    const { admin } = fakeAdmin({ github_hosted_docs_sources: source(), openapi_sources: spec })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.commitReadmeSpecFile.mockRejectedValue(new ReadmePublishError('GitHub rejected the push: main is protected.', 409, 'branch_protected'))
    expect(await writeOpenApiSourceToLinkedRepository(admin, 'ws-1', 'payments-api')).toMatchObject({
      committed: false,
      reason: 'failed',
      message: 'GitHub rejected the push: main is protected.',
    })
    mocks.commitReadmeSpecFile.mockRejectedValue(new Error('socket hang up'))
    const generic = await writeOpenApiSourceToLinkedRepository(admin, 'ws-1', 'payments-api')
    expect(generic).toMatchObject({ committed: false, reason: 'failed' })
    expect(generic?.message).not.toMatch(/socket/)
    logged.mockRestore()
  })

  it('deletes the file of a removed definition', async () => {
    const { admin } = fakeAdmin({ github_hosted_docs_sources: source(), openapi_sources: { repo_path: 'reference/openapi.json' } })
    expect(await openApiSourceRepositoryPath(admin, 'ws-1', 'payments-api')).toBe('reference/openapi.json')
    expect(await openApiSourceRepositoryPath({} as SupabaseClient, 'ws-1', 'payments-api')).toBeNull()

    mocks.commitReadmeSpecFile.mockResolvedValue({ committed: true, path: 'reference/openapi.json', commitSha: 'sha-10' })
    expect(
      await removeOpenApiSourceFromLinkedRepository(admin, 'ws-1', { slug: 'payments-api', repoPath: 'reference/openapi.json' }),
    ).toEqual({ committed: true, path: 'reference/openapi.json', commit_sha: 'sha-10' })
    expect(mocks.commitReadmeSpecFile).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      slug: 'payments-api',
      raw: null,
      repoPath: 'reference/openapi.json',
    })
    // A definition that never lived in the repository has nothing to delete.
    expect(await removeOpenApiSourceFromLinkedRepository(admin, 'ws-1', { slug: 'x', repoPath: null })).toBeNull()
  })
})
