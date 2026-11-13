/**
 * Chunk 1 — Core Type Tests
 *
 * These tests serve as living documentation of the GitHub integration's type
 * contracts. They verify:
 *   - Object shapes conform to the declared interfaces
 *   - Discriminated union literals are correctly constrained
 *   - Nullability matches the schema (NOT NULL vs nullable columns)
 *
 * If a type change breaks these tests, it means the TypeScript interface,
 * the SQL schema, and the README need to be updated together.
 */

import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  GitHubIntegrationRow,
  GitHubPRSessionRow,
  GitHubUserLinkRow,
  MonitoredRepoRow,
} from '@breezify/core'

// ---------------------------------------------------------------------------
// GitHubIntegrationRow
// ---------------------------------------------------------------------------

describe('GitHubIntegrationRow', () => {
  it('accepts a well-formed Organization installation', () => {
    const row: GitHubIntegrationRow = {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      workspace_id: 'aaaaaaaa-0000-0000-0000-000000000002',
      github_account_login: 'acmecorp',
      github_account_type: 'Organization',
      installation_id: 12345678,
      installed_by: 'aaaaaaaa-0000-0000-0000-000000000003',
      created_at: '2026-03-27T00:00:00Z',
      updated_at: '2026-03-27T00:00:00Z',
    }
    expect(row.github_account_type).toBe('Organization')
    expect(row.installation_id).toBeTypeOf('number')
  })

  it('accepts a well-formed User installation', () => {
    const row: GitHubIntegrationRow = {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      workspace_id: 'aaaaaaaa-0000-0000-0000-000000000002',
      github_account_login: 'ben-li',
      github_account_type: 'User',
      installation_id: 99999999,
      installed_by: null,
      created_at: '2026-03-27T00:00:00Z',
      updated_at: '2026-03-27T00:00:00Z',
    }
    expect(row.github_account_type).toBe('User')
  })

  it('installed_by is nullable (installer may have left the workspace)', () => {
    const withInstaller: GitHubIntegrationRow = {
      id: 'id',
      workspace_id: 'ws',
      github_account_login: 'org',
      github_account_type: 'Organization',
      installation_id: 1,
      installed_by: 'user-id',
      created_at: '',
      updated_at: '',
    }
    const withoutInstaller: GitHubIntegrationRow = { ...withInstaller, installed_by: null }

    expect(withInstaller.installed_by).toBe('user-id')
    expect(withoutInstaller.installed_by).toBeNull()
  })

  it('github_account_type is a discriminated union', () => {
    expectTypeOf<GitHubIntegrationRow['github_account_type']>().toEqualTypeOf<
      'Organization' | 'User'
    >()
  })
})

// ---------------------------------------------------------------------------
// MonitoredRepoRow
// ---------------------------------------------------------------------------

describe('MonitoredRepoRow', () => {
  it('accepts a well-formed repo row', () => {
    const row: MonitoredRepoRow = {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      workspace_id: 'aaaaaaaa-0000-0000-0000-000000000002',
      installation_id: 12345678,
      repo_full_name: 'acmecorp/api-service',
      repo_id: 987654321,
      created_by: 'aaaaaaaa-0000-0000-0000-000000000003',
      created_at: '2026-03-27T00:00:00Z',
      file_sync_status: 'synced',
      file_indexing_enabled: true,
      indexed_file_count: 42,
      pending_file_count: 0,
      skipped_file_count: 7,
      failed_file_count: 0,
      last_file_sync_commit_sha: 'abcdef123456',
      last_file_sync_at: '2026-03-27T00:01:00Z',
      last_file_sync_error: null,
      file_tree_truncated: false,
    }
    expect(row.repo_full_name).toContain('/')
    expect(row.repo_id).toBeTypeOf('number')
    expect(row.installation_id).toBeTypeOf('number')
  })

  it('created_by is nullable (creator may have left the workspace)', () => {
    const row: MonitoredRepoRow = {
      id: 'id',
      workspace_id: 'ws',
      installation_id: 1,
      repo_full_name: 'org/repo',
      repo_id: 1,
      created_by: null,
      created_at: '',
      file_sync_status: 'pending',
      file_indexing_enabled: true,
      indexed_file_count: 0,
      pending_file_count: 0,
      skipped_file_count: 0,
      failed_file_count: 0,
      last_file_sync_commit_sha: null,
      last_file_sync_at: null,
      last_file_sync_error: null,
      file_tree_truncated: false,
    }
    expect(row.created_by).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GitHubPRSessionRow
// ---------------------------------------------------------------------------

describe('GitHubPRSessionRow', () => {
  const base: GitHubPRSessionRow = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    workspace_id: 'aaaaaaaa-0000-0000-0000-000000000002',
    installation_id: 12345678,
    repo_full_name: 'acmecorp/api-service',
    repo_id: 987654321,
    pr_number: 42,
    pr_title: 'feat: add GitHub capture',
    pr_author_login: 'ben-li',
    status: 'active',
    doc_count: 0,
    document_ids: [],
    last_activity_at: null,
    last_ingested_at: null,
    created_at: '2026-03-27T00:00:00Z',
    updated_at: '2026-03-27T00:00:00Z',
  }

  it('accepts an active session with no documents yet', () => {
    expect(base.status).toBe('active')
    expect(base.document_ids).toHaveLength(0)
    expect(base.doc_count).toBe(0)
  })

  it('accepts a closed session with documents', () => {
    const closed: GitHubPRSessionRow = {
      ...base,
      status: 'closed',
      doc_count: 2,
      document_ids: [
        'aaaaaaaa-0000-0000-0000-000000000010',
        'aaaaaaaa-0000-0000-0000-000000000011',
      ],
      last_activity_at: '2026-03-27T10:00:00Z',
      last_ingested_at: '2026-03-27T10:01:00Z',
    }
    expect(closed.status).toBe('closed')
    expect(closed.document_ids).toHaveLength(2)
  })

  it('accepts an error session', () => {
    const errored: GitHubPRSessionRow = { ...base, status: 'error' }
    expect(errored.status).toBe('error')
  })

  it('pr_title and pr_author_login are nullable (populated after first API fetch)', () => {
    const fresh: GitHubPRSessionRow = {
      ...base,
      pr_title: null,
      pr_author_login: null,
    }
    expect(fresh.pr_title).toBeNull()
    expect(fresh.pr_author_login).toBeNull()
  })

  it('last_activity_at and last_ingested_at are nullable (null before first event)', () => {
    expect(base.last_activity_at).toBeNull()
    expect(base.last_ingested_at).toBeNull()
  })

  it('status is a discriminated union', () => {
    expectTypeOf<GitHubPRSessionRow['status']>().toEqualTypeOf<
      'active' | 'closed' | 'error'
    >()
  })

  it('document_ids is an array of strings', () => {
    expectTypeOf<GitHubPRSessionRow['document_ids']>().toEqualTypeOf<string[]>()
  })
})

// ---------------------------------------------------------------------------
// GitHubUserLinkRow
// ---------------------------------------------------------------------------

describe('GitHubUserLinkRow', () => {
  it('accepts a well-formed link', () => {
    const row: GitHubUserLinkRow = {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      workspace_id: 'aaaaaaaa-0000-0000-0000-000000000002',
      user_id: 'aaaaaaaa-0000-0000-0000-000000000003',
      github_login: 'ben-li',
      created_at: '2026-03-27T00:00:00Z',
    }
    expect(row.github_login).toBeTypeOf('string')
    expect(row.github_login.length).toBeGreaterThan(0)
  })

  it('all fields are non-nullable (the link is meaningless without all parts)', () => {
    expectTypeOf<GitHubUserLinkRow['user_id']>().toEqualTypeOf<string>()
    expectTypeOf<GitHubUserLinkRow['workspace_id']>().toEqualTypeOf<string>()
    expectTypeOf<GitHubUserLinkRow['github_login']>().toEqualTypeOf<string>()
  })
})
