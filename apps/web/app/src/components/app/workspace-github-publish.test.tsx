// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PREPARE_WORKSPACE_PUBLISH_EVENT,
  type PrepareWorkspacePublishEventDetail,
} from "@/lib/workspace-publish-events"

const harness = vi.hoisted(() => ({
  role: "editor",
  isLoading: false,
  hasSource: true,
  mutate: vi.fn(),
  mutatePublishStatus: vi.fn(),
  publishStatusLoading: false,
  publishStatusError: null as Error | null,
  publishStatus: {
    status: "changes",
    changed_file_count: 1,
    written_file_count: 1,
    deleted_file_count: 0,
    unchanged_file_count: 83,
    compared_commit_sha: "abc123",
  } as Record<string, unknown> | undefined,
  source: {
    id: "source-1",
    repo_full_name: "example-org/breezify-docs",
    sync_status: "synced",
    publish_pull_request_number: null as number | null,
    publish_pull_request_url: null as string | null,
  } as Record<string, unknown>,
}))

vi.mock("@/hooks/swr", () => ({
  useWorkspace: () => ({
    data: { id: "workspace-1", user_role: harness.role },
  }),
  useGithubHostedDocs: () => ({
    data: { source: harness.hasSource ? harness.source : null },
    isLoading: harness.isLoading,
    mutate: harness.mutate,
  }),
  useGithubHostedDocsPublishStatus: () => ({
    data: harness.publishStatus,
    error: harness.publishStatusError,
    isLoading: harness.publishStatusLoading,
    mutate: harness.mutatePublishStatus,
  }),
}))

import { WorkspaceGitHubPublish } from "./workspace-github-publish"

beforeEach(() => {
  harness.role = "editor"
  harness.isLoading = false
  harness.hasSource = true
  harness.mutate.mockReset()
  harness.mutatePublishStatus.mockReset()
  harness.publishStatusLoading = false
  harness.publishStatusError = null
  harness.publishStatus = {
    status: "changes",
    changed_file_count: 1,
    written_file_count: 1,
    deleted_file_count: 0,
    unchanged_file_count: 83,
    compared_commit_sha: "abc123",
  }
  harness.source = {
    id: "source-1",
    repo_full_name: "example-org/breezify-docs",
    sync_status: "synced",
    publish_pull_request_number: null,
    publish_pull_request_url: null,
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("WorkspaceGitHubPublish", () => {
  it("saves the active document before creating one workspace pull request", async () => {
    const user = userEvent.setup()
    let finishSave: ((saved: boolean) => void) | undefined
    window.addEventListener(
      PREPARE_WORKSPACE_PUBLISH_EVENT,
      (event) => {
        const detail = (
          event as CustomEvent<PrepareWorkspacePublishEventDetail>
        ).detail
        detail.waitUntil(
          new Promise<boolean>((resolve) => {
            finishSave = resolve
          }),
        )
      },
      { once: true },
    )
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          pull_request_number: 41,
          pull_request_url: "https://github.test/pull/41",
          changed_file_count: 3,
          reused: false,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    render(<WorkspaceGitHubPublish />)
    await user.click(screen.getByRole("button", { name: "Publish workspace" }))
    expect(
      screen.getByRole("heading", { name: "Publish workspace changes?" }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Create pull request" }))
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => finishSave?.(true))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/github/hosted-docs/publish",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      )
    })
    expect(harness.mutate).toHaveBeenCalledTimes(2)
  })

  it("keeps an open pull request actionable and exposes its link", async () => {
    const user = userEvent.setup()
    harness.source = {
      ...harness.source,
      publish_pull_request_number: 52,
      publish_pull_request_url: "https://github.test/pull/52",
    }

    render(<WorkspaceGitHubPublish />)

    expect(
      screen.getByRole("link", { name: /View pull request #52/ }),
    ).toHaveAttribute("href", "https://github.test/pull/52")
    await user.click(screen.getByRole("button", { name: "Update pull request" }))
    expect(
      screen.getByRole("heading", {
        name: "Update the workspace pull request?",
      }),
    ).toBeInTheDocument()
  })

  it("leaves diff navigation to the Changes sidebar tab", () => {
    render(<WorkspaceGitHubPublish />)

    expect(
      screen.queryByRole("link", { name: /View diff/i }),
    ).not.toBeInTheDocument()
  })

  it("hides the publish action when GitHub already matches", () => {
    harness.publishStatus = {
      status: "up_to_date",
      changed_file_count: 0,
      written_file_count: 0,
      deleted_file_count: 0,
      unchanged_file_count: 84,
      compared_commit_sha: "abc123",
    }

    render(<WorkspaceGitHubPublish />)

    expect(screen.getByText("GitHub up to date")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Publish workspace" }),
    ).not.toBeInTheDocument()
  })

  it("dismisses the up-to-date acknowledgement after a short delay", () => {
    vi.useFakeTimers()
    harness.publishStatus = {
      status: "up_to_date",
      changed_file_count: 0,
      written_file_count: 0,
      deleted_file_count: 0,
      unchanged_file_count: 84,
      compared_commit_sha: "abc123",
    }

    render(<WorkspaceGitHubPublish />)

    expect(screen.getByText("GitHub up to date")).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.queryByText("GitHub up to date")).not.toBeInTheDocument()
  })

  it("shows only the link when the open pull request is up to date", () => {
    harness.source = {
      ...harness.source,
      publish_pull_request_number: 52,
      publish_pull_request_url: "https://github.test/pull/52",
    }
    harness.publishStatus = {
      status: "up_to_date",
      changed_file_count: 0,
      written_file_count: 0,
      deleted_file_count: 0,
      unchanged_file_count: 84,
      compared_commit_sha: "abc123",
      pull_request_up_to_date: true,
    }

    render(<WorkspaceGitHubPublish />)

    expect(screen.getByText("Pull request up to date")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Update pull request" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: /View pull request #52/ }),
    ).toHaveAttribute("href", "https://github.test/pull/52")
  })

  it("checks exact GitHub state before showing the publish action", () => {
    harness.publishStatus = undefined
    harness.publishStatusLoading = true

    render(<WorkspaceGitHubPublish />)

    expect(screen.getByText("Checking GitHub…")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Publish workspace" }),
    ).not.toBeInTheDocument()
  })

  it("immediately starts inbound sync when the repository head is newer", async () => {
    harness.publishStatus = {
      status: "sync_required",
      changed_file_count: 0,
      written_file_count: 0,
      deleted_file_count: 0,
      unchanged_file_count: 0,
      compared_commit_sha: "def456",
    }

    render(<WorkspaceGitHubPublish />)

    expect(screen.getByText("Syncing latest GitHub changes…")).toBeInTheDocument()
    expect(
      screen.getByRole("progressbar", {
        name: "Latest GitHub changes sync progress",
      }),
    ).toBeInTheDocument()
    expect(document.querySelector(".animate-spin")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Publish workspace" }),
    ).not.toBeInTheDocument()
    await waitFor(() => expect(harness.mutate).toHaveBeenCalledOnce())
  })

  it("explicitly confirms and acknowledges keeping Breezify conflict versions", async () => {
    const user = userEvent.setup()
    harness.source = {
      ...harness.source,
      conflict_count: 2,
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          pull_request_number: 61,
          pull_request_url: "https://github.test/pull/61",
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    render(<WorkspaceGitHubPublish />)
    await user.click(screen.getByRole("button", { name: "Publish workspace" }))
    expect(
      screen.getByText(/This pull request will propose the Breezify versions/i),
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Create pull request" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      conflict_resolution: "breezify",
    })
  })

  it("surfaces a 4xx response and leaves the confirmation open", async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "GitHub publishing is temporarily unavailable.",
            code: "github_publish_failed",
          }),
          { status: 409 },
        ),
      ),
    )

    render(<WorkspaceGitHubPublish />)
    await user.click(screen.getByRole("button", { name: "Publish workspace" }))
    await user.click(screen.getByRole("button", { name: "Create pull request" }))

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("GitHub publishing is temporarily unavailable.")
    expect(
      screen.getByRole("heading", { name: "Publish workspace changes?" }),
    ).toBeInTheDocument()
  })

  it("treats a raced no-change response as up to date", async () => {
    const user = userEvent.setup()
    harness.mutatePublishStatus.mockResolvedValue(undefined)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "There are no workspace changes to publish.",
            code: "no_changes",
          }),
          { status: 409 },
        ),
      ),
    )

    render(<WorkspaceGitHubPublish />)
    await user.click(screen.getByRole("button", { name: "Publish workspace" }))
    await user.click(screen.getByRole("button", { name: "Create pull request" }))

    await waitFor(() => {
      expect(harness.mutatePublishStatus).toHaveBeenCalledTimes(1)
    })
    expect(
      screen.queryByRole("heading", { name: "Publish workspace changes?" }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("does not let a viewer publish workspace changes", () => {
    harness.role = "viewer"
    render(<WorkspaceGitHubPublish />)

    expect(
      screen.getByRole("button", { name: "Publish workspace" }),
    ).toBeDisabled()
    expect(
      screen.getByText(/Only workspace editors, admins, and owners/i),
    ).toBeInTheDocument()
  })

  it("renders nothing when no GitHub source is linked (GitHub setup is not offered)", () => {
    harness.role = "admin"
    harness.hasSource = false

    const { container } = render(<WorkspaceGitHubPublish />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole("link", { name: "Set up GitHub publishing" })).toBeNull()
  })

  it("links to the activation pull request while initial setup is waiting", () => {
    harness.source = {
      ...harness.source,
      sync_status: "disabled",
      pending_pull_request_number: 73,
      pending_pull_request_url: "https://github.test/pull/73",
    }

    render(<WorkspaceGitHubPublish />)

    expect(
      screen.getByRole("link", { name: /View activation pull request #73/ }),
    ).toHaveAttribute("href", "https://github.test/pull/73")
    expect(
      screen.getByText(/Merge the activation pull request/i),
    ).toBeInTheDocument()
  })

  it("shows the sync error instead of a publish action", () => {
    harness.role = "admin"
    harness.source = {
      ...harness.source,
      sync_status: "error",
      last_sync_error: "Hosted documentation sync failed.",
    }

    render(<WorkspaceGitHubPublish />)

    expect(
      screen.getByRole("link", { name: "Review GitHub sync" }),
    ).toHaveAttribute("href", "/settings/integrations/github")
    expect(screen.getByText("Hosted documentation sync failed.")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Publish workspace" }),
    ).not.toBeInTheDocument()
  })

  it("shows inbound progress instead of a publish action", () => {
    harness.source = {
      ...harness.source,
      sync_status: "syncing",
    }

    render(<WorkspaceGitHubPublish />)

    expect(screen.getByText("Syncing GitHub…")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Publish workspace" }),
    ).not.toBeInTheDocument()
  })
})
