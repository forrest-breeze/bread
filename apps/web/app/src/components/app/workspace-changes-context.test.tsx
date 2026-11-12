// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SWRConfig } from "swr"
import { notifyWorkspaceDocumentSaved } from "@/lib/workspace-publish-events"

const harness = vi.hoisted(() => ({
  pathname: "/knowledge/doc-1",
  publishStatus: undefined as
    | {
        status: "changes"
        changed_file_count: number
        compared_commit_sha: string
        comparison_key: string
      }
    | undefined,
  publishStatusLoading: false,
  mutatePublishStatus: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => harness.pathname,
}))

vi.mock("@/hooks/swr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/swr")>()
  return {
    ...actual,
    useWorkspace: () => ({ data: { user_role: "editor" } }),
    useGithubHostedDocs: () => ({
      data: {
        source: {
          id: "source-1",
          sync_status: "synced",
          last_sync_commit_sha: "github-head",
          publish_last_commit_sha: null,
          publish_pull_request_url: null,
          publish_pull_request_number: null,
          conflict_count: 0,
        },
      },
      error: undefined,
      isLoading: false,
    }),
    useGithubHostedDocsPublishStatus: () => ({
      data: harness.publishStatus,
      error: undefined,
      isLoading: harness.publishStatusLoading,
      mutate: harness.mutatePublishStatus,
    }),
  }
})

import {
  WorkspaceChangesProvider,
  useWorkspaceChanges,
} from "./workspace-changes-context"

const payload = {
  files: [
    {
      path: "docs/one.md",
      status: "modified" as const,
      previous: "old",
      next: "new",
      previousBlobSha: "blob-one",
    },
    {
      path: "docs/two.md",
      status: "added" as const,
      previous: "",
      next: "two",
    },
  ],
  changed_file_count: 2,
  truncated: false,
  compared_commit_sha: "github-head",
}

function ChangesConsumer(): React.ReactElement {
  const {
    checkingGitHub,
    files,
    selectedCount,
    commitSelected,
    toggleSelectedPath,
  } = useWorkspaceChanges()
  return (
    <div>
      <span>{checkingGitHub ? "checking" : "ready"}</span>
      <span>{files.length} files</span>
      <span>{selectedCount} staged</span>
      <button onClick={() => toggleSelectedPath("docs/one.md")}>Unstage one</button>
      <button onClick={() => void commitSelected()}>Commit staged</button>
    </div>
  )
}

function TestShell({ showChanges }: { showChanges: boolean }) {
  return (
    <SWRConfig value={{ provider: () => new Map() }}>
      <WorkspaceChangesProvider>
        {showChanges ? <ChangesConsumer /> : <div>Documents</div>}
      </WorkspaceChangesProvider>
    </SWRConfig>
  )
}

beforeEach(() => {
  harness.pathname = "/knowledge/doc-1"
  harness.publishStatus = undefined
  harness.publishStatusLoading = false
  harness.mutatePublishStatus.mockReset().mockResolvedValue(undefined)
})

afterEach(() => vi.unstubAllGlobals())

describe("WorkspaceChangesProvider", () => {
  it("waits for exact publish status, then preloads once before the Changes view opens", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify(payload), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const view = render(<TestShell showChanges={false} />)

    expect(fetchMock).not.toHaveBeenCalled()

    harness.publishStatus = {
      status: "changes",
      changed_file_count: 2,
      compared_commit_sha: "github-head",
      comparison_key: "comparison-1",
    }
    view.rerender(<TestShell showChanges={false} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    harness.pathname = "/knowledge/changes"
    view.rerender(<TestShell showChanges />)

    expect(await screen.findByText("2 files")).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/github/hosted-docs/publish/diff?basis=",
    )
  })

  it("keeps staged files when the main Changes view unmounts", async () => {
    harness.publishStatus = {
      status: "changes",
      changed_file_count: 2,
      compared_commit_sha: "github-head",
      comparison_key: "comparison-1",
    }
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const view = render(<TestShell showChanges />)

    await screen.findByText("2 staged")
    fireEvent.click(screen.getByRole("button", { name: "Unstage one" }))
    expect(screen.getByText("1 staged")).toBeInTheDocument()

    view.rerender(<TestShell showChanges={false} />)
    view.rerender(<TestShell showChanges />)

    expect(screen.getByText("1 staged")).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("does not rebuild the diff until a saved edit's status refresh settles", async () => {
    harness.publishStatus = {
      status: "changes",
      changed_file_count: 2,
      compared_commit_sha: "github-head",
      comparison_key: "comparison-1",
    }
    let finishStatusRefresh: (() => void) | undefined
    harness.mutatePublishStatus.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStatusRefresh = () => {
            harness.publishStatus = {
              status: "changes",
              changed_file_count: 2,
              compared_commit_sha: "github-head",
              comparison_key: "comparison-2",
            }
            resolve()
          }
        }),
    )
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    render(<TestShell showChanges />)
    await screen.findByText("2 files")
    expect(fetchMock).toHaveBeenCalledOnce()

    act(() => {
      notifyWorkspaceDocumentSaved({
        documentId: "doc-1",
        savedAt: "2026-08-29T12:00:00.000Z",
      })
    })
    expect(screen.getByText("checking")).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledOnce()

    await act(async () => finishStatusRefresh?.())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it("reuses the diff when a save does not change the comparison fingerprint", async () => {
    harness.publishStatus = {
      status: "changes",
      changed_file_count: 2,
      compared_commit_sha: "github-head",
      comparison_key: "comparison-1",
    }
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    render(<TestShell showChanges />)
    await screen.findByText("2 files")

    await act(async () => {
      notifyWorkspaceDocumentSaved({
        documentId: "doc-unchanged",
        savedAt: "2026-08-29T12:01:00.000Z",
      })
    })

    await waitFor(() => expect(harness.mutatePublishStatus).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("creates one commit containing every staged path", async () => {
    harness.publishStatus = {
      status: "changes",
      changed_file_count: 2,
      compared_commit_sha: "github-head",
      comparison_key: "comparison-1",
    }
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input) === "/api/github/hosted-docs/publish" &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              pull_request_number: 41,
              pull_request_url: "https://github.test/pull/41",
            }),
            { status: 201 },
          )
        }
        return new Response(JSON.stringify(payload), { status: 200 })
      },
    )
    vi.stubGlobal("fetch", fetchMock)
    render(<TestShell showChanges />)

    await screen.findByText("2 staged")
    fireEvent.click(screen.getByRole("button", { name: "Unstage one" }))
    fireEvent.click(screen.getByRole("button", { name: "Commit staged" }))

    await waitFor(() => {
      const publishCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/github/hosted-docs/publish" &&
          init?.method === "POST",
      )
      expect(JSON.parse(String(publishCall?.[1]?.body))).toEqual({
        paths: ["docs/two.md"],
      })
    })
  })
})
