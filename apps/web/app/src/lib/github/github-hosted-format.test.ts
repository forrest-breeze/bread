import { describe, expect, it } from 'vitest'
import { validateBreezifyHostedDocsFiles } from './github-hosted-format'

function doc(
  path: string,
  title: string,
  id: string,
): { path: string; content: string } {
  return {
    path,
    content: [
      '---',
      `title: ${JSON.stringify(title)}`,
      `breezify_document_id: ${JSON.stringify(id)}`,
      '---',
      '',
      `# ${title}`,
      '',
      'Body',
      '',
    ].join('\n'),
  }
}

describe('Breezify hosted docs format', () => {
  it('accepts the exact exported document format', () => {
    expect(validateBreezifyHostedDocsFiles([
      doc(
        'docs/getting-started.md',
        'Getting Started',
        '00000000-0000-4000-8000-000000000001',
      ),
    ])).toEqual([])
  })

  it('rejects missing metadata and title drift', () => {
    const issues = validateBreezifyHostedDocsFiles([{
      path: 'docs/setup.md',
      content: '---\ntitle: "Setup"\n---\n\n# Install\n',
    }])

    expect(issues.map((issue) => issue.message)).toEqual([
      'frontmatter must contain title, breezify_document_id, and an optional date',
    ])
  })

  it('accepts a dated entry and still identifies it', () => {
    const dated = {
      path: 'docs/changelog/2026-08-17-portal-pages.md',
      content: [
        '---',
        'title: "Portal pages"',
        'breezify_document_id: "00000000-0000-4000-8000-000000000002"',
        'date: "2026-08-17T17:00:00Z"',
        '---',
        '',
        '# Portal pages',
        '',
        'Body',
        '',
      ].join('\n'),
    }

    expect(validateBreezifyHostedDocsFiles([dated])).toEqual([])
    // The dated shape must not slip past the duplicate-identity scan.
    expect(
      validateBreezifyHostedDocsFiles([
        dated,
        doc('docs/b.md', 'B', '00000000-0000-4000-8000-000000000002'),
      ]),
    ).toContainEqual({
      path: 'docs/b.md',
      message: `reuses breezify_document_id from ${dated.path}`,
    })
  })

  it('rejects an unparseable date and any other third key', () => {
    const frontmatter = (third: string): { path: string; content: string } => ({
      path: 'docs/entry.md',
      content: [
        '---',
        'title: "Entry"',
        'breezify_document_id: "00000000-0000-4000-8000-000000000003"',
        third,
        '---',
        '',
        '# Entry',
        '',
      ].join('\n'),
    })

    expect(
      validateBreezifyHostedDocsFiles([frontmatter('date: "not-a-date"')]).map(
        (issue) => issue.message,
      ),
    ).toEqual([
      'the optional third frontmatter line must be a quoted ISO 8601 date',
    ])
    expect(
      validateBreezifyHostedDocsFiles([frontmatter('author: "Ada"')]).map(
        (issue) => issue.message,
      ),
    ).toEqual([
      'the optional third frontmatter line must be a quoted ISO 8601 date',
    ])
  })

  it('rejects duplicate document identities', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    expect(validateBreezifyHostedDocsFiles([
      doc('docs/a.md', 'A', id),
      doc('docs/b.md', 'B', id),
    ])).toContainEqual({
      path: 'docs/b.md',
      message: 'reuses breezify_document_id from docs/a.md',
    })
  })
})
