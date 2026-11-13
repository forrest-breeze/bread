import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildGitHubBootstrapFiles,
  restrictedBootstrapFolderNames,
  validBootstrapDocumentPath,
  type BootstrapDocument,
  type BootstrapFolder,
  type GitHubBootstrapFile,
} from './github-hosted-bootstrap'
import { portalDocumentToMarkdown } from '@/lib/portal/portal-doc-markdown'
import { readPublishedDate } from '@/lib/documents/published-date'
import { OPENAPI_OPERATION_KIND } from './github-hosted-openapi'

export const MAX_HOSTED_WORKSPACE_DOCUMENTS = 500
export const MAX_HOSTED_WORKSPACE_BYTES = 8 * 1024 * 1024

const WORKSPACE_ROOT_ID = 'workspace-root'

function hostedContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

interface FolderRow {
  id: string
  display_name: string
  parent_folder_id: string | null
  kind: string
  content: string | null
  visibility: string
  required_role: string | null
}

interface DocumentRow {
  id: string
  title: string
  content: string
  source: string
  source_metadata: Record<string, unknown> | null
  public_slug: string | null
  folder_id: string | null
  /** Emitted as the `date:` frontmatter line; dated feeds order by it. */
  updated_at: string | null
}

interface RepositoryCompanionRow {
  content: string
  source_metadata: Record<string, unknown> | null
}

export interface BreezifyWorkspaceExport {
  files: GitHubBootstrapFile[]
  documents: DocumentRow[]
  /** Existing repository paths Breezify may safely update/delete. */
  managedPaths: string[]
  restrictedFolderNames: string[]
  totalBytes: number
}

/** Build one deterministic repository tree for the complete authored workspace. */
export async function buildBreezifyWorkspaceExport(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    targetPath: string
    repoId?: number
    hostedRootFolderId?: string | null
  },
): Promise<BreezifyWorkspaceExport> {
  // These reads are independent. Starting them together removes two database
  // round trips from every status check, diff preview, and commit.
  const folderQuery = admin
    .from('folders')
    .select('id, display_name, parent_folder_id, kind, content, visibility, required_role')
    .eq('workspace_id', input.workspaceId)
  const documentQuery = admin
    .from('documents')
    .select('id, title, content, source, source_metadata, public_slug, folder_id, updated_at')
    .eq('workspace_id', input.workspaceId)
    .is('deleted_at', null)
    .in('document_type', ['source', 'page'])
  const companionQuery = input.repoId
    ? admin
        .from('documents')
        .select('content, source_metadata')
        .eq('workspace_id', input.workspaceId)
        .eq('source', 'GitHub')
        .contains('source_metadata', {
          kind: 'repository_file',
          repo_id: input.repoId,
        })
        .is('deleted_at', null)
    : Promise.resolve({ data: [], error: null })
  const [folderResult, documentResult, companionResult] = await Promise.all([
    folderQuery,
    documentQuery,
    companionQuery,
  ])
  const { data: folderRows, error: folderError } = folderResult
  if (folderError) throw new Error(`workspace folder export: ${folderError.message}`)
  const { data: documentRows, error: documentError } = documentResult
  if (documentError) {
    throw new Error(`workspace document export: ${documentError.message}`)
  }
  const { data: companionRows, error: companionError } = companionResult
  if (companionError) {
    throw new Error(`workspace repository companion export: ${companionError.message}`)
  }

  const folders = (folderRows ?? []) as FolderRow[]
  const userFolders = folders.filter((folder) => folder.kind === 'user')
  const userFolderIds = new Set(userFolders.map((folder) => folder.id))
  if (
    input.hostedRootFolderId &&
    !userFolderIds.has(input.hostedRootFolderId)
  ) {
    throw new Error('The linked Breezify folder is unavailable.')
  }
  const folderById = new Map(userFolders.map((folder) => [folder.id, folder]))
  const isInsideHostedRoot = (folderId: string | null): boolean => {
    if (!folderId || !input.hostedRootFolderId) return false
    let cursor: string | null = folderId
    let guard = 0
    while (cursor && guard < 64) {
      if (cursor === input.hostedRootFolderId) return true
      cursor = folderById.get(cursor)?.parent_folder_id ?? null
      guard += 1
    }
    return false
  }
  const contentByFolderId = new Map(
    userFolders.map((folder) => [folder.id, folder.content]),
  )
  const bootstrapFolders: BootstrapFolder[] = [
    {
      id: WORKSPACE_ROOT_ID,
      displayName: 'Breezify workspace',
      parentFolderId: null,
      visibility: 'workspace',
      requiredRole: null,
    },
    ...userFolders.map((folder) => ({
      id: folder.id,
      displayName: folder.display_name,
      parentFolderId:
        folder.parent_folder_id && userFolderIds.has(folder.parent_folder_id)
          ? folder.parent_folder_id
          : WORKSPACE_ROOT_ID,
      contentMarkdown: portalDocumentToMarkdown(
        contentByFolderId.get(folder.id) ?? null,
      ),
      visibility: folder.visibility,
      requiredRole: folder.required_role,
    })),
  ]
  const restrictedFolderNames = restrictedBootstrapFolderNames({
    rootFolderId: input.hostedRootFolderId ?? WORKSPACE_ROOT_ID,
    folders: bootstrapFolders,
  })

  const documents = ((documentRows ?? []) as DocumentRow[]).filter(
    (document) => {
      const inWorkspaceTree =
        document.folder_id === null || userFolderIds.has(document.folder_id)
      const inExportScope = input.hostedRootFolderId
        ? isInsideHostedRoot(document.folder_id)
        : inWorkspaceTree
      return (
        inWorkspaceTree &&
        inExportScope &&
        !(
          document.source === 'GitHub' &&
          document.source_metadata?.kind === 'repository_file'
        ) &&
        // Generated from an OpenAPI spec in the repository; the spec is the
        // source, so these pages are never written back as Markdown files.
        document.source_metadata?.kind !== OPENAPI_OPERATION_KIND
      )
    },
  )
  const canonicalPath = (document: DocumentRow): string | null => {
    const metadata = document.source_metadata
    const path = validBootstrapDocumentPath(
      typeof metadata?.canonical_repo_path === 'string'
        ? metadata.canonical_repo_path
        : null,
      input.targetPath,
    )
    return (
      path &&
      (!input.repoId || Number(metadata?.repo_id) === input.repoId)
    )
      ? path
      : null
  }
  const canonicalPaths = new Set(
    documents.map(canonicalPath).filter((path): path is string => Boolean(path)),
  )
  const repositoryContentByPath = new Map<string, string>()
  const managedPaths = new Set<string>()
  if (input.repoId) {
    for (const row of (companionRows ?? []) as RepositoryCompanionRow[]) {
      const path = validBootstrapDocumentPath(
        typeof row.source_metadata?.path === 'string'
          ? row.source_metadata.path
          : null,
        input.targetPath,
      )
      if (path) {
        managedPaths.add(path)
        if (canonicalPaths.has(path)) {
          repositoryContentByPath.set(path, row.content)
        }
      }
    }
  }

  const bootstrapDocuments: BootstrapDocument[] = documents.map((document) => {
    const path = canonicalPath(document)
    const externalDocumentId = document.source_metadata?.breezify_document_id
    const contentMarkdown = portalDocumentToMarkdown(document.content)
    const syncedContentHash = document.source_metadata?.github_hosted_content_hash
    return {
      id: document.id,
      breezifyDocumentId:
        typeof externalDocumentId === 'string' ? externalDocumentId : null,
      title: document.title,
      folderId: document.folder_id ?? WORKSPACE_ROOT_ID,
      pathRootFolderId:
        isInsideHostedRoot(document.folder_id)
          ? input.hostedRootFolderId!
          : undefined,
      publicSlug: document.public_slug,
      contentMarkdown,
      canonicalPath: path,
      repositoryContent: repositoryContentByPath.get(path ?? '') ?? null,
      repositoryContentIsCurrent:
        typeof syncedContentHash === 'string' &&
        hostedContentHash(contentMarkdown) === syncedContentHash,
      publishedAt: readPublishedDate(document.source_metadata),
      updatedAt: document.updated_at ?? null,
    }
  })
  const files = buildGitHubBootstrapFiles({
    targetPath: input.targetPath,
    rootFolderId: WORKSPACE_ROOT_ID,
    folders: bootstrapFolders,
    documents: bootstrapDocuments,
  })
  return {
    files,
    documents,
    managedPaths: [...managedPaths].sort((a, b) => a.localeCompare(b)),
    restrictedFolderNames,
    totalBytes: files.reduce(
      (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
      0,
    ),
  }
}

/** Attach deterministic root-relative repository paths before initial pull sync. */
export async function linkBreezifyWorkspaceDocuments(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    repoId: number
    repoFullName: string
    ref: string
    commitSha: string
    exported: BreezifyWorkspaceExport
  },
): Promise<void> {
  const documentById = new Map(
    input.exported.documents.map((document) => [document.id, document]),
  )
  for (const file of input.exported.files) {
    if (!file.documentId) continue
    const document = documentById.get(file.documentId)
    if (!document) continue
    const { error } = await admin
      .from('documents')
      .update({
        source_metadata: {
          ...(document.source_metadata ?? {}),
          kind: 'github_hosted_document',
          canonical_repo_path: file.path,
          breezify_document_id: file.breezifyDocumentId ?? file.documentId,
          github_hosted_sync: true,
          github_hosted_conflict: false,
          repo_id: input.repoId,
          repo_full_name: input.repoFullName,
          path: file.path,
          ref: input.ref,
          commit_sha: input.commitSha,
        },
      })
      .eq('id', file.documentId)
      .eq('workspace_id', input.workspaceId)
    if (error) throw new Error(`workspace document link: ${error.message}`)
  }
}
