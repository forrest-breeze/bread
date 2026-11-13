import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { GitHubTreeEntry } from './github'
import {
  hasCompleteHostedCanonicalPaths,
  hostedDocDate,
  hostedDocumentFolderId,
  hostedFolderReparents,
  inferHostedDirectoryFolders,
  isHostedDocsFile,
  mdxToHostedMarkdown,
  normalizeHostedDocsPaths,
  repositoryFileToHostedMarkdown,
  resolveHostedDirectory,
  shouldApplyGitHubHostedContent,
  shouldDeleteStaleHostedDocument,
  shouldRefreshHostedDocumentIndex,
  shouldSkipGitHubHostedDoc,
} from './github-hosted-docs'

function entry(path: string, overrides: Partial<GitHubTreeEntry> = {}): GitHubTreeEntry {
  return {
    path,
    mode: '100644',
    type: 'blob',
    sha: `sha-${path}`,
    size: 100,
    url: `https://api.github.test/${path}`,
    ...overrides,
  }
}

describe('GitHub hosted docs source helpers', () => {
  const hash = (content: string): string =>
    createHash('sha256').update(content).digest('hex')

  const establishedHelpCenterFolders = () => inferHostedDirectoryFolders({
    roots: ['docs/breezify-docs'],
    documents: [{
      canonicalPath: 'docs/breezify-docs/help-center/setup/existing.md',
      folderId: 'setup-folder',
      deletedAt: null,
    }],
    folders: [
      { id: 'setup-folder', parentFolderId: 'help-center-folder' },
      { id: 'help-center-folder', parentFolderId: null },
    ],
  })

  it('normalizes selections and removes descendants already covered by a parent', () => {
    expect(normalizeHostedDocsPaths([
      '/docs/product/',
      'docs/product/developer',
      ' docs/help ',
      '../invalid',
    ])).toEqual(['docs/help', 'docs/product'])
  })

  it('selects Markdown and MDX below a chosen folder only', () => {
    const roots = ['docs/product']
    expect(isHostedDocsFile(entry('docs/product/intro.mdx'), roots)).toBe(true)
    // A selected docs folder is authoritative. Underscore-prefixed files can
    // be real docs (for example `_cli.mdx`), so naming alone must not silently
    // exclude them from the linked document set.
    expect(isHostedDocsFile(entry('docs/product/_partial.mdx'), roots)).toBe(true)
    expect(isHostedDocsFile(entry('docs/product/blank.md', { size: 0 }), roots)).toBe(true)
    expect(isHostedDocsFile(entry('docs/internal/plan.md'), roots)).toBe(false)
    expect(isHostedDocsFile(entry('docs/product/logo.png'), roots)).toBe(false)
  })

  it('keeps a declared entry date and ignores an unusable one', () => {
    // A dated file owns its document's updated_at, which is what the changelog
    // feed orders by; anything unparseable falls back to the sync clock (null).
    expect(hostedDocDate('2026-08-17T17:00:00Z')).toBe('2026-08-17T17:00:00.000Z')
    expect(hostedDocDate('2026-08-17')).toBe('2026-08-17T00:00:00.000Z')
    expect(hostedDocDate('last tuesday')).toBeNull()
    expect(hostedDocDate(undefined)).toBeNull()
  })

  it('converts MDX without executing components or damaging fenced code', () => {
    const markdown = mdxToHostedMarkdown([
      'import Tabs from "@theme/Tabs"',
      '# Setup',
      '',
      '<Callout>Read this first.</Callout>',
      '',
      '```tsx',
      '<Widget enabled />',
      '```',
    ].join('\n'))

    expect(markdown).not.toContain('import Tabs')
    expect(markdown).not.toContain('# Setup')
    expect(markdown).toContain('Read this first.')
    expect(markdown).toContain('<Widget enabled />')
  })

  it('turns a complete repository file into the curated conflict version', () => {
    expect(repositoryFileToHostedMarkdown([
      '---',
      'title: Setup',
      '---',
      'import Card from "./Card"',
      '# Setup',
      '',
      '<Card>Current GitHub instructions.</Card>',
    ].join('\n'))).toBe('Current GitHub instructions.')
  })

  it('preserves Breezify edits during merge but allows explicit replacement', () => {
    const sourceMetadata = { github_hosted_content_hash: hash('last GitHub version') }

    expect(shouldApplyGitHubHostedContent({
      mode: 'merge',
      currentContent: 'last GitHub version',
      incomingContent: 'new GitHub version',
      sourceMetadata,
    })).toBe(true)
    expect(shouldApplyGitHubHostedContent({
      mode: 'merge',
      currentContent: 'Breezify edit',
      incomingContent: 'new GitHub version',
      sourceMetadata,
    })).toBe(false)
    expect(shouldApplyGitHubHostedContent({
      mode: 'replace_breezify',
      currentContent: 'Breezify edit',
      incomingContent: 'new GitHub version',
      sourceMetadata,
    })).toBe(true)
  })

  it('recognizes a merged Breezify-authored version despite HTML storage', () => {
    const sourceMetadata = { github_hosted_content_hash: hash('old GitHub version') }

    expect(shouldApplyGitHubHostedContent({
      mode: 'merge',
      currentContent: '<h2>Install</h2><p>Run <code>npm i</code> first.</p>',
      incomingContent: '## Install\n\nRun `npm i` first.',
      sourceMetadata,
    })).toBe(true)
  })

  it('does not delete a locally edited document removed from GitHub during merge', () => {
    const sourceMetadata = { github_hosted_content_hash: hash('last GitHub version') }
    expect(shouldDeleteStaleHostedDocument({
      mode: 'merge',
      currentContent: 'Breezify edit',
      sourceMetadata,
    })).toBe(false)
    expect(shouldDeleteStaleHostedDocument({
      mode: 'merge',
      currentContent: 'last GitHub version',
      sourceMetadata,
    })).toBe(true)
  })

  it('indexes a first merged publish even when its content already matches', () => {
    expect(shouldRefreshHostedDocumentIndex({
      priorStatus: 'Draft',
      currentContent: 'Merged content',
      incomingContent: 'Merged content',
    })).toBe(true)
    expect(shouldRefreshHostedDocumentIndex({
      priorStatus: 'Published',
      currentContent: 'Merged content',
      incomingContent: 'Merged content',
    })).toBe(false)
  })

  it('infers every established directory prefix from canonical folder ancestry', () => {
    const cache = establishedHelpCenterFolders()

    expect(Object.fromEntries(cache)).toEqual({
      'help-center': 'help-center-folder',
      'help-center/setup': 'setup-folder',
    })
    expect(resolveHostedDirectory({
      relativeDirectory: 'help-center/setup',
      rootFolderId: 'hosted-root',
      cache,
    })).toEqual({
      parentFolderId: 'setup-folder',
      existingPrefix: 'help-center/setup',
      missingSegments: [],
    })
  })

  it('uses the deepest established ancestor for new-folder placement and access', () => {
    expect(resolveHostedDirectory({
      relativeDirectory: 'help-center/troubleshooting',
      rootFolderId: 'hosted-root',
      cache: establishedHelpCenterFolders(),
    })).toEqual({
      parentFolderId: 'help-center-folder',
      existingPrefix: 'help-center',
      missingSegments: ['troubleshooting'],
    })
  })

  it('does not choose arbitrarily between canonical mirror folders', () => {
    const cache = inferHostedDirectoryFolders({
      roots: ['docs/breezify-docs'],
      documents: [
        {
          canonicalPath: 'docs/breezify-docs/help-center/setup/first.md',
          folderId: 'setup-folder-a',
          deletedAt: null,
        },
        {
          canonicalPath: 'docs/breezify-docs/help-center/setup/second.md',
          folderId: 'setup-folder-b',
          deletedAt: null,
        },
      ],
      folders: [
        { id: 'setup-folder-a', parentFolderId: 'help-center-folder' },
        { id: 'setup-folder-b', parentFolderId: 'help-center-folder' },
        { id: 'help-center-folder', parentFolderId: null },
      ],
    })

    expect(cache.get('help-center')).toBe('help-center-folder')
    expect(cache.has('help-center/setup')).toBe(false)
  })

  it('ignores deleted canonical rows when inferring folder reuse', () => {
    const cache = inferHostedDirectoryFolders({
      roots: ['docs/breezify-docs'],
      documents: [
        {
          canonicalPath: 'docs/breezify-docs/help-center/setup/live.md',
          folderId: 'live-setup-folder',
          deletedAt: null,
        },
        {
          canonicalPath: 'docs/breezify-docs/help-center/setup/deleted.md',
          folderId: 'deleted-setup-folder',
          deletedAt: '2026-08-19T12:00:00.000Z',
        },
        {
          canonicalPath: 'docs/breezify-docs/help-center/archive/deleted.md',
          folderId: 'archive-folder',
          deletedAt: '2026-08-19T12:00:00.000Z',
        },
      ],
      folders: [
        { id: 'live-setup-folder', parentFolderId: 'help-center-folder' },
        { id: 'deleted-setup-folder', parentFolderId: 'deleted-help-center-folder' },
        { id: 'archive-folder', parentFolderId: 'deleted-help-center-folder' },
        { id: 'help-center-folder', parentFolderId: null },
        { id: 'deleted-help-center-folder', parentFolderId: null },
      ],
    })

    expect(cache.get('help-center')).toBe('help-center-folder')
    expect(cache.get('help-center/setup')).toBe('live-setup-folder')
    expect(cache.has('help-center/archive')).toBe(false)
  })

  it('requires every selected repository path before taking the same-commit shortcut', () => {
    const input = {
      roots: ['docs/breezify-docs'],
      expectedPaths: [
        'docs/breezify-docs/help-center/first.md',
        'docs/breezify-docs/help-center/missing.md',
      ],
      documents: [
        {
          canonicalPath: 'docs/breezify-docs/help-center/first.md',
          folderId: 'help-center-a',
          deletedAt: null,
        },
        {
          canonicalPath: 'docs/breezify-docs/help-center/first.md',
          folderId: 'help-center-b',
          deletedAt: null,
        },
      ],
    }

    expect(hasCompleteHostedCanonicalPaths(input)).toBe(false)
    expect(hasCompleteHostedCanonicalPaths({
      ...input,
      documents: [
        ...input.documents,
        {
          canonicalPath: 'docs/breezify-docs/help-center/missing.md',
          folderId: 'help-center-a',
          deletedAt: null,
        },
      ],
    })).toBe(true)
    expect(hasCompleteHostedCanonicalPaths({
      ...input,
      documents: [
        ...input.documents,
        {
          canonicalPath: 'docs/breezify-docs/help-center/missing.md',
          folderId: 'help-center-a',
          deletedAt: null,
        },
        {
          canonicalPath: 'docs/breezify-docs/help-center/stale.md',
          folderId: 'help-center-a',
          deletedAt: null,
        },
      ],
    })).toBe(false)
  })

  it('does not let deleted or out-of-root canonical rows satisfy integrity', () => {
    expect(hasCompleteHostedCanonicalPaths({
      roots: ['docs/breezify-docs'],
      expectedPaths: [
        'docs/breezify-docs/help-center/missing.md',
        'docs/other/ignored.md',
      ],
      documents: [
        {
          canonicalPath: 'docs/breezify-docs/help-center/missing.md',
          folderId: 'deleted-folder',
          deletedAt: '2026-08-19T18:00:00.000Z',
        },
        {
          canonicalPath: 'docs/other/ignored.md',
          folderId: 'other-folder',
          deletedAt: null,
        },
      ],
    })).toBe(false)
  })

  it('treats the selected repository root as the workspace root', () => {
    const cache = establishedHelpCenterFolders()

    // A top-level file is folderless; a file in an established directory
    // lives in that directory's folder; an unresolved directory is a bug.
    expect(hostedDocumentFolderId({ relativeDirectory: '', cache })).toBeNull()
    expect(hostedDocumentFolderId({
      relativeDirectory: 'help-center/setup',
      cache,
    })).toBe('setup-folder')
    expect(() => hostedDocumentFolderId({ relativeDirectory: 'guides', cache }))
      .toThrow('hosted directory was not resolved: guides')

    // A brand-new top-level directory is created at the workspace root, not
    // inside a connector-owned container folder.
    expect(resolveHostedDirectory({
      relativeDirectory: 'guides',
      rootFolderId: null,
      cache,
    })).toEqual({
      parentFolderId: null,
      existingPrefix: '',
      missingSegments: ['guides'],
    })
  })

  it('moves established directory folders to mirror the repository tree', () => {
    // The pre-refactor sync nested everything under a "<Repo> Docs" wrapper.
    // Replace mode lifts top-level directories to the workspace root and puts
    // nested directories under their parent directory's folder.
    expect(hostedFolderReparents({
      cache: new Map([
        ['getting-started', 'getting-started-folder'],
        ['developers', 'developers-folder'],
        ['developers/api', 'api-folder'],
        ['developers/mcp', 'mcp-folder'],
      ]),
      folders: [
        { id: 'wrapper-folder', parentFolderId: null },
        { id: 'getting-started-folder', parentFolderId: 'wrapper-folder' },
        { id: 'developers-folder', parentFolderId: 'wrapper-folder' },
        { id: 'api-folder', parentFolderId: 'developers-folder' },
        { id: 'mcp-folder', parentFolderId: 'wrapper-folder' },
      ],
    })).toEqual([
      { folderId: 'getting-started-folder', parentFolderId: null },
      { folderId: 'developers-folder', parentFolderId: null },
      { folderId: 'mcp-folder', parentFolderId: 'developers-folder' },
    ])
  })

  it('skips folder moves without a resolved parent, for unknown folders, and cycles', () => {
    expect(hostedFolderReparents({
      cache: new Map([
        // Parent directory has no resolved folder yet: nothing to move under.
        ['developers/api', 'api-folder'],
        // Created during this sync, so already in place and not in the rows.
        ['guides', 'new-guides-folder'],
        // Moving b-folder under a-folder would put a-folder inside itself.
        ['a', 'a-folder'],
        ['a/b', 'b-folder'],
      ]),
      folders: [
        { id: 'api-folder', parentFolderId: 'developers-folder' },
        { id: 'developers-folder', parentFolderId: null },
        { id: 'b-folder', parentFolderId: null },
        { id: 'a-folder', parentFolderId: 'b-folder' },
      ],
    })).toEqual([{ folderId: 'a-folder', parentFolderId: null }])
  })

  it('retains canonical folder reuse when a force run bypasses content checkpoints', () => {
    const cache = establishedHelpCenterFolders()

    expect(resolveHostedDirectory({
      relativeDirectory: 'help-center/setup',
      rootFolderId: 'hosted-root',
      cache,
    }).parentFolderId).toBe('setup-folder')
    expect(shouldSkipGitHubHostedDoc({
      mode: 'merge',
      force: true,
      currentBlobSha: 'blob-current',
      currentCommitSha: 'commit-current',
      lastSyncCommitSha: 'commit-previous',
      checkpoints: [{
        blobSha: 'blob-current',
        mode: 'merge',
        deletedAt: null,
      }],
    })).toBe(false)
  })

  it('resumes merge syncs only from fully checkpointed current blobs', () => {
    const decision = (overrides: Partial<Parameters<typeof shouldSkipGitHubHostedDoc>[0]> = {}) =>
      shouldSkipGitHubHostedDoc({
        mode: 'merge',
        force: false,
        currentBlobSha: 'blob-current',
        currentCommitSha: 'commit-current',
        lastSyncCommitSha: 'commit-previous',
        checkpoints: [{
          blobSha: 'blob-current',
          mode: 'merge',
          deletedAt: null,
        }],
        ...overrides,
      })

    expect(decision()).toBe(true)
    expect(decision({
      checkpoints: [
        { blobSha: 'blob-current', mode: 'merge', deletedAt: null },
        { blobSha: 'blob-current', mode: 'merge', deletedAt: null },
      ],
    })).toBe(true)
    expect(decision({
      checkpoints: [
        { blobSha: 'blob-current', mode: 'merge', deletedAt: null },
        { blobSha: 'blob-previous', mode: 'merge', deletedAt: null },
      ],
    })).toBe(false)
    expect(decision({ checkpoints: [] })).toBe(false)
    expect(decision({
      checkpoints: [{ blobSha: 'blob-current', mode: 'merge', deletedAt: '2026-08-19' }],
    })).toBe(false)
    expect(decision({ force: true })).toBe(false)
    // A killed forced replacement is retried later without `force`; completed
    // files must resume in that mode too, while the initial force run bypasses
    // every checkpoint.
    expect(decision({ mode: 'replace_breezify' })).toBe(false)
    expect(decision({
      mode: 'replace_breezify',
      checkpoints: [{
        blobSha: 'blob-current',
        mode: 'replace_breezify',
        deletedAt: null,
        appliedCommitSha: 'commit-current',
      }],
    })).toBe(true)
    expect(decision({
      mode: 'replace_breezify',
      force: true,
      checkpoints: [{
        blobSha: 'blob-current',
        mode: 'replace_breezify',
        deletedAt: null,
        appliedCommitSha: 'commit-current',
      }],
    })).toBe(false)
    expect(decision({
      mode: 'replace_breezify',
      checkpoints: [{
        blobSha: 'blob-current',
        mode: 'replace_breezify',
        deletedAt: null,
        appliedCommitSha: 'commit-previous',
      }],
    })).toBe(false)
  })

  it('resumes pre-checkpoint rows from the current commit without hiding conflicts from replace', () => {
    const legacyCheckpoint = (overrides: Partial<Parameters<typeof shouldSkipGitHubHostedDoc>[0]> = {}) =>
      shouldSkipGitHubHostedDoc({
        mode: 'merge',
        force: false,
        currentBlobSha: 'blob-current',
        currentCommitSha: 'commit-current',
        lastSyncCommitSha: 'commit-previous',
        checkpoints: [{
          blobSha: null,
          mode: null,
          deletedAt: null,
          appliedCommitSha: 'commit-current',
        }],
        ...overrides,
      })

    expect(legacyCheckpoint()).toBe(true)
    expect(legacyCheckpoint({
      checkpoints: [{
        blobSha: null,
        mode: null,
        deletedAt: null,
        pendingCommitSha: 'commit-current',
        conflict: true,
      }],
    })).toBe(true)
    expect(legacyCheckpoint({
      checkpoints: [{
        blobSha: null,
        mode: null,
        deletedAt: null,
        pendingCommitSha: 'commit-current',
        conflict: false,
      }],
    })).toBe(false)
    expect(legacyCheckpoint({
      mode: 'replace_breezify',
      checkpoints: [{
        blobSha: null,
        mode: null,
        deletedAt: null,
        pendingCommitSha: 'commit-current',
        conflict: true,
      }],
    })).toBe(false)
    expect(legacyCheckpoint({ lastSyncCommitSha: 'commit-current' })).toBe(false)
  })
})
