import { GitHubApiError } from './retry'

const GITHUB_API = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
const REQUEST_TIMEOUT_MS = 8000
const MAX_ERROR_BODY = 500

export type GitHubCheckRunStatus = 'queued' | 'in_progress' | 'completed'

export type GitHubCheckRunConclusion =
  | 'action_required'
  | 'cancelled'
  | 'failure'
  | 'neutral'
  | 'success'
  | 'skipped'
  | 'stale'
  | 'timed_out'

/** Conclusions callers may publish; GitHub alone may assign `stale`. */
export type GitHubWritableCheckRunConclusion = Exclude<
  GitHubCheckRunConclusion,
  'stale'
>

export type GitHubCheckAnnotationLevel = 'notice' | 'warning' | 'failure'

export interface GitHubCheckAnnotation {
  path: string
  start_line: number
  end_line: number
  start_column?: number
  end_column?: number
  annotation_level: GitHubCheckAnnotationLevel
  message: string
  title?: string
  raw_details?: string
}

export interface GitHubCheckOutput {
  title: string
  summary: string
  text?: string
  /** GitHub accepts at most 50 annotations in one create or update request. */
  annotations?: GitHubCheckAnnotation[]
}

interface CreateGitHubCheckRunBase {
  name: string
  head_sha: string
  /** Stable caller identity used to correlate deliveries without exposing it in the UI. */
  external_id?: string
  details_url?: string
  started_at?: string
  output?: GitHubCheckOutput
}

export type CreateGitHubCheckRunInput = CreateGitHubCheckRunBase & (
  | {
      status: Exclude<GitHubCheckRunStatus, 'completed'>
      conclusion?: never
      completed_at?: never
    }
  | {
      status: 'completed'
      conclusion: GitHubWritableCheckRunConclusion
      completed_at?: string
    }
)

interface UpdateGitHubCheckRunBase {
  details_url?: string
  output?: GitHubCheckOutput
}

export type UpdateGitHubCheckRunInput = UpdateGitHubCheckRunBase & (
  | {
      status?: Exclude<GitHubCheckRunStatus, 'completed'>
      conclusion?: never
      completed_at?: never
    }
  | {
      status: 'completed'
      conclusion: GitHubWritableCheckRunConclusion
      completed_at?: string
    }
)

/** The subset of a check-run response used to complete or link to the run. */
export interface GitHubCheckRun {
  id: number
  html_url: string
  status: GitHubCheckRunStatus
  conclusion: GitHubCheckRunConclusion | null
}

function requestHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  }
}

function redact(value: string, secret: string): string {
  if (!secret) return value
  return value.split(secret).join('[REDACTED]')
}

/**
 * Preserve GitHub's diagnostic body (including secondary-rate-limit wording)
 * without letting an echoed installation credential or an unbounded upstream
 * response enter logs.
 */
async function readErrorBody(res: Response, token: string): Promise<string> {
  try {
    const body = redact(await res.text(), token)
    return body.length > MAX_ERROR_BODY ? body.slice(0, MAX_ERROR_BODY) : body
  } catch {
    return ''
  }
}

async function throwCheckRunError(
  res: Response,
  url: string,
  token: string,
): Promise<never> {
  const body = await readErrorBody(res, token)
  throw new GitHubApiError(
    `GitHub API responded ${res.status} for ${url}${body ? `: ${body}` : ''}`,
    res.status,
  )
}

/** Create an App-owned check run for a commit. */
export async function createGitHubCheckRun(
  token: string,
  repoFullName: string,
  input: CreateGitHubCheckRunInput,
): Promise<GitHubCheckRun> {
  const url = `${GITHUB_API}/repos/${repoFullName}/check-runs`
  const res = await fetch(url, {
    method: 'POST',
    headers: requestHeaders(token),
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) await throwCheckRunError(res, url, token)
  return (await res.json()) as GitHubCheckRun
}

/** Update an App-owned check run created by this GitHub App installation. */
export async function updateGitHubCheckRun(
  token: string,
  repoFullName: string,
  checkRunId: number,
  input: UpdateGitHubCheckRunInput,
): Promise<GitHubCheckRun> {
  const url = `${GITHUB_API}/repos/${repoFullName}/check-runs/${checkRunId}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: requestHeaders(token),
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) await throwCheckRunError(res, url, token)
  return (await res.json()) as GitHubCheckRun
}
