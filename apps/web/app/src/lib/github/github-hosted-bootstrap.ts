export interface BootstrapFolder {
  id: string
  displayName: string
  parentFolderId: string | null
  contentMarkdown?: string
  visibility?: string
  requiredRole?: string | null
}

export function restrictedBootstrapFolderNames(input: {
  rootFolderId: string
  folders: BootstrapFolder[]
}): string[] {
  const byId = new Map(input.folders.map((folder) => [folder.id, folder]))
  const inSubtree = (folder: BootstrapFolder): boolean => {
    let cursor: BootstrapFolder | undefined = folder
    let guard = 0
    while (cursor && guard < 64) {
      if (cursor.id === input.rootFolderId) return true
      cursor = cursor.parentFolderId ? byId.get(cursor.parentFolderId) : undefined
      guard += 1
    }
    return false
  }
  const isRestrictedBySelfOrAncestor = (folder: BootstrapFolder): boolean => {
    let cursor: BootstrapFolder | undefined = folder
    let guard = 0
    while (cursor && guard < 64) {
      if (
        (cursor.visibility && cursor.visibility !== 'workspace') ||
        cursor.requiredRole
      ) {
        return true
      }
      cursor = cursor.parentFolderId ? byId.get(cursor.parentFolderId) : undefined
      guard += 1
    }
    return false
  }

  return input.folders
    .filter((folder) => inSubtree(folder) && isRestrictedBySelfOrAncestor(folder))
    .map((folder) => folder.displayName)
    .sort((a, b) => a.localeCompare(b))
}

export interface BootstrapDocument {
  /** Internal Breezify database row identity. */
  id: string
  /** Stable identity declared by the hosted repository frontmatter. */
  breezifyDocumentId?: string | null
  title: string
  folderId: string
  /** Optional taxonomy root to omit from this document's repository path. */
  pathRootFolderId?: string
  publicSlug?: string | null
  contentMarkdown: string
  /** Stable path assigned by an already-linked hosted docs source. */
  canonicalPath?: string | null
  /** Exact repository body used to retain valid id/date frontmatter. */
  repositoryContent?: string | null
  /** True when title/body still match the last GitHub reconciliation. */
  repositoryContentIsCurrent?: boolean
  /**
   * The document's publication date, as stored in source_metadata. Emitted as
   * the `date:` frontmatter line so the repository keeps owning it: a sync
   * reads it back into the same field, and editing the document afterwards
   * cannot move the entry in a dated feed.
   */
  publishedAt?: string | null
  /**
   * Last-modified timestamp, used only as the fallback for a document that has
   * no publication date yet. It lets documents dated before this field existed
   * keep their date through the first publish, after which the sync stores a
   * real one.
   */
  updatedAt?: string | null
}

export interface GitHubBootstrapFile {
  /** Internal Breezify database row identity used to link the exported file. */
  documentId: string | null
  /** Stable identity emitted in the repository frontmatter. */
  breezifyDocumentId?: string | null
  path: string
  content: string
}

const SAFE_SEGMENT = /[^a-z0-9._-]+/g

function pathSegment(value: string, fallback: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, '-and-')
    .replace(SAFE_SEGMENT, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || fallback
}

function markdownTitle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([*_`[\]<>])/g, '\\$1')
}

export function normalizeBootstrapTargetPath(value: string): string | null {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
  if (!normalized || normalized.length > 512) return null
  const segments = normalized.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment === '.git' ||
        !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    return null
  }
  return normalized
}

/** Validate a repository Markdown path without changing its stored identity. */
export function validBootstrapDocumentPath(
  value: string | null | undefined,
  requestedTargetPath: string,
): string | null {
  const targetPath = normalizeBootstrapTargetPath(requestedTargetPath)
  if (
    !value ||
    !targetPath ||
    value !== value.trim() ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('//') ||
    !value.startsWith(`${targetPath}/`) ||
    !/\.(?:md|mdx)$/i.test(value)
  ) {
    return null
  }
  const segments = value.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git' ||
        /[\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    return null
  }
  return value
}

export function githubHostedDocsPullRequestTitle(
  targetPath: string,
  targetExists: boolean,
): string {
  return `docs: ${targetExists ? 'Update' : 'Create'} ${targetPath} from Breezify`
}

export function githubHostedDocsBranchPrefix(targetPath: string): string {
  const segment = targetPath
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'docs'
  return `breezify/docs-${segment}-`
}

function relativeFolderChain(
  folderId: string,
  rootFolderId: string,
  byId: ReadonlyMap<string, BootstrapFolder>,
): BootstrapFolder[] | null {
  const folders: BootstrapFolder[] = []
  let cursor: string | null = folderId
  let guard = 0
  while (cursor && cursor !== rootFolderId && guard < 64) {
    const folder = byId.get(cursor)
    if (!folder) return null
    folders.unshift(folder)
    cursor = folder.parentFolderId
    guard += 1
  }
  return cursor === rootFolderId ? folders : null
}

function generatedFolderSegments(folders: BootstrapFolder[]): string[] {
  return folders.map((folder, index) =>
    pathSegment(folder.displayName, `folder-${folders.length - index}`),
  )
}

function uniqueFilePath(
  requestedName: string,
  directory: string,
  usedPaths: Set<string>,
): string {
  const extensionMatch = /\.(mdx|md)$/i.exec(requestedName)
  const extension = extensionMatch?.[0] ?? '.md'
  const requestedBase = extensionMatch
    ? requestedName.slice(0, -extension.length)
    : requestedName
  let suffix = 1
  while (true) {
    const base = suffix === 1 ? requestedBase : `${requestedBase}-${suffix}`
    const path = `${directory}/${base}${extension}`
    if (!usedPaths.has(path)) {
      usedPaths.add(path)
      return path
    }
    suffix += 1
  }
}

const BREEZIFY_DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function preservedFrontmatterLines(
  repositoryContent: string | null | undefined,
  expectedDocumentId: string,
): { title: string; date?: string; dateValue?: string } | null {
  if (!repositoryContent) return null
  const normalized = repositoryContent.replace(/\r\n?/g, '\n')
  const boundary = normalized.indexOf('\n---\n', 4)
  if (!normalized.startsWith('---\n') || boundary === -1) return null
  const lines = normalized.slice(4, boundary).split('\n')
  if (lines.length !== 2 && lines.length !== 3) return null

  const titleMatch = /^title: (.+)$/.exec(lines[0]!)
  const idMatch = /^breezify_document_id: (.+)$/.exec(lines[1]!)
  if (!titleMatch || !idMatch) return null
  try {
    const title = JSON.parse(titleMatch[1]!) as unknown
    const id = JSON.parse(idMatch[1]!) as unknown
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      lines[0] !== `title: ${JSON.stringify(title)}` ||
      typeof id !== 'string' ||
      !BREEZIFY_DOCUMENT_ID_PATTERN.test(id) ||
      id !== expectedDocumentId ||
      lines[1] !== `breezify_document_id: ${JSON.stringify(id)}`
    ) {
      return null
    }
    if (lines.length === 2) return { title }

    const dateMatch = /^date: (.+)$/.exec(lines[2]!)
    if (!dateMatch) return null
    const date = JSON.parse(dateMatch[1]!) as unknown
    if (
      typeof date !== 'string' ||
      Number.isNaN(Date.parse(date)) ||
      lines[2] !== `date: ${JSON.stringify(date)}`
    ) {
      return null
    }
    return { title, date: lines[2]!, dateValue: date }
  } catch {
    return null
  }
}

/**
 * The `date:` frontmatter line for a timestamp, or null when there isn't a
 * usable one. Normalized to the exact ISO form the format validator requires,
 * so a file Breezify writes round-trips through its own parser unchanged.
 */
function frontmatterDateLine(updatedAt: string | null | undefined): string | null {
  if (!updatedAt) return null
  const parsed = new Date(updatedAt)
  if (Number.isNaN(parsed.getTime())) return null
  return `date: ${JSON.stringify(parsed.toISOString())}`
}

function sameDateInstant(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  return !Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime === rightTime
}

function documentFileContent(document: BootstrapDocument): {
  content: string
  breezifyDocumentId: string
} {
  const title = document.title.trim() || 'Untitled'
  const body = document.contentMarkdown.trim()
  const explicitDocumentId =
    typeof document.breezifyDocumentId === 'string' &&
    BREEZIFY_DOCUMENT_ID_PATTERN.test(document.breezifyDocumentId)
      ? document.breezifyDocumentId
      : null
  const breezifyDocumentId = explicitDocumentId ?? document.id
  const preserved = preservedFrontmatterLines(
    document.repositoryContent,
    breezifyDocumentId,
  )
  const repositoryDateIsCurrent =
    !document.publishedAt ||
    sameDateInstant(document.publishedAt, preserved?.dateValue)
  // A GitHub sync that no one edited must be byte-for-byte clean. Besides
  // avoiding whitespace/MDX churn, this retains the repository's exact date
  // spelling instead of manufacturing a Breezify-authored change.
  if (
    document.repositoryContentIsCurrent === true &&
    preserved?.title === title &&
    repositoryDateIsCurrent &&
    document.repositoryContent
  ) {
    return {
      breezifyDocumentId,
      content: document.repositoryContent,
    }
  }

  const publishedDateLine = frontmatterDateLine(document.publishedAt)
  const dateLine =
    (repositoryDateIsCurrent ? preserved?.date : null) ??
    publishedDateLine ??
    preserved?.date ??
    // updated_at is only a migration fallback for Breezify-authored documents.
    // A linked repository file with no date must remain undated.
    (document.repositoryContent ? null : frontmatterDateLine(document.updatedAt))
  return {
    breezifyDocumentId,
    content: [
      '---',
      `title: ${JSON.stringify(title)}`,
      `breezify_document_id: ${JSON.stringify(breezifyDocumentId)}`,
      ...(dateLine ? [dateLine] : []),
      '---',
      '',
      `# ${markdownTitle(title)}`,
      ...(body ? ['', body] : []),
      '',
    ].join('\n'),
  }
}

/** Build new repository files while retaining a document-id → path mapping. */
export function buildGitHubBootstrapFiles(input: {
  targetPath: string
  rootFolderId: string
  folders: BootstrapFolder[]
  documents: BootstrapDocument[]
}): GitHubBootstrapFile[] {
  const targetPath = normalizeBootstrapTargetPath(input.targetPath)
  if (!targetPath) throw new Error('Choose a valid GitHub folder path.')

  const byId = new Map(input.folders.map((folder) => [folder.id, folder]))
  const root = byId.get(input.rootFolderId)
  if (!root) throw new Error('The selected Breezify folder is unavailable.')

  const usedPaths = new Set<string>()
  const files: GitHubBootstrapFile[] = []
  const sorted = [...input.documents].sort((a, b) =>
    `${a.folderId}:${a.title}:${a.id}`.localeCompare(
      `${b.folderId}:${b.title}:${b.id}`,
    ),
  )
  const folderChainByDocumentId = new Map(
    sorted.map((document) => [
      document.id,
      relativeFolderChain(
        document.folderId,
        document.pathRootFolderId ?? input.rootFolderId,
        byId,
      ),
    ]),
  )
  const canonicalPathByDocumentId = new Map(
    sorted.map((document) => [
      document.id,
      validBootstrapDocumentPath(document.canonicalPath, targetPath),
    ]),
  )
  const mappedPathCandidatesByFolderId = new Map<string, Set<string>>()
  const addMappedPathCandidate = (folderId: string, segments: string[]) => {
    const candidates = mappedPathCandidatesByFolderId.get(folderId) ?? new Set()
    candidates.add(JSON.stringify(segments))
    mappedPathCandidatesByFolderId.set(folderId, candidates)
  }
  const targetSegmentCount = targetPath.split('/').length
  for (const document of sorted) {
    const canonicalPath = canonicalPathByDocumentId.get(document.id)
    const folderChain = folderChainByDocumentId.get(document.id)
    if (!canonicalPath || !folderChain || folderChain.length === 0) continue

    const canonicalDirectory = canonicalPath
      .split('/')
      .slice(targetSegmentCount, -1)
    // A document's own folder maps directly to its canonical directory.
    addMappedPathCandidate(folderChain.at(-1)!.id, canonicalDirectory)

    // Ancestor mappings are only safe when every folder has one path segment.
    if (canonicalDirectory.length === folderChain.length) {
      folderChain.forEach((folder, index) => {
        addMappedPathCandidate(folder.id, canonicalDirectory.slice(0, index + 1))
      })
    }
  }
  const mappedPathByFolderId = new Map<string, string[]>()
  for (const [folderId, candidates] of mappedPathCandidatesByFolderId) {
    if (candidates.size !== 1) continue
    mappedPathByFolderId.set(folderId, JSON.parse([...candidates][0]!) as string[])
  }
  const canonicalPathOwner = new Map<string, string>()
  for (const document of sorted) {
    const path = canonicalPathByDocumentId.get(document.id)
    if (
      folderChainByDocumentId.get(document.id) &&
      path &&
      !canonicalPathOwner.has(path)
    ) {
      canonicalPathOwner.set(path, document.id)
      usedPaths.add(path)
    }
  }
  for (const document of sorted) {
    const folderChain = folderChainByDocumentId.get(document.id)
    if (!folderChain) continue
    const generatedSegments = generatedFolderSegments(folderChain)
    for (let index = folderChain.length - 1; index >= 0; index -= 1) {
      const mappedPath = mappedPathByFolderId.get(folderChain[index]!.id)
      if (mappedPath === undefined) continue
      generatedSegments.splice(0, index + 1, ...mappedPath)
      break
    }
    const generatedDirectory = [targetPath, ...generatedSegments].join('/')
    const canonicalPath = canonicalPathByDocumentId.get(document.id) ?? null
    const requestedSlug = document.publicSlug?.split('/').filter(Boolean).at(-1)
    const generatedBase = pathSegment(
      requestedSlug || document.title,
      `document-${document.id.slice(0, 8)}`,
    )
    let path: string
    if (
      canonicalPath &&
      canonicalPathOwner.get(canonicalPath) === document.id
    ) {
      path = canonicalPath
    } else if (canonicalPath) {
      const slash = canonicalPath.lastIndexOf('/')
      path = uniqueFilePath(
        canonicalPath.slice(slash + 1),
        canonicalPath.slice(0, slash),
        usedPaths,
      )
    } else {
      path = uniqueFilePath(
        `${generatedBase}.md`,
        generatedDirectory,
        usedPaths,
      )
    }
    const rendered = documentFileContent(document)
    files.push({
      documentId: document.id,
      breezifyDocumentId: rendered.breezifyDocumentId,
      path,
      content: rendered.content,
    })
  }

  if (files.length === 0) {
    files.push({
      documentId: null,
      path: `${targetPath}/.gitkeep`,
      content: '',
    })
  }
  return files
}
