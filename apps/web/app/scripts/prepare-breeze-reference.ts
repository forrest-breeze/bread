/** Prepare portable reference content from a downloaded Breeze llms.txt snapshot.
 * Usage: npx tsx scripts/prepare-breeze-reference.ts <source-dir> <output-dir>
 * Writes files only; database updates are a separate, reviewed operation.
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { renderOperation, prunedSpec } from './import-llms-docs'

type Obj = Record<string, any>
const [source, output] = process.argv.slice(2)
if (!source || !output) throw new Error('Expected source and output directories')
await mkdir(output, { recursive: true })
const prepared: Obj[] = []
for (const file of (await readdir(source)).filter(f => f.endsWith('.md')).sort()) {
  const raw = await readFile(path.join(source, file), 'utf8')
  const match = /#\s*OpenAPI definition\s*```json\n([\s\S]*?)\n```/.exec(raw)
  if (!match) throw new Error(`Missing OpenAPI: ${file}`)
  const original = JSON.parse(match[1])
  const slug = file.slice(0, -3)
  const operations = ['paths', 'webhooks'].flatMap(kind =>
    Object.entries(original[kind] ?? {}).flatMap(([route, item]) =>
      ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].flatMap(method => {
        const op = (item as Obj)[method]
        return op && op.operationId?.toLowerCase() === slug ? [{ kind, route, method, op, item: item as Obj }] : []
      })))
  if (operations.length !== 1) throw new Error(`Ambiguous operation: ${file}`)
  const {kind,route,method,op,item} = operations[0]
  const scoped = {...original, paths: {}, webhooks: {}, [kind]: {[route]: {...Object.fromEntries(Object.entries(item).filter(([key]) => !['get','post','put','patch','delete','head','options','trace'].includes(key))), [method]: op}}}
  const spec: Obj = {...prunedSpec(scoped), info: original.info ?? {title: 'Breeze API', version: 'unversioned'}}
  const resolve = (node: Obj = {}): Obj => node.$ref?.startsWith('#/') ? node.$ref.slice(2).split('/').reduce((v: Obj,k: string) => v[k.replace(/~1/g,'/').replace(/~0/g,'~')], spec) : node
  const sample = (node: Obj = {}, seen = new Set<Obj>()): any => {
    const s = resolve(node)
    if (!s || seen.has(s)) return null
    const next = new Set(seen).add(s)
    if (s.example !== undefined) return s.example
    if (s.default !== undefined) return s.default
    if (s.const !== undefined) return s.const
    if (s.enum) return s.enum[0]
    if (s.oneOf || s.anyOf) return sample((s.oneOf ?? s.anyOf)[0], next)
    if (s.allOf) return Object.assign({}, ...s.allOf.map((p: Obj) => sample(p, next)))
    if (s.properties) return Object.fromEntries(Object.entries(s.properties).filter(([,v]) => !(v as Obj).writeOnly).map(([k,v]) => [k,sample(v as Obj,next)]))
    if (s.type === 'array') return [sample(s.items,next)]
    if (s.type === 'boolean') return false
    if (s.type === 'number' || s.type === 'integer') return s.minimum ?? 0
    return 'string'
  }
  const mediaExample = (media: Obj) => media.example ?? Object.values(media.examples ?? {}).map((e: any) => resolve(e).value).find(v => v !== undefined)
  const json = (v: unknown) => '```json\n'+JSON.stringify(v,null,2)+'\n```'
  const mergedOp = {...op, parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])]}
  let content = renderOperation(spec,method,route,mergedOp,kind === 'webhooks').replace(/^## /,'').replace(/^### /gm,'## ').replace(/^#### /gm,'### ')
  const security = op.security ?? original.security ?? []
  if (kind === 'paths' && security.length) {
    content += '\n\n## Authentication\n\n'+security.map((alternative: Obj) => Object.keys(alternative).map(name => {
      const scheme = spec.components?.securitySchemes?.[name] ?? {}
      return `**${name}**: ${scheme.description ?? `${scheme.type} ${scheme.scheme ?? ''}`}`
    }).join(' and ')).join('\n\nOr: ')
  }
  if (op['x-required-permissions']) content += '\n\nRequired permissions: '+op['x-required-permissions'].map((p: string) => '`'+p+'`').join(', ')+'.'
  content += '\n\n## Request example\n\n'
  const body = resolve(op.requestBody)
  if (kind === 'paths') {
    const server = (op.servers ?? item.servers ?? spec.servers)?.[0]?.url
    if (!server) throw new Error(`Missing server: ${slug}`)
    const curl = [`curl --request ${method.toUpperCase()}`, `  --url '${server.replace(/\/$/,'')}${route}'`]
    const firstSecurity = security[0] ?? {}
    for (const name of Object.keys(firstSecurity)) {
      const scheme = spec.components?.securitySchemes?.[name] ?? {}
      if (scheme.scheme === 'basic') curl.push('  --user "${BREEZE_API_KEY}:"')
      else if (scheme.scheme === 'bearer') curl.push('  --header "Authorization: Bearer ${BREEZE_API_TOKEN}"')
      else if (scheme.type === 'apiKey' && scheme.in === 'header') curl.push(`  --header "${scheme.name}: \${BREEZE_API_KEY}"`)
    }
    const contentType = Object.keys(body.content ?? {})[0]
    if (contentType === 'application/json') curl.push("  --header 'Content-Type: application/json'", "  --data @payload.json")
    content += '### Shell\n\nReplace path placeholders and supply required parameters listed above.'+(contentType ? '\n\nPrepare the request body using the documented schema'+(contentType === 'application/json' ? ' and save it as `payload.json`.' : ` (${contentType}); this command shows the endpoint and authentication only.`) : '')+'\n\n```bash\n'+curl.join(' \\\n')+'\n```'
  } else content += 'Breeze sends this payload to your configured webhook endpoint.\n'
  for (const [type, media] of Object.entries(body.content ?? {}) as [string,Obj][]) {
    if (!type.includes('json')) continue
    const example = mediaExample(media)
    content += '\n\n### '+(kind === 'webhooks' ? 'Webhook payload' : 'Request body')+'\n\n'+(example !== undefined ? 'Source example.' : 'Illustrative shape generated from the schema; replace placeholder values before use.')+'\n\n'+json(example ?? sample(media.schema))
  }
  content += '\n\n## Response example\n'
  for (const [code, response] of Object.entries(op.responses ?? {}) as [string,Obj][]) {
    const r = resolve(response)
    content += `\n### ${code} — ${(r.description ?? '').replace(/\n/g,' ')}\n`
    for (const [type, media] of Object.entries(r.content ?? {}) as [string,Obj][]) {
      if (!type.includes('json')) {content += `\nContent type: \`${type}\`.\n`;continue}
      const example = mediaExample(media)
      content += '\n'+(example !== undefined ? 'Source example.' : 'Illustrative shape generated from the schema, not a live response.')+'\n\n'+json(example ?? sample(media.schema))+'\n'
    }
  }
  // Every local reference in the portable contract must resolve.
  const check = (value: any): void => { if (!value || typeof value !== 'object') return; if(value.$ref && !resolve(value)) throw new Error(`Unresolved reference in ${slug}: ${value.$ref}`); Object.values(value).forEach(check) }
  check(spec)
  await writeFile(path.join(output,file),content+'\n')
  await writeFile(path.join(output,slug+'.openapi.json'),JSON.stringify(spec,null,2)+'\n')
  prepared.push({slug,title:op.summary,content:content+'\n',spec,operation_id:op.operationId,source_url:`https://docs.breeze.com/reference/${file}`})
}
await writeFile(path.join(output,'manifest.json'),JSON.stringify(prepared))
console.log(`Prepared ${prepared.length} endpoint pages with portable OpenAPI contracts`)
