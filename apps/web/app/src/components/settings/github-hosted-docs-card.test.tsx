// @vitest-environment happy-dom
import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, vi } from 'vitest'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import type { GitHubAvailableRepo } from '@/lib/github/types'
import {
  buildHostedDocsFolderTree,
  expandedPathsForSelection,
  GithubHostedDocsCard,
} from './github-hosted-docs-card'
import {
  bootstrapGithubHostedDocsSource,
  saveGithubHostedDocsSource,
} from '@/lib/github/api/github-integrations'

const availableRepo: GitHubAvailableRepo = {
  id: 1185697075,
  name: 'breezify',
  full_name: 'example-org/breezify-docs',
  private: true,
}

const hostedSource: GitHubHostedDocsSourceRow = {
  id: 'source-row-1',
  workspace_id: 'workspace-1',
  installation_id: 11,
  repo_full_name: 'example-org/breezify-docs',
  repo_id: 1185697075,
  paths: ['docs/product'],
  root_folder_id: 'folder-1',
  sync_status: 'synced',
  document_count: 25,
  conflict_count: 0,
  last_sync_commit_sha: '51580bc',
  last_sync_at: '2026-08-12T00:00:00Z',
  last_sync_error: null,
  pending_pull_request_number: null,
  pending_pull_request_url: null,
  pending_pull_request_head: null,
  publish_pull_request_number: null,
  publish_pull_request_url: null,
  publish_pull_request_head: null,
  publish_last_commit_sha: null,
  publish_operation_id: null,
  publish_operation_started_at: null,
  pending_sync_mode: 'merge',
  created_by: 'user-1',
  created_at: '2026-08-10T00:00:00Z',
  updated_at: '2026-08-12T00:00:00Z',
}

let mockSource: GitHubHostedDocsSourceRow | null = hostedSource

vi.mock('@/hooks/swr', () => ({
  useGithubHostedDocs: () => ({
    data: {
      source: mockSource,
      linked_folder: mockSource
        ? {
            id: 'folder-1',
            display_name: 'Breezify Docs',
            visibility: 'workspace',
            required_role: null,
          }
        : null,
      linked_path_count: mockSource ? 53 : 0,
      linked_document_count: mockSource ? 65 : 0,
    },
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useFolders: () => ({
    data: [{
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'breezify-docs',
      display_name: 'Breezify Docs',
      kind: 'user',
      parent_folder_id: null,
      visibility: 'workspace',
      required_role: null,
      document_count: 12,
      sort_order: null,
      icon: null,
      last_seen_at: '2026-08-12T00:00:00Z',
      created_at: '2026-08-12T00:00:00Z',
      updated_at: '2026-08-12T00:00:00Z',
    }],
    isLoading: false,
  }),
}))

vi.mock('swr', () => ({
  default: () => ({
    data: {
      repoId: hostedSource.repo_id,
      repoFullName: hostedSource.repo_full_name,
      ref: 'main',
      commitSha: '51580bc',
      truncated: false,
      folders: ['docs', 'docs/product', 'docs/product/developer'],
    },
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
}))

vi.mock('@/lib/github/api/github-integrations', () => ({
  bootstrapGithubHostedDocsSource: vi.fn(),
  saveGithubHostedDocsSource: vi.fn(),
  disableGithubHostedDocsSource: vi.fn(),
}))

afterEach(cleanup)
beforeEach(() => {
  mockSource = hostedSource
  vi.mocked(saveGithubHostedDocsSource).mockReset()
  vi.mocked(saveGithubHostedDocsSource).mockResolvedValue({
    source: hostedSource,
  })
  vi.mocked(bootstrapGithubHostedDocsSource).mockReset()
  vi.mocked(bootstrapGithubHostedDocsSource).mockResolvedValue({
    source: hostedSource,
    targetPath: 'docs',
    fileCount: 12,
    pullRequestUrl: 'https://github.test/acme/repo/pull/1',
  })
})

describe('buildHostedDocsFolderTree', () => {
  it('expands the ancestors of the persisted source so its checkbox is visible', () => {
    expect([...expandedPathsForSelection(['docs/product/developer'])]).toEqual([
      'docs',
      'docs/product',
    ])
  })

  it('locks root setup while a link is active', () => {
    render(
      <GithubHostedDocsCard
        repositories={[availableRepo]}
      />,
    )

    expect(screen.getByText('GitHub docs root')).not.toBeNull()
    expect(screen.getByText(/one repository folder as the root/i)).not.toBeNull()
    expect(screen.getByText('Current root')).not.toBeNull()
    expect(screen.getByText('example-org/breezify-docs/docs/product')).not.toBeNull()
    expect(screen.getByText(/disable the link before choosing or creating/i)).not.toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText('Select an existing folder')).toBeNull()
    expect(screen.queryByText('Create a new folder')).toBeNull()
    expect(screen.getByRole('button', { name: 'Disable root link' })).not.toBeNull()
  })

  it('locks root setup as soon as its pull request is open', () => {
    mockSource = {
      ...hostedSource,
      sync_status: 'disabled',
      pending_pull_request_number: 172,
      pending_pull_request_url: 'https://github.com/example-org/breezify-docs/pull/172',
      pending_pull_request_head: 'breezify/docs-docs-example',
    }
    render(<GithubHostedDocsCard repositories={[availableRepo]} />)

    expect(screen.getByText('Waiting for PR merge')).not.toBeNull()
    expect(screen.getByText(/pull request is open.*setup is locked/i)).not.toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText('Select an existing folder')).toBeNull()
    expect(screen.queryByText('Create a new folder')).toBeNull()
    expect(screen.getByRole('link', { name: /view pull request/i })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Disable root link' })).not.toBeNull()
  })

  it('shows activation progress after the pull request merges', () => {
    mockSource = { ...hostedSource, sync_status: 'pending' }
    render(<GithubHostedDocsCard repositories={[availableRepo]} />)

    expect(screen.getByText('Syncing root')).not.toBeNull()
    expect(screen.getByText(/breezify is activating this root/i)).not.toBeNull()
    expect(screen.queryByText('Select an existing folder')).toBeNull()
    expect(screen.queryByText('Create a new folder')).toBeNull()
  })

  it('creates a new root from the complete Breezify tree through a pull request', async () => {
    mockSource = null
    const user = userEvent.setup()
    render(
      <GithubHostedDocsCard
        repositories={[availableRepo]}
      />,
    )

    expect(screen.getByText('Create a new folder')).not.toBeNull()
    expect(screen.getByText(/build the workspace tree there/i)).not.toBeNull()
    expect(screen.getByLabelText('Or create a folder')).not.toBeNull()
    expect(screen.getByRole('textbox', { name: 'New GitHub root path' })).toHaveValue('docs')

    await user.click(screen.getByRole('button', { name: 'Create via pull request' }))
    expect(bootstrapGithubHostedDocsSource).toHaveBeenCalledWith({
      repoId: 1185697075,
      targetPath: 'docs',
      allowExisting: false,
    })
  })

  it('shows one local loading bar for the action that is running', async () => {
    mockSource = null
    let finish!: (value: {
      source: GitHubHostedDocsSourceRow
      pullRequestUrl: string
    }) => void
    vi.mocked(bootstrapGithubHostedDocsSource).mockImplementationOnce(
      () => new Promise((resolve) => {
        finish = resolve
      }),
    )
    const user = userEvent.setup()
    const { container } = render(
      <GithubHostedDocsCard repositories={[availableRepo]} />,
    )

    await user.click(screen.getByRole('button', { name: 'Create via pull request' }))

    expect(screen.getByRole('progressbar', {
      name: 'Create GitHub docs folder progress',
    })).not.toBeNull()
    expect(screen.queryByRole('progressbar', {
      name: 'Link selected folder progress',
    })).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()

    finish({
      source: hostedSource,
      pullRequestUrl: 'https://github.test/acme/repo/pull/1',
    })
    await waitFor(() => {
      expect(screen.queryByRole('progressbar', {
        name: 'Create GitHub docs folder progress',
      })).toBeNull()
    })
  })

  it('links and starts syncing one existing root in merge mode', async () => {
    mockSource = null
    const user = userEvent.setup()
    render(
      <GithubHostedDocsCard
        repositories={[availableRepo]}
      />,
    )

    await user.click(screen.getByRole('radio', { name: 'docs' }))
    await user.click(screen.getByRole('button', { name: 'Link selected folder' }))

    expect(saveGithubHostedDocsSource).toHaveBeenCalledWith({
      repoId: 1185697075,
      rootPath: 'docs',
      mode: 'merge',
    })
    expect(screen.getByText(/github root linked.*syncing/i)).not.toBeNull()
    expect(screen.queryByRole('link', { name: /view pull request/i })).toBeNull()
  })

  it('can explicitly choose GitHub as the initial authority', async () => {
    mockSource = null
    const user = userEvent.setup()
    render(<GithubHostedDocsCard repositories={[availableRepo]} />)

    await user.click(screen.getByRole('radio', { name: 'docs' }))
    await user.click(screen.getByRole('radio', { name: /use github/i }))
    await user.click(screen.getByRole('button', { name: 'Link selected folder' }))

    expect(saveGithubHostedDocsSource).toHaveBeenCalledWith({
      repoId: 1185697075,
      rootPath: 'docs',
      mode: 'github_wins',
    })
  })

  it('uses a pull request when Breezify is the initial authority', async () => {
    mockSource = null
    const user = userEvent.setup()
    render(<GithubHostedDocsCard repositories={[availableRepo]} />)

    await user.click(screen.getByRole('radio', { name: 'docs' }))
    await user.click(screen.getByRole('radio', { name: /use breezify/i }))
    await user.click(screen.getByRole('button', { name: 'Link selected folder' }))
    await user.click(screen.getByRole('button', { name: 'Open pull request' }))

    expect(bootstrapGithubHostedDocsSource).toHaveBeenCalledWith({
      repoId: 1185697075,
      targetPath: 'docs',
      allowExisting: true,
    })
  })

  it('builds a collapsed hierarchy instead of a flat folder list', () => {
    expect(buildHostedDocsFolderTree([
      'docs',
      'docs/product',
      'docs/product/developer',
      'packages',
      'packages/api/docs',
    ])).toEqual([
      {
        path: 'docs',
        name: 'docs',
        children: [{
          path: 'docs/product',
          name: 'product',
          children: [{
            path: 'docs/product/developer',
            name: 'developer',
            children: [],
          }],
        }],
      },
      {
        path: 'packages',
        name: 'packages',
        children: [{
          path: 'packages/api',
          name: 'api',
          children: [{
            path: 'packages/api/docs',
            name: 'docs',
            children: [],
          }],
        }],
      },
    ])
  })
})
