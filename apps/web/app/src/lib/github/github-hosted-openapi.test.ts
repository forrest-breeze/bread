import { describe, expect, it } from 'vitest'
import { parseApiOperation } from '@/lib/portal/api-reference-model'
import {
  isHostedOpenApiFile,
  MAX_OPENAPI_OPERATIONS,
  openApiFolderName,
  parseHostedOpenApiSpec,
} from './github-hosted-openapi'
import type { GitHubTreeEntry } from './github'

function blob(path: string): GitHubTreeEntry {
  return { path, type: 'blob', sha: 'sha', mode: '100644' } as GitHubTreeEntry
}

const petstore = {
  openapi: '3.0.3',
  info: { title: 'Petstore API', version: '1.2.0' },
  tags: [{ name: 'pets' }, { name: 'store' }],
  paths: {
    '/pets': {
      get: {
        tags: ['pets'],
        summary: 'List pets',
        operationId: 'listPets',
        parameters: [
          { name: 'limit', in: 'query', description: 'Max | items', schema: { type: 'integer', format: 'int32' } },
        ],
        responses: {
          '200': {
            description: 'A page of pets',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
              },
            },
          },
        },
      },
      post: {
        tags: ['pets'],
        summary: 'Create a pet',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NewPet' } },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', schema: { type: 'string' } }],
      get: {
        tags: ['pets'],
        operationId: 'getPet',
        responses: { '404': { $ref: '#/components/responses/NotFound' } },
      },
    },
    '/orders': {
      post: { tags: ['store'], summary: 'Place order', responses: { '200': { description: 'OK' } } },
    },
    '/health': {
      get: { responses: { '200': { description: 'OK' } } },
    },
  },
  components: {
    responses: { NotFound: { description: 'Not found' } },
    schemas: {
      Pet: {
        allOf: [
          { $ref: '#/components/schemas/NewPet' },
          { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
        ],
      },
      NewPet: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Pet name', example: 'Rex' },
          tag: { type: 'string' },
          parent: { $ref: '#/components/schemas/NewPet' },
        },
      },
    },
  },
}

function parse(spec: unknown, specPath = 'docs/api/openapi.json') {
  return parseHostedOpenApiSpec({ specPath, raw: JSON.stringify(spec), repoId: 42 })
}

describe('isHostedOpenApiFile', () => {
  it('matches spec file names inside selected roots only', () => {
    expect(isHostedOpenApiFile(blob('docs/openapi.json'), ['docs'])).toBe(true)
    expect(isHostedOpenApiFile(blob('docs/api/Swagger.json'), ['docs'])).toBe(true)
    expect(isHostedOpenApiFile(blob('docs/billing.openapi.json'), ['docs'])).toBe(true)
    expect(isHostedOpenApiFile(blob('openapi.json'), ['docs'])).toBe(false)
    expect(isHostedOpenApiFile(blob('docs/package.json'), ['docs'])).toBe(false)
    expect(isHostedOpenApiFile(blob('docs/openapi.yaml'), ['docs'])).toBe(false)
    expect(
      isHostedOpenApiFile({ ...blob('docs/openapi.json'), type: 'tree' } as GitHubTreeEntry, ['docs']),
    ).toBe(false)
  })
})

describe('parseHostedOpenApiSpec', () => {
  it('generates one page per operation, grouped and ordered by tag', () => {
    const { spec, issues } = parse(petstore)
    expect(issues).toEqual([])
    expect(spec?.title).toBe('Petstore API')
    expect(spec?.version).toBe('1.2.0')
    expect(spec?.operations.map((op) => [op.key, op.tag, op.tagOrder, op.order, op.title])).toEqual([
      ['GET /pets', 'pets', 0, 0, 'List pets'],
      ['POST /pets', 'pets', 0, 1, 'Create a pet'],
      ['GET /pets/{petId}', 'pets', 0, 2, 'getPet'],
      ['POST /orders', 'store', 1, 0, 'Place order'],
      ['GET /health', 'Endpoints', 2, 0, 'GET /health'],
    ])
  })

  it('writes content the API reference can read the method and path from', () => {
    const { spec } = parse(petstore)
    for (const operation of spec!.operations) {
      expect(parseApiOperation(operation.title, operation.content)).toEqual({
        method: operation.method,
        path: operation.path,
      })
    }
  })

  it('renders parameters, request bodies with resolved refs, and responses', () => {
    const { spec } = parse(petstore)
    const [list, create, get] = spec!.operations
    expect(list!.content).toContain('| `limit` | query | integer<int32> | No | Max \\| items |')
    expect(list!.content).toContain('### Example `200` response')
    expect(list!.content).toContain('"name": "Rex"')
    expect(create!.content).toContain('`application/json` (required)')
    expect(create!.content).toContain('| `name` | string | Yes | Pet name |')
    expect(create!.content).toContain('| `parent` | NewPet | No |')
    // Path-level parameters are inherited and always required.
    expect(get!.content).toContain('| `petId` | path | string | Yes |')
    expect(get!.content).toContain('| `404` | Not found |')
  })

  it('terminates on self-referencing schemas', () => {
    const { spec } = parse(petstore)
    const create = spec!.operations[1]!
    expect(create.content).toContain('"parent": {}')
  })

  it('produces unique, stable public slugs', () => {
    const first = parse(petstore).spec!.operations.map((op) => op.publicSlug)
    const second = parse(petstore).spec!.operations.map((op) => op.publicSlug)
    expect(new Set(first).size).toBe(first.length)
    expect(first).toEqual(second)
    expect(first[0]).toMatch(/^github-42-docs-api-openapi-listpets-[0-9a-f]{8}$/)
  })

  it('supports Swagger 2.0 body parameters and definitions', () => {
    const { spec, issues } = parse({
      swagger: '2.0',
      info: { title: 'Legacy', version: '1' },
      consumes: ['application/json'],
      paths: {
        '/users': {
          post: {
            summary: 'Create user',
            parameters: [
              { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/User' } },
              { name: 'X-Trace', in: 'header', type: 'string' },
            ],
            responses: { '200': { description: 'OK', schema: { $ref: '#/definitions/User' } } },
          },
        },
      },
      definitions: {
        User: { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
      },
    })
    expect(issues).toEqual([])
    const content = spec!.operations[0]!.content
    expect(content).toContain('| `X-Trace` | header | string | No |')
    expect(content).not.toContain('| `body` |')
    expect(content).toContain('| `email` | string<email> | No |')
    expect(content).toContain('"email": "user@example.com"')
  })

  it('reads YAML definitions the same way as JSON', () => {
    const raw = [
      'openapi: 3.0.3',
      'info:',
      '  title: Payments API',
      '  version: 2025-01-15',
      'paths:',
      '  /payments:',
      '    get:',
      '      operationId: listPayments',
      '      summary: List payments',
      '      responses:',
      "        '200':",
      '          description: OK',
    ].join('\n')
    const { spec, issues } = parseHostedOpenApiSpec({ specPath: 'reference/payments.yaml', raw, repoId: 1 })
    expect(issues).toEqual([])
    expect(spec?.title).toBe('Payments API')
    // No timestamp coercion: the version stays the string the author wrote.
    expect(spec?.version).toBe('2025-01-15')
    expect(spec?.operations.map((operation) => operation.key)).toEqual(['GET /payments'])
    expect(spec?.operations[0]!.publicSlug).toMatch(/^github-1-reference-payments-listpayments-/)
  })

  it('reports invalid specs as issues against the file', () => {
    expect(parse('nope').issues).toEqual([{ path: 'docs/api/openapi.json', message: 'must be a JSON or YAML object' }])
    expect(
      parseHostedOpenApiSpec({ specPath: 'docs/openapi.json', raw: '{', repoId: 1 }).issues[0]!.message,
    ).toBe('must be valid JSON or YAML')
    expect(
      parseHostedOpenApiSpec({ specPath: 'docs/openapi.yaml', raw: 'openapi: [unclosed', repoId: 1 }).issues[0]!.message,
    ).toBe('must be valid JSON or YAML')
    expect(parse({ openapi: '2.5.0', paths: {} }).issues[0]!.message).toMatch(/must declare/)
    expect(parse({ openapi: '3.1.0' }).issues[0]!.message).toMatch(/paths/)
    expect(parse({ openapi: '3.1.0', paths: {} }).issues[0]!.message).toMatch(/does not define/)
  })

  it('caps the number of generated pages', () => {
    const paths = Object.fromEntries(
      Array.from({ length: MAX_OPENAPI_OPERATIONS + 1 }, (_, index) => [
        `/r${index}`,
        { get: { responses: {} } },
      ]),
    )
    expect(parse({ openapi: '3.0.0', paths }).issues[0]!.message).toMatch(/limit/)
  })
})

describe('openApiFolderName', () => {
  it('is stable per spec and per tag', () => {
    expect(openApiFolderName(42, 'docs/openapi.json')).toBe(openApiFolderName(42, 'docs/openapi.json'))
    expect(openApiFolderName(42, 'docs/openapi.json', 'pets')).not.toBe(
      openApiFolderName(42, 'docs/openapi.json', 'store'),
    )
  })
})
