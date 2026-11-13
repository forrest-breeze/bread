/**
 * Everything the ReadMe-format sync needs from the workspace database.
 *
 * The sync and publish logic is written against this interface so it can be
 * exercised with an in-memory store; `readme-store-supabase.ts` is the real
 * implementation.
 */

export interface ReadmeStoreDocument {
  id: string
  title: string
  content: string
  status: string | null
  folderId: string | null
  sortOrder: number | null
  publicSlug: string | null
  metadata: Record<string, unknown> | null
  updatedAt: string | null
}

export interface ReadmeStoreFolder {
  id: string
  name: string
  displayName: string
  parentId: string | null
  sortOrder: number | null
  content: string | null
  metadata: Record<string, unknown> | null
  /**
   * True when the folder, or a folder above it, is limited to some workspace
   * roles. Such content is never written to GitHub unless it came from there.
   */
  restricted: boolean
}

export interface ReadmeStoreSpec {
  slug: string
  /** `info.title` of the definition. */
  title: string
  specRaw: string | null
  repoPath: string | null
  repoBlobSha: string | null
  operationCount: number
}

export interface ReadmeStoreSpecSyncResult {
  ok: boolean
  /** First validation problem, when the spec was rejected. */
  issue?: string
  operationCount: number
  created: number
  updated: number
  removed: number
}

export interface ReadmeStore {
  /** User folders of the workspace, excluding generated OpenAPI folders. */
  listFolders(): Promise<ReadmeStoreFolder[]>
  /** Live authored documents, excluding generated and repository-mirror rows. */
  listDocuments(): Promise<ReadmeStoreDocument[]>
  /** Every public slug in use, including soft-deleted documents. */
  listPublicSlugs(): Promise<string[]>
  /**
   * Repository links of documents that were deleted in Breezify while still
   * linked: deletions that have not been published to GitHub yet.
   */
  listDeletedLinks(): Promise<Array<{ path: string; blobSha: string | null }>>
  /** Forget those links once the files are gone from the repository. */
  clearDeletedLinks(paths: string[]): Promise<void>

  createFolder(input: {
    name: string
    displayName: string
    parentId: string | null
    sortOrder: number | null
    content: string | null
    metadata: Record<string, unknown>
  }): Promise<string>
  updateFolder(
    id: string,
    patch: Partial<{
      displayName: string
      parentId: string | null
      sortOrder: number | null
      content: string | null
      metadata: Record<string, unknown>
    }>,
  ): Promise<void>
  deleteFolder(id: string): Promise<void>

  insertDocument(input: {
    title: string
    content: string
    status: string
    folderId: string | null
    sortOrder: number | null
    publicSlug: string
    metadata: Record<string, unknown>
  }): Promise<string>
  /** Plain field update; never changes title or content. */
  updateDocument(
    id: string,
    patch: Partial<{
      status: string
      folderId: string | null
      sortOrder: number | null
      metadata: Record<string, unknown>
    }>,
  ): Promise<void>
  /**
   * Replace title and content with the repository version, snapshotting the
   * previous head as a document version. Fails if the document changed since
   * it was read. The underlying database function also sets the status to
   * Published, so callers set the status they want afterwards.
   */
  applyDocumentContent(input: {
    id: string
    expectedTitle: string
    expectedContent: string
    title: string
    content: string
    metadataPatch: Record<string, unknown>
  }): Promise<void>
  softDeleteDocuments(ids: string[]): Promise<void>
  /** Refresh search chunks for a document whose content changed. */
  refreshIndex(id: string, content: string): Promise<void>

  listSpecs(): Promise<ReadmeStoreSpec[]>
  syncSpec(input: {
    slug: string
    raw: string
    repoPath: string
    repoBlobSha: string
    syncedBy: string
  }): Promise<ReadmeStoreSpecSyncResult>
  setSpecRepository(
    slug: string,
    repository: { repoPath: string | null; repoBlobSha: string | null },
  ): Promise<void>
  removeSpec(slug: string): Promise<{ removed: number }>

  updateSource(patch: Record<string, unknown>): Promise<void>
}
