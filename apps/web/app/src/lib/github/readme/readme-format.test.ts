import { describe, expect, it } from 'vitest'
import { gitBlobSha, planReadmeExport, type ReadmeExportDocument, type ReadmeExportFolder } from './readme-export'
import {
  frontmatterDate,
  frontmatterSlug,
  isApiReferenceStub,
  isReadmeConfigPage,
  mergeReadmeFrontmatter,
  parseOrderFile,
  parseReadmeFile,
  serializeOrderFile,
  serializeReadmeFile,
} from './readme-frontmatter'
import {
  classifyReadmeTree,
  directoryDisplayName,
  normalizeReadmeRoot,
  readmeFolderDirectories,
  readmeRootFromPaths,
  readReadmeSyncState,
  storedReadmeRoot,
  type ReadmeSyncState,
} from './readme-layout'
import { readmeBodyToMarkdown } from './readme-markdown'
import { specFileContent } from './readme-publish'
import { specSlugForPath } from './readme-sync'

describe('ReadMe frontmatter', () => {
  it('keeps dates and nested keys exactly as written', () => {
    const raw = '---\ntitle: Launch\ndate: 2025-01-15\nmetadata:\n  robots: index\n---\nBody.\n'
    const parsed = parseReadmeFile(raw)
    expect(parsed.frontmatter).toEqual({
      title: 'Launch',
      date: '2025-01-15',
      metadata: { robots: 'index' },
    })
    expect(serializeReadmeFile(parsed.frontmatter, parsed.body)).toBe(raw)
    expect(frontmatterDate(parsed.frontmatter)).toBe('2025-01-15T00:00:00.000Z')
  })

  it('reads a file that is only frontmatter, with or without a final newline', () => {
    const page = '---\ntitle: Customer\nhidden: false\n---'
    expect(parseReadmeFile(page)).toMatchObject({ frontmatter: { title: 'Customer' }, body: '' })
    expect(parseReadmeFile(`${page}\n`).body).toBe('')
    expect(parseReadmeFile('﻿---\r\ntitle: Windows\r\n---\r\nBody\r\n').body).toBe('Body\n')
  })

  it('treats a file without frontmatter as all body', () => {
    expect(parseReadmeFile('# Hello\n')).toMatchObject({
      hasFrontmatter: false,
      frontmatter: {},
      body: '# Hello\n',
    })
  })

  it('reports frontmatter that is not a mapping instead of throwing', () => {
    expect(parseReadmeFile('---\n- a\n- b\n---\n').error).toMatch(/must be a YAML mapping/)
    expect(parseReadmeFile('---\ntitle: [oops\n---\n').error).toMatch(/not valid YAML/)
  })

  it('recognizes generated API pages and ReadMe settings pages', () => {
    expect(isApiReferenceStub({ api: { file: 'openapi.json', operationId: 'getThing' } })).toBe(true)
    expect(isApiReferenceStub({ api: { webhook: 'payment.succeeded' } })).toBe(true)
    expect(isApiReferenceStub({ title: 'API basics' })).toBe(false)
    expect(isReadmeConfigPage({ api_config: 'authentication' })).toBe(true)
    expect(isReadmeConfigPage({ title: 'Authentication' })).toBe(false)
  })

  it('only accepts a slug override that is one URL segment', () => {
    expect(frontmatterSlug({ slug: 'merchant-settlement-faq' })).toBe('merchant-settlement-faq')
    expect(frontmatterSlug({ slug: 'a/b' })).toBeNull()
    expect(frontmatterSlug({})).toBeNull()
  })

  it('changes only the fields Breezify owns when a page is edited', () => {
    const previous = { title: 'Old', excerpt: 'Kept', deprecated: false, hidden: false, next: { pages: [] } }
    const merged = mergeReadmeFrontmatter({ previous, title: 'New', hidden: true })
    expect(merged).toEqual({ ...previous, title: 'New', hidden: true })
    // Key order is the author's.
    expect(Object.keys(merged)).toEqual(Object.keys(previous))
    // `hidden` is not introduced into a file that never had it...
    expect(mergeReadmeFrontmatter({ previous: { title: 'T' }, title: 'T', hidden: false })).toEqual({ title: 'T' })
    // ...unless the page became hidden.
    expect(mergeReadmeFrontmatter({ previous: { title: 'T' }, title: 'T', hidden: true })).toEqual({ title: 'T', hidden: true })
    // A new file states both.
    expect(mergeReadmeFrontmatter({ previous: null, title: 'T', hidden: false })).toEqual({ title: 'T', hidden: false })
  })

  it('writes a changelog date only when it differs from the one in the file', () => {
    const previous = { title: 'Launch', date: '2025-01-15' }
    expect(mergeReadmeFrontmatter({ previous, title: 'Launch', hidden: false, date: '2025-01-15T00:00:00.000Z' }).date).toBe('2025-01-15')
    expect(mergeReadmeFrontmatter({ previous, title: 'Launch', hidden: false, date: '2025-02-01T09:30:00.000Z' }).date).toBe('2025-02-01')
  })

  it('parses and writes _order.yaml', () => {
    expect(parseOrderFile('- Overview & Getting Started\n- api-fundamentals\n- testing.md\n- api-fundamentals\n')).toEqual([
      'Overview & Getting Started',
      'api-fundamentals',
      'testing',
    ])
    expect(parseOrderFile('[]\n')).toEqual([])
    expect(parseOrderFile('')).toEqual([])
    expect(parseOrderFile('key: value\n')).toBeNull()
    expect(serializeOrderFile(['Overview & Getting Started', 'mcp'])).toBe('- Overview & Getting Started\n- mcp\n')
    expect(serializeOrderFile([])).toBe('[]\n')
  })
})

describe('ReadMe Markdown -> Breezify Markdown', () => {
  it('turns callouts into ReadMe-style blockquotes', () => {
    expect(
      readmeBodyToMarkdown('<Callout icon="💡" theme="default">\n  **Understanding ids**\n\n  Every response has two.\n</Callout>'),
    ).toBe('> 💡 **Understanding ids**\n>\n> Every response has two.')
    expect(readmeBodyToMarkdown('<Callout theme="warn">\n  ### Careful\n\n  Read this.\n</Callout>')).toBe(
      '> 🚧 Careful\n>\n> Read this.',
    )
  })

  it('turns anchors, images and embeds into Markdown', () => {
    expect(
      readmeBodyToMarkdown('Contact us <Anchor label="here" target="_blank" href="https://breeze.cash/sales">here</Anchor>.'),
    ).toBe('Contact us [here](https://breeze.cash/sales).')
    expect(readmeBodyToMarkdown('<Image align="center" alt="Settings" src="https://files.example/a.png" />')).toBe(
      '![Settings](https://files.example/a.png)',
    )
    expect(readmeBodyToMarkdown('<Image border={false} src="https://files.example/b.png" />')).toBe(
      '![](https://files.example/b.png)',
    )
    expect(readmeBodyToMarkdown('<Embed url="https://youtu.be/x" title="Demo" />')).toBe('[Demo](https://youtu.be/x)')
  })

  it('unwraps tabs without turning their content into a code block', () => {
    const source = [
      '<Tabs>',
      '  <Tab title="Visa">',
      '    | Card | Result |',
      '    | --- | --- |',
      '    | `4242` | Success |',
      '  </Tab>',
      '  <Tab title="Mastercard">',
      '    Use `5555`.',
      '  </Tab>',
      '</Tabs>',
    ].join('\n')
    expect(readmeBodyToMarkdown(source)).toBe(
      '**Visa**\n\n| Card | Result |\n| --- | --- |\n| `4242` | Success |\n\n**Mastercard**\n\nUse `5555`.',
    )
  })

  it('keeps the HTML table inside <Table>', () => {
    expect(readmeBodyToMarkdown('<Table align={["left","left"]}>\n  <thead>\n    <tr><th>Name</th></tr>\n  </thead>\n</Table>')).toBe(
      '<table>\n  <thead>\n    <tr><th>Name</th></tr>\n  </thead>\n</table>',
    )
  })

  it('leaves placeholders, plain HTML and code alone', () => {
    const source = [
      'Send `Authorization: Basic <YOUR_API_KEY>` or <YOUR_API_KEY> as the user.',
      '',
      '<div class="note">kept<br />here</div>',
      '',
      '```jsx',
      '<Callout>inside code</Callout>',
      'import x from "y"',
      '```',
    ].join('\n')
    expect(readmeBodyToMarkdown(source)).toBe(source)
  })

  it('drops MDX imports and converts legacy magic blocks', () => {
    expect(readmeBodyToMarkdown('import Thing from "./thing"\n\nText.')).toBe('Text.')
    expect(
      readmeBodyToMarkdown('[block:callout]\n{"type":"warning","title":"Heads up","body":"Read this."}\n[/block]'),
    ).toBe('> 🚧 Heads up\n>\n> Read this.')
    expect(
      readmeBodyToMarkdown('[block:image]\n{"images":[{"image":["https://files.example/a.png","a.png"],"caption":"A"}]}\n[/block]'),
    ).toBe('![A](https://files.example/a.png)')
    expect(
      readmeBodyToMarkdown('[block:code]\n{"codes":[{"code":"curl x","language":"shell"}]}\n[/block]'),
    ).toBe('```shell\ncurl x\n```')
    expect(
      readmeBodyToMarkdown('[block:parameters]\n{"data":{"h-0":"Field","h-1":"Type","0-0":"id","0-1":"string"},"cols":2,"rows":1}\n[/block]'),
    ).toBe('| Field | Type |\n| --- | --- |\n| id | string |')
  })
})

describe('ReadMe repository layout', () => {
  const blob = (path: string, size = 10) => ({ path, type: 'blob', sha: `sha-${path}`, size })

  it('classifies pages, order files and API definitions inside the sections', () => {
    const tree = [
      blob('README.md'),
      blob('app/docs/page.tsx'),
      blob('docs/_order.yaml'),
      blob('docs/Core Integration Guide/testing.md'),
      blob('docs/Merchant Onboarding/overview.mdx'),
      blob('docs/.drafts/secret.md'),
      blob('reference/openapi.json'),
      blob('reference/Breeze API/balances/index.md'),
      blob('custom_blocks/footer.md'),
      { path: 'docs', type: 'tree', sha: 'x' },
    ]
    const result = classifyReadmeTree(tree, '')
    expect(result.pages.map((file) => file.path)).toEqual([
      'docs/Core Integration Guide/testing.md',
      'docs/Merchant Onboarding/overview.mdx',
      'reference/Breeze API/balances/index.md',
    ])
    expect(result.orderFiles.map((file) => file.path)).toEqual(['docs/_order.yaml'])
    expect(result.specCandidates.map((file) => file.path)).toEqual(['reference/openapi.json'])
  })

  it('normalizes the project root', () => {
    expect(normalizeReadmeRoot('')).toBe('')
    expect(normalizeReadmeRoot('.')).toBe('')
    expect(normalizeReadmeRoot('/site/docs-root/')).toBe('site/docs-root')
    expect(normalizeReadmeRoot('../etc')).toBeNull()
    expect(normalizeReadmeRoot('a//b')).toBeNull()
    expect(storedReadmeRoot('')).toBe('.')
    expect(readmeRootFromPaths(['.'])).toBe('')
    expect(readmeRootFromPaths(['site'])).toBe('site')
  })

  it('maps directories to folders: guide categories at the top, sections as one folder', () => {
    expect(
      readmeFolderDirectories([
        'docs/Core Integration Guide/customer/kyc/overview.md',
        'docs/loose-page.md',
        'reference/errors.md',
      ]),
    ).toEqual([
      'reference',
      'docs/Core Integration Guide',
      'docs/Core Integration Guide/customer',
      'docs/Core Integration Guide/customer/kyc',
    ])
    expect(directoryDisplayName('reference')).toBe('API Reference')
    expect(directoryDisplayName('docs/Core Integration Guide')).toBe('Core Integration Guide')
    expect(directoryDisplayName('docs/Core Integration Guide/payout-page')).toBe('Payout Page')
  })

  it('ignores recorded state from another root or format', () => {
    const state = { format: 'readme', root: 'site', order_files: { a: { sha: '1', entries: ['x'] } }, managed_paths: ['a'], skipped: [] }
    expect(readReadmeSyncState(state, 'site').managed_paths).toEqual(['a'])
    expect(readReadmeSyncState(state, '').managed_paths).toEqual([])
    expect(readReadmeSyncState(null, '').order_files).toEqual({})
  })

  it('derives API definition names and file formats', () => {
    expect(specSlugForPath('reference/openapi.json')).toBe('openapi')
    expect(specSlugForPath('reference/Payments API.v2.yaml')).toBe('payments-api-v2')
    expect(specFileContent('{"openapi":"3.1.0"}', null)).toBe('{"openapi":"3.1.0"}')
    expect(specFileContent('openapi: 3.1.0\n', 'reference/api.json')).toBe('{\n  "openapi": "3.1.0"\n}\n')
    expect(specFileContent('{"openapi":"3.1.0"}', 'reference/api.yml')).toBe('openapi: 3.1.0\n')
  })
})

describe('planReadmeExport', () => {
  const emptyState: ReadmeSyncState = { format: 'readme', root: '', order_files: {}, managed_paths: [], skipped: [] }
  const folder = (overrides: Partial<ReadmeExportFolder> & { id: string; displayName: string }): ReadmeExportFolder => ({
    parentId: null,
    sortOrder: null,
    markdown: '',
    link: null,
    ...overrides,
  })
  const document = (overrides: Partial<ReadmeExportDocument> & { id: string; title: string }): ReadmeExportDocument => ({
    hidden: false,
    folderId: null,
    sortOrder: null,
    publicSlug: null,
    markdown: 'Body.',
    publishedDate: null,
    link: null,
    ...overrides,
  })
  const linkedFolder = (id: string, displayName: string, path: string): ReadmeExportFolder =>
    folder({
      id,
      displayName,
      link: { path, indexPath: null, indexBlobSha: null, indexMarkdownHash: null, indexTitle: null, indexFrontmatter: null },
    })

  it('names a new guide category the way the existing ones are named', () => {
    const plan = planReadmeExport({
      root: '',
      folders: [
        linkedFolder('f1', 'Core Integration Guide', 'docs/Core Integration Guide'),
        folder({ id: 'f2', displayName: 'Going Live & Beyond' }),
        folder({ id: 'f3', displayName: 'Checklists', parentId: 'f2' }),
      ],
      documents: [document({ id: 'd1', title: 'Launch day', folderId: 'f3' })],
      specs: [],
      tree: new Map(),
      state: emptyState,
    })
    expect(plan.writes.map((write) => write.path)).toEqual(['docs/Going Live & Beyond/checklists/launch-day.md'])
    expect(plan.folders.find((entry) => entry.id === 'f2')?.link.path).toBe('docs/Going Live & Beyond')
  })

  it('slugifies new categories when the repository uses slug-style folders', () => {
    const plan = planReadmeExport({
      root: 'site',
      folders: [linkedFolder('f1', 'Guides', 'site/docs/guides'), folder({ id: 'f2', displayName: 'Going Live & Beyond' })],
      documents: [
        document({ id: 'd1', title: 'Launch day', folderId: 'f2' }),
        document({ id: 'd2', title: 'Launch day', folderId: 'f2' }),
        document({ id: 'd3', title: 'Index', folderId: 'f2' }),
      ],
      specs: [],
      tree: new Map(),
      state: { ...emptyState, root: 'site' },
    })
    expect(plan.writes.map((write) => write.path)).toEqual([
      'site/docs/going-live-and-beyond/index-page.md',
      'site/docs/going-live-and-beyond/launch-day-2.md',
      'site/docs/going-live-and-beyond/launch-day.md',
    ])
  })

  it('reorders its own pages in _order.yaml and keeps entries it does not mirror', () => {
    const orderPath = 'reference/Breeze API/_order.yaml'
    const orderContent = '- balances\n- notes\n- customers\n- changelog\n- removed-long-ago\n'
    const tree = new Map([
      [orderPath, gitBlobSha(orderContent)],
      // Generated tag folders Breezify does not mirror.
      ['reference/Breeze API/balances/getbalance.md', 'stub-1'],
      ['reference/Breeze API/customers/index.md', 'stub-2'],
      ['reference/Breeze API/notes.md', 'old-notes'],
      ['reference/Breeze API/changelog.md', 'old-changelog'],
    ])
    const page = (id: string, name: string, sortOrder: number): ReadmeExportDocument =>
      document({
        id,
        title: name,
        folderId: 'api',
        sortOrder,
        link: {
          path: `reference/Breeze API/${name}.md`,
          blobSha: `old-${name}`,
          markdownHash: 'stale',
          title: name,
          hidden: false,
          frontmatter: { title: name },
          frontmatterRaw: null,
          conflict: false,
        },
      })
    const plan = planReadmeExport({
      root: '',
      folders: [
        linkedFolder('ref', 'API Reference', 'reference'),
        { ...linkedFolder('api', 'Breeze API', 'reference/Breeze API'), parentId: 'ref' },
      ],
      // Breezify swapped the order of its two pages.
      documents: [page('d1', 'changelog', 0), page('d2', 'notes', 1)],
      specs: [],
      tree,
      state: {
        ...emptyState,
        order_files: {
          [orderPath]: {
            sha: gitBlobSha(orderContent),
            entries: ['balances', 'notes', 'customers', 'changelog', 'removed-long-ago'],
          },
        },
        managed_paths: [orderPath, 'reference/Breeze API/notes.md', 'reference/Breeze API/changelog.md'],
      },
    })
    const written = plan.writes.find((write) => write.path === orderPath)
    // Breezify's pages swap inside their own slots; generated entries stay put;
    // the entry for something that no longer exists is dropped.
    expect(written?.content).toBe('- balances\n- changelog\n- customers\n- notes\n')
    expect(plan.deletes).toEqual([])
  })

  it('writes unchanged frontmatter back exactly as the author spelled it', () => {
    // Quoting, folding and a comment that a YAML re-dump would not reproduce.
    const raw = [
      'title: "Moving to Production"',
      'excerpt: >-',
      '  Breeze SDK allows for embedding our payment page on your front-end with little',
      '  to no configuration required.',
      '# reviewed by compliance',
      'hidden: false',
    ].join('\n')
    const frontmatter = parseReadmeFile(`---\n${raw}\n---\nOld body.\n`).frontmatter
    const linked = (title: string): ReadmeExportDocument =>
      document({
        id: 'd1',
        title,
        markdown: 'New body.',
        link: {
          path: 'docs/going-live.md',
          blobSha: 'old',
          markdownHash: 'old',
          title: 'Moving to Production',
          hidden: false,
          frontmatter,
          frontmatterRaw: raw,
          conflict: false,
        },
      })
    const tree = new Map([['docs/going-live.md', 'old']])
    const bodyEdit = planReadmeExport({ root: '', folders: [], documents: [linked('Moving to Production')], specs: [], tree, state: emptyState })
    expect(bodyEdit.writes).toEqual([{ path: 'docs/going-live.md', content: `---\n${raw}\n---\nNew body.\n` }])
    expect(bodyEdit.documents[0]!.frontmatterRaw).toBe(raw)

    // A changed title has to be re-serialized; everything is still there.
    const retitled = planReadmeExport({ root: '', folders: [], documents: [linked('Going live')], specs: [], tree, state: emptyState })
    const written = parseReadmeFile(retitled.writes[0]!.content)
    expect(written.frontmatter).toEqual({ ...frontmatter, title: 'Going live' })
    expect(written.body).toBe('New body.\n')
  })

  it('never deletes files it does not manage', () => {
    const tree = new Map([
      ['reference/Breeze API/balances/_order.yaml', 'a'],
      ['reference/Breeze API/balances/index.md', 'b'],
      ['reference/_order.yaml', 'c'],
      ['docs/guides/old.md', 'd'],
    ])
    const plan = planReadmeExport({
      root: '',
      folders: [],
      documents: [],
      specs: [],
      tree,
      state: { ...emptyState, managed_paths: ['docs/guides/old.md'] },
    })
    // Only the page Breezify imported and no longer has is removed.
    expect(plan.deletes).toEqual(['docs/guides/old.md'])
    expect(plan.writes).toEqual([])
  })

  it('writes an API definition where it already lives, or to reference/ when new', () => {
    const plan = planReadmeExport({
      root: '',
      folders: [],
      documents: [],
      specs: [
        { slug: 'payments-api', raw: '{"openapi":"3.1.0"}', repoPath: 'reference/openapi.json' },
        { slug: 'payouts', raw: 'openapi: 3.1.0\n', repoPath: null },
      ],
      tree: new Map([['reference/openapi.json', gitBlobSha('{"openapi":"3.1.0"}')]]),
      state: emptyState,
    })
    expect(plan.writes).toEqual([{ path: 'reference/payouts.yaml', content: 'openapi: 3.1.0\n' }])
    expect(plan.specs).toEqual([
      expect.objectContaining({ slug: 'payments-api', path: 'reference/openapi.json', written: false }),
      expect.objectContaining({ slug: 'payouts', path: 'reference/payouts.yaml', written: true }),
    ])
  })
})
