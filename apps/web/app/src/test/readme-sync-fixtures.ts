import { createHash } from 'node:crypto'
import { GitHubApiError } from '@/lib/github/retry'
import { gitBlobSha } from '@/lib/github/readme/readme-export'
import type { ReadmePublishDeps } from '@/lib/github/readme/readme-publish'
import type {
  ReadmeStore,
  ReadmeStoreDocument,
  ReadmeStoreFolder,
  ReadmeStoreSpec,
} from '@/lib/github/readme/readme-store'
import { isOpenApiDocument, parseSpecDocument } from '@/lib/github/readme/readme-sync'

/**
 * In-memory stand-ins for GitHub and the workspace database, used to exercise
 * the ReadMe-format sync end to end without a network or a database.
 */

function sha(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

interface FakeCommit {
  sha: string
  treeSha: string
  files: Map<string, string>
  message: string
}

export class FakeRepository {
  readonly fullName: string
  readonly id: number
  defaultBranch = 'main'
  /** Set to make pushes to that branch fail the way a protected branch does. */
  protectedBranch: string | null = null
  readonly branches = new Map<string, string>()
  readonly pullRequests: Array<{
    number: number
    head: string
    base: string
    state: 'open' | 'closed'
    merged: boolean
  }> = []
  blobReads: string[] = []
  private readonly commits = new Map<string, FakeCommit>()
  private readonly trees = new Map<string, Map<string, string>>()
  private readonly blobs = new Map<string, { content: string; path: string }>()
  private counter = 0

  constructor(files: Record<string, string> = {}, options: { id?: number; fullName?: string } = {}) {
    this.id = options.id ?? 42
    this.fullName = options.fullName ?? 'breeze/docs'
    this.branches.set('main', this.write(new Map(Object.entries(files)), 'initial commit'))
  }

  private write(files: Map<string, string>, message: string): string {
    const listing = [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => `${path}\0${gitBlobSha(content)}`)
      .join('\n')
    const treeSha = sha(`tree\n${listing}`)
    const commitSha = sha(`commit ${this.counter++}\n${treeSha}\n${message}`)
    this.trees.set(treeSha, new Map(files))
    for (const [path, content] of files) this.blobs.set(gitBlobSha(content), { content, path })
    this.commits.set(commitSha, { sha: commitSha, treeSha, files: new Map(files), message })
    return commitSha
  }

  head(branch = this.defaultBranch): string {
    return this.branches.get(branch)!
  }

  files(branch = this.defaultBranch): Record<string, string> {
    return Object.fromEntries(this.commits.get(this.head(branch))!.files)
  }

  file(path: string, branch = this.defaultBranch): string | undefined {
    return this.commits.get(this.head(branch))!.files.get(path)
  }

  lastMessage(branch = this.defaultBranch): string {
    return this.commits.get(this.head(branch))!.message
  }

  /** A push made on GitHub. `null` deletes a file. */
  push(changes: Record<string, string | null>, branch = this.defaultBranch): string {
    const files = new Map(this.commits.get(this.head(branch))!.files)
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path)
      else files.set(path, content)
    }
    const commitSha = this.write(files, 'push from GitHub')
    this.branches.set(branch, commitSha)
    return commitSha
  }

  /** Merge an open pull request by fast-forwarding its base branch. */
  merge(pullRequestNumber: number): string {
    const pullRequest = this.pullRequests.find((entry) => entry.number === pullRequestNumber)!
    pullRequest.state = 'closed'
    pullRequest.merged = true
    this.branches.set(pullRequest.base, this.head(pullRequest.head))
    return this.head(pullRequest.base)
  }

  private resolve(ref: string): FakeCommit {
    const commit = this.commits.get(this.branches.get(ref) ?? ref)
    if (!commit) throw new GitHubApiError(`No commit found for ${ref}`, 404)
    return commit
  }

  github(): Required<Omit<ReadmePublishDeps, 'store' | 'toMarkdown' | 'now'>> {
    return {
      retry: (operation) => operation(),
      getToken: async () => 'token',
      getRepo: async () => ({
        id: this.id,
        full_name: this.fullName,
        default_branch: this.defaultBranch,
        private: true,
      }),
      getCommit: async (_token, _repo, ref) => {
        const commit = this.resolve(ref)
        return { sha: commit.sha, commit: { tree: { sha: commit.treeSha } } }
      },
      getTree: async (_token, _repo, treeSha) => {
        const files = this.trees.get(treeSha)!
        const directories = new Set<string>()
        for (const path of files.keys()) {
          const segments = path.split('/')
          for (let depth = 1; depth < segments.length; depth++) {
            directories.add(segments.slice(0, depth).join('/'))
          }
        }
        return {
          sha: treeSha,
          truncated: false,
          tree: [
            ...[...directories].map((path) => ({
              path,
              mode: '040000',
              type: 'tree' as const,
              sha: sha(`dir ${path}`),
              url: '',
            })),
            ...[...files].map(([path, content]) => ({
              path,
              mode: '100644',
              type: 'blob' as const,
              sha: gitBlobSha(content),
              size: Buffer.byteLength(content, 'utf8'),
              url: '',
            })),
          ],
        }
      },
      getBlob: async (_token, _repo, blobSha) => {
        const blob = this.blobs.get(blobSha)!
        this.blobReads.push(blob.path)
        return {
          sha: blobSha,
          size: Buffer.byteLength(blob.content, 'utf8'),
          encoding: 'base64',
          content: Buffer.from(blob.content, 'utf8').toString('base64'),
        }
      },
      getBranchReference: async (_token, _repo, branch) => {
        const commitSha = this.branches.get(branch)
        return commitSha
          ? { ref: `refs/heads/${branch}`, object: { type: 'commit' as const, sha: commitSha } }
          : null
      },
      createBranch: async (_token, _repo, branch, commitSha) => {
        if (!this.branches.has(branch)) this.branches.set(branch, commitSha)
        return {
          ref: `refs/heads/${branch}`,
          object: { type: 'commit' as const, sha: this.branches.get(branch)! },
        }
      },
      createFilesCommit: async (_token, _repo, args) => {
        if (this.protectedBranch === args.branch) {
          throw new GitHubApiError(
            'GitHub API responded 422: Repository rule violations found. Changes must be made through a pull request.',
            422,
          )
        }
        if (this.branches.get(args.branch) !== args.baseCommitSha) {
          throw new GitHubApiError('GitHub API responded 422: Update is not a fast forward', 422)
        }
        const files = new Map(this.commits.get(args.baseCommitSha)!.files)
        for (const path of args.deletePaths ?? []) files.delete(path)
        for (const file of args.files) files.set(file.path, file.content)
        const commitSha = this.write(files, args.message)
        this.branches.set(args.branch, commitSha)
        return { sha: commitSha, html_url: `https://github.test/${this.fullName}/commit/${commitSha}` }
      },
      createPullRequest: async (_token, _repo, args) => {
        const number = this.pullRequests.length + 1
        this.pullRequests.push({
          number,
          head: args.head,
          base: args.base,
          state: 'open',
          merged: false,
        })
        return {
          number,
          html_url: `https://github.test/${this.fullName}/pull/${number}`,
          state: 'open' as const,
          title: args.title,
        }
      },
      findOpenPullRequest: async (_token, _repo, args) => {
        const found = this.pullRequests.find(
          (entry) => entry.state === 'open' && entry.head === args.head && entry.base === args.base,
        )
        return found
          ? {
              number: found.number,
              html_url: `https://github.test/${this.fullName}/pull/${found.number}`,
              state: 'open' as const,
              title: 'docs: sync from Bread',
            }
          : null
      },
    }
  }
}

interface StoredDocument extends ReadmeStoreDocument {
  deleted: boolean
}

export class MemoryReadmeStore implements ReadmeStore {
  readonly documents = new Map<string, StoredDocument>()
  readonly folders = new Map<string, ReadmeStoreFolder>()
  readonly specs = new Map<string, ReadmeStoreSpec>()
  /** Document versions snapshotted when GitHub content replaced Bread's. */
  readonly snapshots: Array<{ id: string; title: string; content: string }> = []
  readonly indexed: string[] = []
  source: Record<string, unknown> = {}
  private nextId = 1

  constructor(private readonly repoId = 42) {}

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`
  }

  // --- Things a person does in the Bread editor ------------------------------
  document(match: string): StoredDocument {
    const found = [...this.documents.values()].find(
      (document) =>
        !document.deleted &&
        (document.id === match ||
          document.title === match ||
          document.metadata?.canonical_repo_path === match),
    )
    if (!found) throw new Error(`No document matches ${match}`)
    return found
  }

  folder(match: string): ReadmeStoreFolder {
    const found = [...this.folders.values()].find(
      (folder) =>
        folder.id === match || folder.displayName === match || folder.metadata?.path === match,
    )
    if (!found) throw new Error(`No folder matches ${match}`)
    return found
  }

  liveDocuments(): StoredDocument[] {
    return [...this.documents.values()].filter((document) => !document.deleted)
  }

  authorDocument(input: {
    title: string
    content: string
    folderId?: string | null
    status?: string
    sortOrder?: number | null
    publicSlug?: string | null
  }): StoredDocument {
    const document: StoredDocument = {
      id: this.id('doc'),
      title: input.title,
      content: input.content,
      status: input.status ?? 'Draft',
      folderId: input.folderId ?? null,
      sortOrder: input.sortOrder ?? null,
      publicSlug: input.publicSlug ?? null,
      metadata: {},
      updatedAt: null,
      deleted: false,
    }
    this.documents.set(document.id, document)
    return document
  }

  authorFolder(displayName: string, parentId: string | null = null): ReadmeStoreFolder {
    const folder: ReadmeStoreFolder = {
      id: this.id('folder'),
      name: `user-${displayName}`,
      displayName,
      parentId,
      sortOrder: null,
      content: null,
      metadata: {},
      restricted: false,
    }
    this.folders.set(folder.id, folder)
    return folder
  }

  /** Delete in the editor: a soft delete that keeps the repository link. */
  deleteInBread(match: string): void {
    this.document(match).deleted = true
  }

  // --- ReadmeStore -----------------------------------------------------------
  async listFolders(): Promise<ReadmeStoreFolder[]> {
    return [...this.folders.values()].map((folder) => ({ ...folder }))
  }

  async listDocuments(): Promise<ReadmeStoreDocument[]> {
    return this.liveDocuments().map(({ deleted: _deleted, ...document }) => ({ ...document }))
  }

  async listPublicSlugs(): Promise<string[]> {
    return [...this.documents.values()].flatMap((document) =>
      document.publicSlug ? [document.publicSlug] : [],
    )
  }

  async listDeletedLinks(): Promise<Array<{ path: string; blobSha: string | null }>> {
    return [...this.documents.values()].flatMap((document) => {
      const metadata = document.metadata
      if (
        !document.deleted ||
        metadata?.github_hosted_sync !== true ||
        metadata.repo_format !== 'readme' ||
        metadata.repo_id !== this.repoId ||
        typeof metadata.canonical_repo_path !== 'string'
      ) {
        return []
      }
      return [{
        path: metadata.canonical_repo_path,
        blobSha: (metadata.github_hosted_checkpoint_blob_sha as string | undefined) ?? null,
      }]
    })
  }

  async clearDeletedLinks(paths: string[]): Promise<void> {
    for (const document of this.documents.values()) {
      if (document.deleted && paths.includes(document.metadata?.canonical_repo_path as string)) {
        document.metadata = { ...document.metadata, github_hosted_sync: false }
      }
    }
  }

  async createFolder(input: Parameters<ReadmeStore['createFolder']>[0]): Promise<string> {
    const existing = [...this.folders.values()].find((folder) => folder.name === input.name)
    const id = existing?.id ?? this.id('folder')
    this.folders.set(id, {
      id,
      name: input.name,
      displayName: input.displayName,
      parentId: input.parentId,
      sortOrder: input.sortOrder,
      content: input.content,
      metadata: input.metadata,
      restricted: existing?.restricted ?? false,
    })
    return id
  }

  async updateFolder(id: string, patch: Parameters<ReadmeStore['updateFolder']>[1]): Promise<void> {
    Object.assign(this.folders.get(id)!, patch)
  }

  async deleteFolder(id: string): Promise<void> {
    this.folders.delete(id)
  }

  async insertDocument(input: Parameters<ReadmeStore['insertDocument']>[0]): Promise<string> {
    if ([...this.documents.values()].some((document) => document.publicSlug === input.publicSlug)) {
      throw new Error(`duplicate public slug ${input.publicSlug}`)
    }
    const id = this.id('doc')
    this.documents.set(id, { id, ...input, updatedAt: null, deleted: false })
    return id
  }

  async updateDocument(
    id: string,
    patch: Parameters<ReadmeStore['updateDocument']>[1],
  ): Promise<void> {
    Object.assign(this.documents.get(id)!, patch)
  }

  async applyDocumentContent(
    input: Parameters<ReadmeStore['applyDocumentContent']>[0],
  ): Promise<void> {
    const document = this.documents.get(input.id)!
    if (document.title !== input.expectedTitle || document.content !== input.expectedContent) {
      throw new Error('The Bread document changed while GitHub content was being applied.')
    }
    this.snapshots.push({ id: document.id, title: document.title, content: document.content })
    document.title = input.title
    document.content = input.content
    document.metadata = { ...document.metadata, ...input.metadataPatch }
    // Faithful to apply_github_hosted_document_update, which publishes.
    document.status = 'Published'
  }

  async softDeleteDocuments(ids: string[]): Promise<void> {
    for (const id of ids) this.documents.get(id)!.deleted = true
  }

  async refreshIndex(id: string): Promise<void> {
    this.indexed.push(id)
  }

  async listSpecs(): Promise<ReadmeStoreSpec[]> {
    return [...this.specs.values()].map((spec) => ({ ...spec }))
  }

  async syncSpec(input: Parameters<ReadmeStore['syncSpec']>[0]) {
    const parsed = parseSpecDocument(input.raw)
    if (!isOpenApiDocument(parsed) || typeof parsed?.paths !== 'object' || parsed.paths === null) {
      return {
        ok: false,
        issue: 'must contain a `paths` object',
        operationCount: 0,
        created: 0,
        updated: 0,
        removed: 0,
      }
    }
    const operationCount = Object.values(parsed.paths as Record<string, object>).reduce(
      (total, item) => total + Object.keys(item ?? {}).length,
      0,
    )
    const existed = this.specs.has(input.slug)
    this.specs.set(input.slug, {
      slug: input.slug,
      title: String((parsed.info as { title?: unknown } | undefined)?.title ?? input.slug),
      specRaw: input.raw,
      repoPath: input.repoPath,
      repoBlobSha: input.repoBlobSha,
      operationCount,
    })
    return {
      ok: true,
      operationCount,
      created: existed ? 0 : operationCount,
      updated: existed ? operationCount : 0,
      removed: 0,
    }
  }

  async setSpecRepository(
    slug: string,
    repository: { repoPath: string | null; repoBlobSha: string | null },
  ): Promise<void> {
    Object.assign(this.specs.get(slug)!, repository)
  }

  async removeSpec(slug: string): Promise<{ removed: number }> {
    const removed = this.specs.get(slug)?.operationCount ?? 0
    this.specs.delete(slug)
    return { removed }
  }

  async updateSource(patch: Record<string, unknown>): Promise<void> {
    Object.assign(this.source, patch)
  }
}
