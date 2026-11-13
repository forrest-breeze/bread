import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  compileRepositoryFileContent,
  decodeRepositoryBlob,
  extractRepositoryPushInfo,
  handleRepositoryPush,
  meanEmbedding,
  repositoryFileSyncStatus,
  selectRepositoryFiles,
  shouldIndexRepositoryFile,
  syncGitHubRepository,
} from './github-repo-ingest'
import type { GitHubTreeEntry } from './github'

function entry(path: string, overrides: Partial<GitHubTreeEntry> = {}): GitHubTreeEntry {
  return {
    path,
    mode: '100644',
    type: 'blob',
    sha: `sha-${path}`,
    size: 100,
    url: `https://api.github.test/${path}`,
    ...overrides,
  }
}

function monitoredRepoSyncStateTable(
  writes: Array<Record<string, unknown>>,
): { update: (row: Record<string, unknown>) => unknown } {
  interface UpdateChain {
    eq: () => UpdateChain
    then: Promise<{ error: null }>['then']
  }
  return {
    update: (row: Record<string, unknown>) => {
      let recorded = false
      const finish = async (): Promise<{ error: null }> => {
        if (!recorded) {
          writes.push(row)
          recorded = true
        }
        return { error: null }
      }
      const chain: UpdateChain = {
        eq: () => chain,
        then: (onFulfilled, onRejected) => finish().then(onFulfilled, onRejected),
      }
      return chain
    },
  }
}

describe('shouldIndexRepositoryFile', () => {
  it('includes source, documentation, and common project manifests', () => {
    expect(shouldIndexRepositoryFile(entry('src/index.ts'))).toBe(true)
    expect(shouldIndexRepositoryFile(entry('docs/architecture.md'))).toBe(true)
    expect(shouldIndexRepositoryFile(entry('Dockerfile'))).toBe(true)
  })

  it('excludes dependencies, generated output, lockfiles, and oversized files', () => {
    expect(shouldIndexRepositoryFile(entry('node_modules/pkg/index.js'))).toBe(false)
    expect(shouldIndexRepositoryFile(entry('dist/index.js'))).toBe(false)
    expect(shouldIndexRepositoryFile(entry('package-lock.json'))).toBe(false)
    expect(shouldIndexRepositoryFile(entry('src/huge.ts', { size: 200_000 }))).toBe(false)
  })

  it('refuses common credential and private-key paths', () => {
    expect(shouldIndexRepositoryFile(entry('.env'))).toBe(false)
    expect(shouldIndexRepositoryFile(entry('.env.production'))).toBe(false)
    expect(shouldIndexRepositoryFile(entry('config/secrets.yaml'))).toBe(false)
    expect(shouldIndexRepositoryFile(entry('certs/server.pem'))).toBe(false)
  })

  it('skips symlinks and submodule entries', () => {
    expect(shouldIndexRepositoryFile(entry('linked.ts', { mode: '120000' }))).toBe(false)
    expect(shouldIndexRepositoryFile(entry('vendor/lib', { type: 'commit', mode: '160000' }))).toBe(false)
  })
})

describe('repository file selection and normalization', () => {
  it('keeps retryable per-file work in backfilling instead of repository error', () => {
    expect(repositoryFileSyncStatus({
      pending: 1,
      deferred: 0,
      treeTruncated: false,
    })).toBe('partial')
    expect(repositoryFileSyncStatus({
      pending: 0,
      deferred: 0,
      treeTruncated: false,
    })).toBe('synced')
  })

  it('derives a document vector by averaging its retrieval chunks', () => {
    expect(meanEmbedding([[1, 3], [3, 7]])).toEqual([2, 5])
    expect(meanEmbedding([])).toBeNull()
    expect(() => meanEmbedding([[1], [1, 2]])).toThrow(/different dimensions/i)
  })

  it('prioritizes root guidance and documentation before source and tests', () => {
    const selected = selectRepositoryFiles([
      entry('tests/widget.test.ts'),
      entry('src/widget.ts'),
      entry('docs/design.md'),
      entry('README.md'),
    ]).selected

    expect(selected.map((item) => item.path)).toEqual([
      'README.md',
      'docs/design.md',
      'src/widget.ts',
      'tests/widget.test.ts',
    ])
  })

  it('counts excluded files without treating directories as skipped files', () => {
    const selection = selectRepositoryFiles([
      entry('src', { type: 'tree', mode: '040000', size: undefined }),
      entry('src/index.ts'),
      entry('dist/bundle.js'),
    ])

    expect(selection.selected.map((item) => item.path)).toEqual(['src/index.ts'])
    expect(selection.skipped).toBe(1)
  })

  it('decodes base64 text and rejects binary-looking blobs', () => {
    expect(decodeRepositoryBlob({
      sha: 'one',
      size: 5,
      encoding: 'base64',
      content: Buffer.from('hello\r\nworld').toString('base64'),
    })).toBe('hello\nworld')
    expect(decodeRepositoryBlob({
      sha: 'two',
      size: 3,
      encoding: 'base64',
      content: Buffer.from('a\u0000b').toString('base64'),
    })).toBeNull()
  })

  it('wraps code with repository provenance and a collision-safe fence', () => {
    const content = compileRepositoryFileContent({
      repoFullName: 'acme/repo',
      path: 'src/index.ts',
      ref: 'main',
      commitSha: 'commit-sha',
      blobSha: 'blob-sha',
      content: 'const fence = ```example```',
    })

    expect(content).toContain('# acme/repo/src/index.ts')
    expect(content).toContain('/blob/commit-sha/src/index.ts')
    expect(content).toContain('````typescript')
  })
})

describe('extractRepositoryPushInfo', () => {
  const payload = {
    ref: 'refs/heads/main',
    after: 'abc123',
    repository: { id: 7, full_name: 'acme/repo', default_branch: 'main' },
    installation: { id: 11 },
  }

  it('accepts pushes to the repository default branch', () => {
    expect(extractRepositoryPushInfo('push', payload)).toEqual({
      installationId: 11,
      repoId: 7,
      repoFullName: 'acme/repo',
      ref: 'abc123',
      branch: 'main',
    })
  })

  it('ignores feature-branch pushes and non-push events', () => {
    expect(extractRepositoryPushInfo('push', {
      ...payload,
      ref: 'refs/heads/feature/docs',
    })).toBeNull()
    expect(extractRepositoryPushInfo('pull_request', payload)).toBeNull()
  })
})

describe('handleRepositoryPush', () => {
  const pushInfo = {
    installationId: 11,
    repoId: 7,
    repoFullName: 'acme/repo',
    ref: 'commit-sha',
  }
  const monitoredRepo = {
    workspace_id: 'ws-1',
    installation_id: 11,
    repo_id: 7,
    repo_full_name: 'acme/repo',
  }
  const hostedSource = {
    id: 'source-1',
    ...monitoredRepo,
    paths: ['docs'],
    root_folder_id: 'folder-1',
    document_count: 2,
    last_sync_commit_sha: 'previous-sha',
    pending_sync_mode: 'replace_bread' as const,
  }

  function pushAdmin(source: Record<string, unknown> = hostedSource) {
    return {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: table === 'monitored_repos' ? monitoredRepo : source,
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient
  }

  it('routes a ReadMe-format link to the ReadMe sync at the pushed commit', async () => {
    const syncHostedDocs = vi.fn()
    const syncReadmeSource = vi.fn().mockResolvedValue(null)
    const admin = pushAdmin({ ...hostedSource, format: 'readme', branch: null, sync_status: 'synced' })
    await handleRepositoryPush({ ...pushInfo, branch: 'main' }, {
      admin,
      syncRepository: vi.fn().mockResolvedValue(undefined),
      syncHostedDocs,
      syncReadmeSource,
    })
    expect(syncHostedDocs).not.toHaveBeenCalled()
    expect(syncReadmeSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'source-1', format: 'readme' }),
      { ref: 'commit-sha' },
      admin,
    )
  })

  it('leaves a ReadMe-format link pinned to another branch to its own push handler', async () => {
    const syncReadmeSource = vi.fn()
    await handleRepositoryPush({ ...pushInfo, branch: 'main' }, {
      admin: pushAdmin({ ...hostedSource, format: 'readme', branch: 'v2.0', sync_status: 'synced' }),
      syncRepository: vi.fn().mockResolvedValue(undefined),
      syncHostedDocs: vi.fn(),
      syncReadmeSource,
    })
    expect(syncReadmeSource).not.toHaveBeenCalled()
  })

  it('completes hosted-doc sync even when repository indexing rejects', async () => {
    const repositoryError = new Error('repository indexing failed')
    const syncRepository = vi.fn().mockRejectedValue(repositoryError)
    const syncHostedDocs = vi.fn().mockResolvedValue({ documentCount: 2 })

    await expect(handleRepositoryPush(pushInfo, {
      admin: pushAdmin(),
      syncRepository,
      syncHostedDocs,
    })).rejects.toBe(repositoryError)

    expect(syncHostedDocs).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'source-1',
      ref: 'commit-sha',
      paths: ['docs'],
      mode: 'replace_bread',
    }))
    expect(syncHostedDocs.mock.invocationCallOrder[0]).toBeLessThan(
      syncRepository.mock.invocationCallOrder[0]!,
    )
  })
})

describe('syncGitHubRepository', () => {
  it('creates a document, indexes it, and persists the path/blob pointer', async () => {
    const insertedDocuments: Array<Record<string, unknown>> = []
    const fileStateWrites: Array<Record<string, unknown>> = []
    const syncStateWrites: Array<Record<string, unknown>> = []
    const fileStates = new Map<string, Record<string, unknown>>()
    const indexDocument = vi.fn().mockResolvedValue({
      sectionCount: 1,
      chunkCount: 1,
      sectionsDeleted: 0,
      chunksDeleted: 0,
      chunksEmbedded: 1,
      durationMs: 1,
    })

    const admin = {
      from: (table: string) => {
        if (table === 'github_repo_files') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({
                  data: Array.from(fileStates.values()),
                  error: null,
                }),
              }),
            }),
            upsert: async (row: Record<string, unknown>) => {
              fileStateWrites.push(row)
              fileStates.set(String(row.path), row)
              return { error: null }
            },
          }
        }
        if (table === 'monitored_repos') {
          return monitoredRepoSyncStateTable(syncStateWrites)
        }
        if (table === 'documents') {
          return {
            insert: (row: Record<string, unknown>) => {
              insertedDocuments.push(row)
              return {
                select: () => ({
                  single: async () => ({ data: { id: 'doc-1' }, error: null }),
                }),
              }
            },
          }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient

    const result = await syncGitHubRepository({
      workspaceId: 'ws-1',
      installationId: 11,
      repoId: 7,
      repoFullName: 'acme/repo',
      ref: 'main',
    }, {
      admin,
      getToken: vi.fn().mockResolvedValue('token'),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'commit-sha',
        commit: { tree: { sha: 'tree-sha' } },
      }),
      getTree: vi.fn().mockResolvedValue({
        sha: 'tree-sha',
        truncated: false,
        tree: [entry('README.md', { sha: 'blob-sha', size: 12 })],
      }),
      getBlob: vi.fn().mockResolvedValue({
        sha: 'blob-sha',
        size: 12,
        encoding: 'base64',
        content: Buffer.from('# Hello repo').toString('base64'),
      }),
      embedMany: vi.fn().mockResolvedValue([Array.from({ length: 768 }, () => 0.01)]),
      indexDocument,
      isIndexingEnabled: vi.fn().mockResolvedValue(true),
    })

    expect(result).toMatchObject({
      indexed: 1,
      created: 1,
      updated: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
    })
    expect(insertedDocuments[0]).toMatchObject({
      workspace_id: 'ws-1',
      title: 'acme/repo/README.md',
      source: 'GitHub',
    })
    expect(indexDocument).toHaveBeenCalledWith(
      'doc-1',
      expect.objectContaining({ type: 'doc' }),
      expect.objectContaining({ supabase: admin }),
    )
    expect(fileStateWrites.at(-1)).toMatchObject({
      path: 'README.md',
      blob_sha: 'blob-sha',
      document_id: 'doc-1',
      last_seen_commit_sha: 'commit-sha',
    })
    expect(syncStateWrites).toHaveLength(2)
    expect(syncStateWrites[0]).toMatchObject({ file_sync_status: 'syncing' })
    expect(syncStateWrites[1]).toMatchObject({
      file_sync_status: 'synced',
      indexed_file_count: 1,
      pending_file_count: 0,
      skipped_file_count: 0,
      failed_file_count: 0,
      last_file_sync_commit_sha: 'commit-sha',
      last_file_sync_error: null,
      file_tree_truncated: false,
    })
  })

  // Quota pausing removed: embeddings are disabled, so there is no provider quota.
  it('persists a safe user-facing failure without exposing provider details', async () => {
    const syncStateWrites: Array<Record<string, unknown>> = []
    const admin = {
      from: (table: string) => {
        if (table !== 'monitored_repos') throw new Error(`Unexpected table: ${table}`)
        return monitoredRepoSyncStateTable(syncStateWrites)
      },
    } as unknown as SupabaseClient
    const denied = Object.assign(new Error('raw GitHub provider response'), {
      status: 403,
    })

    await expect(syncGitHubRepository({
      workspaceId: 'ws-1',
      installationId: 11,
      repoId: 7,
      repoFullName: 'acme/repo',
    }, {
      admin,
      getToken: vi.fn().mockRejectedValue(denied),
      isIndexingEnabled: vi.fn().mockResolvedValue(true),
    })).rejects.toBe(denied)

    expect(syncStateWrites).toHaveLength(2)
    expect(syncStateWrites[1]).toMatchObject({
      file_sync_status: 'error',
      failed_file_count: 1,
      last_file_sync_error:
        'GitHub denied repository contents. Approve the read-only Contents permission, then retry.',
    })
    expect(syncStateWrites[1].last_file_sync_error).not.toContain('raw GitHub')
  })

  it('stops before the next file when an admin cancels indexing', async () => {
    const syncStateWrites: Array<Record<string, unknown>> = []
    const getBlob = vi.fn()
    const admin = {
      from: (table: string) => {
        if (table === 'monitored_repos') {
          return monitoredRepoSyncStateTable(syncStateWrites)
        }
        if (table === 'github_repo_files') {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({ data: [], error: null }),
              }),
            }),
          }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient
    const isIndexingEnabled = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false)

    const result = await syncGitHubRepository({
      workspaceId: 'ws-1',
      installationId: 11,
      repoId: 7,
      repoFullName: 'acme/repo',
      ref: 'main',
    }, {
      admin,
      getToken: vi.fn().mockResolvedValue('token'),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'commit-sha',
        commit: { tree: { sha: 'tree-sha' } },
      }),
      getTree: vi.fn().mockResolvedValue({
        sha: 'tree-sha',
        truncated: false,
        tree: [entry('README.md', { sha: 'blob-sha', size: 12 })],
      }),
      getBlob,
      isIndexingEnabled,
    })

    expect(result.cancelled).toBe(true)
    expect(getBlob).not.toHaveBeenCalled()
    expect(syncStateWrites.at(-1)).toMatchObject({
      file_sync_status: 'cancelled',
      indexed_file_count: 0,
      pending_file_count: 1,
    })
  })
})
