import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  buildBreadWorkspaceExport,
  linkBreadWorkspaceDocuments,
} from './github-hosted-workspace'

function thenable<T>(value: T, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    then: (onFulfilled: (result: T) => unknown, onRejected?: (error: unknown) => unknown) =>
      Promise.resolve(value).then(onFulfilled, onRejected),
  }
}

describe('buildBreadWorkspaceExport', () => {
  it('keeps whole-workspace export behavior when no hosted root is provided', async () => {
    const folders = [
      {
        id: 'folder-a',
        display_name: 'Product',
        parent_folder_id: null,
        kind: 'user',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
      {
        id: 'folder-b',
        display_name: 'Developer',
        parent_folder_id: 'folder-a',
        kind: 'user',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
      {
        id: 'system-folder',
        display_name: 'System',
        parent_folder_id: null,
        kind: 'system',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
    ]
    const documents = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Overview',
        content: 'Product overview',
        source: 'manual',
        source_metadata: null,
        public_slug: null,
        folder_id: 'folder-a',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        title: 'API Setup',
        content: 'API setup',
        source: 'manual',
        source_metadata: null,
        public_slug: null,
        folder_id: 'folder-b',
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        title: 'Workspace Note',
        content: 'Unfiled note',
        source: 'manual',
        source_metadata: null,
        public_slug: null,
        folder_id: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        title: 'Generated',
        content: 'Generated content',
        source: 'system',
        source_metadata: null,
        public_slug: null,
        folder_id: 'system-folder',
      },
      {
        id: '00000000-0000-4000-8000-000000000005',
        title: 'Repository companion',
        content: 'Raw repository content',
        source: 'GitHub',
        source_metadata: { kind: 'repository_file' },
        public_slug: null,
        folder_id: null,
      },
    ]

    const from = vi.fn((table: string) => {
      if (table === 'folders') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: folders, error: null }),
          }),
        }
      }
      if (table === 'documents') {
        const result = { data: documents, error: null }
        const inFn = vi.fn().mockReturnValue(thenable(result))
        const isFn = vi.fn().mockReturnValue({ in: inFn })
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ is: isFn }),
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await buildBreadWorkspaceExport(
      { from } as never,
      { workspaceId: 'workspace-1', targetPath: 'docs' },
    )

    expect(result.documents).toHaveLength(3)
    expect(result.files.map((file) => file.path)).toEqual([
      'docs/product/overview.md',
      'docs/product/developer/api-setup.md',
      'docs/workspace-note.md',
    ])
    expect(result.restrictedFolderNames).toEqual([])
  })

  it('uses repository companions for stable paths/frontmatter and managed deletions', async () => {
    const documentId = '00000000-0000-4000-8000-000000000001'
    const breadDocumentId = '00000000-0000-4000-8000-000000000099'
    const syncedContent = 'Current instructions.'
    const syncedContentHash = createHash('sha256')
      .update(syncedContent)
      .digest('hex')
    const folders = [
      {
        id: 'hosted-root',
        display_name: 'GitHub Docs',
        parent_folder_id: null,
        kind: 'user',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
      {
        id: 'guides',
        display_name: 'Guides',
        parent_folder_id: 'hosted-root',
        kind: 'user',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
    ]
    const documents = [{
      id: documentId,
      title: 'Setup',
      content: syncedContent,
      source: 'docs',
      source_metadata: {
        canonical_repo_path: 'docs/old/setup.mdx',
        repo_id: 42,
        bread_document_id: breadDocumentId,
        github_hosted_content_hash: syncedContentHash,
      },
      public_slug: null,
      folder_id: 'guides',
    }]
    const companions = [
      {
        content: [
          '---',
          'title: "Setup"',
          `bread_document_id: ${JSON.stringify(breadDocumentId)}`,
          'date: "2026-08-17T17:00:00.000Z"',
          '---',
          '',
          '# Setup',
          '',
          syncedContent,
        ].join('\n'),
        source_metadata: {
          kind: 'repository_file',
          repo_id: 42,
          path: 'docs/old/setup.mdx',
        },
      },
      {
        content: '# Removed',
        source_metadata: {
          kind: 'repository_file',
          repo_id: 42,
          path: 'docs/removed.md',
        },
      },
    ]

    const from = vi.fn((table: string) => {
      if (table === 'folders') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: folders, error: null }),
          }),
        }
      }
      if (table === 'documents') {
        return {
          select: vi.fn((columns: string) => {
            if (columns === 'content, source_metadata') {
              const result = { data: companions, error: null }
              const is = vi.fn().mockResolvedValue(result)
              const contains = vi.fn().mockReturnValue({ is })
              const sourceEq = vi.fn().mockReturnValue({ contains })
              const workspaceEq = vi.fn().mockReturnValue({ eq: sourceEq })
              return { eq: workspaceEq }
            }
            const result = { data: documents, error: null }
            const inFn = vi.fn().mockReturnValue(thenable(result))
            const isFn = vi.fn().mockReturnValue({ in: inFn })
            return { eq: vi.fn().mockReturnValue({ is: isFn }) }
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await buildBreadWorkspaceExport(
      { from } as never,
      {
        workspaceId: 'workspace-1',
        targetPath: 'docs',
        repoId: 42,
        hostedRootFolderId: 'hosted-root',
      },
    )

    expect(result.files[0]?.path).toBe('docs/old/setup.mdx')
    expect(result.files[0]?.documentId).toBe(documentId)
    expect(result.files[0]?.breadDocumentId).toBe(breadDocumentId)
    expect(result.files[0]?.content).toContain(
      `bread_document_id: ${JSON.stringify(breadDocumentId)}`,
    )
    // The date survives the export. Here it comes from the repository file
    // (the document row carries no updated_at), which is the fallback path;
    // a document with a timestamp emits that instead.
    expect(result.files[0]?.content).toContain('date: "2026-08-17T17:00:00.000Z"')
    expect(result.files[0]?.content).toBe(companions[0]!.content)
    expect(result.managedPaths).toEqual([
      'docs/old/setup.mdx',
      'docs/removed.md',
    ])
  })

  it('exports only the hosted subtree while preserving linked repository directories', async () => {
    const folders = [
      {
        id: 'hosted-root',
        display_name: 'Bread Docs',
        parent_folder_id: null,
        kind: 'user',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
      {
        id: 'developers',
        display_name: 'Developers & AI',
        parent_folder_id: 'hosted-root',
        kind: 'user',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
      {
        id: 'developer-sdks',
        display_name: 'SDKs',
        parent_folder_id: 'developers',
        kind: 'user',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
      {
        id: 'help-center',
        display_name: 'Bread Help Center',
        parent_folder_id: 'hosted-root',
        kind: 'user',
        content: null,
        visibility: 'workspace',
        required_role: null,
      },
      {
        id: 'blog',
        display_name: 'Blog',
        parent_folder_id: null,
        kind: 'user',
        content: null,
        visibility: 'role',
        required_role: 'admin',
      },
    ]
    const documents = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Setup',
        content: 'Developer setup.',
        source: 'docs',
        source_metadata: {
          canonical_repo_path: 'docs/bread-docs/developers/setup.mdx',
          repo_id: 42,
        },
        public_slug: null,
        folder_id: 'developers',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        title: 'Contact support',
        content: 'Contact us.',
        source: 'docs',
        source_metadata: {
          canonical_repo_path: 'docs/bread-docs/help-center/contact.md',
          repo_id: 42,
        },
        public_slug: null,
        folder_id: 'help-center',
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        title: 'Node SDK',
        content: 'Install the SDK.',
        source: 'manual',
        source_metadata: null,
        public_slug: null,
        folder_id: 'developer-sdks',
      },
      {
        id: '00000000-0000-4000-8000-000000000006',
        title: 'FAQ',
        content: 'Common questions.',
        source: 'manual',
        source_metadata: null,
        public_slug: null,
        folder_id: 'help-center',
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        title: 'Launch post',
        content: 'News.',
        source: 'manual',
        source_metadata: null,
        public_slug: null,
        folder_id: 'blog',
      },
      {
        id: '00000000-0000-4000-8000-000000000005',
        title: 'Workspace note',
        content: 'Private note.',
        source: 'manual',
        source_metadata: null,
        public_slug: null,
        folder_id: null,
      },
    ]

    const from = vi.fn((table: string) => {
      if (table === 'folders') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: folders, error: null }),
          }),
        }
      }
      if (table === 'documents') {
        return {
          select: vi.fn((columns: string) => {
            if (columns === 'content, source_metadata') {
              const result = { data: [], error: null }
              const is = vi.fn().mockResolvedValue(result)
              const contains = vi.fn().mockReturnValue({ is })
              const sourceEq = vi.fn().mockReturnValue({ contains })
              const workspaceEq = vi.fn().mockReturnValue({ eq: sourceEq })
              return { eq: workspaceEq }
            }
            const result = { data: documents, error: null }
            const inFn = vi.fn().mockReturnValue(thenable(result))
            const isFn = vi.fn().mockReturnValue({ in: inFn })
            return { eq: vi.fn().mockReturnValue({ is: isFn }) }
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await buildBreadWorkspaceExport(
      { from } as never,
      {
        workspaceId: 'workspace-1',
        targetPath: 'docs/bread-docs',
        repoId: 42,
        hostedRootFolderId: 'hosted-root',
      },
    )

    expect(result.documents.map((document) => document.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000006',
    ])
    expect(result.files.map((file) => file.path)).toEqual([
      'docs/bread-docs/developers/sdks/node-sdk.md',
      'docs/bread-docs/developers/setup.mdx',
      'docs/bread-docs/help-center/contact.md',
      'docs/bread-docs/help-center/faq.md',
    ])
    expect(result.restrictedFolderNames).toEqual([])
  })

  it('links an exported external identity without changing the internal row id', async () => {
    const documentId = '00000000-0000-4000-8000-000000000001'
    const breadDocumentId = '00000000-0000-4000-8000-000000000099'
    const workspaceEq = vi.fn().mockResolvedValue({ error: null })
    const documentEq = vi.fn().mockReturnValue({ eq: workspaceEq })
    const update = vi.fn().mockReturnValue({ eq: documentEq })
    const from = vi.fn().mockReturnValue({ update })

    await linkBreadWorkspaceDocuments(
      { from } as never,
      {
        workspaceId: 'workspace-1',
        repoId: 42,
        repoFullName: 'acme/docs',
        ref: 'main',
        commitSha: 'commit-1',
        exported: {
          files: [{
            documentId,
            breadDocumentId,
            path: 'docs/setup.md',
            content: '',
          }],
          documents: [{
            id: documentId,
            title: 'Setup',
            content: 'Current.',
            source: 'docs',
            source_metadata: {},
            public_slug: null,
            folder_id: null,
            updated_at: null,
          }],
          managedPaths: [],
          restrictedFolderNames: [],
          totalBytes: 0,
        },
      },
    )

    expect(update).toHaveBeenCalledWith({
      source_metadata: expect.objectContaining({
        canonical_repo_path: 'docs/setup.md',
        bread_document_id: breadDocumentId,
      }),
    })
    expect(documentEq).toHaveBeenCalledWith('id', documentId)
    expect(workspaceEq).toHaveBeenCalledWith('workspace_id', 'workspace-1')
  })
})
