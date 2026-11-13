import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('./readme-service', () => ({ syncReadmeSource: vi.fn() }))

import { extractHostedBranchPush, handleHostedBranchPush } from './readme-webhook'

const payload = {
  ref: 'refs/heads/v2.0',
  after: 'abc123',
  repository: { id: 7, full_name: 'acme/docs', default_branch: 'v1.6' },
  installation: { id: 11 },
}

describe('extractHostedBranchPush', () => {
  it('describes a push to a branch other than the default', () => {
    expect(extractHostedBranchPush('push', payload)).toEqual({
      installationId: 11,
      repoId: 7,
      repoFullName: 'acme/docs',
      branch: 'v2.0',
      after: 'abc123',
    })
  })

  it('keeps slashes in branch names', () => {
    expect(
      extractHostedBranchPush('push', { ...payload, ref: 'refs/heads/release/2.0' })?.branch,
    ).toBe('release/2.0')
  })

  it('ignores default-branch pushes, tags, deletions and other events', () => {
    expect(extractHostedBranchPush('push', { ...payload, ref: 'refs/heads/v1.6' })).toBeNull()
    expect(extractHostedBranchPush('push', { ...payload, ref: 'refs/tags/v2.0' })).toBeNull()
    expect(extractHostedBranchPush('push', { ...payload, deleted: true })).toBeNull()
    expect(extractHostedBranchPush('push', { ...payload, after: '0000000000' })).toBeNull()
    expect(extractHostedBranchPush('pull_request', payload)).toBeNull()
    expect(extractHostedBranchPush('push', { ...payload, installation: undefined })).toBeNull()
  })
})

describe('handleHostedBranchPush', () => {
  const info = extractHostedBranchPush('push', payload)!

  function adminReturning(data: unknown) {
    const filters: Array<[string, unknown]> = []
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push([column, value])
        return query
      },
      maybeSingle: async () => ({ data, error: null }),
    }
    return { admin: { from: () => query } as unknown as SupabaseClient, filters }
  }

  it('syncs the ReadMe-format link that follows the pushed branch', async () => {
    const source = { id: 'source-1', format: 'readme', branch: 'v2.0', sync_status: 'synced' }
    const { admin, filters } = adminReturning(source)
    const syncSource = vi.fn().mockResolvedValue(null)
    await handleHostedBranchPush(info, { admin, syncSource })
    expect(filters).toEqual([
      ['repo_id', 7],
      ['installation_id', 11],
      ['format', 'readme'],
      ['branch', 'v2.0'],
    ])
    expect(syncSource).toHaveBeenCalledWith(source, { ref: 'abc123' }, admin)
  })

  it('does nothing when no link follows that branch', async () => {
    const syncSource = vi.fn()
    await handleHostedBranchPush(info, { admin: adminReturning(null).admin, syncSource })
    expect(syncSource).not.toHaveBeenCalled()
  })
})
