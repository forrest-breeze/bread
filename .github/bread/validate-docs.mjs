import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 256 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const root = process.argv[2]
const issues = []
const ids = new Map()

function markdownTitle(value) {
  return value.replace(/\\/g, '\\\\').replace(/([*_\x60[\]<>])/g, '\\$1')
}

function parseJsonString(value) {
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(next)
    return entry.isFile() && /\.(?:md|mdx)$/i.test(entry.name) ? [next] : []
  })
}

if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('Bread docs root is missing: ' + (root || '<not configured>'))
  process.exit(1)
}

const files = walk(root).sort()

for (const file of files) {
  const raw = fs.readFileSync(file)
  const content = raw.toString('utf8').replace(/\r\n?/g, '\n')
  if (raw.byteLength > MAX_BYTES) issues.push(file + ': exceeds the 262144-byte Bread sync limit')
  if (content.includes('\u0000') || content.includes('\uFFFD')) {
    issues.push(file + ': must be valid UTF-8 text without binary or replacement characters')
  }

  const boundary = content.indexOf('\n---\n', 4)
  if (!content.startsWith('---\n') || boundary === -1) {
    issues.push(file + ': must start with Bread frontmatter')
    continue
  }
  const lines = content.slice(4, boundary).split('\n')
  if (lines.length !== 2 && lines.length !== 3) {
    issues.push(file + ': frontmatter must contain title, bread_document_id, and an optional date')
    continue
  }

  const titleMatch = /^title: (.+)$/.exec(lines[0])
  const idMatch = /^bread_document_id: (.+)$/.exec(lines[1])
  const title = titleMatch ? parseJsonString(titleMatch[1]) : null
  const documentId = idMatch ? parseJsonString(idMatch[1]) : null
  if (!title || !title.trim() || lines[0] !== 'title: ' + JSON.stringify(title)) {
    issues.push(file + ': title must be a non-empty JSON string on the first frontmatter line')
  }
  if (!documentId || !UUID.test(documentId) || lines[1] !== 'bread_document_id: ' + JSON.stringify(documentId)) {
    issues.push(file + ': bread_document_id must be a valid quoted UUID')
  } else if (ids.has(documentId)) {
    issues.push(file + ': reuses bread_document_id from ' + ids.get(documentId))
  } else {
    ids.set(documentId, file)
  }

  if (lines.length === 3) {
    const dateMatch = /^date: (.+)$/.exec(lines[2])
    const date = dateMatch ? parseJsonString(dateMatch[1]) : null
    if (!date || Number.isNaN(Date.parse(date)) || lines[2] !== 'date: ' + JSON.stringify(date)) {
      issues.push(file + ': the optional third frontmatter line must be a quoted ISO 8601 date')
    }
  }

  if (title) {
    const body = content.slice(boundary + '\n---\n'.length)
    const heading = '\n# ' + markdownTitle(title)
    if (body !== heading && !body.startsWith(heading + '\n')) {
      issues.push(file + ': the first body line must be an H1 matching the frontmatter title')
    }
  }
}

if (issues.length > 0) {
  console.error('Bread document format validation failed:\n\n' + issues.map((issue) => '- ' + issue).join('\n'))
  process.exit(1)
}

console.log('Validated ' + files.length + ' Bread document' + (files.length === 1 ? '' : 's') + ' in ' + root + '.')
