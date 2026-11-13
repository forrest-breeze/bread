import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubBlob,
  GitHubRepositoryTree,
  GitHubTreeEntry,
} from './github'
import type { GitHubCheckRun } from './github-checks'
import {
  extractGitHubDocsCheckInfo,
  handleGitHubDocsCheck,
  BREEZIFY_DOCS_CHECK_NAME,
  type GitHubDocsCheckDependencies,
  type GitHubDocsCheckInfo,
} from './github-docs-check'
import { BREEZIFY_HOSTED_DOC_MAX_BYTES } from './github-hosted-format'
import { MAX_HOSTED_WORKSPACE_BYTES } from './github-hosted-workspace'
import { GitHubApiError } from './retry'

const INFO: GitHubDocsCheckInfo = {
  installationId: 7,
  repoId: 42,
  repoFullName: 'acme/product-docs',
  headSha: 'commit-sha',
}
const NOW = new Date('2026-08-19T16:00:00.000Z')

function sourceAdmin(
  rows: Array<{ paths: unknown }>,
  error: { message: string } | null = null,
): {
  admin: SupabaseClient
  from: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
} {
  const query: Record<string, unknown> = {}
  const select = vi.fn(() => query)
  const eq = vi.fn()
    .mockImplementationOnce(() => query)
    .mockResolvedValueOnce({ data: rows, error })
  Object.assign(query, { select, eq })
  const from = vi.fn(() => query)
  return {
    admin: { from } as unknown as SupabaseClient,
    from,
    select,
    eq,
  }
}

function treeEntry(
  path: string,
  overrides: Partial<GitHubTreeEntry> = {},
): GitHubTreeEntry {
  return {
    path,
    mode: '100644',
    type: 'blob',
    sha: `sha-${path}`,
    size: 100,
    url: `https://api.github.test/trees/${encodeURIComponent(path)}`,
    ...overrides,
  }
}

function repositoryTree(entries: GitHubTreeEntry[]): GitHubRepositoryTree {
  return { sha: 'tree-sha', truncated: false, tree: entries }
}

function documentContent(index = 1): string {
  const id = String(index).padStart(12, '0')
  return [
    '---',
    `title: "Document ${index}"`,
    `breezify_document_id: "00000000-0000-4000-8000-${id}"`,
    '---',
    '',
    `# Document ${index}`,
    '',
    'Body',
    '',
  ].join('\n')
}

function blob(content: string, sha = 'blob-sha'): GitHubBlob {
  return {
    sha,
    size: Buffer.byteLength(content, 'utf8'),
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64'),
  }
}

async function noRetry<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}

function defaultMocks(input: {
  admin?: SupabaseClient
  tree?: GitHubRepositoryTree
  getBlob?: NonNullable<GitHubDocsCheckDependencies['getBlob']>
} = {}) {
  const fallbackAdmin = sourceAdmin([{ paths: ['docs'] }]).admin
  const defaultTree = repositoryTree([
    treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
    treeEntry('docs/start.md', { size: Buffer.byteLength(documentContent()) }),
  ])
  const getToken = vi.fn<NonNullable<GitHubDocsCheckDependencies['getToken']>>()
    .mockResolvedValue('installation-token')
  const createCheck = vi.fn<NonNullable<GitHubDocsCheckDependencies['createCheck']>>()
    .mockResolvedValue({
      id: 99,
      html_url: 'https://github.test/checks/99',
      status: 'in_progress',
      conclusion: null,
    })
  const updateCheck = vi.fn<NonNullable<GitHubDocsCheckDependencies['updateCheck']>>()
    .mockImplementation(async (_token, _repo, id, update): Promise<GitHubCheckRun> => ({
      id,
      html_url: `https://github.test/checks/${id}`,
      status: update.status ?? 'in_progress',
      conclusion: update.conclusion ?? null,
    }))
  const getCommit = vi.fn<NonNullable<GitHubDocsCheckDependencies['getCommit']>>()
    .mockResolvedValue({ sha: INFO.headSha, commit: { tree: { sha: 'tree-sha' } } })
  const getTree = vi.fn<NonNullable<GitHubDocsCheckDependencies['getTree']>>()
    .mockResolvedValue(input.tree ?? defaultTree)
  const getBlob = vi.fn<NonNullable<GitHubDocsCheckDependencies['getBlob']>>(
    input.getBlob ?? (async (_token, _repo, sha) => blob(documentContent(), sha)),
  )
  const clearToken = vi.fn<NonNullable<GitHubDocsCheckDependencies['clearToken']>>()
    .mockResolvedValue(undefined)

  const deps: GitHubDocsCheckDependencies = {
    admin: input.admin ?? fallbackAdmin,
    getToken,
    createCheck,
    updateCheck,
    getCommit,
    getTree,
    getBlob,
    clearToken,
    retry: noRetry,
    now: () => NOW,
  }
  return {
    deps,
    getToken,
    createCheck,
    updateCheck,
    getCommit,
    getTree,
    getBlob,
    clearToken,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('extractGitHubDocsCheckInfo', () => {
  const common = {
    repository: { id: 42, full_name: 'acme/product-docs' },
    installation: { id: 7 },
  }

  it.each(['requested', 'rerequested'])('accepts check_suite %s events', (action) => {
    expect(extractGitHubDocsCheckInfo('check_suite', {
      ...common,
      action,
      check_suite: { head_sha: 'suite-head-sha' },
    })).toEqual({
      installationId: 7,
      repoId: 42,
      repoFullName: 'acme/product-docs',
      headSha: 'suite-head-sha',
    })
  })

  it('accepts only our App-owned, exact-name check_run rerequest', () => {
    const payload = {
      ...common,
      action: 'rerequested',
      check_run: {
        name: BREEZIFY_DOCS_CHECK_NAME,
        head_sha: 'run-head-sha',
        app: { id: 1234 },
      },
    }

    expect(extractGitHubDocsCheckInfo('check_run', payload, '1234')).toEqual({
      installationId: 7,
      repoId: 42,
      repoFullName: 'acme/product-docs',
      headSha: 'run-head-sha',
    })
    expect(extractGitHubDocsCheckInfo('check_run', payload, undefined)).toBeNull()
    expect(extractGitHubDocsCheckInfo('check_run', payload, '9999')).toBeNull()
    expect(extractGitHubDocsCheckInfo('check_run', {
      ...payload,
      check_run: { ...payload.check_run, name: 'Validate other docs' },
    }, '1234')).toBeNull()
  })

  it('rejects unrelated actions and malformed repository identity', () => {
    expect(extractGitHubDocsCheckInfo('check_suite', {
      ...common,
      action: 'completed',
      check_suite: { head_sha: 'sha' },
    })).toBeNull()
    expect(extractGitHubDocsCheckInfo('check_suite', {
      ...common,
      repository: { id: 42 },
      action: 'requested',
      check_suite: { head_sha: 'sha' },
    })).toBeNull()
  })
})

describe('handleGitHubDocsCheck', () => {
  it('filters the admin lookup by installation and repository, then no-ops when unlinked', async () => {
    const admin = sourceAdmin([])
    const mocks = defaultMocks({ admin: admin.admin })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toEqual({
      status: 'ignored',
      reason: 'unlinked',
    })

    expect(admin.from).toHaveBeenCalledWith('github_hosted_docs_sources')
    expect(admin.select).toHaveBeenCalledWith('paths, format')
    expect(admin.eq).toHaveBeenNthCalledWith(1, 'installation_id', 7)
    expect(admin.eq).toHaveBeenNthCalledWith(2, 'repo_id', 42)
    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(mocks.createCheck).not.toHaveBeenCalled()
  })

  it('aggregates unique roots, validates the exact commit, and completes successfully', async () => {
    const admin = sourceAdmin([
      { paths: ['docs/api'] },
      { paths: ['guides', 'docs/api'] },
    ])
    const first = documentContent(1)
    const second = documentContent(2)
    const tree = repositoryTree([
      treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
      treeEntry('docs/api', { type: 'tree', mode: '040000', size: undefined }),
      treeEntry('docs/api/intro.md', { size: Buffer.byteLength(first) }),
      treeEntry('guides', { type: 'tree', mode: '040000', size: undefined }),
      treeEntry('guides/setup.mdx', { size: Buffer.byteLength(second) }),
      treeEntry('other/ignored.md'),
    ])
    const getBlob = vi.fn<NonNullable<GitHubDocsCheckDependencies['getBlob']>>()
      .mockImplementation(async (_token, _repo, sha) =>
        sha.includes('intro') ? blob(first, sha) : blob(second, sha))
    const mocks = defaultMocks({ admin: admin.admin, tree, getBlob })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toEqual({
      status: 'success',
      checkRunId: 99,
      documentCount: 2,
    })

    expect(mocks.createCheck).toHaveBeenCalledWith(
      'installation-token',
      INFO.repoFullName,
      {
        name: BREEZIFY_DOCS_CHECK_NAME,
        head_sha: INFO.headSha,
        external_id: `breezify-docs:${INFO.repoId}:${INFO.headSha}`,
        status: 'in_progress',
        started_at: NOW.toISOString(),
      },
    )
    expect(mocks.getCommit).toHaveBeenCalledWith(
      'installation-token',
      INFO.repoFullName,
      INFO.headSha,
    )
    expect(mocks.getTree).toHaveBeenCalledWith(
      'installation-token',
      INFO.repoFullName,
      'tree-sha',
    )
    expect(mocks.getBlob).toHaveBeenCalledTimes(2)
    const completion = mocks.updateCheck.mock.calls[0]?.[3]
    expect(completion).toMatchObject({
      status: 'completed',
      conclusion: 'success',
      completed_at: NOW.toISOString(),
      output: {
        title: 'Breezify documents are valid',
        summary:
          'Validated 2 Breezify documents across 2 linked roots at this commit. All 6 checks passed.',
      },
    })
    expect(completion?.output?.text).toContain('### Checks performed')
    expect(completion?.output?.text).toContain('**Repository scope:**')
    expect(completion?.output?.text).toContain('**File content:** 2 Markdown/MDX documents were decoded completely as valid UTF-8 text without NUL or replacement characters.')
    expect(completion?.output?.text).toContain('**Frontmatter:**')
    expect(completion?.output?.text).toContain('**Document identity:**')
    expect(completion?.output?.text).toContain('**Title structure:**')
    expect(completion?.output?.text).toContain('**Size limits:**')
    expect(completion?.output?.text).toContain('500-document limit')
    expect(completion?.output?.text).toContain('256 KiB')
    expect(completion?.output?.text).toContain('8 MiB combined limit')
    expect(completion?.output?.text).toContain('### Linked roots')
    expect(completion?.output?.text).toContain('- `docs/api`')
    expect(completion?.output?.text).toContain('- `guides`')
    expect(completion?.output?.text).toContain(
      'Breezify does not lint links, prose, or general Markdown/MDX syntax.',
    )
  })

  it('uses singular scope wording for one document in one linked root', async () => {
    const mocks = defaultMocks()

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toMatchObject({
      status: 'success',
      documentCount: 1,
    })

    const output = mocks.updateCheck.mock.calls[0]?.[3].output
    expect(output?.summary).toBe(
      'Validated 1 Breezify document across 1 linked root at this commit. All 6 checks passed.',
    )
    expect(output?.text).toContain('1 Markdown/MDX document was decoded completely')
    expect(output?.text).toContain('1 document is within the 500-document limit')
  })

  it('clears a pre-permission token and retries check creation once after a 403', async () => {
    const mocks = defaultMocks()
    mocks.getToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token')
    mocks.createCheck
      .mockRejectedValueOnce(new GitHubApiError('Forbidden', 403))
      .mockResolvedValueOnce({
        id: 99,
        html_url: 'https://github.test/checks/99',
        status: 'in_progress',
        conclusion: null,
      })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toMatchObject({
      status: 'success',
    })

    expect(mocks.clearToken).toHaveBeenCalledWith(INFO.installationId)
    expect(mocks.getToken).toHaveBeenCalledTimes(2)
    expect(mocks.createCheck).toHaveBeenNthCalledWith(
      2,
      'fresh-token',
      INFO.repoFullName,
      expect.objectContaining({ head_sha: INFO.headSha }),
    )
  })

  it('backs off a secondary-rate-limit 403 without replacing the token', async () => {
    const mocks = defaultMocks()
    mocks.deps.retry = noRetry
    mocks.createCheck
      .mockRejectedValueOnce(new GitHubApiError('Secondary rate limit', 403))
      .mockResolvedValueOnce({
        id: 99,
        html_url: 'https://github.test/checks/99',
        status: 'in_progress',
        conclusion: null,
      })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toMatchObject({
      status: 'success',
    })

    expect(mocks.clearToken).not.toHaveBeenCalled()
    expect(mocks.getToken).toHaveBeenCalledTimes(1)
    expect(mocks.createCheck).toHaveBeenNthCalledWith(
      2,
      'installation-token',
      INFO.repoFullName,
      expect.objectContaining({ head_sha: INFO.headSha }),
    )
  })

  it('publishes at most 50 line-one annotations for document format failures', async () => {
    const entries: GitHubTreeEntry[] = [
      treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
      ...Array.from({ length: 55 }, (_, index) =>
        treeEntry(`docs/invalid-${index}.md`, { size: 10 })),
    ]
    const mocks = defaultMocks({
      tree: repositoryTree(entries),
      getBlob: async (_token, _repo, sha) => blob('# Invalid\n', sha),
    })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toEqual({
      status: 'failure',
      checkRunId: 99,
    })

    const completion = mocks.updateCheck.mock.calls[0]?.[3]
    expect(completion?.conclusion).toBe('failure')
    expect(completion?.output?.summary).toBe('55 issues found in 55 documents.')
    expect(completion?.output?.annotations).toHaveLength(50)
    expect(completion?.output?.annotations?.every((annotation) =>
      annotation.start_line === 1 && annotation.end_line === 1,
    )).toBe(true)
    expect(completion?.output?.text).toContain('### Errors')
    expect(completion?.output?.text).toContain('- `docs/invalid-0.md`')
    expect(completion?.output?.text).toContain('`must start with Breezify frontmatter`')
    expect(completion?.output?.text).toContain('…and 35 more issues')
    expect(completion?.output?.text).toContain(
      'GitHub annotations show the first 50 issues.',
    )
    expect(completion?.output?.text).toContain('### Check scope')
    expect(completion?.output?.text).toContain('- Commit: `commit-sha`')
    expect(completion?.output?.text).toContain('- Linked docs folder:')
    expect(completion?.output?.text).toContain('  - `docs`')
    expect(completion?.output?.text).toContain('### Next step')
  })

  it('shows the exact file, error, linked folder, and commit for one invalid document', async () => {
    const invalid = [
      '---',
      'title: "Document 1"',
      'breezify_document_id: "not-a-uuid"',
      '---',
      '',
      '# Document 1',
      '',
    ].join('\n')
    const mocks = defaultMocks({
      tree: repositoryTree([
        treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
        treeEntry('docs/guides/setup.md', { size: Buffer.byteLength(invalid) }),
      ]),
      getBlob: async (_token, _repo, sha) => blob(invalid, sha),
    })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toEqual({
      status: 'failure',
      checkRunId: 99,
    })

    const output = mocks.updateCheck.mock.calls[0]?.[3].output
    expect(output?.summary).toBe('1 issue found in 1 document.')
    expect(output?.text).toContain('- `docs/guides/setup.md`')
    expect(output?.text).toContain(
      '`breezify_document_id must be a valid quoted UUID`',
    )
    expect(output?.text).toContain('- Commit: `commit-sha`')
    expect(output?.text).toContain('- Linked docs folder:')
    expect(output?.text).toContain('  - `docs`')
    expect(output?.text).toContain(
      'Fix the document errors above, then push another commit or re-run this check.',
    )
  })

  it.each([
    {
      name: 'a truncated repository tree',
      tree: { ...repositoryTree([]), truncated: true },
      summary: 'GitHub returned an incomplete repository tree',
    },
    {
      name: 'a missing configured root',
      tree: repositoryTree([]),
      summary: 'root is missing or is not a directory',
    },
    {
      name: 'a configured root that is not a tree',
      tree: repositoryTree([treeEntry('docs')]),
      summary: 'root is missing or is not a directory',
    },
    {
      name: 'more than 500 selected documents',
      tree: repositoryTree([
        treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
        ...Array.from({ length: 501 }, (_, index) =>
          treeEntry(`docs/doc-${index}.md`)),
      ]),
      summary: 'more than 500 linked Breezify documents',
    },
    {
      name: 'a document with missing size metadata',
      tree: repositoryTree([
        treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
        treeEntry('docs/no-size.md', { size: undefined }),
      ]),
      summary: 'did not report a safe size',
    },
    {
      name: 'documents over the aggregate workspace limit',
      tree: repositoryTree([
        treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
        ...Array.from({ length: 33 }, (_, index) =>
          treeEntry(`docs/doc-${index}.md`, { size: BREEZIFY_HOSTED_DOC_MAX_BYTES })),
      ]),
      summary: `${MAX_HOSTED_WORKSPACE_BYTES}-byte workspace limit`,
    },
  ])('fails safely without fetching blobs for $name', async ({ tree, summary }) => {
    const mocks = defaultMocks({ tree })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toMatchObject({
      status: 'failure',
    })

    expect(mocks.getBlob).not.toHaveBeenCalled()
    const completion = mocks.updateCheck.mock.calls[0]?.[3]
    expect(completion?.conclusion).toBe('failure')
    expect(completion?.output?.summary).toContain(summary)
    expect(completion?.output?.text).toContain('### Check scope')
    expect(completion?.output?.text).toContain('- Commit: `commit-sha`')
    expect(completion?.output?.text).toContain('- Linked docs folder:')
    expect(completion?.output?.text).toContain('  - `docs`')
    expect(completion?.output?.text).toContain('### Next step')
  })

  it('rejects an oversized document from tree metadata before fetching it', async () => {
    const mocks = defaultMocks({
      tree: repositoryTree([
        treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
        treeEntry('docs/large.md', { size: BREEZIFY_HOSTED_DOC_MAX_BYTES + 1 }),
      ]),
    })

    await handleGitHubDocsCheck(INFO, mocks.deps)

    expect(mocks.getBlob).not.toHaveBeenCalled()
    const annotation = mocks.updateCheck.mock.calls[0]?.[3].output?.annotations?.[0]
    expect(annotation).toMatchObject({
      path: 'docs/large.md',
      start_line: 1,
      end_line: 1,
      annotation_level: 'failure',
    })
    expect(annotation?.message).toContain(`${BREEZIFY_HOSTED_DOC_MAX_BYTES}-byte`)
  })

  it('rejects a non-base64 blob with a file annotation', async () => {
    const mocks = defaultMocks({
      getBlob: async (_token, _repo, sha) => ({
        sha,
        size: 4,
        encoding: 'utf-8',
        content: 'nope',
      }),
    })

    await handleGitHubDocsCheck(INFO, mocks.deps)

    const completion = mocks.updateCheck.mock.calls[0]?.[3]
    expect(completion?.conclusion).toBe('failure')
    expect(completion?.output?.annotations?.[0]).toMatchObject({
      path: 'docs/start.md',
      message: expect.stringContaining('base64-encoded'),
    })
  })

  it('bounds concurrent blob reads', async () => {
    const contents = Array.from({ length: 18 }, (_, index) => documentContent(index + 1))
    const tree = repositoryTree([
      treeEntry('docs', { type: 'tree', mode: '040000', size: undefined }),
      ...contents.map((content, index) =>
        treeEntry(`docs/doc-${index + 1}.md`, { size: Buffer.byteLength(content) })),
    ])
    let active = 0
    let maximum = 0
    const getBlob = vi.fn<NonNullable<GitHubDocsCheckDependencies['getBlob']>>()
      .mockImplementation(async (_token, _repo, sha) => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 0))
        active--
        const index = Number(/doc-(\d+)/.exec(sha)?.[1] ?? 1) - 1
        return blob(contents[index]!, sha)
      })
    const mocks = defaultMocks({ tree, getBlob })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toMatchObject({
      status: 'success',
      documentCount: 18,
    })

    expect(maximum).toBe(6)
  })

  it('uses a generic failure output when an internal error contains a secret', async () => {
    const secret = 'ghs_do-not-expose-this-token'
    const mocks = defaultMocks()
    mocks.getTree.mockRejectedValue(new Error(`upstream echoed ${secret}`))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toEqual({
      status: 'failure',
      checkRunId: 99,
    })

    const completion = mocks.updateCheck.mock.calls[0]?.[3]
    expect(JSON.stringify(completion?.output)).not.toContain(secret)
    expect(completion?.output).toEqual({
      title: 'Breezify document validation could not finish',
      summary: 'Breezify could not safely complete validation for this commit.',
      text: 'Re-run the check. If it fails again, reconnect the repository from Breezify settings.',
    })
  })

  it('does not overwrite a successful outcome when its completion response is lost', async () => {
    const mocks = defaultMocks()
    mocks.updateCheck.mockRejectedValue(
      new GitHubApiError('upstream response lost', 502),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).resolves.toEqual({
      status: 'failure',
      checkRunId: 99,
    })

    expect(mocks.updateCheck).toHaveBeenCalledTimes(1)
    expect(mocks.updateCheck.mock.calls[0]?.[3]).toMatchObject({
      status: 'completed',
      conclusion: 'success',
    })
  })

  it('does not mint a token when the server-side source lookup fails', async () => {
    const admin = sourceAdmin([], { message: 'database unavailable' })
    const mocks = defaultMocks({ admin: admin.admin })

    await expect(handleGitHubDocsCheck(INFO, mocks.deps)).rejects.toThrow(
      'Unable to look up linked Breezify documentation roots.',
    )
    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(mocks.createCheck).not.toHaveBeenCalled()
  })
})
