import type { SupabaseClient } from '@supabase/supabase-js'

export interface GitHubHostedDocumentUpdateInput {
  documentId: string
  workspaceId: string
  expectedTitle: string
  expectedContent: string
  title: string
  content: string
  sourceMetadataPatch: Record<string, unknown>
  updatedAt: string
  requireConflict?: boolean
}

export interface GitHubHostedDocumentUpdateResult {
  applied: boolean
  snapshotCreated: boolean
  headChanged: boolean
  stale: boolean
}

interface GitHubHostedDocumentUpdateRpcRow {
  applied?: unknown
  snapshot_created?: unknown
  head_changed?: unknown
  stale?: unknown
}

export class GitHubHostedDocumentChangedError extends Error {
  constructor() {
    super('The Breezify document changed while GitHub content was being applied.')
    this.name = 'GitHubHostedDocumentChangedError'
  }
}

/**
 * Atomically snapshots the prior curated head and applies its GitHub version.
 * The database row lock makes a committed retry a no-op instead of creating a
 * duplicate version, while a concurrent Breezify edit fails closed as stale.
 */
export async function applyGitHubHostedDocumentUpdate(
  admin: SupabaseClient,
  input: GitHubHostedDocumentUpdateInput,
): Promise<GitHubHostedDocumentUpdateResult> {
  const { data, error } = await admin.rpc(
    'apply_github_hosted_document_update',
    {
      p_document_id: input.documentId,
      p_workspace_id: input.workspaceId,
      p_expected_title: input.expectedTitle,
      p_expected_content: input.expectedContent,
      p_title: input.title,
      p_content: input.content,
      p_source_metadata_patch: input.sourceMetadataPatch,
      p_updated_at: input.updatedAt,
      p_require_conflict: input.requireConflict ?? false,
    },
  )
  if (error) {
    throw new Error(`hosted document atomic update: ${error.message}`)
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | GitHubHostedDocumentUpdateRpcRow
    | null
  if (
    !row ||
    typeof row.applied !== 'boolean' ||
    typeof row.snapshot_created !== 'boolean' ||
    typeof row.head_changed !== 'boolean' ||
    typeof row.stale !== 'boolean'
  ) {
    throw new Error('hosted document atomic update returned an invalid result')
  }
  if (!row.applied) throw new GitHubHostedDocumentChangedError()

  return {
    applied: true,
    snapshotCreated: row.snapshot_created,
    headChanged: row.head_changed,
    stale: row.stale,
  }
}
