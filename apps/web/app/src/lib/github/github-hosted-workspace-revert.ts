import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@bread/core'
import type { GitHubBootstrapFile } from './github-hosted-bootstrap'
import type { PublishDiffFile } from './github-hosted-workspace-publish'
import {
  hostedContentHash,
  parseGitHubHostedDocument,
} from './github-hosted-docs'
import {
  applyGitHubHostedDocumentUpdate,
  GitHubHostedDocumentChangedError,
} from './github-hosted-document-update'
import {
  fireDocumentEmbeddingUpdate,
  fireIngestFromText,
} from '@/rag/ingest'

type RevertSource = Pick<
  GitHubHostedDocsSourceRow,
  | 'id'
  | 'repo_id'
  | 'repo_full_name'
  | 'paths'
>

interface WorkspaceDocumentRow {
  id: string
  title: string
  content: string
  source_metadata: Record<string, unknown> | null
  deleted_at: string | null
  updated_at: string
}

interface RevertDependencies {
  applyDocumentUpdate?: typeof applyGitHubHostedDocumentUpdate
  ingest?: typeof fireIngestFromText
  updateEmbedding?: typeof fireDocumentEmbeddingUpdate
  now?: () => string
}

export class HostedWorkspaceRevertError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'HostedWorkspaceRevertError'
  }
}

async function loadDocumentById(
  admin: SupabaseClient,
  workspaceId: string,
  documentId: string,
): Promise<WorkspaceDocumentRow | null> {
  const { data, error } = await admin
    .from('documents')
    .select('id, title, content, source_metadata, deleted_at, updated_at')
    .eq('id', documentId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(`workspace revert document lookup: ${error.message}`)
  return data as WorkspaceDocumentRow | null
}

async function loadDocumentByCanonicalPath(
  admin: SupabaseClient,
  workspaceId: string,
  canonicalPath: string,
): Promise<WorkspaceDocumentRow | null> {
  const { data, error } = await admin
    .from('documents')
    .select('id, title, content, source_metadata, deleted_at, updated_at')
    .eq('workspace_id', workspaceId)
    .contains('source_metadata', { canonical_repo_path: canonicalPath })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`workspace revert canonical lookup: ${error.message}`)
  return data as WorkspaceDocumentRow | null
}

async function moveAddedDocumentToTrash(
  admin: SupabaseClient,
  workspaceId: string,
  document: WorkspaceDocumentRow,
  revertedAt: string,
): Promise<void> {
  let query = admin
    .from('documents')
    .update({ deleted_at: revertedAt, updated_at: revertedAt })
    .eq('id', document.id)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
  query = document.updated_at
    ? query.eq('updated_at', document.updated_at)
    : query.is('updated_at', null)
  const { data, error } = await query.select('id').maybeSingle()
  if (error) throw new Error(`workspace revert trash update: ${error.message}`)
  if (!data) {
    throw new HostedWorkspaceRevertError(
      'The Bread document changed while it was being reverted. Refresh the Changes view and try again.',
      409,
      'document_changed',
      { document_id: document.id },
    )
  }
}

/**
 * Make selected Bread files match the exact GitHub comparison head. Added
 * files move to trash; modified/removed files are atomically restored with a
 * version snapshot and expected-head protection.
 */
export async function revertHostedWorkspaceChanges(
  admin: SupabaseClient,
  input: {
    workspaceId: string
    source: RevertSource
    exportedFiles: GitHubBootstrapFile[]
    diffFiles: PublishDiffFile[]
    selectedPaths: string[]
    comparedCommitSha: string
  },
  injected: RevertDependencies = {},
): Promise<{ revertedPaths: string[]; documentIds: string[] }> {
  const applyDocumentUpdate =
    injected.applyDocumentUpdate ?? applyGitHubHostedDocumentUpdate
  const ingest = injected.ingest ?? fireIngestFromText
  const updateEmbedding =
    injected.updateEmbedding ?? fireDocumentEmbeddingUpdate
  const now = injected.now ?? (() => new Date().toISOString())
  const diffByPath = new Map(input.diffFiles.map((file) => [file.path, file]))
  const exportedByPath = new Map(
    input.exportedFiles.map((file) => [file.path, file]),
  )
  const missing = input.selectedPaths.filter((path) => !diffByPath.has(path))
  if (missing.length > 0) {
    throw new HostedWorkspaceRevertError(
      'The selected files no longer match the current GitHub comparison. Refresh the Changes view and try again.',
      409,
      'selected_paths_changed',
      { paths: missing },
    )
  }
  for (const path of input.selectedPaths) {
    const file = diffByPath.get(path)!
    const exportedFile = exportedByPath.get(path)
    if (file.status === 'added' && !exportedFile?.documentId) {
      throw new HostedWorkspaceRevertError(
        `${path} is generated workspace scaffolding and cannot be reverted independently.`,
        409,
        'file_not_revertible',
        { path },
      )
    }
    if (
      file.status !== 'added' &&
      (file.bodyOmitted || !file.previousBlobSha)
    ) {
      throw new HostedWorkspaceRevertError(
        `${path} is too large or unavailable to revert from this review.`,
        409,
        'revert_body_unavailable',
        { path },
      )
    }
  }

  const revertedPaths: string[] = []
  const documentIds = new Set<string>()
  for (const path of input.selectedPaths) {
    const file = diffByPath.get(path)!
    const exportedFile = exportedByPath.get(path)
    const revertedAt = now()

    if (file.status === 'added') {
      // Preflight above guarantees this is a real document rather than
      // generated `.gitkeep` scaffolding.
      const document = await loadDocumentById(
        admin,
        input.workspaceId,
        exportedFile!.documentId!,
      )
      if (!document || document.deleted_at) {
        throw new HostedWorkspaceRevertError(
          `${path} no longer maps to an editable Bread document.`,
          409,
          'document_not_found',
          { path },
        )
      }
      await moveAddedDocumentToTrash(
        admin,
        input.workspaceId,
        document,
        revertedAt,
      )
      documentIds.add(document.id)
      revertedPaths.push(path)
      continue
    }

    const parsed = parseGitHubHostedDocument(
      path,
      file.previous,
      input.source.paths,
      input.source.repo_id,
      file.previousBlobSha!,
    )
    const document =
      (exportedFile?.documentId
        ? await loadDocumentById(
            admin,
            input.workspaceId,
            exportedFile.documentId,
          )
        : null) ??
      (parsed.breadDocumentId
        ? await loadDocumentById(
            admin,
            input.workspaceId,
            parsed.breadDocumentId,
          )
        : null) ??
      (await loadDocumentByCanonicalPath(
        admin,
        input.workspaceId,
        path,
      ))
    if (!document) {
      throw new HostedWorkspaceRevertError(
        `${path} no longer maps to a Bread document that can be restored.`,
        409,
        'document_not_found',
        { path },
      )
    }

    try {
      await applyDocumentUpdate(admin, {
        documentId: document.id,
        workspaceId: input.workspaceId,
        expectedTitle: document.title,
        expectedContent: document.content,
        title: parsed.title,
        content: parsed.content,
        sourceMetadataPatch: {
          kind: 'github_hosted_document',
          canonical_repo_path: path,
          ...(parsed.breadDocumentId
            ? { bread_document_id: parsed.breadDocumentId }
            : {}),
          ...(parsed.date ? { published_date: parsed.date } : {}),
          github_hosted_sync: true,
          github_hosted_conflict: false,
          github_hosted_content_hash: hostedContentHash(parsed.content),
          github_hosted_pending_content_hash: null,
          github_hosted_pending_commit_sha: null,
          github_hosted_checkpoint_blob_sha: file.previousBlobSha,
          github_hosted_checkpoint_mode: 'replace_bread',
          repo_id: input.source.repo_id,
          repo_full_name: input.source.repo_full_name,
          path,
          commit_sha: input.comparedCommitSha,
        },
        updatedAt: revertedAt,
      })
    } catch (error) {
      if (error instanceof GitHubHostedDocumentChangedError) {
        throw new HostedWorkspaceRevertError(
          'The Bread document changed while it was being reverted. Refresh the Changes view and try again.',
          409,
          'document_changed',
          { document_id: document.id, path },
        )
      }
      throw error
    }

    documentIds.add(document.id)
    revertedPaths.push(path)
    if (
      document.deleted_at ||
      document.title !== parsed.title ||
      document.content !== parsed.content
    ) {
      ingest(document.id, parsed.content)
      updateEmbedding(document.id, input.workspaceId, parsed.content)
    }
  }

  const { count: conflictCount, error: conflictCountError } = await admin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', input.workspaceId)
    .contains('source_metadata', {
      repo_id: input.source.repo_id,
      github_hosted_conflict: true,
    })
    .is('deleted_at', null)
  if (conflictCountError) {
    console.error('[Bread] workspace revert conflict recount failed:', conflictCountError)
  } else {
    const { error: sourceError } = await admin
      .from('github_hosted_docs_sources')
      .update({ conflict_count: conflictCount ?? 0 })
      .eq('id', input.source.id)
      .eq('workspace_id', input.workspaceId)
    if (sourceError) {
      console.error('[Bread] workspace revert source update failed:', sourceError)
    }
  }

  return { revertedPaths, documentIds: [...documentIds] }
}
