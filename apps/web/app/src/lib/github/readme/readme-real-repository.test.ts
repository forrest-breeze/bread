import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeRepository, MemoryReadmeStore } from '@/test/readme-sync-fixtures'
import { parseHostedOpenApiSpec } from '../github-hosted-openapi'
import { inspectReadmePublish, publishReadmeWorkspace } from './readme-publish'
import { syncReadmeRepository } from './readme-sync'

/**
 * Optional check against a real checkout of a repository that ReadMe's GitHub
 * integration has been writing to. Skipped unless a path is given:
 *
 *   README_SYNC_FIXTURE_DIR=/path/to/checkout npx vitest run \
 *     src/lib/github/readme/readme-real-repository.test.ts
 *
 * It asserts the property that matters most for a drop-in replacement: after
 * importing the repository, Bread wants to change nothing in it.
 */
const fixtureDirectory = process.env.README_SYNC_FIXTURE_DIR

function readTextFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === '.git' || name === 'node_modules') continue
      const path = join(directory, name)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(?:md|mdx|ya?ml|json)$/i.test(name)) continue
      files[relative(root, path).split('\\').join('/')] = readFileSync(path, 'utf8')
    }
  }
  walk(root)
  return files
}

describe.skipIf(!fixtureDirectory)('ReadMe-format sync against a real repository', () => {
  it('imports the repository and then has nothing to change in it', async () => {
    const files = readTextFiles(fixtureDirectory!)
    const repo = new FakeRepository(files)
    const store = new MemoryReadmeStore(repo.id)
    const deps = {
      store,
      toMarkdown: (content: string | null | undefined): string => content ?? '',
      ...repo.github(),
    }
    const target = {
      installationId: 1,
      repoId: repo.id,
      repoFullName: repo.fullName,
      root: '',
      branch: null,
    }
    const result = await syncReadmeRepository(
      { ...target, lastSyncCommitSha: null, syncState: null, mode: 'merge' },
      deps,
    )
    const publishSource = () => ({
      ...target,
      lastSyncCommitSha: store.source.last_sync_commit_sha as string,
      syncState: store.source.sync_state,
      publishMode: 'direct' as const,
      publishPullRequestNumber: null,
      publishPullRequestHead: null,
    })

    const loud = result.skipped.filter((entry) => !entry.quiet)
    const quietReasons = new Map<string, number>()
    for (const entry of result.skipped.filter((item) => item.quiet)) {
      quietReasons.set(entry.reason, (quietReasons.get(entry.reason) ?? 0) + 1)
    }
    console.info(
      JSON.stringify(
        {
          pagesInRepository: Object.keys(files).filter((path) => /^(docs|reference)\/.*\.mdx?$/.test(path)).length,
          documents: store.liveDocuments().length,
          folders: store.folders.size,
          specs: [...store.specs.values()].map((spec) => `${spec.slug} <- ${spec.repoPath}`),
          skippedQuietly: Object.fromEntries(quietReasons),
          skippedWithProblems: loud,
          topLevelFolders: [...store.folders.values()]
            .filter((folder) => folder.parentId === null)
            .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99))
            .map((folder) => `${folder.sortOrder ?? '-'} ${folder.displayName}`),
        },
        null,
        2,
      ),
    )

    expect(loud).toEqual([])
    expect(store.liveDocuments().length).toBeGreaterThan(0)
    // Slugs must be unique, and titles present.
    const slugs = store.liveDocuments().map((document) => document.publicSlug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(store.liveDocuments().filter((document) => !document.title.trim())).toEqual([])

    // The drop-in property: nothing to write, nothing to delete.
    const inspection = await inspectReadmePublish(publishSource(), deps)
    expect(inspection).toMatchObject({
      status: 'up_to_date',
      writtenFileCount: 0,
      deletedFileCount: 0,
    })

    // Editing one page touches exactly that one file.
    const before = repo.files()
    const edited = store.liveDocuments()[0]!
    edited.content = `${edited.content}\n\nEdited in Bread.`
    await publishReadmeWorkspace(publishSource(), deps)
    const after = repo.files()
    const changed = Object.keys({ ...before, ...after }).filter((path) => before[path] !== after[path])
    expect(changed).toEqual([edited.metadata?.canonical_repo_path])

    // And a second sync of the unchanged repository reads no blobs.
    repo.blobReads = []
    await syncReadmeRepository(
      {
        ...target,
        lastSyncCommitSha: null,
        syncState: store.source.sync_state,
        mode: 'merge',
      },
      deps,
    )
    expect(repo.blobReads).toEqual([])
  })

  it('renders every OpenAPI definition in reference/ with the existing generator', () => {
    const files = readTextFiles(fixtureDirectory!)
    const specs = Object.entries(files).filter(
      ([path, raw]) => /^reference\/[^/]+\.(?:json|ya?ml)$/.test(path) && /openapi|swagger/.test(raw.slice(0, 2000)),
    )
    for (const [path, raw] of specs) {
      const { spec, issues } = parseHostedOpenApiSpec({
        specPath: path,
        raw,
        repoId: 0,
        slugPrefix: 'openapi',
      })
      console.info(`${path}: ${spec?.operations.length ?? 0} operations`, issues)
      expect(issues).toEqual([])
    }
  })
})
