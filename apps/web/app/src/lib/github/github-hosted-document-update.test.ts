import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  applyGitHubHostedDocumentUpdate,
  GitHubHostedDocumentChangedError,
} from './github-hosted-document-update'

function adminWithRpc(result: {
  data: unknown
  error: { message: string } | null
}): { admin: SupabaseClient; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn().mockResolvedValue(result)
  return {
    admin: { rpc } as unknown as SupabaseClient,
    rpc,
  }
}

const update = {
  documentId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  expectedTitle: 'Before',
  expectedContent: 'Old body',
  title: 'After',
  content: 'New body',
  sourceMetadataPatch: {
    commit_sha: 'abc123',
    github_hosted_conflict: false,
  },
  updatedAt: '2026-08-20T01:00:00.000Z',
}

describe('applyGitHubHostedDocumentUpdate', () => {
  it('passes the expected head and metadata patch to the atomic RPC', async () => {
    const { admin, rpc } = adminWithRpc({
      data: [{
        applied: true,
        snapshot_created: true,
        head_changed: true,
        stale: false,
      }],
      error: null,
    })

    await expect(applyGitHubHostedDocumentUpdate(admin, {
      ...update,
      requireConflict: true,
    })).resolves.toEqual({
      applied: true,
      snapshotCreated: true,
      headChanged: true,
      stale: false,
    })
    expect(rpc).toHaveBeenCalledWith(
      'apply_github_hosted_document_update',
      {
        p_document_id: update.documentId,
        p_workspace_id: update.workspaceId,
        p_expected_title: 'Before',
        p_expected_content: 'Old body',
        p_title: 'After',
        p_content: 'New body',
        p_source_metadata_patch: update.sourceMetadataPatch,
        p_updated_at: update.updatedAt,
        p_require_conflict: true,
      },
    )
  })

  it('fails closed when the expected Breezify head is stale', async () => {
    const { admin } = adminWithRpc({
      data: [{
        applied: false,
        snapshot_created: false,
        head_changed: false,
        stale: true,
      }],
      error: null,
    })

    await expect(
      applyGitHubHostedDocumentUpdate(admin, update),
    ).rejects.toBeInstanceOf(GitHubHostedDocumentChangedError)
  })

  it('surfaces database failures instead of updating without a snapshot', async () => {
    const { admin } = adminWithRpc({
      data: null,
      error: { message: 'transaction rolled back' },
    })

    await expect(
      applyGitHubHostedDocumentUpdate(admin, update),
    ).rejects.toThrow('hosted document atomic update: transaction rolled back')
  })
})
