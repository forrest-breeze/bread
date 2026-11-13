import { createHmac, createPrivateKey, createSign, timingSafeEqual, type KeyObject } from 'crypto'
import { buildRedis } from '@/lib/upstash'
import { GitHubApiError } from './retry'
import type { GitHubAvailableRepo } from './types'
import type { GitHubFileCommit } from '@breezify/core'

/**
 * Where the GitHub App private key lives when it is too large for a Lambda env
 * var. Exported so the health probe reports on the same key the runtime reads.
 */
export const PRIVATE_KEY_REDIS_KEY = 'github:app:private-key'

const GITHUB_API = 'https://api.github.com'

// Maximum GitHub error-body bytes to include in thrown error messages.
// GitHub's "secondary rate limit" phrase lands in the first ~200 bytes; the
// cap just keeps pathological HTML error pages from bloating the logs.
const MAX_ERROR_BODY = 500

// Reads the response body as text and truncates. Returns "" if reading
// fails — we must never mask the original HTTP error with a body-read
// error because the response body is unreliable on some failure paths.
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) : text
  } catch {
    return ''
  }
}

// =============================================================================
// Types — GitHub REST API response shapes
//
// Only the fields we actually use are typed. The real API responses contain
// many more fields; we rely on TypeScript to narrow what we access rather than
// typing the full payload.
// =============================================================================

export interface GitHubUser {
  login: string
  /** "User" | "Bot" | "Organization" */
  type: string
}

export interface GitHubPR {
  number: number
  html_url?: string
  title: string
  /** The PR description. Null when the author left the body blank. */
  body: string | null
  state: 'open' | 'closed'
  merged: boolean
  merged_at?: string | null
  merge_commit_sha?: string | null
  head?: { ref: string }
  user: GitHubUser | null
  created_at: string
  updated_at: string
}

/**
 * A single entry from the repo-wide list-PRs endpoint. Only the fields the
 * backfill needs are typed: identity (number), display (title), the filters
 * (draft, user.type), and the change marker (updated_at) used to decide whether
 * a session needs re-ingestion.
 */
export interface GitHubPRListItem {
  number: number
  title: string
  /** True for PRs still in draft state — excluded from backfill. */
  draft: boolean
  user: GitHubUser | null
  updated_at: string
}

export interface GitHubIssueComment {
  id: number
  /** Comment body. Null when the comment was submitted with no text. */
  body: string | null
  user: GitHubUser | null
  created_at: string
}

export interface GitHubReview {
  id: number
  /** Review body. Null for approval-only reviews (no comment text). */
  body: string | null
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  user: GitHubUser | null
  /** Null when the review is still PENDING (not yet submitted). */
  submitted_at: string | null
}

export interface GitHubReviewComment {
  id: number
  body: string | null
  /** File path the comment is attached to. */
  path: string
  /** Current line number. Null if the line no longer exists in the diff. */
  line: number | null
  /** Original line number at time of comment. */
  original_line: number | null
  user: GitHubUser | null
  created_at: string
}

/** Subset of the GitHub App installation response used by the install flow. */
export interface GitHubInstallation {
  id: number
  account: {
    login: string
    /** "Organization" | "User" */
    type: string
  }
}

/** Minimal repository metadata needed to resolve the branch we index. */
export interface GitHubRepository {
  id: number
  full_name: string
  default_branch: string
  private: boolean
}

/** A commit and the root tree it points to. */
export interface GitHubRepositoryCommit {
  sha: string
  commit: {
    tree: { sha: string }
  }
}

/** A single entry returned by GitHub's recursive Git Trees endpoint. */
export interface GitHubTreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
  url: string
}

export interface GitHubRepositoryTree {
  sha: string
  truncated: boolean
  tree: GitHubTreeEntry[]
}

export interface GitHubBlob {
  sha: string
  size: number
  encoding: 'base64' | string
  content: string
}

export interface GitHubRepositoryFile {
  type: 'file'
  encoding: 'base64' | string
  size: number
  name: string
  path: string
  sha: string
  content: string
  html_url: string
}

export interface GitHubReference {
  ref: string
  object: {
    type: 'commit'
    sha: string
  }
}

export interface GitHubFileWriteResult {
  content: {
    path: string
    sha: string
  } | null
  commit: {
    sha: string
    html_url: string
  }
}

export interface GitHubFilesCommitResult {
  sha: string
  html_url: string
}

export interface GitHubCreatedPullRequest {
  number: number
  html_url: string
  state: 'open' | 'closed'
  title: string
}

export interface GitHubFileCommitPage {
  commits: GitHubFileCommit[]
  hasMore: boolean
}

// =============================================================================
// Webhook signature verification
// =============================================================================

/**
 * Verify a GitHub webhook payload against its HMAC-SHA256 signature.
 *
 * @param rawBody        The raw request body string (must not be parsed JSON).
 * @param signatureHeader The full X-Hub-Signature-256 header value, e.g.
 *                        "sha256=abc123...". Returns false if the prefix is absent.
 * @param secret         The webhook secret configured in the GitHub App settings.
 */
export function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false

  const expectedHex = signatureHeader.slice('sha256='.length)

  const hmac = createHmac('sha256', secret)
  hmac.update(rawBody, 'utf-8')
  const actualHex = hmac.digest('hex')

  // Convert both to binary for constant-time comparison.
  // timingSafeEqual requires equal-length buffers; a malformed expectedHex
  // (not a 64-char hex string) would produce a different-length buffer, so
  // we check lengths explicitly before comparing.
  const expected = Buffer.from(expectedHex, 'hex')
  const actual = Buffer.from(actualHex, 'hex')

  if (expected.length !== actual.length) return false

  return timingSafeEqual(expected, actual)
}

// =============================================================================
// GitHub App authentication
// =============================================================================

/**
 * Create a signed RS256 JWT for GitHub App auth.
 *
 * Resolves the private key in priority order:
 *   1. GITHUB_APP_PRIVATE_KEY env var (base64-encoded PKCS#1 DER)
 *   2. Upstash Redis key "github:app:private-key" (same format)
 *      — used when the env var exceeds the Lambda 4KB env var limit.
 *
 * Throws if GITHUB_APP_ID is absent or no private key can be resolved.
 */
async function getAppJWT(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID
  if (!appId) {
    throw new Error('GITHUB_APP_ID environment variable is not set')
  }

  let privateKeyB64 = process.env.GITHUB_APP_PRIVATE_KEY

  if (!privateKeyB64) {
    const redis = buildRedis()
    if (!redis) {
      throw new Error(
        'GITHUB_APP_PRIVATE_KEY is not set and Upstash Redis is not configured'
      )
    }
    const fromRedis = await redis.get<string>(PRIVATE_KEY_REDIS_KEY)
    if (!fromRedis) {
      throw new Error(
        `GITHUB_APP_PRIVATE_KEY is not set and Redis key "${PRIVATE_KEY_REDIS_KEY}" is empty`
      )
    }
    privateKeyB64 = fromRedis
  }

  const privateKey = parseAppPrivateKey(privateKeyB64)
  return createGitHubJWT(appId.trim(), privateKey)
}

/**
 * Parse the GITHUB_APP_PRIVATE_KEY env var into a KeyObject.
 *
 * The expected format is base64-encoded PKCS#1 DER, produced from a
 * GitHub-issued .pem with:
 *   openssl rsa -in key.pem -outform DER | base64
 *
 * Two historical mistakes are detected explicitly and rewritten into an
 * actionable error, so ops don't hit the opaque OpenSSL
 * `DECODER routines::unsupported` message and wonder what's wrong:
 *
 *   1. Raw PEM text pasted directly (includes the BEGIN header).
 *   2. Base64-encoded PEM text (the pre-migration format) — identifiable
 *      because its base64-decoded bytes start with the ASCII header
 *      "-----".
 *
 * Any other parse failure is also wrapped with context.
 */
export function parseAppPrivateKey(privateKeyB64: string): KeyObject {
  if (privateKeyB64.includes('-----BEGIN')) {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY appears to contain raw PEM text. ' +
        'Expected base64-encoded PKCS#1 DER. ' +
        'Regenerate with: openssl rsa -in key.pem -outform DER | base64',
    )
  }

  const rawBytes = Buffer.from(privateKeyB64, 'base64')

  if (rawBytes.length >= 5 && rawBytes.subarray(0, 5).toString('ascii') === '-----') {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY appears to be base64-encoded PEM text (pre-migration format). ' +
        'Expected base64-encoded PKCS#1 DER. ' +
        'Regenerate with: openssl rsa -in key.pem -outform DER | base64',
    )
  }

  try {
    return createPrivateKey({ key: rawBytes, format: 'der', type: 'pkcs1' })
  } catch (err) {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY could not be parsed as PKCS#1 DER: ' +
        `${(err as Error).message}. ` +
        'Regenerate with: openssl rsa -in key.pem -outform DER | base64',
    )
  }
}

/**
 * Generate a short-lived installation access token for the given GitHub App
 * installation. Delegates to the in-memory cache which honors the token's
 * real expires_at minus a 60-second safety margin. See installation-token.ts.
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  const { getInstallationTokenCached } = await import('./installation-token')
  return getInstallationTokenCached(installationId)
}

/**
 * Raw installation-token fetch — bypasses the cache and returns the token
 * together with its epoch-ms expiry. Intended for the cache module itself;
 * application code should prefer getInstallationToken.
 */
export async function getInstallationTokenRaw(
  installationId: number,
): Promise<{ token: string; expiresAt: number }> {
  const jwt = await getAppJWT()

  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub installation token request failed with status ${res.status}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  const data = (await res.json()) as { token: string; expires_at?: string }
  // GitHub returns ISO 8601 expires_at; fall back to +55 minutes if absent so
  // we still cache, just conservatively. (Real responses always include it.)
  const expiresAt = data.expires_at
    ? Date.parse(data.expires_at)
    : Date.now() + 55 * 60_000
  return { token: data.token, expiresAt }
}

/**
 * Fetch the account details for a GitHub App installation.
 * Used during the install callback to determine the account login and type
 * (Organization vs User) without requiring a user-level OAuth token.
 *
 * Authenticates as the GitHub App itself (not as an installation).
 */
export async function getInstallationDetails(
  installationId: number,
): Promise<GitHubInstallation> {
  const jwt = await getAppJWT()

  const url = `${GITHUB_API}/app/installations/${installationId}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  return (await res.json()) as GitHubInstallation
}

/**
 * List every repository the App installation can access, following Link-header
 * pagination. Authenticates with the installation access token (not the app
 * JWT). Unlike most list endpoints, `/installation/repositories` wraps each
 * page in `{ total_count, repositories: [...] }`, so it can't reuse
 * fetchAllPages (which expects a bare array per page).
 */
export async function listInstallationRepos(
  installationId: number,
): Promise<GitHubAvailableRepo[]> {
  const token = await getInstallationToken(installationId)
  const results: GitHubAvailableRepo[] = []
  let nextUrl: string | null = `${GITHUB_API}/installation/repositories?per_page=100`

  while (nextUrl) {
    const res: Response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })

    if (!res.ok) {
      const body = await readErrorBody(res)
      throw new GitHubApiError(
        `GitHub API responded ${res.status} for ${nextUrl}${body ? `: ${body}` : ''}`,
        res.status,
      )
    }

    const page = (await res.json()) as {
      repositories?: Array<{
        id: number
        name: string
        full_name: string
        private: boolean
      }>
    }
    for (const r of page.repositories ?? []) {
      results.push({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
      })
    }

    const linkHeader: string | null = res.headers.get('Link')
    nextUrl = linkHeader ? parseNextPageUrl(linkHeader) : null
  }

  return results
}

/** Fetch repository metadata with an installation token. */
export async function getRepository(
  token: string,
  repoFullName: string,
): Promise<GitHubRepository> {
  const url = `${GITHUB_API}/repos/${repoFullName}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  return (await res.json()) as GitHubRepository
}

/** Resolve a branch, tag, or commit SHA to the commit and its root tree. */
export async function getRepositoryCommit(
  token: string,
  repoFullName: string,
  ref: string,
): Promise<GitHubRepositoryCommit> {
  const url = `${GITHUB_API}/repos/${repoFullName}/commits/${encodeURIComponent(ref)}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  return (await res.json()) as GitHubRepositoryCommit
}

/** Recursively list the files below a Git tree. */
export async function getRepositoryTree(
  token: string,
  repoFullName: string,
  treeSha: string,
): Promise<GitHubRepositoryTree> {
  const url = `${GITHUB_API}/repos/${repoFullName}/git/trees/${treeSha}?recursive=1`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  return (await res.json()) as GitHubRepositoryTree
}

/** Fetch one Git blob. GitHub always returns blob content as base64. */
export async function getRepositoryBlob(
  token: string,
  repoFullName: string,
  blobSha: string,
): Promise<GitHubBlob> {
  const url = `${GITHUB_API}/repos/${repoFullName}/git/blobs/${blobSha}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  return (await res.json()) as GitHubBlob
}

function encodeGitHubPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

function repositoryHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * Read one repository file exactly as it exists at a branch, tag, or commit.
 * The Contents API returns base64 for normal-sized text files; directory
 * responses are rejected because document sessions always point at a file.
 */
export async function getRepositoryFile(
  token: string,
  repoFullName: string,
  path: string,
  ref: string,
): Promise<GitHubRepositoryFile> {
  const url =
    `${GITHUB_API}/repos/${repoFullName}/contents/${encodeGitHubPath(path)}` +
    `?ref=${encodeURIComponent(ref)}`
  const res = await fetch(url, {
    headers: repositoryHeaders(token),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  const payload = (await res.json()) as GitHubRepositoryFile | unknown[]
  if (Array.isArray(payload) || payload.type !== 'file') {
    throw new GitHubApiError(`GitHub path is not a file: ${path}`, 422)
  }
  return payload
}

/** Resolve a branch name to its current commit SHA. */
export async function getRepositoryBranchReference(
  token: string,
  repoFullName: string,
  branch: string,
): Promise<GitHubReference | null> {
  const refPath = encodeGitHubPath(`heads/${branch}`)
  const url = `${GITHUB_API}/repos/${repoFullName}/git/ref/${refPath}`
  const res = await fetch(url, {
    headers: repositoryHeaders(token),
    signal: AbortSignal.timeout(8000),
  })

  if (res.status === 404) return null
  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }
  return (await res.json()) as GitHubReference
}

/**
 * Create a feature branch at an exact commit. If it already exists, return its
 * current reference so retries remain idempotent.
 */
export async function createRepositoryBranch(
  token: string,
  repoFullName: string,
  branch: string,
  commitSha: string,
): Promise<GitHubReference> {
  const existing = await getRepositoryBranchReference(token, repoFullName, branch)
  if (existing) return existing

  const url = `${GITHUB_API}/repos/${repoFullName}/git/refs`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...repositoryHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    }),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    // A retry can race the first successful request. Resolve the branch once
    // before surfacing GitHub's conflict.
    if (res.status === 422) {
      const raced = await getRepositoryBranchReference(token, repoFullName, branch)
      if (raced) return raced
    }
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }
  return (await res.json()) as GitHubReference
}

/** Commit one complete file body to a branch using GitHub's Contents API. */
export async function createOrUpdateRepositoryFile(
  token: string,
  repoFullName: string,
  args: {
    path: string
    branch: string
    message: string
    content: string
    currentBlobSha?: string | null
  },
): Promise<GitHubFileWriteResult> {
  const url = `${GITHUB_API}/repos/${repoFullName}/contents/${encodeGitHubPath(args.path)}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...repositoryHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: args.message,
      content: Buffer.from(args.content, 'utf8').toString('base64'),
      branch: args.branch,
      ...(args.currentBlobSha ? { sha: args.currentBlobSha } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }
  return (await res.json()) as GitHubFileWriteResult
}

/**
 * Apply several file additions, replacements, and removals to a branch in one
 * atomic commit. The branch update uses force=false so a concurrent GitHub
 * change fails instead of being overwritten.
 */
const GITHUB_BLOB_WRITE_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++
      output[index] = await fn(values[index]!)
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

export async function createRepositoryFilesCommit(
  token: string,
  repoFullName: string,
  args: {
    branch: string
    baseCommitSha: string
    baseTreeSha: string
    message: string
    files: Array<{ path: string; content: string }>
    deletePaths?: string[]
  },
): Promise<GitHubFilesCommitResult> {
  if (args.files.length === 0 && (args.deletePaths?.length ?? 0) === 0) {
    throw new GitHubApiError('At least one file change is required for a GitHub commit.', 422)
  }

  const blobs = await mapWithConcurrency(
    args.files,
    GITHUB_BLOB_WRITE_CONCURRENCY,
    async (file) => {
      const url = `${GITHUB_API}/repos/${repoFullName}/git/blobs`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...repositoryHeaders(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        const body = await readErrorBody(res)
        throw new GitHubApiError(
          `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
          res.status,
        )
      }
      const blob = (await res.json()) as { sha: string }
      return {
        path: file.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blob.sha,
      }
    },
  )

  const treeEntries: Array<{
    path: string
    mode: '100644'
    type: 'blob'
    sha: string | null
  }> = [
    ...blobs,
    ...[...new Set(args.deletePaths ?? [])]
      .filter((path) => !args.files.some((file) => file.path === path))
      .map((path) => ({ path, mode: '100644' as const, type: 'blob' as const, sha: null })),
  ]

  const treeUrl = `${GITHUB_API}/repos/${repoFullName}/git/trees`
  const treeResponse = await fetch(treeUrl, {
    method: 'POST',
    headers: {
      ...repositoryHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ base_tree: args.baseTreeSha, tree: treeEntries }),
    signal: AbortSignal.timeout(15000),
  })
  if (!treeResponse.ok) {
    const body = await readErrorBody(treeResponse)
    throw new GitHubApiError(
      `GitHub API responded ${treeResponse.status} for ${treeUrl}${body ? `: ${body}` : ''}`,
      treeResponse.status,
    )
  }
  const tree = (await treeResponse.json()) as { sha: string }

  const commitUrl = `${GITHUB_API}/repos/${repoFullName}/git/commits`
  const commitResponse = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      ...repositoryHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: args.message,
      tree: tree.sha,
      parents: [args.baseCommitSha],
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!commitResponse.ok) {
    const body = await readErrorBody(commitResponse)
    throw new GitHubApiError(
      `GitHub API responded ${commitResponse.status} for ${commitUrl}${body ? `: ${body}` : ''}`,
      commitResponse.status,
    )
  }
  const commit = (await commitResponse.json()) as GitHubFilesCommitResult

  const refUrl =
    `${GITHUB_API}/repos/${repoFullName}/git/refs/heads/` +
    encodeGitHubPath(args.branch)
  const refResponse = await fetch(refUrl, {
    method: 'PATCH',
    headers: {
      ...repositoryHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sha: commit.sha, force: false }),
    signal: AbortSignal.timeout(10000),
  })
  if (!refResponse.ok) {
    const body = await readErrorBody(refResponse)
    throw new GitHubApiError(
      `GitHub API responded ${refResponse.status} for ${refUrl}${body ? `: ${body}` : ''}`,
      refResponse.status,
    )
  }

  return commit
}

/** Open a pull request from a Breezify edit branch to the deployment branch. */
export async function createRepositoryPullRequest(
  token: string,
  repoFullName: string,
  args: {
    head: string
    base: string
    title: string
    body: string
  },
): Promise<GitHubCreatedPullRequest> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...repositoryHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }
  return (await res.json()) as GitHubCreatedPullRequest
}

/**
 * Find the open pull request for a branch, if one already exists.
 *
 * This makes publishing retry-safe when GitHub accepted the PR but the
 * subsequent database reconciliation failed.
 */
export async function findOpenRepositoryPullRequest(
  token: string,
  repoFullName: string,
  args: {
    head: string
    base: string
  },
): Promise<GitHubCreatedPullRequest | null> {
  const owner = repoFullName.split("/", 1)[0]
  const params = new URLSearchParams({
    state: "open",
    head: `${owner}:${args.head}`,
    base: args.base,
    per_page: "1",
  })
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?${params.toString()}`
  const res = await fetch(url, {
    headers: repositoryHeaders(token),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ""}`,
      res.status,
    )
  }
  const pullRequests = (await res.json()) as GitHubCreatedPullRequest[]
  return pullRequests[0] ?? null
}

/** List one GitHub-style page of commits that touched a specific file. */
export async function listRepositoryFileCommits(
  token: string,
  repoFullName: string,
  args: {
    path: string
    branch: string
    page?: number
    perPage?: number
  },
): Promise<GitHubFileCommitPage> {
  const page = Math.max(1, args.page ?? 1)
  const perPage = Math.min(100, Math.max(1, args.perPage ?? 50))
  const params = new URLSearchParams({
    path: args.path,
    sha: args.branch,
    page: String(page),
    per_page: String(perPage),
  })
  const url = `${GITHUB_API}/repos/${repoFullName}/commits?${params.toString()}`
  const res = await fetch(url, {
    headers: repositoryHeaders(token),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  const payload = (await res.json()) as Array<{
    sha: string
    html_url: string
    commit: {
      message: string
      author: { name: string; date: string } | null
      committer: { name: string; date: string } | null
    }
    author: { login: string; avatar_url: string } | null
  }>
  const link = res.headers.get('Link') ?? ''
  return {
    commits: payload.map((item) => ({
      sha: item.sha,
      html_url: item.html_url,
      message: item.commit.message,
      authored_at:
        item.commit.author?.date ??
        item.commit.committer?.date ??
        new Date(0).toISOString(),
      author_name:
        item.commit.author?.name ??
        item.commit.committer?.name ??
        item.author?.login ??
        'Unknown',
      author_login: item.author?.login ?? null,
      author_avatar_url: item.author?.avatar_url ?? null,
    })),
    hasMore: /rel="next"/.test(link),
  }
}

// =============================================================================
// Private: JWT creation
// =============================================================================

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

/**
 * Create a signed RS256 JWT for GitHub App authentication.
 *
 * Claims:
 *   iat  — now minus 60 seconds (clock-skew tolerance)
 *   exp  — iat plus 540 seconds (9 minutes — within GitHub's 10-minute limit)
 *   iss  — the GitHub App ID (string)
 */
function createGitHubJWT(appId: string, privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000)
  const iat = now - 60

  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = base64url(
    Buffer.from(JSON.stringify({ iat, exp: iat + 540, iss: appId })),
  )
  const signingInput = `${header}.${payload}`

  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()

  const signature = base64url(signer.sign(privateKey))
  return `${signingInput}.${signature}`
}

// =============================================================================
// Private: Paginated fetch helper
// =============================================================================

/**
 * Fetch all pages of a GitHub list endpoint, following Link header pagination.
 * Starts at baseUrl?per_page=100, then follows the "next" link until exhausted.
 *
 * Throws on any non-200 response. Logs a warning when the rate limit is exhausted.
 */
async function fetchAllPages<T>(baseUrl: string, token: string): Promise<T[]> {
  const results: T[] = []
  // baseUrl may already carry a query string (e.g. ?state=open); pick the right
  // separator so the per_page param doesn't produce a malformed "?...?per_page".
  const separator = baseUrl.includes('?') ? '&' : '?'
  let nextUrl: string | null = `${baseUrl}${separator}per_page=100`
  // Hard page cap so a high-traffic PR (or repo) can't walk pagination
  // unbounded on the synchronous cron path. 5 × 100 = 500 items is ample;
  // anything beyond ingests across subsequent ticks.
  let pages = 0
  const MAX_PAGES = 5

  while (nextUrl) {
    const res: Response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      const remaining = res.headers.get('X-RateLimit-Remaining')
      if (remaining !== null && parseInt(remaining, 10) === 0) {
        console.error('[Breezify] GitHub API rate limit exhausted for:', baseUrl)
      }
      const body = await readErrorBody(res)
      throw new GitHubApiError(
        `GitHub API responded ${res.status} for ${baseUrl}${body ? `: ${body}` : ''}`,
        res.status,
      )
    }

    const page = (await res.json()) as T[]
    results.push(...page)

    const linkHeader: string | null = res.headers.get('Link')
    nextUrl = linkHeader ? parseNextPageUrl(linkHeader) : null
    if (++pages >= MAX_PAGES) break
  }

  return results
}

/**
 * Extract the "next" page URL from a GitHub Link response header.
 * Returns null if no next page exists.
 *
 * Link header format:
 *   <https://api.github.com/...?page=2>; rel="next", <...>; rel="last"
 */
function parseNextPageUrl(linkHeader: string): string | null {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
  return match?.[1] ?? null
}

// =============================================================================
// GitHub REST API — public
// =============================================================================

/**
 * Fetch the PR metadata (title, body, author, state, merge status).
 * Single-item fetch — not paginated.
 */
export async function getPullRequest(
  token: string,
  repoFullName: string,
  prNumber: number,
): Promise<GitHubPR> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }

  return (await res.json()) as GitHubPR
}

/**
 * List all open pull requests for a repository, following Link-header
 * pagination. Used by the sweep/backfill to discover PRs that opened before the
 * repo was monitored — the webhook only ever creates sessions for events fired
 * after install, so without this the integration never sees pre-existing PRs.
 *
 * Returns lightweight list items; full PR content (comments, reviews) is fetched
 * per-PR by ingestPR when a session is actually re-ingested.
 */
export async function listOpenPullRequests(
  token: string,
  repoFullName: string,
): Promise<GitHubPRListItem[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?state=open`
  return fetchAllPages<GitHubPRListItem>(url, token)
}

/** List the most recently updated closed PRs for legacy hosted-docs recovery. */
export async function listRecentClosedPullRequests(
  token: string,
  repoFullName: string,
  perPage = 50,
): Promise<GitHubPR[]> {
  const params = new URLSearchParams({
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: String(Math.min(100, Math.max(1, perPage))),
  })
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?${params.toString()}`
  const res = await fetch(url, {
    headers: repositoryHeaders(token),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const body = await readErrorBody(res)
    throw new GitHubApiError(
      `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
      res.status,
    )
  }
  return (await res.json()) as GitHubPR[]
}

/**
 * Fetch all top-level PR discussion comments (the general conversation thread).
 * These correspond to `issue_comment` webhook events on PRs.
 * Not the same as inline code review comments — see getPRReviewComments.
 */
export async function getPRComments(
  token: string,
  repoFullName: string,
  prNumber: number,
): Promise<GitHubIssueComment[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/issues/${prNumber}/comments`
  return fetchAllPages<GitHubIssueComment>(url, token)
}

/**
 * Fetch all reviews submitted on a PR (approvals, change requests, comment
 * submissions). Each review has an optional body and a state. Inline line-level
 * comments within a review are fetched separately via getPRReviewComments.
 */
export async function getPRReviews(
  token: string,
  repoFullName: string,
  prNumber: number,
): Promise<GitHubReview[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}/reviews`
  return fetchAllPages<GitHubReview>(url, token)
}

/**
 * Fetch all inline code review comments on a PR.
 * These are attached to specific lines in the diff and correspond to
 * `pull_request_review_comment` webhook events.
 */
export async function getPRReviewComments(
  token: string,
  repoFullName: string,
  prNumber: number,
): Promise<GitHubReviewComment[]> {
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}/comments`
  return fetchAllPages<GitHubReviewComment>(url, token)
}
