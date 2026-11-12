const BREAD_DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const BREAD_HOSTED_DOC_MAX_BYTES = 256 * 1024

export interface BreadDocsFormatIssue {
  path: string
  message: string
}

export interface BreadDocsFormatFile {
  path: string
  content: string
}

function markdownTitle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([*_`[\]<>])/g, '\\$1')
}

function parseJsonString(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function validateBreadHostedDocument(
  file: BreadDocsFormatFile,
): BreadDocsFormatIssue[] {
  const issues: BreadDocsFormatIssue[] = []
  const normalized = file.content.replace(/\r\n?/g, '\n')
  if (Buffer.byteLength(file.content, 'utf8') > BREAD_HOSTED_DOC_MAX_BYTES) {
    issues.push({
      path: file.path,
      message: `exceeds the ${BREAD_HOSTED_DOC_MAX_BYTES}-byte Bread sync limit`,
    })
  }
  if (normalized.includes('\u0000') || normalized.includes('\uFFFD')) {
    issues.push({
      path: file.path,
      message: 'must be valid UTF-8 text without binary or replacement characters',
    })
  }

  const boundary = normalized.indexOf('\n---\n', 4)
  if (!normalized.startsWith('---\n') || boundary === -1) {
    issues.push({
      path: file.path,
      message: 'must start with Bread frontmatter',
    })
    return issues
  }

  const frontmatter = normalized.slice(4, boundary)
  const lines = frontmatter.split('\n')
  if (lines.length !== 2 && lines.length !== 3) {
    issues.push({
      path: file.path,
      message:
        'frontmatter must contain title, bread_document_id, and an optional date',
    })
    return issues
  }

  const titleMatch = /^title: (.+)$/.exec(lines[0]!)
  const idMatch = /^bread_document_id: (.+)$/.exec(lines[1]!)
  const title = titleMatch ? parseJsonString(titleMatch[1]!) : null
  const documentId = idMatch ? parseJsonString(idMatch[1]!) : null
  if (!title?.trim() || lines[0] !== `title: ${JSON.stringify(title)}`) {
    issues.push({
      path: file.path,
      message: 'title must be a non-empty JSON string on the first frontmatter line',
    })
  }
  if (
    !documentId ||
    !BREAD_DOCUMENT_ID_PATTERN.test(documentId) ||
    lines[1] !== `bread_document_id: ${JSON.stringify(documentId)}`
  ) {
    issues.push({
      path: file.path,
      message: 'bread_document_id must be a valid quoted UUID',
    })
  }
  // Optional third line. Dated entries (changelog releases) carry their own
  // timestamp so the repository — not the sync clock — decides where they fall
  // in a dated feed. Anything else in that slot is still rejected.
  if (lines.length === 3) {
    const dateMatch = /^date: (.+)$/.exec(lines[2]!)
    const date = dateMatch ? parseJsonString(dateMatch[1]!) : null
    if (
      !date ||
      Number.isNaN(Date.parse(date)) ||
      lines[2] !== `date: ${JSON.stringify(date)}`
    ) {
      issues.push({
        path: file.path,
        message:
          'the optional third frontmatter line must be a quoted ISO 8601 date',
      })
    }
  }

  if (title) {
    const body = normalized.slice(boundary + '\n---\n'.length)
    const expectedHeading = `\n# ${markdownTitle(title)}`
    if (
      body !== expectedHeading &&
      !body.startsWith(`${expectedHeading}\n`)
    ) {
      issues.push({
        path: file.path,
        message: 'the first body line must be an H1 matching the frontmatter title',
      })
    }
  }
  return issues
}

export function validateBreadHostedDocsFiles(
  files: BreadDocsFormatFile[],
): BreadDocsFormatIssue[] {
  const docs = files.filter((file) => /\.(?:md|mdx)$/i.test(file.path))
  const issues = docs.flatMap((file) => validateBreadHostedDocument(file))

  const ids = new Map<string, string>()
  for (const file of docs) {
    const match =
      /^---\r?\ntitle: .+\r?\nbread_document_id: (.+)(?:\r?\ndate: .+)?\r?\n---(?:\r?\n|$)/.exec(
        file.content,
      )
    const documentId = match ? parseJsonString(match[1]!) : null
    if (!documentId || !BREAD_DOCUMENT_ID_PATTERN.test(documentId)) continue
    const previous = ids.get(documentId)
    if (previous) {
      issues.push({
        path: file.path,
        message: `reuses bread_document_id from ${previous}`,
      })
    } else {
      ids.set(documentId, file.path)
    }
  }
  return issues
}

export class BreadDocsFormatError extends Error {
  constructor(readonly issues: BreadDocsFormatIssue[]) {
    super(
      issues.length === 1
        ? `${issues[0]!.path}: ${issues[0]!.message}`
        : `${issues.length} files do not follow the Bread document format`,
    )
    this.name = 'BreadDocsFormatError'
  }
}

export function assertBreadHostedDocsFiles(
  files: BreadDocsFormatFile[],
): void {
  const issues = validateBreadHostedDocsFiles(files)
  if (issues.length > 0) throw new BreadDocsFormatError(issues)
}
