import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { revertHostedWorkspaceChanges } from './github-hosted-workspace-revert'

const documentId = '11111111-1111-4111-8111-111111111111'
const workspaceId = '22222222-2222-4222-8222-222222222222'
const source = {
  id: 'source-1',
  repo_id: 42,
  repo_full_name: 'acme/docs',
  paths: ['docs'],
}

function resolvedBuilder(result: Record<string, unknown>) {
  const chain: Record<string, any> = {}
  for (const method of [
    'select',
    'eq',
    'contains',
    'is',
    'limit',
    'update',
  ]) {
    chain[method] = vi.fn(() => chain)
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  chain.then = vi.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolve),
  )
  return chain
}

function adminFrom(builders: Array<Record<string, any>>) {
  const from = vi.fn()
  for (const builder of builders) from.mockReturnValueOnce(builder)
  return {
    admin: { from } as unknown as SupabaseClient,
    from,
  }
}

function conflictCountBuilder() {
  return resolvedBuilder({ count: 0, error: null })
}

describe('revertHostedWorkspaceChanges', () => {
  it('moves a newly added Bread document to trash with an updated-at guard', async () => {
    const document = {
      id: documentId,
      title: 'New page',
      content: 'New body',
      source_metadata: null,
      deleted_at: null,
      updated_at: '2026-08-29T12:00:00.000Z',
    }
    const lookup = resolvedBuilder({ data: document, error: null })
    const trash = resolvedBuilder({ data: { id: documentId }, error: null })
    const sourceUpdate = resolvedBuilder({ error: null })
    const { admin } = adminFrom([
      lookup,
      trash,
      conflictCountBuilder(),
      sourceUpdate,
    ])

    const result = await revertHostedWorkspaceChanges(
      admin,
      {
        workspaceId,
        source,
        exportedFiles: [{
          documentId,
          path: 'docs/new.md',
          content: 'New body',
        }],
        diffFiles: [{
          path: 'docs/new.md',
          status: 'added',
          previous: '',
          next: 'New body',
        }],
        selectedPaths: ['docs/new.md'],
        comparedCommitSha: 'commit-1',
      },
      { now: () => '2026-08-29T13:00:00.000Z' },
    )

    expect(trash.update).toHaveBeenCalledWith({
      deleted_at: '2026-08-29T13:00:00.000Z',
      updated_at: '2026-08-29T13:00:00.000Z',
    })
    expect(trash.eq).toHaveBeenCalledWith(
      'updated_at',
      '2026-08-29T12:00:00.000Z',
    )
    expect(result).toEqual({
      revertedPaths: ['docs/new.md'],
      documentIds: [documentId],
    })
  })

  it('atomically restores a modified document from the compared GitHub blob', async () => {
    const current = {
      id: documentId,
      title: 'Bread title',
      content: 'Bread body',
      source_metadata: { canonical_repo_path: 'docs/page.md' },
      deleted_at: null,
      updated_at: '2026-08-29T12:00:00.000Z',
    }
    const { admin } = adminFrom([
      resolvedBuilder({ data: current, error: null }),
      conflictCountBuilder(),
      resolvedBuilder({ error: null }),
    ])
    const applyDocumentUpdate = vi.fn().mockResolvedValue({
      applied: true,
      snapshotCreated: true,
      headChanged: true,
      stale: false,
    })
    const ingest = vi.fn()
    const updateEmbedding = vi.fn()
    const previous = [
      '---',
      'title: "GitHub title"',
      `bread_document_id: "${documentId}"`,
      '---',
      '',
      '# GitHub title',
      '',
      'GitHub body',
      '',
    ].join('\n')

    await revertHostedWorkspaceChanges(
      admin,
      {
        workspaceId,
        source,
        exportedFiles: [{
          documentId,
          path: 'docs/page.md',
          content: 'Bread body',
        }],
        diffFiles: [{
          path: 'docs/page.md',
          status: 'modified',
          previous,
          next: 'Bread body',
          previousBlobSha: 'blob-old',
        }],
        selectedPaths: ['docs/page.md'],
        comparedCommitSha: 'commit-1',
      },
      {
        applyDocumentUpdate,
        ingest,
        updateEmbedding,
        now: () => '2026-08-29T13:00:00.000Z',
      },
    )

    expect(applyDocumentUpdate).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        documentId,
        expectedTitle: 'Bread title',
        expectedContent: 'Bread body',
        title: 'GitHub title',
        sourceMetadataPatch: expect.objectContaining({
          canonical_repo_path: 'docs/page.md',
          commit_sha: 'commit-1',
          github_hosted_conflict: false,
        }),
      }),
    )
    expect(ingest).toHaveBeenCalledWith(documentId, expect.any(String))
    expect(updateEmbedding).toHaveBeenCalledWith(
      documentId,
      workspaceId,
      expect.any(String),
    )
  })
})
