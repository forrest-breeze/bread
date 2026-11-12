import { describe, expect, it } from 'vitest'
import {
  buildGitHubBootstrapFiles,
  githubHostedDocsBranchPrefix,
  githubHostedDocsPullRequestTitle,
  normalizeBootstrapTargetPath,
  restrictedBootstrapFolderNames,
  type BootstrapDocument,
} from './github-hosted-bootstrap'

describe('GitHub hosted docs bootstrap', () => {
  it('adds the docs tag to pull request titles', () => {
    expect(githubHostedDocsPullRequestTitle('docs', true)).toBe(
      'docs: Update docs from Bread',
    )
    expect(githubHostedDocsPullRequestTitle('docs', false)).toBe(
      'docs: Create docs from Bread',
    )
  })

  it('builds a stable branch prefix for merge recovery', () => {
    expect(githubHostedDocsBranchPrefix('docs/Product Guides')).toBe(
      'bread/docs-docs-product-guides-',
    )
  })

  it('validates a new repository folder path', () => {
    expect(normalizeBootstrapTargetPath(' /docs/product/ ')).toBe('docs/product')
    expect(normalizeBootstrapTargetPath('../docs')).toBeNull()
    expect(normalizeBootstrapTargetPath('docs/product docs')).toBeNull()
  })

  it('maps a Bread folder subtree to new Markdown files', () => {
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [
        { id: 'root', displayName: 'Bread Docs', parentFolderId: null },
        { id: 'child', displayName: 'API & Tools', parentFolderId: 'root' },
      ],
      documents: [
        {
          id: 'doc-1',
          title: 'Getting Started',
          folderId: 'root',
          publicSlug: 'getting-started',
          contentMarkdown: 'Welcome.',
        },
        {
          id: 'doc-2',
          title: 'MCP Setup',
          folderId: 'child',
          contentMarkdown: 'Connect your client.',
        },
      ],
    })

    expect(files.map((file) => file.path)).toEqual([
      'docs/api-and-tools/mcp-setup.md',
      'docs/getting-started.md',
    ])
    const gettingStarted = files.find(
      (file) => file.path === 'docs/getting-started.md',
    )
    expect(gettingStarted?.documentId).toBe('doc-1')
    expect(gettingStarted?.breadDocumentId).toBe('doc-1')
    expect(gettingStarted?.content).toContain('bread_document_id: "doc-1"')
    expect(gettingStarted?.content).toContain('# Getting Started\n\nWelcome.')
  })

  it('creates a non-document placeholder so an empty Bread folder can exist in Git', () => {
    expect(
      buildGitHubBootstrapFiles({
        targetPath: 'docs',
        rootFolderId: 'root',
        folders: [{
          id: 'root',
          displayName: 'Product Docs',
          parentFolderId: null,
          contentMarkdown: 'Product documentation.',
        }],
        documents: [],
      }),
    ).toEqual([{
      documentId: null,
      path: 'docs/.gitkeep',
      content: '',
    }])
  })

  it('preserves a linked canonical path, id, and date despite display-folder renames', () => {
    const documentId = '00000000-0000-4000-8000-000000000001'
    const breadDocumentId = '00000000-0000-4000-8000-000000000099'
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'workspace-root',
      folders: [
        { id: 'workspace-root', displayName: 'Workspace', parentFolderId: null },
        { id: 'hosted-root', displayName: 'GitHub Docs', parentFolderId: 'workspace-root' },
        { id: 'guides', displayName: 'Guides', parentFolderId: 'hosted-root' },
      ],
      documents: [
        {
          id: documentId,
          breadDocumentId,
          title: 'Renamed Setup',
          folderId: 'guides',
          pathRootFolderId: 'hosted-root',
          contentMarkdown: 'Current Bread instructions.',
          canonicalPath: 'docs/old/setup.mdx',
          repositoryContent: [
            '---',
            'title: "Old Setup"',
            `bread_document_id: ${JSON.stringify(breadDocumentId)}`,
            'date: "2026-08-17T17:00:00.000Z"',
            '---',
            '',
            '# Old Setup',
          ].join('\n'),
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          title: 'New Guide',
          folderId: 'guides',
          pathRootFolderId: 'hosted-root',
          contentMarkdown: 'A new document.',
        },
      ],
    })

    expect(files.map((file) => file.path)).toEqual([
      'docs/old/new-guide.md',
      'docs/old/setup.mdx',
    ])
    const setup = files.find((file) => file.path === 'docs/old/setup.mdx')
    expect(setup?.documentId).toBe(documentId)
    expect(setup?.breadDocumentId).toBe(breadDocumentId)
    expect(setup?.content).toContain(
      `bread_document_id: ${JSON.stringify(breadDocumentId)}`,
    )
    expect(setup?.content).toContain('date: "2026-08-17T17:00:00.000Z"')
    expect(setup?.content).toContain('# Renamed Setup\n\nCurrent Bread instructions.')
  })

  it('reuses the exact GitHub file when title and body were not edited', () => {
    const documentId = '00000000-0000-4000-8000-000000000001'
    const repositoryContent = [
      '---',
      'title: "Setup"',
      `bread_document_id: ${JSON.stringify(documentId)}`,
      'date: "2026-08-17"',
      '---',
      '',
      '# Setup',
      '',
      '<Callout>Keep this exact MDX.</Callout>',
    ].join('\r\n')

    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [{ id: 'root', displayName: 'Docs', parentFolderId: null }],
      documents: [{
        id: documentId,
        breadDocumentId: documentId,
        title: 'Setup',
        folderId: 'root',
        contentMarkdown: 'Keep this exact MDX.',
        canonicalPath: 'docs/setup.mdx',
        repositoryContent,
        repositoryContentIsCurrent: true,
        publishedAt: '2026-08-17T00:00:00.000Z',
        updatedAt: '2026-08-29T04:00:00.000Z',
      }],
    })

    expect(files[0]?.content).toBe(repositoryContent)
  })

  it('keeps GitHub date spelling when Bread changes only the body', () => {
    const documentId = '00000000-0000-4000-8000-000000000001'
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [{ id: 'root', displayName: 'Docs', parentFolderId: null }],
      documents: [{
        id: documentId,
        breadDocumentId: documentId,
        title: 'Setup',
        folderId: 'root',
        contentMarkdown: 'A real Bread edit.',
        canonicalPath: 'docs/setup.md',
        repositoryContent: [
          '---',
          'title: "Setup"',
          `bread_document_id: ${JSON.stringify(documentId)}`,
          'date: "2026-08-17"',
          '---',
          '',
          '# Setup',
          '',
          'Old body.',
        ].join('\n'),
        repositoryContentIsCurrent: false,
        publishedAt: '2026-08-17T00:00:00.000Z',
      }],
    })

    expect(files[0]?.content).toContain('date: "2026-08-17"')
    expect(files[0]?.content).toContain('A real Bread edit.')
  })

  it('does not invent a date for an undated GitHub file', () => {
    const documentId = '00000000-0000-4000-8000-000000000001'
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [{ id: 'root', displayName: 'Docs', parentFolderId: null }],
      documents: [{
        id: documentId,
        breadDocumentId: documentId,
        title: 'Setup',
        folderId: 'root',
        contentMarkdown: 'A real Bread edit.',
        canonicalPath: 'docs/setup.md',
        repositoryContent: [
          '---',
          'title: "Setup"',
          `bread_document_id: ${JSON.stringify(documentId)}`,
          '---',
          '',
          '# Setup',
          '',
          'Old body.',
        ].join('\n'),
        repositoryContentIsCurrent: false,
        updatedAt: '2026-08-29T04:00:00.000Z',
      }],
    })

    expect(files[0]?.content).not.toContain('\ndate:')
    expect(files[0]?.content).toContain('A real Bread edit.')
  })

  it('reserves canonical paths before assigning generated paths', () => {
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [
        { id: 'root', displayName: 'Workspace', parentFolderId: null },
        { id: 'guides', displayName: 'Guides', parentFolderId: 'root' },
      ],
      documents: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          title: 'A generated setup',
          folderId: 'guides',
          publicSlug: 'setup',
          contentMarkdown: 'Generated.',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          title: 'Linked setup',
          folderId: 'guides',
          canonicalPath: 'docs/guides/setup.md',
          contentMarkdown: 'Linked.',
        },
      ],
    })

    expect(files.map((file) => file.path)).toEqual([
      'docs/guides/setup-2.md',
      'docs/guides/setup.md',
    ])
  })

  it('inherits stable repository directories from canonical descendants', () => {
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [
        { id: 'root', displayName: 'Bread Docs', parentFolderId: null },
        {
          id: 'developers',
          displayName: 'Developers & AI',
          parentFolderId: 'root',
        },
        {
          id: 'existing-guides',
          displayName: 'Guides',
          parentFolderId: 'developers',
        },
        {
          id: 'new-sdks',
          displayName: 'SDKs',
          parentFolderId: 'developers',
        },
        {
          id: 'help-center',
          displayName: 'Bread Help Center',
          parentFolderId: 'root',
        },
      ],
      documents: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          title: 'Existing guide',
          folderId: 'existing-guides',
          canonicalPath: 'docs/developers/guides/existing.md',
          contentMarkdown: 'Existing.',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          title: 'Node SDK',
          folderId: 'new-sdks',
          contentMarkdown: 'New.',
        },
        {
          id: '00000000-0000-4000-8000-000000000003',
          title: 'Contact',
          folderId: 'help-center',
          canonicalPath: 'docs/help-center/contact.md',
          contentMarkdown: 'Existing.',
        },
        {
          id: '00000000-0000-4000-8000-000000000004',
          title: 'FAQ',
          folderId: 'help-center',
          contentMarkdown: 'New.',
        },
      ],
    })

    expect(files.find((file) => file.documentId?.endsWith('0002'))?.path).toBe(
      'docs/developers/sdks/node-sdk.md',
    )
    expect(files.find((file) => file.documentId?.endsWith('0004'))?.path).toBe(
      'docs/help-center/faq.md',
    )
  })

  it('falls back to display folders when canonical mappings are ambiguous', () => {
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [
        { id: 'root', displayName: 'Bread Docs', parentFolderId: null },
        { id: 'guides', displayName: 'Product Guides', parentFolderId: 'root' },
        { id: 'api', displayName: 'API', parentFolderId: 'guides' },
      ],
      documents: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          title: 'First linked guide',
          folderId: 'guides',
          canonicalPath: 'docs/legacy/first.md',
          contentMarkdown: 'First.',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          title: 'Second linked guide',
          folderId: 'guides',
          canonicalPath: 'docs/reference/second.md',
          contentMarkdown: 'Second.',
        },
        {
          id: '00000000-0000-4000-8000-000000000003',
          title: 'New API guide',
          folderId: 'api',
          contentMarkdown: 'New.',
        },
      ],
    })

    expect(files.find((file) => file.documentId?.endsWith('0003'))?.path).toBe(
      'docs/product-guides/api/new-api-guide.md',
    )
  })

  it('does not let repository content establish identity without explicit metadata', () => {
    const documentId = '00000000-0000-4000-8000-000000000001'
    const breadDocumentId = '00000000-0000-4000-8000-000000000099'
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [{ id: 'root', displayName: 'Workspace', parentFolderId: null }],
      documents: [{
        id: documentId,
        title: 'Setup',
        folderId: 'root',
        contentMarkdown: 'Current.',
        canonicalPath: 'docs/setup.mdx',
        repositoryContent: [
          '---',
          'title: "Setup"',
          `bread_document_id: ${JSON.stringify(breadDocumentId)}`,
          'date: "2026-08-17T17:00:00.000Z"',
          '---',
          '',
          '# Setup',
        ].join('\n'),
      }],
    })

    expect(files[0]?.documentId).toBe(documentId)
    expect(files[0]?.breadDocumentId).toBe(documentId)
    expect(files[0]?.content).toContain(
      `bread_document_id: ${JSON.stringify(documentId)}`,
    )
    expect(files[0]?.content).not.toContain('\ndate:')
  })

  it('does not preserve companion identity or date when explicit identity differs', () => {
    const documentId = '00000000-0000-4000-8000-000000000001'
    const breadDocumentId = '00000000-0000-4000-8000-000000000002'
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [{ id: 'root', displayName: 'Workspace', parentFolderId: null }],
      documents: [{
        id: documentId,
        breadDocumentId,
        title: 'Setup',
        folderId: 'root',
        contentMarkdown: 'Current.',
        canonicalPath: 'docs/setup.mdx',
        repositoryContent: [
          '---',
          'title: "Setup"',
          'bread_document_id: "00000000-0000-4000-8000-000000000099"',
          'date: "2026-08-17T17:00:00.000Z"',
          '---',
          '',
          '# Setup',
        ].join('\n'),
      }],
    })

    expect(files[0]?.documentId).toBe(documentId)
    expect(files[0]?.breadDocumentId).toBe(breadDocumentId)
    expect(files[0]?.content).toContain(
      `bread_document_id: ${JSON.stringify(breadDocumentId)}`,
    )
    expect(files[0]?.content).not.toContain('\ndate:')
  })

  it('finds restricted descendants and inherited restrictions before export', () => {
    expect(
      restrictedBootstrapFolderNames({
        rootFolderId: 'root',
        folders: [
          {
            id: 'root',
            displayName: 'Docs',
            parentFolderId: 'restricted-parent',
            visibility: 'workspace',
          },
          {
            id: 'restricted-parent',
            displayName: 'Internal',
            parentFolderId: null,
            visibility: 'role',
            requiredRole: 'admin',
          },
          {
            id: 'child',
            displayName: 'Admin Runbooks',
            parentFolderId: 'root',
            visibility: 'role',
            requiredRole: 'admin',
          },
        ],
      }),
    ).toEqual(['Admin Runbooks', 'Docs'])
  })
})

// ---------------------------------------------------------------------------
// The `date:` line is what dated feeds (changelog and blog portals) order and
// label entries by. It used to be copied from the repository file being
// replaced, which meant a workspace with no local copy of that file exported no
// date at all — publishing then DELETED the date from GitHub, and it existed
// nowhere else to restore from. Sourcing it from the document's own timestamp
// removes that dependency.
// ---------------------------------------------------------------------------
describe('frontmatter date', () => {
  const documentId = '00000000-0000-4000-8000-000000000010'

  function exportOne(document: Partial<BootstrapDocument>): string {
    const files = buildGitHubBootstrapFiles({
      targetPath: 'docs',
      rootFolderId: 'root',
      folders: [{ id: 'root', displayName: 'Docs', parentFolderId: null }],
      documents: [
        {
          id: documentId,
          title: 'Release notes',
          folderId: 'root',
          contentMarkdown: 'Body.',
          ...document,
        },
      ],
    })
    return files[0]?.content ?? ''
  }

  it('emits the stored publication date with no repository copy', () => {
    expect(exportOne({ publishedAt: '2026-08-17T17:00:00.000Z' })).toContain(
      'date: "2026-08-17T17:00:00.000Z"',
    )
  })

  // Documents dated before the publication field existed still carry their date
  // through the first publish; the sync then stores a real one from the file.
  it('falls back to updated_at when no publication date is stored yet', () => {
    expect(exportOne({ updatedAt: '2026-08-17T17:00:00.000Z' })).toContain(
      'date: "2026-08-17T17:00:00.000Z"',
    )
  })

  it('normalizes a database timestamp to the ISO form the validator requires', () => {
    // Postgres hands back "2026-08-17 17:00:00+00", which is not the shape the
    // format validator accepts verbatim.
    expect(exportOne({ publishedAt: '2026-08-17 17:00:00+00' })).toContain(
      'date: "2026-08-17T17:00:00.000Z"',
    )
  })

  it('prefers the stored publication date over the repository copy', () => {
    const content = exportOne({
      publishedAt: '2026-09-01T00:00:00.000Z',
      repositoryContent: [
        '---',
        'title: "Release notes"',
        `bread_document_id: ${JSON.stringify(documentId)}`,
        'date: "2026-08-17T17:00:00.000Z"',
        '---',
        '',
        '# Release notes',
      ].join('\n'),
    })

    expect(content).toContain('date: "2026-09-01T00:00:00.000Z"')
    expect(content).not.toContain('2026-08-17')
  })

  it('publishes a genuine Bread date edit even when the body is unchanged', () => {
    const repositoryContent = [
      '---',
      'title: "Release notes"',
      `bread_document_id: ${JSON.stringify(documentId)}`,
      'date: "2026-08-17"',
      '---',
      '',
      '# Release notes',
      '',
      'Body.',
      '',
    ].join('\n')
    const content = exportOne({
      publishedAt: '2026-09-01T00:00:00.000Z',
      repositoryContent,
      repositoryContentIsCurrent: true,
    })

    expect(content).not.toBe(repositoryContent)
    expect(content).toContain('date: "2026-09-01T00:00:00.000Z"')
  })

  it('omits the line entirely when there is no usable date', () => {
    expect(exportOne({})).not.toContain('date:')
    expect(exportOne({ publishedAt: 'not a date' })).not.toContain('date:')
  })
})
