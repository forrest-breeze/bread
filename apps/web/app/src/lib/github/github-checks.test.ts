import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGitHubCheckRun,
  updateGitHubCheckRun,
  type CreateGitHubCheckRunInput,
  type GitHubCheckRun,
  type UpdateGitHubCheckRunInput,
} from './github-checks'
import { GitHubApiError } from './retry'

const TOKEN = 'ghs_installation-token-that-must-stay-secret'
const REPO = 'acmecorp/api-service'

function mockJsonResponse<T>(data: T, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createGitHubCheckRun', () => {
  it('posts the complete check-run input and returns GitHub output', async () => {
    const input: CreateGitHubCheckRunInput = {
      name: 'Validate Bread docs',
      head_sha: 'abc123',
      external_id: 'bread-docs:123:abc123',
      status: 'completed',
      details_url: 'https://app.example.dev/checks/abc123',
      started_at: '2026-08-19T12:00:00Z',
      completed_at: '2026-08-19T12:00:02Z',
      conclusion: 'failure',
      output: {
        title: 'Bread document validation failed',
        summary: 'One document needs attention.',
        text: 'Fix the annotated document and push again.',
        annotations: [{
          path: 'docs/setup.md',
          start_line: 1,
          end_line: 1,
          start_column: 1,
          end_column: 3,
          annotation_level: 'failure',
          message: 'Document must start with Bread frontmatter.',
          title: 'Invalid Bread document',
          raw_details: 'Expected an opening --- delimiter.',
        }],
      },
    }
    const response: GitHubCheckRun = {
      id: 987,
      html_url: 'https://github.com/acmecorp/api-service/runs/987',
      status: 'completed',
      conclusion: 'failure',
    }
    const mockFetch = vi.fn().mockResolvedValue(mockJsonResponse(response, 201))
    vi.stubGlobal('fetch', mockFetch)

    await expect(createGitHubCheckRun(TOKEN, REPO, input)).resolves.toEqual(response)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://api.github.com/repos/${REPO}/check-runs`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
    expect(JSON.parse(init.body as string)).toEqual(input)
  })

  it('redacts the installation token and bounds a GitHub error body', async () => {
    const suffixOutsideBound = 'SHOULD_NOT_REACH_THE_ERROR'
    const responseBody = `GitHub rejected ${TOKEN}: ${'x'.repeat(700)}${suffixOutsideBound}`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve(responseBody),
    } as Response))

    const error = await createGitHubCheckRun(TOKEN, REPO, {
      name: 'Validate Bread docs',
      head_sha: 'abc123',
      status: 'queued',
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).toMatchObject({ status: 422 })
    const message = (error as Error).message
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(TOKEN)
    expect(message).not.toContain(suffixOutsideBound)
    const errorBody = message.slice(message.indexOf(': ', message.indexOf('https://')) + 2)
    expect(errorBody.length).toBeLessThanOrEqual(500)
  })
})

describe('updateGitHubCheckRun', () => {
  it('patches only the supplied completion fields and returns the updated run', async () => {
    const input: UpdateGitHubCheckRunInput = {
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-08-19T12:00:02Z',
      details_url: 'https://app.example.dev/checks/abc123',
      output: {
        title: 'Bread documents are valid',
        summary: 'All 12 Bread documents passed validation.',
      },
    }
    const response: GitHubCheckRun = {
      id: 987,
      html_url: 'https://github.com/acmecorp/api-service/runs/987',
      status: 'completed',
      conclusion: 'success',
    }
    const mockFetch = vi.fn().mockResolvedValue(mockJsonResponse(response))
    vi.stubGlobal('fetch', mockFetch)

    await expect(updateGitHubCheckRun(TOKEN, REPO, 987, input)).resolves.toEqual(response)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://api.github.com/repos/${REPO}/check-runs/987`)
    expect(init.method).toBe('PATCH')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
    expect(JSON.parse(init.body as string)).toEqual(input)
  })
})
