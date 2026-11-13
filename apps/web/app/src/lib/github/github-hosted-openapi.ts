import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import type { GitHubTreeEntry } from './github'

/**
 * OpenAPI definitions synced from a hosted-docs repository.
 *
 * A spec file found under a selected docs root (`openapi.json`,
 * `swagger.json`, or `*.openapi.json`) is parsed into one generated page per
 * operation, grouped into one folder per tag. The pages are read-only mirrors:
 * the spec in the repository is the source of truth, every sync overwrites
 * them, and they are never exported back to GitHub as Markdown files.
 *
 * Everything here is pure so it can be tested without a database.
 */

export const MAX_OPENAPI_SPEC_BYTES = 2 * 1024 * 1024
export const MAX_OPENAPI_OPERATIONS = 500
export const OPENAPI_OPERATION_KIND = 'github_hosted_openapi_operation'

const OPENAPI_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
type OpenApiMethod = (typeof OPENAPI_METHODS)[number]

const MAX_SCHEMA_DEPTH = 6
const MAX_TABLE_PROPERTIES = 50
const UNTAGGED_GROUP = 'Endpoints'

type JsonObject = Record<string, unknown>

export interface OpenApiSpecIssue {
  path: string
  message: string
}

export interface GeneratedOpenApiOperation {
  /** Stable identity within one spec file: `GET /pets/{id}`. */
  key: string
  method: Uppercase<OpenApiMethod>
  path: string
  title: string
  content: string
  tag: string
  /** Position of the tag in the spec, used as the folder sort order. */
  tagOrder: number
  /** Position of the operation within its tag, used as the document sort order. */
  order: number
  publicSlug: string
}

export interface GeneratedOpenApiSpec {
  specPath: string
  /** `info.title`, used as the display name of the spec's folder. */
  title: string
  version: string | null
  operations: GeneratedOpenApiOperation[]
}

export function isHostedOpenApiFile(entry: GitHubTreeEntry, roots: string[]): boolean {
  if (entry.type !== 'blob') return false
  const basename = entry.path.split('/').at(-1)?.toLowerCase() ?? ''
  const isSpecName =
    /^(?:openapi|swagger)\.json$/.test(basename) ||
    /\.(?:openapi|swagger)\.json$/.test(basename)
  if (!isSpecName) return false
  return roots.some((root) => entry.path.startsWith(`${root}/`))
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/** Table cells must stay on one line and must not open a new column. */
function cell(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim() || '—'
}

/** Resolves local `$ref`s (`#/components/...`, `#/definitions/...`). */
function createResolver(spec: JsonObject) {
  return function resolve(value: unknown, seen: Set<string> = new Set()): {
    value: unknown
    refName: string | null
    cyclic: boolean
  } {
    let current = value
    let refName: string | null = null
    for (let hops = 0; hops < 16 && isObject(current) && typeof current.$ref === 'string'; hops++) {
      const ref = current.$ref
      if (!ref.startsWith('#/')) return { value: {}, refName: ref, cyclic: false }
      if (seen.has(ref)) return { value: {}, refName: ref.split('/').at(-1) ?? ref, cyclic: true }
      seen.add(ref)
      refName = ref.split('/').at(-1) ?? ref
      let target: unknown = spec
      for (const rawSegment of ref.slice(2).split('/')) {
        const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
        target = isObject(target) ? target[segment] : undefined
      }
      current = target ?? {}
    }
    return { value: current, refName, cyclic: false }
  }
}

type Resolver = ReturnType<typeof createResolver>

function schemaType(schema: unknown, resolve: Resolver): string {
  const { value, refName } = resolve(schema)
  if (!isObject(value)) return 'any'
  if (refName && value.type === 'object') return refName
  const type = Array.isArray(value.type)
    ? value.type.filter((item) => item !== 'null').join(' | ')
    : text(value.type)
  if (type === 'array') return `array<${schemaType(value.items, resolve)}>`
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const options = value[combinator]
    if (Array.isArray(options) && options.length > 0) {
      const joiner = combinator === 'allOf' ? ' & ' : ' | '
      return options.map((option) => schemaType(option, resolve)).join(joiner)
    }
  }
  const format = text(value.format)
  if (Array.isArray(value.enum) && value.enum.length > 0) {
    return `${type || 'enum'} (${value.enum.slice(0, 8).map((item) => JSON.stringify(item)).join(', ')})`
  }
  return [type || refName || 'any', format ? `<${format}>` : ''].join('')
}

/** Merges `allOf` members so tables and examples see one flat object. */
function flattenSchema(schema: unknown, resolve: Resolver, seen: Set<string> = new Set()): JsonObject {
  const { value, cyclic } = resolve(schema, seen)
  if (!isObject(value) || cyclic) return {}
  if (!Array.isArray(value.allOf)) return value
  const merged: JsonObject = { ...value, properties: {}, required: [] }
  delete merged.allOf
  for (const member of value.allOf) {
    const flat = flattenSchema(member, resolve, new Set(seen))
    merged.type ??= flat.type
    Object.assign(merged.properties as JsonObject, isObject(flat.properties) ? flat.properties : {})
    ;(merged.required as unknown[]).push(...(Array.isArray(flat.required) ? flat.required : []))
  }
  Object.assign(merged.properties as JsonObject, isObject(value.properties) ? value.properties : {})
  ;(merged.required as unknown[]).push(...(Array.isArray(value.required) ? value.required : []))
  return merged
}

function exampleFor(schema: unknown, resolve: Resolver, depth = 0, seen: Set<string> = new Set()): unknown {
  if (depth > MAX_SCHEMA_DEPTH) return null
  const { cyclic } = resolve(schema, new Set(seen))
  if (cyclic) return {}
  // Track refs along this branch only, so siblings may reuse a schema.
  const branch = new Set(seen)
  const value = flattenSchema(schema, resolve, branch)
  if (value.example !== undefined) return value.example
  if (value.default !== undefined) return value.default
  if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0]
  for (const combinator of ['oneOf', 'anyOf'] as const) {
    const options = value[combinator]
    if (Array.isArray(options) && options.length > 0) {
      return exampleFor(options[0], resolve, depth + 1, branch)
    }
  }
  const type = Array.isArray(value.type) ? value.type.find((item) => item !== 'null') : value.type
  if (type === 'array') return [exampleFor(value.items, resolve, depth + 1, branch)]
  if (type === 'object' || isObject(value.properties)) {
    const output: JsonObject = {}
    for (const [name, property] of Object.entries(isObject(value.properties) ? value.properties : {})) {
      output[name] = exampleFor(property, resolve, depth + 1, branch)
    }
    return output
  }
  switch (type) {
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return true
    case 'string':
      if (value.format === 'date-time') return '2024-01-01T00:00:00Z'
      if (value.format === 'date') return '2024-01-01'
      if (value.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
      if (value.format === 'email') return 'user@example.com'
      return 'string'
    default:
      return null
  }
}

function propertyTable(schema: unknown, resolve: Resolver): string[] {
  const flat = flattenSchema(schema, resolve)
  const properties = isObject(flat.properties) ? Object.entries(flat.properties) : []
  if (properties.length === 0) return []
  const required = new Set(Array.isArray(flat.required) ? flat.required : [])
  const lines = [
    '| Field | Type | Required | Description |',
    '| --- | --- | --- | --- |',
  ]
  for (const [name, property] of properties.slice(0, MAX_TABLE_PROPERTIES)) {
    const resolved = resolve(property).value
    lines.push(
      `| \`${cell(name)}\` | ${cell(schemaType(property, resolve))} | ${required.has(name) ? 'Yes' : 'No'} | ${cell(text(isObject(resolved) ? resolved.description : ''))} |`,
    )
  }
  if (properties.length > MAX_TABLE_PROPERTIES) {
    lines.push(`| … | | | ${properties.length - MAX_TABLE_PROPERTIES} more fields |`)
  }
  return lines
}

function jsonBlock(value: unknown): string[] {
  return ['```json', JSON.stringify(value, null, 2), '```']
}

/** Picks the JSON media type when present, else the first one declared. */
function preferredMedia(content: unknown): { type: string; schema: unknown; example: unknown } | null {
  if (!isObject(content)) return null
  const entries = Object.entries(content)
  if (entries.length === 0) return null
  const [type, media] =
    entries.find(([candidate]) => /[/+]json\b/i.test(candidate)) ?? entries[0]!
  if (!isObject(media)) return { type, schema: undefined, example: undefined }
  const firstExample = isObject(media.examples)
    ? Object.values(media.examples).find(isObject)?.value
    : undefined
  return { type, schema: media.schema, example: media.example ?? firstExample }
}

interface OperationContext {
  spec: JsonObject
  resolve: Resolver
  isSwagger2: boolean
  pathItem: JsonObject
  operation: JsonObject
}

function renderParameters(context: OperationContext): string[] {
  const { resolve } = context
  const byKey = new Map<string, JsonObject>()
  const collect = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const raw of list) {
      const parameter = resolve(raw).value
      if (!isObject(parameter)) continue
      const location = text(parameter.in)
      // Swagger 2 bodies and form fields are rendered as the request body.
      if (location === 'body' || location === 'formData') continue
      byKey.set(`${location}:${text(parameter.name)}`, parameter)
    }
  }
  // Operation-level parameters override path-level ones with the same name.
  collect(context.pathItem.parameters)
  collect(context.operation.parameters)
  if (byKey.size === 0) return []
  const lines = [
    '## Parameters',
    '',
    '| Name | In | Type | Required | Description |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const parameter of byKey.values()) {
    const type = parameter.schema !== undefined
      ? schemaType(parameter.schema, resolve)
      : schemaType(parameter, resolve)
    const required = parameter.required === true || parameter.in === 'path'
    lines.push(
      `| \`${cell(text(parameter.name))}\` | ${cell(text(parameter.in))} | ${cell(type)} | ${required ? 'Yes' : 'No'} | ${cell(text(parameter.description))} |`,
    )
  }
  return [...lines, '']
}

function renderRequestBody(context: OperationContext): string[] {
  const { resolve, operation } = context
  let mediaType: string | null = null
  let schema: unknown
  let example: unknown
  let description = ''
  let required = false

  if (context.isSwagger2) {
    const parameters = [
      ...(Array.isArray(context.pathItem.parameters) ? context.pathItem.parameters : []),
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ].map((raw) => resolve(raw).value).filter(isObject)
    const body = parameters.find((parameter) => parameter.in === 'body')
    const consumes = Array.isArray(operation.consumes)
      ? operation.consumes
      : Array.isArray(context.spec.consumes) ? context.spec.consumes : []
    if (body) {
      mediaType = text(consumes[0]) || 'application/json'
      schema = body.schema
      description = text(body.description)
      required = body.required === true
    } else {
      const fields = parameters.filter((parameter) => parameter.in === 'formData')
      if (fields.length === 0) return []
      mediaType = text(consumes[0]) || 'application/x-www-form-urlencoded'
      schema = {
        type: 'object',
        required: fields.filter((field) => field.required === true).map((field) => field.name),
        properties: Object.fromEntries(fields.map((field) => [field.name, field])),
      }
    }
  } else {
    const body = resolve(operation.requestBody).value
    if (!isObject(body)) return []
    const media = preferredMedia(body.content)
    if (!media) return []
    mediaType = media.type
    schema = media.schema
    example = media.example
    description = text(body.description)
    required = body.required === true
  }

  const lines = ['## Request body', '']
  lines.push(`\`${mediaType}\`${required ? ' (required)' : ''}`, '')
  if (description) lines.push(description, '')
  const table = propertyTable(schema, resolve)
  if (table.length > 0) lines.push(...table, '')
  const sample = example ?? (schema !== undefined ? exampleFor(schema, resolve) : undefined)
  if (sample !== undefined && sample !== null && /json/i.test(mediaType ?? '')) {
    lines.push(...jsonBlock(sample), '')
  }
  return lines
}

function renderResponses(context: OperationContext): string[] {
  const { resolve, operation } = context
  if (!isObject(operation.responses)) return []
  const responses = Object.entries(operation.responses)
  if (responses.length === 0) return []
  const lines = ['## Responses', '', '| Status | Description |', '| --- | --- |']
  for (const [status, raw] of responses) {
    const response = resolve(raw).value
    lines.push(`| \`${cell(status)}\` | ${cell(text(isObject(response) ? response.description : ''))} |`)
  }
  lines.push('')

  // Show an example for the first success response that has a body.
  for (const [status, raw] of responses) {
    if (!/^2/.test(status)) continue
    const response = resolve(raw).value
    if (!isObject(response)) continue
    let schema: unknown
    let example: unknown
    let mediaType = 'application/json'
    if (context.isSwagger2) {
      schema = response.schema
      example = isObject(response.examples)
        ? Object.values(response.examples)[0]
        : undefined
    } else {
      const media = preferredMedia(response.content)
      if (!media) continue
      mediaType = media.type
      schema = media.schema
      example = media.example
    }
    if (schema === undefined && example === undefined) continue
    if (!/json/i.test(mediaType)) continue
    const sample = example ?? exampleFor(schema, resolve)
    if (sample === null || sample === undefined) continue
    lines.push(`### Example \`${status}\` response`, '', ...jsonBlock(sample), '')
    break
  }
  return lines
}

function renderOperation(
  method: Uppercase<OpenApiMethod>,
  path: string,
  context: OperationContext,
): string {
  const { operation } = context
  const lines: string[] = []
  // The API reference reads the method and path from this block.
  lines.push('```http', `${method} ${path}`, '```', '')
  if (operation.deprecated === true) {
    lines.push('> **Deprecated.** This endpoint may be removed in a future version.', '')
  }
  const summary = text(operation.summary)
  const description = text(operation.description)
  if (description) lines.push(description, '')
  else if (summary) lines.push(summary, '')
  lines.push(...renderParameters(context))
  lines.push(...renderRequestBody(context))
  lines.push(...renderResponses(context))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Parse one spec file. Returns issues instead of throwing so the caller can
 * report them alongside Markdown format errors.
 */
export function parseHostedOpenApiSpec(input: {
  specPath: string
  raw: string
  repoId: number
  /** Public-slug prefix. Defaults to `github-<repoId>`; uploads use `openapi`. */
  slugPrefix?: string
}): { spec: GeneratedOpenApiSpec | null; issues: OpenApiSpecIssue[] } {
  const fail = (message: string) => ({
    spec: null,
    issues: [{ path: input.specPath, message }],
  })
  if (Buffer.byteLength(input.raw, 'utf8') > MAX_OPENAPI_SPEC_BYTES) {
    return fail(`exceeds the ${MAX_OPENAPI_SPEC_BYTES}-byte OpenAPI spec limit`)
  }
  let parsed: unknown
  try {
    // JSON is tried first; anything that does not start like JSON is read as
    // YAML, the other format OpenAPI definitions are commonly written in.
    parsed = /^\s*[{[]/.test(input.raw)
      ? JSON.parse(input.raw)
      : yaml.load(input.raw, { schema: yaml.CORE_SCHEMA })
  } catch {
    return fail('must be valid JSON or YAML')
  }
  if (!isObject(parsed)) return fail('must be a JSON or YAML object')
  const openapi = text(parsed.openapi)
  const swagger = text(parsed.swagger)
  const isSwagger2 = swagger.startsWith('2.')
  if (!/^3\.[01]\./.test(openapi) && !isSwagger2) {
    return fail('must declare `openapi: 3.0.x`, `openapi: 3.1.x`, or `swagger: 2.0`')
  }
  if (!isObject(parsed.paths)) return fail('must contain a `paths` object')

  const info = isObject(parsed.info) ? parsed.info : {}
  const declaredTags = Array.isArray(parsed.tags)
    ? parsed.tags.map((tag) => (isObject(tag) ? text(tag.name) : '')).filter(Boolean)
    : []
  const tagOrder = new Map(declaredTags.map((tag, index) => [tag, index]))
  const resolve = createResolver(parsed)
  const specSlug = slugify(input.specPath.replace(/\.(?:json|ya?ml)$/i, '')).slice(0, 40).replace(/-+$/g, '')

  const operations: GeneratedOpenApiOperation[] = []
  const countByTag = new Map<string, number>()
  for (const [path, rawPathItem] of Object.entries(parsed.paths)) {
    const pathItem = resolve(rawPathItem).value
    if (!isObject(pathItem)) continue
    for (const method of OPENAPI_METHODS) {
      const operation = pathItem[method]
      if (!isObject(operation)) continue
      const upper = method.toUpperCase() as Uppercase<OpenApiMethod>
      const key = `${upper} ${path}`
      const tags = Array.isArray(operation.tags) ? operation.tags.map(text).filter(Boolean) : []
      const tag = tags[0] ?? UNTAGGED_GROUP
      if (!tagOrder.has(tag)) tagOrder.set(tag, tagOrder.size)
      const order = countByTag.get(tag) ?? 0
      countByTag.set(tag, order + 1)
      const operationSlug = slugify(text(operation.operationId) || `${method} ${path}`)
        .slice(0, 40)
        .replace(/-+$/g, '')
      operations.push({
        key,
        method: upper,
        path,
        title: text(operation.summary) || text(operation.operationId) || key,
        content: renderOperation(upper, path, {
          spec: parsed,
          resolve,
          isSwagger2,
          pathItem,
          operation,
        }),
        tag,
        tagOrder: tagOrder.get(tag)!,
        order,
        // The hash keeps slugs unique even when truncation or slugification
        // makes two operations look alike.
        publicSlug: `${input.slugPrefix ?? `github-${input.repoId}`}-${specSlug}-${operationSlug}-${shortHash(`${input.specPath}\0${key}`)}`,
      })
    }
  }
  if (operations.length === 0) return fail('does not define any operations')
  if (operations.length > MAX_OPENAPI_OPERATIONS) {
    return fail(`defines ${operations.length} operations; the limit is ${MAX_OPENAPI_OPERATIONS}`)
  }
  return {
    spec: {
      specPath: input.specPath,
      title: text(info.title) || input.specPath.split('/').at(-1)!,
      version: text(info.version) || null,
      operations,
    },
    issues: [],
  }
}

export function openApiFolderName(repoId: number, specPath: string, tag?: string): string {
  const base = `github-hosted-docs-${repoId}-openapi-${shortHash(specPath)}`
  return tag === undefined ? base : `${base}-tag-${shortHash(tag)}`
}
