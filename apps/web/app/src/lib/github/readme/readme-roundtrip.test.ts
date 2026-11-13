import { describe, expect, it } from 'vitest'
import { FakeRepository, MemoryReadmeStore } from '@/test/readme-sync-fixtures'
import { parseOrderFile, parseReadmeFile } from './readme-frontmatter'
import {
  commitReadmeSpecFile,
  diffReadmePublish,
  inspectReadmePublish,
  publishReadmeWorkspace,
  ReadmePublishError,
  type ReadmePublishMode,
  type ReadmePublishSource,
} from './readme-publish'
import { syncReadmeRepository, type ReadmeSyncMode } from './readme-sync'

const PETSTORE_YAML = [
  'openapi: 3.0.3',
  'info:',
  '  title: Payments API',
  '  version: 1.0.0',
  'paths:',
  '  /payments:',
  '    get:',
  '      operationId: listPayments',
  '      responses:',
  "        '200':",
  '          description: OK',
  '',
].join('\n')

const QUICKSTART = [
  '---',
  'title: Quickstart',
  'excerpt: Take your first payment.',
  'hidden: false',
  'metadata:',
  '  title: Quickstart | Breeze',
  '  robots: index',
  'next:',
  '  pages:',
  '    - slug: api-keys',
  '      type: basic',
  '---',
  'Install the SDK.',
  '',
  '<Callout icon="📘" theme="info">',
  '  Sandbox keys start with `sk_test`.',
  '</Callout>',
  '',
].join('\n')

/** A repository laid out the way ReadMe's GitHub integration writes it. */
function readmeRepositoryFiles(): Record<string, string> {
  return {
    'README.md': '# not part of the docs\n',
    'docs/_order.yaml': '- getting-started\n- guides\n',
    'docs/getting-started/_order.yaml': '- quickstart\n- authentication\n',
    'docs/getting-started/quickstart.md': QUICKSTART,
    'docs/getting-started/authentication/index.md':
      '---\ntitle: Authentication\nicon: fa-key\n---\nHow requests are authenticated.\n',
    'docs/getting-started/authentication/_order.yaml': '- api-keys\n',
    'docs/getting-started/authentication/api-keys.md': '---\ntitle: API keys\n---\nRotate keys often.\n',
    'docs/guides/webhooks.md': '---\ntitle: Webhooks\nhidden: true\n---\nComing soon.\n',
    'reference/payments.yaml': PETSTORE_YAML,
    'reference/payments/list-payments.md':
      '---\napi:\n  file: payments.yaml\n  operationId: listPayments\n---\n',
    'reference/errors.md': '---\ntitle: Errors\n---\nError codes.\n',
    'changelogs/2025-01-15-launch.md':
      '---\ntitle: Launch\ntype: added\ndate: 2025-01-15\n---\nWe launched.\n',
    'custom_pages/terms.md': '---\ntitle: Terms\nfullscreen: false\n---\nThe terms.\n',
  }
}

function harness(
  files: Record<string, string> = readmeRepositoryFiles(),
  options: { publishMode?: ReadmePublishMode; root?: string; branch?: string | null } = {},
) {
  const repo = new FakeRepository(files)
  const store = new MemoryReadmeStore(repo.id)
  const root = options.root ?? ''
  const branch = options.branch ?? null
  // The editor may store HTML; these tests keep Markdown, so this is identity.
  const toMarkdown = (content: string | null | undefined): string => content ?? ''
  const deps = { store, toMarkdown, ...repo.github() }
  const source = (): ReadmePublishSource => ({
    installationId: 7,
    repoId: repo.id,
    repoFullName: repo.fullName,
    root,
    branch,
    lastSyncCommitSha: (store.source.last_sync_commit_sha as string | undefined) ?? null,
    syncState: store.source.sync_state ?? null,
    publishMode: options.publishMode ?? 'direct',
    publishPullRequestNumber: (store.source.publish_pull_request_number as number | undefined) ?? null,
    publishPullRequestHead: (store.source.publish_pull_request_head as string | undefined) ?? null,
  })
  return {
    repo,
    store,
    sync: (syncOptions: { mode?: ReadmeSyncMode; force?: boolean } = {}) => {
      repo.blobReads = []
      return syncReadmeRepository(
        {
          installationId: 7,
          repoId: repo.id,
          repoFullName: repo.fullName,
          root,
          branch,
          lastSyncCommitSha: source().lastSyncCommitSha,
          syncState: source().syncState,
          mode: syncOptions.mode ?? 'merge',
          force: syncOptions.force,
        },
        deps,
      )
    },
    inspect: () => inspectReadmePublish(source(), deps),
    diff: () => diffReadmePublish(source(), deps),
    publish: (publishOptions: Parameters<typeof publishReadmeWorkspace>[2] = {}) =>
      publishReadmeWorkspace(source(), deps, publishOptions),
    commitSpec: (input: Parameters<typeof commitReadmeSpecFile>[2]) =>
      commitReadmeSpecFile(source(), deps, input),
  }
}

describe('ReadMe-format GitHub sync: repository -> workspace', () => {
  it('imports a ReadMe repository as folders, pages and API definitions', async () => {
    const { store, sync } = harness()
    const result = await sync()

    // Guide categories are top-level folders; other sections get one folder.
    const gettingStarted = store.folder('docs/getting-started')
    expect(gettingStarted).toMatchObject({ displayName: 'Getting Started', parentId: null, sortOrder: 0 })
    expect(store.folder('docs/guides')).toMatchObject({ parentId: null, sortOrder: 1 })
    expect(store.folder('reference')).toMatchObject({ displayName: 'API Reference', parentId: null })
    expect(store.folder('changelogs').displayName).toBe('Changelog')
    expect(store.folder('custom_pages').displayName).toBe('Custom Pages')

    // A page with child pages is a folder whose landing content is index.md.
    const authentication = store.folder('docs/getting-started/authentication')
    expect(authentication).toMatchObject({
      displayName: 'Authentication',
      parentId: gettingStarted.id,
      sortOrder: 1,
      content: 'How requests are authenticated.',
    })

    const quickstart = store.document('docs/getting-started/quickstart.md')
    expect(quickstart).toMatchObject({
      title: 'Quickstart',
      status: 'Published',
      folderId: gettingStarted.id,
      sortOrder: 0,
      publicSlug: 'quickstart',
    })
    // MDX the editor cannot express is flattened to Markdown in Bread...
    expect(quickstart.content).toBe('Install the SDK.\n\n> 📘\n>\n> Sandbox keys start with `sk_test`.')
    // ...and the whole frontmatter is kept for the way back.
    expect(quickstart.metadata?.readme_frontmatter).toMatchObject({
      excerpt: 'Take your first payment.',
      metadata: { title: 'Quickstart | Breeze', robots: 'index' },
      next: { pages: [{ slug: 'api-keys', type: 'basic' }] },
    })

    expect(store.document('API keys')).toMatchObject({ folderId: authentication.id, sortOrder: 0 })
    // hidden: true is an unpublished page.
    expect(store.document('Webhooks').status).toBe('Draft')
    expect(store.document('Launch').metadata?.published_date).toBe('2025-01-15T00:00:00.000Z')
    expect(store.document('Errors').folderId).toBe(store.folder('reference').id)

    // The OpenAPI definition goes through the existing OpenAPI source sync...
    expect(store.specs.get('payments')).toMatchObject({
      repoPath: 'reference/payments.yaml',
      specRaw: PETSTORE_YAML,
      operationCount: 1,
    })
    // ...so the per-operation stub ReadMe generates is not imported as a page.
    expect(result.skipped).toEqual([
      expect.objectContaining({ path: 'reference/payments/list-payments.md', quiet: true }),
    ])
    expect(store.liveDocuments().map((document) => document.title).sort()).toEqual([
      'API keys', 'Errors', 'Launch', 'Quickstart', 'Terms', 'Webhooks',
    ])
    expect(store.source).toMatchObject({ sync_status: 'synced', conflict_count: 0, document_count: 7 })
    expect(result).toMatchObject({ created: 7, updated: 0, removed: 0 })
  })

  it('reads only the blobs that changed on later syncs', async () => {
    const { repo, store, sync } = harness()
    await sync()
    // Same commit: nothing to do, nothing fetched.
    await sync()
    expect(repo.blobReads).toEqual([])

    repo.push({
      'docs/getting-started/authentication/api-keys.md':
        '---\ntitle: API keys\n---\nRotate keys every 90 days.\n',
    })
    const result = await sync()
    expect(repo.blobReads).toEqual(['docs/getting-started/authentication/api-keys.md'])
    expect(result).toMatchObject({ created: 0, updated: 1, removed: 0 })
    expect(store.document('API keys').content).toBe('Rotate keys every 90 days.')
    // The previous version is kept as a document version, not lost.
    expect(store.snapshots).toEqual([
      expect.objectContaining({ title: 'API keys', content: 'Rotate keys often.' }),
    ])
  })

  it('keeps a hidden page hidden when its content changes on GitHub', async () => {
    const { repo, store, sync } = harness()
    await sync()
    expect(store.document('Webhooks').status).toBe('Draft')
    repo.push({ 'docs/guides/webhooks.md': '---\ntitle: Webhooks\nhidden: true\n---\nStill not ready.\n' })
    await sync()
    expect(store.document('Webhooks')).toMatchObject({ content: 'Still not ready.', status: 'Draft' })

    // Un-hiding on GitHub publishes it; a page unpublished in Bread stays so.
    repo.push({ 'docs/guides/webhooks.md': '---\ntitle: Webhooks\nhidden: false\n---\nReady.\n' })
    await sync()
    expect(store.document('Webhooks').status).toBe('Published')
    store.document('Errors').status = 'Draft'
    repo.push({ 'reference/errors.md': '---\ntitle: Errors\n---\nMore error codes.\n' })
    await sync()
    // Bread changed only the visibility, so GitHub's content still applies.
    expect(store.document('Errors')).toMatchObject({ content: 'More error codes.', status: 'Draft' })
  })

  it('follows a changed _order.yaml without re-reading the pages', async () => {
    const { repo, store, sync } = harness()
    await sync()
    repo.push({ 'docs/getting-started/_order.yaml': '- authentication\n- quickstart\n' })
    await sync()
    expect(repo.blobReads).toEqual(['docs/getting-started/_order.yaml'])
    expect(store.document('Quickstart').sortOrder).toBe(1)
    expect(store.folder('Authentication').sortOrder).toBe(0)
  })

  it('keeps the document when a file is renamed or moved on GitHub', async () => {
    const { repo, store, sync } = harness()
    await sync()
    const before = store.document('Quickstart')
    repo.push({
      'docs/getting-started/quickstart.md': null,
      'docs/guides/quick-start.md': QUICKSTART,
    })
    const result = await sync()
    const after = store.document('Quickstart')
    expect(after.id).toBe(before.id)
    expect(after.publicSlug).toBe('quickstart')
    expect(after.folderId).toBe(store.folder('docs/guides').id)
    expect(after.metadata?.canonical_repo_path).toBe('docs/guides/quick-start.md')
    expect(result).toMatchObject({ created: 0, removed: 0 })
  })

  it('removes pages deleted on GitHub, but keeps ones edited in Bread', async () => {
    const { repo, store, sync } = harness()
    await sync()
    store.document('Errors').content = 'Error codes, rewritten in Bread.'
    repo.push({ 'reference/errors.md': null, 'custom_pages/terms.md': null })
    const result = await sync()

    expect(store.liveDocuments().map((document) => document.title)).not.toContain('Terms')
    // Its folder had nothing else in it.
    expect([...store.folders.values()].map((folder) => folder.displayName)).not.toContain('Custom Pages')
    // The edited page survives, flagged for a person to decide.
    expect(store.document('Errors').metadata).toMatchObject({
      github_hosted_sync: false,
      github_hosted_conflict: true,
      github_hosted_detached_reason: 'source_removed',
    })
    expect(result.removed).toBe(1)
    expect(store.source.conflict_count).toBe(1)
  })

  it('flags a conflict instead of overwriting when both sides changed a page', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    store.document('API keys').content = 'Edited in Bread.'
    repo.push({
      'docs/getting-started/authentication/api-keys.md': '---\ntitle: API keys\n---\nEdited on GitHub.\n',
    })
    await sync()
    expect(store.document('API keys').content).toBe('Edited in Bread.')
    expect(store.document('API keys').metadata?.github_hosted_conflict).toBe(true)
    expect(store.source.conflict_count).toBe(1)

    // Publishing leaves the conflicted page alone...
    expect(await inspect()).toMatchObject({ status: 'up_to_date', conflictCount: 1 })
    // ...until someone says Bread wins.
    await publish({ includeConflicts: true })
    expect(repo.file('docs/getting-started/authentication/api-keys.md')).toBe(
      '---\ntitle: API keys\n---\nEdited in Bread.\n',
    )
    expect(store.document('API keys').metadata?.github_hosted_conflict).toBe(false)
    expect(store.source.conflict_count).toBe(0)
  })

  it('lets GitHub win everywhere in replace mode', async () => {
    const { repo, store, sync } = harness()
    await sync()
    store.document('API keys').content = 'Edited in Bread.'
    repo.push({
      'docs/getting-started/authentication/api-keys.md': '---\ntitle: API keys\n---\nEdited on GitHub.\n',
    })
    await sync({ mode: 'replace_bread' })
    expect(store.document('API keys').content).toBe('Edited on GitHub.')
    expect(store.source.conflict_count).toBe(0)
  })

  it('skips unreadable pages without failing the sync or deleting their documents', async () => {
    const { repo, store, sync } = harness()
    await sync()
    repo.push({ 'reference/errors.md': '---\ntitle: [unclosed\n---\nBroken.\n' })
    const result = await sync()
    expect(store.source.sync_status).toBe('synced')
    expect(store.document('Errors').content).toBe('Error codes.')
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ path: 'reference/errors.md', reason: expect.stringMatching(/not valid YAML/) }),
    )
  })

  it('syncs a project that lives in a subdirectory', async () => {
    const files = Object.fromEntries(
      Object.entries(readmeRepositoryFiles()).map(([path, content]) => [`site/${path}`, content]),
    )
    const { store, sync } = harness({ ...files, 'docs/unrelated.md': '# elsewhere\n' }, { root: 'site' })
    await sync()
    expect(store.document('Quickstart').metadata?.canonical_repo_path).toBe(
      'site/docs/getting-started/quickstart.md',
    )
    expect(store.liveDocuments()).toHaveLength(6)
    expect(store.specs.get('payments')?.repoPath).toBe('site/reference/payments.yaml')
  })

  it('removes an API definition whose file was deleted on GitHub', async () => {
    const { repo, store, sync } = harness()
    await sync()
    repo.push({ 'reference/payments.yaml': null })
    await sync()
    expect(store.specs.has('payments')).toBe(false)
  })
})

describe('ReadMe-format GitHub sync: workspace -> repository', () => {
  it('has nothing to publish right after a sync', async () => {
    const { sync, inspect } = harness()
    await sync()
    expect(await inspect()).toMatchObject({ status: 'up_to_date', changedFileCount: 0 })
  })

  it('commits an edit straight to the branch, touching only that file', async () => {
    const { repo, store, sync, inspect, diff, publish } = harness()
    await sync()
    const before = repo.files()
    const quickstart = store.document('Quickstart')
    quickstart.title = 'Quick start'
    quickstart.content = 'Install the SDK, then take a payment.'

    expect(await inspect()).toMatchObject({ status: 'changes', changedFileCount: 1 })
    expect((await diff()).files).toEqual([
      expect.objectContaining({
        path: 'docs/getting-started/quickstart.md',
        status: 'modified',
        previous: QUICKSTART,
      }),
    ])

    const result = await publish()
    expect(result).toMatchObject({ mode: 'direct', branch: 'main', changedFileCount: 1 })
    expect(repo.lastMessage()).toBe('docs: update docs/getting-started/quickstart.md from Bread')

    const after = repo.files()
    const changed = Object.keys(after).filter((path) => after[path] !== before[path])
    expect(changed).toEqual(['docs/getting-started/quickstart.md'])
    const written = parseReadmeFile(after['docs/getting-started/quickstart.md']!)
    // Title is Bread's; every other frontmatter key is exactly as it was.
    expect(written.frontmatter).toEqual({
      title: 'Quick start',
      excerpt: 'Take your first payment.',
      hidden: false,
      metadata: { title: 'Quickstart | Breeze', robots: 'index' },
      next: { pages: [{ slug: 'api-keys', type: 'basic' }] },
    })
    expect(written.body).toBe('Install the SDK, then take a payment.\n')

    // The workspace is now in step with the new commit: nothing left to
    // publish, and the push webhook for our own commit reads no blobs.
    expect(store.source.last_sync_commit_sha).toBe(repo.head())
    expect(await inspect()).toMatchObject({ status: 'up_to_date' })
    await sync()
    expect(repo.blobReads).toEqual([])
    expect(store.snapshots).toEqual([])
  })

  it('writes new folders and pages in the ReadMe layout and links them', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    const folder = store.authorFolder('Going Live')
    folder.content = 'Checklist before launch.'
    store.authorDocument({ title: 'Go-live checklist', content: 'Rotate your keys.', folderId: folder.id })
    store.authorDocument({
      title: 'Refunds',
      content: 'How refunds work.',
      folderId: store.folder('docs/guides').id,
      status: 'Published',
      publicSlug: 'refunds-guide',
    })
    await publish()

    expect(repo.file('docs/going-live/index.md')).toBe(
      '---\ntitle: Going Live\nhidden: false\n---\nChecklist before launch.\n',
    )
    // A draft is a hidden page on GitHub.
    expect(repo.file('docs/going-live/go-live-checklist.md')).toBe(
      '---\ntitle: Go-live checklist\nhidden: true\n---\nRotate your keys.\n',
    )
    // The file is named after the page's URL slug.
    expect(repo.file('docs/guides/refunds-guide.md')).toBe(
      '---\ntitle: Refunds\nhidden: false\n---\nHow refunds work.\n',
    )
    expect(repo.lastMessage()).toMatch(/^docs: sync 3 files from Bread\n\n- docs\/going-live\/go-live-checklist\.md/)

    // A later push from GitHub must not import copies of what Bread wrote.
    const documents = store.liveDocuments().length
    const folders = store.folders.size
    repo.push({ 'README.md': '# changed\n' })
    await sync()
    expect(store.liveDocuments()).toHaveLength(documents)
    expect(store.folders.size).toBe(folders)
    expect(store.folder('Going Live').metadata?.path).toBe('docs/going-live')
  })

  it('never writes role-restricted Bread folders to GitHub', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    const internal = store.authorFolder('Internal runbooks')
    internal.restricted = true
    const nested = store.authorFolder('On-call', internal.id)
    nested.restricted = true
    store.authorDocument({ title: 'Incident playbook', content: 'Private.', folderId: nested.id })
    expect(await inspect()).toMatchObject({ status: 'up_to_date', changedFileCount: 0 })

    store.authorDocument({ title: 'Public note', content: 'Fine to share.', status: 'Published' })
    await publish()
    expect(Object.keys(repo.files()).filter((path) => /internal|on-call|incident/i.test(path))).toEqual([])
    expect(repo.file('docs/public-note.md')).toContain('Fine to share.')
  })

  it('publishes a reorder as _order.yaml and a move as a rename', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    store.document('Quickstart').sortOrder = 1
    store.folder('Authentication').sortOrder = 0
    const errors = store.document('Errors')
    errors.folderId = store.folder('docs/guides').id
    await publish()

    expect(parseOrderFile(repo.file('docs/getting-started/_order.yaml')!)).toEqual([
      'authentication', 'quickstart',
    ])
    expect(repo.file('reference/errors.md')).toBeUndefined()
    expect(repo.file('docs/guides/errors.md')).toBe('---\ntitle: Errors\n---\nError codes.\n')
    expect(store.document('Errors').metadata?.canonical_repo_path).toBe('docs/guides/errors.md')
  })

  it('does not bring back a page deleted in Bread, and publishes the deletion', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    store.deleteInBread('Terms')

    // An unrelated push arrives before the deletion was published.
    repo.push({ 'README.md': '# changed\n' })
    await sync()
    expect(store.liveDocuments().map((document) => document.title)).not.toContain('Terms')

    expect(await inspect()).toMatchObject({ status: 'changes', deletedFileCount: 1 })
    await publish()
    expect(repo.file('custom_pages/terms.md')).toBeUndefined()

    // If the file later comes back on GitHub, that is a new page again.
    repo.push({ 'custom_pages/terms.md': '---\ntitle: Terms\nfullscreen: false\n---\nThe terms.\n' })
    await sync()
    expect(store.liveDocuments().map((document) => document.title)).toContain('Terms')
  })

  it('treats a page whose document is gone entirely as deleted in Bread', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    // Trashed, then the trash was emptied: no document row is left at all.
    store.documents.delete(store.document('Terms').id)
    repo.push({ 'README.md': '# changed\n' })
    await sync()
    expect(store.liveDocuments().map((document) => document.title)).not.toContain('Terms')
    await publish()
    expect(repo.file('custom_pages/terms.md')).toBeUndefined()
  })

  it('imports a trashed page again when GitHub changed it afterwards', async () => {
    const { repo, store, sync } = harness()
    await sync()
    store.deleteInBread('Terms')
    repo.push({ 'custom_pages/terms.md': '---\ntitle: Terms\n---\nNew terms.\n' })
    await sync()
    expect(store.document('Terms').content).toBe('New terms.')
  })

  it('"Use GitHub" restores everything the repository has', async () => {
    const { store, sync } = harness()
    await sync()
    store.deleteInBread('Terms')
    store.document('Errors').content = 'Unpublished edit.'
    await sync({ mode: 'replace_bread' })
    expect(store.document('Terms').content).toBe('The terms.')
    expect(store.document('Errors').content).toBe('Error codes.')
  })

  it('refuses to publish over GitHub changes that were not pulled yet', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    store.document('Quickstart').content = 'Edited in Bread.'
    repo.push({ 'README.md': '# changed\n' })
    expect(await inspect()).toMatchObject({ status: 'sync_required', code: 'github_sync_required' })
    await expect(publish()).rejects.toMatchObject({ code: 'github_sync_required', status: 409 })
  })

  it('publishes only the selected files and keeps the rest pending', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    store.document('Quickstart').content = 'One.'
    store.document('Errors').content = 'Two.'
    await publish({ selectedPaths: ['reference/errors.md'] })
    expect(repo.file('reference/errors.md')).toContain('Two.')
    expect(repo.file('docs/getting-started/quickstart.md')).toBe(QUICKSTART)
    expect(await inspect()).toMatchObject({ status: 'changes', changedFileCount: 1 })
    await expect(publish({ selectedPaths: ['reference/errors.md'] })).rejects.toMatchObject({
      code: 'selected_paths_changed',
    })
  })

  it('explains a protected branch instead of failing obscurely', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    store.document('Quickstart').content = 'Edited in Bread.'
    repo.protectedBranch = 'main'
    const error = await publish().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReadmePublishError)
    expect(error).toMatchObject({ code: 'branch_protected', status: 409 })
    expect((error as Error).message).toMatch(/switch publishing to pull requests/)
  })

  it('reports no_changes when there is nothing to publish', async () => {
    const { sync, publish } = harness()
    await sync()
    await expect(publish()).rejects.toMatchObject({ code: 'no_changes' })
  })
})

describe('ReadMe-format GitHub sync: pull request mode', () => {
  it('collects changes on a branch and links new pages when the PR merges', async () => {
    const { repo, store, sync, inspect, publish } = harness(undefined, { publishMode: 'pull_request' })
    await sync()
    store.document('Quickstart').content = 'Edited in Bread.'
    store.authorDocument({ title: 'Disputes', content: 'How disputes work.', status: 'Published' })

    const first = await publish()
    expect(first).toMatchObject({ mode: 'pull_request', pullRequestNumber: 1, changedFileCount: 2 })
    expect(first.branch).toMatch(/^bread\/readme-sync-/)
    // The synced branch is untouched until the pull request merges.
    expect(repo.file('docs/getting-started/quickstart.md')).toBe(QUICKSTART)
    expect(repo.file('docs/disputes.md', first.branch)).toBe(
      '---\ntitle: Disputes\nhidden: false\n---\nHow disputes work.\n',
    )
    expect(store.source).toMatchObject({ publish_pull_request_number: 1, publish_pull_request_head: first.branch })
    expect(await inspect()).toMatchObject({ status: 'up_to_date', pullRequestUpToDate: true })

    // A further edit extends the same pull request.
    store.document('Disputes').content = 'How disputes really work.'
    const second = await publish()
    expect(second).toMatchObject({ pullRequestNumber: 1, branch: first.branch, changedFileCount: 1 })
    expect(repo.pullRequests).toHaveLength(1)

    const documents = store.liveDocuments().length
    repo.merge(1)
    await sync()
    expect(store.liveDocuments()).toHaveLength(documents)
    expect(store.document('Disputes').metadata).toMatchObject({
      canonical_repo_path: 'docs/disputes.md',
      github_hosted_sync: true,
      github_hosted_pending_path: null,
    })
    expect(store.snapshots).toEqual([])
  })
})

describe('ReadMe-format GitHub sync: OpenAPI definitions', () => {
  const UPLOADED = `${JSON.stringify({ openapi: '3.1.0', info: { title: 'Payouts' }, paths: { '/payouts': { get: {} } } }, null, 2)}\n`

  it('writes an uploaded definition to reference/ as soon as it is uploaded', async () => {
    const { repo, store, sync, commitSpec } = harness()
    await sync()
    // What PUT /api/v1/openapi/payouts leaves behind: a source with no file.
    store.specs.set('payouts', { slug: 'payouts', title: 'Payouts', specRaw: UPLOADED, repoPath: null, repoBlobSha: null, operationCount: 1 })

    const outcome = await commitSpec({ slug: 'payouts', raw: UPLOADED, repoPath: null })
    expect(outcome).toMatchObject({ committed: true, path: 'reference/payouts.json' })
    expect(repo.file('reference/payouts.json')).toBe(UPLOADED)
    expect(repo.lastMessage()).toBe('docs: update OpenAPI definition payouts')
    expect(store.specs.get('payouts')?.repoPath).toBe('reference/payouts.json')

    // Our own commit coming back through the webhook changes nothing.
    await sync()
    expect(repo.blobReads).toEqual([])
    // Uploading the same definition again does not create an empty commit.
    const head = repo.head()
    expect(await commitSpec({ slug: 'payouts', raw: UPLOADED, repoPath: 'reference/payouts.json' })).toMatchObject({ committed: false })
    expect(repo.head()).toBe(head)
  })

  it('keeps a YAML file YAML when the upload is JSON', async () => {
    const { repo, store, sync, commitSpec } = harness()
    await sync()
    const raw = JSON.stringify({ openapi: '3.0.3', info: { title: 'Payments API', version: '2.0.0' }, paths: {} })
    store.specs.get('payments')!.specRaw = raw
    await commitSpec({ slug: 'payments', raw, repoPath: 'reference/payments.yaml' })
    expect(repo.file('reference/payments.yaml')).toBe(
      'openapi: 3.0.3\ninfo:\n  title: Payments API\n  version: 2.0.0\npaths: {}\n',
    )
  })

  it('picks up a definition changed on GitHub and removes one deleted in Bread', async () => {
    const { repo, store, sync, commitSpec } = harness()
    await sync()
    repo.push({ 'reference/payments.yaml': PETSTORE_YAML.replace('1.0.0', '1.1.0') })
    const result = await sync()
    expect(store.specs.get('payments')?.specRaw).toContain('1.1.0')
    expect(result.updated).toBe(1)

    // DELETE /api/v1/openapi/payments, then the file follows.
    const repoPath = store.specs.get('payments')!.repoPath
    store.specs.delete('payments')
    expect(await commitSpec({ slug: 'payments', raw: null, repoPath })).toMatchObject({ committed: true })
    expect(repo.file('reference/payments.yaml')).toBeUndefined()
    await sync()
    expect(store.specs.has('payments')).toBe(false)
  })

  it('includes definitions in a normal publish when commits go through pull requests', async () => {
    const { repo, store, sync, publish, commitSpec } = harness(undefined, { publishMode: 'pull_request' })
    await sync()
    store.specs.set('payouts', { slug: 'payouts', title: 'Payouts', specRaw: UPLOADED, repoPath: null, repoBlobSha: null, operationCount: 1 })
    // No direct commit in pull request mode.
    expect(await commitSpec({ slug: 'payouts', raw: UPLOADED, repoPath: null })).toMatchObject({ committed: false })
    const result = await publish()
    expect(repo.file('reference/payouts.json', result.branch)).toBe(UPLOADED)
  })
})
