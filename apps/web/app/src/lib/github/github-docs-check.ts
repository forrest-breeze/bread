import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createGitHubCheckRun,
  updateGitHubCheckRun,
  type GitHubCheckAnnotation,
  type GitHubCheckOutput,
  type GitHubCheckRun,
} from './github-checks'
import {
  getInstallationToken,
  getRepositoryBlob,
  getRepositoryCommit,
  getRepositoryTree,
  type GitHubBlob,
  type GitHubRepositoryCommit,
  type GitHubRepositoryTree,
} from './github'
import {
  isHostedDocsFile,
  normalizeHostedDocsPaths,
} from './github-hosted-docs'
import {
  BREAD_HOSTED_DOC_MAX_BYTES,
  validateBreadHostedDocsFiles,
  type BreadDocsFormatIssue,
} from './github-hosted-format'
import {
  MAX_HOSTED_WORKSPACE_BYTES,
  MAX_HOSTED_WORKSPACE_DOCUMENTS,
} from './github-hosted-workspace'
import { getTokenCache } from './token-cache-factory'
import { withGitHubRetry } from './retry'

export const BREAD_DOCS_CHECK_NAME = 'Validate Bread docs'

const BLOB_FETCH_CONCURRENCY = 6
const MAX_ANNOTATIONS = 50
const MAX_ANNOTATION_MESSAGE_LENGTH = 1_000
const MAX_REPORTED_ISSUES = 20
const MAX_REPORTED_ROOTS = 20

function docsCheckExternalId(info: GitHubDocsCheckInfo): string {
  return `bread-docs:${info.repoId}:${info.headSha}`
}

export interface GitHubDocsCheckInfo {
  installationId: number
  repoId: number
  repoFullName: string
  headSha: string
}

export type GitHubDocsCheckResult =
  | { status: 'ignored'; reason: 'unlinked' }
  | { status: 'success'; checkRunId: number; documentCount: number }
  | { status: 'failure'; checkRunId: number }

type RetryGitHubCall = <T>(fn: () => Promise<T>) => Promise<T>

export interface GitHubDocsCheckDependencies {
  admin?: SupabaseClient
  getToken?: (installationId: number) => Promise<string>
  createCheck?: (
    token: string,
    repoFullName: string,
    input: Parameters<typeof createGitHubCheckRun>[2],
  ) => Promise<GitHubCheckRun>
  updateCheck?: (
    token: string,
    repoFullName: string,
    checkRunId: number,
    input: Parameters<typeof updateGitHubCheckRun>[3],
  ) => Promise<GitHubCheckRun>
  getCommit?: (
    token: string,
    repoFullName: string,
    ref: string,
  ) => Promise<GitHubRepositoryCommit>
  getTree?: (
    token: string,
    repoFullName: string,
    treeSha: string,
  ) => Promise<GitHubRepositoryTree>
  getBlob?: (
    token: string,
    repoFullName: string,
    blobSha: string,
  ) => Promise<GitHubBlob>
  clearToken?: (installationId: number) => Promise<void>
  retry?: RetryGitHubCall
  now?: () => Date
}

interface LinkedSourceRow {
  paths: unknown
}

interface ValidationResult {
  documentCount: number
  totalBytes: number
}

class DocsCheckFailure extends Error {
  constructor(
    readonly output: GitHubCheckOutput,
  ) {
    super(output.summary)
    this.name = 'DocsCheckFailure'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function repositoryInfo(payload: Record<string, unknown>): {
  installationId: number
  repoId: number
  repoFullName: string
} | null {
  const installation = asRecord(payload.installation)
  const repository = asRecord(payload.repository)
  const installationId = positiveSafeInteger(installation?.id)
  const repoId = positiveSafeInteger(repository?.id)
  const repoFullName = nonEmptyString(repository?.full_name)
  if (!installationId || !repoId || !repoFullName) return null
  return { installationId, repoId, repoFullName }
}

/**
 * Extract the commit identity for a check GitHub is asking this App to run.
 * `check_run.rerequested` is accepted only for a run owned by the configured
 * App, preventing a same-named check from another App from triggering work.
 */
export function extractGitHubDocsCheckInfo(
  eventType: string,
  payload: Record<string, unknown>,
  expectedAppId: string | undefined = process.env.GITHUB_APP_ID,
): GitHubDocsCheckInfo | null {
  const common = repositoryInfo(payload)
  if (!common) return null

  if (eventType === 'check_suite') {
    if (payload.action !== 'requested' && payload.action !== 'rerequested') {
      return null
    }
    const suite = asRecord(payload.check_suite)
    const headSha = nonEmptyString(suite?.head_sha)
    return headSha ? { ...common, headSha } : null
  }

  if (eventType !== 'check_run' || payload.action !== 'rerequested') return null
  const configuredAppId = expectedAppId ? Number(expectedAppId) : Number.NaN
  if (!Number.isSafeInteger(configuredAppId) || configuredAppId <= 0) return null

  const checkRun = asRecord(payload.check_run)
  const app = asRecord(checkRun?.app)
  if (
    checkRun?.name !== BREAD_DOCS_CHECK_NAME ||
    positiveSafeInteger(app?.id) !== configuredAppId
  ) {
    return null
  }
  const headSha = nonEmptyString(checkRun.head_sha)
  return headSha ? { ...common, headSha } : null
}

async function loadLinkedRoots(
  admin: SupabaseClient,
  info: GitHubDocsCheckInfo,
): Promise<{ linked: boolean; roots: string[] }> {
  const { data, error } = await admin
    .from('github_hosted_docs_sources')
    .select('paths')
    .eq('installation_id', info.installationId)
    .eq('repo_id', info.repoId)
  if (error) {
    throw new Error('Unable to look up linked Bread documentation roots.')
  }

  const rows = (data ?? []) as LinkedSourceRow[]
  const roots = normalizeHostedDocsPaths(
    rows.flatMap((row) =>
      Array.isArray(row.paths)
        ? row.paths.filter((path): path is string => typeof path === 'string')
        : [],
    ),
  )
  return { linked: rows.length > 0, roots }
}

function sanitizeAnnotationMessage(message: string): string {
  const sanitized = message
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
  if (sanitized.length <= MAX_ANNOTATION_MESSAGE_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_ANNOTATION_MESSAGE_LENGTH - 1)}…`
}

function issueAnnotations(
  issues: BreadDocsFormatIssue[],
): GitHubCheckAnnotation[] {
  return issues.slice(0, MAX_ANNOTATIONS).map((issue) => ({
    path: issue.path,
    start_line: 1,
    end_line: 1,
    annotation_level: 'failure',
    title: 'Invalid Bread document',
    message: sanitizeAnnotationMessage(issue.message),
  }))
}

function markdownInlineCode(value: string): string {
  const escaped = JSON.stringify(value).slice(1, -1)
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(escaped.matchAll(/`+/g), (match) => match[0].length),
  )
  const fence = '`'.repeat(longestBacktickRun + 1)
  const padding = escaped.startsWith('`') || escaped.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${escaped}${padding}${fence}`
}

function issueDetailLines(issues: BreadDocsFormatIssue[]): string[] {
  const reported = issues.slice(0, MAX_REPORTED_ISSUES)
  const grouped = new Map<string, string[]>()
  for (const issue of reported) {
    const messages = grouped.get(issue.path) ?? []
    messages.push(sanitizeAnnotationMessage(issue.message))
    grouped.set(issue.path, messages)
  }

  const lines = Array.from(grouped, ([path, messages]) => [
    `- ${markdownInlineCode(path)}`,
    ...messages.map((message) => `  - ${markdownInlineCode(message)}`),
  ]).flat()
  const hidden = issues.length - reported.length
  if (hidden > 0) {
    lines.push(`- …and ${hidden} more ${hidden === 1 ? 'issue' : 'issues'}`)
  }
  return lines
}

function validationFailure(issues: BreadDocsFormatIssue[]): DocsCheckFailure {
  const annotations = issueAnnotations(issues)
  const affectedFiles = new Set(issues.map((issue) => issue.path)).size
  const hiddenAnnotations = issues.length - annotations.length
  return new DocsCheckFailure({
    title: 'Bread document validation failed',
    summary:
      `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'} found in ` +
      `${affectedFiles} ${affectedFiles === 1 ? 'document' : 'documents'}.`,
    text: [
      '### Errors',
      '',
      ...issueDetailLines(issues),
      '',
      hiddenAnnotations > 0
        ? `GitHub annotations show the first ${MAX_ANNOTATIONS} issues.`
        : 'GitHub annotations are attached to the affected files.',
    ].join('\n'),
    annotations,
  })
}

function structuralFailure(summary: string): DocsCheckFailure {
  return new DocsCheckFailure({
    title: 'Bread document validation failed',
    summary,
  })
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Number((bytes / (1024 * 1024)).toFixed(2))} MiB`
  }
  if (bytes >= 1024) {
    return `${Number((bytes / 1024).toFixed(1))} KiB`
  }
  return `${bytes} B`
}

function successOutput(
  validated: ValidationResult,
  roots: string[],
): GitHubCheckOutput {
  const documentLabel = validated.documentCount === 1
    ? 'Bread document'
    : 'Bread documents'
  const rootLabel = roots.length === 1 ? 'linked root' : 'linked roots'
  const rootLines = roots
    .slice(0, MAX_REPORTED_ROOTS)
    .map((root) => `- ${markdownInlineCode(root)}`)
  if (roots.length > MAX_REPORTED_ROOTS) {
    rootLines.push(`- …and ${roots.length - MAX_REPORTED_ROOTS} more`)
  }

  return {
    title: 'Bread documents are valid',
    summary:
      `Validated ${validated.documentCount} ${documentLabel} across ` +
      `${roots.length} ${rootLabel} at this commit. ` +
      'All 6 checks passed.',
    text: [
      '### Checks performed',
      '',
      '- ✅ **Repository scope:** Every linked root exists as a directory, and GitHub returned a complete repository tree.',
      `- ✅ **File content:** ${validated.documentCount} Markdown/MDX ${validated.documentCount === 1 ? 'document was' : 'documents were'} decoded completely as valid UTF-8 text without NUL or replacement characters.`,
      '- ✅ **Frontmatter:** Required `title` and `bread_document_id` fields use the expected order and quoting; optional `date` values are quoted and parseable.',
      '- ✅ **Document identity:** Every document ID is a valid UUID and is unique across the linked roots.',
      '- ✅ **Title structure:** Each document starts with an H1 matching its frontmatter title.',
      `- ✅ **Size limits:** ${validated.documentCount} ${validated.documentCount === 1 ? 'document is' : 'documents are'} within the ${MAX_HOSTED_WORKSPACE_DOCUMENTS}-document limit; each is at most ${formatByteSize(BREAD_HOSTED_DOC_MAX_BYTES)}; ${formatByteSize(validated.totalBytes)} scanned of the ${formatByteSize(MAX_HOSTED_WORKSPACE_BYTES)} combined limit.`,
      '',
      '### Linked roots',
      '',
      ...rootLines,
      '',
      'Only `.md` and `.mdx` files beneath these roots are checked. Bread does not lint links, prose, or general Markdown/MDX syntax.',
    ].join('\n'),
  }
}

function failureOutputWithContext(
  output: GitHubCheckOutput,
  roots: string[],
  headSha: string,
): GitHubCheckOutput {
  const rootLines = roots
    .slice(0, MAX_REPORTED_ROOTS)
    .map((root) => `  - ${markdownInlineCode(root)}`)
  if (roots.length > MAX_REPORTED_ROOTS) {
    rootLines.push(`  - …and ${roots.length - MAX_REPORTED_ROOTS} more`)
  }

  const scopeLines = roots.length === 0
    ? ['- Linked docs folder: none configured']
    : [
        `- ${roots.length === 1 ? 'Linked docs folder' : 'Linked docs folders'}:`,
        ...rootLines,
      ]
  const hasDocumentErrors = (output.annotations?.length ?? 0) > 0

  return {
    ...output,
    text: [
      ...(output.text ? [output.text, ''] : []),
      '### Check scope',
      '',
      `- Commit: ${markdownInlineCode(headSha)}`,
      ...scopeLines,
      '',
      '### Next step',
      '',
      hasDocumentErrors
        ? 'Fix the document errors above, then push another commit or re-run this check.'
        : 'Update the linked docs folder or repository contents, then push another commit or re-run this check.',
    ].join('\n'),
  }
}

function decodeBlob(entryPath: string, blob: GitHubBlob): string {
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw validationFailure([{
      path: entryPath,
      message: 'must be returned by GitHub as base64-encoded content',
    }])
  }
  if (blob.size > BREAD_HOSTED_DOC_MAX_BYTES) {
    throw validationFailure([{
      path: entryPath,
      message: `exceeds the ${BREAD_HOSTED_DOC_MAX_BYTES}-byte Bread sync limit`,
    }])
  }

  const encoded = blob.content.replace(/\s/g, '')
  const validBase64 =
    encoded.length > 0 &&
    encoded.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  if (!validBase64) {
    throw validationFailure([{
      path: entryPath,
      message: 'must contain valid base64-encoded UTF-8 text',
    }])
  }

  const bytes = Buffer.from(encoded, 'base64')
  if (
    bytes.byteLength !== blob.size ||
    bytes.byteLength > BREAD_HOSTED_DOC_MAX_BYTES
  ) {
    throw validationFailure([{
      path: entryPath,
      message: bytes.byteLength > BREAD_HOSTED_DOC_MAX_BYTES
        ? `exceeds the ${BREAD_HOSTED_DOC_MAX_BYTES}-byte Bread sync limit`
        : 'could not be decoded completely from GitHub',
    }])
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw validationFailure([{
      path: entryPath,
      message: 'must contain valid UTF-8 text',
    }])
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let nextIndex = 0
  let stopped = false

  async function worker(): Promise<void> {
    while (!stopped && nextIndex < values.length) {
      const index = nextIndex++
      try {
        output[index] = await fn(values[index]!)
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  )
  return output
}

async function validateCommit(
  info: GitHubDocsCheckInfo,
  roots: string[],
  token: string,
  deps: Required<Pick<
    GitHubDocsCheckDependencies,
    'getCommit' | 'getTree' | 'getBlob' | 'retry'
  >>,
): Promise<ValidationResult> {
  if (roots.length === 0) {
    throw structuralFailure('The linked Bread documentation root is not configured correctly.')
  }

  const commit = await deps.retry(() =>
    deps.getCommit(token, info.repoFullName, info.headSha),
  )
  const tree = await deps.retry(() =>
    deps.getTree(token, info.repoFullName, commit.commit.tree.sha),
  )
  if (tree.truncated) {
    throw structuralFailure(
      'GitHub returned an incomplete repository tree, so Bread could not validate every document.',
    )
  }

  for (const root of roots) {
    const rootEntry = tree.tree.find((entry) => entry.path === root)
    if (rootEntry?.type !== 'tree') {
      throw structuralFailure(
        'A linked Bread documentation root is missing or is not a directory at this commit.',
      )
    }
  }

  const entries = tree.tree
    .filter((entry) => isHostedDocsFile(entry, roots))
    .sort((left, right) => left.path.localeCompare(right.path))
  if (entries.length > MAX_HOSTED_WORKSPACE_DOCUMENTS) {
    throw structuralFailure(
      `This commit contains more than ${MAX_HOSTED_WORKSPACE_DOCUMENTS} linked Bread documents.`,
    )
  }

  const missingSize = entries.find(
    (entry) =>
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0,
  )
  if (missingSize) {
    throw structuralFailure(
      'GitHub did not report a safe size for every linked Bread document.',
    )
  }

  const oversized = entries.find(
    (entry) => entry.size! > BREAD_HOSTED_DOC_MAX_BYTES,
  )
  if (oversized) {
    throw validationFailure([{
      path: oversized.path,
      message: `exceeds the ${BREAD_HOSTED_DOC_MAX_BYTES}-byte Bread sync limit`,
    }])
  }

  const reportedBytes = entries.reduce(
    (total, entry) => total + entry.size!,
    0,
  )
  if (reportedBytes > MAX_HOSTED_WORKSPACE_BYTES) {
    throw structuralFailure(
      `The linked Bread documents exceed the ${MAX_HOSTED_WORKSPACE_BYTES}-byte workspace limit.`,
    )
  }

  let decodedBytes = 0
  const files = await mapWithConcurrency(
    entries,
    BLOB_FETCH_CONCURRENCY,
    async (entry) => {
      const blob = await deps.retry(() =>
        deps.getBlob(token, info.repoFullName, entry.sha),
      )
      const content = decodeBlob(entry.path, blob)
      decodedBytes += Buffer.byteLength(content, 'utf8')
      if (decodedBytes > MAX_HOSTED_WORKSPACE_BYTES) {
        throw structuralFailure(
          `The linked Bread documents exceed the ${MAX_HOSTED_WORKSPACE_BYTES}-byte workspace limit.`,
        )
      }
      return { path: entry.path, content }
    },
  )
  const issues = validateBreadHostedDocsFiles(files)
  if (issues.length > 0) throw validationFailure(issues)
  return { documentCount: files.length, totalBytes: reportedBytes }
}

function internalFailureOutput(): GitHubCheckOutput {
  return {
    title: 'Bread document validation could not finish',
    summary: 'Bread could not safely complete validation for this commit.',
    text: 'Re-run the check. If it fails again, reconnect the repository from Bread settings.',
  }
}

function logInternalFailure(stage: string, error: unknown): void {
  const status = (error as { status?: unknown })?.status
  console.error('[Bread] GitHub docs check internal failure:', {
    stage,
    errorType: error instanceof Error ? error.name : typeof error,
    ...(typeof status === 'number' ? { status } : {}),
  })
}

function isSecondaryRateLimit(error: unknown): boolean {
  return (
    (error as { status?: unknown })?.status === 403 &&
    error instanceof Error &&
    error.message.toLowerCase().includes('secondary rate limit')
  )
}

function stopUnsafeCreateRetry(error: unknown): never {
  // POST /check-runs is not idempotent. Only a rate-limit 403 proves GitHub
  // did not create the run; hide every other status from the generic retry
  // wrapper so an ambiguous 5xx response cannot create a duplicate.
  if (isSecondaryRateLimit(error)) throw error
  const wrapped = new Error('GitHub check-run creation could not be confirmed.')
  wrapped.name = 'GitHubCheckCreationError'
  throw wrapped
}

/**
 * Create and complete one App-owned check for the linked Bread docs roots at
 * an exact Git commit. Unlinked repositories are intentionally ignored before
 * an installation token is minted or a check run is created.
 */
export async function handleGitHubDocsCheck(
  info: GitHubDocsCheckInfo,
  dependencies: GitHubDocsCheckDependencies = {},
): Promise<GitHubDocsCheckResult> {
  const admin = dependencies.admin ?? createAdminClient()
  const linked = await loadLinkedRoots(admin, info)
  if (!linked.linked) return { status: 'ignored', reason: 'unlinked' }

  const getToken = dependencies.getToken ?? getInstallationToken
  const createCheck = dependencies.createCheck ?? createGitHubCheckRun
  const updateCheck = dependencies.updateCheck ?? updateGitHubCheckRun
  const getCommit = dependencies.getCommit ?? getRepositoryCommit
  const getTree = dependencies.getTree ?? getRepositoryTree
  const getBlob = dependencies.getBlob ?? getRepositoryBlob
  const clearToken = dependencies.clearToken ?? ((installationId: number) =>
    getTokenCache().clear(installationId))
  const retry = dependencies.retry ?? withGitHubRetry
  const now = dependencies.now ?? (() => new Date())

  let token = await retry(() => getToken(info.installationId))
  const createInput: Parameters<typeof createGitHubCheckRun>[2] = {
    name: BREAD_DOCS_CHECK_NAME,
    head_sha: info.headSha,
    external_id: docsCheckExternalId(info),
    status: 'in_progress',
    started_at: now().toISOString(),
  }
  let checkRun: GitHubCheckRun
  try {
    checkRun = await createCheck(token, info.repoFullName, createInput)
  } catch (error) {
    // Installation tokens retain their permission snapshot. A token minted
    // before the owner approved Checks:write can stay cached for nearly an
    // hour. Secondary rate limits are also definitive 403 responses, but need
    // backoff rather than a new token.
    if ((error as { status?: unknown })?.status !== 403) throw error
    if (isSecondaryRateLimit(error)) {
      checkRun = await retry(async () => {
        try {
          return await createCheck(token, info.repoFullName, createInput)
        } catch (retryError) {
          stopUnsafeCreateRetry(retryError)
        }
      })
    } else {
      // A permission 403 means no run was created, so clearing and trying once
      // with a freshly minted token is safe from duplicate check runs.
      await clearToken(info.installationId)
      token = await retry(() => getToken(info.installationId))
      checkRun = await createCheck(token, info.repoFullName, createInput)
    }
  }

  let result: GitHubDocsCheckResult
  let completion: Parameters<typeof updateGitHubCheckRun>[3]
  try {
    const validated = await validateCommit(info, linked.roots, token, {
      getCommit,
      getTree,
      getBlob,
      retry,
    })
    completion = {
      status: 'completed',
      conclusion: 'success',
      completed_at: now().toISOString(),
      output: successOutput(validated, linked.roots),
    }
    result = {
      status: 'success',
      checkRunId: checkRun.id,
      documentCount: validated.documentCount,
    }
  } catch (error) {
    const expected = error instanceof DocsCheckFailure
    if (!expected) logInternalFailure('validation', error)
    completion = {
      status: 'completed',
      conclusion: 'failure',
      completed_at: now().toISOString(),
      output: expected
        ? failureOutputWithContext(error.output, linked.roots, info.headSha)
        : internalFailureOutput(),
    }
    result = { status: 'failure', checkRunId: checkRun.id }
  }

  try {
    // Publish exactly one logical outcome. If a success response is lost after
    // GitHub applies it, sending a different failure outcome would incorrectly
    // flip the remote check.
    await retry(() =>
      updateCheck(token, info.repoFullName, checkRun.id, completion),
    )
  } catch (completionError) {
    logInternalFailure('completion', completionError)
    return { status: 'failure', checkRunId: checkRun.id }
  }
  return result
}
