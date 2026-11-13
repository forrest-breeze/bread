import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import type {
  GitHubRepositoryCommit,
  GitHubRepositoryTree,
} from './github'
import {
  gitBlobSha,
  inspectHostedWorkspacePublish,
  planHostedWorkspacePublish,
  publishHostedWorkspaceToGitHub,
  PUBLISH_DIFF_MAX_FILES,
  resolveHostedWorkspacePublishDiff,
} from './github-hosted-workspace-publish'

const targetPath = 'docs'
const branch = 'breezify/docs-docs-workspace-test'

function source(
  overrides: Partial<GitHubHostedDocsSourceRow> = {},
): GitHubHostedDocsSourceRow {
  return {
    id: 'source-1',
    workspace_id: 'workspace-1',
    installation_id: 7,
    repo_full_name: 'acme/docs',
    repo_id: 42,
    paths: [targetPath],
    root_folder_id: 'folder-1',
    sync_status: 'synced',
    document_count: 1,
    conflict_count: 0,
    last_sync_commit_sha: 'base-sha',
    last_sync_at: '2026-08-18T12:00:00.000Z',
    last_sync_error: null,
    pending_pull_request_number: null,
    pending_pull_request_url: null,
    pending_pull_request_head: null,
    publish_pull_request_number: null,
    publish_pull_request_url: null,
    publish_pull_request_head: branch,
    publish_last_commit_sha: null,
    publish_operation_id: null,
    publish_operation_started_at: null,
    pending_sync_mode: 'merge',
    created_by: 'user-1',
    created_at: '2026-08-18T12:00:00.000Z',
    updated_at: '2026-08-18T12:00:00.000Z',
    ...overrides,
  }
}

function commit(sha: string, treeSha: string): GitHubRepositoryCommit {
  return { sha, commit: { tree: { sha: treeSha } } }
}

function tree(
  treeSha: string,
  entries: Array<{ path: string; sha: string }> = [],
): GitHubRepositoryTree {
  return {
    sha: treeSha,
    truncated: false,
    tree: entries.map((entry) => ({
      ...entry,
      mode: '100644',
      type: 'blob' as const,
      size: 20,
      url: `https://api.github.test/blobs/${entry.sha}`,
    })),
  }
}

function dependencies() {
  return {
    getToken: vi.fn().mockResolvedValue('token'),
    getRepo: vi.fn().mockResolvedValue({
      id: 42,
      full_name: 'acme/docs',
      default_branch: 'main',
      private: true,
    }),
    getBranchReference: vi.fn().mockResolvedValue(null),
    getCommit: vi.fn().mockResolvedValue(commit('base-sha', 'base-tree')),
    getTree: vi.fn().mockResolvedValue(tree('base-tree')),
    createBranch: vi.fn().mockResolvedValue({
      ref: `refs/heads/${branch}`,
      object: { type: 'commit' as const, sha: 'base-sha' },
    }),
    createFilesCommit: vi.fn().mockResolvedValue({
      sha: 'publish-sha',
      html_url: 'https://github.com/acme/docs/commit/publish-sha',
    }),
    createPullRequest: vi.fn().mockResolvedValue({
      number: 17,
      html_url: 'https://github.com/acme/docs/pull/17',
      state: 'open' as const,
      title: 'Publish',
    }),
    findOpenPullRequest: vi.fn().mockResolvedValue(null),
    retry: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
    now: () => Number.parseInt('test', 36),
  }
}

describe('hosted workspace publish', () => {
  beforeEach(() => vi.clearAllMocks())

  it('computes Git-compatible blob IDs', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('writes changed files and deletes only known managed paths', () => {
    const unchanged = 'same\n'
    const plan = planHostedWorkspacePublish({
      targetPath,
      files: [
        { documentId: 'one', path: 'docs/same.md', content: unchanged },
        { documentId: 'two', path: 'docs/new.mdx', content: 'new\n' },
      ],
      managedPaths: ['docs/same.md', 'docs/removed.md'],
      tree: tree('tree', [
        { path: 'docs/same.md', sha: gitBlobSha(unchanged) },
        { path: 'docs/removed.md', sha: 'removed' },
        { path: 'docs/unmanaged.md', sha: 'unmanaged' },
        { path: 'outside.md', sha: 'outside' },
      ]),
    })

    expect(plan.files).toEqual([{ path: 'docs/new.mdx', content: 'new\n' }])
    expect(plan.deletePaths).toEqual(['docs/removed.md'])
    expect(plan.unchangedFileCount).toBe(1)
  })

  it('creates one commit and PR from a reserved first-publish branch', async () => {
    const deps = dependencies()
    const result = await publishHostedWorkspaceToGitHub(
      {
        source: source(),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'setup\n' }],
        managedPaths: [],
      },
      deps,
    )

    expect(deps.createBranch).toHaveBeenCalledWith(
      'token',
      'acme/docs',
      branch,
      'base-sha',
    )
    expect(deps.createFilesCommit).toHaveBeenCalledOnce()
    expect(deps.createPullRequest).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      branch,
      pullRequestNumber: 17,
      changedFileCount: 1,
      reused: false,
    })
  })

  it('commits only the selected changed paths', async () => {
    const deps = dependencies()
    deps.getTree.mockResolvedValue(
      tree('base-tree', [
        { path: 'docs/remove.md', sha: gitBlobSha('old\n') },
      ]),
    )

    const result = await publishHostedWorkspaceToGitHub(
      {
        source: source(),
        files: [
          { documentId: 'one', path: 'docs/one.md', content: 'one\n' },
          { documentId: 'two', path: 'docs/two.md', content: 'two\n' },
        ],
        managedPaths: ['docs/remove.md'],
        selectedPaths: ['docs/two.md', 'docs/remove.md'],
      },
      deps,
    )

    expect(deps.createFilesCommit).toHaveBeenCalledWith(
      'token',
      'acme/docs',
      expect.objectContaining({
        files: [{ path: 'docs/two.md', content: 'two\n' }],
        deletePaths: ['docs/remove.md'],
      }),
    )
    expect(result).toMatchObject({
      changedFileCount: 2,
      writtenFileCount: 1,
      deletedFileCount: 1,
    })
  })

  it('fails closed when a selected path is no longer changed', async () => {
    const deps = dependencies()

    await expect(
      publishHostedWorkspaceToGitHub(
        {
          source: source(),
          files: [
            { documentId: 'one', path: 'docs/one.md', content: 'one\n' },
          ],
          managedPaths: [],
          selectedPaths: ['docs/stale.md'],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'selected_paths_changed' })
    expect(deps.createFilesCommit).not.toHaveBeenCalled()
  })

  it('updates a verified open workspace PR without opening another', async () => {
    const deps = dependencies()
    deps.findOpenPullRequest.mockResolvedValue({
      number: 17,
      html_url: 'https://github.com/acme/docs/pull/17',
      state: 'open',
      title: 'Publish',
    })
    deps.getBranchReference.mockResolvedValue({
      ref: `refs/heads/${branch}`,
      object: { type: 'commit', sha: 'prior-breezify-sha' },
    })
    deps.getCommit.mockImplementation(async (_token, _repo, ref) =>
      ref === 'main'
        ? commit('base-sha', 'base-tree')
        : commit('prior-breezify-sha', 'branch-tree'),
    )
    deps.getTree.mockImplementation(async (_token, _repo, sha) =>
      sha === 'branch-tree'
        ? tree('branch-tree', [{ path: 'docs/old-setup.md', sha: gitBlobSha('old\n') }])
        : tree('base-tree'),
    )

    const result = await publishHostedWorkspaceToGitHub(
      {
        source: source({
          publish_pull_request_number: 17,
          publish_pull_request_url: 'https://github.com/acme/docs/pull/17',
          publish_last_commit_sha: 'prior-breezify-sha',
        }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'new\n' }],
        managedPaths: [],
      },
      deps,
    )

    expect(deps.createBranch).not.toHaveBeenCalled()
    expect(deps.createPullRequest).not.toHaveBeenCalled()
    expect(deps.createFilesCommit).toHaveBeenCalledWith(
      'token',
      'acme/docs',
      expect.objectContaining({ deletePaths: ['docs/old-setup.md'] }),
    )
    expect(result.reused).toBe(true)
  })

  it('recovers an open PR when its current branch already matches the export', async () => {
    const deps = dependencies()
    deps.findOpenPullRequest.mockResolvedValue({
      number: 17,
      html_url: 'https://github.com/acme/docs/pull/17',
      state: 'open',
      title: 'Publish',
    })
    deps.getBranchReference.mockResolvedValue({
      ref: `refs/heads/${branch}`,
      object: { type: 'commit', sha: 'provider-success-sha' },
    })
    deps.getCommit.mockImplementation(async (_token, _repo, ref) =>
      ref === 'main'
        ? commit('base-sha', 'base-tree')
        : commit('provider-success-sha', 'branch-tree'),
    )
    deps.getTree.mockImplementation(async (_token, _repo, sha) =>
      sha === 'branch-tree'
        ? tree('branch-tree', [{ path: 'docs/setup.md', sha: gitBlobSha('new\n') }])
        : tree('base-tree'),
    )

    const result = await publishHostedWorkspaceToGitHub(
      {
        source: source({
          publish_pull_request_number: 17,
          publish_pull_request_url: 'https://github.com/acme/docs/pull/17',
          publish_last_commit_sha: 'stale-db-sha',
        }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'new\n' }],
        managedPaths: ['docs/setup.md'],
      },
      deps,
    )

    expect(result).toMatchObject({
      commitSha: 'provider-success-sha',
      changedFileCount: 0,
      reused: true,
    })
    expect(deps.createFilesCommit).not.toHaveBeenCalled()
  })

  it('rejects reviewer-pushed branch changes when the export still differs', async () => {
    const deps = dependencies()
    deps.findOpenPullRequest.mockResolvedValue({
      number: 17,
      html_url: 'https://github.com/acme/docs/pull/17',
      state: 'open',
      title: 'Publish',
    })
    deps.getBranchReference.mockResolvedValue({
      ref: `refs/heads/${branch}`,
      object: { type: 'commit', sha: 'reviewer-sha' },
    })
    deps.getCommit.mockImplementation(async (_token, _repo, ref) =>
      ref === 'main'
        ? commit('base-sha', 'base-tree')
        : commit('reviewer-sha', 'reviewer-tree'),
    )
    deps.getTree.mockResolvedValue(tree('reviewer-tree'))

    await expect(
      publishHostedWorkspaceToGitHub(
        {
          source: source({
            publish_pull_request_number: 17,
            publish_pull_request_url: 'https://github.com/acme/docs/pull/17',
            publish_last_commit_sha: 'prior-breezify-sha',
          }),
          files: [{ documentId: 'one', path: 'docs/setup.md', content: 'new\n' }],
          managedPaths: [],
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: 'publish_branch_changed',
      status: 409,
    })
  })

  it('requires the source to be synchronized to the current default head', async () => {
    const deps = dependencies()

    await expect(
      publishHostedWorkspaceToGitHub(
        {
          source: source({ last_sync_commit_sha: 'older-sha' }),
          files: [{ documentId: 'one', path: 'docs/setup.md', content: 'new\n' }],
          managedPaths: [],
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: 'github_sync_required',
      status: 409,
    })
    expect(deps.getTree).not.toHaveBeenCalled()
  })

  it('reports an up-to-date default branch without writing to GitHub', async () => {
    const deps = dependencies()
    deps.getTree.mockResolvedValue(
      tree('base-tree', [
        { path: 'docs/setup.md', sha: gitBlobSha('setup\n') },
      ]),
    )

    const inspection = await inspectHostedWorkspacePublish(
      {
        source: source({ publish_pull_request_head: null }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'setup\n' }],
        managedPaths: ['docs/setup.md'],
      },
      deps,
    )

    expect(inspection).toEqual({
      status: 'up_to_date',
      changedFileCount: 0,
      writtenFileCount: 0,
      deletedFileCount: 0,
      unchangedFileCount: 1,
      comparedCommitSha: 'base-sha',
      comparisonKey: expect.any(String),
      pullRequestUpToDate: undefined,
    })
    expect(deps.createBranch).not.toHaveBeenCalled()
    expect(deps.createFilesCommit).not.toHaveBeenCalled()
  })

  it('reports exact write and delete counts against the default branch', async () => {
    const deps = dependencies()
    deps.getTree.mockResolvedValue(
      tree('base-tree', [
        { path: 'docs/old.md', sha: gitBlobSha('old\n') },
      ]),
    )

    const inspection = await inspectHostedWorkspacePublish(
      {
        source: source({ publish_pull_request_head: null }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'new\n' }],
        managedPaths: ['docs/old.md'],
      },
      deps,
    )

    expect(inspection).toMatchObject({
      status: 'changes',
      changedFileCount: 2,
      writtenFileCount: 1,
      deletedFileCount: 1,
      unchangedFileCount: 0,
      comparedCommitSha: 'base-sha',
    })
  })

  it('changes the comparison key when content changes without changing the file count', async () => {
    const deps = dependencies()
    deps.getTree.mockResolvedValue(
      tree('base-tree', [
        { path: 'docs/setup.md', sha: gitBlobSha('old\n') },
      ]),
    )

    const first = await inspectHostedWorkspacePublish(
      {
        source: source({ publish_pull_request_head: null }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'first\n' }],
        managedPaths: ['docs/setup.md'],
      },
      deps,
    )
    const second = await inspectHostedWorkspacePublish(
      {
        source: source({ publish_pull_request_head: null }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'second\n' }],
        managedPaths: ['docs/setup.md'],
      },
      deps,
    )

    expect(first.changedFileCount).toBe(1)
    expect(second.changedFileCount).toBe(1)
    expect(first.comparisonKey).not.toBe(second.comparisonKey)
  })

  it('reports sync-required before comparing repository trees', async () => {
    const deps = dependencies()

    const inspection = await inspectHostedWorkspacePublish(
      {
        source: source({
          last_sync_commit_sha: 'older-sha',
          publish_pull_request_head: null,
        }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'new\n' }],
        managedPaths: [],
      },
      deps,
    )

    expect(inspection).toMatchObject({
      status: 'sync_required',
      changedFileCount: 0,
      comparedCommitSha: 'base-sha',
      code: 'github_sync_required',
    })
    expect(deps.getTree).not.toHaveBeenCalled()
  })

  it('compares an open Breezify pull request branch and marks it up to date', async () => {
    const deps = dependencies()
    deps.findOpenPullRequest.mockResolvedValue({
      number: 17,
      html_url: 'https://github.com/acme/docs/pull/17',
      state: 'open',
      title: 'Publish',
    })
    deps.getBranchReference.mockResolvedValue({
      ref: `refs/heads/${branch}`,
      object: { type: 'commit', sha: 'publish-sha' },
    })
    deps.getCommit.mockImplementation(async (_token, _repo, ref) =>
      ref === 'main'
        ? commit('base-sha', 'base-tree')
        : commit('publish-sha', 'publish-tree'),
    )
    deps.getTree.mockImplementation(async (_token, _repo, sha) =>
      sha === 'publish-tree'
        ? tree('publish-tree', [
            { path: 'docs/setup.md', sha: gitBlobSha('new\n') },
          ])
        : tree('base-tree'),
    )

    const inspection = await inspectHostedWorkspacePublish(
      {
        source: source({
          publish_pull_request_number: 17,
          publish_pull_request_url: 'https://github.com/acme/docs/pull/17',
          publish_last_commit_sha: 'publish-sha',
        }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'new\n' }],
        managedPaths: ['docs/setup.md'],
      },
      deps,
    )

    expect(inspection).toMatchObject({
      status: 'up_to_date',
      changedFileCount: 0,
      comparedCommitSha: 'publish-sha',
      pullRequestUpToDate: true,
    })
  })

  it('marks an open Breezify pull request stale when its branch differs', async () => {
    const deps = dependencies()
    deps.findOpenPullRequest.mockResolvedValue({
      number: 17,
      html_url: 'https://github.com/acme/docs/pull/17',
      state: 'open',
      title: 'Publish',
    })
    deps.getBranchReference.mockResolvedValue({
      ref: `refs/heads/${branch}`,
      object: { type: 'commit', sha: 'publish-sha' },
    })
    deps.getCommit.mockImplementation(async (_token, _repo, ref) =>
      ref === 'main'
        ? commit('base-sha', 'base-tree')
        : commit('publish-sha', 'publish-tree'),
    )
    deps.getTree.mockImplementation(async (_token, _repo, sha) =>
      sha === 'publish-tree'
        ? tree('publish-tree', [
            { path: 'docs/setup.md', sha: gitBlobSha('old\n') },
          ])
        : tree('base-tree'),
    )

    const inspection = await inspectHostedWorkspacePublish(
      {
        source: source({
          publish_pull_request_number: 17,
          publish_pull_request_url: 'https://github.com/acme/docs/pull/17',
          publish_last_commit_sha: 'publish-sha',
        }),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'new\n' }],
        managedPaths: ['docs/setup.md'],
      },
      deps,
    )

    expect(inspection).toMatchObject({
      status: 'changes',
      changedFileCount: 1,
      comparedCommitSha: 'publish-sha',
      pullRequestUpToDate: false,
    })
  })

  it('compares the default branch when a reserved branch has no open pull request', async () => {
    const deps = dependencies()
    deps.getBranchReference.mockResolvedValue({
      ref: `refs/heads/${branch}`,
      object: { type: 'commit', sha: 'stranded-branch-sha' },
    })
    deps.getTree.mockResolvedValue(
      tree('base-tree', [
        { path: 'docs/setup.md', sha: gitBlobSha('default\n') },
      ]),
    )

    const inspection = await inspectHostedWorkspacePublish(
      {
        source: source(),
        files: [{ documentId: 'one', path: 'docs/setup.md', content: 'default\n' }],
        managedPaths: ['docs/setup.md'],
      },
      deps,
    )

    expect(inspection).toMatchObject({
      status: 'up_to_date',
      comparedCommitSha: 'base-sha',
      pullRequestUpToDate: undefined,
    })
    expect(deps.getCommit).toHaveBeenCalledTimes(1)
    expect(deps.getCommit).toHaveBeenCalledWith('token', 'acme/docs', 'main')
    expect(deps.getBranchReference).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// resolveHostedWorkspacePublishDiff — the "files changed" preview.
//
// The plan compares blob SHAs and never downloads bodies (that is what keeps
// the polled status check cheap). The preview needs the OLD bodies, so these
// pin that it fetches them only for changed paths and stays inside its caps.
// ---------------------------------------------------------------------------
describe('resolveHostedWorkspacePublishDiff', () => {
  function blobDeps(bodies: Record<string, string> = {}) {
    const deps = dependencies()
    return {
      ...deps,
      getBlob: vi.fn(async (_token: string, _repo: string, sha: string) => ({
        sha,
        size: 20,
        content: Buffer.from(bodies[sha] ?? '').toString('base64'),
        encoding: 'base64' as const,
      })),
    }
  }

  it('marks a path the repository does not have as added, and fetches no body for it', async () => {
    const deps = blobDeps()
    const diff = await resolveHostedWorkspacePublishDiff(
      {
        source: source(),
        files: [{ path: 'docs/new.md', content: 'hello', documentId: 'doc-new' }],
        managedPaths: [],
      },
      deps,
    )

    expect(diff.files).toHaveLength(1)
    expect(diff.files[0]).toMatchObject({
      path: 'docs/new.md',
      status: 'added',
      previous: '',
      next: 'hello',
    })
    // An added file has no "before" — fetching one would be a wasted call.
    expect(deps.getBlob).not.toHaveBeenCalled()
  })

  it('pairs a changed path with the text currently on GitHub', async () => {
    const existing = gitBlobSha('old body')
    const deps = blobDeps({ [existing]: 'old body' })
    deps.getTree.mockResolvedValue(
      tree('base-tree', [{ path: 'docs/page.md', sha: existing }]),
    )

    const diff = await resolveHostedWorkspacePublishDiff(
      {
        source: source(),
        files: [{ path: 'docs/page.md', content: 'new body', documentId: 'doc-page' }],
        managedPaths: ['docs/page.md'],
      },
      deps,
    )

    expect(diff.files[0]).toMatchObject({
      path: 'docs/page.md',
      status: 'modified',
      previous: 'old body',
      next: 'new body',
      previousBlobSha: existing,
    })
  })

  it('leaves an unchanged path out entirely', async () => {
    const same = gitBlobSha('identical')
    const deps = blobDeps({ [same]: 'identical' })
    deps.getTree.mockResolvedValue(
      tree('base-tree', [{ path: 'docs/page.md', sha: same }]),
    )

    const diff = await resolveHostedWorkspacePublishDiff(
      {
        source: source(),
        files: [{ path: 'docs/page.md', content: 'identical', documentId: 'doc-page' }],
        managedPaths: ['docs/page.md'],
      },
      deps,
    )

    expect(diff.files).toHaveLength(0)
    expect(diff.changedFileCount).toBe(0)
    expect(deps.getBlob).not.toHaveBeenCalled()
  })

  // The cap has to bound API CALLS, not just the response — it is applied
  // before any body is fetched.
  it('caps how many files it fetches and reports the total honestly', async () => {
    const deps = blobDeps()
    const files = Array.from({ length: 70 }, (_, index) => ({
      path: `docs/page-${String(index).padStart(3, '0')}.md`,
      content: `body ${index}`,
      documentId: `doc-${index}`,
    }))

    const diff = await resolveHostedWorkspacePublishDiff(
      { source: source(), files, managedPaths: [] },
      deps,
    )

    expect(diff.files).toHaveLength(PUBLISH_DIFF_MAX_FILES)
    expect(diff.changedFileCount).toBe(70)
    expect(diff.truncated).toBe(true)
  })

  it('keeps a file in the list when its body cannot be read', async () => {
    const existing = gitBlobSha('old body')
    const deps = blobDeps()
    deps.getBlob.mockRejectedValue(new Error('blob unavailable'))
    deps.getTree.mockResolvedValue(
      tree('base-tree', [{ path: 'docs/page.md', sha: existing }]),
    )

    const diff = await resolveHostedWorkspacePublishDiff(
      {
        source: source(),
        files: [{ path: 'docs/page.md', content: 'new body', documentId: 'doc-page' }],
        managedPaths: ['docs/page.md'],
      },
      deps,
    )

    expect(diff.files[0]).toMatchObject({
      path: 'docs/page.md',
      bodyOmitted: true,
      next: 'new body',
    })
  })

  it('reports a managed path that disappeared as removed', async () => {
    const existing = gitBlobSha('stale')
    const deps = blobDeps({ [existing]: 'stale' })
    deps.getTree.mockResolvedValue(
      tree('base-tree', [{ path: 'docs/gone.md', sha: existing }]),
    )

    const diff = await resolveHostedWorkspacePublishDiff(
      { source: source(), files: [], managedPaths: ['docs/gone.md'] },
      deps,
    )

    expect(diff.files[0]).toMatchObject({
      path: 'docs/gone.md',
      status: 'removed',
      previous: 'stale',
      next: '',
      previousBlobSha: existing,
    })
  })
})
