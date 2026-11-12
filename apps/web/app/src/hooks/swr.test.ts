import useSWR from "swr"
import { describe, expect, it, vi } from "vitest"
import {
  githubHostedDocsPublishStatusRefreshInterval,
  githubHostedDocsRefreshInterval,
  isGithubHostedDocsPublishStatusKey,
  usePortalDraft,
} from "./swr"

vi.mock("swr", () => ({
  default: vi.fn(),
}))

describe("usePortalDraft", () => {
  it("does not reuse the previous project draft while a new project key loads", () => {
    usePortalDraft("help", { workspaceId: "ws-1" })

    expect(useSWR).toHaveBeenCalledWith(
      ["/api/portal/draft?project=help", "ws-1"],
      expect.any(Function),
      expect.objectContaining({
        keepPreviousData: false,
        revalidateOnFocus: false,
      }),
    )
  })

  it("scopes the cache key to the active workspace so a switch starts fresh", () => {
    usePortalDraft("help", { workspaceId: "ws-2" })

    expect(useSWR).toHaveBeenCalledWith(
      ["/api/portal/draft?project=help", "ws-2"],
      expect.any(Function),
      expect.anything(),
    )
  })

  it("does not fetch until the workspace id is known", () => {
    usePortalDraft("help")

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Function), expect.anything())
  })
})

describe("githubHostedDocsRefreshInterval", () => {
  it("keeps polling while a pull request is waiting to activate the link", () => {
    expect(
      githubHostedDocsRefreshInterval({
        source: { sync_status: "disabled" },
      }),
    ).toBe(5_000)
  })

  it.each(["pending", "syncing"] as const)(
    "keeps polling while the link is %s",
    (syncStatus) => {
      expect(
        githubHostedDocsRefreshInterval({
          source: { sync_status: syncStatus },
        }),
      ).toBe(5_000)
    },
  )

  it.each(["synced", "error"] as const)(
    "stops polling once the link is %s",
    (syncStatus) => {
      expect(
        githubHostedDocsRefreshInterval({
          source: { sync_status: syncStatus },
        }),
      ).toBe(0)
    },
  )
})

describe("githubHostedDocsPublishStatusRefreshInterval", () => {
  it("polls while the default branch still needs inbound sync", () => {
    expect(
      githubHostedDocsPublishStatusRefreshInterval({
        status: "sync_required",
        changed_file_count: 0,
        written_file_count: 0,
        deleted_file_count: 0,
        unchanged_file_count: 0,
        compared_commit_sha: "abc123",
      }),
    ).toBe(5_000)
    expect(
      githubHostedDocsPublishStatusRefreshInterval({
        status: "up_to_date",
        changed_file_count: 0,
        written_file_count: 0,
        deleted_file_count: 0,
        unchanged_file_count: 84,
        compared_commit_sha: "abc123",
      }),
    ).toBe(0)
  })

  it("polls while another publish holds the source lease", () => {
    expect(
      githubHostedDocsPublishStatusRefreshInterval({
        status: "blocked",
        changed_file_count: 0,
        written_file_count: 0,
        deleted_file_count: 0,
        unchanged_file_count: 0,
        compared_commit_sha: null,
        code: "publish_in_progress",
      }),
    ).toBe(5_000)
  })
})

describe("isGithubHostedDocsPublishStatusKey", () => {
  it("matches publish status keys without matching the expensive diff", () => {
    expect(
      isGithubHostedDocsPublishStatusKey(
        "/api/github/hosted-docs/publish?basis=source-1",
      ),
    ).toBe(true)
    expect(
      isGithubHostedDocsPublishStatusKey(
        "/api/github/hosted-docs/publish/diff?basis=comparison-1",
      ),
    ).toBe(false)
  })
})
