import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'

const github = vi.hoisted(() => ({
  getInstallationToken: vi.fn(),
  getRepository: vi.fn(),
  getRepositoryBranchReference: vi.fn(),
  getRepositoryCommit: vi.fn(),
  getRepositoryTree: vi.fn(),
}))
vi.mock('../github', () => github)
vi.mock('../retry', () => ({ withGitHubRetry: <T>(operation: () => Promise<T>) => operation() }))

import { isValidBranchName, linkReadmeRepository, type ReadmeLinkInput } from './readme-link'

function fakeAdmin() {
  const writes: Array<{ kind: 'insert' | 'update'; values: Record<string, unknown>; filters: Array<[string, unknown]> }> = []
  const admin = {
    from: () => {
      const write = { kind: 'insert' as 'insert' | 'update', values: {} as Record<string, unknown>, filters: [] as Array<[string, unknown]> }
      const query = {
        insert: (values: Record<string, unknown>) => { write.kind = 'insert'; write.values = values; writes.push(write); return query },
        update: (values: Record<string, unknown>) => { write.kind = 'update'; write.values = values; writes.push(write); return query },
        eq: (column: string, value: unknown) => { write.filters.push([column, value]); return query },
        select: () => query,
        single: async () => ({ data: { id: 'source-1', ...write.values }, error: null }),
      }
      return query
    },
  } as unknown as SupabaseClient
  return { admin, writes }
}

const blob = (path: string) => ({ path, type: 'blob', sha: `sha-${path}`, size: 10, mode: '100644', url: '' })
const tree = (path: string) => ({ path, type: 'tree', sha: `sha-${path}`, mode: '040000', url: '' })

function input(overrides: Partial<ReadmeLinkInput> = {}): ReadmeLinkInput {
  return {
    workspaceId: 'ws-1',
    userId: 'user-1',
    installationId: 11,
    repository: { id: 7, full_name: 'acme/docs' },
    rootPath: '',
    branch: null,
    publishMode: 'direct',
    mode: 'merge',
    existing: null,
    leaseOperationId: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  github.getInstallationToken.mockResolvedValue('token')
  github.getRepository.mockResolvedValue({ id: 7, full_name: 'acme/docs', default_branch: 'v1.6', private: true })
  github.getRepositoryBranchReference.mockResolvedValue({ ref: 'refs/heads/v2.0', object: { type: 'commit', sha: 'b' } })
  github.getRepositoryCommit.mockResolvedValue({ sha: 'commit-1', commit: { tree: { sha: 'tree-1' } } })
  github.getRepositoryTree.mockResolvedValue({
    sha: 'tree-1',
    truncated: false,
    tree: [tree('docs'), blob('docs/Guides/intro.md'), tree('site'), blob('site/docs/a.md')],
  })
})

describe('linkReadmeRepository', () => {
  it('links the repository root on the default branch, committing directly', async () => {
    const { admin, writes } = fakeAdmin()
    const outcome = await linkReadmeRepository(admin, input())
    expect(outcome).toMatchObject({ ok: true, commitSha: 'commit-1' })
    expect(github.getRepositoryCommit).toHaveBeenCalledWith('token', 'acme/docs', 'v1.6')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      kind: 'insert',
      values: {
        workspace_id: 'ws-1',
        repo_id: 7,
        repo_full_name: 'acme/docs',
        format: 'readme',
        publish_mode: 'direct',
        // The repository root is stored as "." because an empty list means "no link".
        paths: ['.'],
        // Null keeps following the default branch.
        branch: null,
        sync_status: 'pending',
        pending_sync_mode: 'merge',
        created_by: 'user-1',
      },
    })
  })

  it('stores null when the requested branch is the default branch', async () => {
    const { admin, writes } = fakeAdmin()
    await linkReadmeRepository(admin, input({ branch: 'v1.6' }))
    expect(writes[0]!.values.branch).toBeNull()
    expect(github.getRepositoryBranchReference).not.toHaveBeenCalled()
  })

  it('pins another branch after checking that it exists', async () => {
    const { admin, writes } = fakeAdmin()
    await linkReadmeRepository(admin, input({ branch: ' v2.0 ', rootPath: '/site/', publishMode: 'pull_request', mode: 'github_wins' }))
    expect(github.getRepositoryCommit).toHaveBeenCalledWith('token', 'acme/docs', 'v2.0')
    expect(writes[0]!.values).toMatchObject({
      branch: 'v2.0',
      paths: ['site'],
      publish_mode: 'pull_request',
      pending_sync_mode: 'replace_breezify',
    })

    github.getRepositoryBranchReference.mockResolvedValue(null)
    const missing = await linkReadmeRepository(fakeAdmin().admin, input({ branch: 'v9' }))
    expect(missing).toMatchObject({ ok: false, status: 409, code: 'branch_not_found' })
  })

  it('rejects invalid roots and branches before calling GitHub', async () => {
    const { admin, writes } = fakeAdmin()
    expect(await linkReadmeRepository(admin, input({ rootPath: '../secrets' }))).toMatchObject({ ok: false, code: 'invalid_root' })
    expect(await linkReadmeRepository(admin, input({ branch: 'bad..name' }))).toMatchObject({ ok: false, code: 'invalid_branch' })
    expect(github.getInstallationToken).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('rejects a folder that is not in the repository', async () => {
    const outcome = await linkReadmeRepository(fakeAdmin().admin, input({ rootPath: 'nope' }))
    expect(outcome).toMatchObject({ ok: false, status: 409, code: 'root_not_found' })
  })

  it('keeps sync state when re-linking the same target, and resets it otherwise', async () => {
    const existing = {
      id: 'source-1',
      format: 'readme',
      repo_id: 7,
      paths: ['.'],
      branch: null,
      conflict_count: 2,
      created_by: 'someone-else',
    } as unknown as GitHubHostedDocsSourceRow
    const same = fakeAdmin()
    await linkReadmeRepository(same.admin, input({ existing, leaseOperationId: 'lease-1' }))
    expect(same.writes[0]).toMatchObject({ kind: 'update', values: { conflict_count: 2, created_by: 'someone-else' } })
    expect(same.writes[0]!.values).not.toHaveProperty('sync_state')
    // The update only applies while the caller still holds the lease.
    expect(same.writes[0]!.filters).toContainEqual(['publish_operation_id', 'lease-1'])

    const moved = fakeAdmin()
    await linkReadmeRepository(moved.admin, input({ existing, leaseOperationId: 'lease-1', rootPath: 'site' }))
    expect(moved.writes[0]!.values).toMatchObject({ sync_state: {}, last_sync_commit_sha: null, conflict_count: 0 })
  })
})

describe('isValidBranchName', () => {
  it('accepts ordinary branch names and rejects ones git would refuse', () => {
    for (const name of ['main', 'v1.6', 'release/2.0', 'v2.0_new-branch']) expect(isValidBranchName(name)).toBe(true)
    for (const name of ['', 'a b', 'a..b', '/a', 'a/', 'a//b', 'a.lock', '-a', 'a~1', 'a:b', 'a@{1}']) {
      expect(isValidBranchName(name)).toBe(false)
    }
  })
})
